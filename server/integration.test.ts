import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

const OUTLINE = JSON.stringify({
  chapters: [
    { title: 'The Key', brief: 'Mara finds a key that should not exist.' },
    { title: 'The Door', brief: 'The key opens a door in the hill.' },
  ],
});

const PROSE =
  'The key was warm in her hand, and the lock turned before she decided to turn it. ' +
  'Beyond the door, the observatory waited in the dark like a held breath.';

const MEMORY = JSON.stringify({
  summary:
    'Mara finds the brass key and carries it to the hill. The lock turns before she decides ' +
    'to turn it, and the buried observatory opens onto darkness. She chooses to step inside alone.',
  facts: [
    {
      kind: 'plot_thread',
      statement: 'The brass key opens the door in the hill, and someone else may want it.',
      characters: ['Mara'],
      scope: 'story',
    },
    {
      kind: 'character_development',
      statement: 'Mara decides to enter the observatory alone rather than fetch help.',
      characters: ['Mara'],
      scope: 'chapter',
    },
  ],
});

const CAST = JSON.stringify({
  characters: [
    {
      name: 'Mara',
      role: 'protagonist',
      identity: 'A young surveyor who maps abandoned places.',
      appearance: 'Cropped hair, ink-stained hands, a heavy canvas coat.',
      personality: 'Patient, stubborn, uneasy with company.',
      goals: 'Find out what the key opens before anyone else does.',
      relationships: 'Distrusts her former partner, Iven.',
    },
    {
      name: 'Iven',
      role: 'rival',
      identity: 'A disgraced archivist who once catalogued the observatory.',
      appearance: 'Tall, precise, always gloved.',
      personality: 'Charming and evasive.',
      goals: 'Recover the observatory records before Mara destroys them.',
      relationships: 'Mara was once his partner.',
    },
  ],
});

let app: Express;
let apiServer: http.Server;
let mockServer: http.Server;
let baseUrl = '';
let tempDir = '';

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function startMock(): Promise<void> {
  mockServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      json(res, 200, { data: [{ id: 'mock-model', name: 'Mock model' }] });
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        const system = parsed.messages.find((message) => message.role === 'system')?.content ?? '';
        const user = [...parsed.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
        if ((system + user).includes('FAIL')) {
          json(res, 500, { error: { message: 'Mock refusal.' } });
          return;
        }
        const text = system.includes('chapter-by-chapter outline')
          ? OUTLINE
          : system.includes('continuity archivist')
            ? MEMORY
            : system.includes('casting editor')
              ? CAST
              : system.includes('drafting prose for a novel')
                ? PROSE
                : 'A mock assistant reply.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of text.match(/[\s\S]{1,24}/g) ?? [text]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
}

async function request<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { job } = await request<{ job: { status: string; [key: string]: unknown } }>(
      'GET',
      `/jobs/${id}`,
    );
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Generation job did not finish.');
}

async function waitForMemory(chapterId: string) {
  let lastJob: string | null = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    const { memory, activeJob } = await request<{
      memory: { status: string; summary: string | null; staleReasons: string[] };
      activeJob: { id: string } | null;
    }>('GET', `/chapters/${chapterId}/memory`);
    if (activeJob) {
      lastJob = activeJob.id;
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    if (memory.status === 'current') return memory;
    if (memory.status === 'empty') throw new Error('Chapter has no text to summarise.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const detail = lastJob
    ? (await request<{ job: { status: string; error: string | null } }>('GET', `/jobs/${lastJob}`)).job
    : null;
  throw new Error(
    `Memory did not become current.${detail ? ` Last job: ${detail.status} ${detail.error ?? ''}` : ''}`,
  );
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-architect-test-'));
  process.env.DATA_DIR = tempDir;
  process.env.APP_ROOT = process.cwd();
  process.env.STORY_ARCHITECT_ENCRYPTION_KEY = '';

  await startMock();
  const mockPort = (mockServer.address() as AddressInfo).port;
  const { createApp } = await import('./app.js');
  app = createApp();
  await new Promise<void>((resolve) => {
    apiServer = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  (globalThis as { __mockPort?: number }).__mockPort = mockPort;
});

afterAll(async () => {
  // Let any automatic memory job started by the last draft settle before the
  // database is closed.
  await new Promise((resolve) => setTimeout(resolve, 150));
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  const { closeDatabase } = await import('./db.js');
  closeDatabase();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may keep the WAL file briefly; the temp directory is disposable.
  }
});

describe('stage 1 workflow', () => {
  it('configures a provider, approves an outline, drafts, revises, and exports', async () => {
    const health = await request<{ ok: boolean }>('GET', '/health');
    expect(health.ok).toBe(true);

    const mockPort = (globalThis as { __mockPort?: number }).__mockPort;
    const { connection } = await request<{ connection: { id: string; hasApiKey: boolean } }>(
      'POST',
      '/connections',
      {
        name: 'Mock',
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'secret-key',
      },
    );
    expect(connection.hasApiKey).toBe(true);
    expect(JSON.stringify(connection)).not.toContain('secret-key');

    const test = await request<{ ok: boolean; models: unknown[] }>(
      'POST',
      `/connections/${connection.id}/test`,
    );
    expect(test.ok).toBe(true);
    expect(test.models).toHaveLength(1);

    await request('PUT', '/model-roles', {
      scope: 'global',
      assignments: [{ role: 'default', connectionId: connection.id, model: 'mock-model' }],
    });

    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Integration Novel',
      premise: 'A key opens a buried observatory.',
      chapterCount: 2,
      targetChapterWords: 800,
    });

    const { job: outlineJob } = await request<{ job: { id: string } }>(
      'POST',
      `/projects/${project.id}/outline/generate`,
      {},
    );
    const outlineResult = await waitForJob(outlineJob.id);
    expect(outlineResult.status).toBe('completed');

    const outline = await request<{
      latest: { id: string; status: string; chapters: Array<{ title: string }> };
    }>('GET', `/projects/${project.id}/outline`);
    expect(outline.latest.status).toBe('draft');
    expect(outline.latest.chapters).toHaveLength(2);

    const approved = await request<{ revision: { status: string } }>(
      'POST',
      `/projects/${project.id}/outline/${outline.latest.id}/approve`,
    );
    expect(approved.revision.status).toBe('approved');

    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    expect(chapters.chapters).toHaveLength(2);

    const { job: proseJob } = await request<{ job: { id: string } }>(
      'POST',
      `/chapters/${chapters.chapters[0].id}/generate`,
      {},
    );
    const proseResult = await waitForJob(proseJob.id);
    expect(proseResult.status).toBe('completed');

    let chapter = await request<{
      chapter: {
        content: string;
        currentRevisionId: string;
        revisions: Array<{ id: string; source: string }>;
      };
    }>('GET', `/chapters/${chapters.chapters[0].id}`);
    expect(chapter.chapter.content).toContain('observatory');
    expect(chapter.chapter.revisions).toHaveLength(1);

    const edited = await request<{
      chapter: { content: string; currentRevisionId: string; revisions: unknown[] };
    }>('PUT', `/chapters/${chapters.chapters[0].id}/content`, {
      content: 'A revised opening paragraph.',
    });
    expect(edited.chapter.content).toBe('A revised opening paragraph.');
    expect(edited.chapter.revisions).toHaveLength(2);

    const restored = await request<{ revision: { source: string; version: number } }>(
      'POST',
      `/revisions/${edited.chapter.currentRevisionId}/restore`,
    );
    expect(restored.revision.source).toBe('restored');

    const failed = await request<{ job: { id: string } }>(
      'POST',
      `/chapters/${chapters.chapters[1].id}/generate`,
      { instructions: 'FAIL' },
    );
    const failedJob = await waitForJob(failed.job.id);
    expect(failedJob.status).toBe('failed');

    const conversation = await request<{ conversation: { id: string } }>(
      'POST',
      `/projects/${project.id}/conversations`,
      {},
    );
    const chat = await request<{ job: { id: string } }>(
      'POST',
      `/conversations/${conversation.conversation.id}/messages`,
      { content: 'How does the opening land?' },
    );
    expect((await waitForJob(chat.job.id)).status).toBe('completed');
    const messages = await request<{ messages: Array<{ role: string }> }>(
      'GET',
      `/conversations/${conversation.conversation.id}/messages`,
    );
    expect(messages.messages).toHaveLength(2);

    const exportResponse = await fetch(`${baseUrl}/api/projects/${project.id}/export.md`);
    const text = await exportResponse.text();
    expect(exportResponse.headers.get('content-type')).toContain('text/markdown');
    expect(text).toContain('## Chapter 1: The Key');
    expect(text).toContain('A revised opening paragraph.');

    const projectRole = await request<{ roles: Array<{ role: string; source: string }> }>(
      'GET',
      `/model-roles?projectId=${project.id}`,
    );
    expect(projectRole.roles.find((role) => role.role === 'prose')?.source).toBe('default');
  }, 30000);
});

describe('stage 2 memory, cast, and context', () => {
  it('summarises chapters, reviews facts, scopes plans, and marks edited memory stale', async () => {
    const { connections } = await request<{ connections: Array<{ id: string }> }>(
      'GET',
      '/connections',
    );
    expect(connections.length).toBeGreaterThan(0);

    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Continuity Novel',
      premise: 'A surveyor opens a buried observatory with a key that should not exist.',
      genre: 'Gothic fantasy',
      chapterCount: 2,
      targetChapterWords: 600,
    });

    const { job: outlineJob } = await request<{ job: { id: string } }>(
      'POST',
      `/projects/${project.id}/outline/generate`,
      {},
    );
    expect((await waitForJob(outlineJob.id)).status).toBe('completed');
    const outline = await request<{ latest: { id: string } }>(
      'GET',
      `/projects/${project.id}/outline`,
    );
    await request('POST', `/projects/${project.id}/outline/${outline.latest.id}/approve`);
    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    const [first, second] = chapters.chapters;

    // Manual cast plus a proposal from the outline.
    await request('POST', `/projects/${project.id}/characters`, {
      name: 'Mara',
      role: 'protagonist',
      identity: 'A surveyor who maps abandoned places.',
      appearance: 'Cropped hair and a heavy canvas coat.',
      personality: 'Patient, stubborn, uneasy with company.',
      goals: 'Learn what the key opens.',
      relationships: 'Distrusts her former partner, Iven.',
    });
    const castJob = await request<{ job: { id: string } }>(
      'POST',
      `/projects/${project.id}/characters/propose`,
      {},
    );
    expect((await waitForJob(castJob.job.id)).status).toBe('completed');
    const cast = await request<{ characters: Array<{ id: string; name: string; status: string }> }>(
      'GET',
      `/projects/${project.id}/characters`,
    );
    const iven = cast.characters.find((character) => character.name === 'Iven');
    expect(iven?.status).toBe('proposed');
    expect(cast.characters.some((character) => character.name === 'Mara')).toBe(true);
    await request('POST', `/characters/${iven!.id}/accept`);

    // Draft chapter 1; the memory role should summarise it automatically.
    const chapterJob = await request<{ job: { id: string } }>(
      'POST',
      `/chapters/${first.id}/generate`,
      {},
    );
    expect((await waitForJob(chapterJob.job.id)).status).toBe('completed');
    const memory = await waitForMemory(first.id);
    expect(memory.status).toBe('current');
    expect(memory.summary ?? '').toMatch(/observatory/i);

    const overview = await request<{
      counts: { proposedFacts: number; establishedFacts: number; activeCharacters: number };
      facts: Array<{ id: string; kind: string; status: string }>;
    }>('GET', `/projects/${project.id}/memory`);
    expect(overview.counts.activeCharacters).toBe(2);
    expect(overview.counts.proposedFacts).toBeGreaterThanOrEqual(2);
    const plotFact = overview.facts.find((fact) => fact.kind === 'plot_thread');
    expect(plotFact).toBeTruthy();
    await request('POST', `/facts/${plotFact!.id}/accept`);

    // A story-wide authored fact and a plan scoped to chapter 2.
    await request('POST', `/projects/${project.id}/memory/facts`, {
      statement: 'The observatory was built before the village was founded.',
      kind: 'world',
      factClass: 'authored',
    });
    await request('POST', `/projects/${project.id}/memory/facts`, {
      statement: 'Mara will meet Iven at the observatory door.',
      kind: 'timeline',
      factClass: 'plan',
      scopeChapterId: second.id,
    });

    type ContextResponse = {
      sections: Array<{ id: string; included: boolean; detail: string; tokens: number }>;
      requiredTokens: number;
      estimatedTokens: number;
      availableInputTokens: number;
      reservedOutputTokens: number;
      staleSummaries: number;
    };
    const firstContext = await request<ContextResponse>(
      'GET',
      `/chapters/${first.id}/context?preset=balanced`,
    );
    expect(firstContext.sections.find((section) => section.id === 'summaries')?.included).toBe(
      false,
    );
    expect(firstContext.sections.find((section) => section.id === 'characters')?.included).toBe(
      true,
    );
    // Only the story-wide authored fact is available before chapter 1.
    expect(firstContext.sections.find((section) => section.id === 'facts')?.detail).toContain(
      '1 of 1',
    );
    expect(firstContext.estimatedTokens + firstContext.reservedOutputTokens).toBeGreaterThan(
      firstContext.requiredTokens,
    );
    expect(firstContext.availableInputTokens).toBeGreaterThan(0);

    const secondContext = await request<ContextResponse>(
      'GET',
      `/chapters/${second.id}/context?preset=balanced`,
    );
    expect(secondContext.sections.find((section) => section.id === 'summaries')?.included).toBe(
      true,
    );
    // Chapter 1 summary, accepted plot fact, authored world fact, and scoped plan.
    expect(secondContext.sections.find((section) => section.id === 'facts')?.detail).toContain(
      '3 of 3',
    );
    expect(secondContext.requiredTokens).toBeLessThan(secondContext.availableInputTokens);

    // Editing an earlier chapter must surface stale memory and outdated facts.
    await request('PUT', `/chapters/${first.id}/content`, {
      content: 'Mara climbed the hill at dusk and found the door already open.',
    });
    const stale = await request<{
      memory: { status: string; staleReasons: string[] };
    }>('GET', `/chapters/${first.id}/memory`);
    expect(stale.memory.status).toBe('stale');
    expect(stale.memory.staleReasons.length).toBeGreaterThan(0);

    const afterEdit = await request<{ counts: { outdatedFacts: number } }>(
      'GET',
      `/projects/${project.id}/memory`,
    );
    expect(afterEdit.counts.outdatedFacts).toBeGreaterThanOrEqual(1);
    const superseded = await request<{ count: number }>(
      'POST',
      `/projects/${project.id}/memory/supersede-outdated`,
    );
    expect(superseded.count).toBeGreaterThanOrEqual(1);

    // Superseded facts leave prompts; the world fact and scoped plan remain.
    const afterSupersedeContext = await request<ContextResponse>(
      'GET',
      `/chapters/${second.id}/context?preset=balanced`,
    );
    expect(afterSupersedeContext.sections.find((section) => section.id === 'facts')?.detail).toContain(
      '2 of 2',
    );

    // Rebuilding refreshes the summary against the edited revision.
    const rebuild = await request<{ job: { id: string } }>(
      'POST',
      `/chapters/${first.id}/memory/rebuild`,
      {},
    );
    expect((await waitForJob(rebuild.job.id)).status).toBe('completed');
    const rebuilt = await waitForMemory(first.id);
    expect(rebuilt.status).toBe('current');
    expect(rebuilt.summary ?? '').toMatch(/observatory/i);

    // Autosave edits update an editable revision in place, so staleness must
    // also notice content changes that keep the same revision id.
    await request('PUT', `/chapters/${first.id}/content`, {
      content:
        'Mara climbed the hill at dusk and found the door already open. The hinges were warm.',
    });
    const staleAgain = await request<{ memory: { status: string } }>(
      'GET',
      `/chapters/${first.id}/memory`,
    );
    expect(staleAgain.memory.status).toBe('stale');

    const exportResponse = await fetch(`${baseUrl}/api/projects/${project.id}/export.md`);
    const text = await exportResponse.text();
    expect(text).toContain('door already open');
  }, 40000);

  it('refuses an oversized required context with an explanation', async () => {
    const hugeInstructions = 'Keep every scene grounded in the survey maps. '.repeat(400);
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Oversized Context Novel',
      instructions: hugeInstructions,
      chapterCount: 1,
    });
    const manual = await request<{ revision: { id: string; chapters: Array<{ id: string }> } }>(
      'POST',
      `/projects/${project.id}/outline/manual`,
      {},
    );
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        {
          id: manual.revision.chapters[0].id,
          title: 'The Map',
          brief: 'Mara opens the survey map and finds a door drawn on it.',
        },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);
    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    const response = await fetch(
      `${baseUrl}/api/chapters/${chapters.chapters[0].id}/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextPreset: 'focused' }),
      },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Focused|input budget/i);
  }, 20000);
});
