import { describe, expect, it } from 'vitest';
import { estimateTokens, normalizeGenerationSettings, sumTokenUsage } from '../shared/utils.js';
import { countWords } from '../shared/utils.js';
import { DEFAULT_GENERATION } from '../shared/types.js';

describe('sumTokenUsage', () => {
  it('accounts for cache reads, writes, and cost across all paid attempts', () => {
    const total = sumTokenUsage([
      { promptTokens: 3000, cachedPromptTokens: 0, cacheWriteTokens: 2000, cost: 0.001, providers: ['A'] },
      { promptTokens: 3500, cachedPromptTokens: 2000, cacheWriteTokens: 0, cost: 0.0002, providers: ['A', 'B'] },
    ]);
    expect(total).toMatchObject({ promptTokens: 6500, cachedPromptTokens: 2000, cacheWriteTokens: 2000, providers: ['A', 'B'] });
    expect(total?.cost).toBeCloseTo(0.0012);
  });

  it('keeps unknown cache statistics and partial costs unknown', () => {
    expect(sumTokenUsage([{ promptTokens: 100, cost: 0.001, cachedPromptTokens: 90 }, { promptTokens: 200 }]))
      .toEqual({ promptTokens: 300 });
    expect(sumTokenUsage([{ promptTokens: 100 }, null])).toBeNull();
    expect(sumTokenUsage([])).toBeNull();
  });
});

describe('countWords', () => {
  it('counts latin words and CJK characters', () => {
    expect(countWords('The brass key was warm.')).toBe(5);
    expect(countWords('hello 世界')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});

describe('estimateTokens', () => {
  it('uses a rough four characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('normalizeGenerationSettings', () => {
  it('fills omitted fields from the fallback', () => {
    const settings = normalizeGenerationSettings({ temperature: 0.4 }, DEFAULT_GENERATION);
    expect(settings.temperature).toBe(0.4);
    expect(settings.contextPreset).toBe(DEFAULT_GENERATION.contextPreset);
    expect(settings.targetWords).toBe(DEFAULT_GENERATION.targetWords);
  });
});
