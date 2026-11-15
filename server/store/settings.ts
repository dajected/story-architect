import type {
  ContextPreset,
  GenerationSettings,
  GlobalSettings,
  ResolvedRole,
  RoleAssignment,
  TaskRole,
} from '../../shared/types.js';
import { CONTEXT_PRESETS, DEFAULT_GENERATION, TASK_ROLES } from '../../shared/types.js';
import { normalizeGenerationSettings } from '../../shared/utils.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { getConnectionRow, getProviderConnection } from './connections.js';
import type { ProviderConnection } from '../providers.js';

interface SettingRow {
  value: string;
}

interface RoleRow {
  role: TaskRole;
  connection_id: string | null;
  model: string | null;
  provider_slug: string | null;
}

interface ProjectRowForSettings {
  target_chapter_words: number | null;
}

function parseJson<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function getGlobalSettings(): GlobalSettings {
  const row = dbGet<SettingRow>('SELECT value FROM settings WHERE key = ?', 'global');
  const parsed = parseJson<Partial<GlobalSettings>>(row?.value, {});
  return {
    generation: normalizeGenerationSettings(parsed.generation, DEFAULT_GENERATION),
  };
}

export function updateGlobalSettings(input: { generation?: Partial<GenerationSettings> }): GlobalSettings {
  const current = getGlobalSettings();
  const generation = normalizeGenerationSettings(
    { ...current.generation, ...sanitizeGenerationInput(input.generation) },
    DEFAULT_GENERATION,
  );
  validateGeneration(generation);
  dbRun(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    'global',
    JSON.stringify({ generation }),
  );
  return { generation };
}

function sanitizeGenerationInput(
  input: Partial<GenerationSettings> | undefined,
): Partial<GenerationSettings> {
  if (!input) return {};
  const output: Partial<GenerationSettings> = {};
  if (input.temperature !== undefined) {
    output.temperature = input.temperature === null ? null : Number(input.temperature);
  }
  if (input.topP !== undefined) {
    output.topP = input.topP === null ? null : Number(input.topP);
  }
  if (input.maxTokens !== undefined) {
    output.maxTokens = input.maxTokens === null ? null : Math.round(Number(input.maxTokens));
  }
  if (input.targetWords !== undefined) {
    output.targetWords = input.targetWords === null ? null : Math.round(Number(input.targetWords));
  }
  if (input.contextPreset !== undefined) {
    if (!CONTEXT_PRESETS.some((preset) => preset.id === input.contextPreset)) {
      throw badRequest('Unknown context preset.');
    }
    output.contextPreset = input.contextPreset;
  }
  return output;
}

function validateGeneration(settings: GenerationSettings): void {
  if (settings.temperature !== null && (settings.temperature < 0 || settings.temperature > 2)) {
    throw badRequest('Temperature must be between 0 and 2.');
  }
  if (settings.topP !== null && (settings.topP < 0 || settings.topP > 1)) {
    throw badRequest('Top P must be between 0 and 1.');
  }
  if (settings.maxTokens !== null && (settings.maxTokens < 1 || settings.maxTokens > 200000)) {
    throw badRequest('Max tokens must be between 1 and 200000.');
  }
  if (settings.targetWords !== null && (settings.targetWords < 100 || settings.targetWords > 20000)) {
    throw badRequest('Target words must be between 100 and 20000.');
  }
}

export function getProjectGeneration(projectId: string): GenerationSettings {
  const global = getGlobalSettings();
  const row = dbGet<SettingRow>('SELECT settings AS value FROM project_settings WHERE project_id = ?', projectId);
  const project = parseJson<{ generation?: Partial<GenerationSettings> }>(row?.value, {});
  const projectRow = dbGet<ProjectRowForSettings>(
    'SELECT target_chapter_words FROM projects WHERE id = ?',
    projectId,
  );
  const generation = normalizeGenerationSettings(project.generation, global.generation);
  if (project.generation?.targetWords === undefined && projectRow?.target_chapter_words) {
    generation.targetWords = projectRow.target_chapter_words;
  }
  return generation;
}

export function setProjectSettings(
  projectId: string,
  input: { generation?: Partial<GenerationSettings> },
): GenerationSettings {
  const global = getGlobalSettings();
  const row = dbGet<SettingRow>('SELECT settings AS value FROM project_settings WHERE project_id = ?', projectId);
  const current = parseJson<{ generation?: Partial<GenerationSettings> }>(row?.value, {});
  const generation = {
    ...(current.generation ?? {}),
    ...sanitizeGenerationInput(input.generation),
  };
  const resolved = normalizeGenerationSettings(generation, global.generation);
  validateGeneration(resolved);
  dbRun(
    `INSERT INTO project_settings (project_id, settings) VALUES (?, ?)
     ON CONFLICT(project_id) DO UPDATE SET settings = excluded.settings`,
    projectId,
    JSON.stringify({ ...current, generation }),
  );
  return getProjectGeneration(projectId);
}

export function projectGenerationSources(projectId: string): Record<string,string> {
  const row = dbGet<SettingRow>('SELECT settings AS value FROM project_settings WHERE project_id = ?', projectId);
  const settings = parseJson<{generation?: Partial<GenerationSettings>}>(row?.value, {});
  const story = dbGet<{target_chapter_words:number | null}>('SELECT target_chapter_words FROM projects WHERE id = ?', projectId);
  return Object.fromEntries(Object.keys(DEFAULT_GENERATION).map(key => [key, settings.generation?.[key as keyof GenerationSettings] !== undefined ? 'Project override' : key === 'targetWords' && story?.target_chapter_words ? 'Story setup' : 'Global default']));
}

export function resetProjectGeneration(projectId: string): void {
  const row = dbGet<SettingRow>('SELECT settings AS value FROM project_settings WHERE project_id = ?', projectId);
  const current = parseJson<Record<string,unknown>>(row?.value, {});
  delete current.generation;
  dbRun('UPDATE project_settings SET settings = ? WHERE project_id = ?', JSON.stringify(current), projectId);
}

export function getProjectVisualStyle(projectId: string): string {
  const row = dbGet<SettingRow>('SELECT settings AS value FROM project_settings WHERE project_id = ?', projectId);
  return parseJson<{visualStyle?:string}>(row?.value, {}).visualStyle ?? '';
}
export function setProjectVisualStyle(projectId: string, visualStyle: string): void {
  const row = dbGet<SettingRow>('SELECT settings AS value FROM project_settings WHERE project_id = ?', projectId);
  const current = parseJson<Record<string,unknown>>(row?.value, {});
  dbRun('INSERT INTO project_settings (project_id, settings) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET settings = excluded.settings',projectId,JSON.stringify({...current,visualStyle}));
}

export function getRoleAssignments(scope: 'global' | 'project', scopeId = ''): RoleAssignment[] {
  const rows = dbAll<RoleRow>(
    'SELECT role, connection_id, model, provider_slug FROM role_assignments WHERE scope = ? AND scope_id = ?',
    scope,
    scopeId,
  );
  return rows.map((row) => ({
    role: row.role,
    connectionId: row.connection_id,
    model: row.model,
    providerSlug: row.provider_slug,
  }));
}

export function setRoleAssignments(
  scope: 'global' | 'project',
  scopeId: string,
  assignments: RoleAssignment[],
): void {
  const seen = new Set<TaskRole>();
  for (const assignment of assignments) {
    if (!TASK_ROLES.includes(assignment.role)) {
      throw badRequest(`Unknown model role: ${String(assignment.role)}`);
    }
    if (seen.has(assignment.role)) {
      throw badRequest(`Duplicate model role: ${assignment.role}`);
    }
    seen.add(assignment.role);

    if (!assignment.connectionId) {
      dbRun(
        'DELETE FROM role_assignments WHERE scope = ? AND scope_id = ? AND role = ?',
        scope,
        scopeId,
        assignment.role,
      );
      continue;
    }
    const connection = getConnectionRow(assignment.connectionId);
    if (assignment.providerSlug && connection.kind !== 'openrouter') {
      throw badRequest('Provider selection is only available for OpenRouter connections.');
    }
    if (!assignment.model?.trim()) {
      throw badRequest('Choose a model for each assigned role, or clear the assignment.');
    }
    dbRun(
      `INSERT INTO role_assignments (scope, scope_id, role, connection_id, model, provider_slug, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id, role)
       DO UPDATE SET connection_id = excluded.connection_id, model = excluded.model, provider_slug = excluded.provider_slug, updated_at = excluded.updated_at`,
      scope,
      scopeId,
      assignment.role,
      assignment.connectionId,
      assignment.model.trim(),
      assignment.providerSlug?.trim() || null,
      timestamp(),
    );
  }
}

interface ResolvedAssignment {
  role: TaskRole;
  connectionId: string;
  model: string;
  providerSlug?: string | null;
  source: 'project' | 'global';
}

function assignmentMaps(projectId?: string): {
  project: Map<TaskRole, ResolvedAssignment>;
  global: Map<TaskRole, ResolvedAssignment>;
} {
  const toMap = (list: RoleAssignment[], source: 'project' | 'global') => {
    const map = new Map<TaskRole, ResolvedAssignment>();
    for (const assignment of list) {
      if (assignment.connectionId && assignment.model) {
        map.set(assignment.role, {
          role: assignment.role,
          connectionId: assignment.connectionId,
          model: assignment.model,
          providerSlug: assignment.providerSlug,
          source,
        });
      }
    }
    return map;
  };
  return {
    project: projectId ? toMap(getRoleAssignments('project', projectId), 'project') : new Map(),
    global: toMap(getRoleAssignments('global'), 'global'),
  };
}

export function resolveRoles(projectId?: string): ResolvedRole[] {
  const { project, global } = assignmentMaps(projectId);
  const defaultAssignment = project.get('default') ?? global.get('default') ?? null;

  return TASK_ROLES.map((role) => {
    const own = project.get(role) ?? global.get(role) ?? null;
    if (own) {
      return {
        role,
        connectionId: own.connectionId,
        model: own.model,
        providerSlug: own.providerSlug ?? null,
        connectionName: connectionNameSafe(own.connectionId),
        source: own.source,
      };
    }
    if (role !== 'default' && defaultAssignment) {
      return {
        role,
        connectionId: defaultAssignment.connectionId,
        model: defaultAssignment.model,
        providerSlug: defaultAssignment.providerSlug ?? null,
        connectionName: connectionNameSafe(defaultAssignment.connectionId),
        source: 'default',
      };
    }
    return {
      role,
      connectionId: null,
      model: null,
      connectionName: null,
      source: 'unset',
    };
  });
}

function connectionNameSafe(connectionId: string): string | null {
  try {
    return getConnectionRow(connectionId).name;
  } catch {
    return null;
  }
}

export function resolveTaskModel(
  projectId: string | null,
  role: Exclude<TaskRole, 'default'>,
): { connectionId: string; model: string; role: TaskRole; provider: ProviderConnection } {
  const resolved = resolveRoles(projectId ?? undefined).find((entry) => entry.role === role);
  if (!resolved || !resolved.connectionId || !resolved.model) {
    const label = role === 'outline' ? 'outline' : role === 'prose' ? 'prose' : role.replace('_', ' ');
    throw new AppError(
      409,
      `No ${label} model is configured. Add a connection and assign a model in Settings before generating.`,
    );
  }
  return {
    connectionId: resolved.connectionId,
    model: resolved.model,
    role,
    provider: {
      ...getProviderConnection(resolved.connectionId),
      providerSlug: resolved.providerSlug ?? null,
    },
  };
}

export function isContextPreset(value: unknown): value is ContextPreset {
  return typeof value === 'string' && CONTEXT_PRESETS.some((preset) => preset.id === value);
}
