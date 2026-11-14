import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`Story Architect listening on http://${config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}. Shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
