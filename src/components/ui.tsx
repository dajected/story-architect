import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

// Dialogs can close in any order (including when their whole page unmounts).
const bodyScrollLocks = new Set<symbol>();
let unlockedBodyOverflow = '';

function lockBodyScroll() {
  const token = Symbol();
  if (!bodyScrollLocks.size) unlockedBodyOverflow = document.body.style.overflow;
  bodyScrollLocks.add(token);
  document.body.style.overflow = 'hidden';
  return () => {
    bodyScrollLocks.delete(token);
    if (!bodyScrollLocks.size) document.body.style.overflow = unlockedBodyOverflow;
  };
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** Shared focus and scroll behaviour for modal surfaces and responsive drawers. */
export function useDialog(open: boolean, onClose: () => void, dialogRef: RefObject<HTMLElement | null>, modal = true, restoreFocus?: RefObject<boolean>) {
  const closeRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) previousFocusRef.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    const previousFocus = previousFocusRef.current;
    const dialog = dialogRef.current;
    if (restoreFocus) restoreFocus.current = true;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0 && !el.closest('[inert]'));
    if (!dialog?.contains(document.activeElement)) (dialog?.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0] ?? dialog)?.focus();
    const handler = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (modal && event.key === 'Tab') {
        const items = focusable();
        if (!items.length) { event.preventDefault(); dialog?.focus(); return; }
        if (event.shiftKey && (document.activeElement === items[0] || !dialog?.contains(document.activeElement))) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && (document.activeElement === items.at(-1) || !dialog?.contains(document.activeElement))) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    const unlock = modal ? lockBodyScroll() : () => {};
    return () => {
      document.removeEventListener('keydown', handler);
      unlock();
      if (restoreFocus?.current !== false && previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open, modal, dialogRef, restoreFocus]);
}

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
  className = '',
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'normal' | 'wide' | 'narrow';
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog(open, onClose, dialogRef);

  if (!open) return null;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} tabIndex={-1} className={`modal modal-${width} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
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
