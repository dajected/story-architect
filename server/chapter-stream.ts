import { countWords } from '../shared/utils.js';
import { FALLBACK_CONTEXT_LENGTH } from './request-context.js';
import { streamChat } from './providers.js';
import type { ChatParams, ChatResult, ChatUsage, ProviderConnection, ProviderMessage } from './providers.js';

const MAX_CHAPTER_REQUESTS = 4;
const OVERLAP_CHARS = 2048;

export function automaticChapterReplyTokens(
  targetWords: number,
  contextLength: number | null | undefined,
  maxOutputTokens?: number,
): number {
  const window = contextLength && contextLength > 0 ? contextLength : FALLBACK_CONTEXT_LENGTH;
  const safety = Math.max(256, Math.ceil(window * 0.05));
  // A chapter can span requests. Never reserve the entire window for one reply.
  return Math.max(1, Math.min(Math.ceil(targetWords * 2 + 2048),
    Math.floor((window - safety) / 2), maxOutputTokens && maxOutputTokens > 0 ? maxOutputTokens : Infinity));
}

export function appendWithoutOverlap(previous: string, next: string): string {
  let addition = next;
  for (let length = Math.min(previous.length, next.length, OVERLAP_CHARS); length >= 32; length--) {
    if (previous.endsWith(next.slice(0, length))) {
      addition = next.slice(length);
      break;
    }
  }
  // Models sometimes omit a leading separator when starting a new sentence.
  // Leave unfinished words alone so token-level word splits can be repaired.
  return /[.!?]["'”’)]?$/.test(previous) && /^[\p{L}"'“]/u.test(addition) ? ` ${addition}` : addition;
}

function totalUsage(results: ChatResult[]): ChatUsage | null {
  if (results.some((result) => !result.usage)) return null;
  const usage: ChatUsage = {};
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
    if (results.every((result) => result.usage?.[key] !== undefined)) {
      usage[key] = results.reduce((sum, result) => sum + result.usage![key]!, 0);
    }
  }
  return usage;
}

function continuationMessages(original: ProviderMessage[], content: string, targetWords: number): ProviderMessage[] {
  const words = countWords(content);
  const remaining = Math.max(0, targetWords - words);
  const systems = original.filter((message) => message.role === 'system');
  return [...systems, {
    role: 'user',
    content: `Continue the SAME chapter from the exact end of the current draft. Do not restart, recap, repeat the supplied excerpt, add a heading, or discuss the process.
The draft already has about ${words} words toward a target of ${targetWords} words.
${remaining > 100 ? `Aim to finish the remaining chapter beats in about ${remaining} more words.` : 'Finish the current beat and end the chapter naturally within about 100 more words.'}
Return only new prose to append. If the last word or sentence is incomplete, finish it first. Preserve any whitespace needed at the join.`,
    contextParts: [
      { label: 'Current chapter opening (already written)', text: content.slice(0, 800), priority: 60, maxTokens: 220 },
      { label: 'Exact ending of the current draft — continue AFTER this text', text: content.slice(-8000),
        priority: 200, minTokens: 128, maxTokens: 2000, trim: 'tail' },
    ],
  }];
}

/** One job/runtime across a bounded number of separately budgeted replies. */
export async function streamChapter(
  provider: ProviderConnection,
  params: ChatParams,
  options: { targetWords: number; automaticOutput: boolean; onUsage?: (usage: ChatUsage | null) => void },
): Promise<ChatResult> {
  const model = provider.models?.find((entry) => entry.id === params.model);
  const window = model?.contextLength ?? FALLBACK_CONTEXT_LENGTH;
  const growthLimit = Math.max(1, Math.min(model?.maxOutputTokens ?? Infinity,
    window - Math.max(256, Math.ceil(window * 0.05)) - 2048));
  const results: ChatResult[] = [];
  let content = '';
  let maxTokens = params.maxTokens;
  for (let attempt = 0; attempt < MAX_CHAPTER_REQUESTS; attempt++) {
    params.signal.throwIfAborted();
    const previous = content;
    let buffered = '';
    let streaming = previous.length === 0;
    const emit = (text: string) => {
      if (!text) return;
      content += text;
      params.onDelta(text);
    };
    const flush = () => {
      if (!buffered) return;
      emit(appendWithoutOverlap(previous, buffered));
      buffered = '';
      streaming = true;
    };
    let result: ChatResult;
    try {
      result = await streamChat(provider, {
        ...params,
        maxTokens,
        messages: previous ? continuationMessages(params.messages, previous, options.targetWords) : params.messages,
        onDelta: (text) => {
          if (streaming) emit(text);
          else {
            buffered += text;
            if (buffered.length >= OVERLAP_CHARS) flush();
          }
        },
      });
    } finally {
      // Cancellation and provider errors must retain already-received prose.
      flush();
    }
    results.push(result);
    options.onUsage?.(totalUsage(results));
    params.signal.throwIfAborted();
    if (result.finishReason !== 'length' && result.finishReason !== 'max_tokens') {
      if (!content.slice(previous.length).trim()) {
        throw new Error('The model returned no new prose while continuing the chapter. Partial output is kept for recovery.');
      }
      return { content, usage: totalUsage(results), finishReason: result.finishReason };
    }
    const progressed = content.length > previous.length;
    const largerBudget = !progressed && options.automaticOutput && maxTokens !== null
      ? Math.min(growthLimit, Math.ceil(maxTokens * 1.5)) : maxTokens;
    if (!progressed && (largerBudget === maxTokens || attempt > 0)) {
      throw new Error('The model exhausted its reply token limit without producing new prose. Partial output is kept. Increase the model reply allowance or use a model that spends fewer tokens reasoning.');
    }
    maxTokens = largerBudget;
  }
  throw new Error(`The chapter still reached the reply token limit after ${MAX_CHAPTER_REQUESTS} requests. Partial output is kept for recovery. Lower the target length or increase max output tokens before retrying.`);
}
