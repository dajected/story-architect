import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { APP_COMMIT, APP_VERSION } from '../version';

export type Theme = 'dark' | 'light';

export function VersionBadge() {
  return (
    <div
      className="version-badge"
      title={`Story Architect v${APP_VERSION} — build ${APP_COMMIT}`}
      aria-label={`Version ${APP_VERSION}, build ${APP_COMMIT}`}
    >
      v{APP_VERSION} · {APP_COMMIT}
    </div>
  );
}

export function Brand({ to = '/', small = false }: { to?: string; small?: boolean }) {
  return (
    <Link className={`brand ${small ? 'brand-small' : ''}`} to={to} aria-label="Story Architect home">
      <img src="/icon.svg" alt="" width={small ? 26 : 32} height={small ? 26 : 32} />
      <span>Story Architect</span>
    </Link>
  );
}

export function ThemeToggle({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
}) {
  return (
    <button
      type="button"
      className="button button-ghost button-small theme-toggle"
      onClick={() => onChange(theme === 'dark' ? 'light' : 'dark')}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}

export function PageHeader({
  children,
  theme,
  onThemeChange,
}: {
  children?: ReactNode;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  return (
    <header className="page-header">
      <Brand />
      <nav className="page-nav">
        {children}
        <Link className="button button-ghost button-small" to="/settings">
          App settings
        </Link>
        <ThemeToggle theme={theme} onChange={onThemeChange} />
      </nav>
    </header>
  );
}
