import { createApp } from './app.js';
import { config } from './config.js';
import { reconcileInterruptedImageJobs } from './image-generation.js';

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`Story Architect listening on http://${config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  void reconcileInterruptedImageJobs().catch((error) => {
    console.error('[story-architect] image job reconciliation failed:', error);
  });
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}. Shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
