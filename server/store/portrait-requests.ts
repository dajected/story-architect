import crypto from 'node:crypto';
import type {
  ChapterPortraitRequest,
  ChapterPortraitStatus,
} from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { notFound } from '../errors.js';

interface PortraitRequestRow {
  id: string;
  project_id: string;
  chapter_id: string;
  character_id: string;
  prompt_job_id: string;
  image_job_id: string | null;
  status: ChapterPortraitStatus;
  prompt: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function mapRequest(row: PortraitRequestRow): ChapterPortraitRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    characterId: row.character_id,
    status: row.status,
    promptJobId: row.prompt_job_id,
    imageJobId: row.image_job_id,
    prompt: row.prompt,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPortraitRequest(id: string): ChapterPortraitRequest {
  const row = dbGet<PortraitRequestRow>('SELECT * FROM chapter_portrait_jobs WHERE id = ?', id);
  if (!row) throw notFound('Character portrait request not found.');
  return mapRequest(row);
}

export function listChapterPortraitRequests(chapterId: string): ChapterPortraitRequest[] {
  const rows = dbAll<PortraitRequestRow>(
    'SELECT * FROM chapter_portrait_jobs WHERE chapter_id = ? ORDER BY created_at DESC',
    chapterId,
  );
  return rows.map(mapRequest);
}

export function activePortraitRequestForCharacter(
  characterId: string,
): ChapterPortraitRequest | null {
  const row = dbGet<PortraitRequestRow>(
    `SELECT * FROM chapter_portrait_jobs
      WHERE character_id = ? AND status IN ('prompting', 'imaging')
      ORDER BY created_at DESC LIMIT 1`,
    characterId,
  );
  return row ? mapRequest(row) : null;
}

export function createPortraitRequest(params: {
  projectId: string;
  chapterId: string;
  characterId: string;
  promptJobId: string;
  status: ChapterPortraitStatus;
}): ChapterPortraitRequest {
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO chapter_portrait_jobs (
       id, project_id, chapter_id, character_id, prompt_job_id, image_job_id, status,
       prompt, error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, '', NULL, ?, ?)`,
    id,
    params.projectId,
    params.chapterId,
    params.characterId,
    params.promptJobId,
    params.status,
    at,
    at,
  );
  return getPortraitRequest(id);
}

export function updatePortraitRequest(
  id: string,
  patch: Partial<
    Pick<ChapterPortraitRequest, 'status' | 'imageJobId' | 'prompt' | 'error'>
  >,
): ChapterPortraitRequest {
  const fields: string[] = [];
  const values: Array<string | null> = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.imageJobId !== undefined) {
    fields.push('image_job_id = ?');
    values.push(patch.imageJobId);
  }
  if (patch.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(patch.prompt);
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    values.push(patch.error);
  }
  fields.push('updated_at = ?');
  values.push(timestamp());
  dbRun(`UPDATE chapter_portrait_jobs SET ${fields.join(', ')} WHERE id = ?`, ...values, id);
  return getPortraitRequest(id);
}
