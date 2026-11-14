import { describe, expect, it } from 'vitest';
import { prepareRequest } from './request-context.js';
import type { RequestMessage } from './request-context.js';
import { renderContextTemplate } from './prompts.js';

describe('shared request budgeting', () => {
  it('fits the combined prompt instead of independently capping its sources', () => {
    const request = prepareRequest([
      { role: 'system', content: 'Keep these instructions.', contextParts: [
        { label: 'Relevant source', text: 'source '.repeat(2000), priority: 100, maxTokens: 2200 },
        { label: 'Older facts', text: 'background '.repeat(2000), priority: 50, maxTokens: 2000 },
        { label: 'Outline', text: 'future plans '.repeat(2000), priority: 10, maxTokens: 2000 },
      ] },
      { role: 'user', content: 'Answer this exact request.' },
    ], { contextLength: 8000, maxTokens: 3000 });
    expect(request.messages[0].content).toContain('Keep these instructions.');
    expect(request.messages.at(-1)?.content).toBe('Answer this exact request.');
    expect(request.report.estimatedInputTokens).toBeLessThanOrEqual(request.report.inputBudgetTokens);
    expect(request.report.estimatedInputTokens + request.maxTokens + request.report.safetyTokens).toBeLessThanOrEqual(8000);
    expect(request.report.sections.find((section) => section.label === 'Relevant source')?.included).toBe(true);
    expect(request.report.sections.some((section) => section.trimmed)).toBe(true);
  });

  it('protects minimum source excerpts from higher-priority optional background', () => {
    const request = prepareRequest([{ role: 'user', content: 'Summarise.', contextParts: [
      { label: 'Source', text: 'OPENING ' + 'middle '.repeat(3000) + ' ENDING', priority: 10, minTokens: 256, trim: 'both' },
      { label: 'Background', text: 'old facts '.repeat(3000), priority: 100 },
    ] }], { contextLength: 4000, maxTokens: 1500 });
    expect(request.messages[0].content).toContain('OPENING');
    expect(request.messages[0].content).toContain('ENDING');
    expect(request.report.estimatedInputTokens).toBeLessThanOrEqual(2244);
  });

  it('removes entire conversation turns while preserving the latest request', () => {
    const history: RequestMessage[] = [
      { role: 'system', content: 'Writing assistant.' },
      { role: 'user', content: 'old question '.repeat(100), contextGroup: { id: 'old', priority: 10 } },
      { role: 'assistant', content: 'old answer '.repeat(100), contextGroup: { id: 'old', priority: 10 } },
      { role: 'user', content: 'recent question', contextGroup: { id: 'recent', priority: 20 } },
      { role: 'assistant', content: 'recent answer', contextGroup: { id: 'recent', priority: 20 } },
      { role: 'user', content: 'Latest question must remain whole.' },
    ];
    const request = prepareRequest(history, { contextLength: 4000, maxTokens: 1000, inputBudgetTokens: 100 });
    expect(request.messages.map((message) => message.content)).toEqual([
      'Writing assistant.', 'recent question', 'recent answer', 'Latest question must remain whole.',
    ]);
    expect(request.report.sections.find((section) => section.label.endsWith('old'))?.included).toBe(false);
  });

  it('rejects oversized essential input instead of truncating instructions', () => {
    expect(() => prepareRequest([{ role: 'user', content: 'required '.repeat(3000) }],
      { contextLength: 4000, maxTokens: 1500 })).toThrow(/essential instructions and task input/i);
  });

  it('accounts for repeated template substitutions after rendering', () => {
    const message = renderContextTemplate('Essential rule. {{memory}} Repeated: {{memory}} Task: {{task}}',
      { memory: 'old story '.repeat(2000), task: 'Write the next scene.' },
      { memory: { label: 'Memory', priority: 10 } });
    const request = prepareRequest([message], { contextLength: 4000, maxTokens: 1500 });
    expect(request.messages[0].content).toContain('Essential rule.');
    expect(request.messages[0].content).toContain('Task: Write the next scene.');
    expect(request.messages[0].content).not.toContain('__SA_CONTEXT_');
    expect(request.report.sections).toHaveLength(2);
    expect(request.report.estimatedInputTokens).toBeLessThanOrEqual(2244);
  });

  it('uses a finite fallback and reserves output when model metadata is missing', () => {
    const request = prepareRequest([{ role: 'user', content: 'Hello.' }], { maxTokens: null });
    expect(request.report.contextLengthKnown).toBe(false);
    expect(request.report.contextLength).toBe(16000);
    expect(request.maxTokens).toBe(2048);
    expect(request.report.safetyTokens).toBe(800);
    expect(request.report.inputBudgetTokens).toBe(12000);
  });

  it('respects separate model output limits without silently reducing explicit requests', () => {
    expect(() => prepareRequest([{ role: 'user', content: 'Hello.' }],
      { contextLength: 32000, maxTokens: 6000, maxOutputTokens: 4096 })).toThrow(/reply limit/);
    const automatic = prepareRequest([{ role: 'user', content: 'Hello.' }],
      { contextLength: 32000, maxTokens: null, maxOutputTokens: 1000 });
    expect(automatic.maxTokens).toBe(1000);
  });

  it('uses more conservative estimates for non-ASCII source text', () => {
    const request = prepareRequest([{ role: 'user', content: 'Summarise.', contextParts: [
      { label: 'Source', text: '漢字の文章。'.repeat(2000), priority: 100, minTokens: 256, trim: 'both' },
    ] }], { contextLength: 4000, maxTokens: 1500 });
    expect(request.report.estimatedInputTokens).toBeLessThanOrEqual(2244);
    expect(request.messages[0].content.length).toBeLessThan(3000);
  });

  it('does not inject metadata or template slots into provider messages', () => {
    const request = prepareRequest([{ role: 'user', content: 'Start __SLOT__ end.', contextParts: [
      { label: 'Notes', text: 'reference', priority: 10, slot: '__SLOT__' },
    ] }], { maxTokens: 1000 });
    expect(request.messages[0]).toEqual({ role: 'user', content: 'Start \n\n## Notes\nreference end.' });
  });

  it('preserves literal replacement characters inside context', () => {
    const request = prepareRequest([renderContextTemplate('Rules {{memory}} Task',
      { memory: "$& costs $5; $` and $' are literal." }, { memory: { label: 'Memory', priority: 10 } })],
    { maxTokens: 1000 });
    expect(request.messages[0].content).toBe("Rules \n\n## Memory\n$& costs $5; $` and $' are literal. Task");
  });
});
