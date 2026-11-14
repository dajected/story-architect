import crypto from 'node:crypto';
import type { RequestContextPart, RequestMessage } from './request-context.js';
import type { OutlineChapter, RewriteAction } from '../shared/types.js';

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

## Story memory
{{story_memory}}

## Lore
{{lore}}

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

export const IMAGE_PROMPT_SYSTEM = `You are an art director for a novel's character portraits. Turn the supplied story details into one concrete image-generation prompt.

Rules:
- Return only the final prompt as a single paragraph. No headings, labels, quotation marks, code fences, or commentary.
- Describe the subject, physical features, clothing, expression, pose, setting, lighting, camera framing, and visual style.
- Use the character's established appearance and the selected scene. Do not invent contradictions or new story events.
- Treat the supplied character and scene details as authoritative. Never ask for more information and never reply with a question; if a detail is missing, omit the gap and write the best prompt the available details support.
- Keep the prompt under 180 words and make it usable by a text-to-image model.
- Do not include negative-prompt text; the author supplies that separately.`;

export const IMAGE_PROMPT_TEMPLATE_DEFAULT = `Create the image-generation prompt for this character portrait.

## Novel
Title: {{novel_title}}
Genre: {{genre}}
Tone: {{tone}}
Visual style: {{visual_style}}
Story style notes: {{project_style}}

## Character
Name: {{character_name}}
Role: {{character_role}}
Identity: {{identity}}
Appearance: {{appearance}}
Clothing: {{clothing}}
Personality: {{personality}}
Goals: {{goals}}
Notes: {{notes}}

## Scene
{{scene}}
Chapter: {{chapter_title}}
Chapter brief: {{chapter_brief}}

## Additional instructions
{{additional_instructions}}`;

export interface ImagePromptValuesParams {
  novelTitle: string;
  genre: string;
  tone: string;
  projectStyle: string;
  characterName: string;
  characterRole: string;
  identity: string;
  appearance: string;
  clothing: string;
  personality: string;
  goals: string;
  notes: string;
  scene: string;
  chapterTitle: string;
  chapterBrief: string;
  visualStyle: string;
  additionalInstructions: string;
}

export function imagePromptValues(params: ImagePromptValuesParams): PromptValues {
  return {
    novel_title: params.novelTitle,
    genre: params.genre,
    tone: params.tone,
    project_style: params.projectStyle,
    character_name: params.characterName,
    character_role: params.characterRole,
    identity: params.identity,
    clothing: params.clothing,
    appearance: params.appearance,
    personality: params.personality,
    goals: params.goals,
    notes: params.notes,
    scene: params.scene,
    chapter_title: params.chapterTitle,
    chapter_brief: params.chapterBrief,
    visual_style: params.visualStyle,
    additional_instructions: params.additionalInstructions,
  };
}

export interface PromptValues {
  [key: string]: string | number | null | undefined;
}

export function renderTemplate(template: string, values: PromptValues): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

/** Preserve custom template layout while making background variables budgetable. */
export function renderContextTemplate(
  template: string,
  values: PromptValues,
  optional: Record<string, Omit<RequestContextPart, 'text' | 'slot'>>,
): RequestMessage {
  const contextParts: RequestContextPart[] = [];
  const content = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key] == null ? '' : String(values[key]);
    if (!optional[key] || !value.trim()) return value;
    const slot = `__SA_CONTEXT_${crypto.randomUUID()}__`;
    contextParts.push({ ...optional[key], text: value, slot });
    return slot;
  });
  return { role: 'system', content, contextParts };
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
  storyMemory?: string;
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

${params.outlineSummary ? `Approved outline (future beats are plans, not history):\n${params.outlineSummary}\n\n` : ''}${params.storyMemory ? `Story memory (verified summaries, character profiles, established facts):\n${params.storyMemory}\n\n` : ''}${params.chapterContext ? `Current chapter context:\n${params.chapterContext}\n\n` : ''}
The manuscript is the author's source of truth. You can brainstorm, analyse, and suggest revisions, but your messages never change the manuscript unless the author explicitly inserts them. Do not claim that you edited anything.`;
}

/** Instruction block for the memory role. The chapter text is supplied by the caller. */
export const MEMORY_EXTRACTION_PROMPT = `You are the continuity archivist for a novel. Read one chapter and produce a short summary plus reviewable continuity facts.

Rules:
- Summarise only what actually happens in the supplied chapter text. The brief is a plan: do not present unrealised intentions as events.
- The summary should be 90 to 180 words, written in the past tense, naming the important characters and the causal turn.
- Facts must be concrete and checkable. Prefer five to twelve useful facts over a long list.
- Use kind "character_development" for a lasting change to a character, "relationship" for a shift between named characters, "timeline" for an ordered event, "plot_thread" for an unresolved question or promise, and "world" for a stable world detail.
- Use scope "story" when the fact remains true for the rest of the novel. Use "chapter" when it is only true or known at this point in the story.
- Do not repeat facts already listed under "Known facts". Do not invent details that are absent from the text.

Return only valid JSON, with no commentary and no code fences:
{"summary":"...","facts":[{"kind":"character_development","statement":"...","characters":["Name"],"scope":"story"}]}`;

export const CHARACTER_CASTING_PROMPT = `You are a casting editor for a novel. Read the premise and the approved outline and propose the recurring cast.

Rules:
- Propose only characters who appear in, speak in, or are clearly required by the outline.
- Aim for three to twelve characters, most important first.
- Keep names exactly as they appear in the outline when a name is given. Otherwise propose a fitting name.
- Describe each character compactly: identity, appearance, personality, goals, and relationships. Leave a field empty if the outline does not support an answer; do not invent elaborate backstory.
- These are proposals for the author to accept, not established canon yet.

Return only valid JSON, with no commentary and no code fences:
{"characters":[{"name":"...","role":"protagonist","identity":"...","appearance":"...","personality":"...","goals":"...","relationships":"..."}]}`;

export const CONTINUITY_REVIEW_PROMPT = `You are a continuity editor for a novel. Check one chapter against the derived story memory supplied by the author.

Rules:
- Report only concrete problems: contradicted facts, impossible timelines, changed names or descriptions, relationships that no longer hold, or threads that were dropped.
- Use the supplied established facts and accepted profiles as the reference. Treat the chapter brief as a plan, not as evidence.
- Return only JSON: {"findings":[{"kind":"Conflict | Possible inconsistency | Open thread","chapter":"affected chapter title","passage":"exact unique quote from the current chapter","reference":"established fact and its source chapter","suggestion":"specific proposed correction","replacement":"optional exact replacement for the quoted passage"}]}.
- Cite the specific detail from the chapter and the fact it conflicts with. Do not invent problems.
- If nothing is wrong return {"findings":[]}. Keep the report under 500 words.
- This report is advisory. Never rewrite the chapter or claim to have changed the manuscript.`;

export const REWRITE_SYSTEM_PROMPT = `You are Story Architect's line editor, revising one selected passage inside a novel chapter.

Rules:
- Return only the replacement prose for the selected passage. No quotation marks, labels, headings, commentary, or explanation.
- Keep the established point of view, tense, voice, and the facts of the surrounding text.
- Do not introduce new plot events, characters, or continuity facts. Preserve the passage's meaning and its bridge into the following text.
- Match the surrounding prose's paragraph style. Do not repeat the surrounding paragraphs.
- Resolve the requested action exactly; it overrides the passage's current length or style.`;

const REWRITE_ACTION_INSTRUCTIONS: Record<RewriteAction, string> = {
  rewrite:
    'Rewrite the passage for clarity, rhythm, and precision while keeping its meaning and roughly its current length.',
  expand:
    'Expand the passage to roughly 1.5 to 2 times its current length by deepening sensory detail, interiority, and physical action. Do not add new plot events.',
  shorten:
    'Shorten the passage to roughly 60 percent of its current length, keeping the essential action, image, and emotional beat.',
  style:
    'Rewrite the passage in the requested style. If the author gives no style note, make it more literary, concrete, and rhythmically varied.',
};

export function rewriteActionInstruction(action: RewriteAction): string {
  return REWRITE_ACTION_INSTRUCTIONS[action] ?? REWRITE_ACTION_INSTRUCTIONS.rewrite;
}

export function buildRewriteSystemPrompt(params: {
  action: RewriteAction;
  title: string;
  premise: string;
  genre: string;
  tone: string;
  pov: string;
  tense: string;
  styleNotes: string;
  contentPreferences: string;
  instructions: string;
  chapterNumber: number;
  chapterTitle: string;
  chapterBrief: string;
  before: string;
  selection: string;
  after: string;
  instruction: string;
}): string {
  return `${REWRITE_SYSTEM_PROMPT}

## Novel
Title: ${params.title || '(untitled)'}
Premise: ${params.premise || '(not set)'}
Genre: ${params.genre || '(not set)'}
Tone: ${params.tone || '(not set)'}
Point of view: ${params.pov || '(not set)'}
Tense: ${params.tense || '(not set)'}
Writing style: ${params.styleNotes || '(not set)'}
Content preferences: ${params.contentPreferences || '(not set)'}
Project instructions: ${params.instructions || '(none)'}

## Chapter
Chapter ${params.chapterNumber}: ${params.chapterTitle}
Brief: ${params.chapterBrief || '(none)'}

## Requested change
${rewriteActionInstruction(params.action)}
${params.instruction ? `Author's instruction: ${params.instruction}` : ''}

## Text before the selection
${params.before || '(The selection starts the chapter.)'}

## Selected passage to replace
${params.selection}

## Text after the selection
${params.after || '(The selection ends the chapter.)'}`;
}

export interface ParsedMemoryFact {
  kind:
    | 'character_development'
    | 'relationship'
    | 'timeline'
    | 'plot_thread'
    | 'world';
  statement: string;
  characters: string[];
  scope: 'chapter' | 'story';
}

export interface ParsedMemory {
  summary: string;
  facts: ParsedMemoryFact[];
  parsed: boolean;
}

const MEMORY_KINDS: ParsedMemoryFact['kind'][] = [
  'character_development',
  'relationship',
  'timeline',
  'plot_thread',
  'world',
];

function jsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }
  const objectStart = raw.indexOf('{');
  const objectEnd = raw.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    candidates.push(raw.slice(objectStart, objectEnd + 1));
  }
  candidates.push(raw.trim());
  return candidates;
}

function normaliseString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normaliseStringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .slice(0, 8);
}

/** Tolerant parser for the memory role's summary/fact reply. */
export function parseMemoryExtraction(raw: string): ParsedMemory {
  for (const candidate of jsonCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== 'object') continue;
      const record = parsed as Record<string, unknown>;
      const summary = normaliseString(record.summary ?? record.chapterSummary, 12000);
      const rawFacts = Array.isArray(record.facts) ? record.facts : [];
      const facts: ParsedMemoryFact[] = [];
      for (const entry of rawFacts) {
        if (!entry || typeof entry !== 'object') continue;
        const fact = entry as Record<string, unknown>;
        const statement = normaliseString(fact.statement ?? fact.fact ?? fact.text, 4000);
        if (!statement) continue;
        const kind = MEMORY_KINDS.includes(fact.kind as ParsedMemoryFact['kind'])
          ? (fact.kind as ParsedMemoryFact['kind'])
          : 'timeline';
        const scope = fact.scope === 'chapter' ? 'chapter' : 'story';
        facts.push({
          kind,
          statement,
          characters: normaliseStringList(fact.characters ?? fact.character),
          scope,
        });
      }
      if (summary || facts.length > 0) {
        return { summary, facts, parsed: true };
      }
    } catch {
      // Try the next candidate.
    }
  }

  // Last resort: keep the prose so the author can edit it into a summary.
  const fallback = raw
    .replace(/```[a-z]*\s*([\s\S]*?)```/gi, '$1')
    .replace(/^\s*\{[\s\S]*\}\s*$/, '')
    .trim()
    .slice(0, 12000);
  return { summary: fallback, facts: [], parsed: false };
}

export interface ParsedCharacter {
  name: string;
  role: string;
  identity: string;
  appearance: string;
  personality: string;
  goals: string;
  relationships: string;
}

/** Tolerant parser for the casting role's character proposals. */
export function parseCharacterProposals(raw: string): ParsedCharacter[] {
  for (const candidate of jsonCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? ((parsed as Record<string, unknown>).characters as unknown)
          : null;
      if (!Array.isArray(list)) continue;
      const characters: ParsedCharacter[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const name = normaliseString(record.name, 160);
        if (!name) continue;
        characters.push({
          name,
          role: normaliseString(record.role, 120),
          identity: normaliseString(record.identity, 4000),
          appearance: normaliseString(record.appearance, 4000),
          personality: normaliseString(record.personality, 4000),
          goals: normaliseString(record.goals, 4000),
          relationships: normaliseString(record.relationships, 4000),
        });
        if (characters.length >= 40) break;
      }
      if (characters.length > 0) return characters;
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}
