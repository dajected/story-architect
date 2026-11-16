import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { PROSE_TEMPLATE_DEFAULT, PROSE_TEMPLATE_LEGACY } from './prompts.js';

it('upgrades untouched saved prose defaults and copies while preserving custom templates', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-architect-template-upgrade-'));
  vi.stubEnv('DATA_DIR', directory);
  vi.resetModules();
  let database: typeof import('./db.js') | undefined;
  try {
    database = await import('./db.js');
    database.db.prepare('UPDATE prompt_templates SET content = ? WHERE id = ?')
      .run(PROSE_TEMPLATE_LEGACY.replace(/\n/g, '\r\n'), 'tpl-prose-default');
    const insert = database.db.prepare(`INSERT INTO prompt_templates
      (id, project_id, kind, name, content, is_default, created_at, updated_at)
      VALUES (?, NULL, 'prose', ?, ?, 0, '', '')`);
    insert.run('copy', 'Untouched copy', PROSE_TEMPLATE_LEGACY);
    const customised = `${PROSE_TEMPLATE_LEGACY}\nAuthor rule: use short sentences.`;
    insert.run('custom', 'Custom prompt', customised);
    database.db.exec(`PRAGMA user_version = ${database.latestMigrationVersion() - 1}`);
    database.closeDatabase();
    vi.resetModules();
    database = await import('./db.js');
    const content = (id: string) => (database!.db.prepare('SELECT content FROM prompt_templates WHERE id = ?').get(id) as { content: string }).content;
    expect(content('tpl-prose-default')).toBe(PROSE_TEMPLATE_DEFAULT);
    expect(content('copy')).toBe(PROSE_TEMPLATE_DEFAULT);
    expect(content('custom')).toBe(customised);
    expect(database.schemaVersion()).toBe(database.latestMigrationVersion());
  } finally {
    database?.closeDatabase();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
