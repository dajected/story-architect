import crypto from 'node:crypto';
import type { OutlineChapter } from '../shared/types.js';

export const OUTLINE_TEMPLATE_DEFAULT = `You are Story Architect, an experienced developmental editor and novelist.

Create a chapter-by-chapter outline for the novel below.

## Novel
Title: {{project_title}}
Premise: {{premise}}
Genre: {{genre}}
Tone: {{tone}}
Point of view: {{pov}}
Tense: {{tense}}
Writing style: {{style_notes}}
Content preferences: {{content_preferences}}

## Project instructions
{{instructions}}

## Target shape
{{chapter_count}} chapters, roughly {{target_chapter_words}} words each.

## Additional instructions
{{additional_instructions}}

## Response format
Return only valid JSON, with no commentary and no code fences:
{"chapters":[{"title":"Chapter title","brief":"Two to four sentences describing what happens, the emotional turn, and what it sets up."}]}

Rules:
- Give every chapter a distinct, evocative title.
- Each brief should describe concrete events and a causal chain, not vague themes.
- Follow the requested chapter count.
- Do not include front matter, an epilogue, or notes outside the JSON.`;

export const PROSE_TEMPLATE_DEFAULT = `You are Story Architect, drafting prose for a novel.

## Novel
Title: {{project_title}}
Premise: {{premise}}
Genre: {{genre}}
Tone: {{tone}}
Point of view: {{pov}}
Tense: {{tense}}
Writing style: {{style_notes}}
Content preferences: {{content_preferences}}

## Project instructions
{{instructions}}

## Recent preceding prose
{{recent_prose}}

## Chapter to draft
Chapter {{chapter_number}}: {{chapter_title}}
Brief: {{chapter_brief}}
Approximate target length: {{target_words}} words.

## Additional instructions
{{additional_instructions}}

## Requirements
- Continue naturally from the recent prose. Do not recap it.
- Follow the chapter brief and hold the established point of view and tense.
- Write finished prose only: no chapter heading, notes, outlines, or commentary around the text.
- End at a natural stopping point near the target length.`;

export interface PromptValues {
  [key: string]: string | number | null | undefined;
}

export function renderTemplate(template: string, values: PromptValues): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

export function outlinePromptValues(params: {
  title: string;
  premise: string;
  genre: string;
  tone: string;
  pov: string;
  tense: string;
  styleNotes: string;
  contentPreferences: string;
  instructions: string;
  chapterCount: number | null;
  targetChapterWords: number | null;
  additionalInstructions: string;
}): PromptValues {
  return {
    project_title: params.title,
    premise: params.premise,
    genre: params.genre,
    tone: params.tone,
    pov: params.pov,
    tense: params.tense,
    style_notes: params.styleNotes,
    content_preferences: params.contentPreferences,
    instructions: params.instructions,
    chapter_count: params.chapterCount ?? 'an appropriate number of',
    target_chapter_words: params.targetChapterWords ?? 'a natural number of',
    additional_instructions: params.additionalInstructions || 'None.',
  };
}

/** Tolerant outline JSON parser: fenced JSON, bare JSON, then numbered-list fallback. */
export function parseOutline(raw: string): OutlineChapter[] {
  const candidates: string[] = [];
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  candidates.push(...fenced);

  const objectStart = raw.indexOf('{');
  const objectEnd = raw.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    candidates.push(raw.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = raw.indexOf('[');
  const arrayEnd = raw.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    candidates.push(raw.slice(arrayStart, arrayEnd + 1));
  }
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed) ? parsed : parsed?.chapters;
      const chapters = normalizeOutlineList(list);
      if (chapters.length > 0) return chapters;
    } catch {
      // Try the next candidate.
    }
  }

  return parseOutlineFallback(raw);
}

function normalizeOutlineList(list: unknown): OutlineChapter[] {
  if (!Array.isArray(list)) return [];
  const chapters: OutlineChapter[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const title = String(record.title ?? record.name ?? record.chapter ?? '').trim();
    const brief = String(record.brief ?? record.summary ?? record.description ?? '').trim();
    if (!title) continue;
    chapters.push({ id: crypto.randomUUID(), title, brief });
  }
  return chapters;
}

function parseOutlineFallback(raw: string): OutlineChapter[] {
  const lines = raw.split(/\r?\n/);
  const chapters: OutlineChapter[] = [];
  let current: OutlineChapter | null = null;

  const flush = () => {
    if (current && current.title.trim()) {
      chapters.push({
        ...current,
        title: current.title.trim(),
        brief: current.brief.trim(),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(?:#{1,4}\s*)?(?:\d+[.)]\s*|[-*]\s*)?(?:\*\*)?(.+?)(?:\*\*)?\s*(?:[:—–-]\s*(.*))?$/);
    const looksLikeHeading =
      /^(?:#{1,4}\s*)?(?:\d+[.)]|[-*]|chapter\s+\d+)/i.test(trimmed) ||
      (/^[A-Z0-9][^.!?]{2,80}$/.test(trimmed) && trimmed.split(/\s+/).length <= 12);

    if (looksLikeHeading && match) {
      flush();
      const title = (match[1] || '').replace(/^chapter\s+\d+\s*[:.—–-]?\s*/i, '').trim();
      const brief = (match[2] || '').trim();
      if (title) current = { id: crypto.randomUUID(), title, brief };
    } else if (current) {
      current.brief = current.brief ? `${current.brief} ${trimmed}` : trimmed;
    }
  }
  flush();
  return chapters;
}

export function buildChatSystemPrompt(params: {
  title: string;
  premise: string;
  genre: string;
  tone: string;
  pov: string;
  tense: string;
  styleNotes: string;
  contentPreferences: string;
  instructions: string;
  outlineSummary: string;
  chapterContext: string;
}): string {
  return `You are the writing assistant inside Story Architect, a self-hosted novel workspace.
Speak as a sharp, practical developmental editor and co-writer. Be concrete and concise.

Novel: ${params.title || '(untitled)'}
Premise: ${params.premise || '(not set)'}
Genre: ${params.genre || '(not set)'}
Tone: ${params.tone || '(not set)'}
Point of view: ${params.pov || '(not set)'}
Tense: ${params.tense || '(not set)'}
Style: ${params.styleNotes || '(not set)'}
Content preferences: ${params.contentPreferences || '(not set)'}
Project instructions: ${params.instructions || '(none)'}

Approved outline:
${params.outlineSummary || '(no approved outline yet)'}

Current chapter context:
${params.chapterContext || '(no chapter selected)'}

The manuscript is the author's source of truth. You can brainstorm, analyse, and suggest revisions, but your messages never change the manuscript unless the author explicitly inserts them. Do not claim that you edited anything.`;
}
