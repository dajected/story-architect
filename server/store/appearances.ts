import type {
  CharacterAppearance,
  CharacterAppearanceStatus,
} from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { badRequest } from '../errors.js';
import { currentChapterText, getChapterRow } from './chapters.js';
import { activeCharacters, getCharacterRow } from './characters.js';
import { chapterTextHash, precedingSignature } from './memory.js';
import { touchProject } from './projects.js';

/** Longest appearance record accepted from a model or an author edit. */
export const APPEARANCE_MAX_CHARS = 4000;

interface AppearanceRow {
  chapter_id: string;
  character_id: string;
  project_id: string;
  appearance: string;
  source_revision_id: string | null;
  source_content_hash: string;
  preceding_signature: string;
  entering_hash: string;
  generated_at: string;
  updated_at: string;
  job_id: string | null;
}

export interface AppearanceEntry {
  character: string;
  appearance: string;
}

/** Hash a prior appearance so chained records can notice upstream rebuilds. */
function appearanceHash(text: string): string {
  return chapterTextHash(text);
}

function getAppearanceRow(chapterId: string, characterId: string): AppearanceRow | undefined {
  return dbGet<AppearanceRow>(
    'SELECT * FROM character_appearances WHERE chapter_id = ? AND character_id = ?',
    chapterId,
    characterId,
  );
}

/** The record immediately before a chapter boundary, or null at the story start. */
export function latestAppearanceBefore(
  projectId: string,
  orderIndex: number,
  characterId: string,
): AppearanceRow | null {
  const row = dbGet<AppearanceRow>(
    `SELECT a.* FROM character_appearances a
     JOIN chapters ch ON ch.id = a.chapter_id
     WHERE a.project_id = ? AND a.character_id = ? AND ch.order_index < ?
     ORDER BY ch.order_index DESC
     LIMIT 1`,
    projectId,
    characterId,
    orderIndex,
  );
  return row ?? null;
}

/** The appearance a character carries into a chapter, falling back to their profile. */
function enteringAppearance(
  character: { appearance: string },
  previous: AppearanceRow | null,
): string {
  return (previous?.appearance ?? character.appearance ?? '').trim();
}

/**
 * Build the appearance section the memory role carries into a chapter. Returning
 * the end-of previous-chapter records is what lets each new record build on the
 * last instead of re-deriving appearance from scratch.
 */
export function appearanceEnteringPrompt(projectId: string, chapterId: string): string {
  const chapter = getChapterRow(chapterId);
  const keyCharacters = activeCharacters(projectId).filter((character) => character.keyCharacter);
  if (keyCharacters.length === 0) return '';
  const orderIndex = Number(chapter.order_index);
  return keyCharacters
    .map((character) => {
      const previous = latestAppearanceBefore(projectId, orderIndex, character.id);
      const text = enteringAppearance(character, previous);
      return `### ${character.name}\n${text || '(No appearance recorded yet.)'}`;
    })
    .join('\n\n');
}

/**
 * Store the end-of-chapter appearance records produced by a memory extraction.
 * A character the model omitted keeps the record they entered with; a character
 * with no earlier record starts from their profile.
 */
export function saveChapterAppearances(params: {
  chapterId: string;
  entries: AppearanceEntry[];
  sourceRevisionId: string | null;
  sourceContentHash: string;
  precedingSignature: string;
  jobId: string | null;
}): number {
  const chapter = getChapterRow(params.chapterId);
  const projectId = chapter.project_id;
  const orderIndex = Number(chapter.order_index);
  const keyCharacters = activeCharacters(projectId).filter((character) => character.keyCharacter);
  if (keyCharacters.length === 0) return 0;
  const at = timestamp();
  let saved = 0;
  for (const character of keyCharacters) {
    const previous = latestAppearanceBefore(projectId, orderIndex, character.id);
    const entering = enteringAppearance(character, previous);
    const match = params.entries.find(
      (entry) => entry.character.trim().toLowerCase() === character.name.toLowerCase(),
    );
    const appearance = (match?.appearance ?? previous?.appearance ?? character.appearance ?? '')
      .trim()
      .slice(0, APPEARANCE_MAX_CHARS);
    if (!appearance) continue;
    dbRun(
      `INSERT INTO character_appearances (
         chapter_id, character_id, project_id, appearance, source_revision_id,
         source_content_hash, preceding_signature, entering_hash, generated_at, updated_at, job_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chapter_id, character_id) DO UPDATE SET
         appearance = excluded.appearance,
         source_revision_id = excluded.source_revision_id,
         source_content_hash = excluded.source_content_hash,
         preceding_signature = excluded.preceding_signature,
         entering_hash = excluded.entering_hash,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at,
         job_id = excluded.job_id`,
      params.chapterId,
      character.id,
      projectId,
      appearance,
      params.sourceRevisionId,
      params.sourceContentHash,
      params.precedingSignature,
      appearanceHash(entering),
      at,
      at,
      params.jobId,
    );
    saved += 1;
  }
  if (saved > 0) touchProject(projectId);
  return saved;
}

/** Author correction: keep the record current against this chapter and its predecessor. */
export function updateChapterAppearance(
  chapterId: string,
  characterId: string,
  appearance: string,
): CharacterAppearance {
  const chapter = getChapterRow(chapterId);
  const character = getCharacterRow(characterId);
  if (character.project_id !== chapter.project_id) {
    throw badRequest('That character belongs to another novel.');
  }
  if (!character.key_character) {
    throw badRequest('Mark this character as a key character before recording their appearance.');
  }
  const text = appearance.trim();
  if (!text) throw badRequest('An appearance record cannot be empty.');
  if (text.length > APPEARANCE_MAX_CHARS) {
    throw badRequest(`An appearance record must be ${APPEARANCE_MAX_CHARS} characters or fewer.`);
  }
  const orderIndex = Number(chapter.order_index);
  const previous = latestAppearanceBefore(chapter.project_id, orderIndex, character.id);
  const entering = enteringAppearance(character, previous);
  const chapterText = currentChapterText(chapterId);
  const at = timestamp();
  dbRun(
    `INSERT INTO character_appearances (
       chapter_id, character_id, project_id, appearance, source_revision_id,
       source_content_hash, preceding_signature, entering_hash, generated_at, updated_at, job_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(chapter_id, character_id) DO UPDATE SET
       appearance = excluded.appearance,
       source_revision_id = excluded.source_revision_id,
       source_content_hash = excluded.source_content_hash,
       preceding_signature = excluded.preceding_signature,
       entering_hash = excluded.entering_hash,
       generated_at = excluded.generated_at,
       updated_at = excluded.updated_at,
       job_id = NULL`,
    chapterId,
    character.id,
    chapter.project_id,
    text,
    chapter.current_revision_id,
    chapterTextHash(chapterText),
    precedingSignature(chapter.project_id, orderIndex),
    appearanceHash(entering),
    at,
    at,
  );
  touchProject(chapter.project_id);
  const record = listChapterAppearances(chapterId, [character.id])[0];
  if (!record) {
    throw badRequest('Mark this character as a key character before recording their appearance.');
  }
  return record;
}

/** Appearance records for every key character at the end of one chapter. */
export function listChapterAppearances(
  chapterId: string,
  characterIds?: string[],
): CharacterAppearance[] {
  const chapter = getChapterRow(chapterId);
  const projectId = chapter.project_id;
  const orderIndex = Number(chapter.order_index);
  const characters = activeCharacters(projectId).filter(
    (character) =>
      character.keyCharacter && (!characterIds || characterIds.includes(character.id)),
  );
  const rows = new Map(
    dbAll<AppearanceRow>('SELECT * FROM character_appearances WHERE chapter_id = ?', chapterId)
      .map((row) => [row.character_id, row]),
  );
  const currentHash = chapterTextHash(currentChapterText(chapterId));
  return characters.map((character) => {
    const row = rows.get(character.id);
    const previous = latestAppearanceBefore(projectId, orderIndex, character.id);
    const entering = enteringAppearance(character, previous);
    const staleReasons: string[] = [];
    let status: CharacterAppearanceStatus = 'missing';
    if (row) {
      if (
        row.source_content_hash !== currentHash ||
        row.source_revision_id !== chapter.current_revision_id
      ) {
        staleReasons.push('The chapter text changed after this appearance was recorded.');
      }
      if (row.entering_hash !== appearanceHash(entering)) {
        staleReasons.push('An earlier appearance record changed after this one was built.');
      }
      status = staleReasons.length > 0 ? 'stale' : 'current';
    }
    return {
      chapterId,
      projectId,
      characterId: character.id,
      characterName: character.name,
      chapterTitle: chapter.title,
      chapterOrder: orderIndex,
      appearance: row?.appearance ?? null,
      status,
      staleReasons,
      sourceRevisionId: row?.source_revision_id ?? null,
      generatedAt: row?.generated_at ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

/**
 * The latest recorded appearance for an image prompt. At the start of a chapter
 * that is the prior chapter's record; at the end it is this chapter's record.
 */
export function appearanceForImagePrompt(
  chapterId: string,
  characterId: string,
  moment: 'start' | 'end' | 'custom',
): string {
  const chapter = getChapterRow(chapterId);
  const orderIndex = Number(chapter.order_index);
  if (moment !== 'start') {
    const own = getAppearanceRow(chapterId, characterId);
    if (own?.appearance.trim()) return own.appearance.trim();
  }
  return latestAppearanceBefore(chapter.project_id, orderIndex, characterId)?.appearance.trim() ?? '';
}

/**
 * Before appearance records exist (older projects, or chapters never rebuilt),
 * carry forward reviewed character-development facts so earlier changes are not
 * silently lost from image prompts.
 */
export function priorAppearanceChanges(chapterId: string, characterId: string): string[] {
  const chapter = getChapterRow(chapterId);
  return dbAll<{ statement: string }>(
    `SELECT f.statement FROM facts f
     JOIN chapters ch ON ch.id = f.chapter_id
     WHERE f.project_id = ? AND f.character_id = ? AND f.kind = 'character_development'
       AND f.status IN ('proposed', 'established')
       AND ch.order_index < ?
     ORDER BY ch.order_index, f.created_at
     LIMIT 12`,
    chapter.project_id,
    characterId,
    Number(chapter.order_index),
  ).map((row) => row.statement.trim());
}
