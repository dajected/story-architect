import type { ConnectionKind, ModelOption, ModelProviderOption, TokenUsage } from '../shared/types.js';
import { prepareRequest } from './request-context.js';
import type { PreparedRequest, RequestMessage } from './request-context.js';

export interface ProviderConnection {
  id: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  apiKey: string | null;
  models?: ModelOption[];
  providerSlug?: string | null;
}

export interface ProviderMessage extends RequestMessage {}

export interface ChatParams {
  model: string;
  messages: ProviderMessage[];
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  inputBudgetTokens?: number;
  sessionId?: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onPrepared?: (request: PreparedRequest) => void;
}

export interface ChatUsage extends TokenUsage {}

/** Stable across chapter jobs and retries, with separate affinity for each role. */
export function generationSessionId(projectId: string, role: string): string {
  const taskRole = ({ chapter: 'prose', chat: 'prose', rewrite: 'prose', review: 'memory', characters: 'memory' } as Record<string, string>)[role] ?? role;
  return `story-architect:${projectId}:${taskRole}`;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage | null;
  finishReason: string | null;
}

export class ProviderError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function chatEndpoint(baseUrl: string): string {
  const base = normaliseBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function modelsEndpoint(baseUrl: string): string {
  const base = normaliseBaseUrl(baseUrl);
  if (/\/models$/i.test(base)) return base;
  return `${base}/models`;
}

function headers(connection: ProviderConnection): Record<string, string> {
  const result: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (connection.apiKey) {
    result.Authorization = `Bearer ${connection.apiKey}`;
  }
  if (connection.kind === 'openrouter') {
    result['HTTP-Referer'] = process.env.PUBLIC_URL || 'https://story-architect.local';
    result['X-Title'] = 'Story Architect';
  }
  return result;
}

function errorSnippet(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  const withoutMarkup = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return withoutMarkup.slice(0, 400);
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return;
  let body = '';
  try {
    body = await response.text();
  } catch {
    // Ignore body read errors.
  }
  const detail = errorSnippet(body);
  throw new ProviderError(
    `Provider returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${
      detail ? `: ${detail}` : ''
    }`,
    response.status,
  );
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          if (typeof record.text === 'string') return record.text;
          if (typeof record.content === 'string') return record.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

export async function streamChat(connection: ProviderConnection, params: ChatParams): Promise<ChatResult> {
  const model = connection.models?.find((entry) => entry.id === params.model);
  const prepared = prepareRequest(params.messages, {
    contextLength: model?.contextLength,
    maxOutputTokens: model?.maxOutputTokens,
    maxTokens: params.maxTokens,
    inputBudgetTokens: params.inputBudgetTokens,
  });
  params.onPrepared?.(prepared);
  const body: Record<string, unknown> = {
    model: params.model,
    messages: prepared.messages,
    stream: true,
  };
  if (params.temperature !== null) body.temperature = params.temperature;
  if (params.topP !== null) body.top_p = params.topP;
  body.max_tokens = prepared.maxTokens;
  if (connection.kind === 'openrouter') {
    body.stream_options = { include_usage: true };
    if (params.sessionId) body.session_id = params.sessionId;
    if (connection.providerSlug) {
      body.provider = { only: [connection.providerSlug], allow_fallbacks: false };
    }
  }

  const response = await fetch(chatEndpoint(connection.baseUrl), {
    method: 'POST',
    headers: headers(connection),
    body: JSON.stringify(body),
    signal: params.signal,
  });
  await ensureOk(response);
  if (!response.body) {
    throw new ProviderError('Provider returned an empty response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: ChatUsage | null = null;
  let finishReason: string | null = null;
  let done = false;
  const providers = new Set<string>();

  const processLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (chunk.error) {
      const error = chunk.error as Record<string, unknown> | string;
      const message = typeof error === 'string' ? error : String(error.message ?? 'Provider error');
      throw new ProviderError(message);
    }
    if (typeof chunk.provider === 'string') providers.add(chunk.provider);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const record = choice as Record<string, unknown>;
      if (typeof record.finish_reason === 'string') finishReason = record.finish_reason;
      const delta = record.delta as Record<string, unknown> | undefined;
      const text = extractText(delta?.content ?? record.text);
      if (text) {
        content += text;
        params.onDelta(text);
      }
    }
    if (chunk.usage && typeof chunk.usage === 'object') {
      const raw = chunk.usage as Record<string, unknown>;
      const promptDetails = raw.prompt_tokens_details as Record<string, unknown> | undefined;
      const completionDetails = raw.completion_tokens_details as Record<string, unknown> | undefined;
      const values = {
        promptTokens: raw.prompt_tokens,
        completionTokens: raw.completion_tokens,
        totalTokens: raw.total_tokens,
        reasoningTokens: completionDetails?.reasoning_tokens,
        cachedPromptTokens: promptDetails?.cached_tokens ?? raw.prompt_cache_hit_tokens,
        cacheWriteTokens: promptDetails?.cache_write_tokens ?? raw.cache_creation_input_tokens,
        cost: connection.kind === 'openrouter' ? raw.cost : undefined,
      };
      usage = { ...(usage ?? {}) };
      for (const [key, value] of Object.entries(values)) {
        const number = numberOrUndefined(value);
        if (number !== undefined && number >= 0) Object.assign(usage, { [key]: number });
      }
    }
  };

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) processLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    }
    if (buffer.trim()) processLine(buffer.replace(/\r$/, ''));
  } finally {
    reader.releaseLock();
  }

  const resolvedUsage = usage as ChatUsage | null;
  if (!resolvedUsage || !Object.keys(resolvedUsage).length) {
    return { content, usage: null, finishReason };
  }
  if (providers.size) resolvedUsage.providers = [...providers];
  return { content, usage: resolvedUsage, finishReason };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function fetchModels(
  connection: ProviderConnection,
): Promise<ModelOption[]> {
  const response = await fetch(modelsEndpoint(connection.baseUrl), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
      ...(connection.kind === 'openrouter'
        ? {
            'HTTP-Referer': process.env.PUBLIC_URL || 'https://story-architect.local',
            'X-Title': 'Story Architect',
          }
        : {}),
    },
  });
  await ensureOk(response);
  const data = (await response.json()) as unknown;
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).data)
      ? ((data as Record<string, unknown>).data as unknown[])
      : [];

  const models: ModelOption[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      models.push({ id: entry, name: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    if (!id) continue;
    const pricing = (record.pricing ?? null) as Record<string, unknown> | null;
    const topProvider = record.top_provider as Record<string, unknown> | undefined;
    models.push({
      id,
      name: typeof record.name === 'string' ? record.name : id,
      contextLength:
        typeof record.context_length === 'number'
          ? record.context_length
          : typeof record.contextLength === 'number'
            ? record.contextLength
            : undefined,
      promptPrice: typeof pricing?.prompt === 'string' ? pricing.prompt : undefined,
      completionPrice: typeof pricing?.completion === 'string' ? pricing.completion : undefined,
      promptCacheReadPrice: typeof pricing?.input_cache_read === 'string' ? pricing.input_cache_read : undefined,
      promptCacheWritePrice: typeof pricing?.input_cache_write === 'string' ? pricing.input_cache_write : undefined,
      maxOutputTokens: numberOrUndefined(topProvider?.max_completion_tokens ?? record.max_output_tokens),
    });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export async function fetchModelProviders(
  connection: ProviderConnection,
  model: string,
): Promise<ModelProviderOption[]> {
  const modelPath = model.split('/').map((part) => encodeURIComponent(part)).join('/');
  const response = await fetch(`${normaliseBaseUrl(connection.baseUrl)}/models/${modelPath}/endpoints`, {
    method: 'GET',
    headers: {
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
      ...headers(connection),
      Accept: 'application/json',
    },
  });
  await ensureOk(response);
  const payload = (await response.json()) as Record<string, unknown>;
  const data = payload.data as Record<string, unknown> | undefined;
  const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];
  const options = new Map<string, ModelProviderOption>();
  for (const value of endpoints) {
    if (!value || typeof value !== 'object') continue;
    const endpoint = value as Record<string, unknown>;
    const slug =
      typeof endpoint.provider_slug === 'string'
        ? endpoint.provider_slug
        : typeof endpoint.tag === 'string'
          ? endpoint.tag
          : null;
    const name = typeof endpoint.provider_name === 'string' ? endpoint.provider_name : slug;
    if (slug && name) options.set(slug, { slug, name });
  }
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function testConnection(
  connection: ProviderConnection,
): Promise<{ ok: boolean; message: string; models: ModelOption[] }> {
  const startedAt = Date.now();
  try {
    const models = await fetchModels(connection);
    return {
      ok: true,
      message: `Connected in ${Date.now() - startedAt} ms. ${models.length} model${
        models.length === 1 ? '' : 's'
      } discovered.`,
      models,
    };
  } catch (modelError) {
    // Some OpenAI-compatible servers do not implement /models. Fall back to a tiny completion.
    try {
      const response = await fetch(chatEndpoint(connection.baseUrl), {
        method: 'POST',
        headers: { ...headers(connection), Accept: 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_tokens: 1,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) {
        return {
          ok: true,
          message: `Connected in ${Date.now() - startedAt} ms. This endpoint does not expose a model list; enter model IDs manually.`,
          models: [],
        };
      }
      await ensureOk(response);
    } catch (chatError) {
      const first = modelError instanceof Error ? modelError.message : String(modelError);
      const second = chatError instanceof Error ? chatError.message : String(chatError);
      return {
        ok: false,
        message: `Could not reach the endpoint. Model list: ${first} Completion test: ${second}`,
        models: [],
      };
    }
  }
  return { ok: false, message: 'Connection test did not complete.', models: [] };
}
