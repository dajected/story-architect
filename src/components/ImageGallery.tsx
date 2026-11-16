import { ActionMenu } from './ActionMenu';
import { formatChapterLabel } from '../utils';
import { useEffect, useState } from 'react';
import type { Character, Chapter, ImageAsset } from '@shared/types';
import { api } from '../api';
import { errorText, formatDate } from '../utils';
import { Banner, confirmAction } from './ui';
import { ImageViewer } from './ImageViewer';

export function ImageGallery({assets, characters, chapters = [], onChanged, onRegenerate, initialViewId = null, viewerOnly = false, onCloseView}: {
  initialViewId?: string | null;
  viewerOnly?: boolean;
  onCloseView?: () => void;
  assets: ImageAsset[]; characters: Character[]; chapters?: Pick<Chapter, 'id' | 'title' | 'orderIndex'>[];
  onChanged: () => void | Promise<unknown>; onRegenerate?: (asset: ImageAsset) => void;
}) {
  const [viewId, setViewId] = useState<string | null>(initialViewId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const index = assets.findIndex(a => a.id === viewId);
  const viewed = assets[index];
  useEffect(() => {setViewId(initialViewId);}, [initialViewId]);
  const name = (asset: ImageAsset) => characters.find(c => c.id === asset.characterId)?.name ?? 'Character';
  const chapter = (asset: ImageAsset) => chapters.find(c => c.id === asset.chapterId);
  const chapterLabel = (asset: ImageAsset) => {
    const match = chapter(asset);
    return match ? formatChapterLabel(match.title, match.orderIndex) : asset.chapterId ? 'Chapter image' : 'Reference portrait';
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try {await action(); await onChanged();} catch(err) {setError(errorText(err));} finally {setBusy(false);}
  };
  const actions = (asset: ImageAsset, compact = false) => {
    const primary = <>
      {asset.chapterId ? <button className="button button-small" disabled={busy || asset.selectedForChapter} onClick={() => void run(() => api.selectChapterImage(asset.chapterId!, asset.id))}>{asset.selectedForChapter ? '✓ Chapter image' : 'Use for this chapter'}</button> : null}
      {onRegenerate ? <button className="button button-small" onClick={() => onRegenerate(asset)}>Regenerate / customize</button> : null}
    </>;
    const overflow = <>
      <button className="button button-small" disabled={busy || characters.find(c => c.id === asset.characterId)?.portraitAssetId === asset.id} onClick={() => void run(async () => {if (await confirmAction(`Use this image as ${name(asset)}’s main character portrait throughout the project? Chapter selections stay unchanged.`)) await api.setCharacterPortrait(asset.characterId, asset.id);})}>Set as main character portrait</button>
      <a className="button button-small" href={`${asset.url}?download=1`} download>Download</a>
      <button className="button button-danger-ghost button-small" disabled={busy} onClick={() => void run(async () => {if (await confirmAction(`Delete this image of ${name(asset)}? The saved file and any selection of it will be removed.`)) {await api.deleteImageAsset(asset.id); setViewId(null);}})}>Delete image</button>
    </>;
    if (!compact) return <div className="row-actions">{primary}{overflow}</div>;
    return <div className="row-actions">
      <ActionMenu className="image-card-menu" buttonClassName="button button-ghost button-small" label="Image options">{primary}{overflow}</ActionMenu>
    </div>;
  };
  const sourceDetails = (asset: ImageAsset, compact = false) => <details className={compact ? "small gallery-source" : "small"}><summary>Prompt and source</summary><p>{asset.prompt}</p><p>{formatDate(asset.createdAt)} · {asset.settings.moment ?? 'end'} · {asset.settings.sourceRevisionId ? `Source revision ${asset.settings.sourceRevisionId.slice(0, 8)}` : 'Source revision unknown'}</p></details>;
  return <>
    {error ? <Banner tone="danger">{error}</Banner> : null}
    {!viewerOnly ? <div className="image-gallery">{assets.map(asset => <figure className="image-card" key={asset.id}>
      <button className="image-card-image image-open" onClick={() => setViewId(asset.id)} aria-label={`View image of ${name(asset)}`}><img src={asset.url} alt={`${name(asset)}${chapter(asset) ? ` — ${chapterLabel(asset)}` : ''}`} loading="lazy" /></button>
      <figcaption><strong>{name(asset)}</strong><span className="muted small">{chapterLabel(asset)}</span>
      <div className="row-actions">{asset.selectedForChapter ? <span className="badge badge-accent">Selected chapter image</span> : null}{asset.sourceOutdated ? <span className="badge badge-warning">Earlier draft · Review</span> : null}</div>
      {sourceDetails(asset, true)}{actions(asset, true)}</figcaption>
    </figure>)}</div> : null}
    {viewed ? <ImageViewer open title={`${name(viewed)} — ${chapterLabel(viewed)}`} url={viewed.url} alt={`Full image of ${name(viewed)}`} index={index} count={assets.length} onNavigate={next => setViewId(assets[next]!.id)} onClose={() => {setViewId(null); onCloseView?.();}} actions={<>{error ? <Banner tone="danger">{error}</Banner> : null}{actions(viewed)}{sourceDetails(viewed)}</>} /> : null}
  </>;
}
