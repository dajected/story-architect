import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupsDir, dbPath, ensureDataDirs } from './config.js';
import { DEFAULT_GENERATION } from '../shared/types.js';
import {
  IMAGE_PROMPT_TEMPLATE_DEFAULT,
  OUTLINE_TEMPLATE_DEFAULT,
  PROSE_TEMPLATE_DEFAULT,
} from './prompts.js';

ensureDataDirs();

export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

const now = () => new Date().toISOString();

function getUserVersion(): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

const migrations: Array<() => void> = [
  () => {
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT,
        models TEXT NOT NULL DEFAULT '[]',
        models_fetched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE role_assignments (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
        model TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id, role)
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        premise TEXT NOT NULL DEFAULT '',
        genre TEXT NOT NULL DEFAULT '',
        tone TEXT NOT NULL DEFAULT '',
        pov TEXT NOT NULL DEFAULT '',
        tense TEXT NOT NULL DEFAULT '',
        style_notes TEXT NOT NULL DEFAULT '',
        content_preferences TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        chapter_count INTEGER,
        target_chapter_words INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_settings (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        settings TEXT NOT NULL
      );

      CREATE TABLE prompt_templates (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE outline_revisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        chapters TEXT NOT NULL,
        source TEXT NOT NULL,
        raw_text TEXT,
        approved_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, version)
      );

      CREATE TABLE chapters (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        order_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        brief TEXT NOT NULL DEFAULT '',
        brief_approved INTEGER NOT NULL DEFAULT 0,
        current_revision_id TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE chapter_revisions (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        word_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        editable INTEGER NOT NULL DEFAULT 0,
        job_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (chapter_id, version)
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        incomplete INTEGER NOT NULL DEFAULT 0,
        job_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE generation_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        chapter_id TEXT,
        conversation_id TEXT,
        connection_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        context_json TEXT,
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        usage TEXT,
        revision_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE INDEX idx_chapters_project ON chapters(project_id, order_index);
      CREATE INDEX idx_chapter_revisions_chapter ON chapter_revisions(chapter_id, version);
      CREATE INDEX idx_outline_revisions_project ON outline_revisions(project_id, version);
      CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
      CREATE INDEX idx_jobs_project ON generation_jobs(project_id, created_at);
      CREATE INDEX idx_jobs_chapter ON generation_jobs(chapter_id, created_at);
    `);
  },
  () => {
    db.exec(`
      CREATE TABLE characters (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        identity TEXT NOT NULL DEFAULT '',
        appearance TEXT NOT NULL DEFAULT '',
        personality TEXT NOT NULL DEFAULT '',
        goals TEXT NOT NULL DEFAULT '',
        relationships TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE chapter_memory (
        chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        source_revision_id TEXT,
        source_content_hash TEXT NOT NULL DEFAULT '',
        source_word_count INTEGER NOT NULL DEFAULT 0,
        preceding_signature TEXT NOT NULL DEFAULT '',
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        job_id TEXT
      );

      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        fact_class TEXT NOT NULL DEFAULT 'established',
        statement TEXT NOT NULL,
        character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
        chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        scope_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        source_revision_id TEXT,
        source_content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        origin TEXT NOT NULL DEFAULT 'extracted',
        accepted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_characters_project ON characters(project_id, status, name COLLATE NOCASE);
      CREATE INDEX idx_chapter_memory_project ON chapter_memory(project_id);
      CREATE INDEX idx_facts_project ON facts(project_id, status, created_at);
      CREATE INDEX idx_facts_chapter ON facts(chapter_id);
      CREATE INDEX idx_facts_character ON facts(character_id);
    `);
  },
  () => {
    db.exec(`
      CREATE TABLE lorebooks (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE lorebook_links (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, lorebook_id)
      );

      CREATE TABLE lore_entries (
        id TEXT PRIMARY KEY,
        lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        triggers TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        always_include INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE lore_pins (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL REFERENCES lore_entries(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, entry_id)
      );

      CREATE TABLE prose_instructions (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_lorebooks_project ON lorebooks(project_id, name COLLATE NOCASE);
      CREATE INDEX idx_lorebook_links_project ON lorebook_links(project_id);
      CREATE INDEX idx_lore_entries_book ON lore_entries(lorebook_id, priority DESC);
      CREATE INDEX idx_prose_instructions_project ON prose_instructions(project_id, name COLLATE NOCASE);
    `);
  },
  () => {
    db.exec(`
      CREATE TABLE image_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT,
        settings TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE image_prompt_templates (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE image_assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        job_id TEXT,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        negative_prompt TEXT NOT NULL DEFAULT '',
        template_id TEXT,
        template_name TEXT,
        template_content TEXT NOT NULL DEFAULT '',
        connection_id TEXT,
        connection_name TEXT,
        provider_kind TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE image_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        connection_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        negative_prompt TEXT NOT NULL DEFAULT '',
        template_id TEXT,
        template_name TEXT,
        template_content TEXT NOT NULL DEFAULT '',
        settings TEXT NOT NULL DEFAULT '{}',
        remote_id TEXT,
        asset_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      ALTER TABLE characters ADD COLUMN portrait_asset_id TEXT REFERENCES image_assets(id) ON DELETE SET NULL;

      CREATE INDEX idx_image_connections_name ON image_connections(name COLLATE NOCASE);
      CREATE INDEX idx_image_templates_project ON image_prompt_templates(project_id, name COLLATE NOCASE);
      CREATE INDEX idx_image_jobs_character ON image_jobs(character_id, created_at);
      CREATE INDEX idx_image_jobs_project ON image_jobs(project_id, created_at);
      CREATE INDEX idx_image_assets_character ON image_assets(character_id, created_at);
      CREATE INDEX idx_image_assets_project ON image_assets(project_id, created_at);
    `);
  },
  () => {
    db.exec(`
      ALTER TABLE generation_jobs ADD COLUMN settings TEXT;
      ALTER TABLE generation_jobs ADD COLUMN pricing TEXT;
      ALTER TABLE generation_jobs ADD COLUMN estimated_cost REAL;
    `);
  },
  () => {
    db.exec(`
      CREATE TABLE chapter_batches (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        items TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE chapter_portrait_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        prompt_job_id TEXT NOT NULL,
        image_job_id TEXT,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_chapter_batches_project ON chapter_batches(project_id, created_at);
      CREATE INDEX idx_chapter_portrait_jobs_chapter ON chapter_portrait_jobs(chapter_id, created_at);
      CREATE INDEX idx_chapter_portrait_jobs_character ON chapter_portrait_jobs(character_id, created_at);
    `);
  },
  () => {
    db.exec(`ALTER TABLE image_assets ADD COLUMN selected_for_chapter INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX idx_selected_chapter_image ON image_assets(chapter_id, character_id)
      WHERE selected_for_chapter = 1 AND chapter_id IS NOT NULL;`);
  },
  () => {
    db.exec(`
      ALTER TABLE chapter_batches ADD COLUMN mode TEXT NOT NULL DEFAULT 'draft';

      CREATE TABLE portrait_batches (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        items TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_portrait_batches_project ON portrait_batches(project_id, created_at);
      CREATE INDEX idx_portrait_batches_character ON portrait_batches(character_id, created_at);
    `);
  },
];

/**
 * Take a consistent copy of the database before applying a later migration.
 * `VACUUM INTO` includes committed WAL content and cannot run inside a
 * transaction, so it happens before the migration loop opens one.
 */
function backupBeforeMigration(version: number): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupsDir, `pre-migration-v${version}-${stamp}.db`);
  try {
    const escaped = file.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    console.log(`[story-architect] pre-upgrade database backup written to ${file}`);
  } catch (error) {
    console.warn(
      `[story-architect] could not write a pre-upgrade database backup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function migrate(): void {
  const current = getUserVersion();
  if (current > 0 && current < migrations.length) {
    backupBeforeMigration(current);
  }
  for (let version = current; version < migrations.length; version++) {
    const migration = migrations[version];
    if (!migration) continue;
    db.exec('BEGIN');
    try {
      migration();
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function seed(): void {
  const settingsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('global') as
    | { value: string }
    | undefined;
  if (!settingsRow) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'global',
      JSON.stringify({ generation: DEFAULT_GENERATION }),
    );
  }

  const templateCount = db.prepare('SELECT COUNT(*) AS count FROM prompt_templates').get() as {
    count: number;
  };
  if (Number(templateCount.count) === 0) {
    const insert = db.prepare(
      `INSERT INTO prompt_templates (id, project_id, kind, name, content, is_default, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 1, ?, ?)`,
    );
    insert.run('tpl-outline-default', 'outline', 'Default outline prompt', OUTLINE_TEMPLATE_DEFAULT, now(), now());
    insert.run('tpl-prose-default', 'prose', 'Default prose prompt', PROSE_TEMPLATE_DEFAULT, now(), now());
  }

  const imageTemplateCount = db
    .prepare('SELECT COUNT(*) AS count FROM image_prompt_templates')
    .get() as { count: number };
  if (Number(imageTemplateCount.count) === 0) {
    db.prepare(
      `INSERT INTO image_prompt_templates (id, project_id, name, content, is_default, created_at, updated_at)
       VALUES (?, NULL, ?, ?, 1, ?, ?)`,
    ).run(
      'tpl-image-prompt-default',
      'Default character image prompt',
      IMAGE_PROMPT_TEMPLATE_DEFAULT,
      now(),
      now(),
    );
  }

  const interruptedAt = now();
  db.prepare(
    `UPDATE generation_jobs
     SET status = 'interrupted',
         error = COALESCE(error, 'The server restarted while this generation was running. Saved partial output is kept.'),
         finished_at = ?
     WHERE status IN ('queued', 'running')`,
  ).run(interruptedAt);

  db.prepare(
    `UPDATE image_jobs
     SET status = 'interrupted',
         error = COALESCE(error, 'The server restarted while this image was being generated. The prompt is kept so you can retry.'),
         finished_at = ?
     WHERE status IN ('queued', 'running')`,
  ).run(interruptedAt);

  // A batch only advances inside this process. After a restart nothing will
  // resume it, so surface it as interrupted rather than leaving it "running".
  db.prepare(
    `UPDATE chapter_batches
     SET status = 'interrupted',
         message = COALESCE(message, 'The server restarted while this batch was running. Drafted chapters are saved; start a new batch to continue.'),
         updated_at = ?
     WHERE status = 'running'`,
  ).run(interruptedAt);

  db.prepare(
    `UPDATE chapter_portrait_jobs
     SET status = 'interrupted',
         error = COALESCE(error, 'The server restarted while this portrait was being generated. The saved prompt and images are kept.'),
         updated_at = ?
     WHERE status IN ('prompting', 'imaging')`,
  ).run(interruptedAt);

  // Portrait batches advance in-process only, so a restart leaves nothing to
  // resume. Surface them as interrupted instead of "running" forever.
  db.prepare(
    `UPDATE portrait_batches
     SET status = 'interrupted',
         message = COALESCE(message, 'The server restarted while this portrait batch was running. Finished images are saved; start a new batch to continue.'),
         updated_at = ?
     WHERE status = 'running'`,
  ).run(interruptedAt);

  // Chat replies have no revision row, so surface any saved partial text as an
  // incomplete assistant message after an interrupted run.
  const interruptedChats = db
    .prepare(
      `SELECT id, conversation_id, output FROM generation_jobs
       WHERE kind = 'chat' AND status = 'interrupted' AND output != '' AND conversation_id IS NOT NULL`,
    )
    .all() as Array<{ id: string; conversation_id: string; output: string }>;
  for (const job of interruptedChats) {
    const existing = db
      .prepare('SELECT id FROM messages WHERE job_id = ?')
      .get(job.id) as { id: string } | undefined;
    if (existing) continue;
    const conversation = db
      .prepare('SELECT id FROM conversations WHERE id = ?')
      .get(job.conversation_id) as { id: string } | undefined;
    if (!conversation) continue;
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, incomplete, job_id, created_at)
       VALUES (?, ?, 'assistant', ?, 1, ?, ?)`,
    ).run(crypto.randomUUID(), job.conversation_id, job.output, job.id, interruptedAt);
  }
}

migrate();
seed();

export function dbAll<T>(sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function dbGet<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function dbRun(sql: string, ...params: Array<string | number | null>): void {
  db.prepare(sql).run(...params);
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function toBool(value: unknown): boolean {
  return Number(value) === 1;
}

export function timestamp(): string {
  return now();
}

export function schemaVersion(): number {
  return getUserVersion();
}

export function latestMigrationVersion(): number {
  return migrations.length;
}

export function closeDatabase(): void {
  try {
    db.close();
  } catch {
    // The database may already be closed during shutdown.
  }
}
