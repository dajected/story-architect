import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [query, setQuery] = useState('');
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return chapters;
    return chapters.filter(
      (chapter) =>
        chapter.title.toLowerCase().includes(search) ||
        chapter.brief.toLowerCase().includes(search),
    );
  }, [chapters, query]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, filtered.length]);

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

        {chapters.length > 6 ? (
          <input
            className="sidebar-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
            }}
            placeholder="Find a chapter"
            aria-label="Find a chapter"
          />
        ) : null}

        <div className="chapter-list">
          {chapters.length === 0 ? (
            <p className="muted small sidebar-empty">
              Chapters appear here once you approve an outline.
            </p>
          ) : filtered.length === 0 ? (
            <p className="muted small sidebar-empty">No chapters match “{query}”.</p>
          ) : (
            filtered.map((chapter) => {
              const index = chapters.indexOf(chapter);
              return (
                <button
                  key={chapter.id}
                  ref={selectedId === chapter.id ? selectedRef : null}
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
              );
            })
          )}
        </div>

        <div className="sidebar-foot">
          <span className="muted small">
            {query.trim()
              ? `${filtered.length} of ${chapters.length} chapters`
              : `${formatWords(totalWords)} words in manuscript`}
          </span>
        </div>
      </aside>
    </>
  );
}
