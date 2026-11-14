import crypto from 'node:crypto';
import type {
  Chapter,
  ChapterDetail,
  ChapterRevision,
  ChapterRevisionMeta,
  ChapterRevisionSource,
  ChapterStatus,
} from '../../shared/types.js';
import { countWords } from '../../shared/utils.js';
import { dbAll, dbGet, dbRun, timestamp, transaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { touchProject } from './projects.js';
import { latestChapterJob } from '../jobs.js';

export interface ChapterRow {
  id: string;
  project_id: string;
  order_index: number;
  title: string;
  brief: string;
  brief_approved: number;
  current_revision_id: string | null;
  status: ChapterStatus;
  created_at: string;
  updated_at: string;
}

interface ChapterWithWords extends ChapterRow {
  word_count: number;
}

export interface RevisionRow {
  id: string;
  chapter_id: string;
  version: number;
  content: string;
  word_count: number;
  source: ChapterRevisionSource;
  editable: number;
  job_id: string | null;
  created_at: string;
}

function mapChapter(row: ChapterWithWords): Chapter {
  return {
    id: row.id,
    projectId: row.project_id,
    orderIndex: Number(row.order_index),
    title: row.title,
    brief: row.brief,
    briefApproved: Number(row.brief_approved) === 1,
    status: row.status,
    wordCount: Number(row.word_count ?? 0),
    currentRevisionId: row.current_revision_id,
    updatedAt: row.updated_at,
  };
}

function mapRevision(row: RevisionRow): ChapterRevision {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    version: Number(row.version),
    content: row.content,
    wordCount: Number(row.word_count),
    source: row.source,
    editable: Number(row.editable) === 1,
    jobId: row.job_id,
    createdAt: row.created_at,
  };
}

export function getChapterRow(id: string): ChapterRow {
  const row = dbGet<ChapterRow>('SELECT * FROM chapters WHERE id = ?', id);
  if (!row) throw notFound('Chapter not found.');
  return row;
}

function getChapterWithWords(id: string): ChapterWithWords {
  const row = dbGet<ChapterWithWords>(
    `SELECT c.*, COALESCE(r.word_count, 0) AS word_count
       FROM chapters c LEFT JOIN chapter_revisions r ON r.id = c.current_revision_id
      WHERE c.id = ?`,
    id,
  );
  if (!row) throw notFound('Chapter not found.');
  return row;
}

export function listChapters(projectId: string): Chapter[] {
  const rows = dbAll<ChapterWithWords>(
    `SELECT c.*, COALESCE(r.word_count, 0) AS word_count
       FROM chapters c LEFT JOIN chapter_revisions r ON r.id = c.current_revision_id
      WHERE c.project_id = ?
      ORDER BY c.order_index`,
    projectId,
  );
  return rows.map(mapChapter);
}

export function getChapter(id: string): Chapter {
  return mapChapter(getChapterWithWords(id));
}

export function getChapterRevision(id: string): ChapterRevision {
  const row = dbGet<RevisionRow>('SELECT * FROM chapter_revisions WHERE id = ?', id);
  if (!row) throw notFound('Chapter revision not found.');
  return mapRevision(row);
}

export function listRevisions(chapterId: string): ChapterRevisionMeta[] {
  const rows = dbAll<RevisionRow>(
    'SELECT * FROM chapter_revisions WHERE chapter_id = ? ORDER BY version DESC',
    chapterId,
  );
  return rows.map((row) => {
    const { content, ...rest } = mapRevision(row);
    return {
      ...rest,
      preview: content.replace(/\s+/g, ' ').trim().slice(0, 280),
    };
  });
}

export function getChapterDetail(id: string): ChapterDetail {
  const chapter = getChapter(id);
  const current = chapter.currentRevisionId
    ? dbGet<RevisionRow>('SELECT * FROM chapter_revisions WHERE id = ?', chapter.currentRevisionId)
    : undefined;
  return {
    ...chapter,
    content: current?.content ?? '',
    revisions: listRevisions(id),
    latestJob: latestChapterJob(id),
  };
}

export function saveChapterContent(chapterId: string, content: string): ChapterDetail {
  if (content.length > 2_000_000) {
    throw badRequest('Chapter text is too large to save.');
  }
  const chapter = getChapterRow(chapterId);
  const wordCount = countWords(content);

  transaction(() => {
    if (!content.trim() && !chapter.current_revision_id) {
      return;
    }
    const current = chapter.current_revision_id
      ? dbGet<RevisionRow>('SELECT * FROM chapter_revisions WHERE id = ?', chapter.current_revision_id)
      : undefined;
    const at = timestamp();

    if (current && Number(current.editable) === 1) {
      dbRun(
        'UPDATE chapter_revisions SET content = ?, word_count = ? WHERE id = ?',
        content,
        wordCount,
        current.id,
      );
      dbRun(
        'UPDATE chapters SET status = ?, updated_at = ? WHERE id = ?',
        content.trim() ? 'drafted' : 'planned',
        at,
        chapterId,
      );
    } else {
      const revision = insertRevision({
        chapterId,
        content,
        source: 'edited',
        editable: true,
        jobId: null,
      });
      dbRun(
        'UPDATE chapters SET current_revision_id = ?, status = ?, updated_at = ? WHERE id = ?',
        revision.id,
        content.trim() ? 'drafted' : 'planned',
        at,
        chapterId,
      );
    }
    touchProject(chapter.project_id);
  });

  return getChapterDetail(chapterId);
}

function insertRevision(params: {
  chapterId: string;
  content: string;
  source: ChapterRevisionSource;
  editable: boolean;
  jobId: string | null;
}): ChapterRevision {
  const row = dbGet<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM chapter_revisions WHERE chapter_id = ?',
    params.chapterId,
  );
  const version = Number(row?.version ?? 0) + 1;
  const id = crypto.randomUUID();
  dbRun(
    `INSERT INTO chapter_revisions (id, chapter_id, version, content, word_count, source, editable, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    params.chapterId,
    version,
    params.content,
    countWords(params.content),
    params.source,
    params.editable ? 1 : 0,
    params.jobId,
    timestamp(),
  );
  return getChapterRevision(id);
}

export function createRevisionFromJob(
  chapterId: string,
  content: string,
  jobId: string,
  source: ChapterRevisionSource = 'generated',
): { revision: ChapterRevision; applied: boolean } {
  const chapter = getChapterRow(chapterId);
  if (!content.trim()) throw badRequest('There is no generated text to save.');

  return transaction(() => {
    const current = chapter.current_revision_id
      ? dbGet<RevisionRow>('SELECT * FROM chapter_revisions WHERE id = ?', chapter.current_revision_id)
      : undefined;
    const applied = !current || !current.content.trim();
    const revision = insertRevision({
      chapterId,
      content,
      source,
      editable: false,
      jobId,
    });
    const at = timestamp();
    if (applied) {
      dbRun(
        'UPDATE chapters SET current_revision_id = ?, status = ?, updated_at = ? WHERE id = ?',
        revision.id,
        'drafted',
        at,
        chapterId,
      );
    } else {
      dbRun('UPDATE chapters SET updated_at = ? WHERE id = ?', at, chapterId);
    }
    touchProject(chapter.project_id);
    return { revision, applied };
  });
}

export function useRevision(revisionId: string): ChapterDetail {
  const revision = getChapterRevision(revisionId);
  const chapter = getChapterRow(revision.chapterId);
  dbRun(
    'UPDATE chapters SET current_revision_id = ?, status = ?, updated_at = ? WHERE id = ?',
    revision.id,
    revision.content.trim() ? 'drafted' : 'planned',
    timestamp(),
    chapter.id,
  );
  touchProject(chapter.project_id);
  return getChapterDetail(chapter.id);
}

export function restoreRevision(revisionId: string): { revision: ChapterRevision; chapter: ChapterDetail } {
  const source = getChapterRevision(revisionId);
  const chapter = getChapterRow(source.chapterId);
  if (!source.content.trim()) {
    throw badRequest('An empty revision cannot be restored.');
  }
  const revision = transaction(() => {
    const created = insertRevision({
      chapterId: chapter.id,
      content: source.content,
      source: 'restored',
      editable: true,
      jobId: null,
    });
    dbRun(
      'UPDATE chapters SET current_revision_id = ?, status = ?, updated_at = ? WHERE id = ?',
      created.id,
      'drafted',
      timestamp(),
      chapter.id,
    );
    touchProject(chapter.project_id);
    return created;
  });
  return { revision, chapter: getChapterDetail(chapter.id) };
}

/**
 * Replace a selected passage with an accepted rewrite. The result is a new
 * immutable revision, so the pre-rewrite working copy remains in history.
 */
export function applyRewriteToChapter(params: {
  chapterId: string;
  start: number;
  end: number;
  selection: string;
  replacement: string;
  jobId: string;
}): { revision: ChapterRevision; chapter: ChapterDetail } {
  const replacement = params.replacement.trim();
  if (!replacement) throw badRequest('The rewrite is empty.');
  const text = currentChapterText(params.chapterId);
  if (!text.trim()) throw badRequest('This chapter has no text to rewrite.');
  const start = Math.max(0, Math.floor(params.start));
  const end = Math.max(start, Math.floor(params.end));
  if (end > text.length) {
    throw conflict('The chapter text changed since this passage was selected. Select it again.');
  }
  const currentSelection = text.slice(start, end);
  if (currentSelection !== params.selection) {
    throw conflict('The chapter text changed since this passage was selected. Select it again.');
  }
  if (!currentSelection.trim()) throw badRequest('Select some text to rewrite.');

  const updatedText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  const chapter = getChapterRow(params.chapterId);
  const revision = transaction(() => {
    const created = insertRevision({
      chapterId: params.chapterId,
      content: updatedText,
      source: 'rewrite',
      editable: false,
      jobId: params.jobId,
    });
    dbRun(
      'UPDATE chapters SET current_revision_id = ?, status = ?, updated_at = ? WHERE id = ?',
      created.id,
      'drafted',
      timestamp(),
      params.chapterId,
    );
    touchProject(chapter.project_id);
    return created;
  });
  return { revision, chapter: getChapterDetail(params.chapterId) };
}

export function appendToChapter(chapterId: string, text: string): ChapterDetail {  const addition = text.trim();
  if (!addition) throw badRequest('There is no text to insert.');
  if (addition.length > 1_000_000) throw badRequest('That text is too large to insert.');
  const current = currentChapterText(chapterId);
  const appended = current.trim()
    ? `${current.trimEnd()}\n\n${addition}\n`
    : `${addition}\n`;
  return saveChapterContent(chapterId, appended);
}

export function currentChapterText(chapterId: string): string {
  const chapter = getChapterRow(chapterId);
  if (!chapter.current_revision_id) return '';
  const row = dbGet<{ content: string }>(
    'SELECT content FROM chapter_revisions WHERE id = ?',
    chapter.current_revision_id,
  );
  return row?.content ?? '';
}
