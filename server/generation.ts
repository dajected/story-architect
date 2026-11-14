import type { ContextPreset, GenerationJob, ProjectDraft } from '../shared/types.js';
import { CONTEXT_PRESETS } from '../shared/types.js';
import { approvedOutlineText, buildChatChapterContext, buildProseContext } from './context.js';
import { AppError, badRequest, conflict, errorMessage } from './errors.js';
import { getProject, touchProject } from './store/projects.js';
import { getProjectGeneration, resolveTaskModel } from './store/settings.js';
import { resolvePromptTemplate } from './store/templates.js';
import {
  renderTemplate,
  outlinePromptValues,
  parseOutline,
  buildChatSystemPrompt,
} from './prompts.js';
import { requireLatestApprovedOutline, createOutlineFromGeneration } from './store/outline.js';
import {
  getChapterRow,
  listChapters,
  createRevisionFromJob,
  getChapter,
} from './store/chapters.js';
import { memoryPromptText } from './store/memory.js';
import { modelContextLength } from './store/connections.js';
import { autoStartChapterMemory } from './memory-generation.js';
import {
  addMessage,
  getConversation,
  listMessages,
  setConversationTitle,
} from './store/chat.js';
import {
  activeChatJob,
  activeJobForChapter,
  activeOutlineJob,
  appendOutput,
  assertJobTerminal,
  createJob,
  createRuntime,
  finalizeJob,
  getJob,
  isCancellation,
  outputSoFar,
  updateJob,
} from './jobs.js';
import { streamChat, ProviderError } from './providers.js';
import type { ProviderConnection, ProviderMessage } from './providers.js';

function ensureAdditionalInstructions(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length > 8000) throw badRequest('Additional instructions must be 8000 characters or fewer.');
  return text;
}

interface StreamOutcome {
  content: string;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
}

async function runStream(
  job: GenerationJob,
  provider: ProviderConnection,
  messages: ProviderMessage[],
  settings: {
    temperature: number | null;
    topP: number | null;
    maxTokens: number | null;
  },
): Promise<StreamOutcome | null> {
  const runtime = createRuntime(job.id);
  try {
    const result = await streamChat(provider, {
      model: job.model,
      messages,
      temperature: settings.temperature,
      topP: settings.topP,
      maxTokens: settings.maxTokens,
      signal: runtime.controller.signal,
      onDelta: (text) => appendOutput(job.id, text),
    });
    return result;
  } catch (error) {
    if (isCancellation(error, runtime.controller.signal)) {
      finalizeJob(job.id, 'cancelled', {
        error: 'Generation stopped. Any partial output is kept.',
      });
      return null;
    }
    const message = error instanceof ProviderError ? error.message : errorMessage(error);
    finalizeJob(job.id, 'failed', { error: message });
    return null;
  }
}

function renderOutlinePrompt(
  projectId: string,
  additionalInstructions: string,
): { prompt: string; userMessage: string } {
  const project = getProject(projectId);
  const template = resolvePromptTemplate(projectId, 'outline');
  const prompt = renderTemplate(
    template.content,
    outlinePromptValues({
      title: project.title,
      premise: project.premise,
      genre: project.genre,
      tone: project.tone,
      pov: project.pov,
      tense: project.tense,
      styleNotes: project.styleNotes,
      contentPreferences: project.contentPreferences,
      instructions: project.instructions,
      chapterCount: project.chapterCount,
      targetChapterWords: project.targetChapterWords,
      additionalInstructions: additionalInstructions || 'None.',
    }),
  );
  return {
    prompt,
    userMessage: `Create the outline for "${project.title}" now. Return only the JSON object.`,
  };
}

export function startOutlineGeneration(
  projectId: string,
  additionalInstructions?: string,
): GenerationJob {
  getProject(projectId);
  const active = activeOutlineJob(projectId);
  if (active) throw conflict('An outline is already being generated for this project.');
  const instructions = ensureAdditionalInstructions(additionalInstructions);
  const model = resolveTaskModel(projectId, 'outline');
  const settings = getProjectGeneration(projectId);
  const { prompt, userMessage } = renderOutlinePrompt(projectId, instructions);

  const job = createJob({
    projectId,
    kind: 'outline',
    connectionId: model.connectionId,
    model: model.model,
    prompt,
    context: { templateReplaced: true, additionalInstructions: instructions },
  });

  void (async () => {
    const result = await runStream(
      job,
      model.provider,
      [
        { role: 'system', content: prompt },
        { role: 'user', content: userMessage },
      ],
      settings,
    );
    if (!result) return;

    try {
      if (!result.content.trim()) {
        finalizeJob(job.id, 'failed', {
          error: 'The model returned an empty response. Nothing was saved.',
        });
        return;
      }
      const chapters = parseOutline(result.content);
      if (chapters.length === 0) {
        finalizeJob(job.id, 'failed', {
          error:
            'The model response could not be read as an outline. The raw output is kept so you can retry or write the outline manually.',
          usage: result.usage,
        });
        return;
      }
      const revision = createOutlineFromGeneration(projectId, chapters, result.content);
      finalizeJob(job.id, 'completed', { revisionId: revision.id, usage: result.usage });
    } catch (error) {
      finalizeJob(job.id, 'failed', { error: errorMessage(error) });
    }
  })();

  return job;
}

export interface ChapterGenerationOptions {
  instructions?: string;
  contextPreset?: ContextPreset;
  targetWords?: number | null;
}

export function startChapterGeneration(
  chapterId: string,
  options: ChapterGenerationOptions = {},
): GenerationJob {
  const chapter = getChapterRow(chapterId);
  const project = getProject(chapter.project_id);
  const active = activeJobForChapter(chapterId);
  if (active) throw conflict('This chapter is already being generated.');
  requireLatestApprovedOutline(project.id);
  if (!Number(chapter.brief_approved)) {
    throw conflict('The chapter brief has not been approved. Approve the outline revision first.');
  }

  const instructions = ensureAdditionalInstructions(options.instructions);
  const model = resolveTaskModel(project.id, 'prose');
  const settings = getProjectGeneration(project.id);
  const preset: ContextPreset =
    options.contextPreset && CONTEXT_PRESETS.some((entry) => entry.id === options.contextPreset)
      ? options.contextPreset
      : settings.contextPreset;

  const targetWords =
    options.targetWords && Number(options.targetWords) >= 100
      ? Math.round(Number(options.targetWords))
      : settings.targetWords ?? project.targetChapterWords ?? 1800;

  const template = resolvePromptTemplate(project.id, 'prose');
  const context = buildProseContext(project, getChapter(chapterId), {
    preset,
    additionalInstructions: instructions,
    targetWords,
    templateContent: template.content,
    modelContextLength: modelContextLength(model.connectionId, model.model),
    maxTokens: settings.maxTokens,
  });
  const chapters = listChapters(project.id);
  const prompt = renderTemplate(template.content, {
    project_title: project.title,
    premise: project.premise,
    genre: project.genre,
    tone: project.tone,
    pov: project.pov,
    tense: project.tense,
    style_notes: project.styleNotes,
    content_preferences: project.contentPreferences,
    instructions: project.instructions,
    chapter_number: chapter.order_index + 1,
    chapter_count: project.chapterCount ?? chapters.length,
    chapter_title: chapter.title,
    chapter_brief: chapter.brief,
    target_words: targetWords,
    story_memory: context.memoryText || '(No story memory yet.)',
    recent_prose: context.recentProse,
    additional_instructions: instructions || 'None.',
    context_preset: preset,
  });
  // Custom templates created before stage 2 have no story-memory placeholder;
  // append the memory block rather than silently dropping it.
  const promptWithMemory =
    context.memoryText && !/\{\{\s*story_memory\s*\}\}/.test(template.content)
      ? `${prompt}\n\n${context.memoryText}`
      : prompt;

  // Reserve the reply capacity that the context budget assumed, even when the
  // provider would otherwise apply an unbounded default.
  const generationSettings = {
    ...settings,
    maxTokens: settings.maxTokens ?? context.reservedOutputTokens,
  };

  const job = createJob({
    projectId: project.id,
    kind: 'chapter',
    chapterId,
    connectionId: model.connectionId,
    model: model.model,
    prompt: promptWithMemory,
    context: {
      preset,
      budgetTokens: context.budgetTokens,
      availableInputTokens: context.availableInputTokens,
      reservedOutputTokens: context.reservedOutputTokens,
      requiredTokens: context.requiredTokens,
      estimatedTokens: context.estimatedTokens,
      includedWords: context.includedWords,
      includedChapters: context.includedChapters,
      omittedChapters: context.omittedChapters,
      includedSummaries: context.includedSummaries,
      totalSummaries: context.totalSummaries,
      includedCharacters: context.includedCharacters,
      totalCharacters: context.totalCharacters,
      includedFacts: context.includedFacts,
      totalFacts: context.totalFacts,
      staleSummaries: context.staleSummaries,
      pendingFacts: context.pendingFacts,
      sections: context.sections,
      targetWords,
    },
  });

  void (async () => {
    const result = await runStream(
      job,
      model.provider,
      [
        { role: 'system', content: promptWithMemory },
        {
          role: 'user',
          content: `Write Chapter ${chapter.order_index + 1}, "${chapter.title}", now. Return prose only.`,
        },
      ],
      generationSettings,
    );
    if (!result) return;
    try {
      if (!result.content.trim()) {
        finalizeJob(job.id, 'failed', {
          error: 'The model returned an empty response. Existing chapter text was left untouched.',
        });
        return;
      }
      const { revision, applied } = createRevisionFromJob(
        chapterId,
        result.content,
        job.id,
        'generated',
      );
      finalizeJob(job.id, 'completed', { revisionId: revision.id, usage: result.usage });
      if (applied) autoStartChapterMemory(chapterId);
    } catch (error) {
      finalizeJob(job.id, 'failed', { error: errorMessage(error) });
    }
  })();

  return job;
}

export function startChatGeneration(params: {
  conversationId: string;
  content: string;
  chapterId?: string | null;
}): { job: GenerationJob; messageId: string } {
  const conversation = getConversation(params.conversationId);
  const content = params.content.trim();
  if (!content) throw badRequest('Write a message before sending.');
  if (content.length > 20000) throw badRequest('Messages must be 20,000 characters or fewer.');
  if (activeChatJob(conversation.id)) {
    throw conflict('The assistant is still replying in this conversation.');
  }

  const project = getProject(conversation.projectId);
  const model = resolveTaskModel(project.id, 'prose');

  let chapterContext = '';
  let storyMemory = '';
  let memoryChapterId: string | null = null;
  if (params.chapterId) {
    const chapter = getChapterRow(params.chapterId);
    if (chapter.project_id !== project.id) throw badRequest('That chapter belongs to another project.');
    chapterContext = buildChatChapterContext(getChapter(chapter.id));
    memoryChapterId = chapter.id;
  } else {
    const chapters = listChapters(project.id).filter((chapter) => chapter.currentRevisionId);
    const last = chapters[chapters.length - 1];
    if (last) {
      chapterContext = buildChatChapterContext(last);
      memoryChapterId = last.id;
    }
  }
  if (memoryChapterId) {
    try {
      const text = memoryPromptText(project.id, memoryChapterId);
      storyMemory =
        text.length > 14000
          ? `${text.slice(0, 14000)}\n[Earlier story memory trimmed for the assistant.]`
          : text;
    } catch {
      storyMemory = '';
    }
  }

  const systemPrompt = buildChatSystemPrompt({
    title: project.title,
    premise: project.premise,
    genre: project.genre,
    tone: project.tone,
    pov: project.pov,
    tense: project.tense,
    styleNotes: project.styleNotes,
    contentPreferences: project.contentPreferences,
    instructions: project.instructions,
    outlineSummary: approvedOutlineText(project.id),
    chapterContext,
    storyMemory,
  });

  const existingMessages = listMessages(conversation.id);
  const userMessage = addMessage({
    conversationId: conversation.id,
    role: 'user',
    content,
  });
  if (existingMessages.length === 0) {
    setConversationTitle(conversation.id, content.slice(0, 80));
  }

  const history = [...existingMessages, userMessage].slice(-24).map((message) => ({
    role: message.role as 'user' | 'assistant',
    content: message.content,
  }));

  const settings = getProjectGeneration(project.id);
  const job = createJob({
    projectId: project.id,
    kind: 'chat',
    conversationId: conversation.id,
    connectionId: model.connectionId,
    model: model.model,
    prompt: systemPrompt,
    context: { chapterId: params.chapterId ?? null, historyMessages: history.length },
  });

  void (async () => {
    const result = await runStream(
      job,
      model.provider,
      [{ role: 'system', content: systemPrompt }, ...history],
      settings,
    );
    const output = outputSoFar(job.id);
    if (!result) {
      if (output.trim()) {
        addMessage({
          conversationId: conversation.id,
          role: 'assistant',
          content: output,
          incomplete: true,
          jobId: job.id,
        });
      }
      return;
    }
    try {
      if (!result.content.trim()) {
        finalizeJob(job.id, 'failed', { error: 'The model returned an empty reply.' });
        return;
      }
      addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: result.content,
        jobId: job.id,
      });
      touchProject(project.id);
      finalizeJob(job.id, 'completed', { usage: result.usage });
    } catch (error) {
      finalizeJob(job.id, 'failed', { error: errorMessage(error) });
    }
  })();

  return { job, messageId: userMessage.id };
}

export function applyPartialJob(jobId: string): {
  revisionId: string;
  applied: boolean;
  chapterId: string;
} {
  const job = getJob(jobId);
  if (job.kind !== 'chapter' || !job.chapterId) {
    throw badRequest('Only chapter generation jobs keep recoverable drafts.');
  }
  assertJobTerminal(job);
  if (job.status === 'completed') {
    throw conflict('This job already completed. Open the generated draft from the revision history.');
  }
  const output = job.output || outputSoFar(jobId);
  if (!output.trim()) throw badRequest('This job has no partial output to recover.');
  const { revision, applied } = createRevisionFromJob(
    job.chapterId,
    output,
    job.id,
    'recovered',
  );
  updateJob(job.id, { revision_id: revision.id });
  if (applied) autoStartChapterMemory(job.chapterId);
  return { revisionId: revision.id, applied, chapterId: job.chapterId };
}

interface SuggestionParams {
  field: string;
  draft: Partial<ProjectDraft>;
  currentChapterCount?: number;
}

const SUGGESTION_PROMPTS: Record<string, string> = {
  title: 'a working novel title. Return only the title, without quotation marks.',
  premise: 'a compelling two-to-three sentence novel premise. Return only the premise.',
  genre: 'a concise genre label such as "Gothic fantasy" or "Literary science fiction". Return only the label.',
  tone: 'a short tone descriptor such as "wry, intimate, quietly ominous". Return only the phrase.',
  pov: 'the best point of view. Reply with exactly one of: First person, Second person, Third person limited, Third person omniscient, Multiple viewpoints.',
  tense: 'the best narrative tense. Reply with exactly one of: Past tense, Present tense.',
  styleNotes: 'two sentences of voice and style guidance. Return only the guidance.',
  contentPreferences: 'two sentences describing content boundaries and preferences for a general adult readership. Return only the guidance.',
  chapterCount: 'a sensible chapter count between 12 and 40. Return only the number.',
  targetChapterWords: 'a sensible target chapter length between 1200 and 4000 words. Return only the number.',
  instructions: 'three concise standing instructions for the AI writing this novel. Return only the instructions.',
};

export async function suggestProjectField(params: SuggestionParams): Promise<string> {
  const field = String(params.field ?? '');
  const instruction = SUGGESTION_PROMPTS[field];
  if (!instruction) throw badRequest('Unknown suggestion field.');
  const model = resolveTaskModel(null, 'outline');
  const draft = params.draft ?? {};
  const description = [
    draft.title ? `Title: ${draft.title}` : '',
    draft.premise ? `Premise: ${draft.premise}` : '',
    draft.genre ? `Genre: ${draft.genre}` : '',
    draft.tone ? `Tone: ${draft.tone}` : '',
    draft.pov ? `Point of view: ${draft.pov}` : '',
    draft.tense ? `Tense: ${draft.tense}` : '',
    draft.styleNotes ? `Style: ${draft.styleNotes}` : '',
    draft.contentPreferences ? `Content preferences: ${draft.contentPreferences}` : '',
    params.currentChapterCount ? `Chapter count: ${params.currentChapterCount}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = `You are helping an author set up a novel. Based on the details so far, suggest ${instruction}
Do not explain. Do not add labels or quotation marks.

Known details:
${description || '(The author has not filled anything in yet.)'}`;

  try {
    const result = await streamChat(model.provider, {
      model: model.model,
      messages: [
        { role: 'system', content: 'You give terse, concrete fiction-planning suggestions. Never add commentary.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.9,
      topP: null,
      maxTokens: 400,
      signal: AbortSignal.timeout(90000),
      onDelta: () => {},
    });
    let value = result.content.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (field === 'chapterCount' || field === 'targetChapterWords') {
      const match = value.match(/\d+/);
      if (!match) throw new AppError(502, 'The model did not return a usable number. Try again.');
      value = match[0];
    }
    if (!value) throw new AppError(502, 'The model returned an empty suggestion. Try again.');
    return value;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ProviderError) throw new AppError(502, error.message);
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new AppError(504, 'The suggestion request timed out.');
    }
    throw new AppError(502, errorMessage(error));
  }
}

