import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundReplyTokens, streamBackgroundTask } from './background-generation.js';
import { streamChat } from './providers.js';
import type { ChatParams, ProviderConnection } from './providers.js';

vi.mock('./providers.js', () => ({ streamChat: vi.fn() }));
beforeEach(() => { vi.mocked(streamChat).mockReset(); });
const provider: ProviderConnection = { id: 'local', name: 'Local', kind: 'openai-compatible',
  baseUrl: 'http://localhost/v1', apiKey: null,
  models: [{ id: 'model', name: 'Model', contextLength: 128000, maxOutputTokens: 32000 }],
};
const valid = '{"summary":"Mara entered the observatory.","facts":[]}';
const validate = (content: string) => { try { return !!JSON.parse(content).summary; } catch { return false; } };
function params(controller = new AbortController()): ChatParams {
  return { model: 'model', messages: [
    { role: 'system', content: 'Return a complete JSON summary and facts.' },
    { role: 'user', content: 'Summarise this chapter.', contextParts: [
      { label: 'Chapter', text: 'Chapter evidence. '.repeat(1600), priority: 100, minTokens: 512 },
    ] },
  ], maxTokens: null, temperature: 0.2, topP: null, signal: controller.signal, onDelta: vi.fn() };
}
function reply(content: string, reason: string, reasoningTokens = 100) {
  return async (_provider: ProviderConnection, request: ChatParams) => {
    request.onDelta(content);
    return { content, finishReason: reason, usage: { promptTokens: 3000, completionTokens: 1000,
      totalTokens: 4000, reasoningTokens } };
  };
}

describe('background reply budgeting', () => {
  it('regenerates a complete JSON result after a cutoff without concatenating partial output', async () => {
    vi.mocked(streamChat).mockImplementationOnce(reply('{"summary":"cut off', 'length'))
      .mockImplementationOnce(reply(valid, 'stop'));
    const request = params();
    const onAttempt = vi.fn();
    const result = await streamBackgroundTask(provider, request, { label: 'Memory', validate, onAttempt });
    expect(result.content).toBe(valid);
    expect(vi.mocked(request.onDelta).mock.calls.flat().join('')).toBe(valid);
    expect(vi.mocked(streamChat).mock.calls.map((call) => call[1].maxTokens)).toEqual([4096, 8192]);
    expect(vi.mocked(streamChat).mock.calls[0][1].messages).toEqual(vi.mocked(streamChat).mock.calls[1][1].messages);
    expect(result.usage).toEqual({ promptTokens: 6000, completionTokens: 2000, totalTokens: 8000, reasoningTokens: 200 });
    expect(onAttempt).toHaveBeenCalledTimes(2);
  });

  it('allows reasoning-only cutoffs to retry with more reply capacity', async () => {
    vi.mocked(streamChat).mockImplementationOnce(reply('', 'length', 1000))
      .mockImplementationOnce(reply(valid, 'stop', 400));
    const result = await streamBackgroundTask(provider, params(), { label: 'Memory', validate });
    expect(result.content).toBe(valid);
    expect(result.usage?.reasoningTokens).toBe(1400);
  });

  it('retries malformed JSON even when the provider reports a normal stop', async () => {
    vi.mocked(streamChat).mockImplementationOnce(reply('{"summary":"not closed', 'stop'))
      .mockImplementationOnce(reply(valid, 'stop'));
    expect((await streamBackgroundTask(provider, params(), { label: 'Memory', validate })).content).toBe(valid);
  });

  it('bounds repeated failures and retains only the last partial response', async () => {
    vi.mocked(streamChat).mockImplementation(reply('{"summary":"unfinished', 'length'));
    const request = params();
    const onAttempt = vi.fn();
    await expect(streamBackgroundTask(provider, request, { label: 'Memory', validate, onAttempt }))
      .rejects.toThrow(/after 3 request/);
    expect(vi.mocked(streamChat).mock.calls.map((call) => call[1].maxTokens)).toEqual([4096, 8192, 16384]);
    expect(vi.mocked(request.onDelta).mock.calls.flat().join('')).toBe('{"summary":"unfinished');
    expect(onAttempt.mock.calls.at(-1)?.[1]?.completionTokens).toBe(3000);
  });

  it('respects the model reply cap rather than repeatedly requesting an impossible budget', async () => {
    const capped = { ...provider, models: [{ id: 'model', name: 'Model', contextLength: 32000, maxOutputTokens: 5000 }] };
    vi.mocked(streamChat).mockImplementation(reply('', 'length'));
    await expect(streamBackgroundTask(capped, params(), { label: 'Memory', validate })).rejects.toThrow(/5,000 tokens/);
    expect(vi.mocked(streamChat).mock.calls.map((call) => call[1].maxTokens)).toEqual([4096, 5000]);
  });

  it('retains partial output when a retry is cancelled', async () => {
    const controller = new AbortController();
    vi.mocked(streamChat).mockImplementationOnce(reply('{"summary":"first partial', 'length'))
      .mockImplementationOnce(async (_provider, request) => {
        request.onDelta('{"summary":"second partial');
        controller.abort();
        controller.signal.throwIfAborted();
        throw new Error('unreachable');
      });
    const request = params(controller);
    await expect(streamBackgroundTask(provider, request, { label: 'Memory', validate })).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(request.onDelta).mock.calls.flat().join('')).toBe('{"summary":"second partial');
  });

  it('uses the same bounded policy for an oversized story-state response', async () => {
    vi.mocked(streamChat).mockImplementationOnce(reply('x'.repeat(5000), 'stop'))
      .mockImplementationOnce(reply('Current situation and unresolved threads.', 'stop'));
    const result = await streamBackgroundTask(provider, params(), {
      label: 'Story state', validate: (content) => !!content && content.length <= 4000,
    });
    expect(result.content).toBe('Current situation and unresolved threads.');
    expect(streamChat).toHaveBeenCalledTimes(2);
  });

  it('caps initial reply capacity for small or unknown model windows', () => {
    expect(backgroundReplyTokens(provider, 'model')).toBe(4096);
    expect(backgroundReplyTokens({ ...provider, models: [{ id: 'model', name: 'Small', contextLength: 6000 }] }, 'model')).toBe(2850);
    expect(backgroundReplyTokens({ ...provider, models: [{ id: 'model', name: 'Small', maxOutputTokens: 1000 }] }, 'model')).toBe(1000);
    expect(backgroundReplyTokens({ ...provider, models: [] }, 'model')).toBe(4096);
  });
});
