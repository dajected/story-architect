import crypto from 'node:crypto';
import type { PromptTemplate, PromptTemplateKind } from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { OUTLINE_TEMPLATE_DEFAULT, PROSE_TEMPLATE_DEFAULT } from '../prompts.js';

interface TemplateRow {
  id: string;
  project_id: string | null;
  kind: PromptTemplateKind;
  name: string;
  content: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function mapTemplate(row: TemplateRow): PromptTemplate {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    content: row.content,
    isDefault: Number(row.is_default) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPromptTemplates(projectId?: string): PromptTemplate[] {
  const rows = projectId
    ? dbAll<TemplateRow>(
        `SELECT * FROM prompt_templates WHERE project_id IS NULL OR project_id = ?
         ORDER BY kind, project_id IS NOT NULL, name COLLATE NOCASE`,
        projectId,
      )
    : dbAll<TemplateRow>(
        'SELECT * FROM prompt_templates WHERE project_id IS NULL ORDER BY kind, name COLLATE NOCASE',
      );
  return rows.map(mapTemplate);
}

export function getPromptTemplate(id: string): PromptTemplate {
  const row = dbGet<TemplateRow>('SELECT * FROM prompt_templates WHERE id = ?', id);
  if (!row) throw notFound('Prompt template not found.');
  return mapTemplate(row);
}

export interface TemplateInput {
  projectId: string | null;
  kind: PromptTemplateKind;
  name: string;
  content: string;
  isDefault?: boolean;
}

export function createPromptTemplate(input: TemplateInput): PromptTemplate {
  validateTemplateInput(input);
  const id = crypto.randomUUID();
  const at = timestamp();
  if (input.isDefault) {
    clearDefault(input.projectId, input.kind);
  }
  dbRun(
    `INSERT INTO prompt_templates (id, project_id, kind, name, content, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.kind,
    input.name.trim(),
    input.content,
    input.isDefault ? 1 : 0,
    at,
    at,
  );
  return getPromptTemplate(id);
}

export function updatePromptTemplate(
  id: string,
  input: Partial<Omit<TemplateInput, 'projectId' | 'kind'>>,
): PromptTemplate {
  const existing = getPromptTemplate(id);
  const name = input.name?.trim() ?? existing.name;
  const content = input.content ?? existing.content;
  if (!name) throw badRequest('Template name is required.');
  if (!content.trim()) throw badRequest('Template content is required.');
  if (input.isDefault) {
    clearDefault(existing.projectId, existing.kind);
  }
  dbRun(
    'UPDATE prompt_templates SET name = ?, content = ?, is_default = ?, updated_at = ? WHERE id = ?',
    name,
    content,
    input.isDefault === undefined ? (existing.isDefault ? 1 : 0) : input.isDefault ? 1 : 0,
    timestamp(),
    id,
  );
  return getPromptTemplate(id);
}

export function setDefaultPromptTemplate(id: string): PromptTemplate {
  const existing = getPromptTemplate(id);
  clearDefault(existing.projectId, existing.kind);
  dbRun('UPDATE prompt_templates SET is_default = 1, updated_at = ? WHERE id = ?', timestamp(), id);
  return getPromptTemplate(id);
}

export function deletePromptTemplate(id: string): void {
  getPromptTemplate(id);
  dbRun('DELETE FROM prompt_templates WHERE id = ?', id);
}

function clearDefault(projectId: string | null, kind: PromptTemplateKind): void {
  if (projectId) {
    dbRun(
      'UPDATE prompt_templates SET is_default = 0 WHERE project_id = ? AND kind = ?',
      projectId,
      kind,
    );
  } else {
    dbRun('UPDATE prompt_templates SET is_default = 0 WHERE project_id IS NULL AND kind = ?', kind);
  }
}

function validateTemplateInput(input: TemplateInput): void {
  if (input.kind !== 'outline' && input.kind !== 'prose') {
    throw badRequest('Template kind must be outline or prose.');
  }
  if (!input.name?.trim()) throw badRequest('Template name is required.');
  if (!input.content?.trim()) throw badRequest('Template content is required.');
}

export function resolvePromptTemplate(
  projectId: string,
  kind: PromptTemplateKind,
): { id: string | null; name: string; content: string; scope: 'project' | 'global' | 'builtin' } {
  const projectTemplate = dbGet<TemplateRow>(
    'SELECT * FROM prompt_templates WHERE project_id = ? AND kind = ? AND is_default = 1 LIMIT 1',
    projectId,
    kind,
  );
  if (projectTemplate) {
    return {
      id: projectTemplate.id,
      name: projectTemplate.name,
      content: projectTemplate.content,
      scope: 'project',
    };
  }
  const globalTemplate = dbGet<TemplateRow>(
    'SELECT * FROM prompt_templates WHERE project_id IS NULL AND kind = ? AND is_default = 1 LIMIT 1',
    kind,
  );
  if (globalTemplate) {
    return {
      id: globalTemplate.id,
      name: globalTemplate.name,
      content: globalTemplate.content,
      scope: 'global',
    };
  }
  return {
    id: null,
    name: kind === 'outline' ? 'Built-in outline prompt' : 'Built-in prose prompt',
    content: kind === 'outline' ? OUTLINE_TEMPLATE_DEFAULT : PROSE_TEMPLATE_DEFAULT,
    scope: 'builtin',
  };
}
