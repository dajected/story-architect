import type { GenerationSettings, JobSettingsSnapshot, TokenUsage } from './types.js';
import { DEFAULT_GENERATION } from './types.js';

/** Never present partial usage or partial costs as a complete multi-request total. */
export function sumTokenUsage(usages: Array<TokenUsage | null>): TokenUsage | null {
  if (!usages.length || usages.some((usage) => !usage)) return null;
  const total: TokenUsage = {};
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'reasoningTokens',
    'cachedPromptTokens', 'cacheWriteTokens', 'cost'] as const) {
    if (usages.every((usage) => usage?.[key] !== undefined)) {
      total[key] = usages.reduce((sum, usage) => sum + usage![key]!, 0);
    }
  }
  const providers = [...new Set(usages.flatMap((usage) => usage?.providers ?? []))];
  if (providers.length) total.providers = providers;
  return total;
}

/** Capture the sampling settings shown in the generation log. */
export function jobSettingsSnapshot(
  settings: Pick<GenerationSettings, 'temperature' | 'topP' | 'maxTokens'> &
    Partial<Pick<GenerationSettings, 'contextPreset' | 'targetWords'>>,
  extra: Partial<JobSettingsSnapshot> = {},
): JobSettingsSnapshot {
  return {
    temperature: settings.temperature ?? null,
    topP: settings.topP ?? null,
    maxTokens: settings.maxTokens ?? null,
    ...(settings.contextPreset ? { contextPreset: settings.contextPreset } : {}),
    ...(settings.targetWords !== undefined ? { targetWords: settings.targetWords } : {}),
    ...extra,
  };
}

export function normalizeGenerationSettings(
  value: Partial<GenerationSettings> | null | undefined,
  fallback: GenerationSettings = DEFAULT_GENERATION,
): GenerationSettings {
  return {
    temperature: value?.temperature ?? fallback.temperature,
    topP: value?.topP ?? fallback.topP,
    maxTokens: value?.maxTokens ?? fallback.maxTokens,
    contextPreset: value?.contextPreset ?? fallback.contextPreset,
    targetWords: value?.targetWords ?? fallback.targetWords,
  };
}

/** Cheap token estimate used for context budgeting and UI labels. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function countWords(text: string): number {
  if (!text.trim()) return 0;
  const latin = text.match(/[A-Za-z0-9’'\-]+/g)?.length ?? 0;
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  return latin + cjk;
}
