import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChapterPortraitOverview, Character, ImageAsset, Project } from '@shared/types';
import { api } from '../api';
import { errorText } from '../utils';
import { Banner, confirmAction, Modal, Spinner } from './ui';
import { ImageGallery } from './ImageGallery';
import { ImageStudio } from './ImageStudio';

export function ChapterPortraits({chapterId, revisionKey, project}: {chapterId: string; revisionKey?: string | null; project: Project}) {
  const [data, setData] = useState<ChapterPortraitOverview | null>(null);
  const [open, setOpen] = useState(false);
  const [studio, setStudio] = useState<Character | null>(null);
  const [initialAsset, setInitialAsset] = useState<ImageAsset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [moment, setMoment] = useState<'start' | 'end' | 'custom'>('end');
  const [scene, setScene] = useState('');
  const [style, setStyle] = useState('');
  const styleLoaded = useRef(false);
  const previous = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    try {
      const next = await api.getChapterPortraits(chapterId);
      const finished = [...previous.current].filter(([id]) => !next.activeRequests.some(r => r.id === id));
      if (finished.length) {
        setNotice('Portrait requests finished. Review each result and the status counts below.');
      }
      previous.current = new Map(next.activeRequests.map(r => [r.id, r.characterId]));
      setData(next); setError(null);
      if (!styleLoaded.current) {setStyle(next.visualStyle ?? '');styleLoaded.current=true;}
      window.dispatchEvent(new CustomEvent('chapter-image-count',{detail: next.assets.length}));
      setConnectionId(current => next.connections.some(c => c.id === current) ? current : next.connections[0]?.id ?? '');
    } catch(err) {setError(errorText(err));}
  }, [chapterId]);
  useEffect(() => {void load();}, [load, revisionKey]);
  useEffect(() => {if (!data?.activeRequests.length) return; const timer = setInterval(() => void load(), 1500); return () => clearInterval(timer);}, [data?.activeRequests.length, load]);
  useEffect(() => {const handler = () => setOpen(true); window.addEventListener('open-chapter-images', handler); return () => window.removeEventListener('open-chapter-images', handler);}, []);
  const characters = [...(data?.named.map(n => n.character) ?? []), ...(data?.others ?? [])];
  const generate = async (ids: string[]) => {
    if (!data) return;
    if (ids.length > 1 && !await confirmAction(`Generate ${ids.length} images? This submits ${ids.length} prompt requests and ${ids.length} image requests. Provider prices are unavailable; your image service may charge for each image.`)) return;
    setBusy(true); setError(null); setNotice(null);
    const failures: string[] = [];
    for (const characterId of ids) {
      try {await api.startChapterPortrait(chapterId, {characterId, connectionId, moment, scene, visualStyle: style});}
      catch(err) {failures.push(`${characters.find(c => c.id === characterId)?.name}: ${errorText(err)}`);}
    }
    await load(); setBusy(false); setNotice(`${ids.length - failures.length} portrait request(s) started.`);
    if (failures.length) setError(failures.join('\n'));
  };
  const customize = (character: Character, asset: ImageAsset | null = null) => {setInitialAsset(asset); setStudio(character);};
  const setupUrl = (tab: string) => `/settings?tab=${tab}&returnTo=${encodeURIComponent(location.pathname)}`;
  return <section className="chapter-portraits compact-portraits">
    <div className="portrait-strip">{characters.slice(0, 4).map(character => {
      const image = data?.assets.find(a => a.characterId === character.id && a.selectedForChapter);
      return <button className="portrait-chip" key={character.id} onClick={() => setOpen(true)}>{image ? <img src={image.url} alt="" /> : <span className="portrait-avatar placeholder">{character.name[0]}</span>}<span>{character.name}<small>{image ? (image.sourceOutdated ? 'Earlier draft' : 'Chapter image') : 'No chapter image'}</small></span></button>;
    })}<button className="button button-small" onClick={() => setOpen(true)}>Chapter images · {data?.assets.length ?? 0} →{data?.activeRequests.length ? ` (${data.activeRequests.length} running)` : ''}</button></div>
    {error && !open ? <Banner tone="danger">{error}</Banner> : null}
    <Modal open={open} onClose={() => setOpen(false)} title={`Chapter images — ${data?.chapterTitle ?? ''}`} subtitle="Select an image for each character in this chapter. Main character portraits stay separate." width="wide">
      <div className="stack">{error ? <Banner tone="danger">{error}</Banner> : null}{notice ? <Banner>{notice}</Banner> : null}
      {!data ? <Spinner label="Loading chapter images…" /> : <>
        {!data.hasText ? <Banner>Draft this chapter before generating its appearances.</Banner> : null}
        {!data.connections.length ? <Banner tone="warning" actions={<a className="button" href={setupUrl('image-connections')}>Connect image service</a>}>An image service draws the portrait.</Banner> : null}
        {!data.imagePromptRole?.model ? <Banner tone="warning" actions={<a className="button" href={setupUrl('models')}>Choose prompt model</a>}>A text model builds the image prompt. You can also write a prompt in Customize.</Banner> : null}
        <div className="form-row"><label>Image service<select value={connectionId} onChange={e => setConnectionId(e.target.value)}>{data.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Story moment<select value={moment} onChange={e => setMoment(e.target.value as typeof moment)}><option value="end">End of chapter</option><option value="start">Start of chapter</option><option value="custom">Custom scene</option></select></label></div>
        {moment === 'custom' ? <label>Scene to depict<textarea value={scene} onChange={e => setScene(e.target.value)} maxLength={8000} /></label> : null}
        <label>Project visual style<input value={style} onChange={e => setStyle(e.target.value)} maxLength={4000} placeholder="Cinematic illustration, consistent lighting and palette" /></label><button className="button button-small" onClick={async () => {try {await api.saveVisualStyle(project.id,style);setNotice('Project visual style saved for all chapters.');}catch(err){setError(errorText(err));}}}>Save project visual style</button>
        <div className="portrait-cast">{characters.map(character => {const named = data.named.find(n => n.character.id === character.id); const request = data.activeRequests.find(r => r.characterId === character.id); const latest = data.requests.find(r => r.characterId === character.id); return <div className="portrait-cast-row" key={character.id}>
          <input type="checkbox" aria-label={`Select ${character.name} for generation`} checked={selected.includes(character.id)} onChange={e => setSelected(current => e.target.checked ? [...current, character.id] : current.filter(id => id !== character.id))} />
          <div className="portrait-cast-copy"><strong>{character.name}</strong><span className="muted small">{named ? `${named.mentionCount} mentions` : 'Other cast member'} · {request?.status ?? latest?.status ?? 'Ready'}</span>{latest?.error ? <span className="error-text small">{latest.error}</span> : null}</div>
          <div className="row-actions">{request ? <button className="button button-small" onClick={async () => {try {await api.cancelChapterPortrait(request.id); await load();} catch(err) {setError(errorText(err));}}}>Stop</button> : <button className="button button-small" disabled={busy || !data.hasText || !connectionId || !data.imagePromptRole?.model} onClick={() => void generate([character.id])}>Generate</button>}<button className="button button-small" onClick={() => customize(character)}>Customize</button></div></div>;})}</div>
        {!characters.length ? <p>Add characters in Cast to create chapter images.</p> : null}
        <div className="row-actions"><button className="button button-primary" disabled={busy || !selected.length || !connectionId || !data.hasText || !data.imagePromptRole?.model} onClick={() => void generate(selected)}>Generate selected ({selected.length})</button><span className="muted small">{data.activeRequests.length} active · Provider cost unavailable</span></div>
        <h3>Images from this chapter</h3><ImageGallery assets={data.assets} characters={characters} onChanged={load} onRegenerate={asset => {const character = characters.find(c => c.id === asset.characterId); if (character) customize(character, asset);}} />
        <div className="row-actions" role="status" aria-live="polite">{['completed','failed','cancelled','interrupted'].map(status => {const count=data.requests.filter(r => r.status === status).length;return count ? <span key={status}>{status}: {count}</span> : null;})}</div>
      </>}
      </div>
    </Modal>
    <ImageStudio open={Boolean(studio)} project={project} character={studio} initialChapterId={chapterId} initialAsset={initialAsset} onClose={() => {setStudio(null); void load();}} onCharacterUpdated={() => void load()} onOpenSettings={() => {location.href = setupUrl('models');}} onOpenImageSettings={() => {location.href = setupUrl('image-connections');}} />
  </section>;
}
