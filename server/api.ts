import { Router } from 'express';
import { settingsRouter } from './routes/settings.js';
import { projectsRouter } from './routes/projects.js';
import { outlineRouter } from './routes/outline.js';
import { writingRouter } from './routes/writing.js';
import { chatRouter } from './routes/chat.js';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'story-architect', time: new Date().toISOString() });
});

apiRouter.use(settingsRouter);
apiRouter.use(projectsRouter);
apiRouter.use(outlineRouter);
apiRouter.use(writingRouter);
apiRouter.use(chatRouter);

apiRouter.use((_req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});
