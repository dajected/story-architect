import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
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
import { getCharacter, getCharacterRow } from './store/characters.js';
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
  listCharacterImageAssets,
  listCharacterImageJobs,
  listInterruptedImageJobsWithRemoteId,
  updateImageJob,
} from './store/images.js';
import { getProject } from './store/projects.js';
import { getProjectGeneration, resolveRoles, resolveTaskModel } from './store/settings.js';
import { streamChat } from './providers.js';

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
      clothing: clothing || '(not specified)',
      personality: character.personality,
      goals: character.goals,
      notes: character.notes,
      scene: sceneText,
      chapterTitle: chapter?.title ?? '',
      chapterBrief: chapter?.brief ?? '',
      visualStyle: visualStyle || project.styleNotes || 'cinematic character portrait',
      additionalInstructions: instructions || 'None.',
    }),
  );

  const model = resolveTaskModel(project.id, 'image_prompt');
  const settings = getProjectGeneration(project.id);
  const system = `${IMAGE_PROMPT_SYSTEM}\n\n${rendered}`;

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
