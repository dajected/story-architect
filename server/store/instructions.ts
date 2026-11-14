import crypto from 'node:crypto';
import type { ProseInstruction } from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { getProject, touchProject } from './projects.js';

interface ProseInstructionRow {
  id: string;
  project_id: string | null;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

function mapInstruction(row: ProseInstructionRow): ProseInstruction {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    text: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProseInstructions(projectId: string): ProseInstruction[] {
  getProject(projectId);
  return dbAll<ProseInstructionRow>(
    `SELECT * FROM prose_instructions
      WHERE project_id = ? OR project_id IS NULL
      ORDER BY name COLLATE NOCASE`,
    projectId,
  ).map(mapInstruction);
}

function getRow(id: string): ProseInstructionRow {
  const row = dbGet<ProseInstructionRow>('SELECT * FROM prose_instructions WHERE id = ?', id);
  if (!row) throw notFound('Saved instruction not found.');
  return row;
}

function validate(input: { name?: string; text?: string }): { name: string; text: string } {
  const name = (input.name ?? '').trim();
  if (!name) throw badRequest('A saved instruction needs a name.');
  if (name.length > 200) throw badRequest('Instruction names must be 200 characters or fewer.');
  const text = (input.text ?? '').trim();
  if (!text) throw badRequest('A saved instruction needs text.');
  if (text.length > 8000) throw badRequest('Instructions must be 8,000 characters or fewer.');
  return { name, text };
}

export function createProseInstruction(
  projectId: string,
  input: { name?: string; text?: string },
): ProseInstruction {
  getProject(projectId);
  const values = validate(input);
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO prose_instructions (id, project_id, name, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    projectId,
    values.name,
    values.text,
    at,
    at,
  );
  touchProject(projectId);
  return mapInstruction(getRow(id));
}

function requireAccessible(projectId: string, id: string): ProseInstructionRow {
  const row = getRow(id);
  if (row.project_id !== null && row.project_id !== projectId) {
    throw notFound('Saved instruction not found.');
  }
  return row;
}

export function updateProseInstruction(
  projectId: string,
  id: string,
  input: { name?: string; text?: string },
): ProseInstruction {
  const existing = requireAccessible(projectId, id);
  const values = validate({
    name: input.name ?? existing.name,
    text: input.text ?? existing.content,
  });
  dbRun(
    'UPDATE prose_instructions SET name = ?, content = ?, updated_at = ? WHERE id = ?',
    values.name,
    values.text,
    timestamp(),
    id,
  );
  touchProject(projectId);
  return mapInstruction(getRow(id));
}

export function deleteProseInstruction(projectId: string, id: string): void {
  requireAccessible(projectId, id);
  dbRun('DELETE FROM prose_instructions WHERE id = ?', id);
  touchProject(projectId);
}
