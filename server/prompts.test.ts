import { describe, expect, it } from 'vitest';
import { parseOutline, renderTemplate } from './prompts.js';

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
  it('substitutes placeholders and blanks missing values', () => {
    expect(renderTemplate('A {{one}} B {{two}}', { one: 'x' })).toBe('A x B ');
  });
});
