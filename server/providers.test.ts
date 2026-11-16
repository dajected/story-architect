import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModels, generationSessionId, streamChat } from './providers.js';

afterEach(() => vi.unstubAllGlobals());

describe('stream finish reasons', () => {
  it('keeps cache usage and reported cost across streamed usage updates, with stable OpenRouter affinity', async () => {
    const events = [
      { provider: 'DeepInfra', choices: [], usage: { prompt_tokens: 3000, completion_tokens: 100, total_tokens: 3100,
        prompt_tokens_details: { cached_tokens: 2048, cache_write_tokens: 512 } } },
      { choices: [], usage: { cost: 0 } },
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    )));
    vi.stubGlobal('fetch', fetchMock);
    const params = { model: 'deepseek/flash', sessionId: generationSessionId('novel', 'chapter'),
      messages: [{ role: 'user' as const, content: 'Chapter 1' }], maxTokens: 1000, temperature: null, topP: null,
      signal: new AbortController().signal, onDelta: () => {} };
    const connection = { id: 'or', name: 'OpenRouter', kind: 'openrouter' as const, baseUrl: 'https://example.invalid/v1', apiKey: null };
    const result = await streamChat(connection, params);
    await streamChat(connection, { ...params, messages: [{ role: 'user', content: 'Chapter 2' }] });
    expect(result.usage).toEqual({ promptTokens: 3000, completionTokens: 100, totalTokens: 3100,
      cachedPromptTokens: 2048, cacheWriteTokens: 512, cost: 0, providers: ['DeepInfra'] });
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies.map((body) => body.session_id)).toEqual([params.sessionId, params.sessionId]);
    expect(generationSessionId('novel', 'rewrite')).toBe(params.sessionId);
    expect(generationSessionId('other', 'chapter')).not.toBe(params.sessionId);
    expect(generationSessionId('novel', 'memory')).not.toBe(params.sessionId);
    await streamChat({ ...connection, kind: 'openai-compatible' }, params);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('session_id');
  });

  it('preserves cache prices when discovering models', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'flash',
      pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000001', input_cache_write: '0.000001' },
    }] }))));
    const models = await fetchModels({ id: 'or', name: 'OR', kind: 'openrouter', baseUrl: 'https://example.invalid', apiKey: null });
    expect(models[0]).toMatchObject({ promptCacheReadPrice: '0.0000001', promptCacheWritePrice: '0.000001' });
  });

  it('retains reasoning-token usage within completion usage', async () => {
    const body = [
      { choices: [{ delta: { content: 'Summary.' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 3000, completion_tokens: 1100, total_tokens: 4100,
        completion_tokens_details: { reasoning_tokens: 900 } } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const result = await streamChat({ id: 'local', name: 'Local', kind: 'openai-compatible',
      baseUrl: 'http://localhost/v1', apiKey: null }, {
      model: 'test', messages: [], maxTokens: 4096, temperature: null, topP: null,
      signal: new AbortController().signal, onDelta: () => {},
    });
    expect(result.usage).toEqual({ promptTokens: 3000, completionTokens: 1100, totalTokens: 4100, reasoningTokens: 900 });
  });

  it('rejects an oversized complete request before contacting the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(streamChat({
      id: 'local', name: 'Local', kind: 'openai-compatible', baseUrl: 'http://localhost/v1', apiKey: null,
      models: [{ id: 'small-model', name: 'Small', contextLength: 4000 }],
    }, {
      model: 'small-model', messages: [{ role: 'user', content: 'essential '.repeat(3000) }],
      temperature: null, topP: null, maxTokens: 1000,
      signal: new AbortController().signal, onDelta: () => {},
    })).rejects.toThrow(/essential instructions and task input/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['length', 'max_tokens', 'stop', null])(
    'preserves finish reason %s even when usage is absent', async (finishReason) => {
      const events = [
        { choices: [{ delta: { content: 'Partial chapter' } }] },
        { choices: [{ delta: {}, finish_reason: finishReason }] },
      ];
      const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
      const onDelta = vi.fn();
      const result = await streamChat({
        id: 'local', name: 'Local', kind: 'openai-compatible', baseUrl: 'http://localhost/v1', apiKey: null,
      }, {
        model: 'test', messages: [], temperature: null, topP: null, maxTokens: 1000,
        signal: new AbortController().signal, onDelta,
      });
      expect(result).toEqual({ content: 'Partial chapter', usage: null, finishReason });
      expect(onDelta).toHaveBeenCalledWith('Partial chapter');
    },
  );
});
