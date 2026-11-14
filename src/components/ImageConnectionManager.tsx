import { useState } from 'react';
import type {
  ImageConnectionInput,
  ImageConnectionKind,
  ImageConnectionPublic,
  ImageProviderSettings,
} from '@shared/types';
import { IMAGE_CONNECTION_LABELS } from '@shared/types';
import { api } from '../api';
import { Banner, Modal, Spinner } from './ui';
import { errorText, formatDate } from '../utils';

interface Editor {
  id?: string;
  name: string;
  kind: ImageConnectionKind;
  baseUrl: string;
  apiKey: string;
  removeKey: boolean;
  settings: ImageProviderSettings;
}

const DEFAULT_BASE: Record<ImageConnectionKind, string> = {
  'openai-images': 'https://api.openai.com/v1',
  comfyui: 'http://localhost:8188',
};

const DEFAULT_SETTINGS: Record<ImageConnectionKind, ImageProviderSettings> = {
  'openai-images': { model: 'gpt-image-1', size: '1024x1024' },
  comfyui: {
    promptInput: 'text',
    negativeInput: 'text',
    seedInput: 'seed',
    timeoutSeconds: 300,
  },
};

export function ImageConnectionManager({
  connections,
  onChanged,
}: {
  connections: ImageConnectionPublic[];
  onChanged: () => Promise<void>;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const openNew = () => {
    setEditor({
      name: '',
      kind: 'openai-images',
      baseUrl: DEFAULT_BASE['openai-images'],
      apiKey: '',
      removeKey: false,
      settings: { ...DEFAULT_SETTINGS['openai-images'] },
    });
    setError(null);
    setNotice(null);
  };

  const openEdit = (connection: ImageConnectionPublic) => {
    setEditor({
      id: connection.id,
      name: connection.name,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      apiKey: '',
      removeKey: false,
      settings: { ...connection.settings },
    });
    setError(null);
    setNotice(null);
  };

  const setSetting = (key: keyof ImageProviderSettings, value: string) => {
    setEditor((current) =>
      current
        ? {
            ...current,
            settings: {
              ...current.settings,
              [key]: key === 'timeoutSeconds' ? Number(value) : value,
            },
          }
        : current,
    );
  };

  const changeKind = (kind: ImageConnectionKind) => {
    setEditor((current) => {
      if (!current) return current;
      const isDefaultUrl =
        !current.baseUrl ||
        current.baseUrl === DEFAULT_BASE[current.kind] ||
        current.baseUrl.startsWith('http://localhost');
      return {
        ...current,
        kind,
        baseUrl: isDefaultUrl ? DEFAULT_BASE[kind] : current.baseUrl,
        settings: { ...DEFAULT_SETTINGS[kind] },
      };
    });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const input: ImageConnectionInput = {
        name: editor.name,
        kind: editor.kind,
        baseUrl: editor.baseUrl,
        settings: editor.settings,
        ...(editor.apiKey ? { apiKey: editor.apiKey } : editor.removeKey ? { apiKey: null } : {}),
      };
      if (editor.id) {
        await api.updateImageConnection(editor.id, input);
        setNotice('Image connection updated. Test it to verify the endpoint.');
      } else {
        const created = await api.createImageConnection(input);
        setNotice(`Image connection "${created.name}" added.`);
      }
      setEditor(null);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async (connection: ImageConnectionPublic) => {
    setTesting(connection.id);
    setError(null);
    try {
      const result = await api.testImageConnection(connection.id);
      setResults((current) => ({ ...current, [connection.id]: result }));
    } catch (err) {
      setResults((current) => ({
        ...current,
        [connection.id]: { ok: false, message: errorText(err) },
      }));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (connection: ImageConnectionPublic) => {
    if (!window.confirm(`Delete the image connection "${connection.name}"?`)) return;
    setError(null);
    try {
      await api.deleteImageConnection(connection.id);
      setNotice('Image connection deleted.');
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="settings-panel">
      <header className="panel-header">
        <div>
          <h1>Image service</h1>
          <p className="muted">
            Separate connections for character images. Text-model connections and roles are not
            changed by anything on this page.
          </p>
        </div>
        <button className="button button-primary" onClick={openNew}>
          Add image connection
        </button>
      </header>

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}

      {connections.length === 0 ? (
        <div className="empty-state">
          <h3>No image connections yet</h3>
          <p className="muted">
            Add an OpenAI Images-compatible endpoint or a ComfyUI server to generate character
            portraits.
          </p>
          <button className="button button-primary" onClick={openNew}>
            Add your first image connection
          </button>
        </div>
      ) : (
        <div className="connection-list">
          {connections.map((connection) => {
            const result = results[connection.id];
            return (
              <article className="connection-card" key={connection.id}>
                <div className="connection-head">
                  <div>
                    <h3>{connection.name}</h3>
                    <p className="muted small">
                      {IMAGE_CONNECTION_LABELS[connection.kind]} · {connection.baseUrl}
                    </p>
                  </div>
                  <span
                    className={`badge ${connection.hasApiKey ? 'badge-success' : 'badge-warning'}`}
                  >
                    {connection.hasApiKey ? 'API key stored' : 'No API key'}
                  </span>
                </div>
                <div className="connection-meta">
                  {connection.kind === 'openai-images' ? (
                    <>
                      <span>Model: {connection.settings.model || 'not set'}</span>
                      <span>Size: {connection.settings.size || 'provider default'}</span>
                    </>
                  ) : (
                    <>
                      <span>
                        Prompt node: {connection.settings.promptNode || 'not set'} /{' '}
                        {connection.settings.promptInput || 'text'}
                      </span>
                      <span>
                        {connection.settings.workflow
                          ? 'Workflow saved'
                          : 'No workflow saved yet'}
                      </span>
                    </>
                  )}
                  <span>Updated {formatDate(connection.updatedAt)}</span>
                </div>
                {result ? (
                  <Banner tone={result.ok ? 'success' : 'danger'}>{result.message}</Banner>
                ) : null}
                <div className="row-actions">
                  <button
                    className="button button-small"
                    onClick={() => void test(connection)}
                    disabled={testing === connection.id}
                  >
                    {testing === connection.id ? <Spinner /> : null}
                    Test
                  </button>
                  <button className="button button-ghost button-small" onClick={() => openEdit(connection)}>
                    Edit
                  </button>
                  <button
                    className="button button-danger-ghost button-small"
                    onClick={() => void remove(connection)}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Modal
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.id ? 'Edit image connection' : 'Add image connection'}
        subtitle="Credentials are stored encrypted on this server and masked in every response."
        width="wide"
        footer={
          <div className="modal-actions">
            <button className="button button-ghost" type="button" onClick={() => setEditor(null)}>
              Cancel
            </button>
            <button className="button button-primary" type="submit" form="image-connection-form" disabled={saving}>
              {saving ? <Spinner /> : null}
              {saving ? 'Saving…' : 'Save connection'}
            </button>
          </div>
        }
      >
        {editor ? (
          <form id="image-connection-form" className="image-connection-form" onSubmit={save}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="image-connection-name">Name</label>
                <input
                  id="image-connection-name"
                  value={editor.name}
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  placeholder="e.g. Local ComfyUI"
                  autoFocus
                />
              </div>
              <div className="field">
                <label htmlFor="image-connection-kind">Type</label>
                <select
                  id="image-connection-kind"
                  value={editor.kind}
                  onChange={(event) => changeKind(event.target.value as ImageConnectionKind)}
                >
                  <option value="openai-images">OpenAI Images API</option>
                  <option value="comfyui">ComfyUI</option>
                </select>
              </div>
            </div>

            <div className="field">
              <label htmlFor="image-connection-url">Base URL</label>
              <input
                id="image-connection-url"
                value={editor.baseUrl}
                onChange={(event) => setEditor({ ...editor, baseUrl: event.target.value })}
                spellCheck={false}
              />
              <p className="field-hint">
                {editor.kind === 'comfyui'
                  ? 'The ComfyUI server root, for example http://192.168.1.20:8188.'
                  : 'Include the API prefix (usually /v1). Story Architect appends /images/generations.'}
              </p>
            </div>

            <div className="field">
              <label htmlFor="image-connection-key">API key</label>
              <input
                id="image-connection-key"
                type="password"
                value={editor.apiKey}
                onChange={(event) => setEditor({ ...editor, apiKey: event.target.value })}
                placeholder={editor.id ? 'Leave blank to keep the current key' : 'sk-… (optional for local services)'}
                autoComplete="off"
              />
              {editor.id ? (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={editor.removeKey}
                    onChange={(event) => setEditor({ ...editor, removeKey: event.target.checked })}
                  />
                  Remove the stored API key
                </label>
              ) : null}
            </div>

            {editor.kind === 'openai-images' ? (
              <>
                <h3 className="form-section-title">Images API</h3>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="image-model">Model</label>
                    <input
                      id="image-model"
                      value={editor.settings.model ?? ''}
                      onChange={(event) => setSetting('model', event.target.value)}
                      placeholder="gpt-image-1"
                      spellCheck={false}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="image-size">Size</label>
                    <input
                      id="image-size"
                      value={editor.settings.size ?? ''}
                      onChange={(event) => setSetting('size', event.target.value)}
                      placeholder="1024x1024"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="image-quality">Quality (optional)</label>
                  <input
                    id="image-quality"
                    value={editor.settings.quality ?? ''}
                    onChange={(event) => setSetting('quality', event.target.value)}
                    placeholder="high"
                    spellCheck={false}
                  />
                  <p className="field-hint">
                    OpenAI, and compatible servers, receive one prompt and return one image. The
                    negative prompt is appended as an “Avoid” note for this adapter.
                  </p>
                </div>
              </>
            ) : (
              <>
                <h3 className="form-section-title">ComfyUI workflow</h3>
                <div className="field">
                  <label htmlFor="image-workflow">Workflow JSON (API format)</label>
                  <textarea
                    id="image-workflow"
                    rows={10}
                    value={editor.settings.workflow ?? ''}
                    onChange={(event) => setSetting('workflow', event.target.value)}
                    placeholder='{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"..."}}}'
                    spellCheck={false}
                    className="code-textarea"
                  />
                  <p className="field-hint">
                    Paste the workflow exported with “Save (API format)”. The node IDs below map the
                    prompt, optional negative prompt, seed, and output image.
                  </p>
                </div>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="image-prompt-node">Prompt node ID</label>
                    <input
                      id="image-prompt-node"
                      value={editor.settings.promptNode ?? ''}
                      onChange={(event) => setSetting('promptNode', event.target.value)}
                      placeholder="6"
                      spellCheck={false}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="image-prompt-input">Prompt field</label>
                    <input
                      id="image-prompt-input"
                      value={editor.settings.promptInput ?? ''}
                      onChange={(event) => setSetting('promptInput', event.target.value)}
                      placeholder="text"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="image-negative-node">Negative node ID (optional)</label>
                    <input
                      id="image-negative-node"
                      value={editor.settings.negativeNode ?? ''}
                      onChange={(event) => setSetting('negativeNode', event.target.value)}
                      placeholder="7"
                      spellCheck={false}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="image-negative-input">Negative field</label>
                    <input
                      id="image-negative-input"
                      value={editor.settings.negativeInput ?? ''}
                      onChange={(event) => setSetting('negativeInput', event.target.value)}
                      placeholder="text"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="image-seed-node">Seed node ID (optional)</label>
                    <input
                      id="image-seed-node"
                      value={editor.settings.seedNode ?? ''}
                      onChange={(event) => setSetting('seedNode', event.target.value)}
                      placeholder="3"
                      spellCheck={false}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="image-seed-input">Seed field</label>
                    <input
                      id="image-seed-input"
                      value={editor.settings.seedInput ?? ''}
                      onChange={(event) => setSetting('seedInput', event.target.value)}
                      placeholder="seed"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="image-output-node">Output node ID (optional)</label>
                    <input
                      id="image-output-node"
                      value={editor.settings.outputNode ?? ''}
                      onChange={(event) => setSetting('outputNode', event.target.value)}
                      placeholder="9"
                      spellCheck={false}
                    />
                    <p className="field-hint">
                      Leave blank to use the first image found in the run history.
                    </p>
                  </div>
                  <div className="field">
                    <label htmlFor="image-timeout">Timeout (seconds)</label>
                    <input
                      id="image-timeout"
                      type="number"
                      min={10}
                      max={1800}
                      value={editor.settings.timeoutSeconds ?? 300}
                      onChange={(event) => setSetting('timeoutSeconds', event.target.value)}
                    />
                  </div>
                </div>
              </>
            )}
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
