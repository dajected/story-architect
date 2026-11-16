import crypto from 'node:crypto';
import type { PreparedRequest } from './request-context.js';
import type {
  GenerationHistory,
  GenerationHistoryEntry,
  GenerationHistorySummary,
  GenerationJob,
  GenerationJobKind,
  GenerationJobStatus,
  JobPricing,
  JobSettingsSnapshot,
  TokenUsage,
  RequestBudgetInfo,
} from '../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from './db.js';
import { AppError, conflict, notFound } from './errors.js';
import { modelPricing } from './store/connections.js';

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
  settings: string | null;
  pricing: string | null;
  estimated_cost: number | null;
  revision_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function parseUsage(raw: string | null): TokenUsage | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as TokenUsage;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function parseSettings(raw: string | null): JobSettingsSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as JobSettingsSnapshot;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function parsePricing(raw: string | null): JobPricing | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as JobPricing;
    if (
      value &&
      typeof value === 'object' &&
      Number.isFinite(value.promptPerToken) &&
      Number.isFinite(value.completionPerToken)
    ) {
      return { ...value, currency: 'USD' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Prefer the provider-reported USD cost. Otherwise estimate using the pricing
 * saved with this job, so later model-list refreshes do not rewrite history.
 */
export function estimateJobCost(
  usage: TokenUsage | null,
  pricing: JobPricing | null,
): number | null {
  if (usage?.cost !== undefined && Number.isFinite(usage.cost) && usage.cost >= 0) return usage.cost;
  if (!usage || !pricing) return null;
  const prompt = Number(usage.promptTokens ?? 0);
  const completion = Number(usage.completionTokens ?? 0);
  if (!usage.promptTokens && !usage.completionTokens) return null;
  const cached = Math.min(prompt, Math.max(0, usage.cachedPromptTokens ?? 0));
  const written = Math.min(prompt - cached, Math.max(0, usage.cacheWriteTokens ?? 0));
  const cost = (prompt - cached - written) * pricing.promptPerToken +
    cached * (pricing.cacheReadPerToken ?? pricing.promptPerToken) +
    written * (pricing.cacheWritePerToken ?? pricing.promptPerToken) + completion * pricing.completionPerToken;
  if (!Number.isFinite(cost) || cost < 0) return null;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

function requestBudget(row: JobRow): RequestBudgetInfo | null {
  try {
    const budget = row.context_json ? JSON.parse(row.context_json)?.requestBudget : null;
    return budget && Array.isArray(budget.sections) && typeof budget.estimatedInputTokens === 'number' ? budget : null;
  } catch { return null; }
}

export function mapJob(row: JobRow): GenerationJob {
  const usage = parseUsage(row.usage);
  const pricing = parsePricing(row.pricing);
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
    usage,
    settings: parseSettings(row.settings),
    requestBudget: requestBudget(row),
    pricing,
    estimatedCost:
      row.estimated_cost === null || row.estimated_cost === undefined
        ? estimateJobCost(usage, pricing)
        : Number(row.estimated_cost),
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
  settings?: JobSettingsSnapshot | null;
  status?: 'queued' | 'running';
}): GenerationJob {
  const id = crypto.randomUUID();
  const at = timestamp();
  const pricing = modelPricing(params.connectionId, params.model);
  dbRun(
    `INSERT INTO generation_jobs (
       id, project_id, kind, status, chapter_id, conversation_id, connection_id, model,
       prompt, context_json, output, error, usage, settings, pricing, estimated_cost,
       revision_id, created_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, ?, ?, NULL, NULL, ?, ?, NULL)`,
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
    params.settings ? JSON.stringify(params.settings) : null,
    pricing ? JSON.stringify(pricing) : null,
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

interface HistoryRow extends JobRow {
  connection_name: string | null;
  chapter_title: string | null;
  chapter_order: number | null;
}

function durationMs(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

interface ImageHistoryRow {
  id: string;
  chapter_id: string | null;
  status: GenerationJobStatus;
  provider_kind: string;
  prompt: string;
  error: string | null;
  settings: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  connection_name: string | null;
  character_name: string | null;
  chapter_title: string | null;
  chapter_order: number | null;
}

/** Image runs bill per image, so surface them in the log even without token usage. */
function imageHistoryEntries(projectId: string, limit: number, activeOnly = false): GenerationHistoryEntry[] {
  const rows = dbAll<ImageHistoryRow>(
    `SELECT j.id, j.chapter_id, j.status, j.provider_kind, j.prompt, j.error, j.settings,
            j.created_at, j.started_at, j.finished_at,
            c.name AS connection_name, ch.name AS character_name,
            chap.title AS chapter_title, chap.order_index AS chapter_order
       FROM image_jobs j
       LEFT JOIN image_connections c ON c.id = j.connection_id
       LEFT JOIN characters ch ON ch.id = j.character_id
       LEFT JOIN chapters chap ON chap.id = j.chapter_id
      WHERE j.project_id = ? ${activeOnly ? "AND j.status IN ('queued', 'running')" : ""}
      ORDER BY j.created_at DESC
      LIMIT ?`,
    projectId,
    limit,
  );
  return rows.map((row) => {
    let model = row.provider_kind === 'comfyui' ? 'ComfyUI' : '';
    if (!model) {
      try {
        const settings = row.settings ? (JSON.parse(row.settings) as { model?: string }) : null;
        model = settings?.model ?? '';
      } catch {
        model = '';
      }
    }
    return {
      id: row.id,
      kind: 'image',
      status: row.status,
      model: model || 'image service',
      connectionName: row.connection_name,
      chapterId: row.chapter_id,
      chapterTitle: row.chapter_title,
      chapterOrder: row.chapter_order === null ? null : Number(row.chapter_order),
      subject: row.character_name,
      settings: null,
      requestBudget: null,
      usage: null,
      estimatedCost: null,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: durationMs(row.started_at, row.finished_at),
    } satisfies GenerationHistoryEntry;
  });
}

/**
 * Readable generation log for one project: model, sampling snapshot, token
 * usage, and an estimated cost where the provider published pricing.
 */
export function projectGenerationHistory(projectId: string, limit = 200, activeOnly = false): GenerationHistory {
  const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = dbAll<HistoryRow>(
    `SELECT j.*, c.name AS connection_name, ch.title AS chapter_title, ch.order_index AS chapter_order
       FROM generation_jobs j
       LEFT JOIN connections c ON c.id = j.connection_id
       LEFT JOIN chapters ch ON ch.id = j.chapter_id
      WHERE j.project_id = ? ${activeOnly ? "AND j.status IN ('queued', 'running')" : ""}
      ORDER BY j.created_at DESC
      LIMIT ?`,
    projectId,
    capped,
  );

  const entries: GenerationHistoryEntry[] = rows.map((row) => {
    const usage = parseUsage(row.usage);
    const pricing = parsePricing(row.pricing);
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      model: row.model,
      connectionName: row.connection_name,
      chapterId: row.chapter_id,
      chapterTitle: row.chapter_title,
      chapterOrder: row.chapter_order === null ? null : Number(row.chapter_order),
      settings: parseSettings(row.settings),
      requestBudget: requestBudget(row),
      usage,
      estimatedCost:
        row.estimated_cost === null || row.estimated_cost === undefined
          ? estimateJobCost(usage, pricing)
          : Number(row.estimated_cost),
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: durationMs(row.started_at, row.finished_at),
    };
  });
  entries.push(...imageHistoryEntries(projectId, capped, activeOnly));
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  entries.splice(capped);

  const summary: GenerationHistorySummary = {
    total: entries.length,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    active: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: null,
    pricedJobs: 0,
    unpricedJobs: 0,
    reportedCostJobs: 0,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    cacheReportedPromptTokens: 0,
  };

  let cost = 0;
  for (const entry of entries) {
    if (entry.status === 'completed') summary.completed += 1;
    else if (entry.status === 'failed') summary.failed += 1;
    else if (entry.status === 'cancelled') summary.cancelled += 1;
    else if (entry.status === 'interrupted') summary.interrupted += 1;
    else summary.active += 1;

    const prompt = Number(entry.usage?.promptTokens ?? 0);
    const completion = Number(entry.usage?.completionTokens ?? 0);
    summary.promptTokens += prompt;
    if (entry.usage?.cachedPromptTokens !== undefined) {
      summary.cachedPromptTokens += entry.usage.cachedPromptTokens;
      summary.cacheReportedPromptTokens += prompt;
    }
    summary.cacheWriteTokens += entry.usage?.cacheWriteTokens ?? 0;
    summary.completionTokens += completion;
    summary.totalTokens += Number(
      entry.usage?.totalTokens ?? (entry.usage ? prompt + completion : 0),
    );

    if (entry.estimatedCost !== null) {
      cost += entry.estimatedCost;
      summary.pricedJobs += 1;
      if (entry.usage?.cost !== undefined) summary.reportedCostJobs += 1;
    } else if (entry.usage) {
      summary.unpricedJobs += 1;
    }
  }
  if (summary.pricedJobs > 0) {
    summary.estimatedCost = Math.round(cost * 1_000_000) / 1_000_000;
  }

  return { projectId, entries, summary, limit: capped };
}

export function updateJob(
  id: string,
  patch: Partial<
    Pick<
      JobRow,
      | 'status'
      | 'output'
      | 'error'
      | 'usage'
      | 'estimated_cost'
      | 'revision_id'
      | 'finished_at'
      | 'started_at'
      | 'context_json'
      | 'settings'
    >
  >,
): GenerationJob {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.context_json !== undefined) { fields.push('context_json = ?'); values.push(patch.context_json); }
  if (patch.settings !== undefined) { fields.push('settings = ?'); values.push(patch.settings); }
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
  if (patch.estimated_cost !== undefined) {
    fields.push('estimated_cost = ?');
    values.push(patch.estimated_cost === null ? null : Number(patch.estimated_cost));
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

  const usageRaw = options.usage ? JSON.stringify(options.usage) : existing.usage;
  const usage = options.usage ?? parseUsage(existing.usage);
  const estimatedCost = estimateJobCost(usage, parsePricing(existing.pricing));

  const job = updateJob(jobId, {
    status,
    output: runtime ? runtime.output : existing.output,
    error: options.error ?? null,
    usage: usageRaw,
    estimated_cost: estimatedCost,
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

/** Keep the actual request and trimming decisions inspectable in job history. */
export function recordPreparedRequest(jobId: string, request: PreparedRequest): void {
  const row = getJobRow(jobId);
  let context: Record<string, unknown> = {};
  try { context = row.context_json ? JSON.parse(row.context_json) : {}; } catch { /* Legacy context. */ }
  const settings = parseSettings(row.settings);
  const prompt = request.messages.map((message) => `## ${message.role}\n${message.content}`).join('\n\n');
  const attempts = Array.isArray(context.requestAttempts) ? context.requestAttempts : [];
  const budget = { ...request.report, requestCount: attempts.length + 1 };
  dbRun('UPDATE generation_jobs SET prompt = ?, context_json = ?, settings = ? WHERE id = ?',
    prompt,
    JSON.stringify({ ...context, requestBudget: budget,
      requestAttempts: [...attempts, { prompt, budget }] }),
    JSON.stringify({ ...settings, maxTokens: request.maxTokens }), jobId);
}

/** Keep retry diagnostics and total paid usage, including discarded attempts. */
export function recordBackgroundAttempt(jobId: string, result: { content: string; finishReason: string | null; usage: TokenUsage | null }, totalUsage: TokenUsage | null): void {
  const row = getJobRow(jobId);
  const context = row.context_json ? JSON.parse(row.context_json) : {};
  const attempts = Array.isArray(context.requestAttempts) ? context.requestAttempts : [];
  if (attempts.length) Object.assign(attempts[attempts.length - 1], {
    output: result.content, finishReason: result.finishReason, usage: result.usage,
  });
  updateJob(jobId, { context_json: JSON.stringify({ ...context, requestAttempts: attempts }),
    usage: totalUsage ? JSON.stringify(totalUsage) : null });
}
