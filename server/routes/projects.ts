import express, { Router } from 'express';
import { z } from 'zod';
import {
  createProject,
  getProject,
  listProjects,
  setProjectStatus,
  updateProject,
} from '../store/projects.js';
import { getProjectGeneration, resolveRoles, setProjectSettings, projectGenerationSources, resetProjectGeneration, setProjectVisualStyle } from '../store/settings.js';
import { currentChapterText, listChapters } from '../store/chapters.js';
import { listPromptTemplates } from '../store/templates.js';
import { projectGenerationHistory } from '../jobs.js';
import { activeProjectPortraitBatches } from '../store/portrait-batches.js';
import { activeChapterBatch } from '../store/chapter-batches.js';
import { createProjectBackup, restoreProjectBackup } from '../backup.js';
import { badRequest } from '../errors.js';
import fs from 'node:fs';
import { listProjectImageAssets, getImageAssetRow, imageFilePath } from '../store/images.js';
import { listCharacters } from '../store/characters.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const projectsRouter = Router();

projectsRouter.get('/projects/:id/queue', wrap((req, res) => {
  const id = stringParam(req.params.id, 'project id');
  getProject(id);
  res.json({ jobs: projectGenerationHistory(id, 1000, true).entries, chapterBatch: activeChapterBatch(id), portraitBatches: activeProjectPortraitBatches(id), characters: listCharacters(id).map(({ id, name }) => ({ id, name })) });
}));

projectsRouter.patch('/projects/:id/visual-style', wrap((req,res) => {
  const id=stringParam(req.params.id,'project id');getProject(id);
  const {visualStyle}=parseBody(z.object({visualStyle:z.string().max(4000)}),req.body);
  setProjectVisualStyle(id,visualStyle);res.status(204).end();
}));

projectsRouter.get('/projects/:id/export.html', wrap((req, res) => {
  const id = stringParam(req.params.id, 'project id');
  const project = getProject(id);
  const assets = listProjectImageAssets(id).filter(a => a.selectedForChapter);
  const cast = listCharacters(id);
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]!));
  const sections = listChapters(id).map(chapter => {
    const images = assets.filter(a => a.chapterId === chapter.id).map(asset => {
      const file = imageFilePath(getImageAssetRow(asset.id).file_name);
      if (!fs.existsSync(file)) return '';
      return `<figure><img src="data:${asset.mimeType};base64,${fs.readFileSync(file).toString('base64')}" alt="${escape(cast.find(c => c.id === asset.characterId)?.name ?? 'Character')}"><figcaption>${escape(cast.find(c => c.id === asset.characterId)?.name ?? 'Character')}${asset.sourceOutdated ? ' — based on an earlier draft' : ''}</figcaption></figure>`;
    }).join('');
    return `<section><h2>Chapter ${chapter.orderIndex + 1}: ${escape(chapter.title)}</h2><div class="portraits">${images}</div><pre>${escape(currentChapterText(chapter.id))}</pre></section>`;
  }).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(project.title) || 'manuscript'}-illustrated.html"`);
  res.send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(project.title)}</title><style>body{max-width:850px;margin:40px auto;padding:20px;font:18px/1.8 Georgia,serif;color:#252525;background:#fff}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}.portraits{display:flex;flex-wrap:wrap;gap:20px}figure{margin:0;max-width:220px}img{max-width:100%;height:auto}figcaption{font:14px system-ui}section{break-before:page}</style><h1>${escape(project.title)}</h1><p>${escape(project.premise)}</p>${sections}</html>`);
}));

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
      generationSources: projectGenerationSources(id),
      roles: resolveRoles(id),
      templates: listPromptTemplates(id),
    });
  }),
);

projectsRouter.delete('/projects/:id/generation-settings', wrap((req, res) => {
  const id = stringParam(req.params.id, 'project id'); getProject(id); resetProjectGeneration(id);
  res.json({generation: getProjectGeneration(id), generationSources: projectGenerationSources(id)});
}));

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

projectsRouter.post(
  '/projects/restore',
  express.raw({
    type: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    limit: '512mb',
  }),
  wrap((req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      throw badRequest('Send the backup file as application/gzip or application/octet-stream.');
    }
    const result = restoreProjectBackup(req.body);
    res.status(201).json(result);
  }),
);

projectsRouter.get(
  '/projects/:id/backup',
  wrap((req, res) => {
    const backup = createProjectBackup(stringParam(req.params.id, 'project id'));
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(backup.bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${backup.filename}"; filename*=UTF-8''${encodeURIComponent(backup.filename)}`,
    );
    res.send(backup.bytes);
  }),
);

projectsRouter.get(
  '/projects/:id/generation-history',
  wrap((req, res) => {
    const id = stringParam(req.params.id, 'project id');
    getProject(id);
    const limit = Number(req.query.limit ?? 200);
    res.json(projectGenerationHistory(id, Number.isFinite(limit) ? limit : 200));
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
