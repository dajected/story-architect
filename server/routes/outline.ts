import { Router } from 'express';
import { z } from 'zod';
import {
  approveOutline,
  createManualOutline,
  latestOutlineRevision,
  listOutlineRevisions,
  saveOutlineDraft,
} from '../store/outline.js';
import { getProject } from '../store/projects.js';
import { startOutlineGeneration } from '../generation.js';
import { activeOutlineJob, latestOutlineJob } from '../jobs.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const outlineRouter = Router();

outlineRouter.get(
  '/projects/:id/outline',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.json({
      revisions: listOutlineRevisions(projectId),
      latest: latestOutlineRevision(projectId),
      activeJob: activeOutlineJob(projectId),
      lastJob: latestOutlineJob(projectId),
    });
  }),
);

outlineRouter.post(
  '/projects/:id/outline/generate',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(
      z.object({ instructions: z.string().max(8000).optional() }).default({}),
      req.body,
    );
    res.status(202).json({ job: startOutlineGeneration(projectId, body.instructions) });
  }),
);

outlineRouter.post(
  '/projects/:id/outline/manual',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const project = getProject(projectId);
    res.status(201).json({ revision: createManualOutline(projectId, project.title) });
  }),
);

const chaptersSchema = z.array(
  z.object({
    id: z.string().optional(),
    title: z.string().max(240),
    brief: z.string().max(8000),
  }),
);

outlineRouter.put(
  '/projects/:id/outline',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(
      z.object({
        chapters: chaptersSchema,
        revisionId: z.string().optional(),
      }),
      req.body,
    );
    res.json({ revision: saveOutlineDraft(projectId, body.chapters, body.revisionId) });
  }),
);

outlineRouter.post(
  '/projects/:id/outline/:revisionId/approve',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const revisionId = stringParam(req.params.revisionId, 'revision id');
    res.json({ revision: approveOutline(projectId, revisionId) });
  }),
);
