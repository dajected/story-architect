import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  OUTLINE_TEMPLATE_DEFAULT,
  OUTLINE_TEMPLATE_PREVIOUS,
  PROSE_TEMPLATE_DEFAULT,
  PROSE_TEMPLATE_LEGACY,
  PROSE_TEMPLATE_PREVIOUS,
} from './prompts.js';

it.each([
  { label: 'legacy prose', prose: PROSE_TEMPLATE_LEGACY, schemaVersion: 12 },
  { label: 'previous prose', prose: PROSE_TEMPLATE_PREVIOUS, schemaVersion: 13 },
])('upgrades untouched outline and $label templates while preserving custom text', async ({ prose, schemaVersion }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-architect-template-upgrade-'));
  vi.stubEnv('DATA_DIR', directory);
  vi.resetModules();
  let database: typeof import('./db.js') | undefined;
  try {
    database = await import('./db.js');
    const update = database.db.prepare('UPDATE prompt_templates SET content = ? WHERE id = ?');
    update.run(prose.replace(/\n/g, '\r\n'), 'tpl-prose-default');
    update.run(OUTLINE_TEMPLATE_PREVIOUS, 'tpl-outline-default');
    const insert = database.db.prepare(`INSERT INTO prompt_templates
      (id, project_id, kind, name, content, is_default, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, 0, '', '')`);
    insert.run('copy', 'prose', 'Untouched copy', prose);
    const customProse = `${prose}\nAuthor rule: use short sentences.`;
    const customOutline = `${OUTLINE_TEMPLATE_PREVIOUS}\nAuthor rule: alternate viewpoints.`;
    insert.run('custom-prose', 'prose', 'Custom prose', customProse);
    insert.run('custom-outline', 'outline', 'Custom outline', customOutline);
    database.db.exec(`PRAGMA user_version = ${schemaVersion}`);
    database.closeDatabase();
    vi.resetModules();
    database = await import('./db.js');
    const content = (id: string) => (database!.db.prepare('SELECT content FROM prompt_templates WHERE id = ?').get(id) as { content: string }).content;
    expect(content('tpl-prose-default')).toBe(PROSE_TEMPLATE_DEFAULT);
    expect(content('tpl-outline-default')).toBe(OUTLINE_TEMPLATE_DEFAULT);
    expect(content('copy')).toBe(PROSE_TEMPLATE_DEFAULT);
    expect(content('custom-prose')).toBe(customProse);
    expect(content('custom-outline')).toBe(customOutline);
    expect(database.schemaVersion()).toBe(database.latestMigrationVersion());
  } finally {
    database?.closeDatabase();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
