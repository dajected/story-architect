import { useCallback, useEffect, useState } from 'react';
import type { Chapter, Character, ImageAsset, Project } from '@shared/types';
import { api } from '../api';
import { errorText } from '../utils';
import { Banner, EmptyState, Spinner } from './ui';
import { ImageGallery } from './ImageGallery';
import { ImageStudio } from './ImageStudio';

export function ProjectImagesPanel({project, character}: {project: Project; character?: Character}) {
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [characterId, setCharacterId] = useState(character?.id ?? '');
  const [chapterId, setChapterId] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(Boolean(character));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [studio, setStudio] = useState<ImageAsset | null>(null);
  const load = useCallback(async () => {
    try {const [images, cast, list] = await Promise.all([api.listProjectImages(project.id), api.listCharacters(project.id), api.listChapters(project.id)]); setAssets(images); setCharacters(cast.characters); setChapters(list); setError(null);} catch(err) {setError(errorText(err));} finally {setLoading(false);}
  }, [project.id]);
  useEffect(() => {void load();}, [load]);
  const filtered = assets.filter(a => (!characterId || a.characterId === characterId) && (!chapterId || a.chapterId === chapterId) && (!selectedOnly || a.selectedForChapter)).sort((a,b) => character ? (chapters.find(c => c.id === a.chapterId)?.orderIndex ?? -1) - (chapters.find(c => c.id === b.chapterId)?.orderIndex ?? -1) : b.createdAt.localeCompare(a.createdAt));
  return <div className="stack"><div><p className="eyebrow">{character ? character.name : 'Visual library'}</p><h1>{character ? 'Appearance timeline' : 'Project images'}</h1><p className="muted">{character ? 'Follow the selected appearance through the story. Each chapter has its own image.' : 'Browse portraits and alternatives across every character and chapter.'}</p></div>
    <div className="row-actions">{!character ? <label>Character<select value={characterId} onChange={e => setCharacterId(e.target.value)}><option value="">All characters</option>{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label> : null}<label>Chapter<select value={chapterId} onChange={e => setChapterId(e.target.value)}><option value="">All chapters</option>{chapters.map(c => <option key={c.id} value={c.id}>{c.orderIndex + 1}. {c.title}</option>)}</select></label><label className="check-label"><input type="checkbox" checked={selectedOnly} onChange={e => setSelectedOnly(e.target.checked)} /> Selected chapter images only</label></div>
    {error ? <Banner tone="danger">{error}</Banner> : null}{loading ? <Spinner label="Loading images…" /> : filtered.length ? <ImageGallery assets={filtered} characters={characters} chapters={chapters} onChanged={load} onRegenerate={setStudio} /> : <EmptyState title="No images match">Generate portraits from a chapter or the Cast image studio. Clear filters to see alternatives.</EmptyState>}
    <ImageStudio open={Boolean(studio)} project={project} character={characters.find(c => c.id === studio?.characterId) ?? null} initialChapterId={studio?.chapterId ?? undefined} initialAsset={studio} onClose={() => {setStudio(null); void load();}} onCharacterUpdated={() => void load()} onOpenSettings={() => {location.href = `/settings?tab=models&returnTo=${encodeURIComponent(location.pathname)}`;}} onOpenImageSettings={() => {location.href = `/settings?tab=image-connections&returnTo=${encodeURIComponent(location.pathname)}`;}} />
  </div>;
}
