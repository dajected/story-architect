import { Router } from 'express';
import { z } from 'zod';
import type { RoleAssignment } from '../../shared/types.js';
import { TASK_ROLES } from '../../shared/types.js';
import {
  createConnection,
  deleteConnection,
  getProviderConnection,
  listConnections,
  saveConnectionModels,
  updateConnection,
} from '../store/connections.js';
import {
  getGlobalSettings,
  getRoleAssignments,
  resolveRoles,
  setRoleAssignments,
  updateGlobalSettings,
} from '../store/settings.js';
import {
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
  setDefaultPromptTemplate,
  updatePromptTemplate,
} from '../store/templates.js';
import { fetchModels, testConnection } from '../providers.js';
import { suggestProjectField } from '../generation.js';
import { AppError, badRequest, errorMessage } from '../errors.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const settingsRouter = Router();

const connectionSchema = z.object({
  name: z.string().min(1, 'Connection name is required.').max(120),
  kind: z.enum(['openrouter', 'openai-compatible']),
  baseUrl: z.string().min(1, 'Base URL is required.').max(2000),
  apiKey: z.string().max(10000).nullable().optional(),
});

settingsRouter.get('/connections', (_req, res) => {
  res.json({ connections: listConnections() });
});

settingsRouter.post(
  '/connections',
  wrap((req, res) => {
    const input = parseBody(connectionSchema, req.body);
    res.status(201).json({ connection: createConnection(input) });
  }),
);

settingsRouter.patch(
  '/connections/:id',
  wrap((req, res) => {
    const id = stringParam(req.params.id, 'connection id');
    const input = parseBody(connectionSchema.partial(), req.body);
    res.json({ connection: updateConnection(id, input) });
  }),
);

settingsRouter.delete(
  '/connections/:id',
  wrap((req, res) => {
    deleteConnection(stringParam(req.params.id, 'connection id'));
    res.status(204).end();
  }),
);

settingsRouter.post(
  '/connections/:id/test',
  wrap(async (req, res) => {
    const id = stringParam(req.params.id, 'connection id');
    const connection = getProviderConnection(id);
    const result = await testConnection(connection);
    if (result.ok && result.models.length > 0) {
      saveConnectionModels(id, result.models);
    }
    res.json(result);
  }),
);

settingsRouter.post(
  '/connections/:id/refresh-models',
  wrap(async (req, res) => {
    const id = stringParam(req.params.id, 'connection id');
    const connection = getProviderConnection(id);
    try {
      const models = await fetchModels(connection);
      const updated = saveConnectionModels(id, models);
      res.json({ connection: updated, models });
    } catch (error) {
      throw new AppError(502, `Could not fetch models: ${errorMessage(error)}`);
    }
  }),
);

settingsRouter.get('/settings', (_req, res) => {
  res.json({
    generation: getGlobalSettings().generation,
    roles: resolveRoles(),
    assignments: getRoleAssignments('global'),
  });
});

settingsRouter.patch(
  '/settings',
  wrap((req, res) => {
    const body = parseBody(
      z.object({ generation: z.record(z.string(), z.unknown()).optional() }),
      req.body,
    );
    const settings = updateGlobalSettings({
      generation: body.generation as never,
    });
    res.json({ generation: settings.generation, roles: resolveRoles() });
  }),
);

const assignmentSchema = z.object({
  scope: z.enum(['global', 'project']),
  projectId: z.string().optional(),
  assignments: z.array(
    z.object({
      role: z.enum(TASK_ROLES as [string, ...string[]]),
      connectionId: z.string().nullable(),
      model: z.string().nullable(),
    }),
  ),
});

settingsRouter.get(
  '/model-roles',
  wrap((req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json({
      roles: resolveRoles(projectId),
      assignments: getRoleAssignments(projectId ? 'project' : 'global', projectId ?? ''),
    });
  }),
);

settingsRouter.put(
  '/model-roles',
  wrap((req, res) => {
    const body = parseBody(assignmentSchema, req.body);
    if (body.scope === 'project' && !body.projectId) {
      throw badRequest('projectId is required for project role assignments.');
    }
    setRoleAssignments(
      body.scope,
      body.scope === 'project' ? body.projectId! : '',
      body.assignments as RoleAssignment[],
    );
    res.json({
      roles: resolveRoles(body.scope === 'project' ? body.projectId : undefined),
      assignments: getRoleAssignments(body.scope, body.scope === 'project' ? body.projectId! : ''),
    });
  }),
);

const templateSchema = z.object({
  projectId: z.string().nullable().optional(),
  kind: z.enum(['outline', 'prose']),
  name: z.string().min(1, 'Template name is required.').max(200),
  content: z.string().min(1, 'Template content is required.').max(100000),
  isDefault: z.boolean().optional(),
});

settingsRouter.get(
  '/templates',
  wrap((req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json({ templates: listPromptTemplates(projectId) });
  }),
);

settingsRouter.post(
  '/templates',
  wrap((req, res) => {
    const input = parseBody(templateSchema, req.body);
    res.status(201).json({
      template: createPromptTemplate({
        projectId: input.projectId ?? null,
        kind: input.kind,
        name: input.name,
        content: input.content,
        isDefault: input.isDefault,
      }),
    });
  }),
);

settingsRouter.patch(
  '/templates/:id',
  wrap((req, res) => {
    const id = stringParam(req.params.id, 'template id');
    const input = parseBody(
      z.object({
        name: z.string().min(1).max(200).optional(),
        content: z.string().min(1).max(100000).optional(),
        isDefault: z.boolean().optional(),
      }),
      req.body,
    );
    res.json({ template: updatePromptTemplate(id, input) });
  }),
);

settingsRouter.post(
  '/templates/:id/default',
  wrap((req, res) => {
    res.json({ template: setDefaultPromptTemplate(stringParam(req.params.id, 'template id')) });
  }),
);

settingsRouter.delete(
  '/templates/:id',
  wrap((req, res) => {
    deletePromptTemplate(stringParam(req.params.id, 'template id'));
    res.status(204).end();
  }),
);

settingsRouter.post(
  '/suggest',
  wrap(async (req, res) => {
    const body = parseBody(
      z.object({
        field: z.string().min(1),
        draft: z.record(z.string(), z.string()).optional(),
        currentChapterCount: z.number().optional(),
      }),
      req.body,
    );
    const value = await suggestProjectField({
      field: body.field,
      draft: body.draft ?? {},
      currentChapterCount: body.currentChapterCount,
    });
    res.json({ value });
  }),
);
