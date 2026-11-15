import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { VersionBadge } from './components/Chrome';
import { LibraryPage } from './pages/LibraryPage';
import { SettingsPage } from './pages/SettingsPage';
import { WorkspacePage } from './pages/WorkspacePage';

type Theme = 'dark' | 'light';

function currentTheme(): Theme {
  const stored = localStorage.getItem('story-architect-theme');
  return stored === 'light' ? 'light' : 'dark';
}

export function App() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const location = useLocation();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('story-architect-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (location.pathname === '/') document.title = 'Story Architect';
    else if (location.pathname === '/settings') document.title = 'Settings — Story Architect';
  }, [location.pathname]);

  return (
    <>
      <Routes>
      <Route path="/" element={<LibraryPage theme={theme} onThemeChange={setTheme} />} />
      <Route path="/settings" element={<SettingsPage theme={theme} onThemeChange={setTheme} />} />
      <Route path="/projects/:projectId" element={<WorkspacePage theme={theme} onThemeChange={setTheme} />} />
      <Route
        path="*"
        element={
          <div className="empty-screen">
            <h1>Page not found</h1>
            <Link className="button" to="/">
              Back to the library
            </Link>
          </div>
        }
      />
    </Routes>
      <VersionBadge />
    </>
  );
}
