import { ActionMenu } from './ActionMenu';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './ui';

export function ImageViewer({open, title, url, alt, index, count, onNavigate, onClose, actions}: {
  open: boolean; title: string; url: string; alt: string; index: number; count: number;
  onNavigate: (index: number) => void; onClose: () => void; actions?: ReactNode;
}) {
  const [zoom, setZoom] = useState(1);
  const touch = useRef<{x: number; y: number} | null>(null);
  useEffect(() => { setZoom(1); }, [url]);
  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input, select, textarea')) return;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (!dialogs[dialogs.length - 1]?.classList.contains('modal-image-viewer')) return;
      const next = index + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0);
      if (next !== index && next >= 0 && next < count) { event.preventDefault(); onNavigate(next); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [open, index, count, onNavigate]);
  return <Modal open={open} title={title} onClose={onClose} width="wide" className="modal-image-viewer">
    <div className="image-viewer-stage" style={zoom > 1 ? {alignItems:'flex-start', justifyContent:'flex-start'} : {touchAction:'pan-y pinch-zoom'}} onTouchStart={event => {
      const point = event.touches[0];
      touch.current = event.touches.length === 1 && point ? {x: point.clientX, y: point.clientY} : null;
    }} onTouchEnd={event => {
      const start = touch.current;
      touch.current = null;
      const end = event.changedTouches[0];
      if (!start || !end || zoom !== 1 || (window.visualViewport?.scale ?? 1) > 1) return;
      const dx = end.clientX - start.x;
      const dy = end.clientY - start.y;
      const next = index + (dx < 0 ? 1 : -1);
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && next >= 0 && next < count) onNavigate(next);
    }} onTouchCancel={() => {touch.current = null;}}>
      <img src={url} alt={alt} style={zoom > 1 ? {width: `${zoom * 100}%`, height: 'auto', maxWidth: 'none', maxHeight: 'none'} : undefined} />
    </div>
    <nav className="image-viewer-controls" aria-label="Image navigation">
      <button className="button button-small" aria-label="Previous image" disabled={index <= 0} onClick={() => onNavigate(index - 1)}>← Previous</button>
      <span className="muted small" aria-live="polite">{index + 1} / {count}</span>
      <button className="button button-small" aria-label="Next image" disabled={index >= count - 1} onClick={() => onNavigate(index + 1)}>Next →</button>
      <ActionMenu className="image-viewer-menu" buttonClassName="button button-small" label="More">
        <label>Zoom<input aria-label="Image zoom" type="range" min="1" max="3" step="0.25" value={zoom} onChange={event => setZoom(Number(event.target.value))} /></label>
        {actions}
      </ActionMenu>
    </nav>
  </Modal>;
}
