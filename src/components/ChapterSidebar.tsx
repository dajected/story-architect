import type { Chapter } from '@shared/types';
import { formatWords } from '../utils';
import { StatusDot } from './ui';

export function ChapterSidebar({
  chapters,
  selectedId,
  onSelect,
  open,
  onClose,
}: {
  chapters: Chapter[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  return (
    <>
      {open ? <div className="sidebar-scrim" onClick={onClose} /> : null}
      <aside className={`chapter-sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-head">
          <div>
            <p className="eyebrow">Manuscript</p>
            <h2>Chapters</h2>
          </div>
          <button className="icon-button sidebar-close" onClick={onClose} aria-label="Close chapters">
            ×
          </button>
        </div>
        <div className="chapter-list">
          {chapters.length === 0 ? (
            <p className="muted small sidebar-empty">
              Chapters appear here once you approve an outline.
            </p>
          ) : (
            chapters.map((chapter, index) => (
              <button
                key={chapter.id}
                className={`chapter-item ${selectedId === chapter.id ? 'selected' : ''}`}
                onClick={() => {
                  onSelect(chapter.id);
                  onClose();
                }}
              >
                <span className="chapter-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="chapter-item-copy">
                  <span className="chapter-item-title">{chapter.title}</span>
                  <span className="chapter-item-meta">
                    <StatusDot status={chapter.status} />
                    {chapter.wordCount > 0 ? `${formatWords(chapter.wordCount)} words` : 'No draft'}
                    {!chapter.briefApproved ? ' · brief pending' : ''}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        <div className="sidebar-foot">
          <span className="muted small">{formatWords(totalWords)} words in manuscript</span>
        </div>
      </aside>
    </>
  );
}
