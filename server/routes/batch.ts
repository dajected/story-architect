import { Router } from 'express';
import { getProject } from '../store/projects.js';
import { latestChapterBatch } from '../store/chapter-batches.js';
import { startChapterBatch, cancelChapterBatch } from '../chapter-batch.js';
import { stringParam, wrap } from './helpers.js';

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
    res.status(202).json({ batch: startChapterBatch(stringParam(req.params.id, 'project id')) });
  }),
);

batchRouter.post(
  '/projects/:id/chapter-batch/cancel',
  wrap((req, res) => {
    res.json({ batch: cancelChapterBatch(stringParam(req.params.id, 'project id')) });
  }),
);
