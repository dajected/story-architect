import { Router } from 'express';
import { z } from 'zod';
import {
  clearLorePins,
  createLorebook,
  createLoreEntry,
  deleteLoreEntry,
  getLoreOverview,
  linkLorebook,
  removeLorebook,
  setLorePins,
  unlinkLorebook,
  updateLorebook,
  updateLoreEntry,
} from '../store/lore.js';
import { getProject } from '../store/projects.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const loreRouter = Router();

const bookCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
});

const bookUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
});

const entryOptions = {
  triggers: z.array(z.string().max(80)).max(30).optional(),
  enabled: z.boolean().optional(),
  alwaysInclude: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
};

const entryCreate = z.object({
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(20000),
  ...entryOptions,
});

const entryUpdate = z.object({
  title: z.string().min(1).max(240).optional(),
  content: z.string().min(1).max(20000).optional(),
  ...entryOptions,
});

loreRouter.get(
  '/projects/:id/lore',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.json(getLoreOverview(projectId));
  }),
);

loreRouter.post(
  '/projects/:id/lorebooks',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(bookCreate, req.body);
    res.status(201).json({ lorebook: createLorebook(projectId, body) });
  }),
);

loreRouter.patch(
  '/projects/:id/lorebooks/:bookId',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(bookUpdate, req.body);
    res.json({
      lorebook: updateLorebook(projectId, stringParam(req.params.bookId, 'lorebook id'), body),
    });
  }),
);

loreRouter.delete(
  '/projects/:id/lorebooks/:bookId',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    res.json({
      result: removeLorebook(projectId, stringParam(req.params.bookId, 'lorebook id')),
    });
  }),
);

loreRouter.post(
  '/projects/:id/lorebooks/:bookId/link',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    res
      .status(201)
      .json({ lorebook: linkLorebook(projectId, stringParam(req.params.bookId, 'lorebook id')) });
  }),
);

loreRouter.post(
  '/projects/:id/lorebooks/:bookId/unlink',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    unlinkLorebook(projectId, stringParam(req.params.bookId, 'lorebook id'));
    res.status(204).end();
  }),
);

loreRouter.post(
  '/projects/:id/lorebooks/:bookId/entries',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(entryCreate, req.body);
    res.status(201).json({
      entry: createLoreEntry(
        projectId,
        stringParam(req.params.bookId, 'lorebook id'),
        body,
      ),
    });
  }),
);

loreRouter.patch(
  '/projects/:id/lore-entries/:entryId',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(entryUpdate, req.body);
    res.json({
      entry: updateLoreEntry(projectId, stringParam(req.params.entryId, 'lore entry id'), body),
    });
  }),
);

loreRouter.delete(
  '/projects/:id/lore-entries/:entryId',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    deleteLoreEntry(projectId, stringParam(req.params.entryId, 'lore entry id'));
    res.status(204).end();
  }),
);

loreRouter.put(
  '/projects/:id/lore/pins',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(
      z.object({ entryIds: z.array(z.string()).max(200) }).default({ entryIds: [] }),
      req.body,
    );
    res.json({ pinnedEntryIds: setLorePins(projectId, body.entryIds) });
  }),
);

loreRouter.delete(
  '/projects/:id/lore/pins',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    clearLorePins(projectId);
    res.status(204).end();
  }),
);
