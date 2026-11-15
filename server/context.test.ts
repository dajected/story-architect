import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, ContextPreset, Project } from '../shared/types.js';
import { estimateTokens } from '../shared/utils.js';
import { buildProseContext } from './context.js';
import { currentChapterText, listChapters } from './store/chapters.js';
import { memoryForPrompt } from './store/memory.js';
import { listLoreEntries } from './store/lore.js';

vi.mock('./store/chapters.js', () => ({ listChapters: vi.fn(), currentChapterText: vi.fn() }));
vi.mock('./store/memory.js', () => ({ memoryForPrompt: vi.fn() }));
vi.mock('./store/lore.js', () => ({ listLoreEntries: vi.fn() }));
vi.mock('./store/outline.js', () => ({ latestOutlineRevision: vi.fn() }));

const project: Project = {
  id: 'novel', title: 'The Observatory', premise: '', genre: '', tone: '', pov: '',
  tense: '', styleNotes: '', contentPreferences: '', instructions: '', chapterCount: 9,
  targetChapterWords: 1800, status: 'active', createdAt: '', updatedAt: '',
  chapterTotal: 9, currentWords: 0, outlineStatus: 'approved',
};
const chapters: Chapter[] = Array.from({ length: 10 }, (_, orderIndex) => ({
  id: `chapter-${orderIndex + 1}`, projectId: project.id, orderIndex,
  title: `Title ${orderIndex + 1}`, brief: 'Continue the search.', briefApproved: true,
  status: 'drafted', wordCount: 2000, currentRevisionId: `revision-${orderIndex + 1}`,
  updatedAt: '',
}));

beforeEach(() => {
  vi.mocked(listChapters).mockReturnValue(chapters);
  vi.mocked(listLoreEntries).mockReturnValue([]);
  vi.mocked(currentChapterText).mockImplementation((id) =>
    `UNIQUE-OPENING-${id}\n${'A long paragraph of previous prose. '.repeat(600)}\nENDING-${id}`,
  );
  vi.mocked(memoryForPrompt).mockReturnValue({
    summaries: chapters.slice(0, 8).map((chapter) => ({
      chapterId: chapter.id, chapterTitle: chapter.title, orderIndex: chapter.orderIndex,
      summary: `SUMMARY-${chapter.id}: the search continues.`, stale: false, staleReasons: [],
    })),
    characters: [], facts: [], staleSummaries: 0, pendingFacts: 0,
  });
});

describe('chapter context', () => {
  it.each<[ContextPreset, number]>([['focused', 800], ['balanced', 1600], ['broad', 2400]])(
    'bounds chapter 9 raw prose with the %s preset while retaining older memory',
    (preset, cap) => {
      const context = buildProseContext(project, chapters[8], { preset, modelContextLength: 16000 });
      expect(context.recentProse).toContain('ENDING-chapter-8');
      expect(context.recentProse).not.toContain('UNIQUE-OPENING');
      expect(context.recentProse).not.toContain('ENDING-chapter-7');
      expect(context.recentProse).not.toContain('ENDING-chapter-9');
      expect(context.memoryText).toContain('SUMMARY-chapter-1');
      expect(context.memoryText).toContain('SUMMARY-chapter-8');
      expect(estimateTokens(context.recentProse)).toBeLessThanOrEqual(cap);
      expect(context.includedChapters).toBe(1);
      expect(context.omittedChapters).toBe(7);
      expect(context.includedWords).toBeGreaterThan(0);
      expect(context.estimatedTokens).toBeLessThanOrEqual(context.availableInputTokens);
      expect(context.estimatedTokens + context.reservedOutputTokens).toBeLessThan(16000);
    },
  );

  it('keeps a short preceding chapter whole without filling spare capacity with older chapters', () => {
    vi.mocked(currentChapterText).mockImplementation((id) => `Short prose from ${id}.`);
    const context = buildProseContext(project, chapters[8], { preset: 'broad' });
    expect(context.recentProse).toContain('Short prose from chapter-8.');
    expect(context.recentProse).not.toContain('chapter-7');
    expect(context.recentProse).not.toContain('Ending excerpt');
    expect(context.includedChapters).toBe(1);
  });

  it('reserves output and overhead before fitting input to a 16,000-token model', () => {
    const context = buildProseContext(project, chapters[8], {
      preset: 'broad', modelContextLength: 16000, targetWords: 4000,
    });
    expect(context.reservedOutputTokens).toBe(7600);
    expect(context.availableInputTokens).toBe(7600);
    expect(context.estimatedTokens).toBeLessThanOrEqual(7600);
    expect(context.warnings.join(' ')).toContain('overhead');
  });

  it('respects an explicit output limit', () => {
    const context = buildProseContext(project, chapters[8], {
      preset: 'broad', modelContextLength: 16000, maxTokens: 6000,
    });
    expect(context.reservedOutputTokens).toBe(6000);
    expect(context.availableInputTokens).toBe(9200);
  });

  it('caps automatic replies to the model output limit even for long chapters', () => {
    const context = buildProseContext(project, chapters[8], {
      preset: 'broad', modelContextLength: 16000, modelMaxOutputTokens: 2000, targetWords: 10000,
    });
    expect(context.reservedOutputTokens).toBe(2000);
    expect(context.availableInputTokens).toBe(13200);
  });

  it('reports unsummarised older chapters instead of inserting their full prose', () => {
    vi.mocked(memoryForPrompt).mockReturnValue({
      summaries: [], characters: [], facts: [], staleSummaries: 0, pendingFacts: 0,
    });
    const context = buildProseContext(project, chapters[8], { preset: 'broad' });
    expect(context.warnings.join(' ')).toContain('8 preceding drafted chapters have no summary');
    expect(context.includedChapters).toBe(1);
    expect(context.recentProse).not.toContain('ENDING-chapter-7');
  });

  it('fits a very small remaining budget without leaking omission markers beyond it', () => {
    const context = buildProseContext(project, chapters[8], {
      preset: 'focused', templateContent: 'x'.repeat(15800), modelContextLength: 16000,
    });
    expect(context.estimatedTokens).toBeLessThanOrEqual(context.availableInputTokens);
    expect(context.includedChapters).toBe(0);
    expect(context.recentProse).toBe('');
  });

  it('has no preceding prose for the opening chapter', () => {
    vi.mocked(memoryForPrompt).mockReturnValue({
      summaries: [], characters: [], facts: [], staleSummaries: 0, pendingFacts: 0,
    });
    const context = buildProseContext(project, chapters[0], { preset: 'balanced' });
    expect(context.recentProse).toBe('');
    expect(context.includedChapters).toBe(0);
    expect(context.omittedChapters).toBe(0);
  });
});
