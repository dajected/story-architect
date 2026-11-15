import crypto from 'node:crypto';
import type {
  Chapter,
  ChapterMemory,
  Character,
  Fact,
  FactClass,
  FactInput,
  FactKind,
  FactStatus,
  MemoryStatus,
} from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp, transaction } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { listChapters, getChapter, getChapterRow, currentChapterText } from './chapters.js';
import { inspectStoryState } from './story-state.js';
import { referenceCharacterText, referenceFactText, selectStoryReferences } from '../story-references.js';
import { activeCharacters, getCharacterRow } from './characters.js';
import { touchProject } from './projects.js';

export const FACT_KINDS: FactKind[] = [
  'character_development',
  'relationship',
  'timeline',
  'plot_thread',
  'world',
];

export const FACT_CLASSES: FactClass[] = ['authored', 'established', 'plan'];

interface MemoryRow {
  chapter_id: string;
  project_id: string;
  summary: string;
  source_revision_id: string | null;
  source_content_hash: string;
  source_word_count: number;
  preceding_signature: string;
  generated_at: string;
  updated_at: string;
  job_id: string | null;
}

interface FactRow {
  id: string;
  project_id: string;
  kind: FactKind;
  fact_class: FactClass;
  statement: string;
  character_id: string | null;
  chapter_id: string | null;
  scope_chapter_id: string | null;
  source_revision_id: string | null;
  source_content_hash: string | null;
  status: FactStatus;
  origin: 'authored' | 'extracted';
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
  character_name: string | null;
  chapter_title: string | null;
  chapter_order: number | null;
  chapter_revision_id: string | null;
  scope_title: string | null;
  scope_order: number | null;
}

const factSelect = `
  SELECT f.*,
    c.name AS character_name,
    ch.title AS chapter_title,
    ch.order_index AS chapter_order,
    ch.current_revision_id AS chapter_revision_id,
    sc.title AS scope_title,
    sc.order_index AS scope_order
  FROM facts f
  LEFT JOIN characters c ON c.id = f.character_id
  LEFT JOIN chapters ch ON ch.id = f.chapter_id
  LEFT JOIN chapters sc ON sc.id = f.scope_chapter_id
`;

function mapFact(row: FactRow, currentContentHash?: string): Fact {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    factClass: row.fact_class,
    statement: row.statement,
    characterId: row.character_id,
    characterName: row.character_name,
    chapterId: row.chapter_id,
    chapterTitle: row.chapter_title,
    chapterOrder: row.chapter_order === null ? null : Number(row.chapter_order),
    scopeChapterId: row.scope_chapter_id,
    scopeChapterTitle: row.scope_title,
    scopeChapterOrder: row.scope_order === null ? null : Number(row.scope_order),
    sourceRevisionId: row.source_revision_id,
    sourceOutdated: isSourceOutdated(row, currentContentHash),
    status: row.status,
    origin: row.origin,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isSourceOutdated(row: FactRow, currentContentHash?: string): boolean {
  if (!row.chapter_id || !row.source_revision_id) return false;
  if (!row.chapter_revision_id) return true;
  if (row.source_content_hash && currentContentHash !== undefined) {
    return row.source_content_hash !== currentContentHash;
  }
  return row.chapter_revision_id !== row.source_revision_id;
}

/** Short stable hash used to notice in-place edits to an editable revision. */
export function chapterTextHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function currentHash(chapterId: string): string {
  return chapterTextHash(currentChapterText(chapterId));
}

export interface ChapterSnapshots {
  signatures: Map<string, string>;
  text: Map<string, string>;
  hash: Map<string, string>;
}

/** Read each chapter once and build its text hash plus the preceding fingerprint. */
export function chapterSnapshots(chapters: Chapter[]): ChapterSnapshots {
  const signatures = new Map<string, string>();
  const text = new Map<string, string>();
  const hash = new Map<string, string>();
  const parts: string[] = [];
  for (const chapter of chapters) {
    const chapterText = currentChapterText(chapter.id);
    const chapterHash = chapterTextHash(chapterText);
    signatures.set(chapter.id, parts.join('|'));
    text.set(chapter.id, chapterText);
    hash.set(chapter.id, chapterHash);
    parts.push(`${chapter.id}:${chapterHash}`);
  }
  return { signatures, text, hash };
}

/** A compact fingerprint of every preceding chapter's current text. */
export function precedingSignature(projectId: string, orderIndex: number, chapters?: Chapter[]): string {
  const list = chapters ?? listChapters(projectId);
  const target = list.find((chapter) => chapter.orderIndex === orderIndex);
  if (!target) return '';
  return chapterSnapshots(list).signatures.get(target.id) ?? '';
}

export function getMemoryRow(chapterId: string): MemoryRow | undefined {
  return dbGet<MemoryRow>('SELECT * FROM chapter_memory WHERE chapter_id = ?', chapterId);
}

function proposedFactCount(chapterId: string): number {
  const row = dbGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM facts WHERE chapter_id = ? AND status = 'proposed'`,
    chapterId,
  );
  return Number(row?.count ?? 0);
}

function memoryStatus(
  chapter: Chapter,
  row: MemoryRow | undefined,
  hasText: boolean,
  currentContentHash: string,
  currentSignature: string,
): { status: MemoryStatus; staleReasons: string[] } {
  if (!hasText) return { status: 'empty', staleReasons: [] };
  if (!row || !row.summary.trim()) return { status: 'missing', staleReasons: [] };
  const reasons: string[] = [];
  if (
    (row.source_content_hash && row.source_content_hash !== currentContentHash) ||
    row.source_revision_id !== chapter.currentRevisionId
  ) {
    reasons.push('The chapter text changed after this summary was generated.');
  }
  if (row.preceding_signature !== currentSignature) {
    reasons.push('An earlier chapter changed after this summary was generated.');
  }
  return { status: reasons.length > 0 ? 'stale' : 'current', staleReasons: reasons };
}

export function getChapterMemory(
  chapterId: string,
  options: {
    activeJobId?: string | null;
    chapters?: Chapter[];
    snapshots?: ChapterSnapshots;
  } = {},
): ChapterMemory {
  const chapter = getChapterRow(chapterId);
  const chapters = options.chapters ?? listChapters(chapter.project_id);
  const snapshots = options.snapshots ?? chapterSnapshots(chapters);
  const mapped = chapters.find((entry) => entry.id === chapterId);
  const detail = mapped ?? {
    id: chapter.id,
    projectId: chapter.project_id,
    orderIndex: Number(chapter.order_index),
    title: chapter.title,
    brief: chapter.brief,
    briefApproved: Number(chapter.brief_approved) === 1,
    status: chapter.status,
    wordCount: 0,
    currentRevisionId: chapter.current_revision_id,
    updatedAt: chapter.updated_at,
  };
  const row = getMemoryRow(chapterId);
  const text = snapshots.text.get(chapterId) ?? '';
  const textHash = snapshots.hash.get(chapterId) ?? chapterTextHash(text);
  const computed = memoryStatus(
    detail,
    row,
    Boolean(text.trim()),
    textHash,
    snapshots.signatures.get(chapterId) ?? '',
  );
  return {
    chapterId: chapter.id,
    projectId: chapter.project_id,
    chapterTitle: chapter.title,
    orderIndex: Number(chapter.order_index),
    wordCount: detail.wordCount,
    summary: row?.summary ?? null,
    sourceRevisionId: row?.source_revision_id ?? null,
    sourceWordCount: Number(row?.source_word_count ?? 0),
    generatedAt: row?.generated_at ?? null,
    updatedAt: row?.updated_at ?? null,
    status: options.activeJobId ? 'pending' : computed.status,
    staleReasons: computed.staleReasons,
    activeJobId: options.activeJobId ?? null,
    proposedFactCount: proposedFactCount(chapterId),
  };
}

export function saveChapterMemory(params: {
  chapterId: string;
  summary: string;
  sourceRevisionId: string | null;
  sourceContentHash: string;
  sourceWordCount: number;
  precedingSignature: string;
  jobId: string | null;
}): void {
  const chapter = getChapterRow(params.chapterId);
  const summary = params.summary.trim();
  if (!summary) throw badRequest('A chapter summary cannot be empty.');
  const at = timestamp();
  dbRun(
    `INSERT INTO chapter_memory (
       chapter_id, project_id, summary, source_revision_id, source_content_hash,
       source_word_count, preceding_signature, generated_at, updated_at, job_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chapter_id) DO UPDATE SET
       summary = excluded.summary,
       source_revision_id = excluded.source_revision_id,
       source_content_hash = excluded.source_content_hash,
       source_word_count = excluded.source_word_count,
       preceding_signature = excluded.preceding_signature,
       generated_at = excluded.generated_at,
       updated_at = excluded.updated_at,
       job_id = excluded.job_id`,
    params.chapterId,
    chapter.project_id,
    summary,
    params.sourceRevisionId,
    params.sourceContentHash,
    params.sourceWordCount,
    params.precedingSignature,
    at,
    at,
    params.jobId,
  );
  touchProject(chapter.project_id);
}

/** Author-edited summaries become current against the current manuscript revision. */
export function updateChapterMemorySummary(chapterId: string, summary: string): ChapterMemory {
  const chapter = getChapterRow(chapterId);
  const chapters = listChapters(chapter.project_id);
  const snapshots = chapterSnapshots(chapters);
  const text = snapshots.text.get(chapterId) ?? '';
  if (!chapter.current_revision_id || !text.trim()) {
    throw badRequest('Write or generate this chapter before adding a summary.');
  }
  const detail = chapters.find((entry) => entry.id === chapterId);
  saveChapterMemory({
    chapterId,
    summary,
    sourceRevisionId: chapter.current_revision_id,
    sourceContentHash: snapshots.hash.get(chapterId) ?? chapterTextHash(text),
    sourceWordCount: detail?.wordCount ?? 0,
    precedingSignature: snapshots.signatures.get(chapterId) ?? '',
    jobId: null,
  });
  return getChapterMemory(chapterId, { chapters, snapshots });
}

/** Statements recorded for one character in one chapter, for a closing-state portrait. */
export function chapterCharacterFacts(chapterId: string, characterId: string): string[] {
  const rows = dbAll<{ statement: string }>(
    `SELECT statement FROM facts
      WHERE chapter_id = ? AND character_id = ? AND status IN ('proposed', 'established')
      ORDER BY created_at`,
    chapterId,
    characterId,
  );
  return rows.map((row) => row.statement);
}

export function listFacts(projectId: string, status?: FactStatus): Fact[] {  const rows = status
    ? dbAll<FactRow>(
        `${factSelect} WHERE f.project_id = ? AND f.status = ?
         ORDER BY CASE f.status WHEN 'proposed' THEN 0 ELSE 1 END, f.created_at DESC`,
        projectId,
        status,
      )
    : dbAll<FactRow>(
        `${factSelect} WHERE f.project_id = ?
         ORDER BY CASE f.status WHEN 'proposed' THEN 0 WHEN 'established' THEN 1 WHEN 'superseded' THEN 2 ELSE 3 END,
                  f.created_at DESC`,
        projectId,
      );
  const hashes = chapterHashes(rows);
  return rows.map((row) => mapFact(row, hashes.get(row.chapter_id ?? '')));
}

function chapterHashes(rows: FactRow[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const row of rows) {
    if (!row.chapter_id || hashes.has(row.chapter_id)) continue;
    hashes.set(row.chapter_id, currentHash(row.chapter_id));
  }
  return hashes;
}

export function getFact(id: string): Fact {
  const row = dbGet<FactRow>(`${factSelect} WHERE f.id = ?`, id);
  if (!row) throw notFound('Continuity fact not found.');
  return mapFact(row, row.chapter_id ? currentHash(row.chapter_id) : undefined);
}

function validateFactInput(
  projectId: string,
  input: FactInput,
  options: { requireStatement?: boolean } = {},
): void {
  if (options.requireStatement !== false && !(input.statement ?? '').trim()) {
    throw badRequest('A fact needs a statement.');
  }
  if ((input.statement ?? '').length > 4000) {
    throw badRequest('Fact statements must be 4000 characters or fewer.');
  }
  if (input.kind !== undefined && !FACT_KINDS.includes(input.kind)) {
    throw badRequest('Unknown fact kind.');
  }
  if (input.factClass !== undefined && !FACT_CLASSES.includes(input.factClass)) {
    throw badRequest('Unknown fact class.');
  }
  if (input.characterId) {
    const character = getCharacterRow(input.characterId);
    if (character.project_id !== projectId) {
      throw badRequest('That character belongs to another project.');
    }
  }
  if (input.scopeChapterId) {
    const chapter = getChapterRow(input.scopeChapterId);
    if (chapter.project_id !== projectId) {
      throw badRequest('That chapter belongs to another project.');
    }
  }
}

export function createFact(
  projectId: string,
  input: FactInput,
  options: {
    status?: FactStatus;
    origin?: 'authored' | 'extracted';
    sourceRevisionId?: string | null;
    sourceContentHash?: string | null;
    chapterId?: string | null;
  } = {},
): Fact {
  validateFactInput(projectId, input);
  const statement = (input.statement ?? '').trim();
  if (!statement) throw badRequest('A fact needs a statement.');
  const now = timestamp();
  const id = crypto.randomUUID();
  const status = options.status ?? 'proposed';
  dbRun(
    `INSERT INTO facts (
       id, project_id, kind, fact_class, statement, character_id, chapter_id, scope_chapter_id,
       source_revision_id, source_content_hash, status, origin, accepted_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    projectId,
    input.kind ?? 'world',
    input.factClass ?? (options.origin === 'authored' ? 'authored' : 'established'),
    statement,
    input.characterId ?? null,
    options.chapterId ?? input.chapterId ?? null,
    input.scopeChapterId ?? null,
    options.sourceRevisionId ?? null,
    options.sourceContentHash ?? null,
    status,
    options.origin ?? 'extracted',
    status === 'established' ? now : null,
    now,
    now,
  );
  touchProject(projectId);
  return getFact(id);
}

export function createAuthoredFact(projectId: string, input: FactInput): Fact {
  return createFact(
    projectId,
    { ...input, factClass: input.factClass ?? 'authored' },
    { status: 'established', origin: 'authored' },
  );
}

export function updateFact(id: string, input: Partial<FactInput>): Fact {
  const current = getFact(id);
  validateFactInput(current.projectId, input, { requireStatement: false });
  const statement =
    input.statement === undefined ? current.statement : input.statement.trim();
  if (!statement) throw badRequest('A fact needs a statement.');
  dbRun(
    `UPDATE facts SET kind = ?, fact_class = ?, statement = ?, character_id = ?,
       scope_chapter_id = ?, updated_at = ?
     WHERE id = ?`,
    input.kind ?? current.kind,
    input.factClass ?? current.factClass,
    statement,
    input.characterId === undefined ? current.characterId : input.characterId,
    input.scopeChapterId === undefined ? current.scopeChapterId : input.scopeChapterId,
    timestamp(),
    id,
  );
  return getFact(id);
}

export function setFactStatus(id: string, status: FactStatus): Fact {
  const current = getFact(id);
  if (!['proposed', 'established', 'superseded', 'rejected'].includes(status)) {
    throw badRequest('Unknown fact status.');
  }
  const at = timestamp();
  dbRun(
    'UPDATE facts SET status = ?, accepted_at = ?, updated_at = ? WHERE id = ?',
    status,
    status === 'established' ? at : current.acceptedAt,
    at,
    id,
  );
  touchProject(current.projectId);
  return getFact(id);
}

export function deleteFact(id: string): void {
  const current = getFact(id);
  dbRun('DELETE FROM facts WHERE id = ?', id);
  touchProject(current.projectId);
}

export function supersedeOutdatedFacts(projectId: string): number {
  const outdated = listFacts(projectId).filter(
    (fact) => fact.status === 'established' && fact.sourceOutdated,
  );
  if (outdated.length === 0) return 0;
  transaction(() => {
    const at = timestamp();
    for (const fact of outdated) {
      dbRun('UPDATE facts SET status = ?, updated_at = ? WHERE id = ?', 'superseded', at, fact.id);
    }
  });
  touchProject(projectId);
  return outdated.length;
}

export interface ExtractedFactDraft {
  kind: FactKind;
  statement: string;
  characterName?: string | null;
  scope: 'chapter' | 'story';
}

/**
 * Store facts extracted from a chapter as proposals. Established canon only
 * changes through explicit review.
 */
export function addExtractedFacts(
  projectId: string,
  chapterId: string,
  revisionId: string | null,
  contentHash: string,
  drafts: ExtractedFactDraft[],
): number {
  const chapter = getChapterRow(chapterId);
  if (chapter.project_id !== projectId) throw badRequest('That chapter belongs to another project.');
  const existing = dbAll<{ statement: string }>(
    `SELECT statement FROM facts
      WHERE project_id = ? AND chapter_id = ? AND status IN ('proposed', 'established', 'rejected')`,
    projectId,
    chapterId,
  );
  const seen = new Set(existing.map((row) => row.statement.trim().toLowerCase()));
  let created = 0;
  for (const draft of drafts) {
    const statement = draft.statement.trim();
    if (!statement) continue;
    const key = statement.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!FACT_KINDS.includes(draft.kind)) continue;
    const character = draft.characterName
      ? findCharacter(projectId, draft.characterName)
      : null;
    createFact(
      projectId,
      {
        kind: draft.kind,
        statement,
        factClass: 'established',
        characterId: character?.id ?? null,
        scopeChapterId: draft.scope === 'chapter' ? chapterId : null,
      },
      {
        status: 'proposed',
        origin: 'extracted',
        sourceRevisionId: revisionId,
        sourceContentHash: contentHash,
        chapterId,
      },
    );
    created += 1;
  }
  return created;
}

function findCharacter(projectId: string, name: string): Character | null {
  const row = dbGet<{ id: string }>(
    'SELECT id FROM characters WHERE project_id = ? AND name = ? COLLATE NOCASE',
    projectId,
    name.trim(),
  );
  if (!row) return null;
  const character = activeCharacters(projectId).find((entry) => entry.id === row.id);
  return character ?? null;
}

interface PromptSummary {
  chapterId: string;
  chapterTitle: string;
  orderIndex: number;
  summary: string;
  stale: boolean;
  staleReasons: string[];
}

interface PromptMemory {
  summaries: PromptSummary[];
  characters: Character[];
  facts: Fact[];
  staleSummaries: number;
  pendingFacts: number;
}

/**
 * Gather the derived memory used to draft a chapter. Only established facts set
 * before this chapter are included; facts scoped to later chapters are kept out
 * so future beats never read as history.
 */
export function memoryForPrompt(projectId: string, chapterId: string, options: { includeSummaries?: boolean } = {}): PromptMemory {
  const chapters = listChapters(projectId);
  const chapter = chapters.find((entry) => entry.id === chapterId);
  if (!chapter) throw notFound('Chapter not found.');
  const snapshots = chapterSnapshots(chapters);

  const summaries: PromptSummary[] = [];
  for (const entry of chapters) {
    if (options.includeSummaries === false) break;
    if (entry.orderIndex >= chapter.orderIndex) continue;
    const row = getMemoryRow(entry.id);
    const text = snapshots.text.get(entry.id) ?? '';
    if (!row || !row.summary.trim() || !text.trim()) continue;
    const reasons: string[] = [];
    if (
      row.source_content_hash !== (snapshots.hash.get(entry.id) ?? '') ||
      row.source_revision_id !== entry.currentRevisionId
    ) {
      reasons.push('source chapter changed');
    }
    if (row.preceding_signature !== (snapshots.signatures.get(entry.id) ?? '')) {
      reasons.push('an earlier chapter changed');
    }
    summaries.push({
      chapterId: entry.id,
      chapterTitle: entry.title,
      orderIndex: entry.orderIndex,
      summary: row.summary.trim(),
      stale: reasons.length > 0,
      staleReasons: reasons,
    });
  }

  const facts = listFacts(projectId).filter((fact) => {
    if (fact.status !== 'established') return false;
    if (fact.chapterOrder !== null && fact.chapterOrder >= chapter.orderIndex) return false;
    if (fact.scopeChapterOrder !== null && fact.scopeChapterOrder > chapter.orderIndex) {
      return false;
    }
    return true;
  });

  const pendingFacts = listFacts(projectId).filter((fact) => fact.status === 'proposed').length;
  return {
    summaries,
    characters: activeCharacters(projectId),
    facts,
    staleSummaries: summaries.filter((entry) => entry.stale).length,
    pendingFacts,
  };
}

export interface ProjectMemoryStats {
  chapters: number;
  current: number;
  stale: number;
  missing: number;
  pending: number;
  proposedFacts: number;
  establishedFacts: number;
  outdatedFacts: number;
  activeCharacters: number;
  proposedCharacters: number;
}

export function projectMemoryStats(
  projectId: string,
  chapters: ChapterMemory[],
  facts: Fact[],
  characters: Character[],
): ProjectMemoryStats {
  return {
    chapters: chapters.length,
    current: chapters.filter((entry) => entry.status === 'current').length,
    stale: chapters.filter((entry) => entry.status === 'stale').length,
    missing: chapters.filter((entry) => entry.status === 'missing').length,
    pending: chapters.filter((entry) => entry.status === 'pending').length,
    proposedFacts: facts.filter((fact) => fact.status === 'proposed').length,
    establishedFacts: facts.filter((fact) => fact.status === 'established').length,
    outdatedFacts: facts.filter((fact) => fact.sourceOutdated && fact.status === 'established').length,
    activeCharacters: characters.filter((character) => character.status === 'active').length,
    proposedCharacters: characters.filter((character) => character.status === 'proposed').length,
  };
}

export function memoryPromptText(projectId: string, chapterId: string, taskQuery = ''): string {
  const chapter = getChapter(chapterId);
  const memory = memoryForPrompt(projectId, chapterId, { includeSummaries: false });
  const state = inspectStoryState(projectId, chapter.orderIndex);
  const references = selectStoryReferences({ chapter, additionalInstructions: taskQuery.slice(0, 8000), state: state.info.text, characters: memory.characters,
    facts: memory.facts, preset: 'balanced' });
  const parts: string[] = [];
  if (state.info.text) parts.push(`## Current story state\n${state.info.text}`);
  if (references.characters.length) parts.push(references.characters.map(referenceCharacterText).join('\n\n'));
  if (references.facts.length) parts.push(references.facts.map(referenceFactText).join('\n'));
  return parts.join('\n\n');
}

export function characterProfileText(character: Character): string {
  const lines = [`### ${character.name}${character.role ? ` — ${character.role}` : ''}`];
  if (character.identity) lines.push(`Identity: ${character.identity}`);
  if (character.appearance) lines.push(`Appearance: ${character.appearance}`);
  if (character.personality) lines.push(`Personality: ${character.personality}`);
  if (character.goals) lines.push(`Goals: ${character.goals}`);
  if (character.relationships) lines.push(`Relationships: ${character.relationships}`);
  if (character.notes) lines.push(`Notes: ${character.notes}`);
  return lines.join('\n');
}
