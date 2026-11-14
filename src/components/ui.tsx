import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  actions,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'} aria-live={tone === 'danger' ? 'assertive' : 'polite'}>
      <div className="banner-copy">
        {title ? <strong>{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {actions ? <div className="banner-actions">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children ? <div className="muted">{children}</div> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'normal',
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'normal' | 'wide' | 'narrow';
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const beforeOpenRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) beforeOpenRef.current = document.activeElement as HTMLElement | null;
  wasOpenRef.current = open;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previousFocus = beforeOpenRef.current;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
    if (!dialog?.contains(document.activeElement)) (dialog?.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0] ?? dialog)?.focus();
    const handler = (event: KeyboardEvent) => {
      const top = Array.from(document.querySelectorAll('[role="dialog"]')).at(-1);
      if (top !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab') {
        const items = focusable();
        if (!items.length) { event.preventDefault(); dialog?.focus(); return; }
        if (event.shiftKey && (document.activeElement === items[0] || !dialog?.contains(document.activeElement))) {event.preventDefault(); items.at(-1)?.focus();}
        else if (!event.shiftKey && document.activeElement === items.at(-1)) {event.preventDefault(); items[0]?.focus();}
      }
    };
    document.addEventListener('keydown', handler);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = previous;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} tabIndex={-1} className={`modal modal-${width}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Shared asynchronous confirmation: named actions use the same accessible dialog. */
export function confirmAction(message: string): Promise<boolean> {
  return new Promise(resolve => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const finish = (accepted: boolean) => {
      root.unmount(); host.remove(); resolve(accepted);
    };
    root.render(<Modal open title="Confirm action" onClose={() => finish(false)} footer={<div className="modal-actions"><button className="button" onClick={() => finish(false)}>Cancel</button><button className="button button-primary" onClick={() => finish(true)}>Continue</button></div>}><p>{message}</p></Modal>);
  });
}

export function StatusDot({ status }: { status: 'planned' | 'drafted' }) {
  return <span className={`status-dot status-${status}`} aria-hidden="true" />;
}
