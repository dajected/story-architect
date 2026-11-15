import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ChapterPortraitOverview,
  Character,
  ImageAsset,
  PortraitBatch,
  Project,
} from '@shared/types';
import { api } from '../api';
import { errorText } from '../utils';
import { Banner, confirmAction, Modal, Spinner } from './ui';
import { ImageGallery } from './ImageGallery';
import { ImageStudio } from './ImageStudio';

function batchLabel(status: PortraitBatch['items'][number]['status']): string {
  if (status === 'completed') return 'Drawn';
  if (status === 'failed') return 'Failed';
  if (status === 'running') return 'Drawing';
  if (status === 'skipped') return 'Skipped';
  return 'Waiting';
}

function batchBadge(status: PortraitBatch['items'][number]['status']): string {
  if (status === 'completed') return 'badge-success';
  if (status === 'failed') return 'badge-danger';
  if (status === 'running') return 'badge-accent';
  return '';
}

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
  const [batchCharacterId, setBatchCharacterId] = useState('');
  const [batch, setBatch] = useState<PortraitBatch | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [skipExisting, setSkipExisting] = useState(true);
  const navigate = useNavigate();
  const styleLoaded = useRef(false);
  const previous = useRef(new Map<string, string>());
  const previousBatchStatus = useRef<PortraitBatch['status'] | null>(null);
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

  const loadBatch = useCallback(async (characterId: string) => {
    if (!characterId) {setBatch(null); return;}
    try {
      setBatch(await api.getCharacterPortraitBatch(characterId));
      setBatchError(null);
    } catch(err) {setBatchError(errorText(err));}
  }, []);

  const characters = [...(data?.named.map(n => n.character) ?? []), ...(data?.others ?? [])];

  useEffect(() => {
    if (!open || !data) return;
    setBatchCharacterId(current => characters.some(c => c.id === current) ? current : characters[0]?.id ?? '');
    // Only re-pick when the chapter or cast changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, data?.chapterId, data?.named.length, data?.others.length]);

  useEffect(() => {
    if (!open || !batchCharacterId) {setBatch(null); previousBatchStatus.current = null; return;}
    previousBatchStatus.current = null;
    setBatch(null);
    setBatchNotice(null);
    void loadBatch(batchCharacterId);
  }, [open, batchCharacterId, loadBatch]);

  useEffect(() => {
    if (!open || !batch || batch.status !== 'running') return;
    const timer = setInterval(() => void loadBatch(batch.characterId), 2500);
    return () => clearInterval(timer);
  }, [open, batch?.id, batch?.status, batch?.characterId, loadBatch]);

  useEffect(() => {
    if (!batch) return;
    const previousStatus = previousBatchStatus.current;
    previousBatchStatus.current = batch.status;
    if (previousStatus === 'running' && batch.status !== 'running') {
      setBatchNotice(batch.message ?? 'Portrait batch finished.');
      if (batch.status !== 'cancelled') void load();
    }
  }, [batch, load]);

  const generate = async (ids: string[]) => {
    if (!data) return;
    const plural = ids.length === 1 ? '' : 's';
    if (!await confirmAction(`Generate ${ids.length} image${plural}? This submits ${ids.length} prompt request${plural} and ${ids.length} image request${plural}. Provider prices are unavailable; your image service may charge for each image.`)) return;
    setBusy(true); setError(null); setNotice(null);
    const failures: string[] = [];
    for (const characterId of ids) {
      try {await api.startChapterPortrait(chapterId, {characterId, connectionId, moment, scene, visualStyle: style});}
      catch(err) {failures.push(`${characters.find(c => c.id === characterId)?.name}: ${errorText(err)}`);}
    }
    await load(); setBusy(false); setNotice(`${ids.length - failures.length} portrait request(s) started.`);
    if (failures.length) setError(failures.join('\n'));
  };

  const startContainerBatch = async () => {
    if (!data || !batchCharacterId) return;
    const character = characters.find(c => c.id === batchCharacterId);
    if (!character) return;
    let chapterCount = 0;
    try {
      const chapters = await api.listChapters(project.id);
      chapterCount = chapters.filter(chapter => chapter.wordCount > 0).length;
    } catch (err) {
      setBatchError(errorText(err));
      return;
    }
    if (chapterCount === 0) {
      setBatchError('Draft at least one chapter before queuing chapter images.');
      return;
    }
    if (!await confirmAction(`Queue an image of ${character.name} for ${chapterCount} chapter${chapterCount === 1 ? '' : 's'}? Each chapter uses one prompt request and one image request, drawn one at a time; your image service may charge per image.${skipExisting ? ' Chapters that already have an image of this character are skipped.' : ''}`)) return;
    setBatchBusy(true); setBatchError(null); setBatchNotice(null);
    try {
      const next = await api.startCharacterPortraitBatch(batchCharacterId, {
        connectionId, moment, scene, visualStyle: style, skipExisting, selectForChapter: true,
      });
      setBatch(next);
      previousBatchStatus.current = next.status;
      setBatchNotice(next.message ?? 'Portrait batch queued.');
    } catch (err) {
      setBatchError(errorText(err));
    } finally {
      setBatchBusy(false);
    }
  };

  const stopContainerBatch = async () => {
    if (!batch) return;
    setBatchBusy(true); setBatchError(null);
    try {
      const next = await api.cancelPortraitBatch(batch.id);
      setBatch(next);
      setBatchNotice(next.message ?? 'Portrait batch stopped.');
    } catch (err) {
      setBatchError(errorText(err));
    } finally {
      setBatchBusy(false);
    }
  };

  const customize = (character: Character, asset: ImageAsset | null = null) => {setInitialAsset(asset); setStudio(character);};
  const setupUrl = (tab: string) => `/settings?tab=${tab}&returnTo=${encodeURIComponent(location.pathname)}`;
  const batchSettled = batch?.items.filter(item => item.status !== 'pending' && item.status !== 'running').length ?? 0;
  const batchProgress = batch?.items.length ? Math.round((batchSettled / batch.items.length) * 100) : 0;
  const batchRunning = batch?.status === 'running';
  return <section className="chapter-portraits compact-portraits">
    <div className="portrait-strip">{characters.slice(0, 4).map(character => {
      const image = data?.assets.find(a => a.characterId === character.id && a.selectedForChapter);
      return <button className="portrait-chip" key={character.id} onClick={() => setOpen(true)}>{image ? <img src={image.url} alt="" /> : <span className="portrait-avatar placeholder">{character.name[0]}</span>}<span>{character.name}<small>{image ? (image.sourceOutdated ? 'Earlier draft' : 'Chapter image') : 'No chapter image'}</small></span></button>;
    })}{characters.length > 4 ? <button className="portrait-chip portrait-more" onClick={() => setOpen(true)} title="Open chapter images">+{characters.length - 4} more</button> : null}<button className="button button-small" onClick={() => setOpen(true)}>Chapter images · {data?.assets.length ?? 0} →{data?.activeRequests.length ? ` (${data.activeRequests.length} running)` : ''}{batchRunning ? ' · timeline running' : ''}</button></div>
    {error && !open ? <Banner tone="danger">{error}</Banner> : null}
    <Modal open={open} onClose={() => setOpen(false)} title={`Chapter images — ${data?.chapterTitle ?? ''}`} subtitle="Select an image for each character in this chapter. Main character portraits stay separate." width="wide">
      <div className="stack">{error ? <Banner tone="danger">{error}</Banner> : null}{notice ? <Banner>{notice}</Banner> : null}
      {!data ? <Spinner label="Loading chapter images…" /> : <>
        {!data.hasText ? <Banner>Draft this chapter before generating its appearances.</Banner> : null}
        {!data.connections.length ? <Banner tone="warning" actions={<button className="button" onClick={() => navigate(setupUrl('image-connections'))}>Connect image service</button>}>An image service draws the portrait.</Banner> : null}
        {!data.imagePromptRole?.model ? <Banner tone="warning" actions={<button className="button" onClick={() => navigate(setupUrl('models'))}>Choose prompt model</button>}>A text model builds the image prompt. You can also write a prompt in Customize.</Banner> : null}
        <div className="form-row"><label>Image service<select value={connectionId} onChange={e => setConnectionId(e.target.value)}>{data.connections.length === 0 ? <option value="">No image connections</option> : null}{data.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Story moment<select value={moment} onChange={e => setMoment(e.target.value as typeof moment)}><option value="end">End of chapter</option><option value="start">Start of chapter</option><option value="custom">Custom scene</option></select></label></div>
        {moment === 'custom' ? <label>Scene to depict<textarea value={scene} onChange={e => setScene(e.target.value)} maxLength={8000} /></label> : null}
        <label>Project visual style<input value={style} onChange={e => setStyle(e.target.value)} maxLength={4000} placeholder="Cinematic illustration, consistent lighting and palette" /></label><button className="button button-small" onClick={async () => {try {await api.saveVisualStyle(project.id,style);setNotice('Project visual style saved for all chapters.');}catch(err){setError(errorText(err));}}}>Save project visual style</button>

        <section className="portrait-batch-panel">
          <div className="image-studio-section-head"><h3>One character, every chapter</h3><span className="muted small">Draws an appearance timeline across the whole story.</span></div>
          <p className="muted small">Queues one image of the chosen character for every chapter that has prose. Images are drawn one at a time, in chapter order, using the image service, story moment, scene and visual style above. Each finished image is set as that chapter's image for the character.</p>
          <div className="form-row">
            <label>Character<select value={batchCharacterId} onChange={e => setBatchCharacterId(e.target.value)} disabled={!characters.length}>{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="check-label"><input type="checkbox" checked={skipExisting} onChange={e => setSkipExisting(e.target.checked)} />Skip chapters that already have an image</label>
          </div>
          <div className="row-actions">
            <button className="button" disabled={batchBusy || batchRunning || !batchCharacterId || !connectionId || !data.imagePromptRole?.model} onClick={() => void startContainerBatch()}>{batchBusy ? <Spinner /> : null}Queue images for all chapters</button>
            {batchRunning ? <button className="button button-danger-ghost" disabled={batchBusy} onClick={() => void stopContainerBatch()}>{batchBusy ? <Spinner /> : null}Stop batch</button> : null}
          </div>
          {batchError ? <Banner tone="danger">{batchError}</Banner> : null}
          {batchNotice ? <Banner tone="success">{batchNotice}</Banner> : null}
          {batch ? <div className="portrait-batch-progress">
            <div className="batch-progress-track"><span style={{width: `${batchProgress}%`}} /></div>
            <span className="muted small">{batch.status === 'running' ? 'Running' : batch.status} · {batchSettled} of {batch.items.length} settled · {batch.items.filter(i => i.status === 'completed').length} drawn{batch.items.some(i => i.status === 'failed') ? ` · ${batch.items.filter(i => i.status === 'failed').length} failed` : ''}</span>
            {batch.message ? <span className="muted small">{batch.message}</span> : null}
            <ol className="batch-items">{batch.items.map(item => <li className={`batch-item ${item.status}`} key={item.chapterId}><span className="batch-item-index">{String(item.orderIndex + 1).padStart(2, '0')}</span><span className="batch-item-title">{item.title}</span><span className={`badge ${batchBadge(item.status)}`}>{batchLabel(item.status)}</span>{item.error ? <span className="batch-item-error">{item.error}</span> : null}</li>)}</ol>
          </div> : null}
        </section>

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
    <ImageStudio open={Boolean(studio)} project={project} character={studio} initialChapterId={chapterId} initialAsset={initialAsset} onClose={() => {setStudio(null); void load();}} onCharacterUpdated={() => void load()} onOpenSettings={() => navigate(setupUrl('models'))} onOpenImageSettings={() => navigate(setupUrl('image-connections'))} />
  </section>;
}
