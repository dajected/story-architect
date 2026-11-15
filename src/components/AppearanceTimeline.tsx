import { useState } from 'react';
import type { Chapter, Character, ImageAsset } from '@shared/types';
import { formatChapterLabel } from '../utils';
import { AppearanceNote, useCharacterAppearances } from './CharacterAppearanceNotes';
import { Banner, EmptyState, Modal, Spinner } from './ui';

export function AppearanceTimeline({ character, chapters, assets, active = true }: {
  character?: Character;
  chapters: Chapter[];
  assets: ImageAsset[];
  active?: boolean;
}) {
  const [showNotes, setShowNotes] = useState(false);
  const [viewed, setViewed] = useState<ImageAsset | null>(null);
  const { records, loading, error } = useCharacterAppearances(character?.id, active);
  if (!character) return <EmptyState title="Choose a character">Select a character to follow their appearance through the story.</EmptyState>;
  const ordered = [...chapters].sort((a, b) => a.orderIndex - b.orderIndex);
  const forChapter = (chapterId: string | null) => assets
    .filter(asset => asset.characterId === character.id && asset.chapterId === chapterId)
    .sort((a, b) => {
      const momentOrder = { start: 0, custom: 1, end: 2 };
      return momentOrder[a.settings.moment ?? 'end'] - momentOrder[b.settings.moment ?? 'end']
        || Number(b.selectedForChapter) - Number(a.selectedForChapter)
        || b.createdAt.localeCompare(a.createdAt);
    });
  const references = forChapter(null);
  const chapterImages = ordered.flatMap(chapter => forChapter(chapter.id));
  const sequence = [...references, ...chapterImages];
  const viewedIndex = sequence.findIndex(asset => asset.id === viewed?.id);
  const viewedChapter = chapters.find(chapter => chapter.id === viewed?.chapterId);
  const image = (asset: ImageAsset) => {
    const chapter = chapters.find(chapter => chapter.id === asset.chapterId);
    const label = chapter ? formatChapterLabel(chapter.title, chapter.orderIndex) : 'Reference portrait';
    return <figure className="timeline-image" key={asset.id}>
      <button className="image-open" onClick={() => setViewed(asset)} aria-label={`View ${character.name}, ${label}, ${asset.settings.moment ?? 'end'}`}>
        <img src={asset.url} alt={`${character.name} — ${asset.chapterId ? asset.settings.moment ?? 'end' : 'reference portrait'}`} loading="lazy" />
      </button>
      <figcaption><span>{asset.chapterId ? asset.settings.moment === 'start' ? 'Chapter start' : asset.settings.moment === 'custom' ? 'Custom moment' : 'Chapter end' : 'Reference portrait'}</span>
        {asset.selectedForChapter ? <span className="badge badge-accent">Selected</span> : null}
        {asset.sourceOutdated ? <span className="badge badge-warning">Earlier draft</span> : null}
      </figcaption>
    </figure>;
  };
  return <section className="appearance-timeline" aria-label={`${character.name} appearance timeline`}>
    <div className="images-gallery-heading">
      <div><h2>{character.name} — Appearance timeline</h2><p className="muted small">{chapterImages.length} chapter images · {ordered.length} chapters. Scroll across to follow the story.</p></div>
      <button className="button button-small" aria-pressed={showNotes} onClick={() => setShowNotes(current => !current)}>{showNotes ? 'Hide appearance notes' : 'Show appearance notes'}</button>
    </div>
    {showNotes && loading ? <Spinner label="Loading appearance notes…" /> : null}
    {showNotes && error ? <Banner tone="danger">{error}</Banner> : null}
    {!ordered.length && !references.length ? <EmptyState title="No chapters yet">Your existing chapter images will appear here in story order.</EmptyState> :
      <div className="appearance-timeline-scroll" tabIndex={0} role="region" aria-label="Chapter appearance sequence">
        <ol className="appearance-timeline-track">
          {references.length ? <li className="timeline-chapter"><header><p className="eyebrow">Before the story</p><h3>Reference portraits</h3></header>{references.map(image)}</li> : null}
          {ordered.map(chapter => {
            const images = forChapter(chapter.id);
            return <li className="timeline-chapter" key={chapter.id}>
              <header><p className="eyebrow">Chapter {chapter.orderIndex + 1}</p><h3>{formatChapterLabel(chapter.title, chapter.orderIndex)}</h3></header>
              {images.length ? images.map(image) : <div className="timeline-missing muted small">No image created for this chapter.</div>}
              {showNotes && !loading && !error ? <div><p className="eyebrow">End-of-chapter notes</p><AppearanceNote record={records.find(record => record.chapterId === chapter.id)} /></div> : null}
            </li>;
          })}
        </ol>
      </div>}
    <Modal open={Boolean(viewed)} title={`${character.name} — Timeline image`} onClose={() => setViewed(null)} width="wide"
      subtitle={viewedChapter ? `${formatChapterLabel(viewedChapter.title, viewedChapter.orderIndex)} · ${viewed?.settings.moment ?? 'end'}` : 'Reference portrait'}>
      {viewed ? <div className="stack"><div className="row-actions">
        <button className="button" disabled={viewedIndex <= 0} onClick={() => setViewed(sequence[viewedIndex - 1]!)}>Previous</button>
        <span>{viewedIndex + 1} / {sequence.length}</span>
        <button className="button" disabled={viewedIndex >= sequence.length - 1} onClick={() => setViewed(sequence[viewedIndex + 1]!)}>Next</button>
        <a className="button" href={`${viewed.url}?download=1`} download>Download</a>
      </div><div className="image-viewer"><img src={viewed.url} alt={`Full image of ${character.name}`} /></div></div> : null}
    </Modal>
  </section>;
}
