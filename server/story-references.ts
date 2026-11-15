import type { Chapter, Character, ContextPreset, Fact } from '../shared/types.js';
import { estimateTokens } from '../shared/utils.js';

const STOP_WORDS = new Set('the and but for with from into that this they them their then when where which while what have has had was were will would could should does did not her she him his who how chapter story scene next continue before after about through'.split(' '));
function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 3 && !STOP_WORDS.has(word)));
}
function overlap(text: string, query: Set<string>): number {
  return [...words(text)].filter((word) => query.has(word)).length;
}
function nameMentioned(name: string, text: string): boolean {
  const tokens = words(name);
  const haystack = words(text);
  return [...tokens].some((token) => haystack.has(token));
}

export function referenceCharacterText(character: Character): string {
  return [`### ${character.name}${character.role ? ` — ${character.role}` : ''}`,
    ...(['identity', 'appearance', 'personality', 'goals', 'relationships'] as const)
      .flatMap((key) => character[key] ? [`${key}: ${character[key].slice(0, 220)}`] : []),
  ].join('\n');
}
export function referenceFactText(fact: Fact): string {
  return `- [${fact.factClass === 'plan' ? 'Plan' : fact.factClass === 'authored' ? 'World fact' : 'Established'}] ${fact.statement}${fact.chapterOrder === null ? '' : ` (Chapter ${fact.chapterOrder + 1})`}`;
}

function selectWithin<T>(ranked: T[], cap: number, count: number, render: (item: T) => string): T[] {
  const selected: T[] = [];
  let tokens = 0;
  for (const item of ranked) {
    const cost = estimateTokens(render(item)) + 2;
    if (cost + tokens > cap) continue;
    selected.push(item);
    tokens += cost;
    if (selected.length >= count) break;
  }
  return selected;
}

/** Retrieve chapter-specific references, with fixed count and token ceilings. */
export function selectStoryReferences(options: {
  chapter: Chapter; additionalInstructions?: string; state: string; characters: Character[]; facts: Fact[];
  preset: ContextPreset; characterBudget?: number; factBudget?: number;
}) {
  const queryText = `${options.chapter.title}\n${options.chapter.brief}\n${options.additionalInstructions ?? ''}`;
  const query = words(queryText);
  const stateQuery = words(options.state);
  const characterScores = options.characters.map((character) => ({ character, score:
    (nameMentioned(character.name, queryText) ? 20 : 0) + (nameMentioned(character.name, options.state) ? 3 : 0),
  })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.character.name.localeCompare(b.character.name));
  const characters = selectWithin(characterScores.map((entry) => entry.character), options.characterBudget ?? 650,
    options.preset === 'focused' ? 3 : options.preset === 'broad' ? 6 : 4, referenceCharacterText);
  const names = new Set(characters.map((character) => character.id));
  const eligibleFacts = options.facts.filter((fact) => fact.status === 'established' && !fact.sourceOutdated &&
    (fact.chapterOrder === null || fact.chapterOrder < options.chapter.orderIndex) &&
    (!fact.scopeChapterId || fact.scopeChapterId === options.chapter.id) &&
    (fact.factClass !== 'plan' || fact.scopeChapterId === options.chapter.id));
  const factsRanked = eligibleFacts.map((fact) => ({ fact, score:
    (fact.scopeChapterId === options.chapter.id ? 100 : 0) + overlap(fact.statement, query) * 5 +
    Math.min(3, overlap(fact.statement, stateQuery)) + (fact.characterId && names.has(fact.characterId) ? 2 : 0),
  })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score ||
    (b.fact.chapterOrder ?? -1) - (a.fact.chapterOrder ?? -1) || a.fact.id.localeCompare(b.fact.id));
  const facts = selectWithin(factsRanked.map((entry) => entry.fact), options.factBudget ?? 650,
    options.preset === 'focused' ? 4 : options.preset === 'broad' ? 10 : 7, referenceFactText);
  return { characters, facts, eligibleFacts };
}
