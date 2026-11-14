import type { Chapter, ContextPreset, Project } from '../shared/types.js';
import { CONTEXT_PRESETS } from '../shared/types.js';
import { countWords, estimateTokens } from '../shared/utils.js';
import { currentChapterText, listChapters } from './store/chapters.js';
import { latestOutlineRevision } from './store/outline.js';

export interface ProseContext {
  recentProse: string;
  includedChapters: number;
  omittedChapters: number;
  includedWords: number;
  fixedTokens: number;
  budgetTokens: number;
  estimatedTokens: number;
  preset: ContextPreset;
}

const OMITTED_MARKER = '[Earlier story context was trimmed to fit the selected context preset.]\n\n';

export function presetBudget(preset: ContextPreset): number {
  return CONTEXT_PRESETS.find((entry) => entry.id === preset)?.budgetTokens ?? 6000;
}

function projectFixedText(project: Project, brief: string): string {
  return [
    project.premise,
    project.genre,
    project.tone,
    project.pov,
    project.tense,
    project.styleNotes,
    project.contentPreferences,
    project.instructions,
    brief,
  ].join('\n');
}

export function buildProseContext(
  project: Project,
  chapter: Chapter,
  preset: ContextPreset,
): ProseContext {
  const budgetTokens = presetBudget(preset);
  const fixedTokens = estimateTokens(projectFixedText(project, chapter.brief));
  const availableTokens = Math.max(400, budgetTokens - fixedTokens);
  const availableChars = availableTokens * 4;

  const chapters = listChapters(project.id).filter(
    (entry) => entry.orderIndex < chapter.orderIndex && entry.currentRevisionId,
  );

  const pieces: Array<{ title: string; text: string }> = [];
  for (const entry of chapters) {
    const text = currentChapterText(entry.id);
    if (text.trim()) pieces.push({ title: entry.title, text });
  }

  let combined = pieces
    .map((piece, index) => `### Previous chapter — ${piece.title}\n${piece.text.trim()}`)
    .join('\n\n');

  let omittedChapters = 0;
  if (combined.length > availableChars) {
    const keepFrom = combined.length - availableChars;
    const boundary = combined.indexOf('\n', keepFrom);
    combined = combined.slice(boundary === -1 ? keepFrom : boundary + 1);
    combined = OMITTED_MARKER + combined;
    const headingsKept = (combined.match(/^### Previous chapter/gm) ?? []).length;
    omittedChapters = Math.max(1, pieces.length - headingsKept);
  }

  const includedWords = countWords(combined);
  return {
    recentProse: combined || '(This is the opening chapter. There is no preceding prose yet.)',
    includedChapters: Math.max(0, pieces.length - omittedChapters),
    omittedChapters,
    includedWords,
    fixedTokens,
    budgetTokens,
    estimatedTokens: fixedTokens + estimateTokens(combined),
    preset,
  };
}

export function buildChatChapterContext(chapter: Chapter): string {
  const text = currentChapterText(chapter.id);
  if (!text.trim()) {
    return `Chapter ${chapter.orderIndex + 1}: ${chapter.title}\nBrief: ${chapter.brief || '(none)'}\nThe chapter has no drafted text yet.`;
  }
  const excerpt = text.length > 6000 ? text.slice(-6000) : text;
  return `Chapter ${chapter.orderIndex + 1}: ${chapter.title}\nBrief: ${chapter.brief || '(none)'}\nMost recent manuscript text:\n${excerpt}`;
}

export function approvedOutlineText(projectId: string): string {
  const latest = latestOutlineRevision(projectId);
  if (!latest || latest.status !== 'approved') return '';
  return latest.chapters
    .map((chapter, index) => `${index + 1}. ${chapter.title} — ${chapter.brief}`)
    .join('\n');
}
