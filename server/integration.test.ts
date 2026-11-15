import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { RequestBudgetInfo } from '../shared/types.js';

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
  appearances: [
    {
      character: 'Mara',
      appearance:
        'Cropped hair stiff with salt, ink-stained hands, a torn canvas coat and the brass key at her belt.',
    },
  ],
});
const STORY_STATE = 'Situation: Mara has entered the observatory with the brass key.\nOpen threads: discover who made the key and find the missing records.\nRelationships: Mara distrusts Iven, her former partner.\nKnowledge: Mara knows the key opens the observatory; Iven has not been told what she found.';

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

const REWRITE = 'A colder opening: the key was already warm, and the lock had turned itself.';

const REVIEW =
  'Continuity review: no conflicts found. The brass key and the observatory match accepted memory.';

const IMAGE_PROMPT =
  'A painterly portrait of Mara in a canvas coat before the observatory door, warm lamplight, ' +
  'cinematic framing, detailed character design.';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

let app: Express;
let apiServer: http.Server;
let mockServer: http.Server;
let baseUrl = '';
let tempDir = '';
let comfyPromptText = '';
let comfyReference = '';
let referenceUploads = 0;
let recoveryHistoryReads = 0;
let comfySubmissions = 0;
let lastImagePromptSystem = '';
const submittedImagePrompts: string[] = [];
const shortTaskReplyBudgets: number[] = [];

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function legacyBackupWithoutStoryStates(bytes: ArrayBuffer): Buffer {
  const tar = zlib.gunzipSync(Buffer.from(bytes));
  const size = Number.parseInt(tar.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim(), 8);
  const manifest = JSON.parse(tar.subarray(512, 512 + size).toString('utf8'));
  delete manifest.storyStates;
  const payload = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.from(tar.subarray(0, 512));
  header.write(payload.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.fill(32, 148, 156);
  header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return zlib.gzipSync(Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512),
    tar.subarray(512 + Math.ceil(size / 512) * 512)]));
}

function startMock(): Promise<void> {
  mockServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      json(res, 200, {
        data: [
          {
            id: 'mock-model',
            name: 'Mock model',
            context_length: 128000,
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
        ],
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { prompt?: string };
        if (!parsed.prompt) {
          json(res, 400, { error: { message: 'Prompt is required.' } });
          return;
        }
        submittedImagePrompts.push(parsed.prompt);
        json(res, 200, {
          created: Math.floor(Date.now() / 1000),
          data: [{ b64_json: TINY_PNG, revised_prompt: parsed.prompt }],
        });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/comfy/system_stats') {
      json(res, 200, { system: { comfyui_version: '0.3.0-test' } });
      return;
    }
    if (req.method === 'POST' && req.url === '/comfy/upload/image') {
      referenceUploads++; req.resume(); json(res,200,{name:'reference.png',subfolder:'portraits'}); return;
    }
    if (req.method === 'POST' && req.url === '/comfy/prompt') {
      comfySubmissions++;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as {
          prompt?: { '6'?: { inputs?: { text?: string } }; '4'?: {inputs?: {image?: string}} };
        };
        const text = parsed.prompt?.['6']?.inputs?.text ?? '';
        if (!text) {
          json(res, 400, { error: { message: 'The prompt node was not mapped.' } });
          return;
        }
        comfyPromptText = text;
        comfyReference = parsed.prompt?.['4']?.inputs?.image ?? '';
        json(res, 200, { prompt_id: 'comfy-test-prompt', number: 1, node_errors: {} });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/comfy/history/recovery-prompt') {
      recoveryHistoryReads++;
      json(res, 200, recoveryHistoryReads === 1 ? {} : {
        'recovery-prompt': {
          status: { completed: true, status_str: 'success' },
          outputs: { '9': { images: [{ filename: 'portrait.png', subfolder: '', type: 'output' }] } },
        },
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/comfy/history/comfy-test-prompt') {
      json(res, 200, {
        'comfy-test-prompt': {
          status: { completed: true, status_str: 'success' },
          outputs: {
            '9': { images: [{ filename: 'portrait.png', subfolder: '', type: 'output' }] },
          },
        },
      });
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/comfy/view')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from(TINY_PNG, 'base64'));
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { max_tokens?: number; messages: Array<{ role: string; content: string }> };
        const system = parsed.messages.find((message) => message.role === 'system')?.content ?? '';
        const user = [...parsed.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
        if ((system + user).includes('FAIL')) {
          json(res, 500, { error: { message: 'Mock refusal.' } });
          return;
        }
        if (system.includes('art director')) lastImagePromptSystem = system;
        const continuing = user.includes('Continue the SAME chapter');
        const recoverCutoff = system.includes('RECOVER_CUTOFF') && system.includes('drafting prose for a novel');
        const background = system.includes('continuity archivist') || system.includes('story-state editor');
        const retryMemory = background && (system + user).includes('MEMORY_REPLY_RETRY');
        const exhaustMemory = background && (system + user).includes('MEMORY_REPLY_EXHAUST');
        const limitedMemory = exhaustMemory || (retryMemory && (parsed.max_tokens ?? 0) < 6000);
        const imagePrompt = system.includes('art director');
        const retryImage = imagePrompt && /IMAGE_REPLY_RETRY|IMAGE_REPLY_CANCEL/.test(system + user);
        const limitedImage = imagePrompt && ((system + user).includes('IMAGE_REPLY_EXHAUST') || (retryImage && (parsed.max_tokens ?? 0) < 6000));
        const invalidImage = imagePrompt && (system + user).includes('IMAGE_INVALID_JSON') && (parsed.max_tokens ?? 0) < 6000;
        const shortTask = system.includes('continuity editor') || system.includes('terse, concrete fiction-planning suggestions');
        const retryShort = shortTask && (system + user).includes('SHORT_REPLY_RETRY');
        if (retryShort) shortTaskReplyBudgets.push(parsed.max_tokens!);
        const limitedShort = retryShort && (parsed.max_tokens ?? 0) < 6000;
        const limitedOutline = system.includes('chapter-by-chapter outline') &&
          (system + user).includes('OUTLINE_REPLY_RETRY') && (parsed.max_tokens ?? 0) < 6000;
        const text = limitedOutline ? '' : limitedImage ? 'PARTIAL_IMAGE_PROMPT: a portrait of Mara'
          : invalidImage ? 'Here is the prompt:\n{"prompt":"unclosed'
          : limitedShort ? 'PARTIAL_SHORT_TASK'
          : limitedMemory ? '{"summary":"partial memory'
          : recoverCutoff
          ? continuing ? PROSE.slice(80) : PROSE.slice(0, 80)
          : (system + user).includes('REFUSE_PROMPT')
          ? "I'm sorry, but I need the character's details (name, appearance, clothing, and setting) before I can write the prompt. Please provide that information."
          : (system + user).includes('JSON_PROMPT')
            ? JSON.stringify({ prompt: IMAGE_PROMPT })
            : system.includes('art director')
              ? IMAGE_PROMPT
              : system.includes('chapter-by-chapter outline')
                ? OUTLINE
                : system.includes('story-state editor')
                  ? STORY_STATE
                  : system.includes('continuity archivist')
                  ? MEMORY
                  : system.includes('casting editor')
                    ? CAST
                    : system.includes('line editor')
                      ? REWRITE
                      : system.includes('continuity editor')
                        ? REVIEW
                        : system.includes('drafting prose for a novel')
                          ? PROSE
                          : 'A mock assistant reply.';
        const slow = (system + user).includes('SLOW');
        const writeStream = () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const chunk of text.match(/[\s\S]{1,24}/g) ?? [text]) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: limitedOutline || limitedImage || limitedShort || limitedMemory || (system + user).includes('TRUNCATE_CHAPTER') || (recoverCutoff && !continuing) ? 'length' : 'stop' }] })}\n\n`);
          const limited = limitedOutline || limitedImage || limitedMemory || limitedShort;
          const completionTokens = limited ? parsed.max_tokens! : retryMemory || retryImage ? 1500 : 50;
          res.write(
            `data: ${JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 100, completion_tokens: completionTokens, total_tokens: 100 + completionTokens,
                ...(limited || retryMemory || retryImage ? { completion_tokens_details: { reasoning_tokens: limited ? completionTokens - 32 : 400 } } : {}) },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        };
        if (slow || (imagePrompt && (system + user).includes('IMAGE_REPLY_CANCEL') && (parsed.max_tokens ?? 0) >= 6000)) setTimeout(writeStream, 250);
        else writeStream();
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

async function imageReplyFixture(title = 'Image reply budget') {
  const { project } = await request<{ project: { id: string } }>('POST', '/projects', { title, chapterCount: 1 });
  const { connections } = await request<{ connections: Array<{ id: string }> }>('GET', '/connections');
  await request('PUT', '/model-roles', { scope: 'project', projectId: project.id,
    assignments: [{ role: 'image_prompt', connectionId: connections[0].id, model: 'mock-model' }] });
  const { revision } = await request<{ revision: { id: string; chapters: Array<{ id: string }> } }>('POST', `/projects/${project.id}/outline/manual`, {});
  await request('PUT', `/projects/${project.id}/outline`, { revisionId: revision.id,
    chapters: [{ id: revision.chapters[0].id, title: 'The Door', brief: 'Mara enters the observatory.' }] });
  await request('POST', `/projects/${project.id}/outline/${revision.id}/approve`);
  const { chapters } = await request<{ chapters: Array<{ id: string }> }>('GET', `/projects/${project.id}/chapters`);
  await request('PUT', `/chapters/${chapters[0].id}/content`, { content: PROSE });
  const { character } = await request<{ character: { id: string } }>('POST', `/projects/${project.id}/characters`, {
    name: 'Mara', role: 'protagonist', appearance: 'A surveyor in a canvas coat.',
  });
  const mockPort = (globalThis as { __mockPort?: number }).__mockPort;
  const { connection } = await request<{ connection: { id: string } }>('POST', '/image-connections', {
    name: `Image retry service ${project.id}`, kind: 'openai-images', baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    settings: { model: 'mock-image', size: '1024x1024' },
  });
  return { projectId: project.id, chapterId: chapters[0].id, characterId: character.id, connectionId: connection.id };
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

async function waitForImageJob(id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const { job } = await request<{ job: { status: string; error?: string | null } }>(
      'GET',
      `/image-jobs/${id}`,
    );
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Image job did not finish.');
}

async function waitForChapterBatch(projectId: string) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const { batch } = await request<{
      batch: {
        status: string;
        mode: string;
        message: string | null;
        items: Array<{ status: string; chapterId: string; error: string | null }>;
      };
    }>('GET', `/projects/${projectId}/chapter-batch`);
    if (batch.status !== 'running') return batch;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Chapter batch did not finish.');
}

async function waitForPortraitBatch(characterId: string) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const { batch } = await request<{
      batch: {
        status: string;
        message: string | null;
        items: Array<{
          status: string;
          chapterId: string;
          assetId: string | null;
          error: string | null;
        }>;
      } | null;
    }>('GET', `/characters/${characterId}/portrait-batch`);
    if (batch && batch.status !== 'running') return batch;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Portrait batch did not finish.');
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

async function waitForMemoryIdle(chapterId: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const { activeJob } = await request<{ activeJob: { id: string } | null }>(
      'GET',
      `/chapters/${chapterId}/memory`,
    );
    if (!activeJob) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Memory stayed busy.');
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
  it('retries an automatic reasoning-only outline cutoff and preserves an explicit reply limit', async () => {
    for (const automatic of [true, false]) {
      const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
        title: 'Outline budget recovery', premise: 'OUTLINE_REPLY_RETRY', chapterCount: 8,
      });
      await request('PATCH', `/projects/${project.id}/settings`, {
        generation: { maxTokens: automatic ? null : 2272 },
      });
      const { job } = await request<{ job: { id: string } }>('POST', `/projects/${project.id}/outline/generate`, {});
      const result = await waitForJob(job.id);
      expect(result.status).toBe(automatic ? 'completed' : 'failed');
      const { getJobRow } = await import('./jobs.js');
      const context = JSON.parse(getJobRow(job.id).context_json!);
      expect(context.requestAttempts).toHaveLength(automatic ? 2 : 1);
      const { latest } = await request<{ latest: { chapters: unknown[] } | null }>('GET', `/projects/${project.id}/outline`);
      if (automatic) {
        expect(latest?.chapters).toHaveLength(2);
        expect((result.usage as { completionTokens: number }).completionTokens).toBe(4146);
      } else expect(latest).toBeNull();
    }
  });

  it('retries reasoning-limited memory and checkpoint updates as complete responses', async () => {
    const { getJobRow } = await import('./jobs.js');
    const { inspectStoryState } = await import('./store/story-state.js');
    const { dbAll } = await import('./db.js');
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'MEMORY_REPLY_RETRY', chapterCount: 1,
    });
    const { revision } = await request<{ revision: { id: string; chapters: Array<{ id: string }> } }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, { revisionId: revision.id,
      chapters: [{ id: revision.chapters[0].id, title: 'The Key', brief: 'Mara enters the observatory.' }] });
    await request('POST', `/projects/${project.id}/outline/${revision.id}/approve`);
    const { chapters } = await request<{ chapters: Array<{ id: string }> }>('GET', `/projects/${project.id}/chapters`);
    await request('PUT', `/chapters/${chapters[0].id}/content`, { content: PROSE });
    const { job } = await request<{ job: { id: string } }>('POST', `/chapters/${chapters[0].id}/memory/rebuild`, {});
    const completed = await waitForJob(job.id);
    expect(completed.status).toBe('completed');
    expect(completed.output).toBe(MEMORY);
    expect(completed.usage).toMatchObject({ completionTokens: 5596, reasoningTokens: 4464 });
    const attempts = JSON.parse(getJobRow(job.id).context_json!).requestAttempts;
    expect(attempts.map((attempt: { budget: { reservedOutputTokens: number } }) => attempt.budget.reservedOutputTokens)).toEqual([4096, 8192]);
    expect(attempts[0].output).toBe('{"summary":"partial memory');
    expect(attempts[1].output).toBe(MEMORY);
    expect(attempts[0].prompt).toBe(attempts[1].prompt);
    await waitForMemory(chapters[0].id);
    expect(inspectStoryState(project.id, 1).info.status).toBe('current');
    const checkpoint = dbAll<{ context_json: string; output: string; status: string }>(
      'SELECT context_json, output, status FROM generation_jobs WHERE project_id = ?', project.id,
    ).find((row) => JSON.parse(row.context_json).stage === 'story_state')!;
    expect(checkpoint.status).toBe('completed');
    expect(checkpoint.output).toBe(STORY_STATE);
    expect(JSON.parse(checkpoint.context_json).requestAttempts).toHaveLength(2);
  });

  it('keeps failed memory unapplied and accounts for all capped retry attempts', async () => {
    const { getChapterMemory } = await import('./store/memory.js');
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'MEMORY_REPLY_EXHAUST', chapterCount: 1,
    });
    const { revision } = await request<{ revision: { id: string; chapters: Array<{ id: string }> } }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, { revisionId: revision.id,
      chapters: [{ id: revision.chapters[0].id, title: 'The Key', brief: 'Mara enters the observatory.' }] });
    await request('POST', `/projects/${project.id}/outline/${revision.id}/approve`);
    const { chapters } = await request<{ chapters: Array<{ id: string }> }>('GET', `/projects/${project.id}/chapters`);
    await request('PUT', `/chapters/${chapters[0].id}/content`, { content: PROSE });
    const { job } = await request<{ job: { id: string } }>('POST', `/chapters/${chapters[0].id}/memory/rebuild`, {});
    const failed = await waitForJob(job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/after 3 request/);
    expect(failed.output).toBe('{"summary":"partial memory');
    expect(failed.usage).toMatchObject({ completionTokens: 28672, reasoningTokens: 28576 });
    expect(getChapterMemory(chapters[0].id).status).toBe('missing');
    const { chapter } = await request<{ chapter: { content: string } }>('GET', `/chapters/${chapters[0].id}`);
    expect(chapter.content).toBe(PROSE);
  });

  it('uses one cached state for a long novel, rebuilds after edits, and restores checkpoint provenance', async () => {
    const { inspectStoryState, stateSource, saveStoryState } = await import('./store/story-state.js');
    const { getChapter } = await import('./store/chapters.js');
    const { getJobRow } = await import('./jobs.js');
    const { dbAll } = await import('./db.js');
    const { ensureStoryStateThrough } = await import('./story-state-generation.js');
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Long Novel State', chapterCount: 26,
    });
    const { revision } = await request<{ revision: { id: string; chapters: Array<{ id: string }> } }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: revision.id,
      chapters: Array.from({ length: 26 }, (_, index) => ({
        id: index === 0 ? revision.chapters[0].id : `${project.id}-${index}`,
        title: `State Chapter ${index + 1}`, brief: 'Mara uses the brass key to enter the north door.',
      })),
    });
    await request('POST', `/projects/${project.id}/outline/${revision.id}/approve`);
    const { chapters } = await request<{ chapters: Array<{ id: string }> }>('GET', `/projects/${project.id}/chapters`);
    for (const [index, chapter] of chapters.entries()) {
      await request('PUT', `/chapters/${chapter.id}/content`, { content: `${PROSE}\nMANUSCRIPT_SOURCE_${index + 1}` });
      if (index < 25) await request('PATCH', `/chapters/${chapter.id}/memory`, {
        summary: `ARCHIVE_SUMMARY_${index + 1}: Mara carries the brass key through the observatory.`,
      });
    }
    await request('POST', `/projects/${project.id}/memory/facts`, {
      statement: 'The brass key opens only the north door. IMPORTANT_OLD_DETAIL.', factClass: 'authored',
    });
    await request('POST', `/projects/${project.id}/memory/facts`, {
      statement: 'A distant librarian enjoys rose tea. IRRELEVANT_ARCHIVE_DETAIL.', factClass: 'authored',
    });
    const target = chapters[25].id;
    const initial = await request<{ storyState: { status: string } }>('GET', `/chapters/${target}/context`);
    expect(initial.storyState.status).toBe('missing');
    const draft = await request<{ job: { id: string } }>('POST', `/chapters/${target}/generate`, {});
    expect((await waitForJob(draft.job.id)).status).toBe('completed');
    const prompt = getJobRow(draft.job.id).prompt;
    expect(prompt).toContain(STORY_STATE);
    expect(prompt).toContain('IMPORTANT_OLD_DETAIL');
    expect(prompt).not.toContain('IRRELEVANT_ARCHIVE_DETAIL');
    expect(prompt).not.toContain('ARCHIVE_SUMMARY_');
    expect(prompt).not.toContain('MANUSCRIPT_SOURCE_26');
    const info = await request<{ storyState: { status: string; throughChapterNumber: number }; estimatedTokens: number }>('GET', `/chapters/${target}/context`);
    expect(info.storyState.status).toBe('current');
    expect(info.storyState.throughChapterNumber).toBe(25);
    expect(info.estimatedTokens).toBeLessThan(2500);
    const checkpointJobs = () => dbAll<{ context_json: string; prompt: string }>('SELECT context_json, prompt FROM generation_jobs WHERE project_id = ?', project.id)
      .filter((job) => JSON.parse(job.context_json ?? '{}').stage === 'story_state');
    expect(checkpointJobs()).toHaveLength(25);
    expect(checkpointJobs().every((job) => (job.prompt.match(/ARCHIVE_SUMMARY_/g) ?? []).length === 1)).toBe(true);
    const cached = await request<{ job: { id: string } }>('POST', `/chapters/${target}/generate`, {});
    expect((await waitForJob(cached.job.id)).status).toBe('completed');
    expect(checkpointJobs()).toHaveLength(25);

    const bytes = await fetch(`${baseUrl}/api/projects/${project.id}/backup`).then((response) => response.arrayBuffer());
    const restored = await fetch(`${baseUrl}/api/projects/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: bytes,
    }).then((response) => response.json()) as { project: { id: string } };
    const restoredState = inspectStoryState(restored.project.id, 25);
    expect(restoredState.info.status).toBe('current');
    expect(restoredState.info.text).toBe(STORY_STATE);
    expect(restoredState.info.throughChapterId).not.toBe(chapters[24].id);

    const legacyResponse = await fetch(`${baseUrl}/api/projects/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: legacyBackupWithoutStoryStates(bytes),
    });
    expect(legacyResponse.status).toBe(201);
    const legacy = await legacyResponse.json() as { project: { id: string } };
    const legacyChapters = await request<{ chapters: Array<{ id: string }> }>('GET', `/projects/${legacy.project.id}/chapters`);
    expect(inspectStoryState(legacy.project.id, 25).info.status).toBe('missing');
    const legacyDraft = await request<{ job: { id: string } }>('POST', `/chapters/${legacyChapters.chapters[25].id}/generate`, {});
    expect((await waitForJob(legacyDraft.job.id)).status).toBe('completed');
    expect(inspectStoryState(legacy.project.id, 25).info.status).toBe('current');

    const oldVersion = inspectStoryState(project.id, 25).checkpoint!.version;
    const oldSource = stateSource(getChapter(chapters[24].id), inspectStoryState(project.id, 24).checkpoint!.version);
    const revisionId = getChapter(chapters[0].id).currentRevisionId;
    await request('PUT', `/chapters/${chapters[0].id}/content`, { content: 'Mara left the key outside. EDITED_SOURCE.' });
    expect(getChapter(chapters[0].id).currentRevisionId).toBe(revisionId);
    expect(inspectStoryState(project.id, 25).info.status).toBe('stale');
    expect(inspectStoryState(project.id, 25).info.text).toBe('');
    expect(() => saveStoryState(chapters[24].id, 'Stale update', oldSource.signature,
      inspectStoryState(project.id, 24).checkpoint?.version ?? null)).toThrow(/changed/);
    const refreshed = await request<{ job: { id: string } }>('POST', `/chapters/${target}/generate`, {});
    expect((await waitForJob(refreshed.job.id)).status).toBe('completed');
    expect(inspectStoryState(project.id, 25).info.status).toBe('current');
    expect(inspectStoryState(project.id, 25).checkpoint!.version).not.toBe(oldVersion);
    await request('PATCH', `/chapters/${chapters[12].id}/memory`, { summary: 'Mara now knows Iven hid the records.' });
    expect(inspectStoryState(project.id, 12).info.status).toBe('current');
    expect(inspectStoryState(project.id, 25).info.status).toBe('stale');
    await ensureStoryStateThrough(chapters[24].id);
    expect(inspectStoryState(project.id, 25).info.status).toBe('current');
  }, 30000);

  it('resumes a limited chapter as one saved revision and builds memory only after completion', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Resumable Chapter', chapterCount: 2,
    });
    const outline = await request<{ job: { id: string } }>('POST', `/projects/${project.id}/outline/generate`, {});
    expect((await waitForJob(outline.job.id)).status).toBe('completed');
    const { latest } = await request<{ latest: { id: string } }>('GET', `/projects/${project.id}/outline`);
    await request('POST', `/projects/${project.id}/outline/${latest.id}/approve`);
    const { chapters } = await request<{ chapters: Array<{ id: string }> }>('GET', `/projects/${project.id}/chapters`);
    const { job } = await request<{ job: { id: string } }>('POST', `/chapters/${chapters[0].id}/generate`, {
      instructions: 'RECOVER_CUTOFF',
    });
    const completed = await waitForJob(job.id);
    expect(completed.status).toBe('completed');
    expect(completed.output).toBe(PROSE);
    expect(completed.usage).toMatchObject({ promptTokens: 200, completionTokens: 100, totalTokens: 300 });
    const { chapter } = await request<{ chapter: { content: string; currentRevisionId: string } }>('GET', `/chapters/${chapters[0].id}`);
    expect(chapter.content).toBe(PROSE);
    expect(chapter.currentRevisionId).toBe(completed.revisionId);
    const { getJobRow } = await import('./jobs.js');
    const context = JSON.parse(getJobRow(job.id).context_json!);
    expect(context.requestAttempts).toHaveLength(2);
    expect(context.requestAttempts[1].prompt).toContain('Continue the SAME chapter');
    await waitForMemory(chapters[0].id);
  });

  it('stops a full-story batch when a chapter cannot make progress after a cutoff', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Stop on Chapter Failure', chapterCount: 2, instructions: 'TRUNCATE_CHAPTER',
    });
    // A manual outline avoids truncating the outline-generation response too.
    const { revision } = await request<{ revision: { id: string; chapters: Array<{ id: string }> } }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: revision.id,
      chapters: [
        { id: revision.chapters[0].id, title: 'The Key', brief: 'Mara finds the key.' },
        { id: 'later-chapter', title: 'The Door', brief: 'Mara opens the door.' },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${revision.id}/approve`);
    await request('POST', `/projects/${project.id}/chapter-batch`, { mode: 'regenerate' });
    const batch = await waitForChapterBatch(project.id);
    expect(batch.status).toBe('interrupted');
    expect(batch.items.map((item) => item.status)).toEqual(['failed', 'skipped']);
    expect(batch.message).toMatch(/Stopped at Chapter 1/);
    expect(batch.items[1].error).toMatch(/Chapter 1 failed/);
    const { chapters } = await request<{ chapters: Array<{ currentRevisionId: string | null }> }>('GET', `/projects/${project.id}/chapters`);
    expect(chapters.every((chapter) => chapter.currentRevisionId === null)).toBe(true);
  });

  it('fits combined memory, review, chat history, and drafting to a small model window', async () => {
    const { listConnections, saveConnectionModels } = await import('./store/connections.js');
    const { addMessage } = await import('./store/chat.js');
    const { getJobRow } = await import('./jobs.js');
    const connection = listConnections()[0];
    saveConnectionModels(connection.id, connection.models.map((model) => ({ ...model, contextLength: 6000 })));
    try {
      const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
        title: 'Large Context Novel', chapterCount: 2,
      });
      const outline = await request<{ job: { id: string } }>('POST', `/projects/${project.id}/outline/generate`, {});
      expect((await waitForJob(outline.job.id)).status).toBe('completed');
      const { latest } = await request<{ latest: { id: string } }>('GET', `/projects/${project.id}/outline`);
      await request('POST', `/projects/${project.id}/outline/${latest.id}/approve`);
      const { chapters } = await request<{ chapters: Array<{ id: string }> }>('GET', `/projects/${project.id}/chapters`);
      await request('PUT', `/chapters/${chapters[0].id}/content`, {
        content: 'OPENING of the search. ' + 'Mara maps the observatory and follows the brass key. '.repeat(2500) + ' ENDING of the search.',
      });
      const assertBudget = async (id: string) => {
        const job = await waitForJob(id);
        expect(job.status).toBe('completed');
        const budget = job.requestBudget as RequestBudgetInfo;
        expect(budget.contextLengthKnown).toBe(true);
        expect(budget.contextLength).toBe(6000);
        expect(budget.estimatedInputTokens + budget.reservedOutputTokens + budget.safetyTokens).toBeLessThanOrEqual(6000);
        expect(getJobRow(id).prompt).not.toContain('__SA_CONTEXT_');
        return budget;
      };
      const memory = await request<{ job: { id: string } }>('POST', `/chapters/${chapters[0].id}/memory/rebuild`, {});
      const memoryBudget = await assertBudget(memory.job.id);
      expect(memoryBudget.sections.find((section) => section.label === 'Chapter text')?.trimmed).toBe(true);
      for (let index = 0; index < 20; index++) {
        await request('POST', `/projects/${project.id}/memory/facts`, {
          statement: `World fact ${index}: ` + 'The observatory walls contain survey marks. '.repeat(25),
          kind: 'world', factClass: 'authored',
        });
      }
      const review = await request<{ job: { id: string } }>('POST', `/chapters/${chapters[0].id}/review`, {});
      const reviewBudget = await assertBudget(review.job.id);
      expect(reviewBudget.sections.find((section) => section.label === 'Accepted story memory')?.included).toBe(true);
      expect(reviewBudget.sections.some((section) => section.trimmed)).toBe(true);

      const { conversation } = await request<{ conversation: { id: string } }>('POST', `/projects/${project.id}/conversations`, {});
      for (let index = 0; index < 20; index++) {
        addMessage({ conversationId: conversation.id, role: 'user', content: `Question ${index}: ` + 'Old discussion. '.repeat(100) });
        addMessage({ conversationId: conversation.id, role: 'assistant', content: `Answer ${index}: ` + 'Earlier explanation. '.repeat(100) });
      }
      const chat = await request<{ job: { id: string } }>('POST', `/conversations/${conversation.id}/messages`, {
        content: 'LATEST REQUEST: explain the brass key.', chapterId: chapters[0].id,
      });
      const chatBudget = await assertBudget(chat.job.id);
      expect(chatBudget.sections.some((section) => section.label.startsWith('Conversation turn') && !section.included)).toBe(true);
      expect(getJobRow(chat.job.id).prompt).toContain('LATEST REQUEST: explain the brass key.');
      expect(getJobRow(chat.job.id).prompt).toContain('Answer 19:');
      expect(getJobRow(chat.job.id).prompt).not.toContain('Answer 0:');

      const chapter = await request<{ job: { id: string } }>('POST', `/chapters/${chapters[1].id}/generate`, {});
      await assertBudget(chapter.job.id);
      await waitForMemory(chapters[1].id);
    } finally {
      saveConnectionModels(connection.id, connection.models);
    }
  }, 30000);

  it('keeps a token-limited chapter recoverable without replacing existing prose or building memory', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Truncated Chapter', chapterCount: 2,
    });
    const { job } = await request<{ job: { id: string } }>(
      'POST', `/projects/${project.id}/outline/generate`, {},
    );
    expect((await waitForJob(job.id)).status).toBe('completed');
    const { latest } = await request<{ latest: { id: string } }>(
      'GET', `/projects/${project.id}/outline`,
    );
    await request('POST', `/projects/${project.id}/outline/${latest.id}/approve`);
    const { chapters } = await request<{ chapters: Array<{ id: string }> }>(
      'GET', `/projects/${project.id}/chapters`,
    );
    await request('PUT', `/chapters/${chapters[0].id}/content`, { content: 'Existing complete draft.' });
    // Check both regeneration over an existing draft and a first draft.
    for (const [index, chapter] of chapters.entries()) {
      const { job: chapterJob } = await request<{ job: { id: string } }>(
        'POST', `/chapters/${chapter.id}/generate`, { instructions: 'TRUNCATE_CHAPTER' },
      );
      const finished = await waitForJob(chapterJob.id);
      expect(finished.status).toBe('failed');
      expect(finished.error).toMatch(/token limit/i);
      expect(finished.output).toBe(PROSE);
      expect(finished.revisionId).toBeNull();
      expect(finished.usage).toMatchObject({ completionTokens: 100 });
      const { chapter: detail } = await request<{ chapter: { content: string } }>(
        'GET', `/chapters/${chapter.id}`,
      );
      expect(detail.content).toBe(index === 0 ? 'Existing complete draft.' : '');
      const memory = await request<{ activeJob: unknown }>('GET', `/chapters/${chapter.id}/memory`);
      expect(memory.activeJob).toBeNull();
    }
  });

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

    // Outline generation automatically creates active characters.
    const pendingCast = await request<{ activeJob: { id: string } | null }>('GET', `/projects/${project.id}/characters`);
    if (pendingCast.activeJob) expect((await waitForJob(pendingCast.activeJob.id)).status).toBe('completed');
    const cast = await request<{ characters: Array<{ id: string; name: string; status: string }> }>('GET', `/projects/${project.id}/characters`);
    const mara = cast.characters.find((character) => character.name === 'Mara');
    const iven = cast.characters.find((character) => character.name === 'Iven');
    expect(mara?.status).toBe('active');
    expect(iven?.status).toBe('active');
    await request('PATCH', `/characters/${mara!.id}`, {
      role: 'protagonist', identity: 'A surveyor who maps abandoned places.',
      appearance: 'Cropped hair and a heavy canvas coat.',
      personality: 'Patient, stubborn, uneasy with company.', goals: 'Learn what the key opens.',
      relationships: 'Distrusts her former partner, Iven.',
    });

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
    expect(firstContext.sections.find((section) => section.id === 'story-state')?.included).toBe(
      false,
    );
    expect(firstContext.sections.find((section) => section.id === 'characters')?.included).toBe(
      true,
    );
    // The unrelated world fact stays archived until it is relevant.
    expect(firstContext.sections.find((section) => section.id === 'facts')?.detail).toContain(
      '0 of 1',
    );
    expect(firstContext.estimatedTokens + firstContext.reservedOutputTokens).toBeGreaterThan(
      firstContext.requiredTokens,
    );
    expect(firstContext.availableInputTokens).toBeGreaterThan(0);

    const secondContext = await request<ContextResponse>(
      'GET',
      `/chapters/${second.id}/context?preset=balanced`,
    );
    expect(secondContext.sections.find((section) => section.id === 'story-state')?.included).toBe(
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

    // Superseded facts leave prompts; without a valid state only the scoped plan is relevant.
    const afterSupersedeContext = await request<ContextResponse>(
      'GET',
      `/chapters/${second.id}/context?preset=balanced`,
    );
    expect(afterSupersedeContext.sections.find((section) => section.id === 'facts')?.detail).toContain(
      '1 of 2',
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

describe('stage 3 lore and writing tools', () => {
  it('activates lore predictably and applies a rewrite as a revision', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Lore Novel',
      premise: 'A surveyor opens a buried observatory with a key that should not exist.',
      chapterCount: 1,
      targetChapterWords: 500,
    });

    const manual = await request<{
      revision: { id: string; chapters: Array<{ id: string }> };
    }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        {
          id: manual.revision.chapters[0].id,
          title: 'The Door',
          brief: 'Mara opens the observatory door with the brass key.',
        },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);
    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    const chapterId = chapters.chapters[0].id;

    const { lorebook } = await request<{ lorebook: { id: string } }>(
      'POST',
      `/projects/${project.id}/lorebooks`,
      { name: 'Hill lore', description: 'The observatory and its history.' },
    );
    const always = await request<{ entry: { id: string } }>(
      'POST',
      `/projects/${project.id}/lorebooks/${lorebook.id}/entries`,
      {
        title: 'The poisoned sea',
        content: 'The sea below the hill has been poisoned since the flood.',
        triggers: [],
        alwaysInclude: true,
        priority: 80,
      },
    );
    const keyword = await request<{ entry: { id: string } }>(
      'POST',
      `/projects/${project.id}/lorebooks/${lorebook.id}/entries`,
      {
        title: 'The buried observatory',
        content: 'The observatory was sealed in 1904, long before the village.',
        triggers: ['observatory'],
        priority: 70,
      },
    );
    const irrelevant = await request<{ entry: { id: string } }>(
      'POST',
      `/projects/${project.id}/lorebooks/${lorebook.id}/entries`,
      {
        title: 'The desert road',
        content: 'The desert road is impassable in summer.',
        triggers: ['desert'],
        priority: 90,
      },
    );
    await request('POST', `/projects/${project.id}/lorebooks/${lorebook.id}/entries`, {
      title: 'Never shown',
      content: 'This entry is disabled and must not activate.',
      triggers: ['observatory'],
      enabled: false,
      priority: 95,
    });

    // A reusable book created for another novel can be linked here.
    const { project: otherProject } = await request<{ project: { id: string } }>(
      'POST',
      '/projects',
      { title: 'Shared World' },
    );
    const { lorebook: sharedBook } = await request<{ lorebook: { id: string } }>(
      'POST',
      `/projects/${otherProject.id}/lorebooks`,
      { name: 'Shared world notes' },
    );
    await request('POST', `/projects/${otherProject.id}/lorebooks/${sharedBook.id}/entries`, {
      title: 'The brass key',
      content: 'The key was cut from an alloy that does not corrode.',
      triggers: ['brass key'],
      priority: 60,
    });
    await request('POST', `/projects/${project.id}/lorebooks/${sharedBook.id}/link`, {});

    const overview = await request<{
      books: Array<{ id: string; owned: boolean }>;
      entries: Array<{ id: string; title: string; pinned: boolean }>;
      pinnedEntryIds: string[];
    }>('GET', `/projects/${project.id}/lore`);
    expect(overview.books).toHaveLength(2);
    expect(overview.books.find((book) => book.id === sharedBook.id)?.owned).toBe(false);
    expect(overview.entries).toHaveLength(5);
    expect(overview.pinnedEntryIds).toHaveLength(0);

    type LoreContext = {
      estimatedTokens: number;
      sections: Array<{ id: string; included: boolean; detail: string; tokens: number }>;
      lore: {
        activated: number;
        omitted: number;
        totalEntries: number;
        entries: Array<{ title: string; reason: string; matched: string[] }>;
        budgetTokens: number;
      };
    };
    const baseContext = await request<LoreContext>(
      'GET',
      `/chapters/${chapterId}/context?preset=balanced`,
    );
    expect(baseContext.sections.find((section) => section.id === 'lore')?.included).toBe(true);
    // This chapter has no memory yet, so section totals include every input token.
    expect(baseContext.estimatedTokens).toBe(
      baseContext.sections.reduce((total, section) => total + section.tokens, 0),
    );
    expect(baseContext.lore.totalEntries).toBe(5);
    expect(baseContext.lore.activated).toBe(3);
    const activatedTitles = baseContext.lore.entries
      .filter((entry) => entry.reason !== 'budget')
      .map((entry) => entry.title);
    expect(activatedTitles).toContain('The poisoned sea');
    expect(activatedTitles).toContain('The buried observatory');
    expect(activatedTitles).toContain('The brass key');
    expect(activatedTitles).not.toContain('The desert road');
    expect(activatedTitles).not.toContain('Never shown');
    const keywordEntry = baseContext.lore.entries.find(
      (entry) => entry.title === 'The buried observatory',
    );
    expect(keywordEntry?.reason).toBe('keyword');
    expect(keywordEntry?.matched).toContain('observatory');

    // Pinning brings an otherwise irrelevant entry into the next generation.
    await request('PUT', `/projects/${project.id}/lore/pins`, {
      entryIds: [irrelevant.entry.id, always.entry.id],
    });
    const pinnedContext = await request<LoreContext>(
      'GET',
      `/chapters/${chapterId}/context?preset=balanced`,
    );
    expect(pinnedContext.lore.activated).toBe(4);
    expect(
      pinnedContext.lore.entries.find((entry) => entry.title === 'The desert road')?.reason,
    ).toBe('manual');

    const chapterJob = await request<{ job: { id: string } }>(
      'POST',
      `/chapters/${chapterId}/generate`,
      { instructions: 'Hold the brass key in the foreground.' },
    );
    expect((await waitForJob(chapterJob.job.id)).status).toBe('completed');
    await waitForMemory(chapterId);

    // Pins were consumed by the generation.
    const afterGeneration = await request<{ pinnedEntryIds: string[] }>(
      'GET',
      `/projects/${project.id}/lore`,
    );
    expect(afterGeneration.pinnedEntryIds).toHaveLength(0);

    const detail = await request<{ chapter: { content: string } }>(
      'GET',
      `/chapters/${chapterId}`,
    );
    const selection = detail.chapter.content.slice(0, 40);
    expect(selection.length).toBe(40);
    const rewrite = await request<{ job: { id: string } }>(
      'POST',
      `/chapters/${chapterId}/rewrite`,
      { action: 'rewrite', selection, start: 0, end: 40 },
    );
    const rewriteJob = await waitForJob(rewrite.job.id);
    expect(rewriteJob.status).toBe('completed');
    expect(String(rewriteJob.output)).toContain('colder opening');

    const rewritten = await request<{
      chapter: { content: string; revisions: Array<{ source: string }> };
    }>('POST', `/jobs/${rewrite.job.id}/apply-rewrite`, { replacement: REWRITE });
    expect(rewritten.chapter.content.startsWith('A colder opening')).toBe(true);
    expect(rewritten.chapter.revisions.some((revision) => revision.source === 'rewrite')).toBe(
      true,
    );

    // Applying a rewrite changes the source text, so derived memory goes stale.
    const stale = await request<{ memory: { status: string } }>(
      'GET',
      `/chapters/${chapterId}/memory`,
    );
    expect(stale.memory.status).toBe('stale');

    // Rewrites cannot be applied against a stale selection.
    const staleApply = await fetch(`${baseUrl}/api/jobs/${rewrite.job.id}/apply-rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(staleApply.status).toBe(409);
  }, 40000);

  it('runs a continuity review and manages reusable prose instructions', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Review Novel',
      premise: 'A surveyor checks the record of a buried observatory.',
      chapterCount: 1,
    });
    const manual = await request<{
      revision: { id: string; chapters: Array<{ id: string }> };
    }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        {
          id: manual.revision.chapters[0].id,
          title: 'The Record',
          brief: 'Mara compares the survey maps against the archive.',
        },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);
    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    const chapterId = chapters.chapters[0].id;

    const generated = await request<{ job: { id: string } }>(
      'POST',
      `/chapters/${chapterId}/generate`,
      {},
    );
    expect((await waitForJob(generated.job.id)).status).toBe('completed');
    await waitForMemory(chapterId);

    const review = await request<{ job: { id: string } }>(
      'POST',
      `/chapters/${chapterId}/review`,
      {},
    );
    const reviewJob = await waitForJob(review.job.id);
    expect(reviewJob.status).toBe('completed');
    expect(String(reviewJob.output)).toContain('Continuity review');
    const beforeCorrection=await request<{chapter:import('../shared/types.js').ChapterDetail}>('GET',`/chapters/${chapterId}`);
    const corrected=await request<{chapter:import('../shared/types.js').ChapterDetail}>('POST',`/chapters/${chapterId}/review-correction`,{jobId:review.job.id,expectedContent:beforeCorrection.chapter.content,passage:'The key was warm',replacement:'The brass key was warm'});
    expect(corrected.chapter.content).toContain('The brass key was warm');
    expect(corrected.chapter.currentRevisionId).not.toBe(beforeCorrection.chapter.currentRevisionId);
    const staleCorrection=await fetch(`${baseUrl}/api/chapters/${chapterId}/review-correction`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:review.job.id,expectedContent:beforeCorrection.chapter.content,passage:'The key was warm',replacement:'The key was cold'})});
    expect(staleCorrection.status).toBe(409);

    const { instruction } = await request<{ instruction: { id: string; name: string } }>(
      'POST',
      `/projects/${project.id}/prose-instructions`,
      { name: 'Terse prose', text: 'Keep sentences under twenty words.' },
    );
    const listed = await request<{ instructions: Array<{ id: string; name: string }> }>(
      'GET',
      `/projects/${project.id}/prose-instructions`,
    );
    expect(listed.instructions).toHaveLength(1);
    const updated = await request<{ instruction: { name: string; text: string } }>(
      'PATCH',
      `/projects/${project.id}/prose-instructions/${instruction.id}`,
      { name: 'Terse prose, revised' },
    );
    expect(updated.instruction.name).toBe('Terse prose, revised');
    await request('DELETE', `/projects/${project.id}/prose-instructions/${instruction.id}`);
    const afterDelete = await request<{ instructions: unknown[] }>(
      'GET',
      `/projects/${project.id}/prose-instructions`,
    );
    expect(afterDelete.instructions).toHaveLength(0);
  }, 40000);
});

describe('stage 4 character image generation', () => {
  it.each(['IMAGE_REPLY_RETRY', 'IMAGE_INVALID_JSON'])('recovers editable and portrait prompts (%s) before submitting exactly one image', async (marker) => {
    const fixture = await imageReplyFixture();
    const { getJobRow } = await import('./jobs.js');
    const { getPortraitRequest } = await import('./store/portrait-requests.js');
    const countBefore = submittedImagePrompts.length;
    const { job } = await request<{ job: { id: string } }>('POST', `/characters/${fixture.characterId}/images/prompt`, {
      chapterId: fixture.chapterId, instructions: `${marker} JSON_PROMPT`,
    });
    const promptJob = await waitForJob(job.id);
    expect(promptJob.status).toBe('completed');
    expect(promptJob.output).toBe(IMAGE_PROMPT);
    expect(JSON.parse(getJobRow(job.id).context_json!).requestAttempts.map((attempt: { budget: { reservedOutputTokens: number } }) => attempt.budget.reservedOutputTokens)).toEqual([4096, 8192]);
    expect(submittedImagePrompts.length).toBe(countBefore);
    const { request: portrait } = await request<{ request: { id: string; promptJobId: string } }>('POST', `/chapters/${fixture.chapterId}/portraits`, {
      characterId: fixture.characterId, connectionId: fixture.connectionId, instructions: 'IMAGE_REPLY_RETRY JSON_PROMPT',
    });
    const finished = await waitForJob(portrait.promptJobId);
    expect(finished.status).toBe('completed');
    expect(finished.output).toBe(IMAGE_PROMPT);
    expect(finished.usage).toMatchObject({ completionTokens: 5596, reasoningTokens: 4464 });
    const imageId = getPortraitRequest(portrait.id).imageJobId;
    expect(imageId).toBeTruthy();
    expect((await waitForImageJob(imageId!)).status).toBe('completed');
    expect(getPortraitRequest(portrait.id).status).toBe('completed');
    expect(submittedImagePrompts.slice(countBefore)).toEqual([IMAGE_PROMPT]);
    const attempts = JSON.parse(getJobRow(portrait.promptJobId).context_json!).requestAttempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].prompt).toBe(attempts[1].prompt);
  });

  it('does not submit an image when every prompt reply is cut off', async () => {
    const fixture = await imageReplyFixture();
    const { getPortraitRequest } = await import('./store/portrait-requests.js');
    const countBefore = submittedImagePrompts.length;
    const { request: portrait } = await request<{ request: { id: string; promptJobId: string } }>('POST', `/chapters/${fixture.chapterId}/portraits`, {
      characterId: fixture.characterId, connectionId: fixture.connectionId, instructions: 'IMAGE_REPLY_EXHAUST',
    });
    const finished = await waitForJob(portrait.promptJobId);
    expect(finished.status).toBe('failed');
    expect(finished.error).toMatch(/after 3 request/);
    expect(finished.output).toContain('PARTIAL_IMAGE_PROMPT');
    expect(finished.usage).toMatchObject({ completionTokens: 28672 });
    expect(getPortraitRequest(portrait.id).status).toBe('failed');
    expect(getPortraitRequest(portrait.id).imageJobId).toBeNull();
    expect(submittedImagePrompts.length).toBe(countBefore);
  });

  it('cancels a portrait during its prompt retry without submitting an image', async () => {
    const fixture = await imageReplyFixture();
    const { getPortraitRequest } = await import('./store/portrait-requests.js');
    const countBefore = submittedImagePrompts.length;
    const { request: portrait } = await request<{ request: { id: string; promptJobId: string } }>('POST', `/chapters/${fixture.chapterId}/portraits`, {
      characterId: fixture.characterId, connectionId: fixture.connectionId, instructions: 'IMAGE_REPLY_CANCEL',
    });
    let retries = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const { job } = await request<{ job: { requestBudget?: { requestCount?: number } } }>('GET', `/jobs/${portrait.promptJobId}`);
      retries = job.requestBudget?.requestCount ?? 0;
      if (retries >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(retries).toBe(2);
    await request('POST', `/chapter-portrait-requests/${portrait.id}/cancel`, {});
    expect((await waitForJob(portrait.promptJobId)).status).toBe('cancelled');
    expect(getPortraitRequest(portrait.id).status).toBe('cancelled');
    expect(getPortraitRequest(portrait.id).imageJobId).toBeNull();
    expect(submittedImagePrompts.length).toBe(countBefore);
  });

  it('uses the shared reply policy for continuity reviews and setup suggestions too', async () => {
    const fixture = await imageReplyFixture('SHORT_REPLY_RETRY');
    shortTaskReplyBudgets.length = 0;
    const { job } = await request<{ job: { id: string } }>('POST', `/chapters/${fixture.chapterId}/review`, {});
    const finished = await waitForJob(job.id);
    expect(finished.status).toBe('completed');
    expect(finished.output).toBe(REVIEW);
    const suggestion = await request<{ value: string }>('POST', '/suggest', { field: 'title', draft: { title: 'SHORT_REPLY_RETRY' } });
    expect(suggestion.value).not.toContain('PARTIAL_SHORT_TASK');
    expect(shortTaskReplyBudgets).toEqual([4096, 8192, 4096, 8192]);
  });

  it('expands a template and saves images through both adapters', async () => {
    const mockPort = (globalThis as { __mockPort?: number }).__mockPort;
    const { connections } = await request<{ connections: Array<{ id: string }> }>(
      'GET',
      '/connections',
    );
    const textConnection = connections[0];

    await request('PUT', '/model-roles', {
      scope: 'global',
      assignments: [
        { role: 'image_prompt', connectionId: textConnection.id, model: 'mock-model' },
      ],
    });

    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Portrait Novel',
      premise: 'A surveyor opens a buried observatory and wants a record of her face.',
      genre: 'Gothic fantasy',
      tone: 'Quiet, ominous',
      styleNotes: 'Painterly and restrained.',
      chapterCount: 1,
    });
    const manual = await request<{
      revision: { id: string; chapters: Array<{ id: string }> };
    }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        {
          id: manual.revision.chapters[0].id,
          title: 'The Door',
          brief: 'Mara studies the observatory door by lamplight.',
        },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);
    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    const chapterId = chapters.chapters[0].id;

    const { character } = await request<{
      character: { id: string; name: string; portraitAssetId: string | null };
    }>('POST', `/projects/${project.id}/characters`, {
      name: 'Mara Voss',
      role: 'protagonist',
      identity: 'A young surveyor who maps abandoned places.',
      appearance: 'Cropped hair, ink-stained hands, a heavy canvas coat.',
      personality: 'Patient and stubborn.',
    });

    const { template } = await request<{
      template: { id: string; name: string; content: string };
    }>('POST', '/image-prompt-templates', {
      projectId: project.id,
      name: 'Observatory portrait',
      content:
        'Portrait of {{character_name}} in {{clothing}}, {{scene}}. Visual style: {{visual_style}}.',
      isDefault: true,
    });
    expect(template.id).toBeTruthy();

    const expansion = await request<{ job: { id: string } }>(
      'POST',
      `/characters/${character.id}/images/prompt`,
      {
        chapterId,
        templateId: template.id,
        scene: 'Standing before the observatory door at dusk.',
        clothing: 'A road-worn canvas coat',
        visualStyle: 'Painterly book-cover illustration',
      },
    );
    const expansionJob = await waitForJob(expansion.job.id);
    expect(expansionJob.status).toBe('completed');
    expect(String(expansionJob.output)).toContain('painterly portrait');

    const { connection: imagesConnection } = await request<{
      connection: { id: string; kind: string; hasApiKey: boolean };
    }>('POST', '/image-connections', {
      name: 'Mock image service',
      kind: 'openai-images',
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: 'image-service-key',
      settings: { model: 'mock-image', size: '1024x1024' },
    });
    expect(imagesConnection.hasApiKey).toBe(true);

    const generated = await request<{ job: { id: string } }>(
      'POST',
      `/characters/${character.id}/images`,
      {
        connectionId: imagesConnection.id,
        prompt: 'Edited portrait prompt: Mara before the observatory door, warm lamplight.',
        negativePrompt: 'blurry, watermark',
        chapterId,
        templateId: template.id,
        templateName: template.name,
        templateContent: template.content,
      },
    );
    const imageJob = await waitForImageJob(generated.job.id);
    expect(imageJob.status, JSON.stringify(imageJob)).toBe('completed');

    const overview = await request<{
      character: { portraitAssetId: string | null; portraitUrl: string | null };
      assets: Array<{
        id: string;
        url: string;
        prompt: string;
        negativePrompt: string;
        templateName: string | null;
        connectionName: string | null;
        providerKind: string;
        jobId: string | null;
      }>;
      jobs: Array<{ id: string; status: string }>;
    }>('GET', `/characters/${character.id}/images`);
    expect(overview.assets).toHaveLength(1);
    expect(overview.character.portraitAssetId).toBeNull();
    const asset = overview.assets[0];
    expect(asset.prompt).toContain('Edited portrait prompt');
    expect(asset.negativePrompt).toBe('blurry, watermark');
    expect(asset.templateName).toBe('Observatory portrait');
    expect(asset.connectionName).toBe('Mock image service');
    expect(asset.providerKind).toBe('openai-images');
    expect(asset.jobId).toBe(generated.job.id);

    const imageResponse = await fetch(`${baseUrl}${asset.url}`);
    expect(imageResponse.headers.get('content-type')).toContain('image/png');
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    expect(bytes[0]).toBe(0x89);

    const portrait = await request<{
      character: { portraitAssetId: string | null; portraitUrl: string | null };
    }>('POST', `/characters/${character.id}/portrait`, { assetId: asset.id });
    expect(portrait.character.portraitAssetId).toBe(asset.id);
    expect(portrait.character.portraitUrl).toContain(asset.id);

    const characters = await request<{
      characters: Array<{ id: string; portraitAssetId: string | null }>;
    }>('GET', `/projects/${project.id}/characters`);
    expect(characters.characters.find((entry) => entry.id === character.id)?.portraitAssetId).toBe(
      asset.id,
    );

    const workflow = {
      '4': {class_type:'LoadImage',inputs:{image:''}},
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
      '9': { class_type: 'SaveImage', inputs: {} },
    };
    const { connection: comfy } = await request<{ connection: { id: string } }>(
      'POST',
      '/image-connections',
      {
        name: 'Mock ComfyUI',
        kind: 'comfyui',
        baseUrl: `http://127.0.0.1:${mockPort}/comfy`,
        settings: {
          workflow: JSON.stringify(workflow),
          promptNode: '6',
          referenceNode: '4',
          promptInput: 'text',
          outputNode: '9',
          timeoutSeconds: 30,
        },
      },
    );
    const comfyTest = await request<{ ok: boolean; message: string }>(
      'POST',
      `/image-connections/${comfy.id}/test`,
    );
    expect(comfyTest.ok).toBe(true);

    const comfyJobStart = await request<{ job: { id: string } }>(
      'POST',
      `/characters/${character.id}/images`,
      {
        connectionId: comfy.id,
        prompt: 'A ComfyUI portrait of Mara at the observatory door.',
        referenceAssetId: asset.id,
        negativePrompt: 'blurry',
        chapterId,
      },
    );
    const comfyJob = await waitForImageJob(comfyJobStart.job.id);
    expect(comfyJob.status, JSON.stringify(comfyJob)).toBe('completed');
    expect(comfyPromptText).toBe('A ComfyUI portrait of Mara at the observatory door.');
    expect(referenceUploads).toBe(1);
    expect(comfyReference).toBe('portraits/reference.png');

    const afterComfy = await request<{
      assets: Array<{ jobId: string | null; providerKind: string }>;
      jobs: Array<{ id: string; status: string; remoteId: string | null }>;
    }>('GET', `/characters/${character.id}/images`);
    expect(afterComfy.assets).toHaveLength(2);
    const comfyAsset = afterComfy.assets.find((entry) => entry.jobId === comfyJobStart.job.id);
    expect(comfyAsset?.providerKind).toBe('comfyui');
    expect(afterComfy.jobs.find((entry) => entry.id === comfyJobStart.job.id)?.remoteId).toBe(
      'comfy-test-prompt',
    );

    // Image connections stay separate from text models.
    const settings = await request<{
      roles: Array<{ role: string; connectionId: string | null; model: string | null }>;
    }>('GET', '/settings');
    const prose = settings.roles.find((role) => role.role === 'prose');
    expect(prose?.connectionId).toBe(textConnection.id);
    expect(prose?.model).toBe('mock-model');
    const textConnections = await request<{ connections: unknown[] }>('GET', '/connections');
    expect(textConnections.connections).toHaveLength(1);
  }, 40000);
});

describe('stage 5 NAS operation and polish', () => {
  it('reports schema and version on the health check', async () => {
    const health = await request<{
      ok: boolean;
      version: string;
      schemaVersion: number;
      latestSchemaVersion: number;
    }>('GET', '/health');
    expect(health.ok).toBe(true);
    expect(health.version).toBe('0.2.0');
    expect(health.schemaVersion).toBe(health.latestSchemaVersion);
    expect(health.schemaVersion).toBeGreaterThanOrEqual(5);
  });

  it('keeps a running job visible and refuses a duplicate paid request', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Slow Provider Novel',
      premise: 'A long-running provider task should stay inspectable.',
    });
    const manual = await request<{
      revision: { id: string; chapters: Array<{ id: string }> };
    }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        {
          id: manual.revision.chapters[0].id,
          title: 'The Slow Reply',
          brief: 'The observatory answers after a long delay.',
        },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);
    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    const chapterId = chapters.chapters[0].id;

    const started = await request<{ job: { id: string } }>(
      'POST',
      `/chapters/${chapterId}/generate`,
      { instructions: 'SLOW' },
    );
    const running = await request<{ job: { status: string; model: string } }>(
      'GET',
      `/jobs/${started.job.id}`,
    );
    expect(['queued', 'running']).toContain(running.job.status);
    expect(running.job.model).toBe('mock-model');

    // A refreshed browser reattaches to the persisted stream and gets a snapshot.
    const streamResponse = await fetch(`${baseUrl}/api/jobs/${started.job.id}/stream`);
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeTruthy();
    const firstChunk = await reader!.read();
    const snapshot = new TextDecoder().decode(firstChunk.value);
    expect(snapshot).toContain('event: snapshot');
    expect(snapshot).toContain(started.job.id);
    await reader!.cancel();

    const duplicate = await fetch(`${baseUrl}/api/chapters/${chapterId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: 'SLOW' }),
    });
    expect(duplicate.status).toBe(409);

    const finished = await waitForJob(started.job.id);
    expect(finished.status).toBe('completed');
    await waitForMemory(chapterId);
  }, 40000);

  it('records usage and cost, then restores a full project backup', async () => {
    const { connections } = await request<{ connections: Array<{ id: string }> }>(
      'GET',
      '/connections',
    );
    const textConnection = connections[0];
    const { connections: imageConnections } = await request<{
      connections: Array<{ id: string; kind: string; name: string }>;
    }>('GET', '/image-connections');
    const imageConnection = imageConnections.find((entry) => entry.kind === 'openai-images');
    expect(imageConnection).toBeTruthy();

    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Backup Novel',
      premise: 'A surveyor archives a buried observatory before the flood.',
      genre: 'Gothic fantasy',
      chapterCount: 2,
      targetChapterWords: 500,
    });
    const manual = await request<{
      revision: { id: string; chapters: Array<{ id: string }> };
    }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        {
          id: manual.revision.chapters[0].id,
          title: 'The Key',
          brief: 'Mara finds the brass key beneath the observatory door.',
        },
        {
          id: manual.revision.chapters[1]?.id ?? cryptoId(),
          title: 'The Archive',
          brief: 'Mara opens the sealed archive and reads the first record.',
        },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);
    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    expect(chapters.chapters).toHaveLength(2);

    for (const chapter of chapters.chapters) {
      const generated = await request<{ job: { id: string } }>(
        'POST',
        `/chapters/${chapter.id}/generate`,
        {},
      );
      expect((await waitForJob(generated.job.id)).status).toBe('completed');
      await waitForMemory(chapter.id);
    }

    const memoryOverview = await request<{
      facts: Array<{ id: string; status: string }>;
    }>('GET', `/projects/${project.id}/memory`);
    const proposed = memoryOverview.facts.find((fact) => fact.status === 'proposed');
    expect(proposed).toBeTruthy();
    await request('POST', `/facts/${proposed!.id}/accept`);

    const { character } = await request<{
      character: { id: string; name: string; portraitAssetId: string | null };
    }>('POST', `/projects/${project.id}/characters`, {
      name: 'Mara Voss',
      role: 'protagonist',
      identity: 'A surveyor of abandoned places.',
      appearance: 'Cropped hair and a canvas coat.',
    });

    await request('POST', '/templates', {
      projectId: project.id,
      kind: 'prose',
      name: 'Backup prose preset',
      content:
        'Write {{chapter_title}} for {{project_title}} with {{story_memory}} and {{lore}}. Target {{target_words}} words.',
      isDefault: true,
    });
    const { template: imageTemplate } = await request<{ template: { id: string; name: string } }>(
      'POST',
      '/image-prompt-templates',
      {
        projectId: project.id,
        name: 'Backup image preset',
        content: 'Portrait of {{character_name}} in {{clothing}}, {{scene}}.',
        isDefault: true,
      },
    );

    const { lorebook } = await request<{ lorebook: { id: string } }>(
      'POST',
      `/projects/${project.id}/lorebooks`,
      { name: 'Archive lore', description: 'The observatory records.' },
    );
    await request('POST', `/projects/${project.id}/lorebooks/${lorebook.id}/entries`, {
      title: 'The brass key',
      content: 'The brass key was cut from an alloy that does not corrode.',
      triggers: ['brass key'],
      alwaysInclude: true,
      priority: 70,
    });
    const { instruction } = await request<{ instruction: { id: string } }>(
      'POST',
      `/projects/${project.id}/prose-instructions`,
      { name: 'Terse voice', text: 'Keep sentences under twenty words.' },
    );

    const conversation = await request<{ conversation: { id: string } }>(
      'POST',
      `/projects/${project.id}/conversations`,
      {},
    );
    const chat = await request<{ job: { id: string } }>(
      'POST',
      `/conversations/${conversation.conversation.id}/messages`,
      { content: 'How should the archive smell?' },
    );
    expect((await waitForJob(chat.job.id)).status).toBe('completed');

    const imageJob = await request<{ job: { id: string } }>(
      'POST',
      `/characters/${character.id}/images`,
      {
        connectionId: imageConnection!.id,
        prompt: 'A portrait of Mara in the archive, lamplight and dust.',
        negativePrompt: 'blurry',
        templateId: imageTemplate.id,
        templateName: imageTemplate.name,
        templateContent: 'Portrait of {{character_name}} in {{clothing}}, {{scene}}.',
      },
    );
    expect((await waitForImageJob(imageJob.job.id)).status).toBe('completed');
    const gallery = await request<{ assets: Array<{ id: string; url: string }> }>(
      'GET',
      `/characters/${character.id}/images`,
    );
    expect(gallery.assets).toHaveLength(1);
    await request('POST', `/characters/${character.id}/portrait`, {
      assetId: gallery.assets[0].id,
    });

    const history = await request<{
      entries: Array<{
        id: string;
        kind: string;
        model: string;
        usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
        estimatedCost: number | null;
        settings: {
          temperature: number | null;
          maxTokens: number | null;
          contextPreset?: string;
        } | null;
      }>;
      summary: {
        total: number;
        pricedJobs: number;
        estimatedCost: number | null;
        promptTokens: number;
      };
    }>('GET', `/projects/${project.id}/generation-history`);
    const chapterJob = history.entries.find((entry) => entry.kind === 'chapter');
    expect(chapterJob).toBeTruthy();
    expect(chapterJob?.model).toBe('mock-model');
    expect(chapterJob?.usage?.promptTokens).toBe(100);
    expect(chapterJob?.usage?.completionTokens).toBe(50);
    expect(chapterJob?.estimatedCost).toBe(0.0002);
    expect(chapterJob?.settings?.contextPreset).toBe('balanced');
    const imageEntry = history.entries.find((entry) => entry.kind === 'image');
    expect(imageEntry).toBeTruthy();
    expect(imageEntry?.subject).toBe('Mara Voss');
    expect(imageEntry?.status).toBe('completed');
    expect(imageEntry?.usage).toBeNull();
    expect(history.summary.pricedJobs).toBeGreaterThan(0);
    expect(history.summary.estimatedCost).toBeGreaterThan(0);
    expect(history.summary.promptTokens).toBeGreaterThan(0);

    const backupResponse = await fetch(`${baseUrl}/api/projects/${project.id}/backup`);
    expect(backupResponse.status).toBe(200);
    expect(backupResponse.headers.get('content-type')).toContain('application/gzip');
    const backupBytes = Buffer.from(await backupResponse.arrayBuffer());
    expect(backupBytes.length).toBeGreaterThan(100);
    const opened = zlib.gunzipSync(backupBytes);
    expect(opened.includes(Buffer.from('secret-key'))).toBe(false);
    expect(opened.includes(Buffer.from('image-service-key'))).toBe(false);
    expect(opened.includes(Buffer.from('Backup Novel'))).toBe(true);
    expect(opened.includes(Buffer.from('Backup prose preset'))).toBe(true);

    const restoreResponse = await fetch(`${baseUrl}/api/projects/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: backupBytes,
    });
    const restoreText = await restoreResponse.text();
    expect(restoreResponse.status, restoreText).toBe(201);
    const restored = JSON.parse(restoreText) as {
      project: { id: string; title: string; status: string };
      stats: { chapters: number; revisions: number; characters: number; images: number };
    };
    expect(restored.project.id).not.toBe(project.id);
    expect(restored.project.title).toBe('Backup Novel');
    expect(restored.project.status).toBe('active');
    expect(restored.stats.chapters).toBe(2);
    expect(restored.stats.revisions).toBe(2);
    expect(restored.stats.characters).toBe(1);
    expect(restored.stats.images).toBe(1);

    const restoredProjectId = restored.project.id;
    const restoredChapters = await request<{ chapters: Array<{ id: string; title: string }> }>(
      'GET',
      `/projects/${restoredProjectId}/chapters`,
    );
    expect(restoredChapters.chapters).toHaveLength(2);
    expect(restoredChapters.chapters.every((chapter) => chapter.id !== chapters.chapters[0].id)).toBe(
      true,
    );
    const restoredChapter = await request<{
      chapter: {
        content: string;
        currentRevisionId: string;
        revisions: Array<{ id: string; source: string }>;
      };
    }>('GET', `/chapters/${restoredChapters.chapters[0].id}`);
    expect(restoredChapter.chapter.content).toContain('observatory');
    expect(restoredChapter.chapter.revisions).toHaveLength(1);
    expect(restoredChapter.chapter.revisions[0].id).not.toBe(
      (await request<{ chapter: { revisions: Array<{ id: string }> } }>(
        'GET',
        `/chapters/${chapters.chapters[0].id}`,
      )).chapter.revisions[0].id,
    );

    // The second summary depends on the first chapter's ID in its fingerprint.
    const restoredMemory = await request<{ memory: { status: string; summary: string | null } }>(
      'GET',
      `/chapters/${restoredChapters.chapters[1].id}/memory`,
    );
    expect(restoredMemory.memory.status).toBe('current');
    expect(restoredMemory.memory.summary).toBeTruthy();

    const restoredFacts = await request<{ facts: Array<{ status: string }>; counts: { establishedFacts: number } }>(
      'GET',
      `/projects/${restoredProjectId}/memory`,
    );
    expect(restoredFacts.counts.establishedFacts).toBeGreaterThan(0);

    const restoredCast = await request<{
      characters: Array<{ id: string; name: string; portraitAssetId: string | null }>;
    }>('GET', `/projects/${restoredProjectId}/characters`);
    expect(restoredCast.characters).toHaveLength(1);
    expect(restoredCast.characters[0].name).toBe('Mara Voss');
    expect(restoredCast.characters[0].portraitAssetId).toBeTruthy();

    const restoredLore = await request<{
      books: Array<{ name: string }>;
      entries: Array<{ title: string }>;
    }>('GET', `/projects/${restoredProjectId}/lore`);
    expect(restoredLore.books.some((book) => book.name === 'Archive lore')).toBe(true);
    expect(restoredLore.entries.some((entry) => entry.title === 'The brass key')).toBe(true);

    const restoredInstructions = await request<{ instructions: Array<{ name: string }> }>(
      'GET',
      `/projects/${restoredProjectId}/prose-instructions`,
    );
    expect(restoredInstructions.instructions.some((entry) => entry.name === 'Terse voice')).toBe(true);

    const restoredConversations = await request<{
      conversations: Array<{ messageCount: number }>;
    }>('GET', `/projects/${restoredProjectId}/conversations`);
    expect(restoredConversations.conversations).toHaveLength(1);
    expect(restoredConversations.conversations[0].messageCount).toBe(2);

    const restoredTemplates = await request<{ templates: Array<{ name: string; isDefault: boolean }> }>(
      'GET',
      `/templates?projectId=${encodeURIComponent(restoredProjectId)}`,
    );
    expect(
      restoredTemplates.templates.some(
        (template) => template.name === 'Backup prose preset' && template.isDefault,
      ),
    ).toBe(true);
    const restoredImageTemplates = await request<{
      templates: Array<{ name: string; isDefault: boolean }>;
    }>('GET', `/image-prompt-templates?projectId=${encodeURIComponent(restoredProjectId)}`);
    expect(
      restoredImageTemplates.templates.some(
        (template) => template.name === 'Backup image preset' && template.isDefault,
      ),
    ).toBe(true);

    const restoredOutline = await request<{
      latest: { status: string; chapters: Array<{ id: string; title: string }> };
    }>('GET', `/projects/${restoredProjectId}/outline`);
    expect(restoredOutline.latest.status).toBe('approved');
    expect(restoredOutline.latest.chapters.map((chapter) => chapter.id).sort()).toEqual(
      restoredChapters.chapters.map((chapter) => chapter.id).sort(),
    );

    const restoredGallery = await request<{ assets: Array<{ id: string; url: string }> }>(
      'GET',
      `/characters/${restoredCast.characters[0].id}/images`,
    );
    expect(restoredGallery.assets).toHaveLength(1);
    const imageResponse = await fetch(`${baseUrl}${restoredGallery.assets[0].url}`);
    expect(imageResponse.status).toBe(200);
    const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
    expect(imageBytes[0]).toBe(0x89);

    const restoredHistory = await request<{ entries: unknown[] }>(
      'GET',
      `/projects/${restoredProjectId}/generation-history`,
    );
    expect(restoredHistory.entries).toHaveLength(0);

    // The same archive can be restored again without colliding.
    const secondRestore = await fetch(`${baseUrl}/api/projects/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: backupBytes,
    });
    const secondRestored = (await secondRestore.json()) as { project: { id: string; title: string } };
    expect(secondRestore.status).toBe(201);
    expect(secondRestored.project.title).toBe('Backup Novel');
    expect(secondRestored.project.id).not.toBe(restoredProjectId);
    expect(secondRestored.project.id).not.toBe(project.id);

    // The original project is untouched by a restore.
    const originalDetail = await request<{ chapter: { content: string } }>(
      'GET',
      `/chapters/${chapters.chapters[0].id}`,
    );
    expect(originalDetail.chapter.content).toContain('observatory');
    expect(instruction.id).toBeTruthy();
  }, 60000);
});

describe('whole-novel drafting and chapter portraits', () => {
  it('drafts every empty chapter in order and builds an end-of-chapter portrait', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Batch Novel',
      premise: 'Two chapters in a quiet house by the hill.',
      chapterCount: 2,
      targetChapterWords: 600,
    });
    const manual = await request<{
      revision: { id: string; chapters: Array<{ id: string }> };
    }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        {
          id: manual.revision.chapters[0].id,
          title: 'The Key',
          brief: 'Mara finds a key that should not exist.',
        },
        {
          id: 'batch-second-chapter',
          title: 'The Door',
          brief: 'The key opens a door in the hill.',
        },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);

    const started = await request<{ batch: { id: string; status: string; items: Array<{ status: string }> } }>(
      'POST',
      `/projects/${project.id}/chapter-batch`,
    );
    expect(started.batch.status).toBe('running');

    let finished = started.batch;
    for (let attempt = 0; attempt < 600; attempt++) {
      const { batch } = await request<{
        batch: {
          status: string;
          items: Array<{ status: string; chapterId: string }>;
          message: string | null;
        };
      }>('GET', `/projects/${project.id}/chapter-batch`);
      if (batch.status !== 'running') {
        finished = batch as typeof finished;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(finished.status).toBe('completed');
    expect(finished.items.map((item) => item.status)).toEqual(['completed', 'completed']);

    const chapters = await request<{
      chapters: Array<{ id: string; currentRevisionId: string | null; wordCount: number }>;
    }>('GET', `/projects/${project.id}/chapters`);
    expect(chapters.chapters).toHaveLength(2);
    expect(chapters.chapters.every((chapter) => Boolean(chapter.currentRevisionId))).toBe(true);
    expect(chapters.chapters.every((chapter) => chapter.wordCount > 0)).toBe(true);

    const chapterId = chapters.chapters[0].id;
    await request('POST', `/chapters/${chapterId}/append`, {
      text: 'Mara pulled her torn canvas coat tight and set the brass key on the sill.',
    });

    const { character } = await request<{ character: { id: string; name: string; keyCharacter: boolean } }>(
      'POST',
      `/projects/${project.id}/characters`,
      {
        name: 'Mara',
        role: 'protagonist',
        appearance: 'Cropped hair, ink-stained hands, a heavy canvas coat.',
        keyCharacter: true,
      },
    );
    expect(character.keyCharacter).toBe(true);

    const overview = await request<{
      hasText: boolean;
      named: Array<{ character: { id: string }; mentionCount: number }>;
    }>('GET', `/chapters/${chapterId}/portraits`);
    expect(overview.hasText).toBe(true);
    const candidate = overview.named.find((entry) => entry.character.id === character.id);
    expect(candidate?.mentionCount).toBeGreaterThan(0);

    // Rebuild memory after the key character exists so their end-of-chapter
    // appearance is recorded, then correct the record before drawing.
    await waitForMemoryIdle(chapterId);
    await request('POST', `/chapters/${chapterId}/memory/rebuild`, {});
    await waitForMemory(chapterId);
    const appearanceOverview = await request<{
      appearances: Array<{
        characterId: string;
        appearance: string | null;
        status: string;
      }>;
    }>('GET', `/chapters/${chapterId}/portraits`);
    const recorded = appearanceOverview.appearances.find(
      (entry) => entry.characterId === character.id,
    );
    expect(recorded?.status).toBe('current');
    expect(recorded?.appearance).toContain('stiff with salt');
    const edited = await request<{ appearance: { appearance: string; status: string } }>(
      'PATCH',
      `/chapters/${chapterId}/appearances/${character.id}`,
      {
        appearance:
          'Cropped salt-stiff hair, ink-stained hands, a torn canvas coat, a fresh cut above one eyebrow, the brass key at her belt.',
      },
    );
    expect(edited.appearance.status).toBe('current');

    const mockPort = (globalThis as { __mockPort?: number }).__mockPort;
    const { connection } = await request<{ connection: { id: string } }>(
      'POST',
      '/image-connections',
      {
        name: 'Batch portrait service',
        kind: 'openai-images',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'image-service-key',
        settings: { model: 'mock-image', size: '1024x1024' },
      },
    );

    // A template with no variables used to leave the prompt model with no
    // character details. The server now appends a reference block, and a
    // JSON "prompt" field is unwrapped before it reaches the image service.
    const { template } = await request<{ template: { id: string } }>(
      'POST',
      '/image-prompt-templates',
      {
        projectId: project.id,
        name: 'No variables',
        content: 'JSON_PROMPT: Create a painterly character portrait prompt.',
        isDefault: true,
      },
    );

    const startedPortrait = await request<{ request: { id: string; status: string } }>(
      'POST',
      `/chapters/${chapterId}/portraits`,
      { characterId: character.id, connectionId: connection.id, templateId: template.id },
    );
    expect(startedPortrait.request.status).toBe('prompting');

    let portraitStatus = startedPortrait.request.status;
    let assets: Array<{ id: string; characterId: string; prompt: string }> = [];
    for (let attempt = 0; attempt < 400; attempt++) {
      const data = await request<{
        activeRequests: Array<{ id: string }>;
        named: Array<{
          character: { id: string };
          latestRequest: { status: string; error: string | null } | null;
        }>;
        assets: Array<{ id: string; characterId: string; prompt: string }>;
      }>('GET', `/chapters/${chapterId}/portraits`);
      assets = data.assets;
      const requestState = data.named.find((entry) => entry.character.id === character.id)
        ?.latestRequest;
      if (requestState && requestState.status !== 'prompting' && requestState.status !== 'imaging') {
        portraitStatus = requestState.status;
        expect(requestState.error).toBeNull();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(portraitStatus).toBe('completed');
    expect(assets).toHaveLength(1);
    expect(assets[0].characterId).toBe(character.id);
    expect(assets[0].prompt).toBe(IMAGE_PROMPT);

    expect(lastImagePromptSystem).toContain('## Character and scene reference');
    expect(lastImagePromptSystem).toContain('Character name: Mara');
    expect(lastImagePromptSystem).toContain(
      'Appearance: Cropped hair, ink-stained hands, a heavy canvas coat.',
    );
    expect(lastImagePromptSystem).toContain('fresh cut above one eyebrow');
    expect(lastImagePromptSystem).toContain('Scene: A portrait of Mara at the very end of Chapter 1');
  }, 60000);

  it('rejects a clarification instead of sending it to the image service', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Refusal Novel',
      chapterCount: 1,
    });
    const manual = await request<{
      revision: { id: string; chapters: Array<{ id: string }> };
    }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        {
          id: manual.revision.chapters[0].id,
          title: 'The Key',
          brief: 'Mara finds a key.',
        },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);
    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    const chapterId = chapters.chapters[0].id;
    await request('PUT', `/chapters/${chapterId}/content`, {
      content: 'Mara turned the brass key over in her hand and listened to the house.',
    });
    const { character } = await request<{ character: { id: string } }>(
      'POST',
      `/projects/${project.id}/characters`,
      { name: 'Mara' },
    );
    const { connections } = await request<{ connections: Array<{ id: string }> }>(
      'GET',
      '/image-connections',
    );
    const { template } = await request<{ template: { id: string } }>(
      'POST',
      '/image-prompt-templates',
      {
        projectId: project.id,
        name: 'Refuses',
        content: 'REFUSE_PROMPT',
        isDefault: true,
      },
    );

    await request('POST', `/chapters/${chapterId}/portraits`, {
      characterId: character.id,
      connectionId: connections[0].id,
      templateId: template.id,
    });

    let latest: { status: string; error: string | null } | null = null;
    for (let attempt = 0; attempt < 300; attempt++) {
      const data = await request<{
        named: Array<{
          character: { id: string };
          latestRequest: { status: string; error: string | null } | null;
        }>;
        assets: Array<{ id: string }>;
      }>('GET', `/chapters/${chapterId}/portraits`);
      const state = data.named.find((entry) => entry.character.id === character.id)?.latestRequest;
      if (state && state.status !== 'prompting' && state.status !== 'imaging') {
        latest = state;
        expect(data.assets).toHaveLength(0);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(latest?.status).toBe('failed');
    expect(latest?.error).toContain('asked for more details');
  }, 30000);

  it('regenerates every chapter and keeps the replaced drafts in history', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Regeneration Novel',
      chapterCount: 2,
      targetChapterWords: 400,
    });
    const manual = await request<{
      revision: { id: string; chapters: Array<{ id: string }> };
    }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        { id: manual.revision.chapters[0].id, title: 'First Light', brief: 'Mara climbs the hill.' },
        { id: 'regeneration-second', title: 'The Door', brief: 'The key turns.' },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);

    const first = await request<{ batch: { mode: string; status: string } }>(
      'POST',
      `/projects/${project.id}/chapter-batch`,
      {},
    );
    expect(first.batch.mode).toBe('draft');
    expect((await waitForChapterBatch(project.id)).status).toBe('completed');

    const before = await request<{
      chapters: Array<{ id: string; currentRevisionId: string | null }>;
    }>('GET', `/projects/${project.id}/chapters`);
    expect(before.chapters.every((chapter) => Boolean(chapter.currentRevisionId))).toBe(true);

    const regenerated = await request<{
      batch: { mode: string; status: string; items: Array<{ status: string }> };
    }>('POST', `/projects/${project.id}/chapter-batch`, { mode: 'regenerate' });
    expect(regenerated.batch.mode).toBe('regenerate');
    expect(regenerated.batch.items.map((item) => item.status)).toEqual(['pending', 'pending']);

    const finished = await waitForChapterBatch(project.id);
    expect(finished.status).toBe('completed');
    expect(finished.items.map((item) => item.status)).toEqual(['completed', 'completed']);

    const after = await request<{
      chapters: Array<{ id: string; currentRevisionId: string | null; wordCount: number }>;
    }>('GET', `/projects/${project.id}/chapters`);
    expect(after.chapters.every((chapter) => chapter.wordCount > 0)).toBe(true);
    for (const [index, chapter] of after.chapters.entries()) {
      expect(chapter.currentRevisionId).not.toBe(before.chapters[index].currentRevisionId);
      const detail = await request<{ chapter: { revisions: Array<{ source: string }> } }>(
        'GET',
        `/chapters/${chapter.id}`,
      );
      expect(detail.chapter.revisions.length).toBeGreaterThanOrEqual(2);
    }
  }, 60000);

  it('queues one portrait per chapter for a single character', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', {
      title: 'Timeline Novel',
      chapterCount: 2,
    });
    const manual = await request<{
      revision: { id: string; chapters: Array<{ id: string }> };
    }>('POST', `/projects/${project.id}/outline/manual`, {});
    await request('PUT', `/projects/${project.id}/outline`, {
      revisionId: manual.revision.id,
      chapters: [
        { id: manual.revision.chapters[0].id, title: 'Arrival', brief: 'Mara reaches the coast.' },
        { id: 'timeline-second', title: 'The Storm', brief: 'The storm breaks over the bay.' },
      ],
    });
    await request('POST', `/projects/${project.id}/outline/${manual.revision.id}/approve`);
    const chapters = await request<{ chapters: Array<{ id: string }> }>(
      'GET',
      `/projects/${project.id}/chapters`,
    );
    for (const chapter of chapters.chapters) {
      await request('PUT', `/chapters/${chapter.id}/content`, {
        content: 'Mara pulled her canvas coat tight and watched the grey sea.',
      });
    }
    const { character } = await request<{ character: { id: string; name: string } }>(
      'POST',
      `/projects/${project.id}/characters`,
      { name: 'Mara', appearance: 'Cropped hair and a heavy canvas coat.' },
    );
    const mockPort = (globalThis as { __mockPort?: number }).__mockPort;
    const { connection } = await request<{ connection: { id: string } }>(
      'POST',
      '/image-connections',
      {
        name: 'Timeline portrait service',
        kind: 'openai-images',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'image-service-key',
        settings: { model: 'mock-image', size: '1024x1024' },
      },
    );
    const { template } = await request<{ template: { id: string } }>(
      'POST',
      '/image-prompt-templates',
      {
        projectId: project.id,
        name: 'Timeline prompt',
        content: 'JSON_PROMPT: Create a painterly character portrait prompt.',
        isDefault: true,
      },
    );

    const started = await request<{ batch: { status: string; items: Array<{ status: string }> } }>(
      'POST',
      `/characters/${character.id}/portrait-batch`,
      { connectionId: connection.id, templateId: template.id, skipExisting: false },
    );
    expect(started.batch.status).toBe('running');
    expect(started.batch.items.map((item) => item.status)).toEqual(['pending', 'pending']);
    const queue = await request<{ portraitBatches: Array<{ characterId: string; items: Array<{ status: string }> }>; characters: Array<{ id: string; name: string }> }>('GET', `/projects/${project.id}/queue`);
    expect(queue.portraitBatches.some(batch => batch.characterId === character.id && batch.items.some(item => item.status === 'pending'))).toBe(true);
    expect(queue.characters.some(item => item.id === character.id && item.name === 'Mara')).toBe(true);

    const finished = await waitForPortraitBatch(character.id);
    expect(finished.status).toBe('completed');
    expect(finished.items.map((item) => item.status)).toEqual(['completed', 'completed']);
    expect(finished.items.every((item) => Boolean(item.assetId))).toBe(true);

    const gallery = await request<{
      assets: Array<{ characterId: string; chapterId: string | null; selectedForChapter: boolean }>;
    }>('GET', `/projects/${project.id}/images`);
    const timeline = gallery.assets.filter((asset) => asset.characterId === character.id);
    expect(timeline).toHaveLength(2);
    expect(timeline.every((asset) => asset.selectedForChapter && asset.chapterId)).toBe(true);
    expect(new Set(timeline.map((asset) => asset.chapterId)).size).toBe(2);
  }, 60000);
});

function cryptoId(): string {
  return `test-${Math.random().toString(36).slice(2)}`;
}

describe('review regressions', () => {
  it('keeps chapter selections separate, detects edited sources, and preserves them in portable backups', async () => {
    const {project} = await request<{project: {id:string}}>('POST','/projects',{title:'Visual <novel>'});
    const {revision} = await request<{revision:{id:string;chapters:Array<{id:string}>}}>('POST',`/projects/${project.id}/outline/manual`,{});
    const chapterId=revision.chapters[0].id;
    await request('PUT',`/projects/${project.id}/outline`,{revisionId:revision.id,chapters:[{id:chapterId,title:'Storm <one>',brief:'Mara reaches the coast.'},{id:'visual-next',title:'Tomorrow',brief:'A new day.'}]});
    await request('POST',`/projects/${project.id}/outline/${revision.id}/approve`);
    await request('POST',`/chapters/${chapterId}/append`,{text:'Mara arrives in a navy coat.'});
    const {character}=await request<{character:{id:string}}>('POST',`/projects/${project.id}/characters`,{name:'Mara <Voss>'});
    const {connections}=await request<{connections:Array<{id:string;kind:string}>}>('GET','/image-connections');
    const connection=connections.find(c=>c.kind==='openai-images')!;
    const makeImage=async()=>{
      const {job}=await request<{job:{id:string}}>('POST',`/characters/${character.id}/images`,{connectionId:connection.id,chapterId,prompt:'Mara in a navy coat.'});
      expect((await waitForImageJob(job.id)).status).toBe('completed');
      const gallery=await request<{assets:import('../shared/types.js').ImageAsset[]}>('GET',`/projects/${project.id}/images`);
      return gallery.assets.find(a=>a.jobId===job.id)!;
    };
    const first=await makeImage(); const second=await makeImage();
    expect(first.sourceOutdated).toBe(false);
    await request('POST',`/chapters/${chapterId}/selected-image`,{assetId:first.id});
    await request('POST',`/chapters/${chapterId}/selected-image`,{assetId:second.id});
    const selected=await request<{assets:import('../shared/types.js').ImageAsset[]}>('GET',`/projects/${project.id}/images`);
    expect(selected.assets.filter(a=>a.selectedForChapter).map(a=>a.id)).toEqual([second.id]);
    const cast=await request<{characters:Array<{portraitAssetId:string|null}>}>('GET',`/projects/${project.id}/characters`);
    expect(cast.characters[0].portraitAssetId).toBeNull();
    const invalid=await fetch(`${baseUrl}/api/chapters/visual-next/selected-image`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetId:second.id})});
    expect(invalid.status).toBe(400);
    const exported=await fetch(`${baseUrl}/api/projects/${project.id}/export.html`).then(r=>r.text());
    expect(exported).toContain('data:image/png;base64,');expect(exported).toContain('Visual &lt;novel&gt;');expect(exported).toContain('Mara &lt;Voss&gt;');
    const download=await fetch(`${baseUrl}${second.url}?download=1`);expect(download.headers.get('content-disposition')).toContain('mara-voss-storm-one');
    const backup=await fetch(`${baseUrl}/api/projects/${project.id}/backup`).then(r=>r.arrayBuffer());
    const restored=await fetch(`${baseUrl}/api/projects/restore`,{method:'POST',headers:{'Content-Type':'application/gzip'},body:backup}).then(r=>r.json()) as {project:{id:string}};
    const restoredImages=await request<{assets:import('../shared/types.js').ImageAsset[]}>('GET',`/projects/${restored.project.id}/images`);
    expect(restoredImages.assets.filter(a=>a.selectedForChapter)).toHaveLength(1);
    expect(restoredImages.assets.every(a=>!a.sourceOutdated)).toBe(true);
    await request('POST',`/chapters/${chapterId}/append`,{text:'Mara changes into a red coat.'});
    const stale=await request<{assets:import('../shared/types.js').ImageAsset[]}>('GET',`/projects/${project.id}/images`);expect(stale.assets.every(a=>a.sourceOutdated)).toBe(true);
    await request('DELETE',`/image-assets/${second.id}`);
    const remaining=await request<{assets:import('../shared/types.js').ImageAsset[]}>('GET',`/projects/${project.id}/images`);expect(remaining.assets.filter(a=>a.selectedForChapter)).toHaveLength(0);
  });

  it('resolves project generation overrides and restores inheritance', async () => {
    const {project}=await request<{project:{id:string}}>('POST','/projects',{title:'Settings sources'});
    await request('PATCH',`/projects/${project.id}/visual-style`,{visualStyle:'Watercolour on parchment'});
    await request('PATCH',`/projects/${project.id}/settings`,{generation:{temperature:0.23}});
    const settings=await request<{generation:{temperature:number};generationSources:Record<string,string>}>('GET',`/projects/${project.id}/settings`);
    expect(settings.generation.temperature).toBe(0.23);expect(settings.generationSources.temperature).toBe('Project override');
    await request('DELETE',`/projects/${project.id}/generation-settings`);
    const inherited=await request<{generationSources:Record<string,string>}>('GET',`/projects/${project.id}/settings`);expect(inherited.generationSources.temperature).toBe('Global default');
    const {getProjectVisualStyle}=await import('./store/settings.js');expect(getProjectVisualStyle(project.id)).toBe('Watercolour on parchment');
  });
  it('refuses an incomplete backup when an image file is unreadable', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', { title: 'Missing image backup' });
    const { character } = await request<{ character: { id: string } }>('POST', `/projects/${project.id}/characters`, { name: 'Mara' });
    const { connections } = await request<{ connections: Array<{ id: string; kind: string }> }>('GET', '/image-connections');
    const connection = connections.find((entry) => entry.kind === 'openai-images')!;
    const { job } = await request<{ job: { id: string } }>('POST', `/characters/${character.id}/images`, { connectionId: connection.id, prompt: 'Portrait' });
    expect((await waitForImageJob(job.id)).status).toBe('completed');
    const { dbGet } = await import('./db.js');
    const { imageFilePath } = await import('./store/images.js');
    const asset = dbGet<{ file_name: string }>('SELECT file_name FROM image_assets WHERE job_id = ?', job.id)!;
    const file = imageFilePath(asset.file_name);
    const bytes = fs.readFileSync(file);
    fs.unlinkSync(file);
    try {
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/backup`);
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect((await response.json() as { error: string }).error).toContain('No incomplete backup was created');
    } finally {
      fs.writeFileSync(file, bytes);
    }
    expect((await fetch(`${baseUrl}/api/projects/${project.id}/backup`)).status).toBe(200);
  });

  it('recovers pending ComfyUI requests on startup and retry without resubmission', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', { title: 'Recovery' });
    const { connections } = await request<{ connections: Array<{ id: string; kind: string; settings: import('../shared/types.js').ImageProviderSettings }> }>('GET', '/image-connections');
    const connection = connections.find((entry) => entry.kind === 'comfyui')!;
    const { createImageJob, updateImageJob, getImageJob } = await import('./store/images.js');
    const { reconcileInterruptedImageJobs } = await import('./image-generation.js');
    for (const mode of ['startup', 'retry']) {
      const { character } = await request<{ character: { id: string } }>('POST', `/projects/${project.id}/characters`, { name: mode });
      const job = createImageJob({ projectId: project.id, characterId: character.id, chapterId: null,
        connectionId: connection.id, providerKind: 'comfyui', prompt: 'Recovered portrait', negativePrompt: '',
        templateId: null, templateName: null, templateContent: '', settings: connection.settings });
      updateImageJob(job.id, { status: 'interrupted', remote_id: 'recovery-prompt' });
      recoveryHistoryReads = 0;
      const before = comfySubmissions;
      const recovering = mode === 'startup' ? reconcileInterruptedImageJobs() : Promise.resolve();
      if (mode === 'retry') {
        const retried = await request<{ job: { id: string; status: string } }>('POST', `/image-jobs/${job.id}/retry`);
        expect(retried.job.id).toBe(job.id);
        expect(retried.job.status).toBe('running');
      }
      expect(getImageJob(job.id).status).toBe('running');
      const duplicate = await fetch(`${baseUrl}/api/characters/${character.id}/images`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: connection.id, prompt: 'Duplicate' }) });
      expect(duplicate.status).toBe(409);
      expect((await waitForImageJob(job.id)).status).toBe('completed');
      await recovering;
      expect(recoveryHistoryReads).toBeGreaterThanOrEqual(2);
      expect(comfySubmissions).toBe(before);
    }
  }, 15000);
});


describe('library deletion', () => {
  it('permanently removes an archived story and leaves other stories intact', async () => {
    const { project } = await request<{ project: { id: string } }>('POST', '/projects', { title: 'Delete me' });
    const { project: other } = await request<{ project: { id: string } }>('POST', '/projects', { title: 'Keep me' });
    await request('POST', `/projects/${project.id}/archive`);
    const deleted = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${baseUrl}/api/projects/${project.id}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/projects/${other.id}`)).status).toBe(200);
  });
});
