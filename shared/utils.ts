import type { GenerationSettings } from './types.js';
import { DEFAULT_GENERATION } from './types.js';

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
