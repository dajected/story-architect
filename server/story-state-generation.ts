import { countWords, jobSettingsSnapshot } from '../shared/utils.js';
import { conflict, errorMessage } from './errors.js';
import { activeJobForChapterKind, appendOutput, createJob, createRuntime, finalizeJob, getJob, isCancellation, isTerminal, recordPreparedRequest, recordBackgroundAttempt } from './jobs.js';
import { backgroundReplyTokens, streamBackgroundTask } from './background-generation.js';
import { getChapter, listChapters } from './store/chapters.js';
import { getProject } from './store/projects.js';
import { resolveTaskModel } from './store/settings.js';
import { inspectStoryState, saveStoryState, stateSource, STORY_STATE_MAX_CHARS } from './store/story-state.js';

export const STORY_STATE_PROMPT = `You are the story-state editor for a novel.
Update one compact, persistent account of the story AS IT STANDS after the supplied chapter.
Use only the previous state and the actual chapter events. Replace superseded state, remove resolved threads, and preserve important unresolved causes and consequences.
Include: current situation and locations; active goals and unresolved plot threads; changed relationships; who knows which important secrets. Keep established names exact.
Prioritise what will matter next. Omit scene-by-scene history, decorative detail and repetition. Never turn future plans into established events. Never invent events.
Return only the updated state as concise prose or bullet points, no JSON or commentary. Aim for 250–400 words and NEVER exceed 4,000 characters. This is a replacement state, not an appended chapter summary.`;

const builds = new Map<string, Promise<void>>();

async function waitForMemory(chapterId: string, signal?: AbortSignal) {
  while (true) {
    signal?.throwIfAborted();
    const active = activeJobForChapterKind(chapterId, 'memory');
    // A queued extraction may itself be waiting for this checkpoint. Building
    // from its current source now avoids a queue dependency cycle.
    if (!active || active.status === 'queued' || isTerminal(getJob(active.id).status)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function buildState(chapterId: string, signal?: AbortSignal) {
  await waitForMemory(chapterId, signal);
  signal?.throwIfAborted();
  const chapter = getChapter(chapterId);
  const current = inspectStoryState(chapter.projectId, chapter.orderIndex + 1);
  if (current.info.status === 'current') return;
  const previous = inspectStoryState(chapter.projectId, chapter.orderIndex);
  if (!['current', 'empty'].includes(previous.info.status)) throw conflict('Build earlier story state before updating this chapter.');
  const parentVersion = previous.checkpoint?.version ?? null;
  const source = stateSource(chapter, parentVersion);
  const model = resolveTaskModel(chapter.projectId, 'memory');
  const project = getProject(chapter.projectId);
  const job = createJob({ projectId: chapter.projectId, kind: 'memory', chapterId,
    connectionId: model.connectionId, model: model.model, prompt: STORY_STATE_PROMPT,
    context: { stage: 'story_state', parentVersion, inputSignature: source.signature },
    settings: jobSettingsSnapshot({ temperature: 0.2, topP: null, maxTokens: backgroundReplyTokens(model.provider, model.model) }),
  });
  const runtime = createRuntime(job.id);
  const abort = () => runtime.controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await streamBackgroundTask(model.provider, {
      model: model.model, temperature: 0.2, topP: null, maxTokens: backgroundReplyTokens(model.provider, model.model),
      signal: runtime.controller.signal, onDelta: (text) => appendOutput(job.id, text),
      onPrepared: (request) => recordPreparedRequest(job.id, request),
      messages: [{ role: 'system', content: STORY_STATE_PROMPT }, {
        role: 'user', content: `Novel: ${project.title}\nUpdate the state after Chapter ${chapter.orderIndex + 1}: ${chapter.title}.\n\n## Previous story state\n${previous.checkpoint?.content ?? '(Opening chapter; no earlier events.)'}`,
        contextParts: [
          { label: source.summary ? 'Verified events from this chapter' : 'Current chapter text', text: source.summary || source.text,
            priority: 100, minTokens: 256, maxTokens: source.summary ? 3500 : 7000, trim: 'both' },
        ],
      }],
    }, {
      label: 'Story-state update',
      validate: (content) => !!content.trim() && content.trim().length <= STORY_STATE_MAX_CHARS && countWords(content) <= 650,
      onAttempt: (result, usage) => recordBackgroundAttempt(job.id, result, usage),
    });
    runtime.controller.signal.throwIfAborted();
    const state = result.content.trim();
    saveStoryState(chapterId, state, source.signature, parentVersion);
    finalizeJob(job.id, 'completed', { usage: result.usage });
  } catch (error) {
    finalizeJob(job.id, isCancellation(error, runtime.controller.signal) ? 'cancelled' : 'failed', { error: errorMessage(error) });
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** Fold missing/invalid checkpoints in order. Each model request sees one prior state and one chapter. */
export async function ensureStoryStateThrough(chapterId: string, signal?: AbortSignal): Promise<void> {
  const target = getChapter(chapterId);
  const chapters = listChapters(target.projectId).filter((chapter) => chapter.orderIndex <= target.orderIndex && chapter.currentRevisionId && chapter.status === 'drafted');
  if (inspectStoryState(target.projectId, target.orderIndex + 1).info.status === 'current') return;
  for (const chapter of chapters) {
    signal?.throwIfAborted();
    if (inspectStoryState(target.projectId, chapter.orderIndex + 1).info.status === 'current') continue;
    let build = builds.get(chapter.id);
    if (!build) {
      build = buildState(chapter.id, signal).finally(() => { builds.delete(chapter.id); });
      builds.set(chapter.id, build);
    }
    if (!signal) await build;
    else {
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try { await Promise.race([build, cancelled]); }
      finally { signal.removeEventListener('abort', abort); }
    }
  }
}

export async function ensureStoryStateBefore(chapterId: string, signal?: AbortSignal): Promise<void> {
  const chapter = getChapter(chapterId);
  const previous = listChapters(chapter.projectId).filter((entry) => entry.orderIndex < chapter.orderIndex && entry.currentRevisionId && entry.status === 'drafted').at(-1);
  if (previous) await ensureStoryStateThrough(previous.id, signal);
}
