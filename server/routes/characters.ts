import { Router } from 'express';
import { z } from 'zod';
import {
  createCharacter,
  listCharacters,
  setCharacterStatus,
  updateCharacter,
} from '../store/characters.js';
import { getProject } from '../store/projects.js';
import { startCharacterProposal } from '../memory-generation.js';
import { activeProjectJobKind } from '../jobs.js';
import { listCharacterAppearances } from '../store/appearances.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const charactersRouter = Router();

charactersRouter.get(
  '/characters/:id/appearances',
  wrap((req, res) => {
    res.json({ appearances: listCharacterAppearances(stringParam(req.params.id, 'character id')) });
  }),
);

const characterSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  role: z.string().max(120).optional(),
  identity: z.string().max(4000).optional(),
  appearance: z.string().max(4000).optional(),
  personality: z.string().max(4000).optional(),
  goals: z.string().max(4000).optional(),
  relationships: z.string().max(4000).optional(),
  notes: z.string().max(8000).optional(),
  keyCharacter: z.boolean().optional(),
});

charactersRouter.get(
  '/projects/:id/characters',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.json({
      characters: listCharacters(projectId),
      activeJob: activeProjectJobKind(projectId, 'characters'),
    });
  }),
);

charactersRouter.post(
  '/projects/:id/characters',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(characterSchema, req.body);
    if (!body.name) {
      res.status(400).json({ error: 'A character name is required.' });
      return;
    }
    res.status(201).json({ character: createCharacter(projectId, { ...body, name: body.name }) });
  }),
);

charactersRouter.patch(
  '/characters/:id',
  wrap((req, res) => {
    const body = parseBody(characterSchema, req.body);
    res.json({ character: updateCharacter(stringParam(req.params.id, 'character id'), body) });
  }),
);

charactersRouter.post(
  '/characters/:id/accept',
  wrap((req, res) => {
    res.json({
      character: setCharacterStatus(stringParam(req.params.id, 'character id'), 'active'),
    });
  }),
);

charactersRouter.post(
  '/characters/:id/archive',
  wrap((req, res) => {
    res.json({
      character: setCharacterStatus(stringParam(req.params.id, 'character id'), 'archived'),
    });
  }),
);

charactersRouter.post(
  '/projects/:id/characters/propose',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.status(202).json({ job: startCharacterProposal(projectId) });
  }),
);
