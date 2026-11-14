import type { ChapterPortraitRequest, PortraitBatch, PortraitBatchItem } from '../shared/types.js';
import { badRequest, conflict, errorMessage } from './errors.js';
import { listChapters, currentChapterText } from './store/chapters.js';
import { getCharacter } from './store/characters.js';
import { getProject } from './store/projects.js';
import { getImageConnection, listImageConnections } from './store/image-connections.js';
import { resolveRoles } from './store/settings.js';
import {
  activePortraitRequestForCharacter,
  getPortraitRequest,
  updatePortraitRequest,
} from './store/portrait-requests.js';
import {
  activeImageJobForCharacter,
  getImageJob,
  listProjectImageAssets,
  selectChapterImage,
} from './store/images.js';
import {
  activePortraitBatch,
  createPortraitBatch,
  getPortraitBatch,
  updatePortraitBatch,
} from './store/portrait-batches.js';
import { cancelChapterPortraitRequest, startChapterPortraitRequest } from './image-generation.js';

export interface PortraitBatchInput {
  connectionId?: string | null;
  templateId?: string | null;
  instructions?: string;
  moment?: 'start' | 'end' | 'custom';
  scene?: string;
  visualStyle?: string;
  /** Leave chapters that already have an image of this character untouched. */
  skipExisting?: boolean;
  /** Make each new image the chapter's selected image for this character. */
  selectForChapter?: boolean;
}

interface RunnerState {
  cancelled: boolean;
}

const runners = new Map<string, RunnerState>();
const runnerCharacters = new Set<string>();
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function summarise(items: PortraitBatchItem[]): string {
  const completed = items.filter((item) => item.status === 'completed').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const skipped = items.filter((item) => item.status === 'skipped').length;
  const parts = [`${completed} portrait${completed === 1 ? '' : 's'} drawn`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${parts.join(', ')}.`;
}

/**
 * Queue one portrait of a single character for every chapter with manuscript
 * text. A character can only have one portrait in flight, so the runner walks
 * the chapters in order and waits for each image before starting the next.
 */
export function startPortraitBatch(
  characterId: string,
  input: PortraitBatchInput = {},
): PortraitBatch {
  const character = getCharacter(characterId);
  if (character.status === 'archived') {
    throw badRequest('Archived characters cannot receive new portraits.');
  }
  const project = getProject(character.projectId);

  if (activePortraitBatch(character.id) || runnerCharacters.has(character.id)) {
    throw conflict(`A portrait batch is already running for ${character.name}.`);
  }
  if (activePortraitRequestForCharacter(character.id) || activeImageJobForCharacter(character.id)) {
    throw conflict(
      `A portrait is already being generated for ${character.name}. Wait for it to finish before starting a batch.`,
    );
  }

  const imagePromptRole = resolveRoles(project.id).find((role) => role.role === 'image_prompt');
  if (!imagePromptRole?.connectionId || !imagePromptRole.model) {
    throw conflict(
      'Choose an image-prompt model in Settings before generating chapter images.',
    );
  }
  if (input.connectionId) {
    getImageConnection(input.connectionId);
  } else if (!listImageConnections()[0]) {
    throw conflict('Add an image service in Settings before generating chapter images.');
  }

  const chapters = listChapters(project.id);
  if (chapters.length === 0) {
    throw conflict('Approve an outline with chapters before generating chapter images.');
  }

  const existing = new Map<string, boolean>();
  for (const asset of listProjectImageAssets(project.id)) {
    if (asset.characterId === character.id && asset.chapterId) {
      existing.set(asset.chapterId, true);
    }
  }

  const items: PortraitBatchItem[] = chapters.map((chapter) => {
    const hasText = Boolean(currentChapterText(chapter.id).trim());
    const alreadyDrawn = existing.has(chapter.id);
    const skipExisting = input.skipExisting !== false;
    const skipped = !hasText || (skipExisting && alreadyDrawn);
    return {
      chapterId: chapter.id,
      orderIndex: chapter.orderIndex,
      title: chapter.title,
      status: skipped ? 'skipped' : 'pending',
      requestId: null,
      assetId: null,
      error: !hasText
        ? 'No manuscript text yet; draft this chapter first.'
        : skipped
          ? `Already has an image of ${character.name}.`
          : null,
    };
  });

  const pending = items.filter((item) => item.status === 'pending');
  const batch = createPortraitBatch({
    projectId: project.id,
    characterId: character.id,
    items,
    status: pending.length === 0 ? 'completed' : 'running',
    message:
      pending.length === 0
        ? `Nothing to draw for ${character.name}. Every chapter either has no text or already has an image.`
        : `Queued ${pending.length} chapter image${pending.length === 1 ? '' : 's'} for ${character.name}.`,
  });
  if (pending.length > 0) {
    const state: RunnerState = { cancelled: false };
    runners.set(batch.id, state);
    runnerCharacters.add(character.id);
    void runPortraitBatch(batch.id, input, state);
  }
  return batch;
}

async function runPortraitBatch(
  batchId: string,
  input: PortraitBatchInput,
  state: RunnerState,
): Promise<void> {
  try {
    const batch = getPortraitBatch(batchId);
    const items = batch.items.map((item) => ({ ...item }));
    const selectForChapter = input.selectForChapter !== false;

    for (const item of items) {
      if (state.cancelled) break;
      if (item.status !== 'pending') continue;

      item.status = 'running';
      updatePortraitBatch(batchId, { items });

      try {
        const request = startChapterPortraitRequest(item.chapterId, {
          characterId: batch.characterId,
          connectionId: input.connectionId ?? null,
          templateId: input.templateId ?? null,
          instructions: input.instructions,
          moment: input.moment,
          scene: input.scene,
          visualStyle: input.visualStyle,
        });
        item.requestId = request.id;
        updatePortraitBatch(batchId, { items });

        const finished = await waitForPortraitRequest(request.id, state);
        if (state.cancelled) {
          item.status = 'skipped';
          item.error = 'Stopped before this image finished.';
          break;
        }

        if (finished.status === 'completed') {
          const assetId = finished.imageJobId
            ? getImageJob(finished.imageJobId).assetId
            : null;
          item.status = 'completed';
          item.error = null;
          item.assetId = assetId;
          if (selectForChapter && assetId) {
            try {
              selectChapterImage(item.chapterId, assetId);
            } catch {
              // A selection conflict must not fail an image that was drawn.
            }
          }
        } else {
          item.status = 'failed';
          item.error = finished.error ?? `The portrait ${finished.status} before an image was saved.`;
        }
      } catch (error) {
        item.status = 'failed';
        item.error = errorMessage(error);
      }
      updatePortraitBatch(batchId, { items });
    }

    if (state.cancelled) {
      updatePortraitBatch(batchId, {
        status: 'cancelled',
        items,
        message: 'Portrait batch stopped. Images already drawn are saved.',
      });
      return;
    }

    updatePortraitBatch(batchId, {
      status: 'completed',
      items,
      message: summarise(items),
    });
  } catch (error) {
    updatePortraitBatch(batchId, {
      status: 'completed',
      message: `The portrait batch stopped unexpectedly: ${errorMessage(error)}`,
    });
  } finally {
    runners.delete(batchId);
    const batch = getPortraitBatch(batchId);
    if (!activePortraitBatch(batch.characterId)) {
      runnerCharacters.delete(batch.characterId);
    }
  }
}

async function waitForPortraitRequest(
  requestId: string,
  state: RunnerState,
): Promise<ChapterPortraitRequest> {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (true) {
    const request = getPortraitRequest(requestId);
    if (TERMINAL.has(request.status)) return request;
    const timedOut = Date.now() > deadline;
    if (state.cancelled || timedOut) {
      try {
        cancelChapterPortraitRequest(requestId);
        if (timedOut && !state.cancelled) {
          updatePortraitRequest(requestId, {
            status: 'interrupted',
            error: 'This portrait took too long and was stopped. It can be retried individually.',
          });
        }
      } catch {
        // The portrait may have finished between the read and the cancel.
      }
      return getPortraitRequest(requestId);
    }
    await sleep(1200);
  }
}

export function cancelPortraitBatch(batchId: string): PortraitBatch {
  const batch = getPortraitBatch(batchId);
  if (batch.status !== 'running') {
    throw conflict('This portrait batch has already finished.');
  }
  const state = runners.get(batchId);
  if (!state) {
    return updatePortraitBatch(batch.id, {
      status: 'interrupted',
      message:
        'The batch was no longer running in this server process. Start a new batch to continue.',
    });
  }
  state.cancelled = true;

  const running = batch.items.find((item) => item.status === 'running' && item.requestId);
  if (running?.requestId) {
    try {
      cancelChapterPortraitRequest(running.requestId);
    } catch {
      // The portrait may have finished between the read and the cancel.
    }
  }

  const items = batch.items.map((item) =>
    item.status === 'running'
      ? {
          ...item,
          status: 'skipped' as const,
          error: 'Stopped before this image finished.',
        }
      : item,
  );
  return updatePortraitBatch(batch.id, {
    status: 'cancelled',
    items,
    message: 'Portrait batch stopped. Images already drawn are saved.',
  });
}
