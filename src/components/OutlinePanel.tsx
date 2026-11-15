import { confirmAction } from './ui';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ChapterBatch,
  ChapterBatchMode,
  GenerationJob,
  OutlineChapter,
  OutlineRevision,
  Project,
} from '@shared/types';
import { countWords } from '@shared/utils';
import { api, type OutlineResponse } from '../api';
import { useJobStream } from '../hooks';
import { errorText, formatDate, formatWords, newId } from '../utils';
import { Banner, EmptyState, Spinner } from './ui';

export function OutlinePanel({
  project,
  onProjectChanged,
  onOpenManuscript,
  onOpenChapter,
}: {
  project: Project;
  onProjectChanged: () => Promise<void>;
  onOpenManuscript: () => void;
  onOpenChapter?: (chapterId: string) => void;
}) {
  const [outline, setOutline] = useState<OutlineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chapters, setChapters] = useState<OutlineChapter[]>([]);
  const [dirty, setDirty] = useState(false);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [batch, setBatch] = useState<ChapterBatch | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const previousCompleted = useRef(0);
  const previousBatchStatus = useRef<ChapterBatch['status'] | null>(null);
  const finishedRef = useRef<(job: GenerationJob) => void>(() => {});
  const stream = useJobStream((job) => finishedRef.current(job));
  const outputRef = useRef<HTMLDivElement | null>(null);

  const latest = outline?.latest ?? null;
  const viewed = outline?.revisions.find((revision) => revision.id === viewedId) ?? latest;
  const isLatest = Boolean(latest && viewed && latest.id === viewed.id);
  const canEdit = Boolean(viewed && isLatest && viewed.status !== 'superseded');

  const loadOutline = async (resetEditor = true) => {
    try {
      const data = await api.getOutline(project.id);
      setOutline(data);
      setLoadError(null);
      if (resetEditor) {
        const target = data.latest;
        setViewedId(target?.id ?? null);
        setChapters(target?.chapters ?? []);
        setDirty(false);
      }
      return data;
    } catch (err) {
      setLoadError(errorText(err));
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getOutline(project.id);
        if (cancelled) return;
        setOutline(data);
        setViewedId(data.latest?.id ?? null);
        setChapters(data.latest?.chapters ?? []);
        if (data.activeJob) stream.attach(data.activeJob);
      } catch (err) {
        if (!cancelled) setLoadError(errorText(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    previousCompleted.current = 0;
    previousBatchStatus.current = null;
    (async () => {
      try {
        const next = await api.getChapterBatch(project.id);
        if (cancelled) return;
        setBatch(next);
        previousCompleted.current =
          next?.items.filter((item) => item.status === 'completed').length ?? 0;
        previousBatchStatus.current = next?.status ?? null;
      } catch {
        // A missing batch endpoint is not fatal for the outline view.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  useEffect(() => {
    if (batch?.status !== 'running') return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const next = await api.getChapterBatch(project.id);
          if (!cancelled) setBatch(next);
        } catch {
          // Keep the last known progress through transient failures.
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [batch?.status, project.id]);

  const completedItems =
    batch?.items.filter((item) => item.status === 'completed').length ?? 0;

  useEffect(() => {
    if (completedItems > previousCompleted.current) {
      previousCompleted.current = completedItems;
      void onProjectChanged();
    }
  }, [completedItems, onProjectChanged]);

  useEffect(() => {
    if (!batch) return;
    const previous = previousBatchStatus.current;
    previousBatchStatus.current = batch.status;
    if (previous === 'running' && batch.status !== 'running') {
      if (batch.status === 'interrupted') {
        setBatchError(
          batch.message ?? 'The server restarted during the batch. Drafted chapters are saved.',
        );
      } else if (batch.status === 'cancelled') {
        setBatchNotice(batch.message ?? 'Batch stopped.');
      } else {
        setBatchNotice(batch.message ?? 'The chapter batch finished.');
      }
      void onProjectChanged();
    }
  }, [batch, onProjectChanged]);

  const loadBatch = async (): Promise<ChapterBatch | null> => {
    try {
      const next = await api.getChapterBatch(project.id);
      setBatch(next);
      setBatchError(null);
      return next;
    } catch (err) {
      setBatchError(errorText(err));
      return null;
    }
  };

  const startBatch = async (mode: ChapterBatchMode = 'draft') => {
    const regenerate = mode === 'regenerate';
    if (
      !await confirmAction(
        regenerate
          ? 'Regenerate the entire story? Every chapter is re-drafted from the approved outline and the new draft becomes the chapter text. Previous drafts stay in each chapter’s revision history. This can take a long time and use many tokens.'
          : 'Generate every chapter in order? Chapters that already have manuscript text are skipped, and each draft waits for the previous chapter’s summary. This can take a long time.',
      )
    ) {
      return;
    }
    setBatchBusy(true);
    setBatchError(null);
    setBatchNotice(null);
    try {
      const next = await api.startChapterBatch(project.id, mode);
      setBatch(next);
      previousCompleted.current =
        next.items.filter((item) => item.status === 'completed').length;
      previousBatchStatus.current = next.status;
      setBatchNotice(
        next.status === 'running'
          ? regenerate
            ? 'Regeneration started. Chapters are rewritten one at a time.'
            : 'Batch started. Chapters are generated one at a time.'
          : next.message ?? 'Nothing needed generating.',
      );
    } catch (err) {
      setBatchError(errorText(err));
    } finally {
      setBatchBusy(false);
    }
  };

  const stopBatch = async () => {
    setBatchBusy(true);
    setBatchError(null);
    try {
      const next = await api.cancelChapterBatch(project.id);
      setBatch(next);
      setBatchNotice(next.message ?? 'Batch stopped.');
      await loadBatch();
    } catch (err) {
      setBatchError(errorText(err));
    } finally {
      setBatchBusy(false);
    }
  };

  useEffect(() => {
    if (stream.output && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [stream.output]);

  useEffect(() => {
    finishedRef.current = (job: GenerationJob) => {
      void (async () => {
        await loadOutline();
        await onProjectChanged();
        if (job.status === 'completed') {
          setNotice('A new outline draft is ready. Review the chapters and approve it before drafting.');
          setShowGenerator(false);
        } else if (job.status === 'failed') {
          setError(job.error || 'Outline generation failed.');
        } else if (job.status === 'cancelled') {
          setNotice('Outline generation stopped. No revision was saved.');
        }
      })();
    };
  });

  const updateChapter = (id: string, patch: Partial<OutlineChapter>) => {
    setChapters((current) => current.map((chapter) => (chapter.id === id ? { ...chapter, ...patch } : chapter)));
    setDirty(true);
    setNotice(null);
  };

  const move = (index: number, direction: -1 | 1) => {
    setChapters((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      const [item] = next.splice(index, 1);
      if (!item) return current;
      next.splice(target, 0, item);
      return next;
    });
    setDirty(true);
  };

  const addChapter = () => {
    setChapters((current) => [
      ...current,
      { id: newId(), title: `Chapter ${current.length + 1}`, brief: '' },
    ]);
    setDirty(true);
  };

  const removeChapter = async (id: string) => {
    const chapter = chapters.find((entry) => entry.id === id);
    if (!chapter) return;
    if (chapter.brief || chapter.title) {
      if (!await confirmAction(`Remove "${chapter.title}" from the outline?`)) return;
    }
    setChapters((current) => current.filter((entry) => entry.id !== id));
    setDirty(true);
  };

  const save = async (): Promise<OutlineRevision | null> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const revision = await api.saveOutline(project.id, chapters, latest?.id);
      await loadOutline();
      await onProjectChanged();
      setNotice(
        revision.status === 'draft' && latest?.status === 'approved'
          ? `Saved as a new outline revision (v${revision.version}). Approve it to resume drafting.`
          : `Outline draft saved (v${revision.version}).`,
      );
      return revision;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!latest || dirty) return;
    const existing = await api.listChapters(project.id).catch(() => null);
    if (!existing) {setError('Could not load existing chapters to preview approval. Try again.'); return;}
    const added = latest.chapters.filter(c => !existing.some(e => e.id === c.id));
    const removed = existing.filter(c => !latest.chapters.some(e => e.id === c.id));
    const moved = latest.chapters.filter((c,i) => existing.some(e => e.id === c.id && e.orderIndex !== i));
    const changed = latest.chapters.filter(c => existing.some(e => e.id === c.id && (e.brief !== c.brief || e.title !== c.title)));
    if (!await confirmAction(`Approve ${latest.chapters.length} chapters and unlock AI drafting?\n${added.length} new chapters; ${moved.length} reordered; ${changed.length} titles or briefs changed.\n${removed.length ? `Remove: ${removed.map(c => c.title + (c.wordCount ? ' (contains manuscript text — removal is blocked)' : '')).join(', ')}.` : 'No existing chapters removed.'}\nExisting prose and revision history are retained for chapters that remain.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.approveOutline(project.id, latest.id);
      await loadOutline();
      await onProjectChanged();
      setNotice('Outline approved. Chapters are ready for drafting.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const createManual = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createManualOutline(project.id);
      await loadOutline();
      await onProjectChanged();
      setNotice('A blank outline is ready. Add chapter titles and briefs, then approve it.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const startGeneration = async () => {
    if (dirty && !await confirmAction('Generating a new outline will replace your unsaved outline edits. Continue?')) {
      return;
    }
    if (
      latest?.status === 'approved' &&
      !await confirmAction(
        'Generate a new outline revision? Drafting pauses until you approve the new revision. Existing chapters with text are kept.',
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    try {
      const job = await api.generateOutline(project.id, instructions.trim() || undefined);
      stream.attach(job);
      setShowGenerator(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const stop = async () => {
    if (!stream.job) return;
    try {
      await api.cancelJob(stream.job.id);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const selectRevision = async (id: string) => {
    if (dirty && id !== viewedId) {
      if (!await confirmAction('Discard unsaved outline edits and view another revision?')) return;
    }
    const revision = outline?.revisions.find((entry) => entry.id === id);
    if (!revision) return;
    setViewedId(id);
    setChapters(revision.chapters);
    setDirty(false);
    setNotice(null);
  };

  if (loading) {
    return (
      <div className="outline-panel centered-block">
        <Spinner label="Loading the outline…" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="outline-panel">
        <Banner tone="danger" actions={<button className="button button-small" onClick={() => void loadOutline()}>Retry</button>}>
          {loadError}
        </Banner>
      </div>
    );
  }

  const lastJob = outline?.lastJob;
  const showLastAttempt =
    !stream.running &&
    lastJob &&
    oldFailedJob(lastJob) &&
    lastJob.output.trim().length > 0;

  return (
    <div className="outline-panel">
      <header className="outline-header">
        <div>
          <p className="eyebrow">Story outline</p>
          <h1>{latest ? `Outline v${latest.version}` : 'Build the outline'}</h1>
          <p className="lede">
            Shape the chapter spine first. Drafting opens only after you approve the latest
            revision.
          </p>
        </div>
        <div className="outline-header-actions">
          {latest ? (
            <button className="button button-ghost" onClick={() => setShowGenerator((open) => !open)}>
              {showGenerator ? 'Hide generator' : latest.status === 'approved' ? 'Regenerate' : 'Generate again'}
            </button>
          ) : null}
          {latest ? (
            <span className={`badge ${latest.status === 'approved' ? 'badge-success' : 'badge-warning'}`}>
              {latest.status === 'approved' ? 'Approved' : 'Awaiting approval'}
            </span>
          ) : null}
        </div>
      </header>

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}

      {!latest && !showGenerator ? (
        <EmptyState
          title="No outline yet"
          actions={
            <>
              <button className="button button-primary" onClick={() => setShowGenerator(true)}>
                Generate with AI
              </button>
              <button className="button" onClick={createManual} disabled={busy}>
                Write it manually
              </button>
            </>
          }
        >
          The outline model will turn the project questionnaire into chapter titles and briefs.
          You can edit every part before approving, or write the outline by hand.
        </EmptyState>
      ) : null}

      {showGenerator ? (
        <section className="generator-card">
          <div className="generator-head">
            <div>
              <h3>{latest ? 'Regenerate the outline' : 'Generate an outline'}</h3>
              <p className="muted small">
                Uses the outline model and prompt template. A new revision is saved; existing
                chapters with text are never deleted automatically.
              </p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="outline-instructions">Additional instructions</label>
            <textarea
              id="outline-instructions"
              rows={3}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Optional: make the middle darker, keep it to three acts, add a rival perspective…"
            />
          </div>
          <div className="form-actions inline">
            <button className="button button-primary" onClick={startGeneration} disabled={stream.running}>
              {stream.running ? <Spinner /> : null}
              {stream.running ? 'Generating…' : latest ? 'Generate new revision' : 'Generate outline'}
            </button>
            {stream.running ? (
              <button className="button button-danger-ghost" onClick={stop}>
                Stop
              </button>
            ) : null}
            <button className="button button-ghost" onClick={createManual} disabled={busy || stream.running}>
              Start manual outline
            </button>
            <Link className="button button-ghost button-small" to={`/settings?tab=models&returnTo=${encodeURIComponent(`/projects/${project.id}`)}`}>
              Model settings
            </Link>
          </div>

          {stream.job ? (
            <div className={`stream-panel ${stream.running ? 'running' : ''}`}>
              <div className="stream-head">
                <span className="badge">{stream.job.model}</span>
                <span className="muted small">
                  {stream.running ? 'Streaming the outline…' : `Generation ${stream.job.status}`}
                </span>
                <span className="muted small">{formatWords(countWords(stream.output))} words</span>
                {!stream.running ? (
                  <button className="button button-ghost button-small stream-dismiss" onClick={() => stream.reset()}>
                    Dismiss
                  </button>
                ) : null}
              </div>
              {stream.job.error ? <Banner tone="danger">{stream.job.error}</Banner> : null}
              <div className="stream-output" ref={outputRef}>
                {stream.output || (stream.running ? 'Waiting for the first tokens…' : 'No output.')}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {showLastAttempt && lastJob ? (
        <details className="last-attempt">
          <summary>Last outline attempt: {lastJob.status}{lastJob.error ? ` — ${lastJob.error}` : ''}</summary>
          <pre>{lastJob.output}</pre>
        </details>
      ) : null}

      {latest?.status === 'approved' || batch?.status === 'running' ? (
        <BatchPanel
          batch={batch}
          busy={batchBusy}
          error={batchError}
          notice={batchNotice}
          onStart={() => void startBatch('draft')}
          onRegenerate={() => void startBatch('regenerate')}
          onStop={() => void stopBatch()}
          onRefresh={() => void loadBatch()}
          onOpenChapter={onOpenChapter}
          approved={latest?.status === 'approved'}
        />
      ) : null}

      {latest ? (
        <div className="outline-layout">
          <details className="outline-history">
            <summary>Revision history ({outline?.revisions.length})</summary>
            <div className="revision-mini-list">
              {outline?.revisions.map((revision) => (
                <button
                  key={revision.id}
                  className={`revision-mini ${viewed?.id === revision.id ? 'selected' : ''}`}
                  onClick={() => selectRevision(revision.id)}
                >
                  <span>v{revision.version}</span>
                  <span className={`badge ${revision.id === latest.id ? 'badge-accent' : ''}`}>
                    {revision.id === latest.id
                      ? revision.status === 'approved'
                        ? 'Approved'
                        : 'Draft'
                      : 'History'}
                  </span>
                  <span className="muted small">{formatDate(revision.createdAt)}</span>
                </button>
              ))}
            </div>
            <p className="muted small">
              {outline?.revisions.length} revision{outline?.revisions.length === 1 ? '' : 's'} stored.
            </p>
          </details>

          <section className="outline-editor">
            {viewed && !isLatest ? (
              <Banner
                tone="info"
                actions={
                  <button className="button button-small" onClick={() => selectRevision(latest.id)}>
                    Back to latest
                  </button>
                }
              >
                Viewing revision v{viewed.version} ({viewed.status}). Older revisions are read-only.
              </Banner>
            ) : null}

            {latest && viewed?.id === latest.id ? (
              latest.status === 'approved' ? (
                <Banner
                  tone={dirty ? 'warning' : 'success'}
                  title={dirty ? 'Unsaved changes to an approved outline' : 'Outline approved'}
                >
                  {dirty
                    ? 'Saving creates a new revision. Drafting pauses until the new revision is approved.'
                    : 'Drafting is unlocked. Editing this outline creates a new revision that needs approval.'}
                </Banner>
              ) : (
                <Banner tone="warning" title="Draft awaiting approval">
                  Approve this revision to unlock chapter drafting. Any existing chapter text is
                  preserved.
                </Banner>
              )
            ) : null}

            {canEdit ? (
              <div className="outline-chapter-list">
                {chapters.map((chapter, index) => (
                  <div className="outline-chapter-card" key={chapter.id}>
                    <div className="outline-chapter-index">{String(index + 1).padStart(2, '0')}</div>
                    <div className="outline-chapter-fields">
                      <input
                        className="outline-title-input"
                        value={chapter.title}
                        onChange={(event) => updateChapter(chapter.id, { title: event.target.value })}
                        placeholder="Chapter title"
                        aria-label={`Chapter ${index + 1} title`}
                      />
                      <textarea
                        ref={node => {if (node) {node.style.height = "auto"; node.style.height = `${node.scrollHeight}px`;}}}
                        value={chapter.brief}
                        onChange={(event) => updateChapter(chapter.id, { brief: event.target.value })}
                        placeholder="What happens, what changes, and what it sets up."
                        rows={4}
                        aria-label={`Chapter ${index + 1} brief`}
                      />
                    </div>
                    <details className="outline-chapter-actions action-menu"><summary className="button button-small" aria-label={`Actions for chapter ${index + 1}`}>Edit order</summary><div className="action-menu-content">
                      <button
                        className="icon-button"
                        onClick={() => move(index, -1)}
                        disabled={index === 0}
                        aria-label="Move chapter up"
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        className="icon-button"
                        onClick={() => move(index, 1)}
                        disabled={index === chapters.length - 1}
                        aria-label="Move chapter down"
                        title="Move down"
                      >
                        ↓
                      </button>
                      <button
                        className="icon-button danger"
                        onClick={() => removeChapter(chapter.id)}
                        aria-label="Remove chapter"
                        title="Remove"
                      >
                        ×
                      </button>
                    </div></details>
                  </div>
                ))}
                <button className="button button-ghost add-chapter" onClick={addChapter}>
                  Add chapter
                </button>
              </div>
            ) : (
              <div className="outline-readonly">
                {viewed?.chapters.map((chapter, index) => (
                  <article key={chapter.id} className="outline-readonly-row">
                    <span className="outline-chapter-index">{String(index + 1).padStart(2, '0')}</span>
                    <div>
                      <h3>{chapter.title}</h3>
                      <p>{chapter.brief || 'No brief.'}</p>
                    </div>
                  </article>
                ))}
                {viewed?.chapters.length === 0 ? <p className="muted">This revision has no chapters.</p> : null}
              </div>
            )}

            <div className="outline-actions">
              <div className="outline-counts">
                <span>
                  {chapters.length} chapter{chapters.length === 1 ? '' : 's'}
                </span>
                {dirty ? <span className="badge badge-warning">Unsaved edits</span> : null}
              </div>
              <div className="row-actions">
                {canEdit ? (
                  <>
                    <button
                      className="button"
                      onClick={() => void save()}
                      disabled={busy || !dirty || stream.running}
                    >
                      {busy ? <Spinner /> : null}
                      {latest?.status === 'approved' ? 'Save as new revision' : 'Save draft'}
                    </button>
                    {latest?.status === 'draft' ? (
                      <button
                        className="button button-primary"
                        onClick={approve}
                        disabled={busy || dirty || stream.running || chapters.length === 0}
                        title={dirty ? 'Save the draft before approving.' : undefined}
                      >
                        {busy ? <Spinner /> : null}
                        Approve outline
                      </button>
                    ) : null}
                    {latest?.status === 'approved' ? (
                      <button className="button" onClick={onOpenManuscript} disabled={busy}>
                        Go to manuscript
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function oldFailedJob(job: GenerationJob): boolean {
  return ['failed', 'cancelled', 'interrupted'].includes(job.status);
}

function batchItemLabel(status: ChapterBatch['items'][number]['status']): string {
  if (status === 'completed') return 'Drafted';
  if (status === 'failed') return 'Failed';
  if (status === 'running') return 'Drafting';
  if (status === 'skipped') return 'Skipped';
  return 'Waiting';
}

function batchItemBadge(status: ChapterBatch['items'][number]['status']): string {
  if (status === 'completed') return 'badge-success';
  if (status === 'failed') return 'badge-danger';
  if (status === 'running') return 'badge-accent';
  return '';
}

function BatchPanel({
  batch,
  busy,
  error,
  notice,
  approved,
  onStart,
  onRegenerate,
  onStop,
  onRefresh,
  onOpenChapter,
}: {
  batch: ChapterBatch | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  approved: boolean;
  onStart: () => void;
  onRegenerate: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onOpenChapter?: (chapterId: string) => void;
}) {
  const items = batch?.items ?? [];
  const total = items.length;
  const completed = items.filter((item) => item.status === 'completed').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const skipped = items.filter((item) => item.status === 'skipped').length;
  const settled = completed + failed + skipped;
  const active = batch?.status === 'running';
  const regenerating = active && batch?.mode === 'regenerate';
  const progress = total > 0 ? Math.round((settled / total) * 100) : 0;
  const running = items.find((item) => item.status === 'running') ?? null;

  return (
    <section className="batch-panel">
      <div className="batch-head">
        <div>
          <p className="eyebrow">Whole novel</p>
          <h3>
            {active
              ? regenerating
                ? 'Regenerating the story'
                : 'Drafting all chapters'
              : 'Generate or regenerate the story'}
          </h3>
          <p className="muted small">
            Both run one chapter at a time, in outline order, and wait for the previous
            chapter’s summary so the context carries forward. <strong>Generate all chapters</strong>{' '}
            fills empty chapters only. <strong>Regenerate full story</strong> rewrites every chapter
            and keeps the replaced drafts in revision history.
          </p>
        </div>
        <div className="row-actions">
          {active ? (
            <button className="button button-danger-ghost" onClick={onStop} disabled={busy}>
              {busy ? <Spinner /> : null}
              Stop batch
            </button>
          ) : (
            <>
              <button
                className="button button-primary"
                onClick={onStart}
                disabled={busy || !approved}
                title={approved ? undefined : 'Approve the outline first.'}
              >
                {busy ? <Spinner /> : null}
                Generate all chapters
              </button>
              <button
                className="button button-danger-ghost"
                onClick={onRegenerate}
                disabled={busy || !approved}
                title={
                  approved
                    ? 'Re-draft every chapter from the approved outline.'
                    : 'Approve the outline first.'
                }
              >
                Regenerate full story
              </button>
            </>
          )}
          {batch && !active ? (
            <button className="button button-ghost" onClick={onRefresh} disabled={busy}>
              Refresh
            </button>
          ) : null}
        </div>
      </div>

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}

      {batch ? (
        <>
          <div className="batch-progress">
            <div className="batch-progress-track">
              <span style={{ width: `${progress}%` }} />
            </div>
            <span className="muted small">
              {batch.mode === 'regenerate' ? 'Regeneration' : 'Drafting'} · {settled} of {total}{' '}
              settled · {completed} {batch.mode === 'regenerate' ? 'rewritten' : 'drafted'}
              {failed > 0 ? ` · ${failed} failed` : ''}
              {skipped > 0 ? ` · ${skipped} skipped` : ''}
            </span>
            {batch.message ? <span className="muted small">{batch.message}</span> : null}
          </div>
          {running ? (
            <p className="muted small batch-running">
              Now {batch.mode === 'regenerate' ? 'rewriting' : 'drafting'} {running.orderIndex + 1}.{' '}
              {running.title}…
            </p>
          ) : null}
          <ol className="batch-items">
            {items.map((item) => (
              <li className={`batch-item ${item.status}`} key={item.chapterId}>
                <span className="batch-item-index">
                  {String(item.orderIndex + 1).padStart(2, '0')}
                </span>
                <span className="batch-item-title">{item.title}</span>
                <span className={`badge ${batchItemBadge(item.status)}`}>
                  {batchItemLabel(item.status)}
                </span>
                {item.error ? <span className="batch-item-error">{item.error}</span> : null}
                {onOpenChapter ? (
                  <button
                    className="button button-ghost button-small batch-item-open"
                    onClick={() => onOpenChapter(item.chapterId)}
                  >
                    Open
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="muted small">
          No batch has run yet. Draft the empty chapters, or regenerate the whole story.
        </p>
      )}
    </section>
  );
}
