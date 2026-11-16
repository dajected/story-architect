import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDialog, useMediaQuery } from './ui';

/** A viewport-bounded popover on desktop and a modal action sheet on phones. */
export function ActionMenu({ label, title, children, className = '', buttonClassName = 'button button-small', ariaLabel }: {
  label: ReactNode; title?: string; children: ReactNode; className?: string; buttonClassName?: string; ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const mobile = useMediaQuery('(max-width: 720px)');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  const id = useId();
  const name = title ?? ariaLabel ?? (typeof label === 'string' ? label : 'Actions');
  const [position, setPosition] = useState({left: 12, top: 12});
  useDialog(open, () => setOpen(false), panelRef, mobile, restoreFocus);
  useLayoutEffect(() => {
    if (!open || mobile) return;
    const positionPanel = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!trigger || !panel) return;
      setPosition({
        left: Math.max(12, Math.min(trigger.right - panel.width, window.innerWidth - panel.width - 12)),
        top: Math.max(12, Math.min(trigger.bottom + 8, window.innerHeight - panel.height - 12)),
      });
    };
    positionPanel();
    const observer = new ResizeObserver(positionPanel);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', positionPanel); window.removeEventListener('scroll', positionPanel, true); };
  }, [open, mobile]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      restoreFocus.current = mobile;
      setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, mobile]);
  return <div className={`action-menu ${className}`}>
    <button ref={triggerRef} type="button" className={buttonClassName} aria-label={ariaLabel} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>{label}</button>
    {open ? createPortal(<div className={`action-menu-layer ${mobile ? 'is-sheet' : ''}`}>
      <div ref={panelRef} id={id} role="dialog" aria-modal={mobile || undefined} aria-label={name} tabIndex={-1} className="action-menu-content action-panel" style={mobile ? undefined : position} onClickCapture={event => {
        if ((event.target as HTMLElement).closest('button, a[href]')) {
          // Capture a stable return target before an action opens another dialog.
          triggerRef.current?.focus();
        }
      }} onClick={event => {
        if ((event.target as HTMLElement).closest('button, a[href]')) setOpen(false);
      }}>
        <div className="action-sheet-heading"><strong>{name}</strong><button className="icon-button" aria-label={`Close ${name}`} type="button" onClick={() => setOpen(false)}>×</button></div>
        {children}
      </div>
    </div>, document.body) : null}
  </div>;
}
