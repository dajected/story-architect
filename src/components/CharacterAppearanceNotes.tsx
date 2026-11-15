import { useEffect, useState } from 'react';
import type { Character, CharacterAppearance } from '@shared/types';
import { api } from '../api';
import { errorText, formatChapterLabel } from '../utils';
import { Banner, EmptyState, Modal, Spinner } from './ui';

export function useCharacterAppearances(characterId?: string, active = true) {
  const [records, setRecords] = useState<CharacterAppearance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRecords([]);
    setError(null);
    setLoading(Boolean(characterId) && active);
    if (characterId && active) {
      void api.listCharacterAppearances(characterId)
        .then(next => { if (!cancelled) setRecords(next); })
        .catch(err => { if (!cancelled) setError(errorText(err)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [characterId, active]);
  return { records, loading, error };
}

export function AppearanceNote({ record }: { record?: CharacterAppearance }) {
  return <div className="appearance-note">
    {record?.appearance ? <>
      <span className={`badge ${record.status === 'stale' ? 'badge-warning' : 'badge-success'}`}>
        {record.status === 'stale' ? 'Outdated notes' : 'Stored notes'}
      </span>
      <p>{record.appearance}</p>
      {record.staleReasons.length ? <p className="muted small">{record.staleReasons.join(' ')}</p> : null}
    </> : <p className="muted small">No appearance notes stored for this chapter.</p>}
  </div>;
}

export function CharacterAppearanceNotes({ character, onClose }: {
  character: Character | null;
  onClose: () => void;
}) {
  const { records, loading, error } = useCharacterAppearances(character?.id);
  return <Modal open={Boolean(character)} title={`Appearance notes — ${character?.name ?? ''}`} onClose={onClose} width="wide"
    subtitle="Stored appearance at the end of each chapter. Notes are recorded for key characters during story memory generation.">
    {loading ? <Spinner label="Loading appearance notes…" /> : error ? <Banner tone="danger">{error}</Banner> : records.length ?
      <div className="appearance-notes-list">{records.map(record => <section key={record.chapterId}>
        <h3>{formatChapterLabel(record.chapterTitle, record.chapterOrder)}</h3>
        <AppearanceNote record={record} />
      </section>)}</div> : <EmptyState title="No chapters yet">Appearance notes will appear here as your story develops.</EmptyState>}
  </Modal>;
}
