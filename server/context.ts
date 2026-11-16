import type {
  Chapter,
  ContextLore,
  ContextLoreEntry,
  ContextPreset,
  ContextSection,
  LoreEntry,
  Project,
  StoryStateInfo,
} from '../shared/types.js';
import { CONTEXT_PRESETS } from '../shared/types.js';
import { countWords, estimateTokens } from '../shared/utils.js';
import { currentChapterText, listChapters } from './store/chapters.js';
import { latestOutlineRevision } from './store/outline.js';
import { memoryForPrompt } from './store/memory.js';
import { listLoreEntries } from './store/lore.js';
import { conflict } from './errors.js';
import { FALLBACK_CONTEXT_LENGTH } from './request-context.js';
import { automaticChapterReplyTokens } from './chapter-stream.js';
import { inspectStoryState } from './store/story-state.js';
import { selectStandingReferences, selectStoryReferences, referenceCharacterText, referenceFactText } from './story-references.js';

export interface ProseContext {
  storyState: StoryStateInfo;
  recentProse: string;
  memoryText: string;
  standingReferencesText: string;
  loreText: string;
  lore: ContextLore;
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
  modelMaxOutputTokens?: number;
}

// Raw prose provides the immediate handoff; summaries and facts carry the story
// beyond that. Never fill spare context with the entire manuscript.
const RECENT_PROSE_TOKENS: Record<ContextPreset, number> = {
  focused: 300,
  balanced: 500,
  broad: 650,
};

export function presetBudget(preset: ContextPreset): number {
  return CONTEXT_PRESETS.find((entry) => entry.id === preset)?.budgetTokens ?? 8000;
}

function projectFixedText(project: Project, brief: string, additionalInstructions: string): string {
  return [
    project.title,
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

function loreShare(preset: ContextPreset): number {
  if (preset === 'focused') return 0.16;
  if (preset === 'broad') return 0.24;
  return 0.2;
}

const LORE_TOKEN_CAP = 600;

/** Whole-word, case-insensitive keyword match against a lowercased haystack. */
export function triggerMatches(trigger: string, haystack: string): boolean {
  const needle = trigger.trim().toLowerCase();
  if (!needle) return false;
  if (/\s/.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

function loreBlock(entry: LoreEntry): string {
  return `### ${entry.title}\n${entry.content}`;
}

function loreHaystack(
  chapter: Chapter,
  additionalInstructions: string,
  chapters: Chapter[],
): string {
  const preceding = chapters
    .filter((entry) => entry.orderIndex < chapter.orderIndex && entry.currentRevisionId)
    .slice(-1)[0];
  const recent = preceding ? currentChapterText(preceding.id).slice(-6000) : '';
  return `${chapter.brief}\n${additionalInstructions}\n${recent}`.toLowerCase();
}

/**
 * Activate lore entries from the chapter brief, extra instructions, and a
 * bounded tail of recent prose. Manual pins win, then always-include entries,
 * then keyword matches ordered by priority. Entries that do not fit the lore
 * budget are reported rather than silently truncated.
 */
function buildLoreContext(
  project: Project,
  chapter: Chapter,
  additionalInstructions: string,
  chapters: Chapter[],
  preset: ContextPreset,
  availableInputTokens: number,
): { text: string; standingText: string; dynamicText: string; lore: ContextLore } {
  const all = listLoreEntries(project.id);
  const enabled = all.filter((entry) => entry.enabled);
  const haystack = loreHaystack(chapter, additionalInstructions, chapters);
  const reasonRank: Record<string, number> = { manual: 0, always: 1, keyword: 2 };

  type TriggeredLore = {
    entry: LoreEntry;
    matched: string[];
    reason: ContextLoreEntry['reason'];
    tokens: number;
  };

  const triggered = enabled
    .map((entry): TriggeredLore | null => {
      const matched = entry.triggers.filter((trigger) => triggerMatches(trigger, haystack));
      const reason: ContextLoreEntry['reason'] | null = entry.pinned
        ? 'manual'
        : entry.alwaysInclude
          ? 'always'
          : matched.length > 0
            ? 'keyword'
            : null;
      if (!reason) return null;
      return { entry, matched, reason, tokens: estimateTokens(loreBlock(entry)) };
    })
    .filter((item): item is TriggeredLore => item !== null)
    .sort((a, b) => {
      const byReason = reasonRank[a.reason] - reasonRank[b.reason];
      if (byReason !== 0) return byReason;
      if (a.reason === 'keyword' && b.matched.length !== a.matched.length) return b.matched.length - a.matched.length;
      if (b.entry.priority !== a.entry.priority) return b.entry.priority - a.entry.priority;
      return a.entry.title.localeCompare(b.entry.title) || a.entry.id.localeCompare(b.entry.id);
    });

  const budgetTokens = Math.min(
    LORE_TOKEN_CAP,
    Math.floor(availableInputTokens * loreShare(preset)),
  );
  const kept: TriggeredLore[] = [];
  const omitted: TriggeredLore[] = [];
  let usedTokens = 0;
  for (const item of triggered) {
    if (usedTokens + item.tokens > budgetTokens) {
      omitted.push({ ...item, reason: 'budget' });
      continue;
    }
    kept.push(item);
    usedTokens += item.tokens;
  }

  const entries: ContextLoreEntry[] = [
    ...kept.map((item) => ({
      id: item.entry.id,
      title: item.entry.title,
      lorebookName: item.entry.lorebookName,
      tokens: item.tokens,
      reason: item.reason,
      matched: item.matched,
    })),
    ...omitted.map((item) => ({
      id: item.entry.id,
      title: item.entry.title,
      lorebookName: item.entry.lorebookName,
      tokens: item.tokens,
      reason: 'budget' as const,
      matched: item.matched,
    })),
  ];

  const text =
    kept.length > 0
      ? `## Lore\n\n${kept.map((item) => loreBlock(item.entry)).join('\n\n')}`
      : '';

  return {
    text,
    standingText: kept.filter((item) => item.entry.alwaysInclude)
      .sort((a, b) => b.entry.priority - a.entry.priority || a.entry.title.localeCompare(b.entry.title) || a.entry.id.localeCompare(b.entry.id))
      .map((item) => loreBlock(item.entry)).join('\n\n'),
    dynamicText: kept.filter((item) => !item.entry.alwaysInclude).map((item) => loreBlock(item.entry)).join('\n\n'),
    lore: {
      entries,
      activated: kept.length,
      omitted: omitted.length,
      totalEntries: all.length,
      triggeredEntries: triggered.length,
      budgetTokens,
      usedTokens,
    },
  };
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
  const reservedOutputTokens = options.maxTokens ?? automaticChapterReplyTokens(
    targetWords, options.modelContextLength, options.modelMaxOutputTokens,
  );

  const requiredText = projectFixedText(
    project,
    `${chapter.title}\n${chapter.brief}`,
    options.additionalInstructions ?? '',
  );
  const coreTokens =
    estimateTokens(requiredText) + estimateTokens(options.templateContent ?? '');
  const storyState = inspectStoryState(project.id, chapter.orderIndex).info;
  const stateTokens = estimateTokens(storyState.text ? `## Current story state\n${storyState.text}` : '');
  const requiredTokens = coreTokens + stateTokens;
  const modelContextLength =
    options.modelContextLength && options.modelContextLength > 0
      ? options.modelContextLength
      : FALLBACK_CONTEXT_LENGTH;

  const warnings: string[] = [];
  let availableInputTokens = presetTokens;
  if (!options.modelContextLength) {
    warnings.push("The selected model's context window is unknown. A conservative 16,000-token window is used, including space for the reply. Token counts are estimates.");
  }
  if (modelContextLength) {
    // Token counts are approximate, and chat framing and the final user message
    // also occupy context. Leave room beyond the requested output allowance.
    const safetyTokens = Math.max(256, Math.ceil(modelContextLength * 0.05));
    const modelInput = modelContextLength - reservedOutputTokens - safetyTokens;
    if (modelInput <= 0) {
      throw conflict(
        `The selected model has a ${modelContextLength.toLocaleString()}-token context, but about ${reservedOutputTokens.toLocaleString()} tokens must be reserved for the reply plus ${safetyTokens.toLocaleString()} for estimation and message overhead. Choose a model with a larger context window or lower the target length and max output tokens.`,
      );
    }
    if (modelInput < presetTokens) {
      availableInputTokens = modelInput;
      warnings.push(
        `The model's ${modelContextLength.toLocaleString()}-token window limits input to about ${modelInput.toLocaleString()} tokens after reserving ${reservedOutputTokens.toLocaleString()} for the reply and ${safetyTokens.toLocaleString()} for token estimation and message overhead.`,
      );
    }
  }

  if (requiredTokens > availableInputTokens) {
    const presetLabel = CONTEXT_PRESETS.find((entry) => entry.id === preset)?.label ?? preset;
    if (modelContextLength && availableInputTokens < presetTokens) {
      throw conflict(
        `This chapter's brief, instructions and prompt need about ${requiredTokens.toLocaleString()} input tokens, but the selected model's ${modelContextLength.toLocaleString()}-token context allows about ${availableInputTokens.toLocaleString()} after reserving ${reservedOutputTokens.toLocaleString()} for the reply and allowing for estimation and message overhead. Choose a larger-context model or shorten the brief, project instructions, and generation instructions.`,
      );
    }
    throw conflict(
      `This chapter's brief, instructions and prompt need about ${requiredTokens.toLocaleString()} input tokens, which is more than the ${presetLabel} preset's ${availableInputTokens.toLocaleString()}-token input budget. Choose a broader preset or shorten the brief, project instructions, and generation instructions.`,
    );
  }

  const remaining = availableInputTokens - requiredTokens;
  const chapters = listChapters(project.id);
  const loreContext = buildLoreContext(
    project,
    chapter,
    options.additionalInstructions ?? '',
    chapters,
    preset,
    remaining,
  );
  const useStanding = !options.templateContent || /\{\{\s*standing_references\s*\}\}/.test(options.templateContent);
  const loreText = useStanding ? loreContext.dynamicText : loreContext.text;
  const lore = loreContext.lore;
  const loreTokens = estimateTokens(loreContext.text);
  const memory = memoryForPrompt(project.id, chapter.id, { includeSummaries: false });
  const memoryBudget = Math.min(1400, Math.floor(Math.max(0, remaining - loreTokens) * memoryShare(preset)));
  const standing = useStanding ? selectStandingReferences(memory.characters, memory.facts) : { characters: [], facts: [] };
  // Keep the baseline whole. Under tight budgets fall back to query-based retrieval.
  const standingMemoryText = () => [
    standing.characters.length ? `### Standing character profiles\n${standing.characters.map(referenceCharacterText).join('\n\n')}` : '',
    standing.facts.length ? `### Standing world facts\n${standing.facts.map(referenceFactText).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  while (estimateTokens(standingMemoryText()) > memoryBudget && (standing.characters.length || standing.facts.length)) {
    if (standing.facts.length) standing.facts.pop();
    else standing.characters.pop();
  }
  const standingCharacterIds = new Set(standing.characters.map((entry) => entry.id));
  const standingFactIds = new Set(standing.facts.map((entry) => entry.id));
  const standingTokens = estimateTokens(standingMemoryText());
  const dynamicMemoryBudget = Math.max(0, memoryBudget - standingTokens);
  const standingReferencesText = [standingMemoryText(), loreContext.standingText ? `### Standing lore\n${loreContext.standingText}` : '']
    .filter(Boolean).join('\n\n');
  const selected = selectStoryReferences({ chapter, additionalInstructions: options.additionalInstructions,
    state: storyState.text, characters: memory.characters.filter((entry) => !standingCharacterIds.has(entry.id)),
    facts: memory.facts.filter((entry) => !standingFactIds.has(entry.id)), preset,
    characterBudget: Math.max(0, Math.min(650 - estimateTokens(standing.characters.map(referenceCharacterText).join('\n\n')), Math.floor(dynamicMemoryBudget / 2))),
    factBudget: Math.max(0, Math.min(650 - estimateTokens(standing.facts.map(referenceFactText).join('\n')), Math.floor(dynamicMemoryBudget / 2))),
  });
  let keptCharacters = selected.characters;
  let keptFacts = selected.facts;
  const renderMemory = () => [
    keptCharacters.length ? `### Relevant characters\n${keptCharacters.map(referenceCharacterText).join('\n\n')}` : '',
    keptFacts.length ? `### Relevant continuity facts\n${keptFacts.map(referenceFactText).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  let memoryText = renderMemory();
  while (estimateTokens(memoryText) > dynamicMemoryBudget && (keptFacts.length || keptCharacters.length)) {
    if (keptFacts.length) keptFacts = keptFacts.slice(0, -1);
    else keptCharacters = keptCharacters.slice(0, -1);
    memoryText = renderMemory();
  }
  const memoryTokens = estimateTokens(memoryText) + standingTokens;
  const includedCharacters = keptCharacters.length + standing.characters.length;
  const includedFacts = keptFacts.length + standing.facts.length;
  const omittedCharacters = memory.characters.length - includedCharacters;
  const omittedFacts = memory.facts.length - includedFacts;
  if (storyState.status === 'missing' || storyState.status === 'stale') {
    warnings.push('Story state is missing or outdated. It will be rebuilt in chapter order before drafting; earlier chapter summaries are never appended to the prose prompt.');
  }
  if (memory.pendingFacts > 0) {
    warnings.push(
      `${memory.pendingFacts} proposed ${
        memory.pendingFacts === 1 ? 'fact is' : 'facts are'
      } awaiting review and excluded from context.`,
    );
  }
  if (lore.omitted > 0) {
    warnings.push(
      `${lore.omitted} activated lore ${
        lore.omitted === 1 ? 'entry did' : 'entries did'
      } not fit the ${Math.round(loreShare(preset) * 100)}% lore budget. Raise the preset or shorten the entries to include them.`,
    );
  }

  const proseTokens = Math.min(
    RECENT_PROSE_TOKENS[preset],
    Math.max(0, remaining - loreTokens - memoryTokens),
  );
  const preceding = chapters.filter(
    (entry) => entry.orderIndex < chapter.orderIndex && entry.currentRevisionId && entry.status === 'drafted',
  );
  const previous = preceding.at(-1);
  const previousText = previous ? currentChapterText(previous.id).trim() : '';
  const heading = previous ? `### Previous chapter — ${previous.title}\n` : '';
  const tailHeading = `${heading}[Ending excerpt; earlier prose omitted.]\n`;
  let recentProse = '';
  let proseText = '';
  let proseTrimmed = false;
  if (previousText) {
    if (estimateTokens(heading + previousText) <= proseTokens) {
      proseText = previousText;
      recentProse = heading + proseText;
    } else {
      // Count the heading and omission marker inside the cap. Preserve the
      // ending even when the chapter is a single very long paragraph.
      const tailChars = proseTokens * 4 - tailHeading.length;
      if (tailChars >= 100) {
        proseText = previousText.slice(-tailChars);
        const boundary = proseText.search(/\s/);
        if (boundary >= 0) proseText = proseText.slice(boundary + 1).trimStart();
        recentProse = tailHeading + proseText;
        proseTrimmed = true;
      }
    }
  }
  const includedChapters = recentProse ? 1 : 0;
  const omittedChapters = preceding.length - includedChapters;
  if (previousText && !recentProse) {
    warnings.push('Recent prose was omitted to keep the required context within the budget.');
  }
  const proseTokensActual = estimateTokens(recentProse);
  const includedWords = countWords(proseText);

  const sections: ContextSection[] = [
    {
      id: 'instructions',
      label: 'Required instructions',
      tokens: coreTokens,
      included: true,
      detail: 'Project metadata, standing instructions, this chapter brief, extra instructions, and prompt template.',
    },
    {
      id: 'lore',
      label: 'Lore',
      tokens: loreTokens,
      included: lore.activated > 0,
      detail:
        `${lore.activated} of ${lore.totalEntries} ${
          lore.totalEntries === 1 ? 'entry' : 'entries'
        } activated${lore.omitted > 0 ? `, ${lore.omitted} over budget` : ''}` +
        `${lore.entries.some((entry) => entry.reason === 'manual') ? '; includes manually pinned entries' : ''}.`,
      note:
        lore.omitted > 0
          ? `${lore.omitted} activated ${lore.omitted === 1 ? 'entry was' : 'entries were'} excluded by the lore budget.`
          : undefined,
    },
    {
      id: 'story-state',
      label: 'Current story state',
      tokens: stateTokens,
      included: storyState.status === 'current',
      detail: storyState.status === 'current'
        ? `One compact checkpoint through Chapter ${storyState.throughChapterNumber}; no preceding chapter summary list.`
        : storyState.status === 'empty' ? 'Opening chapter: no earlier story state.' : 'Checkpoint will be rebuilt before drafting.',
      note: storyState.status === 'stale' ? 'Earlier manuscript text or summaries changed; the old checkpoint is excluded.' : undefined,
    },
    {
      id: 'characters',
      label: 'Characters',
      tokens: estimateTokens([...standing.characters, ...keptCharacters].map(referenceCharacterText).join('\n\n')),
      included: includedCharacters > 0,
      detail: `${includedCharacters} of ${memory.characters.length} active ${
        memory.characters.length === 1 ? 'profile' : 'profiles'
      } included${omittedCharacters > 0 ? `, ${omittedCharacters} omitted` : ''}.`,
    },
    {
      id: 'facts',
      label: 'Continuity facts',
      tokens: estimateTokens([...standing.facts, ...keptFacts].map(referenceFactText).join('\n')),
      included: includedFacts > 0,
      detail: `${includedFacts} of ${memory.facts.length} established ${
        memory.facts.length === 1 ? 'fact' : 'facts'
      } included${omittedFacts > 0 ? `, ${omittedFacts} omitted` : ''}` +
        `${memory.pendingFacts > 0 ? `; ${memory.pendingFacts} proposed awaiting review` : ''}.`,
      note:
        memory.facts.some((fact) => fact.sourceOutdated)
          ? 'Facts from outdated source revisions are excluded until reviewed.'
          : undefined,
    },
    {
      id: 'recent-prose',
      label: 'Recent prose',
      tokens: proseTokensActual,
      included: includedChapters > 0,
      detail:
        includedChapters > 0
          ? `${proseTrimmed ? 'Ending excerpt from' : 'Text from'} the preceding drafted chapter; ${omittedChapters} older chapters excluded from raw prose. Earlier continuity uses the compact story state and selected facts.`
          : preceding.length > 0
            ? 'Preceding prose omitted by the context budget.'
            : 'No preceding prose yet.',
    },
  ];

  return {
    storyState,
    recentProse,
    memoryText,
    standingReferencesText: useStanding ? standingReferencesText : '',
    loreText,
    lore,
    includedChapters,
    omittedChapters,
    includedWords,
    fixedTokens: requiredTokens,
    budgetTokens: presetTokens,
    reservedOutputTokens,
    availableInputTokens,
    requiredTokens,
    estimatedTokens: requiredTokens + loreTokens + memoryTokens + proseTokensActual,
    preset,
    sections,
    warnings,
    staleSummaries: 0,
    pendingFacts: memory.pendingFacts,
    includedSummaries: 0,
    totalSummaries: 0,
    includedCharacters,
    totalCharacters: memory.characters.length,
    includedFacts,
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
