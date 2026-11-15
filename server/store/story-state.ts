import crypto from 'node:crypto';
import type { Chapter, StoryStateInfo } from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { conflict } from '../errors.js';
import { currentChapterText, getChapter, listChapters } from './chapters.js';
import { chapterTextHash, getMemoryRow } from './memory.js';

export const STORY_STATE_MAX_CHARS = 4000;

export interface StoryStateRow {
  chapter_id: string;
  project_id: string;
  version: string;
  content: string;
  input_signature: string;
  parent_version: string | null;
  updated_at: string;
}

export function stateSource(chapter: Chapter, parentVersion: string | null) {
  const text = currentChapterText(chapter.id);
  const hash = chapterTextHash(text);
  const memory = getMemoryRow(chapter.id);
  const summary = memory?.source_content_hash === hash && memory.source_revision_id === chapter.currentRevisionId
    ? memory.summary : '';
  const signature = chapterTextHash(JSON.stringify([
    'story-state-v1', chapter.id, chapter.orderIndex, chapter.currentRevisionId, hash, summary, parentVersion,
  ]));
  return { text, summary, signature };
}

export function inspectStoryState(projectId: string, beforeOrder: number): {
  info: StoryStateInfo; checkpoint: StoryStateRow | null; validPrefix: StoryStateRow | null;
} {
  const chapters = listChapters(projectId).filter((chapter) => chapter.orderIndex < beforeOrder && chapter.status === 'drafted' && chapter.currentRevisionId);
  const rows = new Map(dbAll<StoryStateRow>('SELECT * FROM story_states WHERE project_id = ?', projectId)
    .map((row) => [row.chapter_id, row]));
  let previous: StoryStateRow | null = null;
  for (const chapter of chapters) {
    const row = rows.get(chapter.id);
    const source = stateSource(chapter, previous?.version ?? null);
    if (!row || row.input_signature !== source.signature || row.parent_version !== (previous?.version ?? null)) {
      return { checkpoint: null, validPrefix: previous, info: {
        status: row ? 'stale' : 'missing', throughChapterId: null, throughChapterNumber: null,
        version: null, text: '',
      } };
    }
    previous = row;
  }
  return { checkpoint: previous, validPrefix: previous, info: {
    status: previous ? 'current' : 'empty', throughChapterId: previous?.chapter_id ?? null,
    throughChapterNumber: chapters.at(-1) ? chapters.at(-1)!.orderIndex + 1 : null,
    version: previous?.version ?? null, text: previous?.content ?? '',
  } };
}

export function saveStoryState(chapterId: string, content: string, inputSignature: string, parentVersion: string | null): void {
  const chapter = getChapter(chapterId);
  const previous = inspectStoryState(chapter.projectId, chapter.orderIndex);
  const source = stateSource(chapter, parentVersion);
  if (!['empty', 'current'].includes(previous.info.status) || (previous.checkpoint?.version ?? null) !== parentVersion || source.signature !== inputSignature) {
    throw conflict('The manuscript or its summary changed while story state was being built. Retry with the current text.');
  }
  if (!content.trim() || content.length > STORY_STATE_MAX_CHARS) {
    throw conflict(`Story state must be nonempty and at most ${STORY_STATE_MAX_CHARS} characters. Rebuild memory with a shorter state.`);
  }
  dbRun(`INSERT INTO story_states (chapter_id, project_id, version, content, input_signature, parent_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chapter_id) DO UPDATE SET
    version = excluded.version, content = excluded.content, input_signature = excluded.input_signature,
    parent_version = excluded.parent_version, updated_at = excluded.updated_at`,
  chapterId, chapter.projectId, crypto.randomUUID(), content.trim(), inputSignature, parentVersion, timestamp());
}
