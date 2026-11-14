import { confirmAction } from './ui';
import { useEffect, useState } from 'react';
import type { ChapterDetail, ChapterRevision } from '@shared/types';
import { api } from '../api';
import { errorText, formatDate, formatWords } from '../utils';
import { Markdown } from './Markdown';
import { Banner, Modal, Spinner } from './ui';

const SOURCE_LABELS: Record<string, string> = {
  generated: 'Generated',
  edited: 'Edited',
  restored: 'Restored',
  recovered: 'Recovered partial',
  imported: 'Imported',
};

export function RevisionHistory({
  open,
  onClose,
  chapter,
  onChapterUpdated,
}: {
  open: boolean;
  onClose: () => void;
  chapter: ChapterDetail;
  onChapterUpdated: (chapter: ChapterDetail) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState<ChapterRevision | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setSelectedId(chapter.currentRevisionId ?? chapter.revisions[0]?.id ?? null);
  }, [open, chapter.currentRevisionId, chapter.revisions]);

  useEffect(() => {
    if (!open || !selectedId) {
      setRevision(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getRevision(selectedId)
      .then((data) => {
        if (!cancelled) setRevision(data);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedId]);

  const selectedMeta = chapter.revisions.find((entry) => entry.id === selectedId);

  const useVersion = async () => {
    if (!revision) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.useRevision(revision.id);
      onChapterUpdated(updated);
      setNotice(`Version ${revision.version} is now the current text.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!revision) return;
    if (
      !await confirmAction(
        `Restore version ${revision.version} as a new revision? The current text stays in history.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.restoreRevision(revision.id);
      onChapterUpdated(result.chapter);
      setSelectedId(result.revision.id);
      setNotice(`Version ${revision.version} was restored as new version ${result.revision.version}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Revision history"
      subtitle={`Chapter ${chapter.orderIndex + 1}: ${chapter.title}`}
      width="wide"
    >
      <div className="revision-layout">
        <div className="revision-list">
          {chapter.revisions.map((entry) => (
            <button
              key={entry.id}
              className={`revision-item ${selectedId === entry.id ? 'selected' : ''}`}
              onClick={() => {
                setSelectedId(entry.id);
                setNotice(null);
              }}
            >
              <div className="revision-item-head">
                <strong>v{entry.version}</strong>
                {entry.id === chapter.currentRevisionId ? (
                  <span className="badge badge-accent">Current</span>
                ) : null}
                {entry.id === chapter.latestJob?.revisionId ? (
                  <span className="badge">Latest job</span>
                ) : null}
              </div>
              <span className="revision-source">{SOURCE_LABELS[entry.source] ?? entry.source}</span>
              <span className="muted small">
                {formatDate(entry.createdAt)} · {formatWords(entry.wordCount)} words
              </span>
            </button>
          ))}
        </div>

        <div className="revision-detail">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {notice ? <Banner tone="success">{notice}</Banner> : null}
          {selectedMeta ? (
            <div className="revision-detail-head">
              <div>
                <h3>
                  Version {selectedMeta.version}
                  <span className="badge">{SOURCE_LABELS[selectedMeta.source] ?? selectedMeta.source}</span>
                </h3>
                <p className="muted small">
                  {formatDate(selectedMeta.createdAt)} · {formatWords(selectedMeta.wordCount)} words
                  {selectedMeta.editable ? ' · editable working copy' : ' · preserved snapshot'}
                </p>
              </div>
              <div className="row-actions">
                {selectedMeta.id !== chapter.currentRevisionId ? (
                  <button className="button button-small" onClick={useVersion} disabled={busy}>
                    Use as current
                  </button>
                ) : null}
                <button className="button button-primary button-small" onClick={restore} disabled={busy}>
                  Restore as new revision
                </button>
              </div>
            </div>
          ) : null}
          <div className="revision-preview">
            {loading ? (
              <Spinner label="Loading preview…" />
            ) : revision ? (
              <Markdown text={revision.content || '*(This revision is empty.)*'} />
            ) : (
              <p className="muted">Select a revision to preview it.</p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
