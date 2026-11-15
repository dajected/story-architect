import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ChapterPortraitCandidate,
  ChapterPortraitOverview,
  ChapterPortraitRequest,
  Character,
  CharacterImageOverview,
  GenerationJob,
  ImageAsset,
  ImageJob,
  ResolvedRole,
} from '../shared/types.js';
import { jobSettingsSnapshot } from '../shared/utils.js';
import { badRequest, conflict, errorMessage } from './errors.js';
import {
  appendOutput,
  cancelJob,
  createJob,
  createRuntime,
  finalizeJob,
  isCancellation,
  recordPreparedRequest,
  recordBackgroundAttempt,
} from './jobs.js';
import {
  generateImage,
  recoverComfyImage,
  sniffImageMime,
} from './image-providers.js';
import type { GeneratedImage } from './image-providers.js';
import { ProviderError } from './providers.js';
import { IMAGE_PROMPT_SYSTEM, imagePromptValues, renderContextTemplate } from './prompts.js';
import { getCharacter, getCharacterRow, listCharacters } from './store/characters.js';
import { currentChapterText, getChapter } from './store/chapters.js';
import {
  getImageConnection,
  getProviderImageConnection,
  listImageConnections,
} from './store/image-connections.js';
import {
  listImagePromptTemplates,
  resolveImagePromptTemplate,
} from './store/image-templates.js';
import {
  activeImageJobForCharacter,
  createImageAsset,
  createImageJob,
  getImageJob,
  getImageAsset,
  imagesRoot,
  listChapterImageAssets,
  listCharacterImageAssets,
  listCharacterImageJobs,
  listInterruptedImageJobsWithRemoteId,
  updateImageJob,
} from './store/images.js';
import { chapterCharacterFacts } from './store/memory.js';
import { appearanceForImagePrompt, listChapterAppearances, priorAppearanceChanges } from './store/appearances.js';
import {
  activePortraitRequestForCharacter,
  createPortraitRequest,
  getPortraitRequest,
  listChapterPortraitRequests,
  updatePortraitRequest,
} from './store/portrait-requests.js';
import { getProject } from './store/projects.js';
import { getProjectGeneration, resolveRoles, resolveTaskModel, getProjectVisualStyle } from './store/settings.js';
import { backgroundReplyTokens, streamBackgroundTask } from './background-generation.js';
import type { ProviderConnection, ProviderMessage } from './providers.js';
import type { RequestContextPart } from './request-context.js';

const imageRuntimes = new Map<string, AbortController>();
const IMAGE_BACKGROUND_FIELDS: Record<string, Omit<RequestContextPart, 'text' | 'slot'>> = {
  appearance_record: { label: 'Appearance at this point', priority: 95, maxTokens: 1200 },
  personality: { label: 'Personality', priority: 50, maxTokens: 500 },
  goals: { label: 'Goals', priority: 40, maxTokens: 500 },
  notes: { label: 'Character notes', priority: 30, maxTokens: 700 },
  project_style: { label: 'Story style', priority: 20, maxTokens: 500 },
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function textLimit(value: string | undefined | null, max: number, label: string): string {
  const text = (value ?? '').trim();
  if (text.length > max) throw badRequest(`${label} must be ${max} characters or fewer.`);
  return text;
}

export interface ImagePromptExpansionInput {
  moment?: 'start' | 'end' | 'custom';
  chapterId?: string | null;
  templateId?: string | null;
  scene?: string;
  clothing?: string;
  visualStyle?: string;
  instructions?: string;
}

/**
 * Expand a saved image template through the image-prompt LLM role. The result
 * is a normal text job, so it streams to the browser and stays editable.
 */
export function startImagePromptGeneration(
  characterId: string,
  input: ImagePromptExpansionInput = {},
): GenerationJob {
  const character = getCharacter(characterId);
  const project = getProject(character.projectId);
  const chapter = input.chapterId ? getChapter(input.chapterId) : null;
  if (chapter && chapter.projectId !== project.id) {
    throw badRequest('That chapter belongs to another project.');
  }

  const template = resolveImagePromptTemplate(project.id, input.templateId ?? null);
  const scene = textLimit(input.scene, 8000, 'Scene');
  const clothing = textLimit(input.clothing, 4000, 'Clothing');
  const visualStyle = textLimit(input.visualStyle, 4000, 'Visual style');
  const instructions = textLimit(input.instructions, 4000, 'Instructions');
  const chapterText = chapter ? currentChapterText(chapter.id) : '';
  const moment = input.moment ?? 'end';
  const appearanceRecordValue = appearancePromptValue(chapter?.id ?? null, character.id, moment);
  const sceneText = [
    scene || chapter?.brief || '(No scene was specified; use an evocative portrait setting.)',
    chapterText.trim() ? `Depict the ${moment} of the chapter. Use only appearance established at that point.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const visualStyleValue = visualStyle || getProjectVisualStyle(project.id) || 'cinematic character portrait';
  const clothingValue = clothing || '(not specified)';
  const promptMessage = renderContextTemplate(
    template.content,
    imagePromptValues({
      novelTitle: project.title,
      genre: project.genre,
      tone: project.tone,
      projectStyle: project.styleNotes,
      characterName: character.name,
      characterRole: character.role,
      identity: character.identity,
      appearance: character.appearance,
      appearanceRecord: appearanceRecordValue,
      clothing: clothingValue,
      personality: character.personality,
      goals: character.goals,
      notes: character.notes,
      scene: sceneText,
      chapterTitle: chapter?.title ?? '',
      chapterBrief: chapter?.brief ?? '',
      visualStyle: visualStyleValue,
      additionalInstructions: instructions || 'None.',
    }),
    IMAGE_BACKGROUND_FIELDS,
  );
  if (chapterText.trim()) promptMessage.contextParts!.push({
    label: 'Chapter reference', text: chapterText, priority: 100, minTokens: 256, maxTokens: 1600,
    trim: input.moment === 'start' ? 'head' : 'both',
  });
  const reference = referenceDetailsBlock(template.content, [
    { key: 'novel_title', label: 'Novel', value: project.title },
    { key: 'genre', label: 'Genre', value: project.genre },
    { key: 'tone', label: 'Tone', value: project.tone },
    { key: 'project_style', label: 'Story style', value: project.styleNotes },
    { key: 'character_name', label: 'Character name', value: character.name },
    { key: 'character_role', label: 'Role', value: character.role },
    { key: 'identity', label: 'Identity', value: character.identity },
    { key: 'appearance', label: 'Appearance', value: character.appearance },
    { key: 'appearance_record', label: 'Appearance at this point', value: appearanceRecordValue },
    { key: 'clothing', label: 'Clothing', value: clothingValue },
    { key: 'personality', label: 'Personality', value: character.personality },
    { key: 'goals', label: 'Goals', value: character.goals },
    { key: 'notes', label: 'Notes', value: character.notes },
    { key: 'scene', label: 'Scene', value: sceneText },
    { key: 'chapter_title', label: 'Chapter', value: chapter?.title ?? '' },
    { key: 'chapter_brief', label: 'Chapter brief', value: chapter?.brief ?? '' },
    { key: 'visual_style', label: 'Visual style', value: visualStyleValue },
    {
      key: 'additional_instructions',
      label: 'Additional instructions',
      value: instructions || 'None.',
    },
  ], promptMessage.contextParts!);

  const model = resolveTaskModel(project.id, 'image_prompt');
  const settings = getProjectGeneration(project.id);
  promptMessage.content = [IMAGE_PROMPT_SYSTEM, promptMessage.content, reference].filter(Boolean).join('\n\n');
  const system = promptMessage.content;

  const job = createJob({
    projectId: project.id,
    kind: 'image_prompt',
    chapterId: chapter?.id ?? null,
    connectionId: model.connectionId,
    model: model.model,
    prompt: system,
    context: {
      stage: 'image_prompt',
      characterId: character.id,
      characterName: character.name,
      chapterId: chapter?.id ?? null,
      templateId: template.id,
      templateName: template.name,
      templateContent: template.content,
      templateScope: template.scope,
      scene,
      clothing,
      visualStyle,
      instructions,
    },
    settings: jobSettingsSnapshot({
      temperature: settings.temperature ?? 0.7,
      topP: null,
      maxTokens: backgroundReplyTokens(model.provider, model.model),
    }),
  });

  void (async () => {
    const runtime = createRuntime(job.id);
    try {
      const result = await streamBackgroundTask(model.provider, {
        model: job.model,
        messages: [
          promptMessage,
          { role: 'user', content: 'Write the final image prompt now. Return only the prompt.' },
        ],
        temperature: settings.temperature ?? 0.7,
        topP: null,
        maxTokens: backgroundReplyTokens(model.provider, model.model),
        signal: runtime.controller.signal,
        onDelta: (text) => appendOutput(job.id, cleanImagePrompt(text) || text),
        onPrepared: (request) => recordPreparedRequest(job.id, request),
      }, {
        label: 'Image prompt',
        validate: usableImagePrompt,
        onAttempt: (result, usage) => recordBackgroundAttempt(job.id, result, usage),
      });
      runtime.controller.signal.throwIfAborted();
      if (!result.content.trim()) {
        finalizeJob(job.id, 'failed', {
          error: 'The image-prompt model returned an empty reply. Try again or write the prompt by hand.',
          usage: result.usage,
        });
        return;
      }
      if (looksLikeClarificationRequest(cleanImagePrompt(result.content))) {
        finalizeJob(job.id, 'failed', {
          error:
            'The image-prompt model asked for more details instead of writing a prompt. Check that the selected template includes the character variables, then try again.',
          usage: result.usage,
        });
        return;
      }
      finalizeJob(job.id, 'completed', { usage: result.usage });
    } catch (error) {
      if (isCancellation(error, runtime.controller.signal)) {
        finalizeJob(job.id, 'cancelled', {
          error: 'Prompt expansion stopped. Any partial text is kept.',
        });
        return;
      }
      const message = error instanceof ProviderError ? error.message : errorMessage(error);
      finalizeJob(job.id, 'failed', { error: message });
    }
  })();

  return job;
}

export interface ImageGenerationInput {
  moment?: 'start' | 'end' | 'custom';
  sourceRevisionId?: string | null;
  sourceTextHash?: string;
  referenceAssetId?: string | null;
  connectionId: string;
  prompt: string;
  negativePrompt?: string;
  chapterId?: string | null;
  templateId?: string | null;
  templateName?: string | null;
  templateContent?: string | null;
}

export interface ChapterPortraitInput {
  moment?: 'start' | 'end' | 'custom';
  scene?: string;
  visualStyle?: string;
  characterId: string;
  connectionId?: string | null;
  templateId?: string | null;
  instructions?: string;
}

/** Whole-word, case-insensitive count of a character name in a lowercased text. */
export function countNameMentions(haystack: string, name: string): number {
  const needle = name.trim().toLowerCase();
  if (!needle) return 0;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
    return [...haystack.matchAll(pattern)].length;
  } catch {
    return haystack.split(needle).length - 1;
  }
}

function cleanImagePrompt(raw: string): string {
  let text = raw.trim();
  const expectsJson = /^(?:```(?:json)?\s*)?\{/.test(text) ||
    /\{\s*"(?:prompt|image_prompt|imagePrompt|description|text)"\s*:/.test(text);
  // Some templates ask the model for a "prompt" field. Accept a JSON object
  // and keep only that field so the image service never receives JSON.
  if (text.includes('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (parsed && typeof parsed === 'object') {
          const record = parsed as Record<string, unknown>;
          const field = ['prompt', 'image_prompt', 'imagePrompt', 'description', 'text']
            .map((key) => record[key])
            .find(
              (value): value is string =>
                typeof value === 'string' && value.trim().length > 0,
            );
          if (field) text = field.trim();
          else if (expectsJson) return '';
        }
      } catch {
        if (expectsJson) return '';
      }
    } else if (expectsJson) return '';
  }
  const cleaned = text
    .replace(/```[a-z]*\s*/gi, '')
    .replace(/```/g, '')
    .replace(/^\s*(image\s+prompt|prompt)\s*:\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  return cleaned || text;
}

function usableImagePrompt(raw: string): boolean {
  const text = cleanImagePrompt(raw);
  return !!text && text.length <= 8000;
}

interface PromptReferenceDetail {
  key: string;
  label: string;
  value: string | null | undefined;
}

/**
 * Custom image templates sometimes omit variables entirely, which leaves the
 * prompt model with nothing to describe. Append every value the template did
 * not render, so the model always receives the character and scene facts.
 */
function referenceDetailsBlock(
  templateContent: string,
  details: PromptReferenceDetail[],
  contextParts: RequestContextPart[],
): string {
  const used = new Set<string>();
  for (const match of templateContent.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const key = match[1];
    if (key) used.add(key);
  }
  const missing = details.filter((detail) => {
    if (used.has(detail.key) || !(detail.value ?? '').trim()) return false;
    const background = IMAGE_BACKGROUND_FIELDS[detail.key];
    if (background) {
      contextParts.push({ ...background, text: detail.value! });
      return false;
    }
    return true;
  });
  if (missing.length === 0) return '';
  return [
    '## Character and scene reference',
    'These details are authoritative. Use them and write the prompt; never ask the author for more information.',
    ...missing.map((detail) => `${detail.label}: ${detail.value}`),
  ].join('\n');
}

const CLARIFICATION_PATTERNS = [
  /i(?:'m| am) sorry/i,
  /\bplease provide\b/i,
  /\bi need (?:the|more|additional|specific)\b/i,
  /\bi(?:'d| would) need\b/i,
  /\bcould you (?:provide|clarify|tell|share)\b/i,
  /\bnot enough (?:detail|information)\b/i,
  /\bprovide (?:the|more) (?:character|detail|information)/i,
  /\bwhat (?:is|are) the character/i,
];

/** Detect a refusal/clarification instead of the image prompt we asked for. */
function looksLikeClarificationRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\?\s*$/.test(trimmed)) return true;
  return CLARIFICATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function chapterEndChanges(chapterId: string, characterId: string): string[] {
  try {
    return chapterCharacterFacts(chapterId, characterId);
  } catch {
    return [];
  }
}

/**
 * Feed the chained appearance record into the prompt model. If the chapter has
 * no record yet, fall back to earlier character-development facts so changes
 * from previous chapters are still represented.
 */
function appearancePromptValue(
  chapterId: string | null,
  characterId: string,
  moment: 'start' | 'end' | 'custom',
): string {
  if (!chapterId) return '';
  try {
    const record = appearanceForImagePrompt(chapterId, characterId, moment);
    if (record) return record;
    const changes = priorAppearanceChanges(chapterId, characterId);
    return changes.length
      ? `Earlier recorded changes:\n${changes.map((change) => `- ${change}`).join('\n')}`
      : '';
  } catch {
    return '';
  }
}

/**
 * Build a portrait of one character as they appear at the end of a chapter.
 * The image-prompt role synthesises the appearance and the image service draws
 * it; both steps are tracked on one portrait request so the browser can poll.
 */
export function startChapterPortraitRequest(
  chapterId: string,
  input: ChapterPortraitInput,
): ChapterPortraitRequest {
  const chapter = getChapter(chapterId);
  const project = getProject(chapter.projectId);
  const character = getCharacter(input.characterId);
  if (character.projectId !== project.id) {
    throw badRequest('That character belongs to another novel.');
  }
  if (character.status === 'archived') {
    throw badRequest('Archived characters cannot receive new portraits.');
  }
  if (activePortraitRequestForCharacter(character.id) || activeImageJobForCharacter(character.id)) {
    throw conflict(`A portrait is already being generated for ${character.name}.`);
  }
  const text = currentChapterText(chapterId);
  if (!text.trim() && input.moment !== 'start') {
    throw conflict('Draft this chapter before generating a portrait of its closing state.');
  }

  const connection = input.connectionId
    ? getImageConnection(input.connectionId)
    : listImageConnections()[0];
  if (!connection) {
    throw conflict('Add an image connection in Settings before generating portraits.');
  }

  const model = resolveTaskModel(project.id, 'image_prompt');
  const settings = getProjectGeneration(project.id);
  const template = resolveImagePromptTemplate(project.id, input.templateId ?? null);
  const instructions = textLimit(input.instructions, 4000, 'Instructions');
  const chapterNumber = chapter.orderIndex + 1;
  const moment = input.moment ?? 'end';
  const changes = moment === 'end' ? chapterEndChanges(chapterId, character.id) : [];
  const appearanceRecordValue = appearancePromptValue(chapterId, character.id, moment);
  const sceneText = [
    `A portrait of ${character.name} at the ${moment === 'end' ? 'very end' : moment} of Chapter ${chapterNumber}, "${chapter.title}". ${input.scene ?? ''}`,
    '',
    changes.length > 0
      ? `Physical changes and circumstances established by this chapter:\n${changes
          .map((change) => `- ${change}`)
          .join('\n')}`
      : 'No explicit physical changes were recorded. Use the established appearance, plus anything the closing text clearly shows.',
    '',
    `Show ${character.name} exactly as they appear at the requested moment. Do not anticipate later events.`,
  ].join('\n');

  const clothingValue =
    'As established by the character profile and the chapter. Change, damage or remove clothing only where the chapter supports it.';
  const visualStyleValue =
    input.visualStyle || getProjectVisualStyle(project.id) || 'cinematic character portrait, painterly book-cover illustration';
  const additionalInstructionsValue =
    instructions ||
    `A solo character portrait with a clear view of the face and upper body. No other people, captions or text. Reflect the requested ${moment} moment.`;

  const promptMessage = renderContextTemplate(
    template.content,
    imagePromptValues({
      novelTitle: project.title,
      genre: project.genre,
      tone: project.tone,
      projectStyle: project.styleNotes,
      characterName: character.name,
      characterRole: character.role,
      identity: character.identity,
      appearance: character.appearance,
      appearanceRecord: appearanceRecordValue,
      clothing: clothingValue,
      personality: character.personality,
      goals: character.goals,
      notes: character.notes,
      scene: sceneText,
      chapterTitle: chapter.title,
      chapterBrief: chapter.brief,
      visualStyle: visualStyleValue,
      additionalInstructions: additionalInstructionsValue,
    }),
    IMAGE_BACKGROUND_FIELDS,
  );
  promptMessage.contextParts!.push({ label: 'Chapter reference', text, priority: 100,
    minTokens: 256, maxTokens: 1750, trim: moment === 'start' ? 'head' : 'both' });
  const reference = referenceDetailsBlock(template.content, [
    { key: 'novel_title', label: 'Novel', value: project.title },
    { key: 'genre', label: 'Genre', value: project.genre },
    { key: 'tone', label: 'Tone', value: project.tone },
    { key: 'project_style', label: 'Story style', value: project.styleNotes },
    { key: 'character_name', label: 'Character name', value: character.name },
    { key: 'character_role', label: 'Role', value: character.role },
    { key: 'identity', label: 'Identity', value: character.identity },
    { key: 'appearance', label: 'Appearance', value: character.appearance },
    { key: 'appearance_record', label: 'Appearance at this point', value: appearanceRecordValue },
    { key: 'clothing', label: 'Clothing', value: clothingValue },
    { key: 'personality', label: 'Personality', value: character.personality },
    { key: 'goals', label: 'Goals', value: character.goals },
    { key: 'notes', label: 'Notes', value: character.notes },
    { key: 'scene', label: 'Scene', value: sceneText },
    { key: 'chapter_title', label: 'Chapter', value: chapter.title },
    { key: 'chapter_brief', label: 'Chapter brief', value: chapter.brief },
    { key: 'visual_style', label: 'Visual style', value: visualStyleValue },
    {
      key: 'additional_instructions',
      label: 'Additional instructions',
      value: additionalInstructionsValue,
    },
  ], promptMessage.contextParts!);

  promptMessage.content = [IMAGE_PROMPT_SYSTEM, promptMessage.content, reference].filter(Boolean).join('\n\n');
  const system = promptMessage.content;
  const job = createJob({
    projectId: project.id,
    kind: 'image_prompt',
    chapterId,
    connectionId: model.connectionId,
    model: model.model,
    prompt: system,
    context: {
      stage: 'chapter_portrait',
      characterId: character.id,
      characterName: character.name,
      chapterId,
      chapterNumber,
      imageConnectionId: connection.id,
      templateId: template.id,
      templateName: template.name,
    },
    settings: jobSettingsSnapshot({
      temperature: settings.temperature ?? 0.7,
      topP: null,
      maxTokens: backgroundReplyTokens(model.provider, model.model),
    }),
  });

  const request = createPortraitRequest({
    projectId: project.id,
    chapterId,
    characterId: character.id,
    promptJobId: job.id,
    status: 'prompting',
  });

  void runChapterPortrait(job, request, {
    provider: model.provider,
    system,
    promptMessage,
    connectionId: connection.id,
    templateId: template.id,
    templateName: template.name,
    templateContent: template.content,
    temperature: settings.temperature ?? 0.7,
    sourceRevisionId: chapter.currentRevisionId,
    sourceTextHash: crypto.createHash('sha256').update(text).digest('hex'),
    moment,
  });

  return request;
}

async function runChapterPortrait(
  job: GenerationJob,
  request: ChapterPortraitRequest,
  options: {
    provider: ProviderConnection;
    system: string;
    promptMessage: ProviderMessage;
    connectionId: string;
    templateId: string | null;
    templateName: string;
    templateContent: string;
    temperature: number;
    sourceRevisionId: string | null;
    sourceTextHash: string;
    moment: 'start' | 'end' | 'custom';
  },
): Promise<void> {
  const runtime = createRuntime(job.id);
  try {
    const result = await streamBackgroundTask(options.provider, {
      model: job.model,
      messages: [
        options.promptMessage,
        {
          role: 'user',
          content:
            'Write the final image prompt for this character at the requested moment now. Return only the prompt.',
        },
      ],
      temperature: options.temperature,
      topP: null,
      maxTokens: backgroundReplyTokens(options.provider, job.model),
      signal: runtime.controller.signal,
      onDelta: (text) => appendOutput(job.id, cleanImagePrompt(text) || text),
      onPrepared: (request) => recordPreparedRequest(job.id, request),
    }, {
      label: 'Portrait image prompt',
      validate: usableImagePrompt,
      onAttempt: (result, usage) => recordBackgroundAttempt(job.id, result, usage),
    });
    runtime.controller.signal.throwIfAborted();
    if (!result.content.trim()) {
      finalizeJob(job.id, 'failed', {
        error: 'The image-prompt model returned an empty reply. Try again.',
        usage: result.usage,
      });
      updatePortraitRequest(request.id, {
        status: 'failed',
        error: 'The image-prompt model returned an empty reply. Try again.',
      });
      return;
    }
    const prompt = cleanImagePrompt(result.content);
    if (!prompt) {
      finalizeJob(job.id, 'failed', {
        error: 'The expanded prompt was empty. Try again.',
        usage: result.usage,
      });
      updatePortraitRequest(request.id, {
        status: 'failed',
        error: 'The expanded prompt was empty. Try again.',
      });
      return;
    }
    if (looksLikeClarificationRequest(prompt)) {
      const message =
        'The image-prompt model asked for more details instead of writing a prompt. Check that the selected template includes the character variables, then try again.';
      finalizeJob(job.id, 'failed', { error: message, usage: result.usage });
      updatePortraitRequest(request.id, { status: 'failed', error: message });
      return;
    }
    finalizeJob(job.id, 'completed', { usage: result.usage });

    const imageConnection = getImageConnection(options.connectionId);
    const imageJob = createImageJob({
      projectId: request.projectId,
      characterId: request.characterId,
      chapterId: request.chapterId,
      connectionId: imageConnection.id,
      providerKind: imageConnection.kind,
      prompt,
      negativePrompt: '',
      templateId: options.templateId,
      templateName: options.templateName,
      templateContent: options.templateContent,
      settings: {...imageConnection.settings, sourceRevisionId: options.sourceRevisionId, sourceTextHash: options.sourceTextHash, moment: options.moment},
    });
    updatePortraitRequest(request.id, {
      status: 'imaging',
      imageJobId: imageJob.id,
      prompt,
      error: null,
    });

    await runImageJob(imageJob.id);
    const finished = getImageJob(imageJob.id);
    updatePortraitRequest(request.id, {
      status:
        finished.status === 'completed'
          ? 'completed'
          : finished.status === 'failed'
            ? 'failed'
            : finished.status === 'cancelled'
              ? 'cancelled'
              : 'interrupted',
      error: finished.error,
    });
  } catch (error) {
    if (isCancellation(error, runtime.controller.signal)) {
      finalizeJob(job.id, 'cancelled', { error: 'Portrait prompt generation stopped.' });
      updatePortraitRequest(request.id, {
        status: 'cancelled',
        error: 'Portrait generation stopped.',
      });
      return;
    }
    const message = error instanceof ProviderError ? error.message : errorMessage(error);
    finalizeJob(job.id, 'failed', { error: message });
    updatePortraitRequest(request.id, { status: 'failed', error: message });
  }
}

export function cancelChapterPortraitRequest(id: string): ChapterPortraitRequest {
  const request = getPortraitRequest(id);
  if (!['prompting', 'imaging'].includes(request.status)) {
    throw conflict('This portrait has already finished.');
  }
  if (request.status === 'prompting') {
    try {
      cancelJob(request.promptJobId);
    } catch {
      // The prompt job may have just finished.
    }
  } else if (request.imageJobId) {
    try {
      cancelImageGeneration(request.imageJobId);
    } catch {
      // The image job may have just finished.
    }
  }
  return updatePortraitRequest(id, {
    status: 'cancelled',
    error: 'Cancelled. Any saved images are kept.',
  });
}

export function chapterPortraitOverview(chapterId: string): ChapterPortraitOverview {
  const chapter = getChapter(chapterId);
  const text = currentChapterText(chapterId);
  const lower = text.toLowerCase();
  const characters = listCharacters(chapter.projectId).filter(
    (character) => character.status !== 'archived',
  );
  const assets = listChapterImageAssets(chapterId);
  const requests = listChapterPortraitRequests(chapterId);
  const roles = resolveRoles(chapter.projectId);

  const named: ChapterPortraitCandidate[] = [];
  const others: Character[] = [];
  for (const character of characters) {
    const mentionCount = countNameMentions(lower, character.name);
    if (mentionCount === 0) {
      others.push(character);
      continue;
    }
    const ownRequests = requests.filter((request) => request.characterId === character.id);
    named.push({
      character,
      mentionCount,
      assets: assets.filter((asset) => asset.characterId === character.id),
      activeRequest:
        ownRequests.find(
          (request) => request.status === 'prompting' || request.status === 'imaging',
        ) ?? null,
      latestRequest: ownRequests[0] ?? null,
    });
  }
  named.sort(
    (a, b) =>
      b.mentionCount - a.mentionCount || a.character.name.localeCompare(b.character.name),
  );

  return {
    chapterId,
    requests,
    visualStyle: getProjectVisualStyle(chapter.projectId),
    chapterTitle: chapter.title,
    chapterNumber: chapter.orderIndex + 1,
    hasText: Boolean(text.trim()),
    appearances: listChapterAppearances(chapterId),
    named,
    others,
    assets,
    activeRequests: requests.filter(
      (request) => request.status === 'prompting' || request.status === 'imaging',
    ),
    connections: listImageConnections(),
    templates: listImagePromptTemplates(chapter.projectId),
    imagePromptRole: roles.find((role) => role.role === 'image_prompt') ?? null,
  };
}

export function startImageGeneration(
  characterId: string,
  input: ImageGenerationInput,
): ImageJob {
  const character = getCharacterRow(characterId);
  const project = getProject(character.project_id);
  const connection = getImageConnection(input.connectionId);
  const prompt = textLimit(input.prompt, 8000, 'The image prompt');
  if (!prompt) throw badRequest('Write an image prompt before generating.');
  const negativePrompt = textLimit(input.negativePrompt, 4000, 'The negative prompt');

  if (input.chapterId) {
    const chapter = getChapter(input.chapterId);
    if (chapter.projectId !== project.id) {
      throw badRequest('That chapter belongs to another project.');
    }
  }
  if (activeImageJobForCharacter(characterId)) {
    throw conflict('An image is already being generated for this character.');
  }

  if (input.referenceAssetId) {
    const reference = getImageAsset(input.referenceAssetId);
    if (reference.characterId !== characterId) throw badRequest('Choose a reference image of this character.');
    if (connection.kind !== 'comfyui' || !connection.settings.referenceNode) throw badRequest('Reference images require a ComfyUI reference node configured in Image services.');
  }

  const job = createImageJob({
    projectId: project.id,
    characterId,
    chapterId: input.chapterId ?? null,
    connectionId: connection.id,
    providerKind: connection.kind,
    prompt,
    negativePrompt,
    templateId: input.templateId ?? null,
    templateName: input.templateName ?? null,
    templateContent: input.templateContent ?? '',
    settings: {...connection.settings, sourceRevisionId: input.sourceRevisionId ?? (input.chapterId ? getChapter(input.chapterId).currentRevisionId : null), sourceTextHash: input.sourceTextHash ?? (input.chapterId ? crypto.createHash('sha256').update(currentChapterText(input.chapterId)).digest('hex') : undefined), moment: input.moment ?? 'end', referenceAssetId: input.referenceAssetId ?? null},
  });
  void runImageJob(job.id);
  return job;
}

async function runImageJob(jobId: string): Promise<void> {
  const initial = getImageJob(jobId);
  if (initial.status !== 'queued') return;
  const controller = new AbortController();
  imageRuntimes.set(jobId, controller);
  updateImageJob(jobId, {
    status: 'running',
    started_at: new Date().toISOString(),
    error: null,
  });

  try {
    const savedConnection = getProviderImageConnection(initial.connectionId);
    const connection = {...savedConnection, settings: initial.settings};
    const result = await generateImage(connection, {
      prompt: initial.prompt,
      negativePrompt: initial.negativePrompt,
      signal: controller.signal,
      onRemoteId: (remoteId) => updateImageJob(jobId, { remote_id: remoteId }),
    });
    if (controller.signal.aborted || getImageJob(jobId).status === 'cancelled') return;
    const asset = saveGeneratedImage(initial, result, connection.name);
    updateImageJob(jobId, {
      status: 'completed',
      asset_id: asset.id,
      error: null,
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    const message = error instanceof ProviderError ? error.message : errorMessage(error);
    updateImageJob(jobId, {
      status: 'failed',
      error: message,
      finished_at: new Date().toISOString(),
    });
  } finally {
    imageRuntimes.delete(jobId);
  }
}

function saveGeneratedImage(
  job: ImageJob,
  result: GeneratedImage,
  connectionName: string | null,
): ImageAsset {
  const mimeType = sniffImageMime(result.bytes) ?? result.mimeType;
  const extension = IMAGE_EXTENSIONS[mimeType];
  if (!extension) {
    throw new ProviderError('The image service returned an unsupported image format.');
  }
  if (result.bytes.length > 25 * 1024 * 1024) {
    throw new ProviderError('The image service returned an image larger than 25 MB.');
  }
  const assetId = crypto.randomUUID();
  // Store a portable relative path so a data folder restored on another OS still works.
  const relative = `${job.projectId}/${assetId}.${extension}`;
  try {
    fs.mkdirSync(path.join(imagesRoot(), job.projectId), { recursive: true });
    fs.writeFileSync(path.join(imagesRoot(), relative), result.bytes);
  } catch (error) {
    throw new ProviderError(`The image could not be saved to the data directory: ${errorMessage(error)}`);
  }
  return createImageAsset({
    id: assetId,
    projectId: job.projectId,
    characterId: job.characterId,
    chapterId: job.chapterId,
    jobId: job.id,
    fileName: relative,
    mimeType,
    prompt: job.prompt,
    negativePrompt: job.negativePrompt,
    templateId: job.templateId,
    templateName: job.templateName,
    templateContent: job.templateContent,
    connectionId: job.connectionId,
    connectionName,
    providerKind: job.providerKind,
    settings: job.settings,
  });
}

export function cancelImageGeneration(jobId: string): ImageJob {
  const job = getImageJob(jobId);
  if (!['queued', 'running'].includes(job.status)) {
    throw conflict('This image generation has already finished.');
  }
  const controller = imageRuntimes.get(jobId);
  updateImageJob(jobId, {
    status: 'cancelled',
    error:
      'Cancelled locally. The image service may still finish the request in the background; nothing was saved.',
    finished_at: new Date().toISOString(),
  });
  controller?.abort();
  return getImageJob(jobId);
}

export function retryImageJob(jobId: string): ImageJob {
  const original = getImageJob(jobId);
  if (original.status === 'completed') {
    throw conflict('This image already completed. Use the saved image or start a new one.');
  }
  if (activeImageJobForCharacter(original.characterId)) {
    throw conflict('An image is already being generated for this character.');
  }
  if (original.status === 'interrupted' && original.providerKind === 'comfyui' && original.remoteId) {
    void resumeInterruptedImageJob(original);
    return getImageJob(original.id);
  }
  const connection = getImageConnection(original.connectionId);
  const retry = createImageJob({
    projectId: original.projectId,
    characterId: original.characterId,
    chapterId: original.chapterId,
    connectionId: original.connectionId,
    providerKind: connection.kind,
    prompt: original.prompt,
    negativePrompt: original.negativePrompt,
    templateId: original.templateId,
    templateName: original.templateName,
    templateContent: original.templateContent,
    settings: {...connection.settings, sourceRevisionId: original.settings.sourceRevisionId, sourceTextHash: original.settings.sourceTextHash, moment: original.settings.moment, referenceAssetId: original.settings.referenceAssetId},
  });
  void runImageJob(retry.id);
  return retry;
}

export function characterImageOverview(characterId: string): CharacterImageOverview {
  const character = getCharacter(characterId);
  const roles = resolveRoles(character.projectId);
  const imagePromptRole: ResolvedRole | null =
    roles.find((role) => role.role === 'image_prompt') ?? null;
  return {
    visualStyle: getProjectVisualStyle(character.projectId),
    character,
    assets: listCharacterImageAssets(character.id),
    jobs: listCharacterImageJobs(character.id),
    activeJob: activeImageJobForCharacter(character.id),
    connections: listImageConnections(),
    templates: listImagePromptTemplates(character.projectId),
    imagePromptRole,
  };
}

/** Resume polling saved ComfyUI requests; never resubmit them on recovery. */
export async function reconcileInterruptedImageJobs(): Promise<void> {
  await Promise.all(listInterruptedImageJobsWithRemoteId()
    .filter((job) => job.providerKind === 'comfyui' && job.remoteId)
    .map((job) => resumeInterruptedImageJob(job)));
}

async function resumeInterruptedImageJob(job: ImageJob): Promise<void> {
  if (imageRuntimes.has(job.id)) return;
  // Claim the job before the first await so retry/generate cannot submit a duplicate.
  if (activeImageJobForCharacter(job.characterId)) return;
  const controller = new AbortController();
  imageRuntimes.set(job.id, controller);
  updateImageJob(job.id, { status: 'running', error: null, finished_at: null });
  try {
    const saved = getProviderImageConnection(job.connectionId);
    if (saved.kind !== 'comfyui') throw badRequest('The original ComfyUI connection is no longer available.');
    const connection = { ...saved, settings: job.settings };
    const timeoutMs = Math.max(10, Math.min(1800, job.settings.timeoutSeconds ?? 300)) * 1000;
    const result = await recoverComfyImage(
      connection,
      job.remoteId!,
      AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    );
    if (!result || controller.signal.aborted || getImageJob(job.id).status === 'cancelled') return;
    const asset = saveGeneratedImage(job, result, connection.name);
    updateImageJob(job.id, {
      status: 'completed', asset_id: asset.id, error: null,
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    updateImageJob(job.id, {
      status: 'interrupted',
      error: `Could not recover the existing ComfyUI request: ${errorMessage(error)}. Retry checks the same remote request without submitting another workflow.`,
      finished_at: new Date().toISOString(),
    });
  } finally {
    imageRuntimes.delete(job.id);
  }
}

function trimText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[Excerpt trimmed.]`;
}
