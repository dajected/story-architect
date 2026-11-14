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
} from './jobs.js';
import {
  generateImage,
  recoverComfyImage,
  sniffImageMime,
} from './image-providers.js';
import type { GeneratedImage } from './image-providers.js';
import { ProviderError } from './providers.js';
import { IMAGE_PROMPT_SYSTEM, imagePromptValues, renderTemplate } from './prompts.js';
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
  imagesRoot,
  listChapterImageAssets,
  listCharacterImageAssets,
  listCharacterImageJobs,
  listInterruptedImageJobsWithRemoteId,
  updateImageJob,
} from './store/images.js';
import { chapterCharacterFacts } from './store/memory.js';
import {
  activePortraitRequestForCharacter,
  createPortraitRequest,
  getPortraitRequest,
  listChapterPortraitRequests,
  updatePortraitRequest,
} from './store/portrait-requests.js';
import { getProject } from './store/projects.js';
import { getProjectGeneration, resolveRoles, resolveTaskModel } from './store/settings.js';
import { streamChat } from './providers.js';
import type { ProviderConnection } from './providers.js';

const imageRuntimes = new Map<string, AbortController>();

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
  const sceneText = [
    scene || chapter?.brief || '(No scene was specified; use an evocative portrait setting.)',
    chapterText.trim()
      ? `Current chapter excerpt for visual reference:\n${trimText(chapterText, 4000)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const visualStyleValue = visualStyle || project.styleNotes || 'cinematic character portrait';
  const clothingValue = clothing || '(not specified)';
  const rendered = renderTemplate(
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
  );
  const reference = referenceDetailsBlock(template.content, [
    { key: 'novel_title', label: 'Novel', value: project.title },
    { key: 'genre', label: 'Genre', value: project.genre },
    { key: 'tone', label: 'Tone', value: project.tone },
    { key: 'project_style', label: 'Story style', value: project.styleNotes },
    { key: 'character_name', label: 'Character name', value: character.name },
    { key: 'character_role', label: 'Role', value: character.role },
    { key: 'identity', label: 'Identity', value: character.identity },
    { key: 'appearance', label: 'Appearance', value: character.appearance },
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
  ]);

  const model = resolveTaskModel(project.id, 'image_prompt');
  const settings = getProjectGeneration(project.id);
  const system = [IMAGE_PROMPT_SYSTEM, rendered, reference].filter(Boolean).join('\n\n');

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
      maxTokens: 700,
    }),
  });

  void (async () => {
    const runtime = createRuntime(job.id);
    try {
      const result = await streamChat(model.provider, {
        model: job.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: 'Write the final image prompt now. Return only the prompt.' },
        ],
        temperature: settings.temperature ?? 0.7,
        topP: null,
        maxTokens: 700,
        signal: runtime.controller.signal,
        onDelta: (text) => appendOutput(job.id, text),
      });
      if (!result.content.trim()) {
        finalizeJob(job.id, 'failed', {
          error: 'The image-prompt model returned an empty reply. Try again or write the prompt by hand.',
          usage: result.usage,
        });
        return;
      }
      if (looksLikeClarificationRequest(result.content)) {
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
  connectionId: string;
  prompt: string;
  negativePrompt?: string;
  chapterId?: string | null;
  templateId?: string | null;
  templateName?: string | null;
  templateContent?: string | null;
}

export interface ChapterPortraitInput {
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
  const cleaned = raw
    .replace(/```[a-z]*\s*/gi, '')
    .replace(/```/g, '')
    .replace(/^\s*(image\s+prompt|prompt)\s*:\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  return cleaned || raw.trim();
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
): string {
  const used = new Set<string>();
  for (const match of templateContent.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const key = match[1];
    if (key) used.add(key);
  }
  const missing = details.filter(
    (detail) => !used.has(detail.key) && (detail.value ?? '').trim().length > 0,
  );
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

/** Keep both the opening and the closing of a chapter, weighted to the ending. */
function chapterExcerpt(text: string, limit = 7000): string {
  if (text.length <= limit) return text.trim();
  const head = Math.floor(limit * 0.2);
  const tail = limit - head;
  return `${text.slice(0, head).trim()}\n\n[Middle of the chapter omitted.]\n\n${text
    .slice(-tail)
    .trim()}`;
}

function chapterEndChanges(chapterId: string, characterId: string): string[] {
  try {
    return chapterCharacterFacts(chapterId, characterId);
  } catch {
    return [];
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
  if (!text.trim()) {
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
  const changes = chapterEndChanges(chapterId, character.id);
  const sceneText = [
    `A portrait of ${character.name} at the very end of Chapter ${chapterNumber}, "${chapter.title}", after all of the events in that chapter.`,
    '',
    changes.length > 0
      ? `Physical changes and circumstances established by this chapter:\n${changes
          .map((change) => `- ${change}`)
          .join('\n')}`
      : 'No explicit physical changes were recorded. Use the established appearance, plus anything the closing text clearly shows.',
    '',
    `Closing passage of the chapter (for clothing, injuries, condition, setting, mood and lighting):\n${chapterExcerpt(text)}`,
    '',
    `Show ${character.name} exactly as they appear at this point: the end of the chapter, not the start.`,
  ].join('\n');

  const clothingValue =
    'As established by the character profile and the chapter. Change, damage or remove clothing only where the chapter supports it.';
  const visualStyleValue =
    project.styleNotes || 'cinematic character portrait, painterly book-cover illustration';
  const additionalInstructionsValue =
    instructions ||
    'A solo character portrait with a clear view of the face and upper body. No other people, captions or text. The image must reflect the character’s end-of-chapter state.';

  const rendered = renderTemplate(
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
  );
  const reference = referenceDetailsBlock(template.content, [
    { key: 'novel_title', label: 'Novel', value: project.title },
    { key: 'genre', label: 'Genre', value: project.genre },
    { key: 'tone', label: 'Tone', value: project.tone },
    { key: 'project_style', label: 'Story style', value: project.styleNotes },
    { key: 'character_name', label: 'Character name', value: character.name },
    { key: 'character_role', label: 'Role', value: character.role },
    { key: 'identity', label: 'Identity', value: character.identity },
    { key: 'appearance', label: 'Appearance', value: character.appearance },
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
  ]);

  const system = [IMAGE_PROMPT_SYSTEM, rendered, reference].filter(Boolean).join('\n\n');
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
      maxTokens: 900,
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
    connectionId: connection.id,
    templateId: template.id,
    templateName: template.name,
    templateContent: template.content,
    temperature: settings.temperature ?? 0.7,
  });

  return request;
}

async function runChapterPortrait(
  job: GenerationJob,
  request: ChapterPortraitRequest,
  options: {
    provider: ProviderConnection;
    system: string;
    connectionId: string;
    templateId: string | null;
    templateName: string;
    templateContent: string;
    temperature: number;
  },
): Promise<void> {
  const runtime = createRuntime(job.id);
  try {
    const result = await streamChat(options.provider, {
      model: job.model,
      messages: [
        { role: 'system', content: options.system },
        {
          role: 'user',
          content:
            'Write the final image prompt for this character at the end of the chapter now. Return only the prompt.',
        },
      ],
      temperature: options.temperature,
      topP: null,
      maxTokens: 900,
      signal: runtime.controller.signal,
      onDelta: (text) => appendOutput(job.id, text),
    });
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
      settings: imageConnection.settings,
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
    chapterTitle: chapter.title,
    chapterNumber: chapter.orderIndex + 1,
    hasText: Boolean(text.trim()),
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
    settings: connection.settings,
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
    const connection = getProviderImageConnection(initial.connectionId);
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
    settings: connection.settings,
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
