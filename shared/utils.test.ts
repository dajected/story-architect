import { describe, expect, it } from 'vitest';
import { estimateTokens, normalizeGenerationSettings } from '../shared/utils.js';
import { countWords } from '../shared/utils.js';
import { DEFAULT_GENERATION } from '../shared/types.js';

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
