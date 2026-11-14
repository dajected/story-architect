import crypto from 'node:crypto';
import type {
  LoreEntry,
  LoreEntryInput,
  LoreOverview,
  Lorebook,
} from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp, transaction } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { getProject, touchProject } from './projects.js';

interface LorebookRow {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  entry_count: number;
  linked_project_count: number;
}

interface LoreEntryRow {
  id: string;
  lorebook_id: string;
  lorebook_name: string;
  title: string;
  content: string;
  triggers: string;
  enabled: number;
  always_include: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

const lorebookSelect = `
  SELECT b.*,
    (SELECT COUNT(*) FROM lore_entries e WHERE e.lorebook_id = b.id) AS entry_count,
    (SELECT COUNT(*) FROM lorebook_links l WHERE l.lorebook_id = b.id) AS linked_project_count
  FROM lorebooks b
`;

const loreEntrySelect = `
  SELECT e.*, b.name AS lorebook_name
  FROM lore_entries e JOIN lorebooks b ON b.id = e.lorebook_id
`;

function parseTriggers(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function normaliseTriggers(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const triggers: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trigger = raw.trim().slice(0, 80);
    if (!trigger) continue;
    const key = trigger.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    triggers.push(trigger);
    if (triggers.length >= 30) break;
  }
  return triggers;
}

function mapLorebook(row: LorebookRow, projectId: string): Lorebook {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    projectId: row.project_id,
    owned: row.project_id === projectId,
    entryCount: Number(row.entry_count ?? 0),
    linkedProjectCount: Number(row.linked_project_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEntry(row: LoreEntryRow, pinnedIds: Set<string>): LoreEntry {
  return {
    id: row.id,
    lorebookId: row.lorebook_id,
    lorebookName: row.lorebook_name,
    title: row.title,
    content: row.content,
    triggers: parseTriggers(row.triggers),
    enabled: Number(row.enabled) === 1,
    alwaysInclude: Number(row.always_include) === 1,
    priority: Number(row.priority),
    pinned: pinnedIds.has(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listLorePins(projectId: string): string[] {
  return dbAll<{ entry_id: string }>(
    'SELECT entry_id FROM lore_pins WHERE project_id = ? ORDER BY created_at',
    projectId,
  ).map((row) => row.entry_id);
}

export function clearLorePins(projectId: string): void {
  dbRun('DELETE FROM lore_pins WHERE project_id = ?', projectId);
}

function linkedBooks(projectId: string): Lorebook[] {
  return dbAll<LorebookRow>(
    `${lorebookSelect}
      JOIN lorebook_links l ON l.lorebook_id = b.id AND l.project_id = ?
      ORDER BY b.name COLLATE NOCASE`,
    projectId,
  ).map((row) => mapLorebook(row, projectId));
}

export function listLorebooks(projectId: string): Lorebook[] {
  getProject(projectId);
  return linkedBooks(projectId);
}

export function listLoreEntries(projectId: string): LoreEntry[] {
  const pinned = new Set(listLorePins(projectId));
  const rows = dbAll<LoreEntryRow>(
    `${loreEntrySelect}
      JOIN lorebook_links l ON l.lorebook_id = e.lorebook_id AND l.project_id = ?
      ORDER BY b.name COLLATE NOCASE, e.priority DESC, e.title COLLATE NOCASE`,
    projectId,
  );
  return rows.map((row) => mapEntry(row, pinned));
}

export function getLoreOverview(projectId: string): LoreOverview {
  getProject(projectId);
  const books = linkedBooks(projectId);
  const linked = new Set(books.map((book) => book.id));
  const unlinkedBooks = dbAll<LorebookRow>(`${lorebookSelect} ORDER BY b.name COLLATE NOCASE`)
    .map((row) => mapLorebook(row, projectId))
    .filter((book) => !linked.has(book.id));
  return {
    projectId,
    books,
    entries: listLoreEntries(projectId),
    pinnedEntryIds: listLorePins(projectId),
    unlinkedBooks,
  };
}

export function getLorebookRow(id: string): LorebookRow {
  const row = dbGet<LorebookRow>(`${lorebookSelect} WHERE b.id = ?`, id);
  if (!row) throw notFound('Lorebook not found.');
  return row;
}

function requireLinked(projectId: string, lorebookId: string): LorebookRow {
  const row = getLorebookRow(lorebookId);
  const link = dbGet<{ lorebook_id: string }>(
    'SELECT lorebook_id FROM lorebook_links WHERE project_id = ? AND lorebook_id = ?',
    projectId,
    lorebookId,
  );
  if (!link) throw notFound('That lorebook is not attached to this novel.');
  return row;
}

function normaliseName(value: string | undefined, fallback?: string): string {
  const name = (value ?? fallback ?? '').trim();
  if (!name) throw badRequest('A lorebook name is required.');
  if (name.length > 200) throw badRequest('Lorebook names must be 200 characters or fewer.');
  return name;
}

export function createLorebook(
  projectId: string,
  input: { name?: string; description?: string },
): Lorebook {
  getProject(projectId);
  const name = normaliseName(input.name);
  const description = (input.description ?? '').trim().slice(0, 4000);
  const id = crypto.randomUUID();
  const at = timestamp();
  transaction(() => {
    dbRun(
      `INSERT INTO lorebooks (id, project_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      name,
      description,
      at,
      at,
    );
    dbRun(
      'INSERT INTO lorebook_links (project_id, lorebook_id, created_at) VALUES (?, ?, ?)',
      projectId,
      id,
      at,
    );
  });
  touchProject(projectId);
  return mapLorebook(getLorebookRow(id), projectId);
}

export function updateLorebook(
  projectId: string,
  id: string,
  input: { name?: string; description?: string },
): Lorebook {
  const existing = requireLinked(projectId, id);
  const name = input.name === undefined ? existing.name : normaliseName(input.name);
  const description =
    input.description === undefined
      ? existing.description
      : input.description.trim().slice(0, 4000);
  dbRun(
    'UPDATE lorebooks SET name = ?, description = ?, updated_at = ? WHERE id = ?',
    name,
    description,
    timestamp(),
    id,
  );
  touchProject(projectId);
  return mapLorebook(getLorebookRow(id), projectId);
}

/** Owned books are deleted; shared books are only detached from this novel. */
export function removeLorebook(projectId: string, id: string): { deleted: boolean } {
  const existing = requireLinked(projectId, id);
  if (existing.project_id === projectId) {
    dbRun('DELETE FROM lorebooks WHERE id = ?', id);
    touchProject(projectId);
    return { deleted: true };
  }
  dbRun(
    'DELETE FROM lorebook_links WHERE project_id = ? AND lorebook_id = ?',
    projectId,
    id,
  );
  touchProject(projectId);
  return { deleted: false };
}

export function linkLorebook(projectId: string, lorebookId: string): Lorebook {
  getProject(projectId);
  getLorebookRow(lorebookId);
  dbRun(
    `INSERT INTO lorebook_links (project_id, lorebook_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id, lorebook_id) DO NOTHING`,
    projectId,
    lorebookId,
    timestamp(),
  );
  touchProject(projectId);
  return mapLorebook(getLorebookRow(lorebookId), projectId);
}

export function unlinkLorebook(projectId: string, lorebookId: string): void {
  const existing = requireLinked(projectId, lorebookId);
  if (existing.project_id === projectId) {
    throw badRequest(
      'This novel owns that lorebook. Delete the book instead of detaching it.',
    );
  }
  dbRun(
    'DELETE FROM lorebook_links WHERE project_id = ? AND lorebook_id = ?',
    projectId,
    lorebookId,
  );
  dbRun('DELETE FROM lore_pins WHERE project_id = ? AND entry_id IN (SELECT id FROM lore_entries WHERE lorebook_id = ?)', projectId, lorebookId);
  touchProject(projectId);
}

function getEntryRow(id: string): LoreEntryRow {
  const row = dbGet<LoreEntryRow>(`${loreEntrySelect} WHERE e.id = ?`, id);
  if (!row) throw notFound('Lore entry not found.');
  return row;
}

function validateEntryInput(input: LoreEntryInput): {
  title: string;
  content: string;
  triggers: string[];
  enabled: boolean;
  alwaysInclude: boolean;
  priority: number;
} {
  const title = (input.title ?? '').trim();
  if (!title) throw badRequest('A lore entry needs a title.');
  if (title.length > 240) throw badRequest('Lore entry titles must be 240 characters or fewer.');
  const content = (input.content ?? '').trim();
  if (!content) throw badRequest('A lore entry needs text.');
  if (content.length > 20000) throw badRequest('Lore entry text must be 20,000 characters or fewer.');
  const priority = Math.round(Number(input.priority ?? 0));
  if (!Number.isFinite(priority) || priority < 0 || priority > 100) {
    throw badRequest('Lore priority must be a whole number between 0 and 100.');
  }
  return {
    title,
    content,
    triggers: normaliseTriggers(input.triggers),
    enabled: input.enabled !== false,
    alwaysInclude: input.alwaysInclude === true,
    priority,
  };
}

export function createLoreEntry(
  projectId: string,
  lorebookId: string,
  input: LoreEntryInput,
): LoreEntry {
  requireLinked(projectId, lorebookId);
  const values = validateEntryInput(input);
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO lore_entries (
       id, lorebook_id, title, content, triggers, enabled, always_include, priority, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    lorebookId,
    values.title,
    values.content,
    JSON.stringify(values.triggers),
    values.enabled ? 1 : 0,
    values.alwaysInclude ? 1 : 0,
    values.priority,
    at,
    at,
  );
  touchProject(projectId);
  return mapEntry(getEntryRow(id), new Set(listLorePins(projectId)));
}

export function updateLoreEntry(
  projectId: string,
  entryId: string,
  input: Partial<LoreEntryInput>,
): LoreEntry {
  const existing = getEntryRow(entryId);
  requireLinked(projectId, existing.lorebook_id);
  const merged = validateEntryInput({
    title: input.title ?? existing.title,
    content: input.content ?? existing.content,
    triggers: input.triggers ?? parseTriggers(existing.triggers),
    enabled: input.enabled ?? Number(existing.enabled) === 1,
    alwaysInclude: input.alwaysInclude ?? Number(existing.always_include) === 1,
    priority: input.priority ?? Number(existing.priority),
  });
  dbRun(
    `UPDATE lore_entries SET title = ?, content = ?, triggers = ?, enabled = ?,
       always_include = ?, priority = ?, updated_at = ?
     WHERE id = ?`,
    merged.title,
    merged.content,
    JSON.stringify(merged.triggers),
    merged.enabled ? 1 : 0,
    merged.alwaysInclude ? 1 : 0,
    merged.priority,
    timestamp(),
    entryId,
  );
  touchProject(projectId);
  return mapEntry(getEntryRow(entryId), new Set(listLorePins(projectId)));
}

export function deleteLoreEntry(projectId: string, entryId: string): void {
  const existing = getEntryRow(entryId);
  requireLinked(projectId, existing.lorebook_id);
  dbRun('DELETE FROM lore_entries WHERE id = ?', entryId);
  touchProject(projectId);
}

/** Pin entries for the next chapter generation only. */
export function setLorePins(projectId: string, entryIds: string[]): string[] {
  getProject(projectId);
  const wanted = [...new Set(entryIds)];
  for (const entryId of wanted) {
    const entry = getEntryRow(entryId);
    requireLinked(projectId, entry.lorebook_id);
  }
  transaction(() => {
    dbRun('DELETE FROM lore_pins WHERE project_id = ?', projectId);
    const at = timestamp();
    for (const entryId of wanted) {
      dbRun(
        'INSERT INTO lore_pins (project_id, entry_id, created_at) VALUES (?, ?, ?)',
        projectId,
        entryId,
        at,
      );
    }
  });
  touchProject(projectId);
  return wanted;
}

export interface PromptLoreEntry {
  entry: LoreEntry;
  lorebookName: string;
}

/**
 * Every enabled entry in a linked book, once per entry, with the current
 * project's pin state. Activation and budgeting happen in the context builder.
 */
export function loreEntriesForPrompt(projectId: string): PromptLoreEntry[] {
  return listLoreEntries(projectId)
    .filter((entry) => entry.enabled)
    .map((entry) => ({ entry, lorebookName: entry.lorebookName }));
}

