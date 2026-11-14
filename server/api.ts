import { Router } from 'express';
import { APP_VERSION } from '../shared/version.js';
import { dbGet, latestMigrationVersion, schemaVersion } from './db.js';
import { settingsRouter } from './routes/settings.js';
import { projectsRouter } from './routes/projects.js';
import { outlineRouter } from './routes/outline.js';
import { writingRouter } from './routes/writing.js';
import { chatRouter } from './routes/chat.js';
import { charactersRouter } from './routes/characters.js';
import { memoryRouter } from './routes/memory.js';
import { loreRouter } from './routes/lore.js';
import { toolsRouter } from './routes/tools.js';
import { imagesRouter } from './routes/images.js';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  try {
    dbGet<{ ok: number }>('SELECT 1 AS ok');
    res.json({
      ok: true,
      name: 'story-architect',
      version: APP_VERSION,
      schemaVersion: schemaVersion(),
      latestSchemaVersion: latestMigrationVersion(),
      uptimeSeconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      name: 'story-architect',
      version: APP_VERSION,
      error: error instanceof Error ? error.message : 'The database is unavailable.',
      time: new Date().toISOString(),
    });
  }
});

apiRouter.use(settingsRouter);
apiRouter.use(projectsRouter);
apiRouter.use(outlineRouter);
apiRouter.use(writingRouter);
apiRouter.use(chatRouter);
apiRouter.use(charactersRouter);
apiRouter.use(memoryRouter);
apiRouter.use(loreRouter);
apiRouter.use(toolsRouter);
apiRouter.use(imagesRouter);

apiRouter.use((_req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});
