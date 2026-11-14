import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, ensureDataDirs, keyPath } from './config.js';

let cachedKey: Buffer | null = null;

function decodeKey(value: string): Buffer {
  const trimmed = value.trim();
  const buffer = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (buffer.length !== 32) {
    throw new Error('STORY_ARCHITECT_ENCRYPTION_KEY must be 32 bytes as base64 or 64 hex characters.');
  }
  return buffer;
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.STORY_ARCHITECT_ENCRYPTION_KEY;
  if (fromEnv) {
    cachedKey = decodeKey(fromEnv);
    return cachedKey;
  }

  ensureDataDirs();
  if (fs.existsSync(keyPath)) {
    cachedKey = decodeKey(fs.readFileSync(keyPath, 'utf8'));
    return cachedKey;
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, generated.toString('base64'), { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

/** AES-256-GCM. Stored form: v1:<iv>:<tag>:<ciphertext>, all base64. */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptSecret(stored: string | null): string | null {
  if (!stored) return null;
  const [version, ivB64, tagB64, dataB64] = stored.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Stored credential is not in a recognised format. Re-enter the API key.');
  }
  const key = loadKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function maskSecret(hasKey: boolean): string {
  return hasKey ? '••••••••' : 'Not set';
}

if (!fs.existsSync(config.dataDir)) {
  ensureDataDirs();
}
