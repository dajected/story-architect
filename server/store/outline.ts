import crypto from 'node:crypto';
import type { OutlineChapter, OutlineRevision, OutlineRevisionStatus } from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp, transaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { getProjectRow, touchProject } from './projects.js';

interface OutlineRow {
  id: string;
  project_id: string;
  version: number;
  status: OutlineRevisionStatus;
  chapters: string;
  source: 'generated' | 'edited' | 'manual';
  raw_text: string | null;
  approved_at: string | null;
  created_at: string;
}

interface ChapterRow {
  id: string;
  project_id: string;
  order_index: number;
  title: string;
  brief: string;
  brief_approved: number;
  current_revision_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapOutline(row: OutlineRow): OutlineRevision {
  let chapters: OutlineChapter[] = [];
  try {
    const parsed = JSON.parse(row.chapters) as unknown;
    if (Array.isArray(parsed)) {
      chapters = parsed as OutlineChapter[];
    }
  } catch {
    chapters = [];
  }
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    status: row.status,
    chapters,
    source: row.source,
    rawText: row.raw_text,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

export function listOutlineRevisions(projectId: string): OutlineRevision[] {
  getProjectRow(projectId);
  const rows = dbAll<OutlineRow>(
    'SELECT * FROM outline_revisions WHERE project_id = ? ORDER BY version DESC',
    projectId,
  );
  return rows.map(mapOutline);
}

export function latestOutlineRevision(projectId: string): OutlineRevision | null {
  const row = dbGet<OutlineRow>(
    'SELECT * FROM outline_revisions WHERE project_id = ? ORDER BY version DESC LIMIT 1',
    projectId,
  );
  return row ? mapOutline(row) : null;
}

export function getOutlineRevision(projectId: string, revisionId: string): OutlineRevision {
  const row = dbGet<OutlineRow>(
    'SELECT * FROM outline_revisions WHERE id = ? AND project_id = ?',
    revisionId,
    projectId,
  );
  if (!row) throw notFound('Outline revision not found.');
  return mapOutline(row);
}

function nextVersion(projectId: string): number {
  const row = dbGet<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM outline_revisions WHERE project_id = ?',
    projectId,
  );
  return Number(row?.version ?? 0) + 1;
}

function insertRevision(params: {
  projectId: string;
  chapters: OutlineChapter[];
  source: 'generated' | 'edited' | 'manual';
  rawText: string | null;
}): OutlineRevision {
  const version = nextVersion(params.projectId);
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `UPDATE outline_revisions SET status = 'superseded' WHERE project_id = ? AND status IN ('draft', 'approved')`,
    params.projectId,
  );
  dbRun(
    `INSERT INTO outline_revisions (id, project_id, version, status, chapters, source, raw_text, approved_at, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, NULL, ?)`,
    id,
    params.projectId,
    version,
    JSON.stringify(params.chapters),
    params.source,
    params.rawText,
    at,
  );
  touchProject(params.projectId);
  return getOutlineRevision(params.projectId, id);
}

export function createOutlineFromGeneration(
  projectId: string,
  chapters: OutlineChapter[],
  rawText: string,
): OutlineRevision {
  const sanitized = sanitizeChapters(chapters, false);
  if (sanitized.length === 0) throw badRequest('No chapters were found in the generated outline.');
  return insertRevision({ projectId, chapters: sanitized, source: 'generated', rawText });
}

export function createManualOutline(projectId: string, projectTitle: string): OutlineRevision {
  getProjectRow(projectId);
  return insertRevision({
    projectId,
    chapters: [{ id: crypto.randomUUID(), title: projectTitle || 'Chapter 1', brief: '' }],
    source: 'manual',
    rawText: null,
  });
}

export function saveOutlineDraft(
  projectId: string,
  chaptersInput: unknown,
  revisionId?: string,
): OutlineRevision {
  getProjectRow(projectId);
  const chapters = sanitizeChapters(chaptersInput, false);
  if (chapters.length === 0) throw badRequest('Add at least one chapter to the outline.');
  const latest = latestOutlineRevision(projectId);

  if (latest && latest.status === 'draft') {
    if (revisionId && revisionId !== latest.id) {
      throw conflict('Only the latest outline revision can be edited.');
    }
    dbRun(
      'UPDATE outline_revisions SET chapters = ?, source = ? WHERE id = ?',
      JSON.stringify(chapters),
      latest.source === 'generated' ? 'edited' : latest.source,
      latest.id,
    );
    touchProject(projectId);
    return getOutlineRevision(projectId, latest.id);
  }

  if (revisionId && latest && revisionId !== latest.id) {
    throw conflict('Only the latest outline revision can be edited. Reload to see the current outline.');
  }

  return insertRevision({
    projectId,
    chapters,
    source: 'edited',
    rawText: null,
  });
}

export function approveOutline(projectId: string, revisionId: string): OutlineRevision {
  const revision = getOutlineRevision(projectId, revisionId);
  const latest = latestOutlineRevision(projectId);
  if (!latest || latest.id !== revision.id) {
    throw conflict('Only the latest outline revision can be approved.');
  }
  if (revision.status !== 'draft') {
    throw conflict('This outline revision has already been approved or superseded.');
  }
  const chapters = sanitizeChapters(revision.chapters, true);

  transaction(() => {
    const existing = dbAll<ChapterRow>(
      'SELECT * FROM chapters WHERE project_id = ? ORDER BY order_index',
      projectId,
    );
    const existingById = new Map(existing.map((chapter) => [chapter.id, chapter]));
    const incomingIds = new Set(chapters.map((chapter) => chapter.id));
    const at = timestamp();

    for (const chapter of existing) {
      if (incomingIds.has(chapter.id)) continue;
      if (chapter.current_revision_id) {
        const contentRow = dbGet<{ content: string }>(
          'SELECT content FROM chapter_revisions WHERE id = ?',
          chapter.current_revision_id,
        );
        if (contentRow && contentRow.content.trim()) {
          throw conflict(
            `Chapter "${chapter.title}" has manuscript text. Clear or move its text before removing it from the outline.`,
          );
        }
      }
      dbRun('DELETE FROM chapters WHERE id = ?', chapter.id);
    }

    chapters.forEach((chapter, index) => {
      const current = existingById.get(chapter.id);
      if (current) {
        dbRun(
          `UPDATE chapters SET order_index = ?, title = ?, brief = ?, brief_approved = 1, updated_at = ? WHERE id = ?`,
          index,
          chapter.title,
          chapter.brief,
          at,
          chapter.id,
        );
      } else {
        dbRun(
          `INSERT INTO chapters (id, project_id, order_index, title, brief, brief_approved, current_revision_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, NULL, 'planned', ?, ?)`,
          chapter.id,
          projectId,
          index,
          chapter.title,
          chapter.brief,
          at,
          at,
        );
      }
    });

    dbRun(
      `UPDATE outline_revisions SET status = 'superseded'
       WHERE project_id = ? AND id != ? AND status IN ('draft', 'approved')`,
      projectId,
      revision.id,
    );
    dbRun(
      `UPDATE outline_revisions SET status = 'approved', approved_at = ? WHERE id = ?`,
      at,
      revision.id,
    );
    touchProject(projectId);
  });

  return getOutlineRevision(projectId, revision.id);
}

function sanitizeChapters(input: unknown, requireBrief: boolean): OutlineChapter[] {
  if (!Array.isArray(input)) throw badRequest('Outline chapters must be an array.');
  if (input.length > 200) throw badRequest('An outline can contain at most 200 chapters.');
  const seenIds = new Set<string>();
  const chapters: OutlineChapter[] = [];

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const title = String(record.title ?? '').trim();
    const brief = String(record.brief ?? '').trim();
    if (!title) throw badRequest('Every outline chapter needs a title.');
    if (title.length > 240) throw badRequest('Outline chapter titles must be 240 characters or fewer.');
    if (brief.length > 8000) throw badRequest('Outline chapter briefs must be 8000 characters or fewer.');
    if (requireBrief && !brief) {
      throw badRequest(`Chapter "${title}" needs a brief before the outline can be approved.`);
    }
    let id = typeof record.id === 'string' && record.id ? record.id : crypto.randomUUID();
    if (seenIds.has(id)) id = crypto.randomUUID();
    seenIds.add(id);
    chapters.push({ id, title, brief });
  }
  return chapters;
}

export function outlineSummary(projectId: string): string {
  const latest = latestOutlineRevision(projectId);
  if (!latest || latest.status !== 'approved') return '';
  return latest.chapters
    .map((chapter, index) => `${index + 1}. ${chapter.title}\n   ${chapter.brief}`)
    .join('\n');
}

export function isOutlineApproved(projectId: string): boolean {
  const latest = latestOutlineRevision(projectId);
  return Boolean(latest && latest.status === 'approved');
}

export function requireLatestApprovedOutline(projectId: string): OutlineRevision {
  const latest = latestOutlineRevision(projectId);
  if (!latest) {
    throw conflict('Generate and approve an outline before drafting chapters.');
  }
  if (latest.status !== 'approved') {
    throw conflict('The latest outline revision is not approved. Approve it before drafting chapters.');
  }
  return latest;
}
