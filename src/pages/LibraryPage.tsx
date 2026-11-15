import { confirmAction } from '../components/ui';
import { BackupButton } from '../components/BackupButton';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [sort, setSort] = useState(() => localStorage.getItem('library-sort') ?? 'recent');
  const [compact, setCompact] = useState(() => localStorage.getItem('library-compact') === 'true');
  const [ready, setReady] = useState({text:false, image:false});
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const backupInput = useRef<HTMLInputElement | null>(null);

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
    void Promise.all([api.getSettings(), api.listImageConnections()]).then(([settings, images]) => setReady({text: settings.roles.some(r => r.role === 'default' && Boolean(r.model && r.connectionId)), image: images.length > 0})).catch(() => {});
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

  const sorted = [...filtered].sort((a,b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'words' ? b.currentWords - a.currentWords : b.updatedAt.localeCompare(a.updatedAt));
  const create = async (input: Record<string, unknown>) => {
    const project = await api.createProject(input);
    navigate(`/projects/${project.id}`);
  };

  const archive = async (project: Project) => {
    if (!await confirmAction(`Archive "${project.title}"? You can restore it later from the library.`)) {
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

  const restoreBackup = async (file: File) => {
    setRestoring(true);
    setError(null);
    setRestoreNotice(null);
    try {
      const result = await api.restoreProject(file);
      setRestoreNotice(
        `Restored "${result.project.title}" with ${result.stats.chapters} chapters, ` +
          `${result.stats.revisions} revisions, ${result.stats.characters} characters, and ` +
          `${result.stats.images} images. Open it from the library.`,
      );
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRestoring(false);
      if (backupInput.current) backupInput.current.value = '';
    }
  };

  return (
    <div className="page library-page">
      <PageHeader theme={theme} onThemeChange={onThemeChange}>
        <span className="header-note">A quiet workshop for long stories</span>
      </PageHeader>

      <main className="page-body">
        <section className={`library-hero ${active.length ? 'returning-library' : ''}`}>
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

        {restoreNotice ? <Banner tone="success">{restoreNotice}</Banner> : null}

        
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
            <select aria-label="Sort novels" value={sort} onChange={e => {setSort(e.target.value); localStorage.setItem('library-sort',e.target.value);}}><option value="recent">Recently updated</option><option value="title">Title</option><option value="words">Word count</option></select>
            <button className="button button-small" aria-pressed={compact} onClick={() => {setCompact(v => !v);localStorage.setItem('library-compact',String(!compact));}}>{compact ? 'Card view' : 'Compact view'}</button>
            <span className="muted">
              {active.length} active {active.length === 1 ? 'novel' : 'novels'}
            </span>
            <input
              ref={backupInput}
              type="file"
              accept=".gz,.tar.gz,application/gzip"
              className="visually-hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void restoreBackup(file);
              }}
            />
            <button
              className="button button-ghost button-small"
              onClick={() => backupInput.current?.click()}
              disabled={restoring}
            >
              {restoring ? <Spinner label="Restoring…" /> : 'Restore backup'}
            </button>
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
          <div className={`project-grid ${compact ? 'compact-library' : ''}`}>
            {sorted.map((project) => (
              <ProjectCard key={project.id} project={project} onArchive={archive} />
            ))}
          </div>
        )}

        {showArchived && archived.length > 0 ? (
          <section className="archive-section">
            <h2>Archive</h2>
            <div className={`project-grid ${compact ? 'compact-library' : ''}`}>
              {archived.map((project) => (
                <ProjectCard key={project.id} project={project} onRestore={restore} />
              ))}
            </div>
          </section>
        ) : null}

        
      </main>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create a novel"
        subtitle="Turn your idea into a novel."
        width="narrow"
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
  let lastChapter: { title: string; orderIndex: number } | null = null;
  try { lastChapter = JSON.parse(localStorage.getItem(`last-chapter-${project.id}`) ?? 'null'); } catch { /* Ignore old browser data. */ }
  return (
    <article className="project-card">
      <Link className="project-card-main" to={`/projects/${project.id}${project.currentWords > 0 ? '?tab=manuscript' : ''}`}>
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
        <Link className="button button-ghost button-small" to={`/projects/${project.id}${project.currentWords > 0 ? '?tab=manuscript' : ''}`}>
          {project.currentWords > 0 ? lastChapter ? `Continue chapter ${lastChapter.orderIndex + 1}: ${lastChapter.title}` : 'Continue writing →' : project.outlineStatus === 'draft' ? 'Review outline →' : 'Open project →'}
        </Link>
        <BackupButton projectId={project.id} label="Back up" />
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
