import { formatChapterLabel } from '../utils';
import { useCallback, useEffect, useState } from 'react';
import type { Chapter, Character, ImageAsset, PortraitBatch, Project } from '@shared/types';
import { api } from '../api';
import { errorText } from '../utils';
import { Banner, EmptyState, Spinner } from './ui';
import { ImageGallery } from './ImageGallery';
import { ImageStudio } from './ImageStudio';
import { AppearanceTimeline } from './AppearanceTimeline';

/**
 * Project-wide image browser. Cast cards deep-link here with `focus` to show
 * one character's appearance timeline across the chapters.
 */
export function ProjectImagesPanel({
  project,
  focus,
  active = true,
  onOpenCast,
  onOpenSettings,
}: {
  project: Project;
  focus?: { characterId: string; nonce: number } | null;
  active?: boolean;
  onOpenCast?: () => void;
  onOpenSettings: () => void;
}) {
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const firstChapter = [...chapters].sort((a, b) => a.orderIndex - b.orderIndex)[0];
  const [characterId, setCharacterId] = useState('');
  const [view, setView] = useState<'gallery' | 'timeline'>('gallery');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [batch, setBatch] = useState<PortraitBatch | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  useEffect(() => {
    if (!active || !characterId) { setBatch(null); return; }
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await api.getCharacterPortraitBatch(characterId);
        if (!cancelled) setBatch(next);
      } catch (err) { if (!cancelled) setError(errorText(err)); }
    };
    setBatch(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active, characterId]);
  const startBatch = async () => {
    setBatchBusy(true); setError(null); setNotice(null);
    try {
      const next = await api.startCharacterPortraitBatch(characterId, { skipExisting: true, selectForChapter: true });
      setBatch(next); setNotice(next.message ?? 'Chapter images queued.');
    } catch (err) { setError(errorText(err)); } finally { setBatchBusy(false); }
  };
  const cancelBatch = async () => {
    if (!batch) return;
    setBatchBusy(true); setError(null);
    try { setBatch(await api.cancelPortraitBatch(batch.id)); }
    catch (err) { setError(errorText(err)); } finally { setBatchBusy(false); }
  };
  const [notice, setNotice] = useState<string | null>(null);
  const createImage = async () => {
    if (!firstChapter) { setError('Approve the outline to create chapter 1 before generating an image.'); return; }
    setCreating(true); setError(null); setNotice(null);
    try { await api.startChapterPortrait(firstChapter.id, {characterId, moment: 'start'}); setNotice('Image generation started. See Activity for progress.'); } catch (err) { setError(errorText(err)); } finally { setCreating(false); }
  };
  const [studioCharacter, setStudioCharacter] = useState<Character | null>(null);
  const [studio, setStudio] = useState<ImageAsset | null>(null);
  const load = useCallback(async () => {
    try {const [images, cast, list] = await Promise.all([api.listProjectImages(project.id), api.listCharacters(project.id), api.listChapters(project.id)]); setAssets(images); setCharacters(cast.characters); setChapters(list); setError(null);} catch(err) {setError(errorText(err));} finally {setLoading(false);}
  }, [project.id]);
  useEffect(() => {if (active) void load();}, [active, load]);
  useEffect(() => { if (active && batch && batch.status !== 'running') void load(); }, [active, batch?.id, batch?.status, load]);
  useEffect(() => {
    if (!focus) return;
    setCharacterId(focus.characterId);
    setView('timeline');
  }, [focus]);
  const filtered = assets.filter(a => !characterId || a.characterId === characterId).sort((a,b) => characterId ? (chapters.find(c => c.id === a.chapterId)?.orderIndex ?? -1) - (chapters.find(c => c.id === b.chapterId)?.orderIndex ?? -1) : b.createdAt.localeCompare(a.createdAt));
  const selectedCharacter = characters.find(c => c.id === characterId);
  const running = batch?.status === 'running';
  const completed = batch?.items.filter(item => item.status === 'completed').length ?? 0;
  const characterField = <div className="images-fields">
    <label>Character<select value={characterId} onChange={e => setCharacterId(e.target.value)}><option value="">{view === 'timeline' ? 'Choose a character' : 'All characters'}</option>{characters.filter(c => c.status !== 'archived' || c.id === characterId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
  </div>;
  return <div className="stack images-page">
    <header className="images-header">
      <div><p className="eyebrow">Visual library</p><h1>Images</h1>{view === 'gallery' ? <p className="muted">Create and browse character images throughout your story.</p> : null}</div>
      <div className="row-actions">{onOpenCast ? <button className="button" onClick={onOpenCast}>Characters</button> : null}<button className="button" onClick={onOpenSettings}>Image settings</button></div>
    </header>
    <div className="image-view-toolbar"><div className="row-actions" role="group" aria-label="Image view">
      <button className={`button${view === 'gallery' ? ' button-primary' : ''}`} aria-pressed={view === 'gallery'} onClick={() => setView('gallery')}>Gallery</button>
      <button className={`button${view === 'timeline' ? ' button-primary' : ''}`} aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>Appearance timeline</button>
    </div>{view === 'timeline' ? characterField : null}</div>
    {view === 'gallery' ? <section className="images-controls" aria-label="Create and filter images">
      <div className="images-controls-heading"><div><h2>Character images</h2><p className="muted small">Choose a character to create images or explore their appearance. Chapter image sections show key characters only.</p></div></div>
      {characterField}
      <div className="images-actions"><button className="button button-primary" disabled={!characterId || creating || running || !firstChapter} onClick={() => void createImage()}>{creating ? 'Starting…' : firstChapter ? `Create image for ${formatChapterLabel(firstChapter.title, firstChapter.orderIndex)}` : 'Create image'}</button>
        <button className="button" disabled={!characterId || batchBusy || running} onClick={() => void startBatch()}>Create images for all chapters</button>
      </div>
      <p className="muted small">All chapters uses the default settings, creates images one at a time for drafted chapters, and skips chapters that already have an image for this character.</p>
      {batch && selectedCharacter ? <div className="images-batch" role="status"><div><strong>{selectedCharacter.name}: {running ? 'Creating chapter images' : 'Chapter images'}</strong><p className="muted small">{batch.message ?? `${completed} of ${batch.items.length} complete`}{running ? ` ? ${completed} of ${batch.items.length} complete` : ''}</p></div>{running ? <button className="button button-small" disabled={batchBusy} onClick={() => void cancelBatch()}>Stop</button> : null}</div> : null}
    </section> : null}
    {notice ? <Banner tone="success">{notice}</Banner> : null}{error ? <Banner tone="danger">{error}</Banner> : null}
    {loading ? <Spinner label="Loading images…" /> : view === 'timeline' ? <AppearanceTimeline key={characterId} character={selectedCharacter} chapters={chapters} assets={assets} active={active} /> : <>
      <div className="images-gallery-heading"><div><h2>Gallery</h2><p className="muted small">{filtered.length} {filtered.length === 1 ? 'image' : 'images'}</p></div></div>
      {filtered.length ? <ImageGallery assets={filtered} characters={characters} chapters={chapters} onChanged={load} onRegenerate={asset => {setStudio(asset); setStudioCharacter(characters.find(c => c.id === asset.characterId) ?? null);}} /> : <EmptyState title="No images match">Choose a character above to create an image.</EmptyState>}
    </>}
    <ImageStudio open={Boolean(studioCharacter)} project={project} character={studioCharacter} initialChapterId={studio?.chapterId ?? undefined} initialAsset={studio} onClose={() => {setStudio(null); setStudioCharacter(null); void load();}} onCharacterUpdated={() => void load()} onOpenSettings={onOpenSettings} onOpenImageSettings={onOpenSettings} />
  </div>;
}
