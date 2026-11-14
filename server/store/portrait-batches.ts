import crypto from 'node:crypto';
import type {
  PortraitBatch,
  PortraitBatchItem,
  PortraitBatchItemStatus,
  PortraitBatchStatus,
} from '../../shared/types.js';
import { dbGet, dbRun, timestamp } from '../db.js';
import { notFound } from '../errors.js';

interface PortraitBatchRow {
  id: string;
  project_id: string;
  character_id: string;
  status: PortraitBatchStatus;
  items: string;
  message: string | null;
  created_at: string;
  updated_at: string;
}

function parseItems(raw: string): PortraitBatchItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry): PortraitBatchItem => {
        const status: PortraitBatchItemStatus =
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
          requestId: typeof entry.requestId === 'string' ? entry.requestId : null,
          assetId: typeof entry.assetId === 'string' ? entry.assetId : null,
          error: typeof entry.error === 'string' ? entry.error : null,
        };
      })
      .filter((entry) => entry.chapterId);
  } catch {
    return [];
  }
}

function mapBatch(row: PortraitBatchRow): PortraitBatch {
  return {
    id: row.id,
    projectId: row.project_id,
    characterId: row.character_id,
    status: row.status,
    items: parseItems(row.items),
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPortraitBatch(id: string): PortraitBatch {
  const row = dbGet<PortraitBatchRow>('SELECT * FROM portrait_batches WHERE id = ?', id);
  if (!row) throw notFound('Portrait batch not found.');
  return mapBatch(row);
}

export function latestPortraitBatch(characterId: string): PortraitBatch | null {
  const row = dbGet<PortraitBatchRow>(
    'SELECT * FROM portrait_batches WHERE character_id = ? ORDER BY created_at DESC LIMIT 1',
    characterId,
  );
  return row ? mapBatch(row) : null;
}

export function activePortraitBatch(characterId: string): PortraitBatch | null {
  const row = dbGet<PortraitBatchRow>(
    `SELECT * FROM portrait_batches WHERE character_id = ? AND status = 'running'
     ORDER BY created_at DESC LIMIT 1`,
    characterId,
  );
  return row ? mapBatch(row) : null;
}

export function createPortraitBatch(params: {
  projectId: string;
  characterId: string;
  items: PortraitBatchItem[];
  status: PortraitBatchStatus;
  message?: string | null;
}): PortraitBatch {
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO portrait_batches (
       id, project_id, character_id, status, items, message, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    params.projectId,
    params.characterId,
    params.status,
    JSON.stringify(params.items),
    params.message ?? null,
    at,
    at,
  );
  return getPortraitBatch(id);
}

export function updatePortraitBatch(
  id: string,
  patch: {
    status?: PortraitBatchStatus;
    items?: PortraitBatchItem[];
    message?: string | null;
  },
): PortraitBatch {
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
  dbRun(`UPDATE portrait_batches SET ${fields.join(', ')} WHERE id = ?`, ...values, id);
  return getPortraitBatch(id);
}
