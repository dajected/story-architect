import { formatChapterLabel } from '../utils';
import { useCallback, useEffect, useState } from 'react';
import type { Chapter, Character, ImageAsset, PortraitBatch, Project } from '@shared/types';
import { api } from '../api';
import { errorText } from '../utils';
import { Banner, EmptyState, Spinner } from './ui';
import { ImageGallery } from './ImageGallery';
import { ImageStudio } from './ImageStudio';

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
  const [characterId, setCharacterId] = useState('');
  const [chapterId, setChapterId] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
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
    const chapter = chapters.find(c => c.id === chapterId) ?? [...chapters].sort((a,b) => a.orderIndex - b.orderIndex)[0];
    if (!chapter) { setError('Approve the outline to create chapter 1 before generating an image.'); return; }
    setCreating(true); setError(null); setNotice(null);
    try { await api.startChapterPortrait(chapter.id, {characterId, moment: 'start'}); setNotice('Image generation started. See Activity for progress.'); } catch (err) { setError(errorText(err)); } finally { setCreating(false); }
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
    setSelectedOnly(true);
  }, [focus]);
  const filtered = assets.filter(a => (!characterId || a.characterId === characterId) && (!chapterId || a.chapterId === chapterId) && (!selectedOnly || a.selectedForChapter)).sort((a,b) => characterId ? (chapters.find(c => c.id === a.chapterId)?.orderIndex ?? -1) - (chapters.find(c => c.id === b.chapterId)?.orderIndex ?? -1) : b.createdAt.localeCompare(a.createdAt));
  const selectedCharacter = characters.find(c => c.id === characterId);
  const running = batch?.status === 'running';
  const completed = batch?.items.filter(item => item.status === 'completed').length ?? 0;
  return <div className="stack images-page">
    <header className="images-header">
      <div><p className="eyebrow">Visual library</p><h1>Images</h1><p className="muted">Create and browse character images throughout your story.</p></div>
      <div className="row-actions">{onOpenCast ? <button className="button" onClick={onOpenCast}>Characters</button> : null}<button className="button" onClick={onOpenSettings}>Image settings</button></div>
    </header>
    <section className="images-controls" aria-label="Create and filter images">
      <div className="images-controls-heading"><div><h2>Character images</h2><p className="muted small">Choose a character to create images or explore their appearance.</p></div></div>
      <div className="images-fields">
        <label>Character<select value={characterId} onChange={e => setCharacterId(e.target.value)}><option value="">All characters</option>{characters.filter(c => c.status !== 'archived').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Chapter<select value={chapterId} onChange={e => setChapterId(e.target.value)}><option value="">All chapters</option>{chapters.map(c => <option key={c.id} value={c.id}>{formatChapterLabel(c.title, c.orderIndex)}</option>)}</select></label>
      </div>
      <div className="images-actions"><button className="button button-primary" disabled={!characterId || creating || running} onClick={() => void createImage()}>{creating ? 'Starting?' : chapterId ? 'Create image for this chapter' : 'Create image for chapter 1'}</button>
        <button className="button" disabled={!characterId || batchBusy || running} onClick={() => void startBatch()}>Create images for all chapters</button>
      </div>
      <p className="muted small">All chapters uses the default settings, creates images one at a time for drafted chapters, and skips chapters that already have an image for this character.</p>
      {batch && selectedCharacter ? <div className="images-batch" role="status"><div><strong>{selectedCharacter.name}: {running ? 'Creating chapter images' : 'Chapter images'}</strong><p className="muted small">{batch.message ?? `${completed} of ${batch.items.length} complete`}{running ? ` ? ${completed} of ${batch.items.length} complete` : ''}</p></div>{running ? <button className="button button-small" disabled={batchBusy} onClick={() => void cancelBatch()}>Stop</button> : null}</div> : null}
    </section>
    {notice ? <Banner tone="success">{notice}</Banner> : null}{error ? <Banner tone="danger">{error}</Banner> : null}
    <div className="images-gallery-heading"><div><h2>Gallery</h2><p className="muted small">{filtered.length} {filtered.length === 1 ? 'image' : 'images'}</p></div><label className="check-label"><input type="checkbox" checked={selectedOnly} onChange={e => setSelectedOnly(e.target.checked)} /> Selected chapter images only</label></div>
    {loading ? <Spinner label="Loading images?" /> : filtered.length ? <ImageGallery assets={filtered} characters={characters} chapters={chapters} onChanged={load} onRegenerate={asset => {setStudio(asset); setStudioCharacter(characters.find(c => c.id === asset.characterId) ?? null);}} /> : <EmptyState title="No images match">Choose a character above to create an image, or adjust the filters.</EmptyState>}
    <ImageStudio open={Boolean(studioCharacter)} project={project} character={studioCharacter} initialChapterId={studio?.chapterId ?? (chapterId || undefined)} initialAsset={studio} onClose={() => {setStudio(null); setStudioCharacter(null); void load();}} onCharacterUpdated={() => void load()} onOpenSettings={onOpenSettings} onOpenImageSettings={onOpenSettings} />
  </div>;
}
