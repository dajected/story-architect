import { ActionMenu } from './ActionMenu';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatChapterLabel } from '../utils';

type Queue = Awaited<ReturnType<typeof api.getProjectQueue>>;
const labels: Record<string, string> = { outline: 'Outline', chapter: 'Chapter draft', chat: 'Assistant', memory: 'Story memory', characters: 'Characters', rewrite: 'Rewrite', review: 'Continuity review', image_prompt: 'Image prompt', image: 'Image' };

export function WorkspaceQueue({ projectId, onOpenActivity, hideWhenIdle = false }: { projectId: string; onOpenActivity: () => void; hideWhenIdle?: boolean }) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let refreshPending = false;
    let delay = 2500;
    const refresh = async () => {
      if (cancelled || document.hidden || refreshing) return;
      refreshing = true;
      try {
        const next = await api.getProjectQueue(projectId);
        if (!cancelled) {
          setQueue(next); setUnavailable(false);
          const active = next.jobs.length || next.chapterBatch?.status === 'running' || next.portraitBatches.some(batch => batch.status === 'running');
          delay = active ? 2500 : 15000;
        }
      } catch { if (!cancelled) { setUnavailable(true); delay = Math.min(delay * 2, 30000); } }
      finally {
        refreshing = false;
        if (!cancelled && !document.hidden) {
          timer = setTimeout(() => void refresh(), refreshPending ? 0 : delay);
          refreshPending = false;
        }
      }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void refresh(); };
    setQueue(null); void refresh();
    document.addEventListener('visibilitychange', visibility);
    const refreshSoon = () => { clearTimeout(timer); if (refreshing) refreshPending = true; else void refresh(); };
    window.addEventListener('refresh-work-queue', refreshSoon);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('refresh-work-queue', refreshSoon); };
  }, [projectId]);
  const pendingChapters = queue?.chapterBatch?.items.filter(item => item.status === 'pending') ?? [];
  const pendingPortraits = queue?.portraitBatches.flatMap(batch => batch.items.filter(item => item.status === 'pending').map(item => ({ ...item, batchId: batch.id, character: queue.characters.find(c => c.id === batch.characterId)?.name ?? 'Character' }))) ?? [];
  const jobs = queue?.jobs ?? [];
  // A batch can briefly be between its prompt and image requests; keep that work visible.
  const transitioningChapters = queue?.chapterBatch?.items.filter(item => item.status === 'running' && !jobs.some(job => job.id === item.jobId)) ?? [];
  const transitioningPortraits = queue?.portraitBatches.flatMap(batch => batch.items.filter(item => item.status === 'running' && !jobs.some(job => job.chapterId === item.chapterId && (job.kind === 'image' || job.kind === 'image_prompt'))).map(item => ({ ...item, batchId: batch.id, character: queue.characters.find(c => c.id === batch.characterId)?.name ?? 'Character' }))) ?? [];
  const count = jobs.length + pendingChapters.length + pendingPortraits.length + transitioningChapters.length + transitioningPortraits.length;
  if (hideWhenIdle && queue && count === 0 && !unavailable) return null;
  return <ActionMenu className="workspace-queue" title="Work queue" ariaLabel={`Work queue${unavailable ? ', unavailable' : `, ${count} active or queued`}`} label={<>Queue <span className="queue-count" role="status" aria-live="polite">{unavailable ? '!' : count}</span></>}>
      <div className="queue-heading"><strong>Work queue</strong><button className="button button-ghost button-small" onClick={onOpenActivity}>Activity</button></div>
      {unavailable ? <p className="muted small">Queue unavailable. Retrying?</p> : !queue ? <p className="muted small">Loading?</p> : count === 0 ? <p className="muted small">No work running or queued.</p> : <ul className="queue-list">
        {jobs.map(job => <li key={job.id}><span className="queue-status">{job.status === 'queued' ? 'Queued' : 'Running'}</span><span>{labels[job.kind] ?? job.kind}{job.subject ? ` ? ${job.subject}` : ''}{job.chapterTitle ? ` ? ${formatChapterLabel(job.chapterTitle, job.chapterOrder ?? 0)}` : ''}</span></li>)}
        {transitioningChapters.map(item => <li key={`running-chapter-${item.chapterId}`}><span className="queue-status">Running</span><span>Chapter draft ? {formatChapterLabel(item.title, item.orderIndex)}</span></li>)}
        {transitioningPortraits.map(item => <li key={`running-${item.batchId}-${item.chapterId}`}><span className="queue-status">Running</span><span>Image ? {item.character} ? {formatChapterLabel(item.title, item.orderIndex)}</span></li>)}
        {pendingChapters.map(item => <li key={`chapter-${item.chapterId}`}><span className="queue-status">Queued</span><span>Chapter draft ? {formatChapterLabel(item.title, item.orderIndex)}</span></li>)}
        {pendingPortraits.map(item => <li key={`${item.batchId}-${item.chapterId}`}><span className="queue-status">Queued</span><span>Image ? {item.character} ? {formatChapterLabel(item.title, item.orderIndex)}</span></li>)}
      </ul>}
  </ActionMenu>;
}
