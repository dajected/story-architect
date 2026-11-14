import crypto from 'node:crypto';
import type {
  ChapterBatch,
  ChapterBatchItem,
  ChapterBatchItemStatus,
  ChapterBatchStatus,
} from '../../shared/types.js';
import { dbGet, dbRun, timestamp } from '../db.js';
import { notFound } from '../errors.js';

interface BatchRow {
  id: string;
  project_id: string;
  status: ChapterBatchStatus;
  items: string;
  message: string | null;
  created_at: string;
  updated_at: string;
}

function parseItems(raw: string): ChapterBatchItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry): ChapterBatchItem => {
        const status: ChapterBatchItemStatus =
          entry.status === 'running' ||
          entry.status === 'completed' ||
          entry.status === 'failed' ||
          entry.status === 'skipped'
            ? entry.status
            : 'pending';
        return {
          chapterId: String(entry.chapterId ?? ''),
          orderIndex: Number(entry.orderIndex ?? 0),
          title: String(entry.title ?? ''),
          status,
          jobId: typeof entry.jobId === 'string' ? entry.jobId : null,
          revisionId: typeof entry.revisionId === 'string' ? entry.revisionId : null,
          error: typeof entry.error === 'string' ? entry.error : null,
        };
      })
      .filter((entry) => entry.chapterId);
  } catch {
    return [];
  }
}

function mapBatch(row: BatchRow): ChapterBatch {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    items: parseItems(row.items),
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getChapterBatch(id: string): ChapterBatch {
  const row = dbGet<BatchRow>('SELECT * FROM chapter_batches WHERE id = ?', id);
  if (!row) throw notFound('Chapter batch not found.');
  return mapBatch(row);
}

export function latestChapterBatch(projectId: string): ChapterBatch | null {
  const row = dbGet<BatchRow>(
    'SELECT * FROM chapter_batches WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
    projectId,
  );
  return row ? mapBatch(row) : null;
}

export function activeChapterBatch(projectId: string): ChapterBatch | null {
  const row = dbGet<BatchRow>(
    `SELECT * FROM chapter_batches WHERE project_id = ? AND status = 'running'
     ORDER BY created_at DESC LIMIT 1`,
    projectId,
  );
  return row ? mapBatch(row) : null;
}

export function createChapterBatch(params: {
  projectId: string;
  items: ChapterBatchItem[];
  status: ChapterBatchStatus;
  message?: string | null;
}): ChapterBatch {
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO chapter_batches (id, project_id, status, items, message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    params.projectId,
    params.status,
    JSON.stringify(params.items),
    params.message ?? null,
    at,
    at,
  );
  return getChapterBatch(id);
}

export function updateChapterBatch(
  id: string,
  patch: {
    status?: ChapterBatchStatus;
    items?: ChapterBatchItem[];
    message?: string | null;
  },
): ChapterBatch {
  const fields: string[] = [];
  const values: Array<string | null> = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.items !== undefined) {
    fields.push('items = ?');
    values.push(JSON.stringify(patch.items));
  }
  if (patch.message !== undefined) {
    fields.push('message = ?');
    values.push(patch.message);
  }
  fields.push('updated_at = ?');
  values.push(timestamp());
  dbRun(`UPDATE chapter_batches SET ${fields.join(', ')} WHERE id = ?`, ...values, id);
  return getChapterBatch(id);
}
