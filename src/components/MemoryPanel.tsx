import { formatChapterLabel } from '../utils';
import { confirmAction } from './ui';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  ChapterMemory,
  Fact,
  FactClass,
  FactInput,
  FactKind,
  MemoryOverview,
  Project,
} from '@shared/types';
import { FACT_CLASS_LABELS, FACT_KIND_LABELS } from '@shared/types';
import { api } from '../api';
import { errorText, formatDate, formatWords } from '../utils';
import { Banner, EmptyState, Modal, Spinner } from './ui';

type MemoryTab = 'chapters' | 'facts';

const FACT_KINDS: FactKind[] = [
  'character_development',
  'relationship',
  'timeline',
  'plot_thread',
  'world',
];

const FACT_CLASSES: FactClass[] = ['authored', 'established', 'plan'];

export function MemoryPanel({
  project,
  onProjectChanged,
  onOpenSettings,
  onOpenChapter,
}: {
  project: Project;
  onProjectChanged: () => Promise<void>;
  onOpenSettings: () => void;
  onOpenChapter?: (id: string) => void;
}) {
  const [data, setData] = useState<MemoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<MemoryTab>('chapters');
  const [busy, setBusy] = useState(false);
  const [busyChapter, setBusyChapter] = useState<string | null>(null);
  const [summaryEdit, setSummaryEdit] = useState<{ memory: ChapterMemory; text: string } | null>(
    null,
  );
  const [factDraft, setFactDraft] = useState<FactInput | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const overview = await api.getProjectMemory(project.id);
        setData(overview);
        setError(null);
        return overview;
      } catch (err) {
        setError(errorText(err));
        return null;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [project.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data || data.activeJobs.length === 0) return;
    const timer = window.setInterval(() => {
      void load(true);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [data, load]);

  const rebuildAll = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const jobs = await api.rebuildMemory(project.id);
      if (jobs.length === 0) {
        setNotice('Every chapter with text already has a current summary.');
      } else {
        setNotice(
          `${jobs.length} ${jobs.length === 1 ? 'summary is' : 'summaries are'} queued. They run one at a time against the current manuscript.`,
        );
      }
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const rebuildChapter = async (chapterId: string) => {
    setBusyChapter(chapterId);
    setError(null);
    try {
      await api.rebuildChapterMemory(chapterId);
      setNotice('Memory rebuild started.');
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyChapter(null);
    }
  };

  const saveSummary = async () => {
    if (!summaryEdit) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveChapterMemorySummary(summaryEdit.memory.chapterId, summaryEdit.text);
      setSummaryEdit(null);
      setNotice('Summary saved and matched to the current chapter revision.');
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const factAction = async (id: string, action: 'accept' | 'reject' | 'supersede') => {
    setBusy(true);
    setError(null);
    try {
      if (action === 'accept') await api.acceptFact(id);
      else if (action === 'reject') await api.rejectFact(id);
      else await api.supersedeFact(id);
      await load(true);
      await onProjectChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteFact = async (id: string) => {
    if (!await confirmAction('Delete this fact permanently? Superseding keeps a record in the project.')) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteFact(id);
      await load(true);
      await onProjectChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const supersedeOutdated = async () => {
    setBusy(true);
    setError(null);
    try {
      const count = await api.supersedeOutdatedFacts(project.id);
      setNotice(
        count === 0
          ? 'No established facts are tied to an outdated source revision.'
          : `${count} outdated ${count === 1 ? 'fact was' : 'facts were'} superseded and will stop entering prompts.`,
      );
      await load(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const saveFact = async () => {
    if (!factDraft) return;
    if (!(factDraft.statement ?? '').trim()) {
      setError('A fact needs a statement.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createFact(project.id, factDraft);
      setFactDraft(null);
      setNotice('World fact saved. Authored facts are established immediately.');
      await load(true);
      await onProjectChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="memory-panel centered-block">
        <Spinner label="Loading continuity…" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="memory-panel">
        <Banner
          tone="danger"
          actions={
            <button className="button button-small" onClick={() => void load()}>
              Retry
            </button>
          }
        >
          {error ?? 'Continuity could not be loaded.'}
        </Banner>
      </div>
    );
  }

  const counts = data.counts;
  const proposed = data.facts.filter((fact) => fact.status === 'proposed');
  const established = data.facts.filter((fact) => fact.status === 'established');
  const archived = data.facts.filter((fact) => ['superseded', 'rejected'].includes(fact.status));
  const needsRebuild = data.chapters.filter(
    (memory) => memory.status === 'stale' || memory.status === 'missing',
  );
  const running = data.activeJobs.filter((job) => job.kind === 'memory');
  const lastProblemJob = data.recentJobs.find(
    (job) =>
      job.kind === 'memory' &&
      Boolean(job.error) &&
      ['failed', 'interrupted'].includes(job.status),
  );
  const problemChapter = lastProblemJob?.chapterId
    ? data.chapters.find((memory) => memory.chapterId === lastProblemJob.chapterId)
    : null;

  return (
    <div className="memory-panel">
      <header className="panel-header memory-header">
        <div>
          <p className="eyebrow">Story memory</p>
          <h1>Story memory</h1>
          <p className="lede">
            Facts and summaries collected from your chapters. Accepting a fact guides future AI drafts; it does not edit your manuscript. Proposed canon
            only enters later prompts after you accept it.
          </p>
        </div>
        <div className="memory-header-actions">
          <button
            className="button button-primary"
            onClick={rebuildAll}
            disabled={busy || needsRebuild.length === 0 || running.length > 0}
          >
            {busy ? <Spinner /> : null}
            {needsRebuild.length > 0
              ? `Rebuild ${needsRebuild.length} ${needsRebuild.length === 1 ? 'chapter' : 'chapters'}`
              : 'Memory up to date'}
          </button>
          <button className="button" onClick={() => setFactDraft(defaultFactDraft())}>
            Add world fact
          </button>
          <button className="button button-ghost button-small" onClick={onOpenSettings}>
            Model settings
          </button>
        </div>
      </header>

      {error ? (
        <Banner
          tone="danger"
          actions={
            <button className="button button-small" onClick={() => setError(null)}>
              Dismiss
            </button>
          }
        >
          {error}
        </Banner>
      ) : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}

      {!data.memoryRole ? (
        <Banner
          tone="warning"
          title="No memory model assigned"
          actions={
            <button className="button button-small" onClick={onOpenSettings}>
              Assign a model
            </button>
          }
        >
          Summaries, fact extraction, and outline casting use the memory role. You can still edit
          summaries and facts by hand.
        </Banner>
      ) : null}

      {running.length > 0 ? (
        <Banner tone="info" title="Rebuilding continuity">
          {running.length} memory {running.length === 1 ? 'job is' : 'jobs are'} running or queued.
          Existing summaries stay visible until each job finishes.
        </Banner>
      ) : null}

      {lastProblemJob && !running.length ? (
        <Banner
          tone="danger"
          title={`Memory rebuild ${lastProblemJob.status}${
            problemChapter
              ? ` — Chapter ${problemChapter.orderIndex + 1}: ${problemChapter.chapterTitle}`
              : ''
          }`}
          actions={
            lastProblemJob.chapterId ? (
              <button
                className="button button-small"
                onClick={() => void rebuildChapter(lastProblemJob.chapterId as string)}
                disabled={busyChapter === lastProblemJob.chapterId}
              >
                Retry
              </button>
            ) : undefined
          }
        >
          {lastProblemJob.error}
        </Banner>
      ) : null}

      {counts.outdatedFacts > 0 ? (
        <Banner
          tone="warning"
          title={`${counts.outdatedFacts} established ${
            counts.outdatedFacts === 1 ? 'fact comes' : 'facts come'
          } from changed chapters`}
          actions={
            <button className="button button-small" onClick={() => void supersedeOutdated()} disabled={busy}>
              Supersede outdated
            </button>
          }
        >
          They stay in prompts but are labelled for review. Superseding stops them entering new
          context immediately.
        </Banner>
      ) : null}

      <div className="memory-stats">
        <Stat label="Current summaries" value={`${counts.current}/${counts.chapters}`} />
        <Stat label="Stale" value={String(counts.stale)} tone={counts.stale > 0 ? 'warning' : undefined} />
        <Stat label="Missing" value={String(counts.missing)} />
        <Stat
          label="Proposed facts"
          value={String(counts.proposedFacts)}
          tone={counts.proposedFacts > 0 ? 'warning' : undefined}
        />
        <Stat label="Established facts" value={String(counts.establishedFacts)} />
        <Stat label="Active cast" value={String(counts.activeCharacters)} />
      </div>

      <div className="segmented memory-tabs">
        <button className={tab === 'chapters' ? 'active' : ''} onClick={() => setTab('chapters')}>
          Chapters
        </button>
        <button className={tab === 'facts' ? 'active' : ''} onClick={() => setTab('facts')}>
          Facts
          {proposed.length > 0 ? <span className="tab-count">{proposed.length}</span> : null}
        </button>
      </div>

      {tab === 'chapters' ? (
        <section className="memory-section">
          {data.chapters.length === 0 ? (
            <EmptyState title="No chapters yet">Approve an outline to create chapters.</EmptyState>
          ) : (
            <div className="memory-list">
              {data.chapters.map((memory) => (
                <article className={`memory-row status-${memory.status}`} key={memory.chapterId}>

                  <div className="memory-row-body">
                    <div className="memory-row-head">
                      <h3>{formatChapterLabel(memory.chapterTitle, memory.orderIndex)}</h3>{onOpenChapter ? <button className="button button-small" onClick={() => onOpenChapter(memory.chapterId)}>Open this chapter</button> : null}
                      <MemoryBadge status={memory.status} />
                      <span className="muted small">
                        {formatWords(memory.wordCount)} words · source{' '}
                        {formatWords(memory.sourceWordCount)} words
                      </span>
                    </div>
                    {memory.summary ? (
                      <p className="memory-summary">{memory.summary}</p>
                    ) : (
                      <p className="muted small">
                        {memory.status === 'empty'
                          ? 'No manuscript text yet. Draft the chapter first.'
                          : 'No summary has been generated for this chapter.'}
                      </p>
                    )}
                    {memory.staleReasons.length > 0 ? (
                      <ul className="memory-reasons">
                        {memory.staleReasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="memory-row-meta">
                      {memory.generatedAt ? (
                        <span className="muted small">Generated {formatDate(memory.generatedAt)}</span>
                      ) : null}
                      {memory.sourceRevisionId ? (
                        <span className="muted small" title={memory.sourceRevisionId}>
                          Source revision {memory.sourceRevisionId.slice(0, 8)}
                        </span>
                      ) : null}
                      {memory.proposedFactCount > 0 ? (
                        <span className="badge badge-warning">
                          {memory.proposedFactCount} proposed{' '}
                          {memory.proposedFactCount === 1 ? 'fact' : 'facts'}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="memory-row-actions">
                    <button
                      className="button button-small"
                      onClick={() => void rebuildChapter(memory.chapterId)}
                      disabled={
                        busyChapter === memory.chapterId ||
                        memory.status === 'empty' ||
                        memory.status === 'pending'
                      }
                    >
                      {busyChapter === memory.chapterId ? <Spinner /> : null}
                      {memory.status === 'pending' ? 'Rebuilding…' : 'Rebuild'}
                    </button>
                    <button
                      className="button button-ghost button-small"
                      onClick={() => setSummaryEdit({ memory, text: memory.summary ?? '' })}
                      disabled={memory.status === 'empty'}
                    >
                      Edit summary
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="memory-section facts-section">
          <div className="facts-column">
            <div className="facts-head">
              <h2>Proposed facts</h2>
              <span className="badge badge-warning">{proposed.length}</span>
            </div>
            {proposed.length === 0 ? (
              <p className="muted small">
                Nothing awaits review. Rebuild a chapter summary to propose new facts.
              </p>
            ) : (
              proposed.map((fact) => (
                <FactCard
                  key={fact.id}
                  fact={fact}
                  actions={
                    <>
                      <button
                        className="button button-primary button-small"
                        onClick={() => void factAction(fact.id, 'accept')}
                        disabled={busy}
                      >
                        Accept
                      </button>
                      <button
                        className="button button-ghost button-small"
                        onClick={() => void factAction(fact.id, 'reject')}
                        disabled={busy}
                      >
                        Reject
                      </button>
                    </>
                  }
                />
              ))
            )}
          </div>

          <div className="facts-column">
            <div className="facts-head">
              <h2>Established facts</h2>
              <span className="badge badge-success">{established.length}</span>
            </div>
            {established.length === 0 ? (
              <p className="muted small">
                Accepted facts will appear here and enter chapter prompts for later scenes.
              </p>
            ) : (
              established.map((fact) => (
                <FactCard
                  key={fact.id}
                  fact={fact}
                  actions={
                    <button
                      className="button button-ghost button-small"
                      onClick={() => void factAction(fact.id, 'supersede')}
                      disabled={busy}
                    >
                      Supersede
                    </button>
                  }
                />
              ))
            )}
          </div>

          {archived.length > 0 ? (
            <details className="facts-archive">
              <summary>Superseded and rejected facts ({archived.length})</summary>
              <div className="facts-archive-list">
                {archived.map((fact) => (
                  <FactCard
                    key={fact.id}
                    fact={fact}
                    actions={
                      <button
                        className="button button-danger-ghost button-small"
                        onClick={() => void deleteFact(fact.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    }
                  />
                ))}
              </div>
            </details>
          ) : null}
        </section>
      )}

      <Modal
        open={summaryEdit !== null}
        onClose={() => setSummaryEdit(null)}
        title={
          summaryEdit
            ? `Summary — Chapter ${summaryEdit.memory.orderIndex + 1}: ${summaryEdit.memory.chapterTitle}`
            : 'Edit summary'
        }
        subtitle="An authored summary is matched to the current chapter revision."
        width="wide"
        footer={
          summaryEdit ? (
            <div className="modal-actions">
              <button className="button button-ghost" onClick={() => setSummaryEdit(null)}>
                Cancel
              </button>
              <button
                className="button button-primary"
                onClick={saveSummary}
                disabled={busy || !summaryEdit.text.trim()}
              >
                {busy ? <Spinner /> : null}
                Save summary
              </button>
            </div>
          ) : null
        }
      >
        {summaryEdit ? (
          <div className="field">
            <label htmlFor="summary-editor">Chapter summary</label>
            <textarea
              id="summary-editor"
              rows={10}
              value={summaryEdit.text}
              onChange={(event) => setSummaryEdit({ ...summaryEdit, text: event.target.value })}
            />
          </div>
        ) : null}
      </Modal>

      <Modal
        open={factDraft !== null}
        onClose={() => setFactDraft(null)}
        title="Add a story fact"
        subtitle="Authored world facts are established immediately. Plans stay labelled as plans."
        width="wide"
        footer={
          factDraft ? (
            <div className="modal-actions">
              <button className="button button-ghost" onClick={() => setFactDraft(null)}>
                Cancel
              </button>
              <button
                className="button button-primary"
                onClick={saveFact}
                disabled={busy || !(factDraft.statement ?? '').trim()}
              >
                {busy ? <Spinner /> : null}
                Save fact
              </button>
            </div>
          ) : null
        }
      >
        {factDraft ? (
          <div className="fact-form">
            <div className="field">
              <label htmlFor="fact-statement">Statement</label>
              <textarea
                id="fact-statement"
                rows={4}
                value={factDraft.statement ?? ''}
                onChange={(event) => setFactDraft({ ...factDraft, statement: event.target.value })}
                placeholder="The observatory door only opens for someone carrying the brass key."
              />
            </div>
            <div className="form-row three">
              <div className="field">
                <label htmlFor="fact-kind">Kind</label>
                <select
                  id="fact-kind"
                  value={factDraft.kind ?? 'world'}
                  onChange={(event) =>
                    setFactDraft({ ...factDraft, kind: event.target.value as FactKind })
                  }
                >
                  {FACT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {FACT_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="fact-class">Class</label>
                <select
                  id="fact-class"
                  value={factDraft.factClass ?? 'authored'}
                  onChange={(event) =>
                    setFactDraft({ ...factDraft, factClass: event.target.value as FactClass })
                  }
                >
                  {FACT_CLASSES.map((factClass) => (
                    <option key={factClass} value={factClass}>
                      {FACT_CLASS_LABELS[factClass]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="fact-character">Character</label>
                <select
                  id="fact-character"
                  value={factDraft.characterId ?? ''}
                  onChange={(event) =>
                    setFactDraft({ ...factDraft, characterId: event.target.value || null })
                  }
                >
                  <option value="">No specific character</option>
                  {data.characters
                    .filter((character) => character.status === 'active')
                    .map((character) => (
                      <option key={character.id} value={character.id}>
                        {character.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="fact-scope">Applies from</label>
              <select
                id="fact-scope"
                value={factDraft.scopeChapterId ?? ''}
                onChange={(event) =>
                  setFactDraft({ ...factDraft, scopeChapterId: event.target.value || null })
                }
              >
                <option value="">Anywhere in the story (no chapter scope)</option>
                {data.chapters.map((memory) => (
                  <option key={memory.chapterId} value={memory.chapterId}>
                    Chapter {memory.orderIndex + 1}: {memory.chapterTitle}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                Scope prevents a later development from appearing as established history in
                earlier chapters.
              </p>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return (
    <div className={`memory-stat ${tone ?? ''}`}>
      <span>{value}</span>
      <small>{label}</small>
    </div>
  );
}

function MemoryBadge({ status }: { status: ChapterMemory['status'] }) {
  const map: Record<ChapterMemory['status'], { label: string; className: string }> = {
    current: { label: 'Current', className: 'badge-success' },
    stale: { label: 'Stale', className: 'badge-warning' },
    missing: { label: 'Missing', className: '' },
    pending: { label: 'Rebuilding', className: 'badge-accent' },
    empty: { label: 'No text', className: '' },
  };
  const entry = map[status];
  return <span className={`badge ${entry.className}`}>{entry.label}</span>;
}

function FactCard({
  fact,
  actions,
}: {
  fact: Fact;
  actions: ReactNode;
}) {
  return (
    <article className={`fact-card ${fact.status} ${fact.sourceOutdated ? 'outdated' : ''}`}>
      <div className="fact-card-head">
        <span className={`badge fact-kind kind-${fact.kind}`}>{FACT_KIND_LABELS[fact.kind]}</span>
        <span className={`badge fact-class class-${fact.factClass}`}>
          {FACT_CLASS_LABELS[fact.factClass]}
        </span>
        {fact.status === 'proposed' ? <span className="badge badge-warning">Proposed</span> : null}
        {fact.status === 'superseded' ? <span className="badge">Superseded</span> : null}
        {fact.status === 'rejected' ? <span className="badge">Rejected</span> : null}
      </div>
      <p>{fact.statement}</p>
      <div className="fact-meta">
        {fact.characterName ? <span>{fact.characterName}</span> : null}
        {fact.chapterOrder !== null ? (
          <span>
            From Chapter {fact.chapterOrder + 1}: {fact.chapterTitle}
          </span>
        ) : (
          <span>Authored directly</span>
        )}
        {fact.scopeChapterOrder !== null ? (
          <span>
            Scoped to Chapter {fact.scopeChapterOrder + 1}: {fact.scopeChapterTitle}
          </span>
        ) : fact.scopeChapterId === null ? (
          <span>Story-wide</span>
        ) : null}
        {fact.sourceOutdated ? (
          <span className="fact-outdated">Source text changed — review before relying on it.</span>
        ) : null}
        {fact.sourceRevisionId ? (
          <span title={fact.sourceRevisionId}>
            Source revision {fact.sourceRevisionId.slice(0, 8)}
          </span>
        ) : null}
      </div>
      <div className="row-actions">
        {actions}
      </div>
    </article>
  );
}

function defaultFactDraft(): FactInput {
  return {
    statement: '',
    kind: 'world',
    factClass: 'authored',
    characterId: null,
    scopeChapterId: null,
  };
}
