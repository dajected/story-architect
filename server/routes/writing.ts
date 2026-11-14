import { Router } from 'express';
import { z } from 'zod';
import {
  getChapter,
  getChapterDetail,
  getChapterRevision,
  listChapters,
  restoreRevision,
  saveChapterContent,
  useRevision,
  appendToChapter,
  getChapterRow,
} from '../store/chapters.js';
import { getProject } from '../store/projects.js';
import { isContextPreset, getProjectGeneration } from '../store/settings.js';
import { buildProseContext } from '../context.js';
import { startChapterGeneration, applyPartialJob } from '../generation.js';
import { cancelJob, getJob, isTerminal, liveOutput, subscribe } from '../jobs.js';
import type { JobEvent } from '../jobs.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const writingRouter = Router();

writingRouter.get(
  '/projects/:id/chapters',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.json({ chapters: listChapters(projectId) });
  }),
);

writingRouter.get(
  '/chapters/:id',
  wrap((req, res) => {
    res.json({ chapter: getChapterDetail(stringParam(req.params.id, 'chapter id')) });
  }),
);

writingRouter.put(
  '/chapters/:id/content',
  wrap((req, res) => {
    const chapterId = stringParam(req.params.id, 'chapter id');
    const body = parseBody(z.object({ content: z.string().max(2_000_000) }), req.body);
    res.json({ chapter: saveChapterContent(chapterId, body.content) });
  }),
);

writingRouter.post(
  '/chapters/:id/append',
  wrap((req, res) => {
    const chapterId = stringParam(req.params.id, 'chapter id');
    const body = parseBody(z.object({ text: z.string().min(1).max(1_000_000) }), req.body);
    res.json({ chapter: appendToChapter(chapterId, body.text) });
  }),
);

writingRouter.post(
  '/chapters/:id/generate',
  wrap((req, res) => {
    const chapterId = stringParam(req.params.id, 'chapter id');
    const body = parseBody(
      z
        .object({
          instructions: z.string().max(8000).optional(),
          contextPreset: z.enum(['focused', 'balanced', 'broad']).optional(),
          targetWords: z.number().int().min(100).max(20000).nullable().optional(),
        })
        .default({}),
      req.body,
    );
    const job = startChapterGeneration(chapterId, {
      instructions: body.instructions,
      contextPreset: body.contextPreset,
      targetWords: body.targetWords,
    });
    res.status(202).json({ job });
  }),
);

writingRouter.get(
  '/chapters/:id/context',
  wrap((req, res) => {
    const chapterId = stringParam(req.params.id, 'chapter id');
    const chapterRow = getChapterRow(chapterId);
    const project = getProject(chapterRow.project_id);
    const chapter = getChapter(chapterId);
    const requested = req.query.preset;
    const preset = isContextPreset(requested)
      ? requested
      : getProjectGeneration(project.id).contextPreset;
    const context = buildProseContext(project, chapter, preset);
    res.json({
      preset,
      budgetTokens: context.budgetTokens,
      estimatedTokens: context.estimatedTokens,
      includedWords: context.includedWords,
      includedChapters: context.includedChapters,
      omittedChapters: context.omittedChapters,
    });
  }),
);

writingRouter.get(
  '/revisions/:id',
  wrap((req, res) => {
    res.json({ revision: getChapterRevision(stringParam(req.params.id, 'revision id')) });
  }),
);

writingRouter.post(
  '/revisions/:id/use',
  wrap((req, res) => {
    res.json({ chapter: useRevision(stringParam(req.params.id, 'revision id')) });
  }),
);

writingRouter.post(
  '/revisions/:id/restore',
  wrap((req, res) => {
    const result = restoreRevision(stringParam(req.params.id, 'revision id'));
    res.status(201).json(result);
  }),
);

writingRouter.get(
  '/jobs/:id',
  wrap((req, res) => {
    const job = getJob(stringParam(req.params.id, 'job id'));
    const live = liveOutput(job.id);
    res.json({ job: live === null ? job : { ...job, output: live } });
  }),
);

writingRouter.post(
  '/jobs/:id/cancel',
  wrap((req, res) => {
    res.json({ job: cancelJob(stringParam(req.params.id, 'job id')) });
  }),
);

writingRouter.post(
  '/jobs/:id/apply-partial',
  wrap((req, res) => {
    const result = applyPartialJob(stringParam(req.params.id, 'job id'));
    res.status(201).json({
      ...result,
      chapter: getChapterDetail(result.chapterId),
    });
  }),
);

writingRouter.get('/jobs/:id/stream', (req, res, next) => {
  let jobId: string;
  try {
    jobId = stringParam(req.params.id, 'job id');
    getJob(jobId);
  } catch (error) {
    next(error);
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.socket?.setNoDelay(true);

  let closed = false;
  let ready = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const buffered: JobEvent[] = [];

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };

  const send = (event: string, payload: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const emit = (event: JobEvent) => {
    if (event.type === 'delta') {
      send('delta', { text: event.text });
      return;
    }
    send('status', { job: event.job });
    if (isTerminal(event.job.status)) {
      cleanup();
      res.end();
    }
  };

  const handle = (event: JobEvent) => {
    if (!ready) {
      buffered.push(event);
      return;
    }
    emit(event);
  };

  const unsubscribe = subscribe(jobId, handle);
  const live = liveOutput(jobId);
  const current = getJob(jobId);
  const output = live ?? current.output;
  send('snapshot', { job: { ...current, output }, output });
  ready = true;
  for (const event of buffered) emit(event);
  if (closed) return;

  if (!live && isTerminal(current.status)) {
    cleanup();
    res.end();
    return;
  }

  heartbeat = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', cleanup);
});

