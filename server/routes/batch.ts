import { Router } from 'express';
import { z } from 'zod';
import { getProject } from '../store/projects.js';
import { latestChapterBatch } from '../store/chapter-batches.js';
import { startChapterBatch, cancelChapterBatch } from '../chapter-batch.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const batchRouter = Router();

batchRouter.get(
  '/projects/:id/chapter-batch',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.json({ batch: latestChapterBatch(projectId) });
  }),
);

batchRouter.post(
  '/projects/:id/chapter-batch',
  wrap((req, res) => {
    const body = parseBody(
      z.object({ mode: z.enum(['draft', 'regenerate']).optional() }).default({}),
      req.body,
    );
    res.status(202).json({
      batch: startChapterBatch(stringParam(req.params.id, 'project id'), { mode: body.mode }),
    });
  }),
);

batchRouter.post(
  '/projects/:id/chapter-batch/cancel',
  wrap((req, res) => {
    res.json({ batch: cancelChapterBatch(stringParam(req.params.id, 'project id')) });
  }),
);
