import crypto from 'node:crypto';
import type { ImagePromptTemplate } from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { IMAGE_PROMPT_TEMPLATE_DEFAULT } from '../prompts.js';

interface ImageTemplateRow {
  id: string;
  project_id: string | null;
  name: string;
  content: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function mapTemplate(row: ImageTemplateRow): ImagePromptTemplate {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    content: row.content,
    isDefault: Number(row.is_default) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listImagePromptTemplates(projectId?: string): ImagePromptTemplate[] {
  const rows = projectId
    ? dbAll<ImageTemplateRow>(
        `SELECT * FROM image_prompt_templates WHERE project_id IS NULL OR project_id = ?
         ORDER BY project_id IS NOT NULL, name COLLATE NOCASE`,
        projectId,
      )
    : dbAll<ImageTemplateRow>(
        'SELECT * FROM image_prompt_templates WHERE project_id IS NULL ORDER BY name COLLATE NOCASE',
      );
  return rows.map(mapTemplate);
}

export function getImagePromptTemplate(id: string): ImagePromptTemplate {
  const row = dbGet<ImageTemplateRow>('SELECT * FROM image_prompt_templates WHERE id = ?', id);
  if (!row) throw notFound('Image prompt template not found.');
  return mapTemplate(row);
}

export interface ImageTemplateInput {
  projectId: string | null;
  name: string;
  content: string;
  isDefault?: boolean;
}

export function createImagePromptTemplate(input: ImageTemplateInput): ImagePromptTemplate {
  validateImageTemplateInput(input);
  const id = crypto.randomUUID();
  const at = timestamp();
  if (input.isDefault) clearDefault(input.projectId);
  dbRun(
    `INSERT INTO image_prompt_templates (id, project_id, name, content, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.name.trim(),
    input.content,
    input.isDefault ? 1 : 0,
    at,
    at,
  );
  return getImagePromptTemplate(id);
}

export function updateImagePromptTemplate(
  id: string,
  input: Partial<Omit<ImageTemplateInput, 'projectId'>>,
): ImagePromptTemplate {
  const existing = getImagePromptTemplate(id);
  const name = input.name?.trim() ?? existing.name;
  const content = input.content ?? existing.content;
  if (!name) throw badRequest('Template name is required.');
  if (!content.trim()) throw badRequest('Template content is required.');
  if (input.isDefault) clearDefault(existing.projectId);
  dbRun(
    `UPDATE image_prompt_templates SET name = ?, content = ?, is_default = ?, updated_at = ?
     WHERE id = ?`,
    name,
    content,
    input.isDefault === undefined ? (existing.isDefault ? 1 : 0) : input.isDefault ? 1 : 0,
    timestamp(),
    id,
  );
  return getImagePromptTemplate(id);
}

export function setDefaultImagePromptTemplate(id: string): ImagePromptTemplate {
  const existing = getImagePromptTemplate(id);
  clearDefault(existing.projectId);
  dbRun(
    'UPDATE image_prompt_templates SET is_default = 1, updated_at = ? WHERE id = ?',
    timestamp(),
    id,
  );
  return getImagePromptTemplate(id);
}

export function deleteImagePromptTemplate(id: string): void {
  getImagePromptTemplate(id);
  dbRun('DELETE FROM image_prompt_templates WHERE id = ?', id);
}

export function resolveImagePromptTemplate(
  projectId: string,
  templateId?: string | null,
): { id: string | null; name: string; content: string; scope: 'project' | 'global' | 'builtin' } {
  if (templateId) {
    const template = getImagePromptTemplate(templateId);
    if (template.projectId && template.projectId !== projectId) {
      throw badRequest('That image prompt template belongs to another project.');
    }
    return {
      id: template.id,
      name: template.name,
      content: template.content,
      scope: template.projectId ? 'project' : 'global',
    };
  }

  const projectTemplate = dbGet<ImageTemplateRow>(
    'SELECT * FROM image_prompt_templates WHERE project_id = ? AND is_default = 1 LIMIT 1',
    projectId,
  );
  if (projectTemplate) {
    return {
      id: projectTemplate.id,
      name: projectTemplate.name,
      content: projectTemplate.content,
      scope: 'project',
    };
  }
  const globalTemplate = dbGet<ImageTemplateRow>(
    'SELECT * FROM image_prompt_templates WHERE project_id IS NULL AND is_default = 1 LIMIT 1',
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
    name: 'Built-in image prompt',
    content: IMAGE_PROMPT_TEMPLATE_DEFAULT,
    scope: 'builtin',
  };
}

function clearDefault(projectId: string | null): void {
  if (projectId) {
    dbRun('UPDATE image_prompt_templates SET is_default = 0 WHERE project_id = ?', projectId);
  } else {
    dbRun('UPDATE image_prompt_templates SET is_default = 0 WHERE project_id IS NULL');
  }
}

function validateImageTemplateInput(input: ImageTemplateInput): void {
  if (!input.name?.trim()) throw badRequest('Template name is required.');
  if (!input.content?.trim()) throw badRequest('Template content is required.');
}
