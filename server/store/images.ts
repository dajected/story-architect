import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ImageAsset,
  ImageConnectionKind,
  ImageJob,
  ImageJobStatus,
  ImageProviderSettings,
} from '../../shared/types.js';
import { config } from '../config.js';
import { dbAll, dbGet, dbRun, timestamp, transaction } from '../db.js';
import { badRequest } from '../errors.js';
import { notFound } from '../errors.js';

export interface ImageJobRow {
  id: string;
  project_id: string;
  character_id: string;
  chapter_id: string | null;
  connection_id: string;
  provider_kind: ImageConnectionKind;
  status: ImageJobStatus;
  prompt: string;
  negative_prompt: string;
  template_id: string | null;
  template_name: string | null;
  template_content: string;
  settings: string;
  remote_id: string | null;
  asset_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ImageAssetRow {
  selected_for_chapter?: number;
  id: string;
  project_id: string;
  character_id: string;
  chapter_id: string | null;
  job_id: string | null;
  file_name: string;
  mime_type: string;
  prompt: string;
  negative_prompt: string;
  template_id: string | null;
  template_name: string | null;
  template_content: string;
  connection_id: string | null;
  connection_name: string | null;
  provider_kind: ImageConnectionKind;
  settings: string;
  created_at: string;
}

function parseSettings(raw: string | null | undefined): ImageProviderSettings {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ImageProviderSettings)
      : {};
  } catch {
    return {};
  }
}

function mapJob(row: ImageJobRow): ImageJob {
  return {
    id: row.id,
    projectId: row.project_id,
    characterId: row.character_id,
    chapterId: row.chapter_id,
    connectionId: row.connection_id,
    providerKind: row.provider_kind,
    status: row.status,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt,
    templateId: row.template_id,
    templateName: row.template_name,
    templateContent: row.template_content,
    settings: parseSettings(row.settings),
    remoteId: row.remote_id,
    assetId: row.asset_id,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapAsset(row: ImageAssetRow): ImageAsset {
  const settings = parseSettings(row.settings);
  const chapter = row.chapter_id ? dbGet<{current_revision_id: string | null; content: string | null}>('SELECT c.current_revision_id, r.content FROM chapters c LEFT JOIN chapter_revisions r ON r.id = c.current_revision_id WHERE c.id = ?', row.chapter_id) : null;
  return {
    selectedForChapter: row.selected_for_chapter === 1,
    sourceOutdated: Boolean(row.chapter_id && (!settings.sourceRevisionId || settings.sourceRevisionId !== chapter?.current_revision_id || !settings.sourceTextHash || settings.sourceTextHash !== crypto.createHash('sha256').update(chapter?.content ?? '').digest('hex'))),
    id: row.id,
    projectId: row.project_id,
    characterId: row.character_id,
    chapterId: row.chapter_id,
    jobId: row.job_id,
    url: `/api/image-assets/${row.id}/file`,
    mimeType: row.mime_type,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt,
    templateId: row.template_id,
    templateName: row.template_name,
    templateContent: row.template_content,
    connectionId: row.connection_id,
    connectionName: row.connection_name,
    providerKind: row.provider_kind,
    settings: parseSettings(row.settings),
    createdAt: row.created_at,
  };
}

export function getImageJobRow(id: string): ImageJobRow {
  const row = dbGet<ImageJobRow>('SELECT * FROM image_jobs WHERE id = ?', id);
  if (!row) throw notFound('Image job not found.');
  return row;
}

export function getImageJob(id: string): ImageJob {
  return mapJob(getImageJobRow(id));
}

export interface CreateImageJobInput {
  projectId: string;
  characterId: string;
  chapterId: string | null;
  connectionId: string;
  providerKind: ImageConnectionKind;
  prompt: string;
  negativePrompt: string;
  templateId: string | null;
  templateName: string | null;
  templateContent: string;
  settings: ImageProviderSettings;
}

export function createImageJob(input: CreateImageJobInput): ImageJob {
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO image_jobs (
       id, project_id, character_id, chapter_id, connection_id, provider_kind, status,
       prompt, negative_prompt, template_id, template_name, template_content, settings,
       remote_id, asset_id, error, created_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)`,
    id,
    input.projectId,
    input.characterId,
    input.chapterId,
    input.connectionId,
    input.providerKind,
    input.prompt,
    input.negativePrompt,
    input.templateId,
    input.templateName,
    input.templateContent,
    JSON.stringify(input.settings),
    at,
  );
  return getImageJob(id);
}

export function updateImageJob(
  id: string,
  patch: Partial<
    Pick<
      ImageJobRow,
      'status' | 'error' | 'remote_id' | 'asset_id' | 'started_at' | 'finished_at'
    >
  >,
): ImageJob {
  const fields: string[] = [];
  const values: Array<string | null> = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    values.push(patch.error);
  }
  if (patch.remote_id !== undefined) {
    fields.push('remote_id = ?');
    values.push(patch.remote_id);
  }
  if (patch.asset_id !== undefined) {
    fields.push('asset_id = ?');
    values.push(patch.asset_id);
  }
  if (patch.started_at !== undefined) {
    fields.push('started_at = ?');
    values.push(patch.started_at);
  }
  if (patch.finished_at !== undefined) {
    fields.push('finished_at = ?');
    values.push(patch.finished_at);
  }
  if (fields.length > 0) {
    dbRun(`UPDATE image_jobs SET ${fields.join(', ')} WHERE id = ?`, ...values, id);
  }
  return getImageJob(id);
}

export function activeImageJobForCharacter(characterId: string): ImageJob | null {
  const row = dbGet<ImageJobRow>(
    `SELECT * FROM image_jobs WHERE character_id = ? AND status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    characterId,
  );
  return row ? mapJob(row) : null;
}

export function listCharacterImageJobs(characterId: string, limit = 20): ImageJob[] {
  const rows = dbAll<ImageJobRow>(
    'SELECT * FROM image_jobs WHERE character_id = ? ORDER BY created_at DESC LIMIT ?',
    characterId,
    limit,
  );
  return rows.map(mapJob);
}

export function listInterruptedImageJobsWithRemoteId(): ImageJob[] {
  const rows = dbAll<ImageJobRow>(
    `SELECT * FROM image_jobs
     WHERE status = 'interrupted' AND remote_id IS NOT NULL
     ORDER BY created_at ASC`,
  );
  return rows.map(mapJob);
}

export interface CreateImageAssetInput {
  id: string;
  projectId: string;
  characterId: string;
  chapterId: string | null;
  jobId: string | null;
  fileName: string;
  mimeType: string;
  prompt: string;
  negativePrompt: string;
  templateId: string | null;
  templateName: string | null;
  templateContent: string;
  connectionId: string | null;
  connectionName: string | null;
  providerKind: ImageConnectionKind;
  settings: ImageProviderSettings;
}

export function createImageAsset(input: CreateImageAssetInput): ImageAsset {
  dbRun(
    `INSERT INTO image_assets (
       id, project_id, character_id, chapter_id, job_id, file_name, mime_type, prompt,
       negative_prompt, template_id, template_name, template_content, connection_id,
       connection_name, provider_kind, settings, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.projectId,
    input.characterId,
    input.chapterId,
    input.jobId,
    input.fileName,
    input.mimeType,
    input.prompt,
    input.negativePrompt,
    input.templateId,
    input.templateName,
    input.templateContent,
    input.connectionId,
    input.connectionName,
    input.providerKind,
    JSON.stringify(input.settings),
    timestamp(),
  );
  return getImageAsset(input.id);
}

export function getImageAssetRow(id: string): ImageAssetRow {
  const row = dbGet<ImageAssetRow>('SELECT * FROM image_assets WHERE id = ?', id);
  if (!row) throw notFound('Image not found.');
  return row;
}

export function getImageAsset(id: string): ImageAsset {
  return mapAsset(getImageAssetRow(id));
}

export function listCharacterImageAssets(characterId: string): ImageAsset[] {
  const rows = dbAll<ImageAssetRow>(
    'SELECT * FROM image_assets WHERE character_id = ? ORDER BY created_at DESC',
    characterId,
  );
  return rows.map(mapAsset);
}

export function listChapterImageAssets(chapterId: string): ImageAsset[] {
  const rows = dbAll<ImageAssetRow>(
    'SELECT * FROM image_assets WHERE chapter_id = ? ORDER BY created_at DESC',
    chapterId,
  );
  return rows.map(mapAsset);
}

export function listProjectImageAssets(projectId: string): ImageAsset[] {
  return dbAll<ImageAssetRow>('SELECT * FROM image_assets WHERE project_id = ? ORDER BY created_at DESC', projectId).map(mapAsset);
}

export function selectChapterImage(chapterId: string, assetId: string): ImageAsset {
  const asset = getImageAssetRow(assetId);
  if (asset.chapter_id !== chapterId) throw badRequest('Choose an image from this chapter.');
  transaction(() => {
    dbRun('UPDATE image_assets SET selected_for_chapter = 0 WHERE chapter_id = ? AND character_id = ?', chapterId, asset.character_id);
    dbRun('UPDATE image_assets SET selected_for_chapter = 1 WHERE id = ?', assetId);
  });
  return getImageAsset(assetId);
}

export function deleteImageAsset(id: string): void {
  const row = getImageAssetRow(id);
  dbRun(
    'UPDATE characters SET portrait_asset_id = NULL, updated_at = ? WHERE portrait_asset_id = ?',
    timestamp(),
    id,
  );
  dbRun('DELETE FROM image_assets WHERE id = ?', id);
  try {
    fs.rmSync(path.join(config.dataDir, 'images', row.file_name), { force: true });
  } catch {
    // The database row is gone even if the file is briefly locked on Windows.
  }
}

export function imagesRoot(): string {
  return path.join(config.dataDir, 'images');
}

export function imageFilePath(fileName: string): string {
  const root = path.resolve(imagesRoot());
  const absolute = path.resolve(root, fileName);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw notFound('Image not found.');
  }
  return absolute;
}
