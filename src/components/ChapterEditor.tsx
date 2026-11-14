import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChapterDetail,
  ChapterMemory,
  ChapterRevisionMeta,
  ContextPreset,
  GenerationJob,
  GenerationSettings,
  Project,
} from '@shared/types';
import { CONTEXT_PRESETS } from '@shared/types';
import { countWords } from '@shared/utils';
import { api, type ContextInfo } from '../api';
import { useJobStream } from '../hooks';
import { errorText, formatDate, formatWords } from '../utils';
import { ContextInspector } from './ContextInspector';
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
}: {
  project: Project;
  chapter: ChapterDetail;
  settings: GenerationSettings;
  onChapterUpdated: (chapter: ChapterDetail) => void;
  onRefreshChapter: () => Promise<void>;
  onOpenOutline: () => void;
  onOpenMemory: () => void;
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
  const streamRef = useRef<HTMLDivElement | null>(null);
  const initialRevisionRef = useRef(chapter.currentRevisionId);
  const contentRef = useRef(content);
  const savedRef = useRef(savedContent);
  contentRef.current = content;
  savedRef.current = savedContent;
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [saveNonce, setSaveNonce] = useState(0);

  const localWords = useMemo(() => countWords(content), [content]);

  useEffect(() => {
    if (chapter.currentRevisionId !== initialRevisionRef.current) {
      initialRevisionRef.current = chapter.currentRevisionId;
      // An external revision (generation, restore, insert) should replace the editor only
      // when there are no local edits waiting to save.
      if (contentRef.current === savedRef.current) {
        setContent(chapter.content);
        setSavedContent(chapter.content);
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

  const refreshMemory = () => {
    api
      .getChapterMemory(chapter.id)
      .then((result) => setMemory(result.memory))
      .catch(() => undefined);
  };

  useEffect(() => {
    refreshMemory();
    // Memory status is per chapter; reload when the editor switches chapters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

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
    refreshMemory();
    if (job.status === 'completed') {
      // A summary may have been queued automatically after this draft.
      window.setTimeout(refreshMemory, 5000);
      window.setTimeout(refreshMemory, 20000);
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
          <div className="editor-meta">
            <span>{formatWords(localWords)} words</span>
            <span>
              {chapter.briefApproved ? 'Brief approved' : 'Brief awaiting approval'}
            </span>
            <span>Target {formatWords(settings.targetWords ?? project.targetChapterWords ?? 1800)} words</span>
            {saving ? <span className="muted">Saving…</span> : null}
            {!saving && savedAt && savedContent === content ? (
              <span className="muted">Saved {formatDate(savedAt)}</span>
            ) : null}
            {!saving && savedContent !== content ? <span className="muted">Unsaved changes</span> : null}
          </div>
        </div>
        <div className="editor-actions">
          <button className="button button-ghost button-small" onClick={onOpenOutline}>
            Edit outline
          </button>
          <button className="button button-ghost button-small" onClick={onOpenMemory}>
            Continuity
          </button>
          <button className="button button-ghost button-small" onClick={() => setHistoryOpen(true)}>
            History
          </button>
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

      <div className="brief-card">
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
              Memory: {memoryLabel(memory.status)}
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
      </div>

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

      <div className="editor-toolbar">
        <div className="segmented">
          <button className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}>
            Write
          </button>
          <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>
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
            className="manuscript-textarea"
            value={content}
            onChange={(event) => setContent(event.target.value)}
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
