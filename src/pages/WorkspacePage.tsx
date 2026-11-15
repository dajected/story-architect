import { BackupButton } from '../components/BackupButton';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  Chapter,
  ChapterDetail,
  ConnectionPublic,
  Project,
  ResolvedRole,
} from '@shared/types';
import { api, type ProjectSettingsResponse } from '../api';
import { AssistantPanel } from '../components/AssistantPanel';
import { Brand, ThemeToggle, type Theme } from '../components/Chrome';
import { ChapterEditor } from '../components/ChapterEditor';
import { ChapterSidebar } from '../components/ChapterSidebar';
import { CharactersPanel } from '../components/CharactersPanel';
import { GenerationHistoryPanel } from '../components/GenerationHistoryPanel';
import { WorkspaceQueue } from '../components/WorkspaceQueue';
import { LorePanel } from '../components/LorePanel';
import { MemoryPanel } from '../components/MemoryPanel';
import { OutlinePanel } from '../components/OutlinePanel';
import { ProjectSettingsModal } from '../components/ProjectSettingsModal';
import { Banner, EmptyState, Spinner } from '../components/ui';
import { errorText, formatWords } from '../utils';
import { ProjectImagesPanel } from '../components/ProjectImagesPanel';
import { useWritingPreferences, WritingPreferencesContent, PanelResize } from '../components/WorkspaceControls';

type Tab = 'manuscript' | 'outline' | 'cast' | 'memory' | 'lore' | 'activity' | 'images';

export function WorkspacePage({
  theme,
  onThemeChange,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [settings, setSettings] = useState<ProjectSettingsResponse | null>(null);
  const [connections, setConnections] = useState<ConnectionPublic[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chapterDetail, setChapterDetail] = useState<ChapterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('outline');
  // Tabs stay mounted after their first visit so filters and scroll positions survive switching.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(['outline', 'manuscript']));
  const [imagesFocus, setImagesFocus] = useState<{ characterId: string; nonce: number } | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'story'>('story');
  const openSettings = (section: 'story' | 'app' | 'instructions' = 'story') => { if (section === 'app') { navigate(`/settings?tab=image-connections&returnTo=${encodeURIComponent(`/projects/${projectId}?tab=${tab}`)}`); return; } if (section === 'instructions') {setSettingsOpen(false); setTab('lore'); setTimeout(() => document.getElementById('saved-writing-instructions')?.scrollIntoView({block: 'start'}), 100); return;} setSettingsSection('story'); setSettingsOpen(true); };
  const initialised = useRef(false);
  const [focusMode, setFocusMode] = useState(false);
  const [chaptersVisible, setChaptersVisible] = useState(() => localStorage.getItem('chapters-visible') !== 'false');
  const {preferences, setPreferences, style} = useWritingPreferences();
  const setPreference = (key: string, value: number) => setPreferences(current => ({...current, [key]:value}));
  useEffect(() => {
    if (loading || !project || project.id !== projectId || !initialised.current) return;
    localStorage.setItem(`workspace-tab-${projectId}`, tab);
    const url = new URL(window.location.href);
    if (url.searchParams.get('tab') !== tab) {
      url.searchParams.set('tab', tab);
      navigate(`${url.pathname}${url.search}${url.hash}`, { replace: true });
    }
  }, [tab, project, projectId, loading, navigate]);
  useEffect(() => {setVisited(current => current.has(tab) ? current : new Set(current).add(tab));}, [tab]);
  useEffect(() => {const toggle = () => setFocusMode(v => !v); window.addEventListener('toggle-writing-focus', toggle); return () => window.removeEventListener('toggle-writing-focus', toggle);}, []);
  useEffect(() => {localStorage.setItem('assistant-open', String(assistantOpen));}, [assistantOpen]);
  useEffect(() => {localStorage.setItem('chapters-visible', String(chaptersVisible));}, [chaptersVisible]);
  useEffect(() => {const handler = () => {if (window.innerWidth <= 1180) setAssistantOpen(false);};window.addEventListener('resize', handler);return () => window.removeEventListener('resize',handler);}, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
        if (event.key.toLowerCase() === 'f') {event.preventDefault(); setFocusMode(v => !v);}
        if (event.key.toLowerCase() === 'a') {event.preventDefault(); setAssistantOpen(v => !v);}
      }
      if (event.key === 'Escape') setFocusMode(false);
      if (event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key)) {
        const index = chapters.findIndex(c => c.id === selectedId);
        const target = chapters[index + (event.key === 'ArrowRight' ? 1 : -1)];
        if (target) {event.preventDefault(); setTab('manuscript'); void selectChapter(target.id);}
      }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown',handler);
  }, [chapters, selectedId]);

  const selectChapter = useCallback(async (id: string | null) => {
    setSelectedId(id);
    if (!id) {
      setChapterDetail(null);
      return;
    }
    localStorage.setItem(`story-architect-chapter-${projectId}`, id);
    setChapterLoading(true);
    setChapterError(null);
    try {
      const detail = await api.getChapter(id);
      setChapterDetail(detail);
      localStorage.setItem(`last-chapter-${projectId}`, JSON.stringify({title: detail.title, orderIndex: detail.orderIndex}));
    } catch (err) {
      setChapterError(errorText(err));
      setChapterDetail(null);
    } finally {
      setChapterLoading(false);
    }
  }, [projectId]);

  const loadConnections = useCallback(async () => {
    try {
      setConnections(await api.listConnections());
    } catch {
      setConnections([]);
    }
  }, []);

  const loadProject = useCallback(async () => {
    setLoading(true);
    try {
      const [loadedProject, loadedChapters, loadedSettings] = await Promise.all([
        api.getProject(projectId),
        api.listChapters(projectId),
        api.getProjectSettings(projectId),
      ]);
      setProject(loadedProject);
      setChapters(loadedChapters);
      setSettings(loadedSettings);
      setError(null);

      if (!initialised.current) {
        initialised.current = true;
        const storedTab = new URLSearchParams(window.location.search).get('tab') ?? localStorage.getItem(`workspace-tab-${projectId}`);
        setTab(storedTab && ['manuscript','outline','cast','memory','lore','activity','images'].includes(storedTab) ? storedTab as Tab : loadedProject.outlineStatus === 'approved' ? 'manuscript' : 'outline');
      }

      const stored = localStorage.getItem(`story-architect-chapter-${projectId}`);
      const wanted =
        loadedChapters.find((chapter) => chapter.id === stored) ??
        loadedChapters.find((chapter) => chapter.currentRevisionId) ??
        loadedChapters[0] ??
        null;
      if (wanted) {
        await selectChapter(wanted.id);
      } else {
        setSelectedId(null);
        setChapterDetail(null);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, selectChapter]);

  useEffect(() => {
    initialised.current = false;
    setProject(null);
    setChapterDetail(null);
    setSelectedId(null);
    void loadProject();
    void loadConnections();
  }, [loadProject, loadConnections]);

  useEffect(() => {
    document.title = project ? `${project.title} — Story Architect` : 'Story Architect';
  }, [project]);

  const refreshAll = useCallback(async () => {
    try {
      const [loadedProject, loadedChapters, loadedSettings] = await Promise.all([
        api.getProject(projectId),
        api.listChapters(projectId),
        api.getProjectSettings(projectId),
      ]);
      setProject(loadedProject);
      setChapters(loadedChapters);
      setSettings(loadedSettings);
      if (selectedId && !loadedChapters.some((chapter) => chapter.id === selectedId)) {
        if (loadedChapters[0]) await selectChapter(loadedChapters[0].id);
        else await selectChapter(null);
      } else if (!selectedId && loadedChapters[0]) {
        await selectChapter(loadedChapters[0].id);
      } else if (selectedId) {
        const detail = await api.getChapter(selectedId);
        setChapterDetail(detail);
      }
    } catch (err) {
      setError(errorText(err));
    }
  }, [projectId, selectedId, selectChapter]);

  const refreshChapter = useCallback(async () => {
    if (!selectedId) return;
    try {
      const detail = await api.getChapter(selectedId);
      setChapterDetail(detail);
    } catch (err) {
      setChapterError(errorText(err));
    }
  }, [selectedId]);

  const handleChapterUpdated = useCallback((detail: ChapterDetail) => {
    setChapterDetail(detail);
    setChapters((current) =>
      current.map((chapter) =>
        chapter.id === detail.id
          ? {
              ...chapter,
              wordCount: detail.wordCount,
              status: detail.status,
              currentRevisionId: detail.currentRevisionId,
              updatedAt: detail.updatedAt,
            }
          : chapter,
      ),
    );
  }, []);

  const handleProjectUpdated = useCallback((updated: Project) => {
    setProject(updated);
  }, []);

  if (loading) {
    return (
      <div className="workspace-shell">
        <div className="workspace-topbar">
          <Brand small />
        </div>
        <div className="centered-block fill">
          <Spinner label="Opening the manuscript…" />
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="empty-screen">
        <h1>Project not found</h1>
        <p className="muted">{error ?? 'This project may have been removed.'}</p>
        <Link className="button button-primary" to="/">
          Back to the library
        </Link>
      </div>
    );
  }

  const proseRole = settings?.roles.find((role: ResolvedRole) => role.role === 'prose');
  const modelLabel =
    proseRole?.connectionId && proseRole.model
      ? `${proseRole.connectionName ?? 'connection'} / ${proseRole.model}`
      : null;
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  const selectedIndex = selectedId ? chapters.findIndex((chapter) => chapter.id === selectedId) : -1;
  const navigateChapter = (direction: 'previous' | 'next') => {
    if (selectedIndex < 0) return;
    const target = chapters[selectedIndex + (direction === 'previous' ? -1 : 1)];
    if (!target) return;
    setTab('manuscript');
    void selectChapter(target.id);
  };

  return (
    <div className={`workspace-shell ${tab === 'outline' && !focusMode ? 'outline-page' : ''} ${focusMode ? 'focus-mode' : ''} ${chaptersVisible && tab === 'manuscript' ? '' : 'chapters-collapsed'}`} style={style}>
      <header className="workspace-topbar">
        <div className="workspace-topbar-left">
          <Link className="button button-small" to="/">Library</Link>
          <WorkspaceQueue projectId={project.id} onOpenActivity={() => setTab('activity')} />
        </div>

        <nav className="workspace-tabs" aria-label="Workspace sections">
          <button aria-pressed={tab === 'outline'} className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}>
            Outline
          </button>
          <button aria-pressed={tab === 'manuscript'} className={tab === 'manuscript' ? 'active' : ''} onClick={() => setTab('manuscript')}>
            Read story
          </button>
          <button aria-pressed={tab === 'cast'} className={tab === 'cast' ? 'active' : ''} onClick={() => setTab('cast')}>
            Characters
          </button>
          <button aria-pressed={tab === 'memory'} className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>
            Story memory
          </button>
          <button aria-pressed={tab === 'lore'} className={tab === 'lore' ? 'active' : ''} onClick={() => setTab('lore')}>
            World notes
          </button>
          <button
            aria-pressed={tab === 'activity'} className={tab === 'activity' ? 'active' : ''}
            onClick={() => setTab('activity')}
          >
            Activity
          </button>
          <button aria-pressed={tab === 'images'} className={tab === 'images' ? 'active' : ''} onClick={() => setTab('images')}>Images</button>
        </nav>

        <div className="workspace-actions">

          <div className="workspace-title">
            <h1>{project.title}</h1>
            <div className="workspace-subtitle">
              <span>{formatWords(totalWords)} words</span>
              <span>{chapters.length} chapters</span>
              {project.status === 'archived' ? <span className="badge">Archived</span> : null}
            </div>
          </div>
          <details className="action-menu workspace-menu" onKeyDown={event => {
            if (event.key === 'Escape') {
              event.currentTarget.open = false;
              event.currentTarget.querySelector('summary')?.focus();
            }
          }}><summary className="button button-small">Menu</summary><div className="action-menu-content" onClick={event => {
            if ((event.target as HTMLElement).closest('button, a')) {
              const menu = event.currentTarget.closest('.workspace-menu');
              menu?.removeAttribute('open');
              menu?.querySelector('summary')?.focus();
            }
          }}>
          <details className="workspace-submenu"><summary>Workspace</summary><div>
          {tab === 'manuscript' ? <button className="button button-ghost button-small" aria-pressed={window.innerWidth <= 1180 ? sidebarOpen : chaptersVisible} onClick={() => {if (window.innerWidth <= 1180) setSidebarOpen(v => !v); else setChaptersVisible(v => !v);}}>
            {sidebarOpen || (window.innerWidth > 1180 && chaptersVisible) ? 'Hide chapters' : 'Show chapters'}
          </button> : null}
          <button
            className={`button button-ghost button-small ${assistantOpen ? 'active' : ''}`}
            aria-pressed={assistantOpen}
            onClick={() => setAssistantOpen((open) => !open)}
          >
            {assistantOpen ? 'Hide assistant' : 'Show assistant'}
          </button>
          {focusMode ? <button className="button button-small" onClick={() => setFocusMode(false)}>Exit focus</button> : null}
          </div></details>
          <details className="workspace-submenu"><summary>Settings</summary><div>
          <button className="button button-small" onClick={() => openSettings()}>Novel settings</button>
          <Link className="button button-small" to={`/settings?returnTo=${encodeURIComponent(`/projects/${projectId}?tab=${tab}`)}`}>App settings</Link>
          </div></details>
          <details className="workspace-submenu"><summary>Export & backup</summary><div>
          <a className="button button-ghost button-small" href={`/api/projects/${project.id}/export.html`}>Export HTML (chapter images)</a>
          <a className="button button-ghost button-small" href={api.exportUrl(project.id)}>
            Export Markdown
          </a>
          <BackupButton projectId={project.id} label="Back up" />
          </div></details>
          </div></details>
        </div>
      </header>

      {project.status === 'archived' ? (
        <Banner
          tone="warning"
          title="This novel is archived"
          actions={
            <button
              className="button button-small"
              onClick={async () => {
                try {
                  const updated = await api.unarchiveProject(project.id);
                  setProject(updated);
                } catch (err) {
                  setError(errorText(err));
                }
              }}
            >
              Restore to library
            </button>
          }
        >
          It is read-write, but hidden from the active library. Restore it when you are ready.
        </Banner>
      ) : null}

      {error ? (
        <Banner tone="danger" actions={<button className="button button-small" onClick={() => void loadProject()}>Reload</button>}>
          {error}
        </Banner>
      ) : null}

      {project.outlineStatus !== 'approved' || totalWords === 0 ? <section className="next-step" aria-label="Next step"><div><strong>{project.outlineStatus === 'approved' ? 'Next: start chapter 1' : project.outlineStatus === 'draft' ? 'Next: review and approve your outline' : 'Next: create your outline'}</strong><p className="muted small">{project.outlineStatus === 'approved' ? 'Generate a draft, then read your chapter here.' : 'Approving creates your chapter list and unlocks AI drafting. Review the titles and briefs first.'}</p></div><button className="button button-primary button-small" onClick={() => {setTab(project.outlineStatus === 'approved' ? 'manuscript' : 'outline'); if (project.outlineStatus === 'approved' && chapters[0]) void selectChapter(chapters[0].id);}}>{project.outlineStatus === 'approved' ? 'Start chapter 1' : 'Open outline'}</button></section> : null}
      <div className="workspace-main">
        <ChapterSidebar
          chapters={chapters}
          selectedId={selectedId}
          onSelect={(id) => {setTab('manuscript'); void selectChapter(id);}}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {chaptersVisible && tab === 'manuscript' ? <PanelResize label="Resize chapter panel" value={preferences.sidebarWidth!} min={200} max={400} onChange={value => setPreference('sidebarWidth',value)} /> : null}
        <div className="workspace-center">
          <div className={`workspace-view ${tab === 'outline' ? '' : 'is-hidden'}`}>
            <div className="workspace-scroll">
              <OutlinePanel
                active={tab === 'outline'}
                project={project}
                onProjectChanged={refreshAll}
                onOpenManuscript={() => setTab('manuscript')}
                onOpenChapter={(chapterId) => {
                  setTab('manuscript');
                  void selectChapter(chapterId);
                }}
              />
            </div>
          </div>

          <div className={`workspace-view ${tab === 'manuscript' ? '' : 'is-hidden'}`}>
            {project.outlineStatus !== 'approved' && !chapters.length ? (
              <div className="workspace-scroll">
                <EmptyState
                  title="Drafting is locked until the outline is approved"
                  actions={
                    <button className="button button-primary" onClick={() => setTab('outline')}>
                      Review the outline
                    </button>
                  }
                >
                  Approve the latest outline revision to create the chapter list and unlock
                  generation. Existing manuscript text is never discarded by outline changes.
                </EmptyState>
              </div>
            ) : chapterLoading ? (
              <div className="centered-block fill">
                <Spinner label="Loading chapter…" />
              </div>
            ) : chapterError ? (
              <div className="workspace-scroll">
                <Banner tone="danger" actions={<button className="button button-small" onClick={() => void refreshChapter()}>Retry</button>}>
                  {chapterError}
                </Banner>
              </div>
            ) : chapterDetail && settings ? (
              <ChapterEditor
                key={chapterDetail.id}
                project={project}
                chapter={chapterDetail}
                settings={settings.generation}
                onChapterUpdated={handleChapterUpdated}
                onRefreshChapter={refreshChapter}
                onOpenOutline={() => setTab('outline')}
                onOpenMemory={() => setTab('memory')}
                onNavigate={navigateChapter}
                canNavigatePrevious={selectedIndex > 0}
                canNavigateNext={selectedIndex >= 0 && selectedIndex < chapters.length - 1}
              />
            ) : (
              <div className="workspace-scroll">
                <EmptyState
                  title={chapters.length === 0 ? 'No chapters yet' : 'Choose a chapter'}
                  actions={
                    <button className="button" onClick={() => setTab('outline')}>
                      Open outline
                    </button>
                  }
                >
                  {chapters.length === 0
                    ? 'Approve an outline to create the chapter list.'
                    : 'Pick a chapter from the sidebar to start writing.'}
                </EmptyState>
              </div>
            )}
          </div>

          {visited.has('images') ? (
            <div className={`workspace-view ${tab === 'images' ? '' : 'is-hidden'}`}>
              <div className="workspace-scroll workspace-standard-padding">
                <ProjectImagesPanel onOpenSettings={() => openSettings('app')} project={project} focus={imagesFocus} active={tab === 'images'} onOpenCast={() => setTab('cast')} />
              </div>
            </div>
          ) : null}
          {visited.has('cast') ? (
            <div className={`workspace-view ${tab === 'cast' ? '' : 'is-hidden'}`}>
              <div className="workspace-scroll">
                <CharactersPanel
                  project={project}
                  onProjectChanged={refreshAll}
                  onOpenSettings={() => openSettings()}
                  onOpenImageSettings={() => openSettings('app')}
                  onOpenTimeline={(characterId) => {setImagesFocus({characterId, nonce: Date.now()}); setTab('images');}}
                />
              </div>
            </div>
          ) : null}

          {visited.has('memory') ? (
            <div className={`workspace-view ${tab === 'memory' ? '' : 'is-hidden'}`}>
              <div className="workspace-scroll">
                <MemoryPanel
                  project={project}
                  onProjectChanged={refreshAll}
                  onOpenChapter={(id) => {setTab('manuscript'); void selectChapter(id);}}
                  onOpenSettings={() => openSettings()}
                />
              </div>
            </div>
          ) : null}

          {visited.has('lore') ? (
            <div className={`workspace-view ${tab === 'lore' ? '' : 'is-hidden'}`}>
              <div className="workspace-scroll">
                <LorePanel project={project} />
              </div>
            </div>
          ) : null}

          {visited.has('activity') ? (
            <div className={`workspace-view ${tab === 'activity' ? '' : 'is-hidden'}`}>
              <div className="workspace-scroll workspace-standard-padding">
                <GenerationHistoryPanel project={project} />
              </div>
            </div>
          ) : null}
        </div>

        {assistantOpen ? <PanelResize label="Resize Assistant" value={preferences.assistantWidth!} min={280} max={600} reverse onChange={value => setPreference('assistantWidth',value)} /> : null}
        {assistantOpen ? <AssistantPanel
          project={project}
          chapter={chapterDetail}
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          onChapterUpdated={handleChapterUpdated}
          modelLabel={modelLabel}
        /> : null}
      </div>

      <ProjectSettingsModal
        initialSection={settingsSection}
        theme={theme} onThemeChange={onThemeChange}
        displayPreferences={<><button className="button" onClick={() => openSettings('instructions')}>Manage saved writing instructions</button><ThemeToggle theme={theme} onChange={onThemeChange} /><WritingPreferencesContent preferences={preferences} onChange={setPreference} /></>}
        open={settingsOpen}
        project={project}
        connections={connections}
        onClose={() => {
          setSettingsOpen(false);
          void refreshAll();
        }}
        onProjectUpdated={handleProjectUpdated}
        onArchived={() => navigate('/')}
      />
    </div>
  );
}
