import { useState } from 'react';
import { api } from '../api';
import { errorText } from '../utils';
import { Banner, Modal } from './ui';

export function BackupButton({ projectId, label }: { projectId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(api.backupUrl(projectId));
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error || `Backup failed (${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const disposition = response.headers.get('Content-Disposition') ?? '';
      link.download = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'project-backup.tar.gz';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <button className="button button-ghost button-small" disabled={busy}
      title="Download a portable project backup without credentials" onClick={() => void download()}>
      {busy ? 'Preparing backup…' : label}
    </button>
    <Modal open={Boolean(error)} title="Backup could not be completed" onClose={() => setError(null)}>
      <Banner tone="danger">{error}</Banner>
    </Modal>
  </>;
}
