import { streamChat } from './providers.js';
import type { ChatParams, ChatResult, ChatUsage, ProviderConnection } from './providers.js';
import { FALLBACK_CONTEXT_LENGTH, prepareRequest } from './request-context.js';

const MAX_REQUESTS = 3;
const MAX_REPLY_TOKENS = 16384;

function modelLimits(provider: ProviderConnection, modelId: string) {
  const model = provider.models?.find((entry) => entry.id === modelId);
  const context = model?.contextLength && Number.isFinite(model.contextLength) && model.contextLength > 0
    ? Math.floor(model.contextLength) : FALLBACK_CONTEXT_LENGTH;
  const reply = model?.maxOutputTokens && Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens > 0
    ? Math.floor(model.maxOutputTokens) : MAX_REPLY_TOKENS;
  return { context, reply: Math.min(MAX_REPLY_TOKENS, reply) };
}

/** Allow for both the visible answer and any reasoning tokens. */
export function backgroundReplyTokens(provider: ProviderConnection, modelId: string): number {
  const { context, reply } = modelLimits(provider, modelId);
  const safety = Math.max(256, Math.ceil(context * 0.05));
  return Math.max(1, Math.min(4096, reply, Math.floor((context - safety) / 2)));
}

function sumUsage(results: ChatResult[]): ChatUsage | null {
  if (results.some((result) => !result.usage)) return null;
  const usage: ChatUsage = {};
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'reasoningTokens'] as const) {
    if (results.every((result) => result.usage?.[key] !== undefined)) {
      usage[key] = results.reduce((sum, result) => sum + result.usage![key]!, 0);
    }
  }
  return usage;
}

/** Retry complete background results; never concatenate truncated JSON/state. */
export async function streamBackgroundTask(
  provider: ProviderConnection,
  params: ChatParams,
  options: {
    label: string;
    validate: (content: string) => boolean;
    onAttempt?: (result: ChatResult, totalUsage: ChatUsage | null) => void;
  },
): Promise<ChatResult> {
  const limits = modelLimits(provider, params.model);
  let maxTokens = backgroundReplyTokens(provider, params.model);
  const knownContext = provider.models?.find((entry) => entry.id === params.model)?.contextLength;
  const frozen = prepareRequest(params.messages, {
    contextLength: knownContext, maxOutputTokens: limits.reply, maxTokens,
    inputBudgetTokens: Math.min(params.inputBudgetTokens ?? 6000, 6000),
  });
  // Freeze the initial evidence. More reply space must not silently trim
  // additional source text on a later attempt.
  const largestReply = Math.min(limits.reply,
    frozen.report.contextLength - frozen.report.safetyTokens - frozen.report.estimatedInputTokens);
  const results: ChatResult[] = [];
  let lastOutput = '';
  let published = false;
  const publish = (content: string) => {
    if (content && !published) { params.onDelta(content); published = true; }
  };
  for (let attempt = 0; attempt < MAX_REQUESTS; attempt++) {
    params.signal.throwIfAborted();
    let received = '';
    let result: ChatResult;
    try {
      result = await streamChat(provider, {
        ...params, maxTokens, messages: frozen.messages, inputBudgetTokens: frozen.report.inputBudgetTokens,
        onDelta: (text) => { received += text; },
        onPrepared: (request) => params.onPrepared?.({ ...request,
          report: { ...request.report, sections: frozen.report.sections } }),
      });
    } catch (error) {
      publish(received || lastOutput);
      throw error;
    }
    lastOutput = result.content;
    results.push(result);
    options.onAttempt?.(result, sumUsage(results));
    if (params.signal.aborted) { publish(lastOutput); params.signal.throwIfAborted(); }
    const limited = result.finishReason === 'length' || result.finishReason === 'max_tokens';
    if (!limited && options.validate(result.content)) {
      publish(result.content);
      return { ...result, usage: sumUsage(results) };
    }
    const larger = Math.min(largestReply, maxTokens * 2);
    if (attempt === MAX_REQUESTS - 1 || (limited && larger - maxTokens < 256)) {
      publish(lastOutput);
      const reasoning = results.at(-1)?.usage?.reasoningTokens;
      throw new Error(limited
        ? `${options.label} reached its reply token limit after ${results.length} request(s), with ${maxTokens.toLocaleString()} tokens allowed for the last reply${reasoning ? ` (${reasoning.toLocaleString()} used for reasoning)` : ''}. No incomplete result was applied. Use a model with more reply capacity or less reasoning, then retry this task.`
        : `${options.label} returned an invalid or oversized result after ${results.length} request(s). No incomplete result was applied; retry this task.`);
    }
    maxTokens = Math.max(maxTokens, larger);
  }
  throw new Error('Background generation ended unexpectedly.');
}
