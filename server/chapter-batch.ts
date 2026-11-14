import type { ChapterBatch, ChapterBatchItem } from '../shared/types.js';
import { conflict, errorMessage } from './errors.js';
import { listChapters } from './store/chapters.js';
import { getProject } from './store/projects.js';
import { requireLatestApprovedOutline } from './store/outline.js';
import {
  activeChapterBatch,
  createChapterBatch,
  getChapterBatch,
  updateChapterBatch,
} from './store/chapter-batches.js';
import { activeJobForChapterKind, cancelJob, getJob, isTerminal } from './jobs.js';
import { startChapterGeneration } from './generation.js';

interface RunnerState {
  cancelled: boolean;
}

const runners = new Map<string, RunnerState>();
const runnerProjects = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The auto-memory job starts just after the chapter job finishes. */
async function waitForMemory(chapterId: string, state: RunnerState): Promise<void> {
  await sleep(600);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (!state.cancelled && Date.now() < deadline) {
    const job = activeJobForChapterKind(chapterId, 'memory');
    if (!job) return;
    await sleep(1500);
  }
}

async function waitForJob(jobId: string, state: RunnerState): Promise<void> {
  while (true) {
    const job = getJob(jobId);
    if (isTerminal(job.status)) return;
    if (state.cancelled) {
      try {
        cancelJob(jobId);
      } catch {
        // The job may have finished between the status read and the cancel.
      }
    }
    await sleep(1200);
  }
}

function summarise(items: ChapterBatchItem[]): string {
  const completed = items.filter((item) => item.status === 'completed').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const skipped = items.filter((item) => item.status === 'skipped').length;
  const parts = [`${completed} drafted`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${parts.join(', ')}.`;
}

/**
 * Draft every planned chapter in order. Each chapter is generated only after
 * the previous one has finished and its automatic summary has been built, so
 * the context for later chapters includes the prose that came before it.
 */
export function startChapterBatch(projectId: string): ChapterBatch {
  getProject(projectId);
  requireLatestApprovedOutline(projectId);
  if (activeChapterBatch(projectId) || runnerProjects.has(projectId)) {
    throw conflict('A chapter batch is already running for this project.');
  }

  const chapters = listChapters(projectId);
  if (chapters.length === 0) {
    throw conflict('Approve an outline with chapters before drafting the whole novel.');
  }
  const busy = chapters.find((chapter) => activeJobForChapterKind(chapter.id, 'chapter'));
  if (busy) {
    throw conflict(
      `Chapter "${busy.title}" is already being generated. Wait for it to finish before starting a batch.`,
    );
  }

  const items: ChapterBatchItem[] = chapters.map((chapter) => {
    const alreadyWritten = Boolean(chapter.currentRevisionId) && chapter.wordCount > 0;
    return {
      chapterId: chapter.id,
      orderIndex: chapter.orderIndex,
      title: chapter.title,
      status: alreadyWritten ? 'skipped' : 'pending',
      jobId: null,
      revisionId: chapter.currentRevisionId,
      error: alreadyWritten ? 'Already has manuscript text; left untouched.' : null,
    };
  });

  const pending = items.filter((item) => item.status === 'pending');
  const batch = createChapterBatch({
    projectId,
    items,
    status: pending.length === 0 ? 'completed' : 'running',
    message:
      pending.length === 0
        ? 'Every chapter already has manuscript text. Nothing was generated.'
        : null,
  });
  if (pending.length > 0) {
    const state: RunnerState = { cancelled: false };
    runners.set(batch.id, state);
    runnerProjects.add(projectId);
    void runBatch(batch.id, projectId, state);
  }
  return batch;
}

async function runBatch(batchId: string, projectId: string, state: RunnerState): Promise<void> {
  try {
    const batch = getChapterBatch(batchId);
    const items = batch.items.map((item) => ({ ...item }));

    for (const item of items) {
      if (state.cancelled) break;
      if (item.status !== 'pending') continue;

      item.status = 'running';
      updateChapterBatch(batchId, { items });

      try {
        const job = startChapterGeneration(item.chapterId, {});
        item.jobId = job.id;
        updateChapterBatch(batchId, { items });
        await waitForJob(job.id, state);
        if (state.cancelled) {
          item.status = 'skipped';
          item.error = 'Stopped before this chapter finished.';
          break;
        }

        const finished = getJob(job.id);
        if (finished.status === 'completed') {
          item.status = 'completed';
          item.revisionId = finished.revisionId;
          item.error = null;
          updateChapterBatch(batchId, { items });
          await waitForMemory(item.chapterId, state);
        } else {
          item.status = 'failed';
          item.error = finished.error ?? `Generation ${finished.status} before a draft was saved.`;
        }
      } catch (error) {
        item.status = 'failed';
        item.error = errorMessage(error);
      }
      updateChapterBatch(batchId, { items });
    }

    if (state.cancelled) {
      const current = getChapterBatch(batchId);
      updateChapterBatch(batchId, {
        items,
        ...(current.status === 'running'
          ? {
              status: 'cancelled' as const,
              message: 'Batch stopped. Chapters already drafted are saved.',
            }
          : {}),
      });
      return;
    }

    updateChapterBatch(batchId, {
      status: 'completed',
      items,
      message: summarise(items),
    });
  } catch (error) {
    updateChapterBatch(batchId, {
      status: 'completed',
      message: `The batch stopped unexpectedly: ${errorMessage(error)}`,
    });
  } finally {
    runners.delete(batchId);
    runnerProjects.delete(projectId);
  }
}

export function cancelChapterBatch(projectId: string): ChapterBatch {
  const batch = activeChapterBatch(projectId);
  if (!batch) throw conflict('No chapter batch is running for this project.');
  const state = runners.get(batch.id);
  if (!state) {
    return updateChapterBatch(batch.id, {
      status: 'interrupted',
      message: 'The batch was no longer running in this server process. Start a new batch to continue.',
    });
  }
  state.cancelled = true;

  // Stop the in-flight chapter immediately instead of waiting for the poll.
  const runningItem = batch.items.find((item) => item.status === 'running' && item.jobId);
  if (runningItem?.jobId) {
    try {
      cancelJob(runningItem.jobId);
    } catch {
      // The chapter may have finished between the read and the cancel.
    }
  }

  const items = batch.items.map((item) =>
    item.status === 'running'
      ? {
          ...item,
          status: 'skipped' as const,
          error: 'Stopped before this chapter finished.',
        }
      : item,
  );

  return updateChapterBatch(batch.id, {
    status: 'cancelled',
    items,
    message: 'Batch stopped. Chapters already drafted are saved.',
  });
}
