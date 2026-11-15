import { formatChapterLabel } from '../utils';
import { useCallback, useEffect, useState } from 'react';
import type { Chapter, Character, ImageAsset, Project } from '@shared/types';
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
  const [studioCharacter, setStudioCharacter] = useState<Character | null>(null);
  const [studio, setStudio] = useState<ImageAsset | null>(null);
  const load = useCallback(async () => {
    try {const [images, cast, list] = await Promise.all([api.listProjectImages(project.id), api.listCharacters(project.id), api.listChapters(project.id)]); setAssets(images); setCharacters(cast.characters); setChapters(list); setError(null);} catch(err) {setError(errorText(err));} finally {setLoading(false);}
  }, [project.id]);
  useEffect(() => {if (active) void load();}, [active, load]);
  useEffect(() => {
    if (!focus) return;
    setCharacterId(focus.characterId);
    setSelectedOnly(true);
  }, [focus]);
  const filtered = assets.filter(a => (!characterId || a.characterId === characterId) && (!chapterId || a.chapterId === chapterId) && (!selectedOnly || a.selectedForChapter)).sort((a,b) => characterId ? (chapters.find(c => c.id === a.chapterId)?.orderIndex ?? -1) - (chapters.find(c => c.id === b.chapterId)?.orderIndex ?? -1) : b.createdAt.localeCompare(a.createdAt));
  return <div className="stack"><div><p className="eyebrow">Visual library</p><h1>Images</h1>{characterId && onOpenCast ? <button className="button button-small" onClick={onOpenCast}>Back to characters</button> : null}<p className="muted">Browse portraits and alternatives across every character and chapter, or follow one character's appearance through the story.</p></div>
    <div className="row-actions images-filter">{<label>Character<select value={characterId} onChange={e => setCharacterId(e.target.value)}><option value="">All characters</option>{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}<label>Chapter<select value={chapterId} onChange={e => setChapterId(e.target.value)}><option value="">All chapters</option>{chapters.map(c => <option key={c.id} value={c.id}>{formatChapterLabel(c.title, c.orderIndex)}</option>)}</select></label><label className="check-label"><input type="checkbox" checked={selectedOnly} onChange={e => setSelectedOnly(e.target.checked)} /> Selected chapter images only</label><button className="button button-primary" disabled={!characterId} onClick={() => {setStudio(null); setStudioCharacter(characters.find(c => c.id === characterId) ?? null);}}>Create image</button><button className="button" onClick={onOpenSettings}>Image settings</button></div><p className="muted small">Choose a character to create a portrait here. Choose a chapter to place it in the story.</p>
    {error ? <Banner tone="danger">{error}</Banner> : null}{loading ? <Spinner label="Loading images…" /> : filtered.length ? <ImageGallery assets={filtered} characters={characters} chapters={chapters} onChanged={load} onRegenerate={asset => {setStudio(asset); setStudioCharacter(characters.find(c => c.id === asset.characterId) ?? null);}} /> : <EmptyState title="No images match" actions={onOpenCast ? <button className="button" onClick={onOpenCast}>Open characters</button> : undefined}>Generate portraits from a chapter or the portrait studio. Clear filters to see alternatives.</EmptyState>}
    <ImageStudio open={Boolean(studioCharacter)} project={project} character={studioCharacter} initialChapterId={studio?.chapterId ?? (chapterId || undefined)} initialAsset={studio} onClose={() => {setStudio(null); setStudioCharacter(null); void load();}} onCharacterUpdated={() => void load()} onOpenSettings={onOpenSettings} onOpenImageSettings={onOpenSettings} />
  </div>;
}
