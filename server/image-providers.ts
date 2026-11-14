import crypto from 'node:crypto';
import fs from 'node:fs';
import { getImageAssetRow, imageFilePath } from './store/images.js';
import type { ImageConnectionKind, ImageProviderSettings } from '../shared/types.js';
import { normaliseBaseUrl, ProviderError } from './providers.js';

export interface ProviderImageConnection {
  id: string;
  name: string;
  kind: ImageConnectionKind;
  baseUrl: string;
  apiKey: string | null;
  settings: ImageProviderSettings;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  remoteId: string | null;
  revisedPrompt: string | null;
}

export interface GenerateImageParams {
  prompt: string;
  negativePrompt: string;
  signal: AbortSignal;
  onRemoteId?: (id: string) => void;
}

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function sniffImageMime(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return 'image/gif';
  }
  return null;
}

function acceptedMime(value: string | null | undefined): string | null {
  const mime = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return IMAGE_MIME_TYPES.has(mime) ? mime : null;
}

function connectionHeaders(connection: ProviderImageConnection, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: accept,
  };
  if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
  return headers;
}

async function ensureOk(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  let body = '';
  try {
    body = await response.text();
  } catch {
    // Ignore body read errors.
  }
  const detail = body
    .trim()
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
  throw new ProviderError(
    `${provider} returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${
      detail ? `: ${detail}` : ''
    }`,
    response.status,
  );
}

export async function readImageBytes(
  response: Response,
  provider: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  await ensureOk(response, provider);
  const declared = acceptedMime(response.headers.get('content-type'));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new ProviderError(`${provider} returned an empty image.`);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ProviderError(`${provider} returned an image larger than 25 MB.`);
  }
  const mimeType = sniffImageMime(bytes) ?? declared;
  if (!mimeType) {
    throw new ProviderError(`${provider} did not return a recognised image file.`);
  }
  return { bytes, mimeType };
}

async function downloadImage(
  url: string,
  signal: AbortSignal,
  provider: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) throw new ProviderError(`${provider} returned an unreadable inline image.`);
    const bytes = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'binary');
    if (bytes.length === 0) throw new ProviderError(`${provider} returned an empty image.`);
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ProviderError(`${provider} returned an image larger than 25 MB.`);
    }
    const mimeType = sniffImageMime(bytes) ?? acceptedMime(match[1]);
    if (!mimeType) throw new ProviderError(`${provider} returned an unreadable image.`);
    return { bytes, mimeType };
  }
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
  });
  return readImageBytes(response, provider);
}

function imagesEndpoint(baseUrl: string): string {
  const base = normaliseBaseUrl(baseUrl);
  if (/\/images\/generations$/i.test(base)) return base;
  return `${base}/images/generations`;
}

function comfyEndpoint(baseUrl: string, path: string): string {
  return `${normaliseBaseUrl(baseUrl)}${path}`;
}

function imageModelsEndpoint(baseUrl: string): string {
  const base = normaliseBaseUrl(baseUrl).replace(/\/images\/generations$/i, '');
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

/** The OpenAI Images adapter. It covers OpenAI and compatible `/images/generations` servers. */
export async function generateOpenAIImage(
  connection: ProviderImageConnection,
  params: GenerateImageParams,
): Promise<GeneratedImage> {
  const model = connection.settings.model?.trim();
  if (!model) {
    throw new ProviderError(
      'The image connection has no model set. Edit the connection and choose an image model.',
    );
  }
  const prompt = params.negativePrompt.trim()
    ? `${params.prompt}\n\nAvoid: ${params.negativePrompt.trim()}`
    : params.prompt;
  const body: Record<string, unknown> = { model, prompt, n: 1 };
  if (connection.settings.size?.trim()) body.size = connection.settings.size.trim();
  if (connection.settings.quality?.trim()) body.quality = connection.settings.quality.trim();

  const response = await fetch(imagesEndpoint(connection.baseUrl), {
    method: 'POST',
    headers: connectionHeaders(connection, 'application/json'),
    body: JSON.stringify(body),
    signal: AbortSignal.any([params.signal, AbortSignal.timeout(240000)]),
  });
  await ensureOk(response, 'The image service');
  const data = (await response.json()) as unknown;
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.images)
      ? record.images
      : [];
  const first = list[0];
  if (!first || typeof first !== 'object') {
    throw new ProviderError('The image service returned no image.');
  }
  const entry = first as Record<string, unknown>;
  const revisedPrompt = typeof entry.revised_prompt === 'string' ? entry.revised_prompt : null;

  if (typeof entry.b64_json === 'string' && entry.b64_json.trim()) {
    const bytes = Buffer.from(entry.b64_json, 'base64');
    if (bytes.length === 0) throw new ProviderError('The image service returned an empty image.');
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ProviderError('The image service returned an image larger than 25 MB.');
    }
    const mimeType = sniffImageMime(bytes);
    if (!mimeType) {
      throw new ProviderError('The image service returned an unrecognised image file.');
    }
    return { bytes, mimeType, remoteId: null, revisedPrompt };
  }

  const url =
    typeof entry.url === 'string'
      ? entry.url
      : typeof entry.image === 'string'
        ? entry.image
        : typeof entry.image_url === 'string'
          ? entry.image_url
          : '';
  if (!url) throw new ProviderError('The image service returned no image data or URL.');
  const downloaded = await downloadImage(url, params.signal, 'The image service');
  return { ...downloaded, remoteId: null, revisedPrompt };
}

export interface ComfyWorkflowResult {
  workflow: Record<string, unknown>;
  seed: number | null;
}

export function buildComfyWorkflow(
  connection: ProviderImageConnection,
  prompt: string,
  negativePrompt: string,
): ComfyWorkflowResult {
  const raw = connection.settings.workflow?.trim();
  if (!raw) {
    throw new ProviderError(
      'The ComfyUI connection has no workflow saved. Edit the connection and paste an API-format workflow.',
    );
  }
  let workflow: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    workflow = parsed as Record<string, unknown>;
  } catch {
    throw new ProviderError('The saved ComfyUI workflow is not a JSON object.');
  }

  const promptNode = connection.settings.promptNode?.trim();
  if (!promptNode) {
    throw new ProviderError('The ComfyUI connection has no prompt node configured.');
  }
  setNodeInput(
    workflow,
    promptNode,
    connection.settings.promptInput?.trim() || 'text',
    prompt,
    'prompt',
  );

  if (negativePrompt.trim() && connection.settings.negativeNode?.trim()) {
    setNodeInput(
      workflow,
      connection.settings.negativeNode.trim(),
      connection.settings.negativeInput?.trim() || 'text',
      negativePrompt,
      'negative prompt',
    );
  }

  let seed: number | null = null;
  if (connection.settings.seedNode?.trim()) {
    seed = crypto.randomInt(0, 2 ** 31 - 1);
    setNodeInput(
      workflow,
      connection.settings.seedNode.trim(),
      connection.settings.seedInput?.trim() || 'seed',
      seed,
      'seed',
    );
  }

  return { workflow, seed };
}

function setNodeInput(
  workflow: Record<string, unknown>,
  nodeId: string,
  inputName: string,
  value: string | number,
  label: string,
): void {
  const node = workflow[nodeId];
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new ProviderError(
      `The saved ComfyUI workflow has no node "${nodeId}" for the ${label}. Check the connection settings.`,
    );
  }
  const record = node as Record<string, unknown>;
  const inputs =
    record.inputs && typeof record.inputs === 'object' && !Array.isArray(record.inputs)
      ? (record.inputs as Record<string, unknown>)
      : {};
  inputs[inputName] = value;
  record.inputs = inputs;
  workflow[nodeId] = record;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

function findComfyImage(outputs: unknown, outputNode?: string): ComfyImageRef | null {
  if (!outputs || typeof outputs !== 'object') return null;
  const record = outputs as Record<string, unknown>;
  const candidates = outputNode ? [outputNode] : Object.keys(record);
  for (const nodeId of candidates) {
    const node = record[nodeId];
    if (!node || typeof node !== 'object') continue;
    const images = (node as Record<string, unknown>).images;
    if (!Array.isArray(images)) continue;
    for (const image of images) {
      if (!image || typeof image !== 'object') continue;
      const entry = image as Record<string, unknown>;
      if (typeof entry.filename !== 'string' || !entry.filename) continue;
      return {
        filename: entry.filename,
        subfolder: typeof entry.subfolder === 'string' ? entry.subfolder : '',
        type: typeof entry.type === 'string' ? entry.type : 'output',
      };
    }
  }
  return null;
}

function comfyErrorText(entry: Record<string, unknown>): string {
  const status = entry.status as Record<string, unknown> | undefined;
  const messages = status?.messages;
  if (Array.isArray(messages)) {
    const text = messages
      .flatMap((message) =>
        Array.isArray(message)
          ? message
              .filter((part): part is string => typeof part === 'string')
              .join(' ')
          : [],
      )
      .join(' ')
      .trim();
    if (text) return text.slice(0, 400);
  }
  return 'ComfyUI reported a failed generation.';
}

async function fetchComfyHistory(
  connection: ProviderImageConnection,
  promptId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(
    comfyEndpoint(connection.baseUrl, `/history/${encodeURIComponent(promptId)}`),
    {
      method: 'GET',
      headers: connectionHeaders(connection, 'application/json'),
      signal,
    },
  );
  await ensureOk(response, 'ComfyUI');
  const data = (await response.json()) as unknown;
  if (!data || typeof data !== 'object') return null;
  const entry = (data as Record<string, unknown>)[promptId];
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
}

async function downloadComfyImage(
  connection: ProviderImageConnection,
  image: ComfyImageRef,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  const response = await fetch(
    comfyEndpoint(connection.baseUrl, `/view?${query.toString()}`),
    {
      method: 'GET',
      headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : undefined,
      signal,
    },
  );
  return readImageBytes(response, 'ComfyUI');
}

/** ComfyUI adapter: submit an API-format workflow, poll history, then download the output image. */
export async function generateComfyImage(
  connection: ProviderImageConnection,
  params: GenerateImageParams,
): Promise<GeneratedImage> {
  const { workflow } = buildComfyWorkflow(connection, params.prompt, params.negativePrompt);
  if (connection.settings.referenceAssetId && connection.settings.referenceNode) {
    const asset = getImageAssetRow(connection.settings.referenceAssetId);
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(fs.readFileSync(imageFilePath(asset.file_name)))], {type: asset.mime_type}), `reference-${asset.id}.${asset.mime_type.split('/')[1]}`);
    const upload = await fetch(comfyEndpoint(connection.baseUrl, '/upload/image'), {
      method: 'POST', body: form, signal: params.signal,
      headers: connection.apiKey ? {Authorization: `Bearer ${connection.apiKey}`} : undefined,
    });
    await ensureOk(upload, 'ComfyUI reference upload');
    const uploaded = await upload.json() as {name?: string; subfolder?: string};
    if (!uploaded.name) throw new ProviderError('ComfyUI did not return a reference filename.');
    setNodeInput(workflow, connection.settings.referenceNode, connection.settings.referenceInput || 'image', [uploaded.subfolder, uploaded.name].filter(Boolean).join('/'), 'reference image');
  }
  const timeoutMs = Math.max(10, Math.min(1800, connection.settings.timeoutSeconds ?? 300)) * 1000;
  const signal = AbortSignal.any([params.signal, AbortSignal.timeout(timeoutMs + 180000)]);

  const submit = await fetch(comfyEndpoint(connection.baseUrl, '/prompt'), {
    method: 'POST',
    headers: connectionHeaders(connection, 'application/json'),
    body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
    signal,
  });
  await ensureOk(submit, 'ComfyUI');
  const submitted = (await submit.json()) as unknown;
  const record =
    submitted && typeof submitted === 'object' ? (submitted as Record<string, unknown>) : {};
  if (record.node_errors && Object.keys(record.node_errors as object).length > 0) {
    throw new ProviderError(
      `ComfyUI rejected the workflow: ${JSON.stringify(record.node_errors).slice(0, 400)}`,
    );
  }
  if (record.error) {
    const message =
      typeof record.error === 'string'
        ? record.error
        : String((record.error as Record<string, unknown>)?.message ?? 'Unknown error');
    throw new ProviderError(`ComfyUI rejected the prompt: ${message}`);
  }
  const promptId = String(record.prompt_id ?? record.promptId ?? '');
  if (!promptId) throw new ProviderError('ComfyUI did not return a prompt ID.');
  params.onRemoteId?.(promptId);

  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (params.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const entry = await fetchComfyHistory(connection, promptId, signal);
    if (entry) {
      const status = entry.status as Record<string, unknown> | undefined;
      if (status?.status_str === 'error') {
        throw new ProviderError(comfyErrorText(entry));
      }
      const image = findComfyImage(entry.outputs, connection.settings.outputNode?.trim() || undefined);
      if (image) {
        const downloaded = await downloadComfyImage(connection, image, signal);
        return { ...downloaded, remoteId: promptId, revisedPrompt: null };
      }
      if (status?.completed === true) {
        throw new ProviderError(
          'ComfyUI finished without an output image. Check the saved workflow and output node.',
        );
      }
    }
    if (Date.now() > deadline) {
      throw new ProviderError(
        `ComfyUI did not finish within ${Math.round(timeoutMs / 1000)} seconds. The prompt is kept so you can retry.`,
      );
    }
    await sleep(1000, signal);
  }
}

/** Poll the existing remote request without submitting another workflow. */
export async function recoverComfyImage(
  connection: ProviderImageConnection,
  promptId: string,
  signal: AbortSignal,
): Promise<GeneratedImage | null> {
  while (true) {
    const entry = await fetchComfyHistory(connection, promptId, signal);
    if (entry) {
      const status = entry.status as Record<string, unknown> | undefined;
      if (status?.status_str === 'error') {
        throw new ProviderError(comfyErrorText(entry));
      }
      const image = findComfyImage(entry.outputs, connection.settings.outputNode?.trim() || undefined);
      if (image) {
        const downloaded = await downloadComfyImage(connection, image, signal);
        return { ...downloaded, remoteId: promptId, revisedPrompt: null };
      }
      if (status?.completed === true) {
        throw new ProviderError('ComfyUI completed without an image at the configured output node.');
      }
    }
    await sleep(1000, signal);
  }
}

export async function generateImage(
  connection: ProviderImageConnection,
  params: GenerateImageParams,
): Promise<GeneratedImage> {
  return connection.kind === 'comfyui'
    ? generateComfyImage(connection, params)
    : generateOpenAIImage(connection, params);
}

export async function testImageConnection(
  connection: ProviderImageConnection,
): Promise<{ ok: boolean; message: string }> {
  if (connection.kind === 'comfyui') {
    try {
      buildComfyWorkflow(connection, 'connection test', '');
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The ComfyUI workflow is not usable.',
      };
    }
    try {
      const response = await fetch(comfyEndpoint(connection.baseUrl, '/system_stats'), {
        method: 'GET',
        headers: connection.apiKey
          ? { Accept: 'application/json', Authorization: `Bearer ${connection.apiKey}` }
          : { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      await ensureOk(response, 'ComfyUI');
      const stats = (await response.json()) as Record<string, unknown>;
      const system = stats.system as Record<string, unknown> | undefined;
      const version = typeof system?.comfyui_version === 'string' ? system.comfyui_version : null;
      return {
        ok: true,
        message: `Connected to ComfyUI${version ? ` ${version}` : ''}. The workflow and prompt mapping are valid.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Could not reach ComfyUI: ${message}` };
    }
  }

  if (!connection.settings.model?.trim()) {
    return { ok: false, message: 'Choose an image model for this connection.' };
  }
  try {
    const response = await fetch(imageModelsEndpoint(connection.baseUrl), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    if (response.ok) {
      const data = (await response.json()) as unknown;
      const list =
        data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).data)
          ? ((data as Record<string, unknown>).data as unknown[])
          : [];
      return {
        ok: true,
        message:
          list.length > 0
            ? `Connected. ${list.length} model${list.length === 1 ? '' : 's'} listed by the endpoint.`
            : 'Connected. The endpoint did not list models; image generation will be sent to /images/generations.',
      };
    }
    if (response.status === 401 || response.status === 403) {
      await ensureOk(response, 'The image service');
    }
    return {
      ok: true,
      message: `The endpoint responded with ${response.status}. Image generation will be sent to /images/generations.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach the image service: ${message}` };
  }
}
