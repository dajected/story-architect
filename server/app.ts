import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { apiRouter } from './api.js';
import { AppError } from './errors.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.json({ limit: '4mb' }));

  app.use('/api', apiRouter);

  const indexFile = path.join(config.staticDir, 'index.html');
  if (fs.existsSync(config.staticDir)) {
    app.use(express.static(config.staticDir, { index: false, maxAge: '1h' }));
  }

  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) {
      next();
      return;
    }
    if (!fs.existsSync(indexFile)) {
      res
        .status(503)
        .type('text/plain')
        .send('The Story Architect interface has not been built yet. Run "npm run build".');
      return;
    }
    // `dotfiles: allow` keeps the SPA working when the install path itself contains
    // a dot-directory (for example C:\Users\name\.t3\projects\...).
    res.sendFile(indexFile, { dotfiles: 'allow' });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'The request body is not valid JSON.' });
      return;
    }
    const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status;
    const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
    const clientStatus = typeof status === 'number' ? status : typeof statusCode === 'number' ? statusCode : null;
    if (clientStatus && clientStatus >= 400 && clientStatus < 500) {
      const message =
        clientStatus === 413
          ? 'The request body is too large.'
          : error instanceof Error
            ? error.message
            : 'The request could not be processed.';
      res.status(clientStatus).json({ error: message });
      return;
    }
    console.error('[story-architect] request failed:', error);
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    res.status(500).json({ error: message });
  });

  return app;
}
