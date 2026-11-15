import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, ContextPreset, Project } from '../shared/types.js';
import { estimateTokens } from '../shared/utils.js';
import { buildProseContext } from './context.js';
import { currentChapterText, listChapters } from './store/chapters.js';
import { memoryForPrompt } from './store/memory.js';
import { listLoreEntries } from './store/lore.js';
import { inspectStoryState } from './store/story-state.js';

vi.mock('./store/chapters.js', () => ({ listChapters: vi.fn(), currentChapterText: vi.fn() }));
vi.mock('./store/memory.js', () => ({ memoryForPrompt: vi.fn() }));
vi.mock('./store/lore.js', () => ({ listLoreEntries: vi.fn() }));
vi.mock('./store/outline.js', () => ({ latestOutlineRevision: vi.fn() }));
vi.mock('./store/story-state.js', () => ({ inspectStoryState: vi.fn() }));

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
  vi.mocked(inspectStoryState).mockImplementation((_projectId, beforeOrder) => ({
    checkpoint: null, validPrefix: null, info: {
      status: beforeOrder ? 'current' : 'empty', text: beforeOrder ? 'COMPACT-STATE: Mara has the key; the observatory is open. Iven is missing.' : '',
      throughChapterId: beforeOrder ? `chapter-${beforeOrder}` : null, throughChapterNumber: beforeOrder || null,
      version: beforeOrder ? 'state-version' : null,
    },
  }));
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
  it.each<[ContextPreset, number]>([['focused', 300], ['balanced', 500], ['broad', 650]])(
    'bounds chapter 9 prose with the %s preset and replaces the summary archive with one state',
    (preset, cap) => {
      const context = buildProseContext(project, chapters[8], { preset, modelContextLength: 16000 });
      expect(context.recentProse).toContain('ENDING-chapter-8');
      expect(context.recentProse).not.toContain('UNIQUE-OPENING');
      expect(context.recentProse).not.toContain('ENDING-chapter-7');
      expect(context.recentProse).not.toContain('ENDING-chapter-9');
      expect(context.memoryText).not.toContain('SUMMARY-chapter-');
      expect(context.storyState.text).toContain('COMPACT-STATE');
      expect(context.includedSummaries).toBe(0);
      expect(memoryForPrompt).toHaveBeenCalledWith(project.id, chapters[8].id, { includeSummaries: false });
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
    expect(context.availableInputTokens).toBe(5000);
    expect(context.estimatedTokens).toBeLessThanOrEqual(5000);
  });

  it('respects an explicit output limit', () => {
    const context = buildProseContext(project, chapters[8], {
      preset: 'broad', modelContextLength: 16000, maxTokens: 6000,
    });
    expect(context.reservedOutputTokens).toBe(6000);
    expect(context.availableInputTokens).toBe(5000);
  });

  it('caps automatic replies to the model output limit even for long chapters', () => {
    const context = buildProseContext(project, chapters[8], {
      preset: 'broad', modelContextLength: 16000, modelMaxOutputTokens: 2000, targetWords: 10000,
    });
    expect(context.reservedOutputTokens).toBe(2000);
    expect(context.availableInputTokens).toBe(5000);
  });

  it('reports missing story state instead of inserting the chapter archive', () => {
    vi.mocked(inspectStoryState).mockReturnValue({ checkpoint: null, validPrefix: null, info: {
      status: 'missing', text: '', throughChapterId: null, throughChapterNumber: null, version: null,
    } });
    vi.mocked(memoryForPrompt).mockReturnValue({
      summaries: [], characters: [], facts: [], staleSummaries: 0, pendingFacts: 0,
    });
    const context = buildProseContext(project, chapters[8], { preset: 'broad' });
    expect(context.warnings.join(' ')).toContain('will be rebuilt in chapter order');
    expect(context.includedChapters).toBe(1);
    expect(context.recentProse).not.toContain('ENDING-chapter-7');
  });

  it('fits a very small remaining budget without leaking omission markers beyond it', () => {
    const context = buildProseContext(project, chapters[8], {
      preset: 'focused', templateContent: 'x'.repeat(11680), modelContextLength: 16000,
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
