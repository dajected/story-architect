import { confirmAction } from '../components/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ConnectionKind,
  ConnectionPublic,
  GenerationSettings,
  ImageConnectionPublic,
  ImagePromptTemplate,
  PromptTemplate,
  ResolvedRole,
  TaskRole,
} from '@shared/types';
import { api } from '../api';
import { PageHeader, type Theme } from '../components/Chrome';
import { GenerationSettingsForm } from '../components/GenerationSettingsForm';
import { ImageConnectionManager } from '../components/ImageConnectionManager';
import { ImageTemplateManager } from '../components/ImageTemplateManager';
import { RoleEditor } from '../components/RoleEditor';
import { TemplateManager } from '../components/TemplateManager';
import { Banner, Modal, Spinner } from '../components/ui';
import { errorText, formatDate } from '../utils';

type Tab =
  | 'connections'
  | 'models'
  | 'generation'
  | 'prompts'
  | 'image-connections'
  | 'image-prompts';

interface ConnectionEditor {
  id?: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  apiKey: string;
  removeKey: boolean;
}

const DEFAULT_BASE: Record<ConnectionKind, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'http://localhost:1234/v1',
};

const SETTINGS_TABS: Tab[] = [
  'connections',
  'models',
  'generation',
  'prompts',
  'image-connections',
  'image-prompts',
];

function initialTab(): Tab {
  const requested = new URLSearchParams(window.location.search).get('tab');
  return requested && SETTINGS_TABS.includes(requested as Tab) ? (requested as Tab) : 'connections';
}

export function SettingsPage({
  theme,
  onThemeChange,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const requestedReturn = new URLSearchParams(location.search).get('returnTo');
  const returnTo = requestedReturn?.startsWith('/projects/') && !requestedReturn.startsWith('//') ? requestedReturn : '/';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [connections, setConnections] = useState<ConnectionPublic[]>([]);
  const [generation, setGeneration] = useState<GenerationSettings | null>(null);
  const [roles, setRoles] = useState<ResolvedRole[]>([]);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [imageConnections, setImageConnections] = useState<ImageConnectionPublic[]>([]);
  const [imageTemplates, setImageTemplates] = useState<ImagePromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<ConnectionEditor | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});

  const load = useCallback(async () => {
    try {
      const [connectionList, settings, templateList, imageConnectionList, imageTemplateList] =
        await Promise.all([
          api.listConnections(),
          api.getSettings(),
          api.listTemplates(),
          api.listImageConnections(),
          api.listImageTemplates(),
        ]);
      setConnections(connectionList);
      setGeneration(settings.generation);
      setRoles(settings.roles);
      setTemplates(templateList);
      setImageConnections(imageConnectionList);
      setImageTemplates(imageTemplateList);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshConnections = async () => {
    const list = await api.listConnections();
    setConnections(list);
  };

  const refreshSettings = async () => {
    const settings = await api.getSettings();
    setGeneration(settings.generation);
    setRoles(settings.roles);
  };

  const refreshTemplates = async () => {
    setTemplates(await api.listTemplates());
  };

  const refreshImageConnections = async () => {
    setImageConnections(await api.listImageConnections());
  };

  const refreshImageTemplates = async () => {
    setImageTemplates(await api.listImageTemplates());
  };

  const openNew = () => {
    setEditor({
      name: '',
      kind: 'openrouter',
      baseUrl: DEFAULT_BASE.openrouter,
      apiKey: '',
      removeKey: false,
    });
    setNotice(null);
  };

  const openEdit = (connection: ConnectionPublic) => {
    setEditor({
      id: connection.id,
      name: connection.name,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      apiKey: '',
      removeKey: false,
    });
    setNotice(null);
  };

  const saveConnection = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      if (editor.id) {
        await api.updateConnection(editor.id, {
          name: editor.name,
          kind: editor.kind,
          baseUrl: editor.baseUrl,
          ...(editor.apiKey ? { apiKey: editor.apiKey } : editor.removeKey ? { apiKey: null } : {}),
        });
        setNotice('Connection updated. Test it to verify the endpoint.');
      } else {
        const created = await api.createConnection({
          name: editor.name,
          kind: editor.kind,
          baseUrl: editor.baseUrl,
          apiKey: editor.apiKey || null,
        });
        setNotice(`Connection "${created.name}" added. Test it to discover models.`);
      }
      setEditor(null);
      await refreshConnections();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async (connection: ConnectionPublic) => {
    setTesting(connection.id);
    setError(null);
    try {
      const result = await api.testConnection(connection.id);
      setTestResults((current) => ({
        ...current,
        [connection.id]: { ok: result.ok, message: result.message },
      }));
      if (result.ok) await refreshConnections();
    } catch (err) {
      setTestResults((current) => ({
        ...current,
        [connection.id]: { ok: false, message: errorText(err) },
      }));
    } finally {
      setTesting(null);
    }
  };

  const refreshModels = async (connection: ConnectionPublic) => {
    setTesting(connection.id);
    setError(null);
    try {
      const result = await api.refreshModels(connection.id);
      setTestResults((current) => ({
        ...current,
        [connection.id]: {
          ok: true,
          message: `Discovered ${result.models.length} model${result.models.length === 1 ? '' : 's'}.`,
        },
      }));
      await refreshConnections();
    } catch (err) {
      setTestResults((current) => ({
        ...current,
        [connection.id]: { ok: false, message: errorText(err) },
      }));
    } finally {
      setTesting(null);
    }
  };

  const removeConnection = async (connection: ConnectionPublic) => {
    if (
      !await confirmAction(
        `Delete the connection "${connection.name}"? Any model roles using it will be cleared.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteConnection(connection.id);
      setNotice('Connection deleted.');
      await Promise.all([refreshConnections(), refreshSettings()]);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const saveRoles = async (
    assignments: Array<{ role: TaskRole; connectionId: string | null; model: string | null }>,
  ) => {
    await api.setModelRoles({ scope: 'global', assignments });
    await refreshSettings();
  };

  if (loading) {
    return (
      <div className="page">
        <PageHeader theme={theme} onThemeChange={onThemeChange} />
        <div className="centered-block">
          <Spinner label="Loading settings…" />
        </div>
      </div>
    );
  }

  return (
    <div className="page settings-page">
      <PageHeader theme={theme} onThemeChange={onThemeChange}>
        <Link className="button button-small" to={returnTo}>{returnTo === '/' ? 'Library' : '← Return to project'}</Link>

      </PageHeader>

      <main className="settings-layout">
        <aside className="settings-nav">
          <p className="eyebrow">Settings</p>
          <nav>
            <button aria-pressed={tab === 'connections'} className={tab === 'connections' ? 'active' : ''} onClick={() => setTab('connections')}>
              Connections
            </button>
            <button aria-pressed={tab === 'models'} className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>
              Models &amp; roles
            </button>
            <button aria-pressed={tab === 'generation'} className={tab === 'generation' ? 'active' : ''} onClick={() => setTab('generation')}>
              Generation
            </button>
            <button aria-pressed={tab === 'prompts'} className={tab === 'prompts' ? 'active' : ''} onClick={() => setTab('prompts')}>
              Prompt templates
            </button>
            <button
              aria-pressed={tab === 'image-connections'} className={tab === 'image-connections' ? 'active' : ''}
              onClick={() => setTab('image-connections')}
            >
              Image services
            </button>
            <button
              aria-pressed={tab === 'image-prompts'} className={tab === 'image-prompts' ? 'active' : ''}
              onClick={() => setTab('image-prompts')}
            >
              Image prompt templates
            </button>
          </nav>
          <p className="settings-note">Chapter images use two tools: a text model builds the prompt, then an image service draws it. Image prompt templates define the shared art direction.</p>
          <p className="settings-note">
            Credentials are encrypted on the server and never returned to the browser.
          </p>
        </aside>

        <section className="settings-content">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {notice ? <Banner tone="success">{notice}</Banner> : null}

          {tab === 'connections' ? (
            <div className="settings-panel">
              <header className="panel-header">
                <div>
                  <h1>Connections</h1>
                  <p className="muted">
                    OpenRouter and OpenAI-compatible endpoints. Discover models or enter an ID by
                    hand.
                  </p>
                </div>
                <button className="button button-primary" onClick={openNew}>
                  Add connection
                </button>
              </header>

              {connections.length === 0 ? (
                <div className="empty-state">
                  <h3>No connections yet</h3>
                  <p className="muted">
                    Add OpenRouter or a custom OpenAI-compatible endpoint to start generating.
                  </p>
                  <button className="button button-primary" onClick={openNew}>
                    Add your first connection
                  </button>
                </div>
              ) : (
                <div className="connection-list">
                  {connections.map((connection) => {
                    const result = testResults[connection.id];
                    return (
                      <article className="connection-card" key={connection.id}>
                        <div className="connection-head">
                          <div>
                            <h3>{connection.name}</h3>
                            <p className="muted small">
                              {connection.kind === 'openrouter' ? 'OpenRouter' : 'OpenAI-compatible'} ·{' '}
                              {connection.baseUrl}
                            </p>
                          </div>
                          <span className={`badge ${connection.hasApiKey ? 'badge-success' : 'badge-warning'}`}>
                            {connection.hasApiKey ? 'API key stored' : 'No API key'}
                          </span>
                        </div>
                        <div className="connection-meta">
                          <span>
                            {connection.models.length} model
                            {connection.models.length === 1 ? '' : 's'} cached
                          </span>
                          <span>
                            {connection.modelsFetchedAt
                              ? `Updated ${formatDate(connection.modelsFetchedAt)}`
                              : 'Never refreshed'}
                          </span>
                        </div>
                        {result ? (
                          <Banner tone={result.ok ? 'success' : 'danger'}>{result.message}</Banner>
                        ) : null}
                        <div className="row-actions">
                          <button
                            className="button button-small"
                            onClick={() => test(connection)}
                            disabled={testing === connection.id}
                          >
                            {testing === connection.id ? <Spinner /> : null}
                            Test
                          </button>
                          <button
                            className="button button-ghost button-small"
                            onClick={() => refreshModels(connection)}
                            disabled={testing === connection.id}
                          >
                            Refresh models
                          </button>
                          <button className="button button-ghost button-small" onClick={() => openEdit(connection)}>
                            Edit
                          </button>
                          <button
                            className="button button-danger-ghost button-small"
                            onClick={() => removeConnection(connection)}
                          >
                            Delete
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {tab === 'models' ? (
            <div className="settings-panel">
              <header className="panel-header">
                <div>
                  <h1>Models &amp; roles</h1>
                  <p className="muted">
                    Route each task to a model. Unassigned task roles inherit the default model. The
                    image-prompt role expands character image templates but never chooses the image
                    service.
                  </p>
                </div>
              </header>
              <RoleEditor roles={roles} connections={connections} scope="global" onSave={saveRoles} />
            </div>
          ) : null}

          {tab === 'generation' ? (
            <div className="settings-panel">
              <header className="panel-header">
                <div>
                  <h1>Generation defaults</h1>
                  <p className="muted">
                    These defaults apply to every project unless a project overrides them.
                  </p>
                </div>
              </header>
              {generation ? (
                <GenerationSettingsForm
                  value={generation}
                  onSave={async (next) => {
                    await api.updateSettings(next);
                    await refreshSettings();
                  }}
                />
              ) : null}
            </div>
          ) : null}

          {tab === 'prompts' ? (
            <div className="settings-panel">
              <header className="panel-header">
                <div>
                  <h1>Prompt templates</h1>
                  <p className="muted">
                    Editable presets for outlining and prose. Projects can add their own overrides.
                  </p>
                </div>
              </header>
              <TemplateManager templates={templates} projectId={null} onChanged={refreshTemplates} />
            </div>
          ) : null}

          {tab === 'image-connections' ? (
            <ImageConnectionManager
              connections={imageConnections}
              onChanged={refreshImageConnections}
            />
          ) : null}

          {tab === 'image-prompts' ? (
            <div className="settings-panel">
              <header className="panel-header">
                <div>
                  <h1>Image prompts</h1>
                  <p className="muted">
                    Templates for character portraits. Their placeholders are expanded by the
                    image-prompt model before an image service is called.
                  </p>
                </div>
              </header>
              <ImageTemplateManager
                templates={imageTemplates}
                projectId={null}
                onChanged={refreshImageTemplates}
              />
            </div>
          ) : null}
        </section>
      </main>

      <Modal
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.id ? 'Edit connection' : 'Add connection'}
        subtitle="Credentials are stored encrypted on this server and masked in every response."
        footer={
          <div className="modal-actions">
            <button className="button button-ghost" type="button" onClick={() => setEditor(null)}>
              Cancel
            </button>
            <button className="button button-primary" type="submit" form="connection-form" disabled={saving}>
              {saving ? <Spinner /> : null}
              {saving ? 'Saving…' : 'Save connection'}
            </button>
          </div>
        }
      >
        {editor ? (
          <form id="connection-form" className="connection-form" onSubmit={saveConnection}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="connection-name">Name</label>
                <input
                  id="connection-name"
                  value={editor.name}
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  placeholder="e.g. OpenRouter — Claude"
                  autoFocus
                />
              </div>
              <div className="field">
                <label htmlFor="connection-kind">Type</label>
                <select
                  id="connection-kind"
                  value={editor.kind}
                  onChange={(event) => {
                    const kind = event.target.value as ConnectionKind;
                    const isDefaultUrl =
                      !editor.baseUrl ||
                      editor.baseUrl === DEFAULT_BASE[editor.kind] ||
                      editor.baseUrl.startsWith('http://localhost');
                    setEditor({
                      ...editor,
                      kind,
                      baseUrl: isDefaultUrl ? DEFAULT_BASE[kind] : editor.baseUrl,
                    });
                  }}
                >
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </select>
              </div>
            </div>
            <details open={editor.kind === 'openai-compatible'}><summary>Advanced endpoint settings</summary><div className="field">
              <label htmlFor="connection-url">Base URL</label>
              <input
                id="connection-url"
                value={editor.baseUrl}
                onChange={(event) => setEditor({ ...editor, baseUrl: event.target.value })}
                placeholder="https://openrouter.ai/api/v1"
                spellCheck={false}
              />
              <p className="field-hint">
                Include the API prefix (usually <code>/v1</code>). Story Architect appends{' '}
                <code>/chat/completions</code> and <code>/models</code>.
              </p>
            </div>
            </details><div className="field">
              <label htmlFor="connection-key">API key</label>
              <input
                id="connection-key"
                type="password"
                value={editor.apiKey}
                onChange={(event) => setEditor({ ...editor, apiKey: event.target.value })}
                placeholder={editor.id ? 'Leave blank to keep the current key' : 'sk-…'}
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
              <p className="field-hint">
                Sent only from this server. Leave empty for local endpoints that do not require a
                key.
              </p>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
