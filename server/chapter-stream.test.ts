import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendWithoutOverlap, automaticChapterReplyTokens, streamChapter } from './chapter-stream.js';
import { streamChat } from './providers.js';
import type { ChatParams, ProviderConnection } from './providers.js';

vi.mock('./providers.js', () => ({ streamChat: vi.fn() }));

const provider: ProviderConnection = {
  id: 'local', name: 'Local', kind: 'openai-compatible', apiKey: null, baseUrl: 'http://localhost/v1',
  models: [{ id: 'model', name: 'Model', contextLength: 16000, maxOutputTokens: 8000 }],
};
const usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };

function params(controller = new AbortController()): ChatParams {
  return { model: 'model', messages: [
    { role: 'system', content: 'Write this chapter from its brief.' },
    { role: 'user', content: 'Write Chapter 3.' },
  ], temperature: 0.8, topP: null, maxTokens: 2000, signal: controller.signal, onDelta: vi.fn() };
}

function reply(text: string, finishReason: string) {
  return async (_provider: ProviderConnection, request: ChatParams) => {
    request.onDelta(text);
    return { content: text, usage, finishReason };
  };
}

beforeEach(() => { vi.mocked(streamChat).mockReset(); });

describe('chapter continuation', () => {
  it('preserves the rendered system prefix, chapter context, session, and cache accounting when continuing', async () => {
    const request = params();
    request.sessionId = 'novel-prose';
    request.messages = [
      { role: 'system', content: 'Standing SLOT', contextParts: [{ label: 'Standing', text: 'Reference', slot: 'SLOT', priority: 110 }] },
      { role: 'user', content: 'Chapter brief', contextParts: [{ label: 'State', text: 'Mara has the key.', priority: 100 }] },
      { role: 'user', content: 'Draft now.' },
    ];
    vi.mocked(streamChat).mockImplementationOnce(async (_provider, sent) => {
      sent.onPrepared?.({ messages: [{ role: 'system', content: 'Standing Reference' }, { role: 'user', content: 'Chapter brief' }],
        maxTokens: 2000, report: {} as never });
      sent.onDelta('An unfinished chapter.');
      return { content: 'An unfinished chapter.', finishReason: 'length',
        usage: { ...usage, cachedPromptTokens: 0, cacheWriteTokens: 80, cost: 0.001 } };
    }).mockImplementationOnce(async (_provider, sent) => {
      expect(sent.sessionId).toBe(request.sessionId);
      expect(sent.messages[0]).toEqual({ role: 'system', content: 'Standing Reference' });
      expect(sent.messages[1]).toEqual(request.messages[1]);
      sent.onDelta(' It ended.');
      return { content: ' It ended.', finishReason: 'stop',
        usage: { ...usage, cachedPromptTokens: 80, cacheWriteTokens: 0, cost: 0.0002 } };
    });
    const result = await streamChapter(provider, request, { targetWords: 1000, automaticOutput: false });
    expect(result.usage).toMatchObject({ promptTokens: 200, cachedPromptTokens: 80, cacheWriteTokens: 80 });
    expect(result.usage?.cost).toBeCloseTo(0.0012);
  });

  it('continues a cutoff and returns one draft with cumulative usage', async () => {
    const beginning = 'Mara opened the observatory door and stepped into the dark.';
    vi.mocked(streamChat).mockImplementationOnce(reply(beginning, 'length'))
      .mockImplementationOnce(reply('\n\nAt dawn, she finally found the missing map.', 'stop'));
    const request = params();
    const onUsage = vi.fn();
    const result = await streamChapter(provider, request, { targetWords: 1800, automaticOutput: false, onUsage });
    expect(result.content).toBe(beginning + '\n\nAt dawn, she finally found the missing map.');
    expect(vi.mocked(request.onDelta).mock.calls.flat().join('')).toBe(result.content);
    expect(result.usage).toEqual({ promptTokens: 200, completionTokens: 100, totalTokens: 300 });
    expect(onUsage).toHaveBeenLastCalledWith(result.usage);
    expect(streamChat).toHaveBeenCalledTimes(2);
    const continuation = vi.mocked(streamChat).mock.calls[1][1];
    expect(continuation.maxTokens).toBe(2000);
    expect(continuation.messages.at(-1)?.content).toContain('SAME chapter');
    expect(continuation.messages.at(-1)?.contextParts?.at(-1)?.text).toBe(beginning);
  });

  it('removes repeated handoff text from continuation output', async () => {
    const ending = 'She lifted the brass key and turned toward the door.';
    vi.mocked(streamChat).mockImplementationOnce(reply(ending, 'length'))
      .mockImplementationOnce(reply(ending + '\n\nThe door opened.', 'stop'));
    const request = params();
    const result = await streamChapter(provider, request, { targetWords: 1000, automaticOutput: false });
    expect(result.content).toBe(ending + '\n\nThe door opened.');
    expect(vi.mocked(request.onDelta).mock.calls.flat().join('')).toBe(result.content);
  });

  it('bounds retries even if each reply keeps producing prose and hitting its limit', async () => {
    let index = 0;
    vi.mocked(streamChat).mockImplementation(async (_provider, request) => {
      const content = `\n\nA distinct scene ${++index} happens.`;
      request.onDelta(content);
      return { content, usage, finishReason: 'length' };
    });
    const request = params();
    await expect(streamChapter(provider, request, { targetWords: 1800, automaticOutput: false }))
      .rejects.toThrow(/after 4 requests/);
    expect(streamChat).toHaveBeenCalledTimes(4);
    expect(vi.mocked(request.onDelta).mock.calls.flat().join('')).toContain('scene 4');
    expect(vi.mocked(streamChat).mock.calls.every((call) => call[1].maxTokens === 2000)).toBe(true);
  });

  it('allows one larger automatic budget after a reasoning-only cutoff', async () => {
    vi.mocked(streamChat).mockImplementationOnce(reply('', 'length'))
      .mockImplementationOnce(reply('At last, the chapter began and ended.', 'stop'));
    const result = await streamChapter(provider, params(), { targetWords: 1000, automaticOutput: true });
    expect(result.content).toContain('At last');
    expect(vi.mocked(streamChat).mock.calls[1][1].maxTokens).toBe(3000);
  });

  it('does not spend retries on reasoning-only replies when the user budget is fixed', async () => {
    vi.mocked(streamChat).mockImplementation(reply('', 'length'));
    await expect(streamChapter(provider, params(), { targetWords: 1000, automaticOutput: false }))
      .rejects.toThrow(/without producing new prose/);
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  it('retains buffered continuation prose when the job is cancelled', async () => {
    const controller = new AbortController();
    vi.mocked(streamChat).mockImplementationOnce(reply('The first part of the unfinished chapter.', 'length'))
      .mockImplementationOnce(async (_provider, request) => {
        request.onDelta('\n\nA little more prose arrived before cancellation.');
        controller.abort();
        controller.signal.throwIfAborted();
        throw new Error('unreachable');
      });
    const request = params(controller);
    await expect(streamChapter(provider, request, { targetWords: 1000, automaticOutput: false }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(request.onDelta).mock.calls.flat().join('')).toContain('before cancellation.');
    expect(streamChat).toHaveBeenCalledTimes(2);
  });

  it('only carries bounded excerpts of a growing chapter into continuation', async () => {
    vi.mocked(streamChat).mockImplementationOnce(reply('opening '.repeat(10000) + ' ending', 'length'))
      .mockImplementationOnce(reply('\nFinished.', 'stop'));
    await streamChapter(provider, params(), { targetWords: 10000, automaticOutput: false });
    const parts = vi.mocked(streamChat).mock.calls[1][1].messages.at(-1)?.contextParts ?? [];
    expect(parts[0].text.length).toBeLessThanOrEqual(800);
    expect(parts[1].text.length).toBeLessThanOrEqual(8000);
    expect(parts[1].text).toMatch(/ ending$/);
  });

  it('keeps literal overlap characters and partial words intact', () => {
    expect(appendWithoutOverlap('The unfinished furni', 'ture was old.')).toBe('ture was old.');
    expect(appendWithoutOverlap('A long enough repeated sentence with $& literally.',
      'A long enough repeated sentence with $& literally. Next.')).toBe(' Next.');
  });

  it('caps automatic output for model windows and reply limits', () => {
    expect(automaticChapterReplyTokens(10000, 16000, 2000)).toBe(2000);
    expect(automaticChapterReplyTokens(10000, 8000)).toBe(3800);
    expect(automaticChapterReplyTokens(1800, 128000)).toBe(5648);
  });
});
