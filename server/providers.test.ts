import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from './providers.js';

afterEach(() => vi.unstubAllGlobals());

describe('stream finish reasons', () => {
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
