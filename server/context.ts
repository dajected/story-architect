import type {
  Chapter,
  Character,
  ContextPreset,
  ContextSection,
  Fact,
  Project,
} from '../shared/types.js';
import { CONTEXT_PRESETS } from '../shared/types.js';
import { countWords, estimateTokens } from '../shared/utils.js';
import { currentChapterText, listChapters } from './store/chapters.js';
import { latestOutlineRevision } from './store/outline.js';
import { memoryForPrompt } from './store/memory.js';
import { conflict } from './errors.js';

export interface ProseContext {
  recentProse: string;
  memoryText: string;
  includedChapters: number;
  omittedChapters: number;
  includedWords: number;
  fixedTokens: number;
  budgetTokens: number;
  reservedOutputTokens: number;
  availableInputTokens: number;
  requiredTokens: number;
  estimatedTokens: number;
  preset: ContextPreset;
  sections: ContextSection[];
  warnings: string[];
  staleSummaries: number;
  pendingFacts: number;
  includedSummaries: number;
  totalSummaries: number;
  includedCharacters: number;
  totalCharacters: number;
  includedFacts: number;
  totalFacts: number;
}

export interface ContextBuildOptions {
  preset: ContextPreset;
  additionalInstructions?: string;
  targetWords?: number | null;
  templateContent?: string;
  modelContextLength?: number | null;
  maxTokens?: number | null;
}

const OMITTED_MARKER = '[Earlier story context was trimmed to fit the selected context preset.]\n\n';

export function presetBudget(preset: ContextPreset): number {
  return CONTEXT_PRESETS.find((entry) => entry.id === preset)?.budgetTokens ?? 8000;
}

function projectFixedText(project: Project, brief: string, additionalInstructions: string): string {
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
    additionalInstructions,
  ].join('\n');
}

function memoryShare(preset: ContextPreset): number {
  if (preset === 'focused') return 0.45;
  if (preset === 'broad') return 0.55;
  return 0.5;
}

function takeWithin<T>(items: T[], capTokens: number, text: (item: T) => string): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(text(item));
    if (used + cost > capTokens && kept.length > 0) break;
    kept.push(item);
    used += cost;
  }
  return kept;
}

function summaryBlock(entry: {
  chapterTitle: string;
  orderIndex: number;
  summary: string;
  stale: boolean;
  staleReasons: string[];
}): string {
  return [
    `### Chapter ${entry.orderIndex + 1} — ${entry.chapterTitle}`,
    entry.summary,
    entry.stale
      ? `[Summary may be outdated: ${entry.staleReasons.join('; ')}.]`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function relevanceScore(
  character: Character,
  brief: string,
  summaries: Array<{ summary: string }>,
  facts: Fact[],
): number {
  const haystack = `${brief}\n${summaries
    .slice(-3)
    .map((entry) => entry.summary)
    .join('\n')}`.toLowerCase();
  const name = character.name.toLowerCase();
  let score = 0;
  if (name && haystack.includes(name)) score += 3;
  if (facts.some((fact) => fact.characterId === character.id)) score += 2;
  if (/protagonist|antagonist|pov|main/i.test(character.role)) score += 1;
  return score;
}

function characterBlock(character: Character): string {
  const lines = [`### ${character.name}${character.role ? ` — ${character.role}` : ''}`];
  if (character.identity) lines.push(`Identity: ${character.identity}`);
  if (character.appearance) lines.push(`Appearance: ${character.appearance}`);
  if (character.personality) lines.push(`Personality: ${character.personality}`);
  if (character.goals) lines.push(`Goals: ${character.goals}`);
  if (character.relationships) lines.push(`Relationships: ${character.relationships}`);
  if (character.notes) lines.push(`Notes: ${character.notes}`);
  return lines.join('\n');
}

function factLine(fact: Fact): string {
  const label =
    fact.factClass === 'plan' ? 'Plan' : fact.factClass === 'authored' ? 'World fact' : 'Established';
  const provenance = fact.chapterOrder === null ? '' : ` (Chapter ${fact.chapterOrder + 1})`;
  const stale = fact.sourceOutdated ? ' [source text changed; review before relying on it]' : '';
  return `- [${label}] ${fact.statement}${fact.characterName ? ` — ${fact.characterName}` : ''}${provenance}${stale}`;
}

/**
 * Assemble the prose context from required instructions, derived memory, and
 * recent prose. Required content that cannot fit is rejected with an
 * explanation instead of being dropped silently.
 */
export function buildProseContext(
  project: Project,
  chapter: Chapter,
  options: ContextBuildOptions,
): ProseContext {
  const preset = options.preset;
  const presetTokens = presetBudget(preset);
  const targetWords = options.targetWords ?? project.targetChapterWords ?? 1800;
  const reservedOutputTokens = Math.max(
    800,
    Math.round(options.maxTokens ?? targetWords * 1.5),
  );

  const requiredText = projectFixedText(
    project,
    chapter.brief,
    options.additionalInstructions ?? '',
  );
  const requiredTokens =
    estimateTokens(requiredText) + estimateTokens(options.templateContent ?? '');
  const modelContextLength =
    options.modelContextLength && options.modelContextLength > 0
      ? options.modelContextLength
      : null;

  const warnings: string[] = [];
  let availableInputTokens = presetTokens;
  if (modelContextLength) {
    const modelInput = modelContextLength - reservedOutputTokens;
    if (modelInput <= 0) {
      throw conflict(
        `The selected model has a ${modelContextLength.toLocaleString()}-token context, but about ${reservedOutputTokens.toLocaleString()} tokens must be reserved for the reply. Choose a model with a larger context window or lower the target length and max output tokens.`,
      );
    }
    if (modelInput < presetTokens) {
      availableInputTokens = modelInput;
      warnings.push(
        `The model's ${modelContextLength.toLocaleString()}-token window limits input to about ${modelInput.toLocaleString()} tokens after reserving ${reservedOutputTokens.toLocaleString()} for the reply.`,
      );
    }
  } else {
    warnings.push(
      "The selected model's context window is unknown, so the preset budget alone is used. Token counts are estimates.",
    );
  }

  if (requiredTokens > availableInputTokens) {
    const presetLabel = CONTEXT_PRESETS.find((entry) => entry.id === preset)?.label ?? preset;
    if (modelContextLength && requiredTokens + reservedOutputTokens > modelContextLength) {
      throw conflict(
        `This chapter's brief, instructions and prompt need about ${requiredTokens.toLocaleString()} input tokens, plus about ${reservedOutputTokens.toLocaleString()} reserved for the reply. That exceeds the selected model's ${modelContextLength.toLocaleString()}-token context. Choose a larger-context model or shorten the brief, project instructions, and generation instructions.`,
      );
    }
    throw conflict(
      `This chapter's brief, instructions and prompt need about ${requiredTokens.toLocaleString()} input tokens, which is more than the ${presetLabel} preset's ${availableInputTokens.toLocaleString()}-token input budget. Choose a broader preset or shorten the brief, project instructions, and generation instructions.`,
    );
  }

  const remaining = availableInputTokens - requiredTokens;
  const memory = memoryForPrompt(project.id, chapter.id);
  const memoryBudget = Math.floor(remaining * memoryShare(preset));

  const summaryCap = Math.floor(memoryBudget * 0.45);
  const characterCap = Math.floor(memoryBudget * 0.3);
  const factCap = Math.max(0, memoryBudget - summaryCap - characterCap);
  const chapters = listChapters(project.id);

  // Most recent summaries are the most useful, but render them chronologically.
  const summariesRecentFirst = [...memory.summaries].reverse();
  let keptSummaries = takeWithin(summariesRecentFirst, summaryCap, summaryBlock).reverse();
  let omittedSummaries = memory.summaries.length - keptSummaries.length;

  const rankedCharacters = [...memory.characters].sort((a, b) => {
    const diff =
      relevanceScore(b, chapter.brief, memory.summaries, memory.facts) -
      relevanceScore(a, chapter.brief, memory.summaries, memory.facts);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
  let keptCharacters = takeWithin(rankedCharacters, characterCap, characterBlock);
  let omittedCharacters = memory.characters.length - keptCharacters.length;

  const factsByRecency = [...memory.facts].sort(
    (a, b) => (b.chapterOrder ?? -1) - (a.chapterOrder ?? -1),
  );
  let keptFacts = takeWithin(factsByRecency, factCap, factLine).sort((a, b) => {
    if ((a.chapterOrder ?? -1) !== (b.chapterOrder ?? -1)) {
      return (a.chapterOrder ?? -1) - (b.chapterOrder ?? -1);
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
  let omittedFacts = memory.facts.length - keptFacts.length;

  const renderMemory = (): string => {
    const memoryParts: string[] = [];
    if (keptSummaries.length > 0) {
      const body = keptSummaries.map(summaryBlock).join('\n\n');
      memoryParts.push(
        `### Chapter summaries${
          omittedSummaries > 0
            ? ` (${omittedSummaries} earlier ${omittedSummaries === 1 ? 'summary' : 'summaries'} omitted to fit the preset)`
            : ''
        }\n${body}`,
      );
    } else if (memory.summaries.length > 0) {
      memoryParts.push(
        `### Chapter summaries\n(${memory.summaries.length} summaries omitted to fit the preset budget.)`,
      );
    }
    if (keptCharacters.length > 0) {
      memoryParts.push(
        `### Characters${
          omittedCharacters > 0
            ? ` (${omittedCharacters} other ${omittedCharacters === 1 ? 'character' : 'characters'} omitted to fit the preset)`
            : ''
        }\n${keptCharacters.map(characterBlock).join('\n\n')}`,
      );
    }
    if (keptFacts.length > 0) {
      memoryParts.push(
        `### Continuity facts${
          omittedFacts > 0
            ? ` (${omittedFacts} older ${omittedFacts === 1 ? 'fact' : 'facts'} omitted to fit the preset)`
            : ''
        }\n${keptFacts.map(factLine).join('\n')}`,
      );
    }
    return memoryParts.length > 0 ? `## Story memory\n\n${memoryParts.join('\n\n')}` : '';
  };

  let memoryText = renderMemory();
  // A single oversized profile or summary can exceed its own slice; shed lower
  // priority memory rather than silently overflowing the preset budget.
  if (estimateTokens(memoryText) > memoryBudget && keptFacts.length > 0) {
    keptFacts = [];
    omittedFacts = memory.facts.length;
    memoryText = renderMemory();
  }
  if (estimateTokens(memoryText) > memoryBudget && keptCharacters.length > 0) {
    keptCharacters = [];
    omittedCharacters = memory.characters.length;
    memoryText = renderMemory();
  }
  if (estimateTokens(memoryText) > memoryBudget && keptSummaries.length > 1) {
    keptSummaries = keptSummaries.slice(-1);
    omittedSummaries = memory.summaries.length - keptSummaries.length;
    memoryText = renderMemory();
  }
  if (estimateTokens(memoryText) > memoryBudget && keptSummaries.length > 0) {
    keptSummaries = [];
    omittedSummaries = memory.summaries.length;
    memoryText = renderMemory();
    warnings.push(
      'A single chapter summary was too large for the preset budget and was omitted. Rebuild memory with a shorter summary or choose a broader preset.',
    );
  }
  const memoryTokens = estimateTokens(memoryText);

  if (memory.staleSummaries > 0) {
    warnings.push(
      `${memory.staleSummaries} chapter ${
        memory.staleSummaries === 1 ? 'summary is' : 'summaries are'
      } marked outdated because the manuscript changed. Rebuild memory to refresh them.`,
    );
  }
  if (memory.pendingFacts > 0) {
    warnings.push(
      `${memory.pendingFacts} proposed ${
        memory.pendingFacts === 1 ? 'fact is' : 'facts are'
      } awaiting review and excluded from context.`,
    );
  }

  const proseTokens = Math.max(0, remaining - memoryTokens);
  const pieces: Array<{ title: string; text: string }> = [];
  for (const entry of chapters) {
    if (entry.orderIndex >= chapter.orderIndex || !entry.currentRevisionId) continue;
    const text = currentChapterText(entry.id);
    if (text.trim()) pieces.push({ title: entry.title, text });
  }

  let recentProse = pieces
    .map((piece) => `### Previous chapter — ${piece.title}\n${piece.text.trim()}`)
    .join('\n\n');
  const proseChars = proseTokens * 4;
  let omittedChapters = 0;
  if (recentProse.length > proseChars) {
    if (proseChars < 400) {
      recentProse = '';
    } else {
      const keepFrom = recentProse.length - proseChars;
      const boundary = recentProse.indexOf('\n', keepFrom);
      recentProse = recentProse.slice(boundary === -1 ? keepFrom : boundary + 1);
      recentProse = OMITTED_MARKER + recentProse;
    }
    const headingsKept = (recentProse.match(/^### Previous chapter/gm) ?? []).length;
    omittedChapters = Math.max(1, pieces.length - headingsKept);
    if (!recentProse) {
      omittedChapters = pieces.length;
      warnings.push('Recent prose was omitted to keep the required context within the budget.');
    }
  }
  if (!recentProse) {
    recentProse = pieces.length
      ? ''
      : '(This is the opening chapter. There is no preceding prose yet.)';
  }

  const includedChapters = Math.max(0, pieces.length - omittedChapters);
  const proseBody =
    recentProse ||
    (pieces.length > 0 ? '(Recent prose omitted to fit the selected context preset.)' : recentProse);
  const proseTokensActual = estimateTokens(proseBody);
  const includedWords = countWords(includedChapters > 0 ? recentProse : '');

  const sections: ContextSection[] = [
    {
      id: 'instructions',
      label: 'Required instructions',
      tokens: requiredTokens,
      included: true,
      detail: 'Project metadata, standing instructions, this chapter brief, extra instructions, and prompt template.',
    },
    {
      id: 'summaries',
      label: 'Chapter summaries',
      tokens: estimateTokens(keptSummaries.map(summaryBlock).join('\n\n')),
      included: keptSummaries.length > 0,
      detail: `${keptSummaries.length} of ${memory.summaries.length} preceding chapter ${
        memory.summaries.length === 1 ? 'summary' : 'summaries'
      } included${omittedSummaries > 0 ? `, ${omittedSummaries} omitted` : ''}.`,
      ...(memory.staleSummaries > 0
        ? { note: `${memory.staleSummaries} marked outdated by manuscript changes.` }
        : {}),
    },
    {
      id: 'characters',
      label: 'Characters',
      tokens: estimateTokens(keptCharacters.map(characterBlock).join('\n\n')),
      included: keptCharacters.length > 0,
      detail: `${keptCharacters.length} of ${memory.characters.length} active ${
        memory.characters.length === 1 ? 'profile' : 'profiles'
      } included${omittedCharacters > 0 ? `, ${omittedCharacters} omitted` : ''}.`,
    },
    {
      id: 'facts',
      label: 'Continuity facts',
      tokens: estimateTokens(keptFacts.map(factLine).join('\n')),
      included: keptFacts.length > 0,
      detail: `${keptFacts.length} of ${memory.facts.length} established ${
        memory.facts.length === 1 ? 'fact' : 'facts'
      } included${omittedFacts > 0 ? `, ${omittedFacts} omitted` : ''}` +
        `${memory.pendingFacts > 0 ? `; ${memory.pendingFacts} proposed awaiting review` : ''}.`,
      note:
        memory.facts.some((fact) => fact.sourceOutdated)
          ? 'Some facts come from an older revision of their source chapter and are labelled for review.'
          : undefined,
    },
    {
      id: 'recent-prose',
      label: 'Recent prose',
      tokens: proseTokensActual,
      included: includedChapters > 0,
      detail:
        includedChapters > 0
          ? `${includedChapters} preceding ${
              includedChapters === 1 ? 'chapter' : 'chapters'
            } included${omittedChapters > 0 ? `, ${omittedChapters} trimmed` : ''}.`
          : pieces.length > 0
            ? 'Preceding prose omitted or trimmed by the context budget.'
            : 'No preceding prose yet.',
    },
  ];

  return {
    recentProse: recentProse || '(No preceding prose is included for this chapter.)',
    memoryText,
    includedChapters,
    omittedChapters,
    includedWords,
    fixedTokens: requiredTokens,
    budgetTokens: presetTokens,
    reservedOutputTokens,
    availableInputTokens,
    requiredTokens,
    estimatedTokens: requiredTokens + memoryTokens + proseTokensActual,
    preset,
    sections,
    warnings,
    staleSummaries: memory.staleSummaries,
    pendingFacts: memory.pendingFacts,
    includedSummaries: keptSummaries.length,
    totalSummaries: memory.summaries.length,
    includedCharacters: keptCharacters.length,
    totalCharacters: memory.characters.length,
    includedFacts: keptFacts.length,
    totalFacts: memory.facts.length,
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
