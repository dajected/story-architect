import fs from 'node:fs';
import path from 'node:path';

function resolveRootDir(): string {
  if (process.env.APP_ROOT) return path.resolve(process.env.APP_ROOT);
  const moduleDir = import.meta.dirname;
  // Development runs from server/; the compiled server runs from dist-server/server/.
  if (path.basename(path.dirname(moduleDir)) === 'dist-server') {
    return path.resolve(moduleDir, '..', '..');
  }
  return path.resolve(moduleDir, '..');
}

const rootDir = resolveRootDir();

export const config = {
  rootDir,
  dataDir: path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data')),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || '',
  staticDir: path.resolve(rootDir, 'dist'),
  isProduction: process.env.NODE_ENV === 'production',
};

export function ensureDataDirs(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

export const dbPath = path.join(config.dataDir, 'story-architect.db');
export const keyPath = path.join(config.dataDir, 'secret.key');
