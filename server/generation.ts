import type {
  ChapterDetail,
  ContextPreset,
  GenerationJob,
  ProjectDraft,
  RewriteAction,
  RewriteRequest,
} from '../shared/types.js';
import { CONTEXT_PRESETS } from '../shared/types.js';
import { jobSettingsSnapshot } from '../shared/utils.js';
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
  buildRewriteSystemPrompt,
  CONTINUITY_REVIEW_PROMPT,
} from './prompts.js';
import { requireLatestApprovedOutline, createOutlineFromGeneration } from './store/outline.js';
import {
  applyRewriteToChapter,
  currentChapterText,
  getChapterRow,
  listChapters,
  createRevisionFromJob,
  getChapter,
} from './store/chapters.js';
import { memoryPromptText } from './store/memory.js';
import { clearLorePins } from './store/lore.js';
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
  activeJobForChapterKind,
  activeOutlineJob,
  appendOutput,
  assertJobTerminal,
  createJob,
  createRuntime,
  finalizeJob,
  getJob,
  getJobRow,
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
    settings: jobSettingsSnapshot(settings),
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
  const active = activeJobForChapterKind(chapterId, 'chapter');
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
    lore: context.loreText || '(No lore entries activated.)',
    recent_prose: context.recentProse,
    additional_instructions: instructions || 'None.',
    context_preset: preset,
  });
  // Custom templates created before stage 2 have no story-memory placeholder;
  // append the memory block rather than silently dropping it. Stage 3 lore is
  // appended the same way when a template lacks {{lore}}.
  const promptWithMemory =
    context.memoryText && !/\{\{\s*story_memory\s*\}\}/.test(template.content)
      ? `${prompt}\n\n${context.memoryText}`
      : prompt;
  const promptWithLore =
    context.loreText && !/\{\{\s*lore\s*\}\}/.test(template.content)
      ? `${promptWithMemory}\n\n${context.loreText}`
      : promptWithMemory;

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
    prompt: promptWithLore,
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
      includedLore: context.lore.activated,
      totalLore: context.lore.totalEntries,
      omittedLore: context.lore.omitted,
      loreEntries: context.lore.entries,
      loreBudgetTokens: context.lore.budgetTokens,
      staleSummaries: context.staleSummaries,
      pendingFacts: context.pendingFacts,
      sections: context.sections,
      targetWords,
    },
    settings: jobSettingsSnapshot(generationSettings, { contextPreset: preset, targetWords }),
  });

  // Manual pins apply to one generation only.
  clearLorePins(project.id);

  void (async () => {
    const result = await runStream(
      job,
      model.provider,
      [
        { role: 'system', content: promptWithLore },
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
    settings: jobSettingsSnapshot(settings),
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

const REWRITE_ACTIONS: RewriteAction[] = ['rewrite', 'expand', 'shorten', 'style'];

function rewriteMaxTokens(action: RewriteAction, selectionChars: number): number {
  const base = Math.max(400, Math.round((selectionChars / 4) * 1.5));
  if (action === 'expand') return Math.min(6000, Math.round(base * 2));
  if (action === 'shorten') return Math.min(3000, Math.round(base * 0.9));
  return Math.min(4000, base);
}

/**
 * Revise a selected passage without touching the manuscript. The proposal is
 * stored on the job and only becomes a revision when the author applies it.
 */
export function startRewriteGeneration(
  chapterId: string,
  request: RewriteRequest,
): GenerationJob {
  const chapter = getChapterRow(chapterId);
  const project = getProject(chapter.project_id);
  const text = currentChapterText(chapterId);
  if (!text.trim()) {
    throw conflict('Draft or write this chapter before rewriting a passage.');
  }
  const action = REWRITE_ACTIONS.includes(request.action) ? request.action : 'rewrite';
  const selection = typeof request.selection === 'string' ? request.selection : '';
  if (!selection.trim()) throw badRequest('Select some text to rewrite.');
  if (selection.length > 12000) {
    throw badRequest('Selected text must be 12,000 characters or fewer.');
  }
  const start = Math.floor(Number(request.start));
  const end = Math.floor(Number(request.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw badRequest('The selected range is not valid.');
  }
  if (end > text.length || text.slice(start, end) !== selection) {
    throw conflict('The chapter text changed since this passage was selected. Select it again.');
  }
  if (activeJobForChapterKind(chapterId, 'rewrite')) {
    throw conflict('A rewrite is already running for this chapter.');
  }

  const instruction = ensureAdditionalInstructions(request.instruction);
  const model = resolveTaskModel(project.id, 'prose');
  const settings = getProjectGeneration(project.id);
  const before = text.slice(Math.max(0, start - 1500), start);
  const after = text.slice(end, end + 1500);
  const system = buildRewriteSystemPrompt({
    action,
    title: project.title,
    premise: project.premise,
    genre: project.genre,
    tone: project.tone,
    pov: project.pov,
    tense: project.tense,
    styleNotes: project.styleNotes,
    contentPreferences: project.contentPreferences,
    instructions: project.instructions,
    chapterNumber: chapter.order_index + 1,
    chapterTitle: chapter.title,
    chapterBrief: chapter.brief,
    before,
    selection,
    after,
    instruction,
  });

  const rewriteSettings = {
    ...settings,
    maxTokens: settings.maxTokens ?? rewriteMaxTokens(action, selection.length),
  };

  const job = createJob({
    projectId: project.id,
    kind: 'rewrite',
    chapterId,
    connectionId: model.connectionId,
    model: model.model,
    prompt: system,
    context: { stage: 'rewrite', action, start, end, selection, instruction },
    settings: jobSettingsSnapshot(rewriteSettings),
  });

  void (async () => {
    const result = await runStream(
      job,
      model.provider,
      [
        { role: 'system', content: system },
        { role: 'user', content: 'Return only the replacement passage for the selected text now.' },
      ],
      rewriteSettings,
    );
    if (!result) return;
    if (!result.content.trim()) {
      finalizeJob(job.id, 'failed', {
        error: 'The model returned an empty rewrite. The chapter text is untouched.',
        usage: result.usage,
      });
      return;
    }
    // The draft is a proposal. It becomes a revision only through applyRewriteJob.
    finalizeJob(job.id, 'completed', { usage: result.usage });
  })();

  return job;
}

export function applyRewriteJob(
  jobId: string,
  replacementOverride?: string,
): { revisionId: string; chapterId: string; chapter: ChapterDetail } {
  const job = getJob(jobId);
  if (job.kind !== 'rewrite' || !job.chapterId) {
    throw badRequest('Only a rewrite job can be applied to a chapter.');
  }
  assertJobTerminal(job);
  if (job.status !== 'completed') {
    throw conflict('Only a completed rewrite can be applied. Try again or discard it.');
  }
  const row = getJobRow(jobId);
  let context: {
    start?: unknown;
    end?: unknown;
    selection?: unknown;
  } = {};
  try {
    context = row.context_json ? (JSON.parse(row.context_json) as typeof context) : {};
  } catch {
    throw new AppError(500, 'The saved rewrite no longer has its original selection.');
  }
  const start = Number(context.start);
  const end = Number(context.end);
  const selection = typeof context.selection === 'string' ? context.selection : '';
  if (!Number.isFinite(start) || !Number.isFinite(end) || !selection) {
    throw new AppError(500, 'The saved rewrite no longer has its original selection.');
  }
  const replacement =
    typeof replacementOverride === 'string' && replacementOverride.trim()
      ? replacementOverride
      : job.output;
  if (!replacement.trim()) throw badRequest('The rewrite has no text to apply.');
  if (replacement.length > 200000) throw badRequest('That replacement is too large to apply.');

  const { revision, chapter } = applyRewriteToChapter({
    chapterId: job.chapterId,
    start,
    end,
    selection,
    replacement,
    jobId: job.id,
  });
  updateJob(job.id, { revision_id: revision.id });
  return { revisionId: revision.id, chapterId: job.chapterId, chapter };
}

function trimForReview(text: string, limit = 42000): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${text.slice(0, head)}\n\n[Middle of the chapter omitted to fit the review.]\n\n${text.slice(-tail)}`;
}

/** Advisory continuity check for one chapter using the memory role. */
export function startContinuityReview(chapterId: string): GenerationJob {
  const chapter = getChapterRow(chapterId);
  const project = getProject(chapter.project_id);
  const text = currentChapterText(chapterId);
  if (!text.trim()) {
    throw conflict('Draft or write this chapter before reviewing continuity.');
  }
  if (activeJobForChapterKind(chapterId, 'review')) {
    throw conflict('A continuity review is already running for this chapter.');
  }
  const model = resolveTaskModel(project.id, 'memory');
  const memory = memoryPromptText(project.id, chapterId);
  const trimmedMemory =
    memory.length > 18000 ? `${memory.slice(0, 18000)}\n[Earlier story memory trimmed.]` : memory;
  const job = createJob({
    projectId: project.id,
    kind: 'review',
    chapterId,
    connectionId: model.connectionId,
    model: model.model,
    prompt: CONTINUITY_REVIEW_PROMPT,
    context: { stage: 'review', memoryChars: trimmedMemory.length },
    settings: jobSettingsSnapshot({ temperature: 0.2, topP: null, maxTokens: 1200 }),
  });

  void (async () => {
    const user = `Novel: ${project.title}
Premise: ${project.premise || '(not set)'}
Chapter ${chapter.order_index + 1}: ${chapter.title}
Brief (a plan, not evidence): ${chapter.brief || '(none)'}

## Accepted story memory
${trimmedMemory || '(No summaries, facts, or cast have been accepted yet.)'}

## Chapter text
${trimForReview(text)}

Review this chapter's continuity now. Report only concrete conflicts and possible inconsistencies.`;
    const result = await runStream(
      job,
      model.provider,
      [
        { role: 'system', content: CONTINUITY_REVIEW_PROMPT },
        { role: 'user', content: user },
      ],
      { temperature: 0.2, topP: null, maxTokens: 1200 },
    );
    if (!result) return;
    if (!result.content.trim()) {
      finalizeJob(job.id, 'failed', {
        error: 'The review model returned an empty report. Try again.',
        usage: result.usage,
      });
      return;
    }
    finalizeJob(job.id, 'completed', { usage: result.usage });
  })();

  return job;
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

