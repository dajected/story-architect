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
