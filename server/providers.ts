import type { ConnectionKind, ModelOption } from '../shared/types.js';

export interface ProviderConnection {
  id: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  apiKey: string | null;
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  model: string;
  messages: ProviderMessage[];
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage | null;
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
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream: true,
  };
  if (params.temperature !== null) body.temperature = params.temperature;
  if (params.topP !== null) body.top_p = params.topP;
  if (params.maxTokens !== null) body.max_tokens = params.maxTokens;
  if (connection.kind === 'openrouter') {
    body.stream_options = { include_usage: true };
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
  let done = false;

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
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const record = choice as Record<string, unknown>;
      const delta = record.delta as Record<string, unknown> | undefined;
      const text = extractText(delta?.content ?? record.text);
      if (text) {
        content += text;
        params.onDelta(text);
      }
    }
    if (chunk.usage && typeof chunk.usage === 'object') {
      const raw = chunk.usage as Record<string, unknown>;
      usage = {
        promptTokens: numberOrUndefined(raw.prompt_tokens),
        completionTokens: numberOrUndefined(raw.completion_tokens),
        totalTokens: numberOrUndefined(raw.total_tokens),
      };
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
  if (!resolvedUsage || resolvedUsage.promptTokens === undefined || resolvedUsage.completionTokens === undefined) {
    return { content, usage: null };
  }
  return { content, usage: resolvedUsage };
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
    });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
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
