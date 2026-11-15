import type { ReactNode } from 'react';
import type { Theme } from './Chrome';
import { confirmAction } from './ui';
import { useEffect, useState } from 'react';
import type {
  ConnectionPublic,
  GenerationSettings,
  ImagePromptTemplate,
  Project,
  PromptTemplate,
  ResolvedRole,
  TaskRole,
} from '@shared/types';
import { api, type ProjectSettingsResponse } from '../api';
import { GenerationSettingsForm } from './GenerationSettingsForm';
import { ImageTemplateManager } from './ImageTemplateManager';
import { ProjectForm } from './ProjectForm';
import { RoleEditor } from './RoleEditor';
import { TemplateManager } from './TemplateManager';
import { Banner, Modal, Spinner } from './ui';
import { errorText } from '../utils';

type Section = 'story' | 'generation' | 'models' | 'prompts' | 'images' | 'danger' | 'display';

export function ProjectSettingsModal({
  open,
  project,
  connections,
  onClose,
  onProjectUpdated,
  onArchived,
  theme, onThemeChange, displayPreferences, initialSection = 'story',
}: {
  initialSection?: 'story';
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  displayPreferences: ReactNode;
  open: boolean;
  project: Project;
  connections: ConnectionPublic[];
  onClose: () => void;
  onProjectUpdated: (project: Project) => void;
  onArchived: () => void;
}) {
  const [section, setSection] = useState<Section>('story');
  const [data, setData] = useState<ProjectSettingsResponse | null>(null);
  const [imageTemplates, setImageTemplates] = useState<ImagePromptTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setError(null);
    setLoading(true);
    Promise.all([api.getProjectSettings(project.id), api.listImageTemplates(project.id)])
      .then(([settings, templates]) => {
        setData(settings);
        setImageTemplates(templates);
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, [open, project.id, initialSection]);

  const saveProject = async (input: Record<string, unknown>) => {
    const updated = await api.updateProject(project.id, input);
    onProjectUpdated(updated);
  };

  const saveGeneration = async (generation: Partial<GenerationSettings>) => {
    const next = await api.updateProjectSettings(project.id, generation);
    setData((current) => (current ? { ...current, generation: next } : current));
    setData(await api.getProjectSettings(project.id));
  };

  const saveRoles = async (
    assignments: Array<{ role: TaskRole; connectionId: string | null; model: string | null }>,
  ) => {
    await api.setModelRoles({ scope: 'project', projectId: project.id, assignments });
    const roles = await api.getModelRoles(project.id);
    setData((current) =>
      current ? { ...current, roles: roles.roles as ResolvedRole[] } : current,
    );
  };

  const refreshTemplates = async () => {
    const templates = await api.listTemplates(project.id);
    setData((current) => (current ? { ...current, templates } : current));
  };

  const refreshImageTemplates = async () => {
    setImageTemplates(await api.listImageTemplates(project.id));
  };

  const archive = async () => {
    if (!await confirmAction(`Archive "${project.title}"? You can restore it from the library later.`)) {
      return;
    }
    setArchiving(true);
    setError(null);
    try {
      await api.archiveProject(project.id);
      onArchived();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Novel settings — ${project.title}`}
      width="wide"
    >
      <div className="project-settings">
        <nav className="subnav" aria-label="Novel settings">
          {(
            [
              ['story', 'Story setup'],
              ['display', 'Writing & appearance'],
              ['generation', 'Generation'],
              ['models', 'Model overrides'],
              ['prompts', 'Prompt templates'],
              ['images', 'Image prompts'],
              ['danger', 'Archive'],
            ] as Array<[Section, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={section === id} className={section === id ? 'active' : ''}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="project-settings-body">
          {section === 'display' ? displayPreferences : null}
          {error ? <Banner tone="danger">{error}</Banner> : null}

          {section === 'story' ? (
            <ProjectForm
              initial={project}
              submitLabel="Save project"
              onSubmit={async (input) => {
                await saveProject(input);
                onClose();
              }}
              onCancel={onClose}
            />
          ) : null}

          {section === 'generation' ? (
            loading || !data ? (
              <div className="centered-block">
                <Spinner label="Loading project settings…" />
              </div>
            ) : (
              <div className="settings-panel">
                <header className="panel-header">
                  <div>
                    <h2>Project generation</h2>
                    <p className="muted">
                      These settings override the global defaults for this novel only.
                    </p>
                  </div>
                </header>
                <details className="settings-source" open><summary>Effective settings and sources</summary><dl>{Object.entries(data.generation).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{String(value ?? 'Provider default')} · {data.generationSources?.[key] ?? 'Global default'}</dd></div>)}</dl><button className="button button-small" onClick={async () => {try {await api.resetProjectGeneration(project.id);setData(await api.getProjectSettings(project.id));} catch(err) {setError(errorText(err));}}}>Use inherited generation defaults</button></details>
                <GenerationSettingsForm value={data.generation} onSave={saveGeneration} compact />
              </div>
            )
          ) : null}

          {section === 'models' ? (
            loading || !data ? (
              <div className="centered-block">
                <Spinner label="Loading model roles…" />
              </div>
            ) : (
              <div className="settings-panel">
                <header className="panel-header">
                  <div>
                    <h2>Project model overrides</h2>
                    <p className="muted">
                      Leave a role on the global setting to inherit it. Overrides apply only to
                      this novel.
                    </p>
                  </div>
                </header>
                <RoleEditor
                  roles={data.roles}
                  connections={connections}
                  scope="project"
                  onSave={saveRoles}
                />
              </div>
            )
          ) : null}

          {section === 'prompts' ? (
            loading || !data ? (
              <div className="centered-block">
                <Spinner label="Loading prompt templates…" />
              </div>
            ) : (
              <div className="settings-panel">
                <header className="panel-header">
                  <div>
                    <h2>Project prompt templates</h2>
                    <p className="muted">
                      Create a project-specific default, or use the global presets.
                    </p>
                  </div>
                </header>
                <TemplateManager
                  templates={data.templates}
                  projectId={project.id}
                  onChanged={refreshTemplates}
                />
              </div>
            )
          ) : null}

          {section === 'images' ? (
            <div className="settings-panel">
              <header className="panel-header">
                <div>
                  <h2>Project image prompt templates</h2>
                  <p className="muted">
                    Add a prompt template for this novel, or use the global image prompts. The
                    portrait studio lists both.
                  </p>
                </div>
              </header>
              <ImageTemplateManager
                templates={imageTemplates}
                projectId={project.id}
                onChanged={refreshImageTemplates}
              />
            </div>
          ) : null}

          {section === 'danger' ? (
            <div className="settings-panel danger-panel">
              <h2>Archive this novel</h2>
              <p className="muted">
                Archiving removes the project from the active library. Its text, revisions, chats,
                and settings are kept, and it can be restored at any time.
              </p>
              <button className="button button-danger" onClick={archive} disabled={archiving}>
                {archiving ? <Spinner /> : null}
                {archiving ? 'Archiving…' : 'Archive project'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
