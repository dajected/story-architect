import crypto from 'node:crypto';
import type { OutlineStatus, Project, ProjectStatus } from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { badRequest, notFound } from '../errors.js';

export interface ProjectRow {
  id: string;
  title: string;
  premise: string;
  genre: string;
  tone: string;
  pov: string;
  tense: string;
  style_notes: string;
  content_preferences: string;
  instructions: string;
  chapter_count: number | null;
  target_chapter_words: number | null;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

interface ProjectQueryRow extends ProjectRow {
  chapter_total: number;
  current_words: number;
  outline_status: OutlineStatus | null;
}

export interface ProjectInput {
  title?: string;
  premise?: string;
  genre?: string;
  tone?: string;
  pov?: string;
  tense?: string;
  styleNotes?: string;
  contentPreferences?: string;
  instructions?: string;
  chapterCount?: number | null;
  targetChapterWords?: number | null;
}

const projectSelect = `
  SELECT p.*,
    (SELECT COUNT(*) FROM chapters c WHERE c.project_id = p.id) AS chapter_total,
    (SELECT COALESCE(SUM(r.word_count), 0)
       FROM chapters c JOIN chapter_revisions r ON r.id = c.current_revision_id
      WHERE c.project_id = p.id) AS current_words,
    (SELECT o.status FROM outline_revisions o
      WHERE o.project_id = p.id ORDER BY o.version DESC LIMIT 1) AS outline_status
  FROM projects p
`;

function mapProject(row: ProjectQueryRow): Project {
  return {
    id: row.id,
    title: row.title,
    premise: row.premise,
    genre: row.genre,
    tone: row.tone,
    pov: row.pov,
    tense: row.tense,
    styleNotes: row.style_notes,
    contentPreferences: row.content_preferences,
    instructions: row.instructions,
    chapterCount: row.chapter_count,
    targetChapterWords: row.target_chapter_words,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    chapterTotal: Number(row.chapter_total ?? 0),
    currentWords: Number(row.current_words ?? 0),
    outlineStatus: (row.outline_status ?? 'none') as OutlineStatus,
  };
}

export function listProjects(includeArchived = false): Project[] {
  const rows = dbAll<ProjectQueryRow>(
    `${projectSelect} WHERE p.status = 'active' OR ? = 1 ORDER BY p.updated_at DESC`,
    includeArchived ? 1 : 0,
  );
  return rows.map(mapProject);
}

export function getProject(id: string): Project {
  const row = dbGet<ProjectQueryRow>(`${projectSelect} WHERE p.id = ?`, id);
  if (!row) throw notFound('Project not found.');
  return mapProject(row);
}

export function getProjectRow(id: string): ProjectRow {
  const row = dbGet<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
  if (!row) throw notFound('Project not found.');
  return row;
}

export function createProject(input: ProjectInput): Project {
  const title = (input.title ?? '').trim();
  if (!title) throw badRequest('A project title is required.');
  const chapterCount = optionalInteger(input.chapterCount, 1, 200, 'Chapter count');
  const targetWords = optionalInteger(input.targetChapterWords, 100, 20000, 'Target chapter length');
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO projects (
       id, title, premise, genre, tone, pov, tense, style_notes, content_preferences, instructions,
       chapter_count, target_chapter_words, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    id,
    title,
    input.premise ?? '',
    input.genre ?? '',
    input.tone ?? '',
    input.pov ?? '',
    input.tense ?? '',
    input.styleNotes ?? '',
    input.contentPreferences ?? '',
    input.instructions ?? '',
    chapterCount,
    targetWords,
    at,
    at,
  );
  return getProject(id);
}

export function updateProject(id: string, input: ProjectInput): Project {
  const existing = getProjectRow(id);
  const title = input.title === undefined ? existing.title : input.title.trim();
  if (!title) throw badRequest('A project title is required.');
  const chapterCount =
    input.chapterCount === undefined
      ? existing.chapter_count
      : optionalInteger(input.chapterCount, 1, 200, 'Chapter count');
  const targetWords =
    input.targetChapterWords === undefined
      ? existing.target_chapter_words
      : optionalInteger(input.targetChapterWords, 100, 20000, 'Target chapter length');

  dbRun(
    `UPDATE projects SET
       title = ?, premise = ?, genre = ?, tone = ?, pov = ?, tense = ?, style_notes = ?,
       content_preferences = ?, instructions = ?, chapter_count = ?, target_chapter_words = ?, updated_at = ?
     WHERE id = ?`,
    title,
    input.premise ?? existing.premise,
    input.genre ?? existing.genre,
    input.tone ?? existing.tone,
    input.pov ?? existing.pov,
    input.tense ?? existing.tense,
    input.styleNotes ?? existing.style_notes,
    input.contentPreferences ?? existing.content_preferences,
    input.instructions ?? existing.instructions,
    chapterCount,
    targetWords,
    timestamp(),
    id,
  );
  return getProject(id);
}

export function setProjectStatus(id: string, status: ProjectStatus): Project {
  getProjectRow(id);
  if (status !== 'active' && status !== 'archived') {
    throw badRequest('Project status must be active or archived.');
  }
  dbRun('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', status, timestamp(), id);
  return getProject(id);
}

export function touchProject(id: string): void {
  dbRun('UPDATE projects SET updated_at = ? WHERE id = ?', timestamp(), id);
}

function optionalInteger(
  value: number | null | undefined,
  min: number,
  max: number,
  label: string,
): number | null {
  if (value === null || value === undefined) return null;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < min || number > max) {
    throw badRequest(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}
