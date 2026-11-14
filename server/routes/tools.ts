import { Router } from 'express';
import { z } from 'zod';
import {
  createProseInstruction,
  deleteProseInstruction,
  listProseInstructions,
  updateProseInstruction,
} from '../store/instructions.js';
import { getProject } from '../store/projects.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const toolsRouter = Router();

const instructionCreate = z.object({
  name: z.string().min(1).max(200),
  text: z.string().min(1).max(8000),
});

const instructionUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(8000).optional(),
});

toolsRouter.get(
  '/projects/:id/prose-instructions',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.json({ instructions: listProseInstructions(projectId) });
  }),
);

toolsRouter.post(
  '/projects/:id/prose-instructions',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(instructionCreate, req.body);
    res.status(201).json({ instruction: createProseInstruction(projectId, body) });
  }),
);

toolsRouter.patch(
  '/projects/:id/prose-instructions/:instructionId',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    const body = parseBody(instructionUpdate, req.body);
    res.json({
      instruction: updateProseInstruction(
        projectId,
        stringParam(req.params.instructionId, 'instruction id'),
        body,
      ),
    });
  }),
);

toolsRouter.delete(
  '/projects/:id/prose-instructions/:instructionId',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    deleteProseInstruction(projectId, stringParam(req.params.instructionId, 'instruction id'));
    res.status(204).end();
  }),
);
