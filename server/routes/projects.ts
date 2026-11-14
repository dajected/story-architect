import { Router } from 'express';
import { z } from 'zod';
import {
  createProject,
  getProject,
  listProjects,
  setProjectStatus,
  updateProject,
} from '../store/projects.js';
import { getProjectGeneration, resolveRoles, setProjectSettings } from '../store/settings.js';
import { currentChapterText, listChapters } from '../store/chapters.js';
import { listPromptTemplates } from '../store/templates.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const projectsRouter = Router();

const projectFields = {
  title: z.string().max(240).optional(),
  premise: z.string().max(20000).optional(),
  genre: z.string().max(500).optional(),
  tone: z.string().max(500).optional(),
  pov: z.string().max(200).optional(),
  tense: z.string().max(200).optional(),
  styleNotes: z.string().max(20000).optional(),
  contentPreferences: z.string().max(20000).optional(),
  instructions: z.string().max(20000).optional(),
  chapterCount: z.number().int().nullable().optional(),
  targetChapterWords: z.number().int().nullable().optional(),
};

projectsRouter.get(
  '/projects',
  wrap((req, res) => {
    const includeArchived = req.query.includeArchived === '1';
    res.json({ projects: listProjects(includeArchived) });
  }),
);

projectsRouter.post(
  '/projects',
  wrap((req, res) => {
    const input = parseBody(z.object(projectFields), req.body);
    res.status(201).json({ project: createProject(input) });
  }),
);

projectsRouter.get(
  '/projects/:id',
  wrap((req, res) => {
    res.json({ project: getProject(stringParam(req.params.id, 'project id')) });
  }),
);

projectsRouter.patch(
  '/projects/:id',
  wrap((req, res) => {
    const id = stringParam(req.params.id, 'project id');
    const input = parseBody(z.object(projectFields), req.body);
    res.json({ project: updateProject(id, input) });
  }),
);

projectsRouter.post(
  '/projects/:id/archive',
  wrap((req, res) => {
    res.json({ project: setProjectStatus(stringParam(req.params.id, 'project id'), 'archived') });
  }),
);

projectsRouter.post(
  '/projects/:id/unarchive',
  wrap((req, res) => {
    res.json({ project: setProjectStatus(stringParam(req.params.id, 'project id'), 'active') });
  }),
);

projectsRouter.get(
  '/projects/:id/settings',
  wrap((req, res) => {
    const id = stringParam(req.params.id, 'project id');
    getProject(id);
    res.json({
      generation: getProjectGeneration(id),
      roles: resolveRoles(id),
      templates: listPromptTemplates(id),
    });
  }),
);

projectsRouter.patch(
  '/projects/:id/settings',
  wrap((req, res) => {
    const id = stringParam(req.params.id, 'project id');
    getProject(id);
    const body = parseBody(
      z.object({ generation: z.record(z.string(), z.unknown()).optional() }),
      req.body,
    );
    res.json({ generation: setProjectSettings(id, { generation: body.generation as never }) });
  }),
);

projectsRouter.get(
  '/projects/:id/export.md',
  wrap((req, res) => {
    const id = stringParam(req.params.id, 'project id');
    const project = getProject(id);
    const chapters = listChapters(id);
    const parts: string[] = [`# ${project.title}`];
    if (project.premise.trim()) parts.push(`_${project.premise.trim()}_`);

    let exported = 0;
    chapters.forEach((chapter, index) => {
      if (!chapter.currentRevisionId) return;
      const content = currentChapterText(chapter.id);
      if (!content.trim()) return;
      parts.push(`## Chapter ${index + 1}: ${chapter.title}`, content.trim());
      exported += 1;
    });

    if (exported === 0) {
      parts.push('*(No chapter text has been written yet.)*');
    }

    const filename = `${slugify(project.title) || 'manuscript'}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(`${parts.join('\n\n')}\n`);
  }),
);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
