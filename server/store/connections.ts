import crypto from 'node:crypto';
import type { ConnectionKind, ConnectionPublic, JobPricing, ModelOption } from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { ProviderConnection } from '../providers.js';

interface ConnectionRow {
  id: string;
  name: string;
  kind: ConnectionKind;
  base_url: string;
  api_key: string | null;
  models: string;
  models_fetched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionInput {
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  apiKey?: string | null;
}

function parseModels(raw: string): ModelOption[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ModelOption[]) : [];
  } catch {
    return [];
  }
}

export function mapConnection(row: ConnectionRow): ConnectionPublic {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    hasApiKey: Boolean(row.api_key),
    models: parseModels(row.models),
    modelsFetchedAt: row.models_fetched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listConnections(): ConnectionPublic[] {
  const rows = dbAll<ConnectionRow>('SELECT * FROM connections ORDER BY name COLLATE NOCASE');
  return rows.map(mapConnection);
}

export function getConnectionRow(id: string): ConnectionRow {
  const row = dbGet<ConnectionRow>('SELECT * FROM connections WHERE id = ?', id);
  if (!row) throw notFound('Connection not found.');
  return row;
}

export function listPublicConnections(): ConnectionPublic[] {
  return listConnections();
}

export function getProviderConnection(id: string): ProviderConnection {
  const row = getConnectionRow(id);
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
    models: parseModels(row.models),
  };
}

export function createConnection(input: ConnectionInput): ConnectionPublic {
  validateConnectionInput(input);
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO connections (id, name, kind, base_url, api_key, models, models_fetched_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, ?)`,
    id,
    input.name.trim(),
    input.kind,
    input.baseUrl.trim().replace(/\/+$/, ''),
    input.apiKey ? encryptSecret(input.apiKey) : null,
    at,
    at,
  );
  return mapConnection(getConnectionRow(id));
}

export function updateConnection(id: string, input: Partial<ConnectionInput>): ConnectionPublic {
  const existing = getConnectionRow(id);
  const name = input.name?.trim() ?? existing.name;
  const kind = input.kind ?? existing.kind;
  const baseUrl = (input.baseUrl ?? existing.base_url).trim().replace(/\/+$/, '');
  validateConnectionInput({ name, kind, baseUrl });

  let apiKey = existing.api_key;
  if (input.apiKey !== undefined) {
    apiKey = input.apiKey ? encryptSecret(input.apiKey) : null;
  }

  dbRun(
    `UPDATE connections SET name = ?, kind = ?, base_url = ?, api_key = ?, updated_at = ? WHERE id = ?`,
    name,
    kind,
    baseUrl,
    apiKey,
    timestamp(),
    id,
  );
  return mapConnection(getConnectionRow(id));
}

function validateConnectionInput(input: ConnectionInput): void {
  if (!input.name?.trim()) throw badRequest('Connection name is required.');
  if (input.kind !== 'openrouter' && input.kind !== 'openai-compatible') {
    throw badRequest('Connection type must be openrouter or openai-compatible.');
  }
  if (!/^https?:\/\//i.test(input.baseUrl?.trim() ?? '')) {
    throw badRequest('Base URL must start with http:// or https://.');
  }
}

export function deleteConnection(id: string): void {
  getConnectionRow(id);
  dbRun('DELETE FROM connections WHERE id = ?', id);
}

export function saveConnectionModels(id: string, models: ModelOption[]): ConnectionPublic {
  getConnectionRow(id);
  dbRun(
    'UPDATE connections SET models = ?, models_fetched_at = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(models),
    timestamp(),
    timestamp(),
    id,
  );
  return mapConnection(getConnectionRow(id));
}

export function connectionName(id: string | null): string | null {
  if (!id) return null;
  const row = dbGet<{ name: string }>('SELECT name FROM connections WHERE id = ?', id);
  return row?.name ?? null;
}

export function modelContextLength(connectionId: string, model: string): number | null {
  try {
    const row = getConnectionRow(connectionId);
    const entry = parseModels(row.models).find((option) => option.id === model);
    const length = entry?.contextLength;
    return typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
}

export function modelOutputLimit(connectionId: string, model: string): number | undefined {
  const entry = parseModels(getConnectionRow(connectionId).models).find((option) => option.id === model);
  const limit = entry?.maxOutputTokens;
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

function pricePerToken(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

/**
 * Cached per-token pricing for a model. OpenRouter publishes prices on its
 * model list; most OpenAI-compatible endpoints do not, so this is usually null.
 */
export function modelPricing(
  connectionId: string,
  model: string,
): JobPricing | null {
  try {
    const row = getConnectionRow(connectionId);
    const entry = parseModels(row.models).find((option) => option.id === model);
    const prompt = pricePerToken(entry?.promptPrice);
    const completion = pricePerToken(entry?.completionPrice);
    const cacheRead = pricePerToken(entry?.promptCacheReadPrice);
    const cacheWrite = pricePerToken(entry?.promptCacheWritePrice);
    if (prompt === null && completion === null) return null;
    return {
      promptPerToken: prompt ?? 0,
      completionPerToken: completion ?? 0,
      ...(cacheRead !== null ? { cacheReadPerToken: cacheRead } : {}),
      ...(cacheWrite !== null ? { cacheWritePerToken: cacheWrite } : {}),
      currency: 'USD',
    };
  } catch {
    return null;
  }
}
