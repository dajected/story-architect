import { Router } from 'express';
import { badRequest } from '../errors.js';
import { z } from 'zod';
import type { ContextInfo, ContextPreset } from '../../shared/types.js';
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
  applyRewriteToChapter,
} from '../store/chapters.js';
import { getProject } from '../store/projects.js';
import {
  isContextPreset,
  getProjectGeneration,
  resolveRoles,
} from '../store/settings.js';
import { buildProseContext } from '../context.js';
import { modelContextLength, modelOutputLimit } from '../store/connections.js';
import { resolvePromptTemplate } from '../store/templates.js';
import { startChapterGeneration, applyPartialJob, applyRewriteJob, startContinuityReview, startRewriteGeneration } from '../generation.js';
import { cancelJob, getJob, isTerminal, liveOutput, subscribe } from '../jobs.js';
import type { JobEvent } from '../jobs.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const writingRouter = Router();

writingRouter.post('/chapters/:id/review-correction', wrap((req,res) => {
  const id=stringParam(req.params.id,'chapter id');
  const body=parseBody(z.object({jobId:z.string(),expectedContent:z.string().max(2000000),passage:z.string().min(1).max(200000),replacement:z.string().min(1).max(200000)}),req.body);
  const job=getJob(body.jobId);
  if(job.chapterId!==id || job.kind!=='review' || job.status!=='completed') throw badRequest('Choose a completed review of this chapter.');
  const chapter=getChapterDetail(id);
  if(chapter.content!==body.expectedContent) {res.status(409).json({error:'The manuscript changed. Refresh and review the correction again.'});return;}
  const start=chapter.content.indexOf(body.passage);
  if(start<0 || chapter.content.indexOf(body.passage,start+1)>=0) {res.status(409).json({error:'The passage changed or occurs more than once. Edit it manually.'});return;}
  res.json(applyRewriteToChapter({chapterId:id,start,end:start+body.passage.length,selection:body.passage,replacement:body.replacement,jobId:job.id}));
}));

function buildContextInfo(chapterId: string, requestedPreset?: unknown): ContextInfo {
  const chapterRow = getChapterRow(chapterId);
  const project = getProject(chapterRow.project_id);
  const chapter = getChapter(chapterId);
  const settings = getProjectGeneration(project.id);
  const preset: ContextPreset = isContextPreset(requestedPreset)
    ? requestedPreset
    : settings.contextPreset;
  const targetWords = settings.targetWords ?? project.targetChapterWords ?? 1800;
  const roles = resolveRoles(project.id);
  const proseRole = roles.find((role) => role.role === 'prose');
  const memoryRole = roles.find((role) => role.role === 'memory');
  const contextLength =
    proseRole?.connectionId && proseRole.model
      ? modelContextLength(proseRole.connectionId, proseRole.model)
      : null;
  const template = resolvePromptTemplate(project.id, 'prose');
  const context = buildProseContext(project, chapter, {
    preset,
    targetWords,
    templateContent: template.content,
    modelContextLength: contextLength,
    maxTokens: settings.maxTokens,
    modelMaxOutputTokens: proseRole?.connectionId && proseRole.model
      ? modelOutputLimit(proseRole.connectionId, proseRole.model) : undefined,
  });

  const warnings = [...context.warnings];
  if (!proseRole?.connectionId || !proseRole.model) {
    warnings.push('No prose model is configured. Assign one in Settings before generating.');
  }
  if (!memoryRole?.connectionId || !memoryRole.model) {
    warnings.push(
      'No memory model is configured, so chapter summaries and fact extraction cannot run automatically.',
    );
  }

  return {
    storyState: context.storyState,
    preset,
    budgetTokens: context.budgetTokens,
    reservedOutputTokens: context.reservedOutputTokens,
    availableInputTokens: context.availableInputTokens,
    requiredTokens: context.requiredTokens,
    estimatedTokens: context.estimatedTokens,
    totalEstimatedTokens: context.estimatedTokens + context.reservedOutputTokens,
    tokenEstimate: 'approximate',
    model: {
      connectionName: proseRole?.connectionName ?? null,
      model: proseRole?.model ?? null,
      contextLength,
    },
    sections: context.sections,
    warnings,
    lore: context.lore,
    includedWords: context.includedWords,
    includedChapters: context.includedChapters,
    omittedChapters: context.omittedChapters,
    staleSummaries: context.staleSummaries,
    pendingFacts: context.pendingFacts,
  };
}

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
    res.json(buildContextInfo(stringParam(req.params.id, 'chapter id'), req.query.preset));
  }),
);

writingRouter.post(
  '/chapters/:id/rewrite',
  wrap((req, res) => {
    const chapterId = stringParam(req.params.id, 'chapter id');
    const body = parseBody(
      z.object({
        action: z.enum(['rewrite', 'expand', 'shorten', 'style']),
        selection: z.string().min(1).max(12000),
        start: z.number().int().min(0),
        end: z.number().int().min(0),
        instruction: z.string().max(8000).optional(),
      }),
      req.body,
    );
    res.status(202).json({ job: startRewriteGeneration(chapterId, body) });
  }),
);

writingRouter.post(
  '/chapters/:id/review',
  wrap((req, res) => {
    res.status(202).json({
      job: startContinuityReview(stringParam(req.params.id, 'chapter id')),
    });
  }),
);

writingRouter.post(
  '/jobs/:id/apply-rewrite',
  wrap((req, res) => {
    const body = parseBody(
      z.object({ replacement: z.string().max(200000).optional() }).default({}),
      req.body,
    );
    res.status(201).json(applyRewriteJob(stringParam(req.params.id, 'job id'), body.replacement));
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

