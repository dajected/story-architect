import { describe, expect, it } from 'vitest';
import {
  parseCharacterProposals,
  parseMemoryExtraction,
  parseOutline,
  renderTemplate,
  renderProseMessages,
  PROSE_TEMPLATE_DEFAULT,
} from './prompts.js';
import { prepareRequest } from './request-context.js';

describe('parseOutline', () => {
  it('reads a fenced JSON outline', () => {
    const raw = 'Here you go:\n```json\n{"chapters":[{"title":"The Key","brief":"Mara finds a key."}]}\n```';
    const chapters = parseOutline(raw);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('The Key');
    expect(chapters[0].brief).toBe('Mara finds a key.');
    expect(chapters[0].id).toBeTruthy();
  });

  it('reads a bare array', () => {
    const raw = '[{"title":"One","brief":"First."},{"title":"Two","brief":"Second."}]';
    expect(parseOutline(raw).map((chapter) => chapter.title)).toEqual(['One', 'Two']);
  });

  it('reads a bare object with extra prose around it', () => {
    const raw = 'Sure! {"chapters":[{"name":"One","summary":"First."}]} Enjoy.';
    const chapters = parseOutline(raw);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('One');
    expect(chapters[0].brief).toBe('First.');
  });

  it('falls back to a numbered list', () => {
    const raw = [
      '1. The Brass Key - Mara finds a key in the desk.',
      '2. A Door in the Hill: Mara follows a letter north.',
      '3. What the Lens Remembered — The observatory reveals the past.',
    ].join('\n');
    const chapters = parseOutline(raw);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      'The Brass Key',
      'A Door in the Hill',
      'What the Lens Remembered',
    ]);
    expect(chapters[1].brief).toContain('follows a letter');
  });

  it('returns no chapters for unusable output', () => {
    expect(parseOutline('I cannot help with that request.')).toHaveLength(0);
  });
});

describe('renderTemplate', () => {
  it('reuses the entire system message when chapter context changes', () => {
    const values = { project_title: 'Novel', instructions: 'Keep the voice.', standing_references: 'The world has two moons.',
      story_state: 'Mara is at home.', chapter_brief: 'Leave home.', chapter_number: 1, story_memory: 'An old key.' };
    const render = (overrides = {}) => prepareRequest(renderProseMessages(PROSE_TEMPLATE_DEFAULT, { ...values, ...overrides }, {
      standing_references: { label: 'Standing story references', priority: 110, maxTokens: 1400 },
      story_memory: { label: 'Story memory', priority: 90 },
    }), { maxTokens: 1000 }).messages;
    const first = render();
    const next = render({ story_state: 'Mara reaches the city.', chapter_brief: 'Enter the city.', chapter_number: 2, story_memory: 'A new fact.' });
    expect(first[0]).toEqual(next[0]);
    expect(first[0].content).toContain('## Requirements');
    expect(first[0].content).toContain('two moons');
    expect(first[0].content).not.toContain('Mara is at home');
    expect(first[1].role).toBe('user');
    expect(next[1].content).toContain('Mara reaches the city');
    expect(JSON.stringify(first)).not.toContain('__SA_CONTEXT_');
    expect(render()).toEqual(first);
  });

  it('preserves custom template layouts', () => {
    const result = renderProseMessages('Custom {{chapter_brief}} before {{instructions}}.',
      { chapter_brief: 'brief', instructions: 'rules' }, {});
    expect(result).toEqual([{ role: 'system', content: 'Custom brief before rules.', contextParts: [] }]);
  });

  it('substitutes placeholders and blanks missing values', () => {
    expect(renderTemplate('A {{one}} B {{two}}', { one: 'x' })).toBe('A x B ');
  });
});

describe('parseMemoryExtraction', () => {
  it('reads a fenced summary and facts', () => {
    const raw = [
      '```json',
      JSON.stringify({
        summary: 'Mara opens the door.',
        facts: [
          { kind: 'plot_thread', statement: 'The key opens the hill.', characters: ['Mara'], scope: 'story' },
          { kind: 'nonsense', statement: 'The hill is old.', scope: 'chapter' },
        ],
        appearances: [
          { character: 'Mara', appearance: 'Cropped hair, a salt-stiff canvas coat.' },
          { character: '', appearance: 'Ignored without a name.' },
        ],
      }),
      '```',
    ].join('\n');
    const parsed = parseMemoryExtraction(raw);
    expect(parsed.parsed).toBe(true);
    expect(parsed.summary).toBe('Mara opens the door.');
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts[0].characters).toEqual(['Mara']);
    expect(parsed.facts[1].kind).toBe('timeline');
    expect(parsed.facts[1].scope).toBe('chapter');
    expect(parsed.appearances).toEqual([
      { character: 'Mara', appearance: 'Cropped hair, a salt-stiff canvas coat.' },
    ]);
  });

  it('keeps prose when the reply is not JSON', () => {
    const parsed = parseMemoryExtraction('Mara opens the door. The hill is old.');
    expect(parsed.parsed).toBe(false);
    expect(parsed.summary).toContain('Mara opens the door');
    expect(parsed.facts).toHaveLength(0);
    expect(parsed.appearances).toHaveLength(0);
  });
});

describe('parseCharacterProposals', () => {
  it('reads a character list and skips nameless entries', () => {
    const raw = JSON.stringify({
      characters: [
        { name: 'Mara', role: 'protagonist', identity: 'A surveyor.' },
        { role: 'rival', identity: 'No name.' },
      ],
    });
    const characters = parseCharacterProposals(raw);
    expect(characters).toHaveLength(1);
    expect(characters[0].name).toBe('Mara');
    expect(characters[0].role).toBe('protagonist');
  });

  it('returns nothing for an unreadable reply', () => {
    expect(parseCharacterProposals('No cast available.')).toEqual([]);
  });
});
