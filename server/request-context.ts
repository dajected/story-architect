import { conflict } from './errors.js';
import { estimateTokens } from '../shared/utils.js';
import type { RequestBudgetInfo } from '../shared/types.js';

export const FALLBACK_CONTEXT_LENGTH = 16000;

export interface RequestContextPart {
  label: string;
  text: string;
  /** Higher priorities are retained first; source text outranks background. */
  priority: number;
  maxTokens?: number;
  minTokens?: number;
  trim?: 'head' | 'tail' | 'both' | 'omit';
  /** An internal template slot; absent means append after essential content. */
  slot?: string;
}

export interface RequestMessage {
  role: 'system' | 'user' | 'assistant';
  /** Essential instructions or task input. Never silently shortened. */
  content: string;
  contextParts?: RequestContextPart[];
  /** Optional chat messages are kept/dropped as complete turns. */
  contextGroup?: { id: string; priority: number };
}

export interface PreparedRequest {
  messages: Array<{ role: RequestMessage['role']; content: string }>;
  maxTokens: number;
  report: RequestBudgetInfo;
}

// Include framing and additional allowance for non-ASCII text. This remains an
// estimate, so the model window also gets a separate safety margin.
function textTokens(text: string): number {
  return estimateTokens(text) + (text.match(/[^\x00-\x7f]/gu)?.length ?? 0);
}

function messageTokens(messages: PreparedRequest['messages']): number {
  return 8 + messages.reduce((total, message) => total + 8 + textTokens(message.content), 0);
}

function fitText(part: RequestContextPart, tokens: number): string {
  const full = `\n\n## ${part.label}\n${part.text}`;
  if (textTokens(full) <= tokens) return full;
  if (part.trim === 'omit') return '';
  const marker = '\n[Context excerpt trimmed to fit.]\n';
  const prefix = `\n\n## ${part.label}\n`;
  const render = (length: number) => {
    if (part.trim === 'tail') return prefix + marker + part.text.slice(-length);
    if (part.trim === 'both') {
      const head = Math.ceil(length * 0.6);
      const tail = length - head;
      return prefix + part.text.slice(0, head) + marker + (tail ? part.text.slice(-tail) : '');
    }
    return prefix + part.text.slice(0, length) + marker;
  };
  if (textTokens(prefix + marker) >= tokens) return '';
  let low = 1;
  let high = part.text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (textTokens(render(middle)) <= tokens) low = middle;
    else high = middle - 1;
  }
  const result = render(low);
  return textTokens(result) <= tokens ? result : '';
}

/** Budget the final, rendered request across all messages and context sources. */
export function prepareRequest(
  messages: RequestMessage[],
  options: { contextLength?: number | null; maxTokens: number | null; maxOutputTokens?: number; inputBudgetTokens?: number },
): PreparedRequest {
  const known = typeof options.contextLength === 'number' && Number.isFinite(options.contextLength) && options.contextLength > 0;
  const contextLength = known ? Math.floor(options.contextLength!) : FALLBACK_CONTEXT_LENGTH;
  const safetyTokens = Math.max(256, Math.ceil(contextLength * 0.05));
  const replyLimit = options.maxOutputTokens && Number.isFinite(options.maxOutputTokens) && options.maxOutputTokens > 0
    ? Math.floor(options.maxOutputTokens) : null;
  const maxTokens = options.maxTokens ?? Math.min(2048, replyLimit ?? 2048);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw conflict('Max output tokens must be a positive integer.');
  if (replyLimit && maxTokens > replyLimit) {
    throw conflict(`The requested ${maxTokens.toLocaleString()} output tokens exceed this model's ${replyLimit.toLocaleString()}-token reply limit. Lower max output tokens or use a model with a larger reply limit.`);
  }
  const inputBudgetTokens = Math.min(options.inputBudgetTokens ?? 12000, contextLength - maxTokens - safetyTokens);
  const rendered = messages.map((message) => ({ role: message.role, content: message.contextGroup ? '' : message.content }));
  const active = new Set(messages.flatMap((message, index) => message.contextGroup ? [] : [index]));
  const parts = messages.flatMap((message, index) => (message.contextParts ?? [])
    .filter((part) => part.text.trim())
    .map((part) => ({ part, index, text: '' })));
  const groups = new Map<string, { priority: number; indices: number[] }>();
  messages.forEach((message, index) => {
    if (!message.contextGroup) return;
    const { id, priority } = message.contextGroup;
    const group = groups.get(id) ?? { priority, indices: [] };
    group.indices.push(index);
    groups.set(id, group);
  });
  const assemble = () => rendered.flatMap((message, index) => {
    if (!active.has(index)) return [];
    let content = message.content;
    for (const entry of parts.filter((entry) => entry.index === index)) {
      if (entry.part.slot) content = content.replaceAll(entry.part.slot, () => entry.text);
      else content += entry.text;
    }
    return [{ role: message.role, content }];
  });
  // Reserve a minimum excerpt for primary source material before adding any
  // optional background. Core instructions and the latest request remain whole.
  for (const entry of parts) {
    if (entry.part.minTokens) {
      entry.text = fitText(entry.part, entry.part.minTokens);
      if (!entry.text) throw conflict(`The ${entry.part.label} cannot fit its minimum context allowance.`);
    }
  }
  let used = messageTokens(assemble());
  if (used > inputBudgetTokens) {
    throw conflict(`The essential instructions and task input need about ${used.toLocaleString()} tokens, but only ${Math.max(0, inputBudgetTokens).toLocaleString()} input tokens fit after reserving ${maxTokens.toLocaleString()} for the reply and ${safetyTokens.toLocaleString()} for overhead${known ? '' : ' (using a conservative 16,000-token window because model metadata is unavailable)'}. Shorten the request or instructions, lower the requested output length, or select a larger-context model.`);
  }
  const candidates = [
    ...parts.map((entry) => ({ priority: entry.part.priority, part: entry, group: null })),
    ...[...groups.entries()].map(([id, group]) => ({ priority: group.priority, part: null, group: { id, ...group } })),
  ].sort((a, b) => b.priority - a.priority);
  const sections: PreparedRequest['report']['sections'] = [];
  for (const candidate of candidates) {
    if (candidate.part) {
      const entry = candidate.part;
      const original = entry.text;
      const allowance = Math.min(entry.part.maxTokens ?? inputBudgetTokens, inputBudgetTokens - used + textTokens(original));
      entry.text = fitText(entry.part, allowance);
      if (messageTokens(assemble()) > inputBudgetTokens) entry.text = original;
      sections.push({ label: entry.part.label, included: !!entry.text,
        trimmed: entry.text !== `\n\n## ${entry.part.label}\n${entry.part.text}`, tokens: textTokens(entry.text) });
    } else if (candidate.group) {
      const group = candidate.group;
      for (const index of group.indices) {
        active.add(index);
        rendered[index].content = messages[index].content;
      }
      const fits = messageTokens(assemble()) <= inputBudgetTokens;
      if (!fits) for (const index of group.indices) active.delete(index);
      sections.push({ label: `Conversation turn ${group.id}`, included: fits, trimmed: !fits,
        tokens: fits ? group.indices.reduce((sum, index) => sum + textTokens(messages[index].content) + 8, 0) : 0 });
    }
    used = messageTokens(assemble());
  }
  return { messages: assemble(), maxTokens, report: {
    contextLength, contextLengthKnown: known, inputBudgetTokens, estimatedInputTokens: used,
    reservedOutputTokens: maxTokens, safetyTokens, sections,
  } };
}
