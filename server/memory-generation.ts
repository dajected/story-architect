import type { GenerationJob } from '../shared/types.js';
import { countWords, jobSettingsSnapshot } from '../shared/utils.js';
import { approvedOutlineText } from './context.js';
import { badRequest, conflict, errorMessage } from './errors.js';
import {
  appendOutput,
  createJob,
  createRuntime,
  finalizeJob,
  getJob,
  isCancellation,
  activeJobForChapterKind,
  activeProjectJobKind,
  updateJob,
  recordPreparedRequest,
} from './jobs.js';
import {
  CHARACTER_CASTING_PROMPT,
  MEMORY_EXTRACTION_PROMPT,
  parseCharacterProposals,
  parseMemoryExtraction,
} from './prompts.js';
import { streamChat, ProviderError } from './providers.js';
import type { ProviderMessage } from './providers.js';
import { currentChapterText, getChapter, getChapterRow } from './store/chapters.js';
import { addProposedCharacters } from './store/characters.js';
import {
  addExtractedFacts,
  memoryForPrompt,
  precedingSignature,
  saveChapterMemory,
  chapterTextHash,
} from './store/memory.js';
import { latestOutlineRevision } from './store/outline.js';
import { getProject } from './store/projects.js';
import { resolveTaskModel } from './store/settings.js';
import { getProviderConnection, modelContextLength } from './store/connections.js';

const memoryQueues = new Map<string, Promise<void>>();

interface RunResult {
  content: string;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
}

async function runJobStream(
  job: GenerationJob,
  system: string,
  user: string | ProviderMessage,
  options: { temperature: number | null; maxTokens: number | null },
): Promise<RunResult | null> {
  let provider;
  try {
    provider = getProviderConnection(job.connectionId);
  } catch (error) {
    finalizeJob(job.id, 'failed', { error: errorMessage(error) });
    return null;
  }
  updateJob(job.id, { status: 'running', started_at: new Date().toISOString() });
  const runtime = createRuntime(job.id);
  try {
    const result = await streamChat(provider, {
      model: job.model,
      messages: [
        { role: 'system', content: system },
        typeof user === 'string' ? { role: 'user', content: user } : user,
      ],
      temperature: options.temperature,
      topP: null,
      maxTokens: options.maxTokens,
      signal: runtime.controller.signal,
      onDelta: (text) => appendOutput(job.id, text),
      onPrepared: (request) => recordPreparedRequest(job.id, request),
    });
    if (result.finishReason === 'length' || result.finishReason === 'max_tokens') {
      finalizeJob(job.id, 'failed', { error: 'The model reached its reply token limit. Partial output is kept; no incomplete memory or character proposals were applied.', usage: result.usage });
      return null;
    }
    return result;
  } catch (error) {
    if (isCancellation(error, runtime.controller.signal)) {
      finalizeJob(job.id, 'cancelled', {
        error: 'Generation stopped. Any partial output is kept.',
      });
      return null;
    }
    const message = error instanceof ProviderError ? error.message : errorMessage(error);
    finalizeJob(job.id, 'failed', { error: message });
    return null;
  }
}

function memoryModel(projectId: string) {
  return resolveTaskModel(projectId, 'memory');
}

function chapterContextForExtraction(projectId: string, chapterId: string): string {
  const memory = memoryForPrompt(projectId, chapterId);
  const parts: string[] = [];
  if (memory.summaries.length > 0) {
    parts.push(
      `### Earlier chapter summaries\n${memory.summaries
        .map(
          (entry) =>
            `Chapter ${entry.orderIndex + 1} — ${entry.chapterTitle}: ${entry.summary}${
              entry.stale ? ' (may be outdated)' : ''
            }`,
        )
        .join('\n')}`,
    );
  }
  if (memory.facts.length > 0) {
    parts.push(
      `### Known facts\n${memory.facts
        .map((fact) => `- ${fact.statement}${fact.characterName ? ` (${fact.characterName})` : ''}`)
        .join('\n')}`,
    );
  }
  if (memory.characters.length > 0) {
    parts.push(
      `### Cast\n${memory.characters
        .map((character) => `${character.name}${character.role ? ` — ${character.role}` : ''}`)
        .join(', ')}`,
    );
  }
  return parts.join('\n\n');
}

function buildMemoryUserMessage(
  projectId: string,
  chapterId: string,
  text: string,
): ProviderMessage {
  const project = getProject(projectId);
  const chapter = getChapter(chapterId);
  const previous = chapterContextForExtraction(projectId, chapterId);
  return { role: 'user', content: `Novel: ${project.title}
Premise: ${project.premise || '(not set)'}
Chapter ${chapter.orderIndex + 1}: ${chapter.title}
Brief for this chapter (a plan, not evidence): ${chapter.brief || '(none)'}

Summarise the supplied chapter excerpt. Earlier continuity is background, not evidence of new events.`,
    contextParts: [
      { label: 'Chapter text', text, priority: 100, minTokens: 512, maxTokens: 10000, trim: 'both' },
      { label: 'Earlier continuity', text: previous, priority: 20, maxTokens: 2000 },
    ],
  };
}

async function runMemoryJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!['queued', 'running'].includes(job.status)) return;
  if (!job.chapterId) {
    finalizeJob(jobId, 'failed', { error: 'Memory jobs need a chapter.' });
    return;
  }
  const chapter = getChapterRow(job.chapterId);
  const text = currentChapterText(chapter.id);
  if (!text.trim()) {
    finalizeJob(jobId, 'failed', {
      error: 'This chapter has no current text to summarise.',
    });
    return;
  }
  const sourceRevisionId = chapter.current_revision_id;
  const sourceContentHash = chapterTextHash(text);
  const signature = precedingSignature(chapter.project_id, Number(chapter.order_index));
  const user = buildMemoryUserMessage(
    chapter.project_id,
    chapter.id,
    text,
  );
  const result = await runJobStream(
    job,
    MEMORY_EXTRACTION_PROMPT,
    user,
    { temperature: 0.2, maxTokens: 1100 },
  );
  if (!result) {
    return;
  }
  await finishMemoryJob(
    job.id,
    chapter.id,
    result,
    text,
    sourceRevisionId,
    sourceContentHash,
    signature,
  );
}

async function finishMemoryJob(
  jobId: string,
  chapterId: string,
  result: RunResult,
  text: string,
  sourceRevisionId: string | null,
  sourceContentHash: string,
  signature: string,
): Promise<void> {
  const chapter = getChapterRow(chapterId);
  const parsed = parseMemoryExtraction(result.content);
  if (!parsed.summary.trim() && parsed.facts.length === 0) {
    finalizeJob(jobId, 'failed', {
      error:
        'The memory model returned no usable summary. Its raw reply is kept so you can retry or write the summary by hand.',
      usage: result.usage,
    });
    return;
  }
  try {
    if (parsed.summary.trim()) {
      saveChapterMemory({
        chapterId,
        summary: parsed.summary,
        sourceRevisionId,
        sourceContentHash,
        sourceWordCount: countWords(text),
        precedingSignature: signature,
        jobId,
      });
    }
    addExtractedFacts(
      chapter.project_id,
      chapterId,
      sourceRevisionId,
      sourceContentHash,
      parsed.facts.map((fact) => ({
        kind: fact.kind,
        statement: fact.statement,
        characterName: fact.characters[0] ?? null,
        scope: fact.scope,
      })),
    );
    finalizeJob(jobId, 'completed', {
      usage: result.usage,
      error: parsed.parsed
        ? null
        : 'The reply was not valid JSON; the summary text was kept and no new facts were proposed.',
    });
  } catch (error) {
    finalizeJob(jobId, 'failed', { error: errorMessage(error), usage: result.usage });
  }
}

function ensureChapterCanBeSummarised(chapterId: string): string {
  const chapter = getChapterRow(chapterId);
  if (!chapter.current_revision_id || !currentChapterText(chapterId).trim()) {
    throw badRequest('Write or generate this chapter before building its summary.');
  }
  return chapter.project_id;
}

export function startChapterMemoryGeneration(
  chapterId: string,
  options: { queued?: boolean } = {},
): GenerationJob {
  const projectId = ensureChapterCanBeSummarised(chapterId);
  const active = activeJobForChapterKind(chapterId, 'memory');
  if (active) throw conflict('Memory is already being rebuilt for this chapter.');
  const model = memoryModel(projectId);
  const contextLength = modelContextLength(model.connectionId, model.model);
  const job = createJob({
    projectId,
    kind: 'memory',
    chapterId,
    connectionId: model.connectionId,
    model: model.model,
    prompt: MEMORY_EXTRACTION_PROMPT,
    status: options.queued ? 'queued' : 'running',
    context: { stage: 'memory', connectionContextLength: contextLength },
    settings: jobSettingsSnapshot({ temperature: 0.2, topP: null, maxTokens: 1100 }),
  });
  if (!options.queued) void runMemoryJob(job.id);
  return job;
}

/** Start one automatic summary after a chapter draft becomes current. */
export function autoStartChapterMemory(chapterId: string): GenerationJob | null {
  try {
    if (!getChapterRow(chapterId).current_revision_id) return null;
    if (!currentChapterText(chapterId).trim()) return null;
    if (activeJobForChapterKind(chapterId, 'memory')) return null;
    const projectId = getChapterRow(chapterId).project_id;
    memoryModel(projectId);
    return startChapterMemoryGeneration(chapterId);
  } catch {
    // Auto-summary is additive: an unconfigured memory role or a conflict must
    // never fail the chapter generation that triggered it.
    return null;
  }
}

/**
 * Queue rebuilds one after another per project so a bulk refresh does not
 * flood the provider. Jobs are visible as `queued` immediately.
 */
export function queueMemoryRebuild(projectId: string, chapterIds: string[]): GenerationJob[] {
  getProject(projectId);
  const unique = [...new Set(chapterIds)];
  if (unique.length === 0) return [];
  for (const chapterId of unique) {
    const chapter = getChapterRow(chapterId);
    if (chapter.project_id !== projectId) {
      throw badRequest('That chapter belongs to another project.');
    }
    if (!chapter.current_revision_id || !currentChapterText(chapterId).trim()) {
      throw badRequest('Every chapter in a rebuild must have current manuscript text.');
    }
    if (activeJobForChapterKind(chapterId, 'memory')) {
      throw conflict('Memory is already being rebuilt for one of these chapters.');
    }
  }
  const model = memoryModel(projectId);
  const contextLength = modelContextLength(model.connectionId, model.model);
  const jobs = unique.map((chapterId) =>
    createJob({
      projectId,
      kind: 'memory',
      chapterId,
      connectionId: model.connectionId,
      model: model.model,
      prompt: MEMORY_EXTRACTION_PROMPT,
      status: 'queued',
      context: { stage: 'memory', batch: unique.length, connectionContextLength: contextLength },
      settings: jobSettingsSnapshot({ temperature: 0.2, topP: null, maxTokens: 1100 }),
    }),
  );
  const previous = memoryQueues.get(projectId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      for (const job of jobs) {
        const latest = getJob(job.id);
        if (!['queued', 'running'].includes(latest.status)) {
          continue;
        }
        await runMemoryJob(job.id).catch(() => undefined);
      }
    })
    .finally(() => {
      if (memoryQueues.get(projectId) === next) memoryQueues.delete(projectId);
    });
  memoryQueues.set(projectId, next);
  return jobs;
}

export function startCharacterProposal(projectId: string): GenerationJob {
  const project = getProject(projectId);
  const latest = latestOutlineRevision(projectId);
  if (!latest || latest.status !== 'approved') {
    throw conflict('Approve the outline before proposing characters from it.');
  }
  if (activeProjectJobKind(projectId, 'characters')) {
    throw conflict('A character casting pass is already running for this project.');
  }
  const model = memoryModel(projectId);
  const outline = approvedOutlineText(projectId);
  const job = createJob({
    projectId,
    kind: 'characters',
    connectionId: model.connectionId,
    model: model.model,
    prompt: CHARACTER_CASTING_PROMPT,
    context: { stage: 'characters', outlineTokens: Math.ceil(outline.length / 4) },
    settings: jobSettingsSnapshot({ temperature: 0.7, topP: null, maxTokens: 2500 }),
  });

  void (async () => {
    const user: ProviderMessage = { role: 'user', content: `Novel: ${project.title}
Premise: ${project.premise || '(not set)'}
Genre: ${project.genre || '(not set)'}
Tone: ${project.tone || '(not set)'}
Point of view: ${project.pov || '(not set)'}

Propose the cast from the approved outline now. Return only the JSON object.`,
      contextParts: [{ label: 'Approved outline', text: outline, priority: 100, minTokens: 256, maxTokens: 9000, trim: 'both' }],
    };
    const result = await runJobStream(job, CHARACTER_CASTING_PROMPT, user, {
      temperature: 0.7,
      maxTokens: 2500,
    });
    if (!result) return;
    const parsed = parseCharacterProposals(result.content);
    if (parsed.length === 0) {
      finalizeJob(job.id, 'failed', {
        error:
          'The casting reply could not be read as a character list. Its raw output is kept so you can retry.',
        usage: result.usage,
      });
      return;
    }
    try {
      const created = addProposedCharacters(projectId, parsed, 'outline');
      if (created.length === 0) {
        finalizeJob(job.id, 'completed', {
          error: 'No new characters were proposed; the cast already contains these names.',
          usage: result.usage,
        });
        return;
      }
      finalizeJob(job.id, 'completed', { usage: result.usage });
    } catch (error) {
      finalizeJob(job.id, 'failed', { error: errorMessage(error), usage: result.usage });
    }
  })();

  return job;
}
