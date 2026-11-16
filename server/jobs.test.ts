import { describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ dbAll: vi.fn(), dbGet: vi.fn(), dbRun: vi.fn(), timestamp: vi.fn() }));
vi.mock('./store/connections.js', () => ({ modelPricing: vi.fn() }));
import { estimateJobCost } from './jobs.js';

describe('cache-aware job costs', () => {
  const pricing = { promptPerToken: 0.000001, completionPerToken: 0.000002, currency: 'USD' as const,
    cacheReadPerToken: 0.0000001, cacheWritePerToken: 0.00000125 };

  it('uses the reported charge even without model pricing, including a free request', () => {
    expect(estimateJobCost({ promptTokens: 1000, cost: 0.00012345 }, null)).toBe(0.00012345);
    expect(estimateJobCost({ promptTokens: 1000, cost: 0 }, pricing)).toBe(0);
  });

  it('prices cached reads and writes as portions of total input rather than extra tokens', () => {
    expect(estimateJobCost({ promptTokens: 1000, completionTokens: 100, cachedPromptTokens: 600, cacheWriteTokens: 200 }, pricing))
      .toBe(0.00071);
  });

  it('retains ordinary estimates when cache statistics or cache prices are unavailable', () => {
    expect(estimateJobCost({ promptTokens: 1000, completionTokens: 100 }, pricing)).toBe(0.0012);
    expect(estimateJobCost({ promptTokens: 1000, completionTokens: 100, cachedPromptTokens: 600 },
      { promptPerToken: pricing.promptPerToken, completionPerToken: pricing.completionPerToken, currency: 'USD' })).toBe(0.0012);
    expect(estimateJobCost(null, pricing)).toBeNull();
  });
});
