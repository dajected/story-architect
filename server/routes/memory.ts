import { Router } from 'express';
import { z } from 'zod';
import type { Chapter, ChapterMemory, MemoryOverview } from '../../shared/types.js';
import { listChapters } from '../store/chapters.js';
import {
  getChapterMemory,
  getFact,
  listFacts,
  createAuthoredFact,
  updateFact,
  setFactStatus,
  deleteFact,
  projectMemoryStats,
  supersedeOutdatedFacts,
  updateChapterMemorySummary,
  chapterSnapshots,
} from '../store/memory.js';
import { listCharacters } from '../store/characters.js';
import { listChapterAppearances } from '../store/appearances.js';
import { getProject } from '../store/projects.js';
import { resolveRoles } from '../store/settings.js';
import { activeJobForChapterKind, listActiveJobs, listProjectJobs } from '../jobs.js';
import { queueMemoryRebuild, startChapterMemoryGeneration } from '../memory-generation.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const memoryRouter = Router();

function memoryRebuildChapterIds(chapters: Chapter[], memories: ChapterMemory[]): string[] {
  const memoryByChapter = new Map(memories.map((memory) => [memory.chapterId, memory]));
  return chapters
    .filter((chapter) => chapter.currentRevisionId)
    .filter((chapter) => {
      const memory = memoryByChapter.get(chapter.id);
      if (memory?.status === 'stale' || memory?.status === 'missing') return true;
      return listChapterAppearances(chapter.id).some((entry) => entry.status !== 'current');
    })
    .map((chapter) => chapter.id);
}

const factKinds = [
  'character_development',
  'relationship',
  'timeline',
  'plot_thread',
  'world',
] as const;
const factClasses = ['authored', 'established', 'plan'] as const;

const factInputSchema = z.object({
  kind: z.enum(factKinds).optional(),
  factClass: z.enum(factClasses).optional(),
  statement: z.string().min(1).max(4000).optional(),
  characterId: z.string().nullable().optional(),
  scopeChapterId: z.string().nullable().optional(),
});

memoryRouter.get(
  '/projects/:id/memory',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    const chapters = listChapters(projectId);
    const snapshots = chapterSnapshots(chapters);
    const facts = listFacts(projectId);
    const characters = listCharacters(projectId);
    const activeJobs = listActiveJobs(projectId).filter((job) =>
      ['memory', 'characters'].includes(job.kind),
    );
    const recentJobs = listProjectJobs(projectId, 30).filter((job) =>
      ['memory', 'characters'].includes(job.kind),
    );
    const activeByChapter = new Map(
      activeJobs
        .filter((job) => job.kind === 'memory' && job.chapterId)
        .map((job) => [job.chapterId as string, job]),
    );
    const chapterMemory = chapters.map((chapter) =>
      getChapterMemory(chapter.id, {
        chapters,
        snapshots,
        activeJobId: activeByChapter.get(chapter.id)?.id ?? null,
      }),
    );
    const memoryRole = resolveRoles(projectId).find((role) => role.role === 'memory');
    const overview: MemoryOverview = {
      projectId,
      chapters: chapterMemory,
      rebuildChapterIds: memoryRebuildChapterIds(chapters, chapterMemory),
      characters,
      facts,
      counts: projectMemoryStats(projectId, chapterMemory, facts, characters),
      activeJobs,
      recentJobs,
      memoryRole:
        memoryRole?.connectionId && memoryRole.model
          ? {
              connectionId: memoryRole.connectionId,
              connectionName: memoryRole.connectionName,
              model: memoryRole.model,
            }
          : null,
    };
    res.json(overview);
  }),
);

memoryRouter.get(
  '/chapters/:id/memory',
  wrap((req, res) => {
    const chapterId = stringParam(req.params.id, 'chapter id');
    const active = activeJobForChapterKind(chapterId, 'memory');
    res.json({
      memory: getChapterMemory(chapterId, { activeJobId: active?.id ?? null }),
      activeJob: active,
    });
  }),
);

memoryRouter.post(
  '/chapters/:id/memory/rebuild',
  wrap((req, res) => {
    res.status(202).json({
      job: startChapterMemoryGeneration(stringParam(req.params.id, 'chapter id')),
    });
  }),
);

memoryRouter.patch(
  '/chapters/:id/memory',
  wrap((req, res) => {
    const body = parseBody(
      z.object({ summary: z.string().min(1).max(12000) }),
      req.body,
    );
    res.json({
      memory: updateChapterMemorySummary(
        stringParam(req.params.id, 'chapter id'),
        body.summary,
      ),
    });
  }),
);

memoryRouter.post(
  '/projects/:id/memory/rebuild',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    const body = parseBody(
      z.object({ chapterIds: z.array(z.string()).max(200).optional() }).default({}),
      req.body,
    );
    const chapters = listChapters(projectId);
    const snapshots = chapterSnapshots(chapters);
    const ids =
      body.chapterIds ??
      memoryRebuildChapterIds(
        chapters,
        chapters.map((chapter) => getChapterMemory(chapter.id, { chapters, snapshots })),
      );
    if (ids.length === 0) {
      res.status(202).json({ jobs: [] });
      return;
    }
    res.status(202).json({ jobs: queueMemoryRebuild(projectId, ids) });
  }),
);

memoryRouter.get(
  '/projects/:id/memory/facts',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.json({ facts: listFacts(projectId) });
  }),
);

memoryRouter.post(
  '/projects/:id/memory/facts',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    const body = parseBody(factInputSchema, req.body);
    if (!body.statement) {
      res.status(400).json({ error: 'A fact needs a statement.' });
      return;
    }
    res.status(201).json({ fact: createAuthoredFact(projectId, body) });
  }),
);

memoryRouter.patch(
  '/facts/:id',
  wrap((req, res) => {
    const body = parseBody(factInputSchema, req.body);
    res.json({ fact: updateFact(stringParam(req.params.id, 'fact id'), body) });
  }),
);

memoryRouter.post(
  '/facts/:id/accept',
  wrap((req, res) => {
    res.json({ fact: setFactStatus(stringParam(req.params.id, 'fact id'), 'established') });
  }),
);

memoryRouter.post(
  '/facts/:id/reject',
  wrap((req, res) => {
    res.json({ fact: setFactStatus(stringParam(req.params.id, 'fact id'), 'rejected') });
  }),
);

memoryRouter.post(
  '/facts/:id/supersede',
  wrap((req, res) => {
    res.json({ fact: setFactStatus(stringParam(req.params.id, 'fact id'), 'superseded') });
  }),
);

memoryRouter.delete(
  '/facts/:id',
  wrap((req, res) => {
    deleteFact(stringParam(req.params.id, 'fact id'));
    res.status(204).end();
  }),
);

memoryRouter.get(
  '/facts/:id',
  wrap((req, res) => {
    res.json({ fact: getFact(stringParam(req.params.id, 'fact id')) });
  }),
);

memoryRouter.post(
  '/projects/:id/memory/supersede-outdated',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.json({ count: supersedeOutdatedFacts(projectId) });
  }),
);
