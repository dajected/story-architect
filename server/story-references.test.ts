import { describe, expect, it } from 'vitest';
import type { Chapter, Character, Fact } from '../shared/types.js';
import { estimateTokens } from '../shared/utils.js';
import { referenceCharacterText, referenceFactText, selectStandingReferences, selectStoryReferences } from './story-references.js';

const chapter: Chapter = { id: 'next', projectId: 'novel', orderIndex: 30, title: 'The North Door',
  brief: 'Mara uses the brass key to open the north door.', briefApproved: true, status: 'planned',
  wordCount: 0, currentRevisionId: null, updatedAt: '' };
const fact = (id: string, statement: string, extra: Partial<Fact> = {}): Fact => ({
  id, projectId: 'novel', statement, kind: 'world', factClass: 'established', characterId: null,
  characterName: null, chapterId: 'old', chapterTitle: 'Old Chapter', chapterOrder: 0,
  scopeChapterId: null, scopeChapterTitle: null, scopeChapterOrder: null, sourceRevisionId: 'revision',
  sourceOutdated: false, status: 'established', origin: 'extracted', acceptedAt: '', createdAt: '', updatedAt: '', ...extra,
});
const character = (name: string, extra: Partial<Character> = {}): Character => ({
  id: name, projectId: 'novel', name, role: 'protagonist', identity: 'A surveyor.', appearance: '', personality: '',
  goals: '', relationships: '', notes: '', status: 'active', source: 'manual', keyCharacter: false, portraitAssetId: null,
  createdAt: '', updatedAt: '', ...extra,
});

describe('chapter-specific reference retrieval', () => {
  it('builds bounded standing references independent of retrieval order and excludes chapter events and plans', () => {
    const characters = [character('Mara', { keyCharacter: true }), character('Iven', { keyCharacter: true }), character('Unrelated')];
    const facts = [fact('authored', 'Mara has green eyes.', { factClass: 'authored', characterId: 'Mara', chapterId: null, chapterOrder: null }),
      fact('unrelated', 'The world has two moons.', { factClass: 'authored', chapterId: null, chapterOrder: null }),
      fact('event', 'Mara crosses the river.'), fact('plan', 'Mara will leave.', { factClass: 'plan', chapterId: null }),
      fact('scoped', 'A local rule.', { factClass: 'authored', chapterId: null, scopeChapterId: chapter.id })];
    const first = selectStandingReferences(characters, facts);
    expect(first).toEqual(selectStandingReferences([...characters].reverse(), [...facts].reverse()));
    expect(first.characters.map((entry) => entry.name)).toEqual(['Iven', 'Mara']);
    expect(first.facts.map((entry) => entry.id)).toEqual(['authored']);
    expect(estimateTokens(first.characters.map(referenceCharacterText).join('\n\n'))).toBeLessThanOrEqual(350);
  });

  it('selects a relevant old detail over unrelated recent history', () => {
    const result = selectStoryReferences({ chapter, state: 'Mara is at the north door.', characters: [], preset: 'balanced',
      facts: [fact('recent', 'The desert librarian drinks rose tea.', { chapterOrder: 29 }),
        fact('old-key', 'The brass key works only in the north door.', { chapterOrder: 0 })],
    });
    expect(result.facts.map((entry) => entry.id)).toEqual(['old-key']);
  });

  it('excludes future, proposed, outdated and other-chapter facts even when keywords match', () => {
    const result = selectStoryReferences({ chapter, state: '', characters: [], preset: 'broad', facts: [
      fact('future', 'The brass key is broken.', { chapterOrder: 31 }),
      fact('pending', 'The brass key is broken.', { status: 'proposed' }),
      fact('outdated', 'The brass key is broken.', { sourceOutdated: true }),
      fact('scoped', 'The brass key is broken.', { scopeChapterId: 'other' }),
      fact('unscoped-plan', 'Mara will break the brass key.', { factClass: 'plan' }),
      fact('current-plan', 'Mara will open the door.', { factClass: 'plan', scopeChapterId: chapter.id }),
    ] });
    expect(result.facts.map((entry) => entry.id)).toEqual(['current-plan']);
  });

  it('does not include every protagonist profile just because it is active', () => {
    const result = selectStoryReferences({ chapter, state: '', facts: [], preset: 'balanced',
      characters: [character('Mara'), character('Unrelated Archivist'), character('Distant Queen')],
    });
    expect(result.characters.map((entry) => entry.name)).toEqual(['Mara']);
  });

  it('keeps reference size bounded when the archive grows', () => {
    const result = selectStoryReferences({ chapter, state: 'Mara is carrying the key.', preset: 'balanced',
      characters: Array.from({ length: 100 }, (_, index) => character(`Mara ${index}`, { identity: 'A surveyor. '.repeat(100) })),
      facts: Array.from({ length: 1000 }, (_, index) => fact(`key-${index}`, `The brass key has mark ${index}.`)),
    });
    expect(result.characters.length).toBeLessThanOrEqual(4);
    expect(result.facts.length).toBeLessThanOrEqual(7);
    expect(estimateTokens(result.characters.map(referenceCharacterText).join('\n'))).toBeLessThanOrEqual(650);
    expect(estimateTokens(result.facts.map(referenceFactText).join('\n'))).toBeLessThanOrEqual(650);
  });
});
