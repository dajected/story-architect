import crypto from 'node:crypto';
import type {
  ImageConnectionKind,
  ImageConnectionPublic,
  ImageProviderSettings,
} from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { decryptSecret, encryptSecret } from '../crypto.js';

export interface ImageConnectionRow {
  id: string;
  name: string;
  kind: ImageConnectionKind;
  base_url: string;
  api_key: string | null;
  settings: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderImageConnection {
  id: string;
  name: string;
  kind: ImageConnectionKind;
  baseUrl: string;
  apiKey: string | null;
  settings: ImageProviderSettings;
}

export interface ImageConnectionInput {
  name: string;
  kind: ImageConnectionKind;
  baseUrl: string;
  apiKey?: string | null;
  settings?: ImageProviderSettings;
}

const OPENAI_KEYS: Array<keyof ImageProviderSettings> = ['model', 'size', 'quality'];
const COMFY_KEYS: Array<keyof ImageProviderSettings> = [
  'workflow',
  'promptNode',
  'promptInput',
  'negativeNode',
  'negativeInput',
  'seedNode',
  'seedInput',
  'outputNode',
  'referenceNode',
  'referenceInput',
  'timeoutSeconds',
];

function parseSettings(raw: string | null | undefined): ImageProviderSettings {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ImageProviderSettings)
      : {};
  } catch {
    return {};
  }
}

function mapConnection(row: ImageConnectionRow): ImageConnectionPublic {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    hasApiKey: Boolean(row.api_key),
    settings: parseSettings(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listImageConnections(): ImageConnectionPublic[] {
  const rows = dbAll<ImageConnectionRow>(
    'SELECT * FROM image_connections ORDER BY name COLLATE NOCASE',
  );
  return rows.map(mapConnection);
}

export function getImageConnectionRow(id: string): ImageConnectionRow {
  const row = dbGet<ImageConnectionRow>('SELECT * FROM image_connections WHERE id = ?', id);
  if (!row) throw notFound('Image connection not found.');
  return row;
}

export function getImageConnection(id: string): ImageConnectionPublic {
  return mapConnection(getImageConnectionRow(id));
}

export function getProviderImageConnection(id: string): ProviderImageConnection {
  const row = getImageConnectionRow(id);
  let apiKey: string | null = null;
  try {
    apiKey = decryptSecret(row.api_key);
  } catch (error) {
    throw badRequest(
      error instanceof Error
        ? `The stored API key for "${row.name}" could not be read. Re-enter it in Settings. (${error.message})`
        : 'The stored API key could not be read.',
    );
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKey,
    settings: parseSettings(row.settings),
  };
}

export function createImageConnection(input: ImageConnectionInput): ImageConnectionPublic {
  validateImageConnectionInput(input);
  const id = crypto.randomUUID();
  const at = timestamp();
  const settings = sanitizeImageSettings(input.settings, input.kind, true);
  dbRun(
    `INSERT INTO image_connections (id, name, kind, base_url, api_key, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim(),
    input.kind,
    input.baseUrl.trim().replace(/\/+$/, ''),
    input.apiKey ? encryptSecret(input.apiKey) : null,
    JSON.stringify(settings),
    at,
    at,
  );
  return getImageConnection(id);
}

export function updateImageConnection(
  id: string,
  input: Partial<ImageConnectionInput>,
): ImageConnectionPublic {
  const existing = getImageConnectionRow(id);
  const name = input.name?.trim() ?? existing.name;
  const kind = input.kind ?? existing.kind;
  const baseUrl = (input.baseUrl ?? existing.base_url).trim().replace(/\/+$/, '');
  validateImageConnectionInput({ name, kind, baseUrl });

  const settings =
    input.settings === undefined
      ? parseSettings(existing.settings)
      : sanitizeImageSettings(input.settings, kind, true);

  let apiKey = existing.api_key;
  if (input.apiKey !== undefined) {
    apiKey = input.apiKey ? encryptSecret(input.apiKey) : null;
  }

  dbRun(
    `UPDATE image_connections SET name = ?, kind = ?, base_url = ?, api_key = ?, settings = ?,
       updated_at = ? WHERE id = ?`,
    name,
    kind,
    baseUrl,
    apiKey,
    JSON.stringify(settings),
    timestamp(),
    id,
  );
  return getImageConnection(id);
}

export function deleteImageConnection(id: string): void {
  getImageConnectionRow(id);
  dbRun('DELETE FROM image_connections WHERE id = ?', id);
}

export function sanitizeImageSettings(
  input: ImageProviderSettings | undefined,
  kind: ImageConnectionKind,
  applyDefaults = false,
): ImageProviderSettings {
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    throw badRequest('Image settings must be an object.');
  }
  const source = input ?? {};
  const allowed = kind === 'openai-images' ? OPENAI_KEYS : COMFY_KEYS;
  const output: ImageProviderSettings = {};

  for (const key of allowed) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (key === 'timeoutSeconds') {
      const seconds = Number(value);
      if (!Number.isFinite(seconds)) continue;
      output.timeoutSeconds = Math.max(10, Math.min(1800, Math.round(seconds)));
      continue;
    }
    if (key === 'workflow') {
      if (typeof value === 'string') {
        if (value.trim()) output.workflow = value.trim();
      } else if (value && typeof value === 'object') {
        // Accept an already-parsed workflow object from API clients.
        output.workflow = JSON.stringify(value);
      }
      continue;
    }
    if (typeof value === 'string') {
      if (value.trim()) (output as Record<string, unknown>)[key] = value.trim();
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      (output as Record<string, unknown>)[key] = String(value);
    }
  }

  if (kind === 'openai-images') {
    if (applyDefaults) {
      output.model = output.model || 'gpt-image-1';
      output.size = output.size || '1024x1024';
    }
    return output;
  }

  if (applyDefaults) {
    output.promptInput = output.promptInput || 'text';
    output.negativeInput = output.negativeInput || 'text';
    output.seedInput = output.seedInput || 'seed';
    output.timeoutSeconds = output.timeoutSeconds ?? 300;
  }

  if (output.workflow) {
    let workflow: unknown;
    try {
      workflow = JSON.parse(output.workflow);
    } catch {
      throw badRequest('The ComfyUI workflow must be valid JSON in API format.');
    }
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
      throw badRequest('The ComfyUI workflow must be a JSON object keyed by node ID.');
    }
    if (!output.promptNode) {
      throw badRequest('Set the ComfyUI node ID that receives the prompt.');
    }
  }

  return output;
}

export function validateImageConnectionInput(input: ImageConnectionInput): void {
  if (!input.name?.trim()) throw badRequest('Connection name is required.');
  if (input.kind !== 'openai-images' && input.kind !== 'comfyui') {
    throw badRequest('Image connection type must be openai-images or comfyui.');
  }
  if (!/^https?:\/\//i.test(input.baseUrl?.trim() ?? '')) {
    throw badRequest('Base URL must start with http:// or https://.');
  }
}
