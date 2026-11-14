import crypto from 'node:crypto';
import type {
  GenerationJob,
  GenerationJobKind,
  GenerationJobStatus,
  TokenUsage,
} from '../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from './db.js';
import { AppError, conflict, notFound } from './errors.js';

export interface JobRow {
  id: string;
  project_id: string;
  kind: GenerationJobKind;
  status: GenerationJobStatus;
  chapter_id: string | null;
  conversation_id: string | null;
  connection_id: string;
  model: string;
  prompt: string;
  context_json: string | null;
  output: string;
  error: string | null;
  usage: string | null;
  revision_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function parseUsage(raw: string | null): TokenUsage | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenUsage;
  } catch {
    return null;
  }
}

export function mapJob(row: JobRow): GenerationJob {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    chapterId: row.chapter_id,
    conversationId: row.conversation_id,
    connectionId: row.connection_id,
    model: row.model,
    output: row.output,
    error: row.error,
    usage: parseUsage(row.usage),
    revisionId: row.revision_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function getJob(id: string): GenerationJob {
  const row = dbGet<JobRow>('SELECT * FROM generation_jobs WHERE id = ?', id);
  if (!row) throw notFound('Generation job not found.');
  return mapJob(row);
}

export function getJobRow(id: string): JobRow {
  const row = dbGet<JobRow>('SELECT * FROM generation_jobs WHERE id = ?', id);
  if (!row) throw notFound('Generation job not found.');
  return row;
}

export function createJob(params: {
  projectId: string;
  kind: GenerationJobKind;
  chapterId?: string | null;
  conversationId?: string | null;
  connectionId: string;
  model: string;
  prompt: string;
  context?: unknown;
  status?: 'queued' | 'running';
}): GenerationJob {
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO generation_jobs (
       id, project_id, kind, status, chapter_id, conversation_id, connection_id, model,
       prompt, context_json, output, error, usage, revision_id, created_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, NULL, ?, ?, NULL)`,
    id,
    params.projectId,
    params.kind,
    params.status ?? 'running',
    params.chapterId ?? null,
    params.conversationId ?? null,
    params.connectionId,
    params.model,
    params.prompt,
    params.context ? JSON.stringify(params.context) : null,
    at,
    params.status === 'queued' ? null : at,
  );
  return getJob(id);
}

export function latestChapterJob(chapterId: string): GenerationJob | null {
  const row = dbGet<JobRow>(
    `SELECT * FROM generation_jobs WHERE chapter_id = ? AND kind = 'chapter'
     ORDER BY created_at DESC LIMIT 1`,
    chapterId,
  );
  return row ? mapJob(row) : null;
}

export function activeJobForChapter(chapterId: string): GenerationJob | null {
  const row = dbGet<JobRow>(
    `SELECT * FROM generation_jobs WHERE chapter_id = ? AND status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    chapterId,
  );
  return row ? mapJob(row) : null;
}

export function latestOutlineJob(projectId: string): GenerationJob | null {
  const row = dbGet<JobRow>(
    `SELECT * FROM generation_jobs WHERE project_id = ? AND kind = 'outline'
     ORDER BY created_at DESC LIMIT 1`,
    projectId,
  );
  return row ? mapJob(row) : null;
}

export function activeOutlineJob(projectId: string): GenerationJob | null {
  const row = dbGet<JobRow>(
    `SELECT * FROM generation_jobs WHERE project_id = ? AND kind = 'outline' AND status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    projectId,
  );
  return row ? mapJob(row) : null;
}

export function activeChatJob(conversationId: string): GenerationJob | null {
  const row = dbGet<JobRow>(
    `SELECT * FROM generation_jobs WHERE conversation_id = ? AND kind = 'chat' AND status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    conversationId,
  );
  return row ? mapJob(row) : null;
}

export function activeJobForChapterKind(
  chapterId: string,
  kind: GenerationJobKind,
): GenerationJob | null {
  const row = dbGet<JobRow>(
    `SELECT * FROM generation_jobs WHERE chapter_id = ? AND kind = ? AND status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    chapterId,
    kind,
  );
  return row ? mapJob(row) : null;
}

export function activeProjectJobKind(
  projectId: string,
  kind: GenerationJobKind,
): GenerationJob | null {
  const row = dbGet<JobRow>(
    `SELECT * FROM generation_jobs WHERE project_id = ? AND kind = ? AND status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    projectId,
    kind,
  );
  return row ? mapJob(row) : null;
}

export function listActiveJobs(projectId: string): GenerationJob[] {
  const rows = dbAll<JobRow>(
    `SELECT * FROM generation_jobs
      WHERE project_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at ASC`,
    projectId,
  );
  return rows.map(mapJob);
}

export function listProjectJobs(projectId: string, limit = 20): GenerationJob[] {
  const rows = dbAll<JobRow>(
    'SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    projectId,
    limit,
  );
  return rows.map(mapJob);
}

export function updateJob(
  id: string,
  patch: Partial<
    Pick<
      JobRow,
      'status' | 'output' | 'error' | 'usage' | 'revision_id' | 'finished_at' | 'started_at'
    >
  >,
): GenerationJob {
  const fields: string[] = [];
  const values: Array<string | null> = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.output !== undefined) {
    fields.push('output = ?');
    values.push(patch.output);
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    values.push(patch.error);
  }
  if (patch.usage !== undefined) {
    fields.push('usage = ?');
    values.push(patch.usage);
  }
  if (patch.revision_id !== undefined) {
    fields.push('revision_id = ?');
    values.push(patch.revision_id);
  }
  if (patch.finished_at !== undefined) {
    fields.push('finished_at = ?');
    values.push(patch.finished_at);
  }
  if (patch.started_at !== undefined) {
    fields.push('started_at = ?');
    values.push(patch.started_at);
  }
  if (fields.length > 0) {
    dbRun(`UPDATE generation_jobs SET ${fields.join(', ')} WHERE id = ?`, ...values, id);
  }
  return getJob(id);
}

export type JobEvent = { type: 'delta'; text: string } | { type: 'status'; job: GenerationJob };

interface JobRuntime {
  controller: AbortController;
  output: string;
  listeners: Set<(event: JobEvent) => void>;
  lastPersist: number;
}

const runtimes = new Map<string, JobRuntime>();

export function createRuntime(jobId: string): JobRuntime {
  const runtime: JobRuntime = {
    controller: new AbortController(),
    output: '',
    listeners: new Set(),
    lastPersist: Date.now(),
  };
  runtimes.set(jobId, runtime);
  return runtime;
}

export function getRuntime(jobId: string): JobRuntime | undefined {
  return runtimes.get(jobId);
}

export function liveOutput(jobId: string): string | null {
  return runtimes.get(jobId)?.output ?? null;
}

export function appendOutput(jobId: string, text: string): void {
  const runtime = runtimes.get(jobId);
  if (!runtime) return;
  runtime.output += text;
  for (const listener of runtime.listeners) {
    try {
      listener({ type: 'delta', text });
    } catch {
      // A broken SSE client must not stop generation.
    }
  }
  if (Date.now() - runtime.lastPersist > 500) {
    runtime.lastPersist = Date.now();
    updateJob(jobId, { output: runtime.output });
  }
}

export function outputSoFar(jobId: string): string {
  const runtime = runtimes.get(jobId);
  return runtime ? runtime.output : getJobRow(jobId).output;
}

export function subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
  const runtime = runtimes.get(jobId);
  if (!runtime) return () => {};
  runtime.listeners.add(listener);
  return () => {
    runtime.listeners.delete(listener);
  };
}

export function finalizeJob(
  jobId: string,
  status: GenerationJobStatus,
  options: { error?: string | null; usage?: TokenUsage | null; revisionId?: string | null } = {},
): GenerationJob {
  const runtime = runtimes.get(jobId);
  const existing = getJobRow(jobId);
  if (existing.status === 'cancelled' && status !== 'cancelled') {
    status = 'cancelled';
  }

  const job = updateJob(jobId, {
    status,
    output: runtime ? runtime.output : existing.output,
    error: options.error ?? null,
    usage: options.usage ? JSON.stringify(options.usage) : existing.usage,
    revision_id: options.revisionId === undefined ? existing.revision_id : options.revisionId,
    finished_at: timestamp(),
  });

  if (runtime) {
    for (const listener of runtime.listeners) {
      try {
        listener({ type: 'status', job });
      } catch {
        // Ignore broken listeners.
      }
    }
    runtimes.delete(jobId);
  }
  return job;
}

export function stopJobRuntime(jobId: string): void {
  const runtime = runtimes.get(jobId);
  if (!runtime) return;
  runtime.controller.abort();
}

export function cancelJob(jobId: string): GenerationJob {
  const job = getJob(jobId);
  if (!['queued', 'running'].includes(job.status)) {
    throw conflict('This generation has already finished.');
  }
  const runtime = runtimes.get(jobId);
  if (!runtime) {
    return finalizeJob(jobId, 'cancelled', {
      error: 'Cancelled. Partial output, if any, is kept.',
    });
  }
  runtime.controller.abort();
  return updateJob(jobId, {});
}

export function isTerminal(status: GenerationJobStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}

export function assertJobTerminal(job: GenerationJob): void {
  if (!isTerminal(job.status)) {
    throw new AppError(409, 'This generation is still running.');
  }
}

export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}
