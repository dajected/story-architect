import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Project } from '@shared/types';
import { api } from '../api';
import { PageHeader, type Theme } from '../components/Chrome';
import { ProjectForm } from '../components/ProjectForm';
import { Banner, EmptyState, Modal, Spinner } from '../components/ui';
import { errorText, formatWords, relativeTime } from '../utils';

export function LibraryPage({
  theme,
  onThemeChange,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try {
      const list = await api.listProjects(true);
      setProjects(list);
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

  const active = projects.filter((project) => project.status === 'active');
  const archived = projects.filter((project) => project.status === 'archived');

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return active;
    return active.filter(
      (project) =>
        project.title.toLowerCase().includes(query) ||
        project.premise.toLowerCase().includes(query) ||
        project.genre.toLowerCase().includes(query),
    );
  }, [active, search]);

  const create = async (input: Record<string, unknown>) => {
    const project = await api.createProject(input);
    navigate(`/projects/${project.id}`);
  };

  const archive = async (project: Project) => {
    if (!window.confirm(`Archive "${project.title}"? You can restore it later from the library.`)) {
      return;
    }
    try {
      const updated = await api.archiveProject(project.id);
      setProjects((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const restore = async (project: Project) => {
    try {
      const updated = await api.unarchiveProject(project.id);
      setProjects((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setShowArchived(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="page library-page">
      <PageHeader theme={theme} onThemeChange={onThemeChange}>
        <span className="header-note">A quiet workshop for long stories</span>
      </PageHeader>

      <main className="page-body">
        <section className="library-hero">
          <div>
            <p className="eyebrow">Novel workspace</p>
            <h1>Your library</h1>
            <p className="lede">
              Shape an outline, draft chapters, and keep every revision of the manuscript in one
              self-hosted place.
            </p>
          </div>
          <button className="button button-primary button-large" onClick={() => setCreating(true)}>
            New novel
          </button>
        </section>

        {error ? (
          <Banner tone="danger" actions={<button className="button button-small" onClick={load}>Retry</button>}>
            {error}
          </Banner>
        ) : null}

        <div className="library-toolbar">
          <input
            className="search-input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search titles, premises, genres"
            aria-label="Search projects"
          />
          <div className="library-toolbar-right">
            <span className="muted">
              {active.length} active {active.length === 1 ? 'novel' : 'novels'}
            </span>
            {archived.length > 0 ? (
              <button
                className="button button-ghost button-small"
                onClick={() => setShowArchived((current) => !current)}
              >
                {showArchived ? 'Hide archive' : `Archive (${archived.length})`}
              </button>
            ) : null}
          </div>
        </div>

        {loading ? (
          <div className="centered-block">
            <Spinner label="Opening the library…" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={active.length === 0 ? 'The first page is blank' : 'No novels match that search'}
            actions={
              active.length === 0 ? (
                <button className="button button-primary" onClick={() => setCreating(true)}>
                  Create your first novel
                </button>
              ) : null
            }
          >
            {active.length === 0
              ? 'Set up a project with a premise and shape, generate an outline, then draft the first chapter.'
              : 'Try a different phrase or clear the search.'}
          </EmptyState>
        ) : (
          <div className="project-grid">
            {filtered.map((project) => (
              <ProjectCard key={project.id} project={project} onArchive={archive} />
            ))}
          </div>
        )}

        {showArchived && archived.length > 0 ? (
          <section className="archive-section">
            <h2>Archive</h2>
            <div className="project-grid">
              {archived.map((project) => (
                <ProjectCard key={project.id} project={project} onRestore={restore} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="library-footnote">
          <div>
            <h3>Bring your own models</h3>
            <p className="muted">
              Connect OpenRouter or any OpenAI-compatible endpoint. Keys stay on the server, and
              each task can use a different model.
            </p>
          </div>
          <Link className="button" to="/settings">
            Configure connections
          </Link>
        </section>
      </main>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create a novel"
        subtitle="Answer as much or as little as you like. Blank fields are left to the AI."
        width="wide"
      >
        <ProjectForm submitLabel="Create project" onSubmit={create} onCancel={() => setCreating(false)} />
      </Modal>
    </div>
  );
}

function ProjectCard({
  project,
  onArchive,
  onRestore,
}: {
  project: Project;
  onArchive?: (project: Project) => void;
  onRestore?: (project: Project) => void;
}) {
  return (
    <article className="project-card">
      <Link className="project-card-main" to={`/projects/${project.id}`}>
        <div className="project-card-top">
          <span className={`badge ${outlineBadgeClass(project.outlineStatus)}`}>
            {outlineLabel(project.outlineStatus)}
          </span>
          <span className="muted small">{relativeTime(project.updatedAt)}</span>
        </div>
        <h2>{project.title}</h2>
        <p className="project-premise">{project.premise || 'No premise yet.'}</p>
        <div className="project-meta">
          {project.genre ? <span>{project.genre}</span> : null}
          {project.pov ? <span>{project.pov}</span> : null}
          <span>
            {project.chapterTotal} {project.chapterTotal === 1 ? 'chapter' : 'chapters'}
          </span>
          <span>{formatWords(project.currentWords)} words</span>
        </div>
      </Link>
      <div className="project-card-actions">
        <Link className="button button-ghost button-small" to={`/projects/${project.id}`}>
          Open
        </Link>
        {onArchive ? (
          <button className="button button-ghost button-small" onClick={() => onArchive(project)}>
            Archive
          </button>
        ) : null}
        {onRestore ? (
          <button className="button button-ghost button-small" onClick={() => onRestore(project)}>
            Restore
          </button>
        ) : null}
      </div>
    </article>
  );
}

function outlineLabel(status: Project['outlineStatus']): string {
  if (status === 'approved') return 'Outline approved';
  if (status === 'draft') return 'Outline draft';
  return 'No outline';
}

function outlineBadgeClass(status: Project['outlineStatus']): string {
  if (status === 'approved') return 'badge-success';
  if (status === 'draft') return 'badge-warning';
  return '';
}
