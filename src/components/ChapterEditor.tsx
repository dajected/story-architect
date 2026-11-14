import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChapterDetail,
  ChapterMemory,
  ChapterRevisionMeta,
  ContextPreset,
  GenerationJob,
  GenerationSettings,
  Project,
  ProseInstruction,
  RewriteAction,
} from '@shared/types';
import { CONTEXT_PRESETS, REWRITE_ACTION_LABELS } from '@shared/types';
import { countWords } from '@shared/utils';
import { api, type ContextInfo } from '../api';
import { useJobStream } from '../hooks';
import { errorText, formatDate, formatWords } from '../utils';
import { ContextInspector } from './ContextInspector';
import { ChapterPortraits } from './ChapterPortraits';
import { ContinuityReview } from './ContinuityReview';
import { Markdown } from './Markdown';
import { RevisionHistory } from './RevisionHistory';
import { Banner, Modal, Spinner } from './ui';

export function ChapterEditor({
  project,
  chapter,
  settings,
  onChapterUpdated,
  onRefreshChapter,
  onOpenOutline,
  onOpenMemory,
  onNavigate,
  canNavigatePrevious,
  canNavigateNext,
}: {
  project: Project;
  chapter: ChapterDetail;
  settings: GenerationSettings;
  onChapterUpdated: (chapter: ChapterDetail) => void;
  onRefreshChapter: () => Promise<void>;
  onOpenOutline: () => void;
  onOpenMemory: () => void;
  onNavigate?: (direction: 'previous' | 'next') => void;
  canNavigatePrevious?: boolean;
  canNavigateNext?: boolean;
}) {
  const [content, setContent] = useState(chapter.content);
  const [savedContent, setSavedContent] = useState(chapter.content);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [preset, setPreset] = useState<ContextPreset>(settings.contextPreset);
  const [targetWords, setTargetWords] = useState(
    String(settings.targetWords ?? project.targetChapterWords ?? 1800),
  );
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [memory, setMemory] = useState<ChapterMemory | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [alternativeRevisionId, setAlternativeRevisionId] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  const [previewRevision, setPreviewRevision] = useState<ChapterRevisionMeta | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number; text: string } | null>(
    null,
  );
  const [rewriteInstruction, setRewriteInstruction] = useState('');
  const [proposal, setProposal] = useState('');
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyingRewrite, setApplyingRewrite] = useState(false);
  const [savedInstructions, setSavedInstructions] = useState<ProseInstruction[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [imageCount, setImageCount] = useState(0);
  useEffect(() => {const handler = (event: Event) => setImageCount((event as CustomEvent<number>).detail); window.addEventListener('chapter-image-count',handler);return () => window.removeEventListener('chapter-image-count',handler);}, []);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {const handler = () => setMode(current => current === 'write' ? 'preview' : 'write'); window.addEventListener('toggle-manuscript-preview', handler); return () => window.removeEventListener('toggle-manuscript-preview',handler);}, []);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const initialRevisionRef = useRef(chapter.currentRevisionId);
  const contentRef = useRef(content);
  const savedRef = useRef(savedContent);
  contentRef.current = content;
  savedRef.current = savedContent;
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [saveNonce, setSaveNonce] = useState(0);
  const memoryRefreshTimer = useRef<number | null>(null);

  // Keep the live word count deferred so a long chapter never blocks typing.
  const deferredContent = useDeferredValue(content);
  const localWords = useMemo(() => countWords(deferredContent), [deferredContent]);

  useEffect(() => {
    if (chapter.currentRevisionId !== initialRevisionRef.current) {
      initialRevisionRef.current = chapter.currentRevisionId;
      // An external revision (generation, restore, insert) should replace the editor only
      // when there are no local edits waiting to save.
      if (contentRef.current === savedRef.current) {
        setContent(chapter.content);
        setSavedContent(chapter.content);
        setSelection(null);
      }
    }
  }, [chapter.currentRevisionId, chapter.content]);

  useEffect(() => {
    if (content === savedContent) return;
    const timer = window.setTimeout(() => {
      const snapshot = contentRef.current;
      if (snapshot === savedRef.current) return;
      saveChainRef.current = saveChainRef.current.then(async () => {
        if (snapshot === savedRef.current) return;
        setSaving(true);
        setSaveError(null);
        try {
          const updated = await api.saveChapterContent(chapter.id, snapshot);
          savedRef.current = snapshot;
          setSavedContent(snapshot);
          setSavedAt(new Date().toISOString());
          onChapterUpdated(updated);
          refreshMemory();
        } catch (err) {
          setSaveError(errorText(err));
        } finally {
          setSaving(false);
        }
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [content, savedContent, chapter.id, onChapterUpdated, saveNonce]);

  useEffect(() => {
    return () => {
      if (contentRef.current !== savedRef.current) {
        void api.saveChapterContent(chapter.id, contentRef.current).catch(() => undefined);
      }
    };
  }, [chapter.id]);

  // Autosave fires often. Coalesce the derived memory refresh into one trailing
  // read so a long typing session stays responsive but stale status still updates.
  const refreshMemory = (force = false) => {
    if (memoryRefreshTimer.current !== null) {
      window.clearTimeout(memoryRefreshTimer.current);
      memoryRefreshTimer.current = null;
    }
    const run = () => {
      api
        .getChapterMemory(chapter.id)
        .then((result) => setMemory(result.memory))
        .catch(() => undefined);
    };
    if (force) {
      run();
      return;
    }
    memoryRefreshTimer.current = window.setTimeout(() => {
      memoryRefreshTimer.current = null;
      run();
    }, 3000);
  };

  useEffect(() => {
    refreshMemory(true);
    // Memory status is per chapter; reload when the editor switches chapters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  useEffect(() => {
    return () => {
      if (memoryRefreshTimer.current !== null) {
        window.clearTimeout(memoryRefreshTimer.current);
        memoryRefreshTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!showGenerate) return;
    let cancelled = false;
    setContextError(null);
    api
      .getContextInfo(chapter.id, preset)
      .then((info) => {
        if (!cancelled) setContextInfo(info);
      })
      .catch((err) => {
        if (!cancelled) setContextError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [showGenerate, chapter.id, preset]);

  const finishedRef = useRef<(job: GenerationJob) => void>(() => {});
  const stream = useJobStream((job) => finishedRef.current(job));
  const rewriteStream = useJobStream((job) => {
    if (job.status === 'completed') setProposal(job.output.trim());
  });
  const reviewStream = useJobStream();

  useEffect(() => {
    api
      .listProseInstructions(project.id)
      .then(setSavedInstructions)
      .catch(() => setSavedInstructions([]));
  }, [project.id]);

  useEffect(() => {
    if (chapter.latestJob && chapter.latestJob.status === 'running') {
      stream.attach(chapter.latestJob);
    }
    // Only resume a job that was already running when this chapter was opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  useEffect(() => {
    if (stream.output && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [stream.output]);

  const refreshAfterJob = async (job: GenerationJob) => {
    try {
      const detail = await api.getChapter(chapter.id);
      onChapterUpdated(detail);
      if (job.status === 'completed' && job.revisionId) {
        if (detail.currentRevisionId === job.revisionId) {
          setContent(detail.content);
          setSavedContent(detail.content);
          setAlternativeRevisionId(null);
        } else {
          setAlternativeRevisionId(job.revisionId);
        }
      }
    } catch {
      await onRefreshChapter();
    }
    refreshMemory(true);
    if (job.status === 'completed') {
      // A summary may have been queued automatically after this draft.
      window.setTimeout(() => refreshMemory(true), 5000);
      window.setTimeout(() => refreshMemory(true), 20000);
    }
  };

  useEffect(() => {
    finishedRef.current = (job: GenerationJob) => {
      if (job.kind !== 'chapter') return;
      setStopping(false);
      void refreshAfterJob(job);
    };
  });

  const startGeneration = async () => {
    setGenerateError(null);
    try {
      const words = targetWords.trim() ? Number(targetWords) : null;
      const job = await api.generateChapter(chapter.id, {
        instructions: instructions.trim() || undefined,
        contextPreset: preset,
        targetWords: words && Number.isFinite(words) ? Math.round(words) : null,
      });
      setStopping(false);
      setAlternativeRevisionId(null);
      setRecoveryNotice(null);
      stream.attach(job);
      setShowGenerate(true);
    } catch (err) {
      setGenerateError(errorText(err));
    }
  };

  const stop = async () => {
    if (!stream.job) return;
    setStopping(true);
    try {
      await api.cancelJob(stream.job.id);
    } catch (err) {
      setGenerateError(errorText(err));
      setStopping(false);
    }
  };

  const captureSelection = () => {
    const element = textareaRef.current;
    if (!element) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (end > start) {
      setSelection({ start, end, text: content.slice(start, end) });
    }
  };

  const startRewrite = async (action: RewriteAction) => {
    if (!selection) return;
    setApplyError(null);
    setProposal('');
    try {
      const job = await api.rewriteChapter(chapter.id, {
        action,
        selection: selection.text,
        start: selection.start,
        end: selection.end,
        instruction: rewriteInstruction.trim() || undefined,
      });
      rewriteStream.attach(job);
    } catch (err) {
      setGenerateError(errorText(err));
    }
  };

  const applyProposal = async () => {
    if (!rewriteStream.job || !proposal.trim()) return;
    setApplyingRewrite(true);
    setApplyError(null);
    try {
      const result = await api.applyRewrite(rewriteStream.job.id, proposal);
      initialRevisionRef.current = result.chapter.currentRevisionId;
      onChapterUpdated(result.chapter);
      setContent(result.chapter.content);
      setSavedContent(result.chapter.content);
      setSelection(null);
      setProposal('');
      rewriteStream.reset();
      setRecoveryNotice(
        'Rewrite applied as a new revision. The previous text is in History, and this chapter’s summary is now stale.',
      );
      refreshMemory(true);
    } catch (err) {
      setApplyError(errorText(err));
    } finally {
      setApplyingRewrite(false);
    }
  };

  const dismissRewrite = () => {
    rewriteStream.reset();
    setProposal('');
    setApplyError(null);
  };

  const startReview = async () => {
    setReviewOpen(true);
    setReviewError(null);
    if (reviewStream.running) return;
    try {
      const job = await api.reviewChapter(chapter.id);
      reviewStream.attach(job);
    } catch (err) {
      setReviewError(errorText(err));
    }
  };

  const recoverPartial = async (job: GenerationJob) => {
    setRecBusy(true);
    setGenerateError(null);
    try {
      const result = await api.applyPartialJob(job.id);
      onChapterUpdated(result.chapter);
      setRecoveryNotice(
        result.applied
          ? 'The partial draft is now the current chapter text.'
          : 'The partial draft was saved as a new version. Existing text is untouched.',
      );
      if (result.applied) {
        setContent(result.chapter.content);
        setSavedContent(result.chapter.content);
      } else {
        setAlternativeRevisionId(result.revisionId);
      }
    } catch (err) {
      setGenerateError(errorText(err));
    } finally {
      setRecBusy(false);
    }
  };

  const openAlternative = async (revisionId: string) => {
    try {
      const detail = await api.useRevision(revisionId);
      initialRevisionRef.current = detail.currentRevisionId;
      onChapterUpdated(detail);
      setContent(detail.content);
      setSavedContent(detail.content);
      setAlternativeRevisionId(null);
      setRecoveryNotice('The generated draft is now the current text.');
    } catch (err) {
      setGenerateError(errorText(err));
    }
  };

  const openPreview = async (revision: ChapterRevisionMeta) => {
    setPreviewRevision(revision);
    setPreviewContent(null);
    try {
      const full = await api.getRevision(revision.id);
      setPreviewContent(full.content);
    } catch (err) {
      setGenerateError(errorText(err));
    }
  };

  const latestAlternative = chapter.latestJob?.revisionId
    ? chapter.latestJob.revisionId
    : alternativeRevisionId;
  const alternative =
    latestAlternative && latestAlternative !== chapter.currentRevisionId
      ? chapter.revisions.find((revision) => revision.id === latestAlternative)
      : undefined;

  const recoverable =
    chapter.latestJob &&
    !chapter.latestJob.revisionId &&
    ['failed', 'cancelled', 'interrupted'].includes(chapter.latestJob.status) &&
    chapter.latestJob.output.trim().length > 0
      ? chapter.latestJob
      : null;

  const activeJob = stream.running ? stream.job : null;
  const finishedJob = !stream.running && stream.job ? stream.job : null;

  return (
    <div className="chapter-editor">
      <header className="editor-header">
        <div className="editor-title">
          <span className="eyebrow">Chapter {chapter.orderIndex + 1}</span>
          <h1>{chapter.title}</h1>
          <div className="editor-meta" role="status" aria-live="polite">
            <span>{formatWords(localWords)} words</span>
            <span>
              {chapter.briefApproved ? 'Brief approved' : 'Brief awaiting approval'}
            </span>
            <span>Target {formatWords(settings.targetWords ?? project.targetChapterWords ?? 1800)} words</span>
            {saving ? <span className="muted">Saving…</span> : null}
            {!saving && savedAt && savedContent === content ? (
              <span className="muted">Saved {formatDate(savedAt)}</span>
            ) : null}
            {!saving && !savedAt && savedContent === content ? <span className="muted">All changes saved</span> : null}
            {!saving && savedContent !== content ? <span className="muted">Unsaved changes</span> : null}
          </div>
        </div>
        <div className="editor-actions">
          <button className="button button-small" aria-label="Chapter images" onClick={() => window.dispatchEvent(new Event('open-chapter-images'))}>Chapter images · {imageCount}</button>
          <details className="action-menu"><summary className="button button-small">Chapter tools</summary><div className="action-menu-content">
          {onNavigate ? (
            <>
              <button
                className="button button-ghost button-small chapter-step"
                onClick={() => onNavigate('previous')}
                disabled={!canNavigatePrevious}
                title="Previous chapter"
              >
                ← Previous
              </button>
              <button
                className="button button-ghost button-small chapter-step"
                onClick={() => onNavigate('next')}
                disabled={!canNavigateNext}
                title="Next chapter"
              >
                Next →
              </button>
            </>
          ) : null}
          <button className="button button-ghost button-small" onClick={onOpenOutline}>
            Edit outline
          </button>
          <button className="button button-ghost button-small" onClick={onOpenMemory}>
            Continuity
          </button>
          <button className="button button-ghost button-small" onClick={() => void startReview()}>
            Review continuity
          </button>
          <button className="button button-ghost button-small" onClick={() => setHistoryOpen(true)}>
            History
          </button>
          </div></details>
          <button className="button button-primary button-small" onClick={() => setShowGenerate((open) => !open)}>
            {showGenerate ? 'Hide generation' : 'Generate chapter'}
          </button>
        </div>
      </header>

      {saveError ? (
        <Banner
          tone="danger"
          actions={
            <button
              className="button button-small"
              onClick={() => {
                setSaveError(null);
                setSaveNonce((value) => value + 1);
              }}
            >
              Retry
            </button>
          }
        >
          Could not save: {saveError}
        </Banner>
      ) : null}
      {recoveryNotice ? <Banner tone="success">{recoveryNotice}</Banner> : null}

      {recoverable ? (
        <Banner
          tone="warning"
          title="Recoverable partial draft"
          actions={
            <button className="button button-small" onClick={() => recoverPartial(recoverable)} disabled={recBusy}>
              {recBusy ? <Spinner /> : null}
              Recover {formatWords(countWords(recoverable.output))} words
            </button>
          }
        >
          The last {recoverable.status === 'interrupted' ? 'interrupted' : recoverable.status}{' '}
          generation left partial text. Existing chapter text was not changed.
        </Banner>
      ) : null}

      {alternative ? (
        <Banner
          tone="info"
          title={`Generated draft v${alternative.version} is not current`}
          actions={
            <>
              <button className="button button-small" onClick={() => openAlternative(alternative.id)}>
                Use generated draft
              </button>
              <button className="button button-ghost button-small" onClick={() => openPreview(alternative)}>
                Preview
              </button>
              <button className="button button-ghost button-small" onClick={() => setHistoryOpen(true)}>
                History
              </button>
            </>
          }
        >
          Generated text is saved in history. Your current prose was left untouched.
        </Banner>
      ) : null}

      <details className="brief-card"><summary>Chapter brief and continuity</summary>
        <div className="brief-card-head">
          <span className="eyebrow">Chapter brief</span>
          <span className={`badge ${chapter.briefApproved ? 'badge-success' : 'badge-warning'}`}>
            {chapter.briefApproved ? 'Approved' : 'Needs approval'}
          </span>
        </div>
        <p>{chapter.brief || 'No brief has been written for this chapter yet.'}</p>
        {memory ? (
          <div className="brief-memory">
            <span className={`badge ${memoryBadgeClass(memory.status)}`}>
              Continuity: {memoryLabel(memory.status)}
            </span>
            {memory.summary ? (
              <span className="muted small">{clampSummary(memory.summary)}</span>
            ) : (
              <span className="muted small">
                No summary yet. The memory model builds one after this chapter becomes current.
              </span>
            )}
            <button className="button button-ghost button-small" onClick={onOpenMemory}>
              Review
            </button>
          </div>
        ) : null}
      </details>

      <ChapterPortraits project={project} chapterId={chapter.id} revisionKey={`${chapter.currentRevisionId}:${chapter.updatedAt}`} />

      {showGenerate ? (
        <section className="generate-panel">
          <div className="generate-grid">
            <div className="field">
              <label htmlFor="chapter-instructions">Additional instructions</label>
              <textarea
                id="chapter-instructions"
                rows={3}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Optional: focus this scene on the argument at the dinner table, keep the storm offstage…"
              />
              {savedInstructions.length > 0 ? (
                <select
                  className="saved-instruction-picker"
                  value=""
                  onChange={(event) => {
                    const found = savedInstructions.find((entry) => entry.id === event.target.value);
                    if (!found) return;
                    setInstructions((current) =>
                      current.trim() ? `${current.trimEnd()}\n${found.text}` : found.text,
                    );
                  }}
                >
                  <option value="">Add a saved instruction…</option>
                  {savedInstructions.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <div className="generate-side">
              <div className="field">
                <label htmlFor="chapter-preset">Context preset</label>
                <select
                  id="chapter-preset"
                  value={preset}
                  onChange={(event) => setPreset(event.target.value as ContextPreset)}
                >
                  {CONTEXT_PRESETS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label} — {entry.budgetTokens.toLocaleString()} tokens
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="chapter-target">Target words</label>
                <input
                  id="chapter-target"
                  type="number"
                  min={100}
                  max={20000}
                  step={100}
                  value={targetWords}
                  onChange={(event) => setTargetWords(event.target.value)}
                />
              </div>
            </div>
          </div>

          {contextInfo ? (
            <ContextInspector info={contextInfo} />
          ) : (
            <p className="context-note">Estimating the context…</p>
          )}
          {contextError ? <p className="field-hint error-text">{contextError}</p> : null}
          <p className="field-hint">
            Context is assembled from required project instructions, derived story memory, and
            preceding prose within the preset budget. Outdated summaries are labelled rather than
            dropped, and proposed facts are excluded until you accept them.
          </p>

          {generateError ? (
            <Banner
              tone="danger"
              actions={
                <a className="button button-small" href="/settings">
                  Settings
                </a>
              }
            >
              {generateError}
            </Banner>
          ) : null}

          <div className="form-actions inline">
            <button
              className="button button-primary"
              onClick={startGeneration}
              disabled={stream.running || !chapter.briefApproved}
            >
              {stream.running ? <Spinner /> : null}
              {stream.running ? 'Generating…' : 'Generate draft'}
            </button>
            {stream.running ? (
              <button className="button button-danger-ghost" onClick={stop} disabled={stopping}>
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            ) : null}
            <span className="muted small">{presetDescription(preset)}</span>
          </div>

          {stream.job ? (
            <div className={`stream-panel ${stream.running ? 'running' : ''}`}>
              <div className="stream-head">
                <span className="badge">{stream.job.model}</span>
                <span className="muted small">
                  {stream.running
                    ? 'Streaming from the provider…'
                    : finishedJob
                      ? `Generation ${finishedJob.status}`
                      : ''}
                </span>
                <span className="muted small">{formatWords(countWords(stream.output))} words</span>
                {!stream.running ? (
                  <button
                    className="button button-ghost button-small stream-dismiss"
                    onClick={() => stream.reset()}
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
              {finishedJob?.error ? <Banner tone="danger">{finishedJob.error}</Banner> : null}
              <div className="stream-output" ref={streamRef}>
                {stream.output || (stream.running ? 'Waiting for the first tokens…' : 'No output.')}
              </div>
              {finishedJob?.status === 'completed' && finishedJob.revisionId ? (
                <div className="stream-foot">
                  <span className="muted small">
                    Draft saved as a revision. Review it in History before replacing current text.
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {mode === 'write' && selection ? (
        <section className="selection-tools">
          <div className="selection-head">
            <span className="eyebrow">Selected passage</span>
            <span className="muted small">
              {formatWords(countWords(selection.text))} words
            </span>
            <button
              className="button button-ghost button-small selection-clear"
              onClick={() => setSelection(null)}
            >
              Clear selection
            </button>
          </div>
          <div className="selection-controls">
            <input
              value={rewriteInstruction}
              onChange={(event) => setRewriteInstruction(event.target.value)}
              placeholder="Optional focus or style note, e.g. colder, more clipped, keep the image of the door."
              aria-label="Rewrite instruction"
            />
            {savedInstructions.length > 0 ? (
              <select
                value=""
                onChange={(event) => {
                  const found = savedInstructions.find((entry) => entry.id === event.target.value);
                  if (found) setRewriteInstruction(found.text);
                }}
                aria-label="Use a saved instruction"
              >
                <option value="">Use a saved instruction…</option>
                {savedInstructions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="selection-actions">
            {(['rewrite', 'expand', 'shorten', 'style'] as RewriteAction[]).map((action) => (
              <button
                key={action}
                className="button button-small"
                onClick={() => void startRewrite(action)}
                disabled={rewriteStream.running}
              >
                {REWRITE_ACTION_LABELS[action]}
              </button>
            ))}
            <span className="muted small">
              The model proposes a replacement. Nothing changes until you apply it.
            </span>
          </div>
        </section>
      ) : null}

      {rewriteStream.job ? (
        <section className="rewrite-panel">
          <div className="stream-head">
            <span className="eyebrow">Rewrite proposal</span>
            <span className="badge">{rewriteStream.job.model}</span>
            <span className="muted small">
              {rewriteStream.running
                ? 'Streaming the revised passage…'
                : rewriteStream.job.status === 'completed'
                  ? `Proposal ready · ${formatWords(countWords(proposal))} words`
                  : `Rewrite ${rewriteStream.job.status}`}
            </span>
            {!rewriteStream.running ? (
              <button
                className="button button-ghost button-small stream-dismiss"
                onClick={dismissRewrite}
              >
                Discard
              </button>
            ) : null}
          </div>
          {rewriteStream.job.error ? (
            <Banner tone="danger">{rewriteStream.job.error}</Banner>
          ) : null}
          {rewriteStream.job.status === 'completed' ? (
            <textarea
              className="rewrite-proposal"
              value={proposal}
              onChange={(event) => setProposal(event.target.value)}
              spellCheck
              aria-label="Proposed replacement text"
            />
          ) : (
            <div className="stream-output">
              {rewriteStream.output || (rewriteStream.running ? 'Waiting for the first tokens…' : 'No output.')}
            </div>
          )}
          {applyError ? <Banner tone="danger">{applyError}</Banner> : null}
          <div className="rewrite-foot">
            <span className="muted small">
              {content !== savedContent
                ? 'Waiting for the chapter to finish saving before this rewrite can be applied.'
                : 'Applying replaces the selected passage and creates a new revision. The chapter summary is marked stale; later prose is never rewritten.'}
            </span>
            <button
              className="button button-primary button-small"
              onClick={() => void applyProposal()}
              disabled={
                rewriteStream.running ||
                rewriteStream.job.status !== 'completed' ||
                !proposal.trim() ||
                applyingRewrite ||
                content !== savedContent
              }
            >
              {applyingRewrite ? <Spinner /> : null}
              Apply rewrite
            </button>
          </div>
        </section>
      ) : null}

      {reviewOpen ? (
        <section className="review-panel">
          <div className="stream-head">
            <span className="eyebrow">Continuity review</span>
            <span className="badge">{reviewStream.job?.model ?? 'memory role'}</span>
            <span className="muted small">
              {reviewStream.running
                ? 'Checking the chapter against accepted memory…'
                : reviewStream.job
                  ? `Review ${reviewStream.job.status}`
                  : 'Starting…'}
            </span>
            {!reviewStream.running ? (
              <button
                className="button button-ghost button-small stream-dismiss"
                onClick={() => {
                  reviewStream.reset();
                  setReviewOpen(false);
                }}
              >
                Close
              </button>
            ) : null}
          </div>
          {reviewError ? <Banner tone="danger">{reviewError}</Banner> : null}
          {reviewStream.job?.error ? (
            <Banner tone="danger">{reviewStream.job.error}</Banner>
          ) : null}
          <div className="stream-output">
            {reviewStream.running ? (reviewStream.output || 'Waiting for the review…') : reviewStream.output ? <ContinuityReview key={reviewStream.job?.id} jobId={reviewStream.job?.id ?? chapter.id} report={reviewStream.output} content={content} onApply={async (passage,replacement) => {if (content !== savedContent || saving) throw new Error('Wait for the chapter to finish saving before applying a correction.');const updated=await api.applyReviewCorrection(chapter.id,{jobId:reviewStream.job!.id,expectedContent:content,passage,replacement});setContent(updated.content);setSavedContent(updated.content);contentRef.current=updated.content;savedRef.current=updated.content;onChapterUpdated(updated);refreshMemory(true);}} /> : 'No report yet.'}
          </div>
          <div className="stream-foot">
            <span className="muted small">
              Review each suggestion. Only Apply correction changes the manuscript and saves a new revision.
            </span>
          </div>
        </section>
      ) : null}

      <div className="editor-toolbar">
        <div className="segmented">
          <button aria-pressed={mode === 'write'} className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}>
            Write
          </button>
          <button aria-pressed={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>
            Preview
          </button>
        </div>
        <span className="muted small">
          Markdown accepted. Autosaves as you go.
        </span>
      </div>

      <div className="editor-surface">
        {mode === 'write' ? (
          <textarea
            ref={textareaRef}
            aria-label="Chapter manuscript"
            className="manuscript-textarea"
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setSelection(null);
            }}
            onSelect={captureSelection}
            placeholder="Begin the chapter, or generate a draft and edit it here."
            spellCheck
          />
        ) : (
          <div className="manuscript-preview">
            {content.trim() ? (
              <Markdown text={content} />
            ) : (
              <p className="muted">Nothing to preview yet.</p>
            )}
          </div>
        )}
      </div>

      <RevisionHistory
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        chapter={chapter}
        onChapterUpdated={(detail) => {
          initialRevisionRef.current = detail.currentRevisionId;
          setContent(detail.content);
          setSavedContent(detail.content);
          onChapterUpdated(detail);
        }}
      />

      <Modal
        open={previewRevision !== null}
        onClose={() => setPreviewRevision(null)}
        title={previewRevision ? `Version ${previewRevision.version} preview` : 'Draft preview'}
        subtitle={previewRevision ? formatDate(previewRevision.createdAt) : undefined}
        width="wide"
        footer={
          previewRevision ? (
            <div className="modal-actions">
              <button className="button button-ghost" onClick={() => setPreviewRevision(null)}>
                Close
              </button>
              <button
                className="button button-primary"
                onClick={() => {
                  void openAlternative(previewRevision.id);
                  setPreviewRevision(null);
                }}
              >
                Use as current
              </button>
            </div>
          ) : null
        }
      >
        <div className="revision-preview standalone">
          {previewContent === null ? (
            <Spinner label="Loading preview…" />
          ) : (
            <Markdown text={previewContent || '*(Empty revision.)*'} />
          )}
        </div>
      </Modal>
    </div>
  );
}

function presetDescription(preset: ContextPreset): string {
  return CONTEXT_PRESETS.find((entry) => entry.id === preset)?.description ?? '';
}

function memoryBadgeClass(status: ChapterMemory['status']): string {
  if (status === 'current') return 'badge-success';
  if (status === 'stale') return 'badge-warning';
  if (status === 'pending') return 'badge-accent';
  return '';
}

function memoryLabel(status: ChapterMemory['status']): string {
  if (status === 'current') return 'current';
  if (status === 'stale') return 'stale';
  if (status === 'pending') return 'rebuilding';
  if (status === 'empty') return 'no text';
  return 'not built';
}

function clampSummary(summary: string): string {
  const text = summary.replace(/\s+/g, ' ').trim();
  return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}
