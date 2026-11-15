import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { APP_VERSION } from '../shared/version.js';
import { imagesDir } from './config.js';
import { dbAll, dbGet, dbRun, timestamp, transaction } from './db.js';
import { badRequest, notFound } from './errors.js';
import { getProject, type ProjectRow } from './store/projects.js';
import { imagesRoot, imageFilePath } from './store/images.js';
import { resolveImagePromptTemplate } from './store/image-templates.js';
import { resolvePromptTemplate } from './store/templates.js';
import { listChapters, getChapter } from './store/chapters.js';
import { inspectStoryState, saveStoryState, stateSource } from './store/story-state.js';
import type { StoryStateRow } from './store/story-state.js';

const BACKUP_FORMAT = 'story-architect-project';
const BACKUP_VERSION = 1;
const MAX_RESTORE_BYTES = 512 * 1024 * 1024;

interface OutlineRow {
  id: string;
  project_id: string;
  version: number;
  status: string;
  chapters: string;
  source: string;
  raw_text: string | null;
  approved_at: string | null;
  created_at: string;
}

interface ChapterRow {
  id: string;
  project_id: string;
  order_index: number;
  title: string;
  brief: string;
  brief_approved: number;
  current_revision_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  chapter_id: string;
  version: number;
  content: string;
  word_count: number;
  source: string;
  editable: number;
  job_id: string | null;
  created_at: string;
}

interface ConversationRow {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  incomplete: number;
  job_id: string | null;
  created_at: string;
}

interface CharacterRow {
  id: string;
  project_id: string;
  name: string;
  role: string;
  identity: string;
  appearance: string;
  personality: string;
  goals: string;
  relationships: string;
  notes: string;
  status: string;
  source: string;
  portrait_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryRow {
  chapter_id: string;
  project_id: string;
  summary: string;
  source_revision_id: string | null;
  source_content_hash: string;
  source_word_count: number;
  preceding_signature: string;
  generated_at: string;
  updated_at: string;
  job_id: string | null;
}

interface FactRow {
  id: string;
  project_id: string;
  kind: string;
  fact_class: string;
  statement: string;
  character_id: string | null;
  chapter_id: string | null;
  scope_chapter_id: string | null;
  source_revision_id: string | null;
  source_content_hash: string | null;
  status: string;
  origin: string;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LorebookRow {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface LoreEntryRow {
  id: string;
  lorebook_id: string;
  title: string;
  content: string;
  triggers: string;
  enabled: number;
  always_include: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

interface InstructionRow {
  id: string;
  project_id: string | null;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface PromptTemplateRow {
  id: string;
  project_id: string | null;
  kind: string;
  name: string;
  content: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface ImageTemplateRow {
  id: string;
  project_id: string | null;
  name: string;
  content: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface ImageAssetRow {
  selected_for_chapter?: number;
  id: string;
  project_id: string;
  character_id: string;
  chapter_id: string | null;
  job_id: string | null;
  file_name: string;
  mime_type: string;
  prompt: string;
  negative_prompt: string;
  template_id: string | null;
  template_name: string | null;
  template_content: string;
  connection_id: string | null;
  connection_name: string | null;
  provider_kind: string;
  settings: string;
  created_at: string;
}

interface ResolvedTemplateSnapshot {
  kind?: string;
  name: string;
  content: string;
  scope: 'project' | 'global' | 'builtin';
}

interface ProjectBackupManifest {
  format: string;
  version: number;
  appVersion: string;
  exportedAt: string;
  project: ProjectRow;
  projectSettings: { settings: string } | null;
  outlineRevisions: OutlineRow[];
  chapters: ChapterRow[];
  chapterRevisions: RevisionRow[];
  conversations: ConversationRow[];
  messages: MessageRow[];
  characters: CharacterRow[];
  chapterMemory: MemoryRow[];
  storyStates?: Array<{ chapter_id: string; content: string }>;
  facts: FactRow[];
  lorebooks: LorebookRow[];
  loreEntries: LoreEntryRow[];
  proseInstructions: InstructionRow[];
  promptTemplates: PromptTemplateRow[];
  resolvedPromptTemplates: ResolvedTemplateSnapshot[];
  imagePromptTemplates: ImageTemplateRow[];
  resolvedImagePromptTemplate: ResolvedTemplateSnapshot;
  imageAssets: Array<ImageAssetRow & { archivePath: string }>;
}

export interface ProjectBackupStats {
  chapters: number;
  revisions: number;
  characters: number;
  facts: number;
  loreEntries: number;
  conversations: number;
  images: number;
  missingImages: number;
}

export interface ProjectBackup {
  filename: string;
  bytes: Buffer;
  stats: ProjectBackupStats;
}

export interface RestoreResult {
  project: ReturnType<typeof getProject>;
  stats: ProjectBackupStats;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseOutlineChapters(raw: string): Array<{ id: string; title: string; brief: string }> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        title: typeof entry.title === 'string' ? entry.title : '',
        brief: typeof entry.brief === 'string' ? entry.brief : '',
      }))
      .filter((entry) => entry.id && entry.title);
  } catch {
    return [];
  }
}

function safeArchivePath(name: string): string {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
    throw badRequest('The backup contains an unsafe file path.');
  }
  return name;
}

function imageExtension(row: ImageAssetRow): string {
  const fromName = path.extname(row.file_name).replace(/^\./, '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(fromName)) return fromName;
  const byMime: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return byMime[row.mime_type] ?? 'png';
}

function archiveNameForAsset(row: ImageAssetRow): string {
  const extension = imageExtension(row);
  return `images/${row.id}.${extension}`;
}

export function createProjectBackup(projectId: string): ProjectBackup {
  const project = getProject(projectId);
  const projectRow = dbGet<ProjectRow>('SELECT * FROM projects WHERE id = ?', projectId);
  if (!projectRow) throw notFound('Project not found.');

  const projectSettings = dbGet<{ settings: string }>(
    'SELECT settings FROM project_settings WHERE project_id = ?',
    projectId,
  );
  const outlineRevisions = dbAll<OutlineRow>(
    'SELECT * FROM outline_revisions WHERE project_id = ? ORDER BY version',
    projectId,
  );
  const chapters = dbAll<ChapterRow>(
    'SELECT * FROM chapters WHERE project_id = ? ORDER BY order_index',
    projectId,
  );
  const chapterRevisions = dbAll<RevisionRow>(
    `SELECT r.* FROM chapter_revisions r
       JOIN chapters c ON c.id = r.chapter_id
      WHERE c.project_id = ?
      ORDER BY r.chapter_id, r.version`,
    projectId,
  );
  const conversations = dbAll<ConversationRow>(
    'SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at',
    projectId,
  );
  const messages = dbAll<MessageRow>(
    `SELECT m.* FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.project_id = ?
      ORDER BY m.created_at`,
    projectId,
  );
  const characters = dbAll<CharacterRow>(
    'SELECT * FROM characters WHERE project_id = ? ORDER BY created_at',
    projectId,
  );
  const chapterMemory = dbAll<MemoryRow>(
    'SELECT * FROM chapter_memory WHERE project_id = ? ORDER BY chapter_id',
    projectId,
  );
  const facts = dbAll<FactRow>(
    'SELECT * FROM facts WHERE project_id = ? ORDER BY created_at',
    projectId,
  );
  const lorebooks = dbAll<LorebookRow>(
    `SELECT b.* FROM lorebooks b
       JOIN lorebook_links l ON l.lorebook_id = b.id
      WHERE l.project_id = ?
      ORDER BY b.name COLLATE NOCASE`,
    projectId,
  );
  const bookIds = new Set(lorebooks.map((book) => book.id));
  const loreEntries = dbAll<LoreEntryRow>(
    `SELECT e.* FROM lore_entries e
       JOIN lorebook_links l ON l.lorebook_id = e.lorebook_id
      WHERE l.project_id = ?
      ORDER BY e.lorebook_id, e.priority DESC, e.title COLLATE NOCASE`,
    projectId,
  ).filter((entry) => bookIds.has(entry.lorebook_id));
  const proseInstructions = dbAll<InstructionRow>(
    'SELECT * FROM prose_instructions WHERE project_id = ? ORDER BY name COLLATE NOCASE',
    projectId,
  );
  const promptTemplates = dbAll<PromptTemplateRow>(
    'SELECT * FROM prompt_templates WHERE project_id = ? ORDER BY kind, name COLLATE NOCASE',
    projectId,
  );
  const imagePromptTemplates = dbAll<ImageTemplateRow>(
    'SELECT * FROM image_prompt_templates WHERE project_id = ? ORDER BY name COLLATE NOCASE',
    projectId,
  );
  const imageAssets = dbAll<ImageAssetRow>(
    'SELECT * FROM image_assets WHERE project_id = ? ORDER BY created_at',
    projectId,
  );

  const imageEntries: TarEntry[] = [];
  const exportedAssets: Array<ImageAssetRow & { archivePath: string }> = [];
  for (const asset of imageAssets) {
    try {
      const bytes = fs.readFileSync(imageFilePath(asset.file_name));
      const archivePath = archiveNameForAsset(asset);
      imageEntries.push({ name: archivePath, data: bytes });
      exportedAssets.push({ ...asset, archivePath });
    } catch {
      throw badRequest(
        `Backup could not be completed because an image file is missing or unreadable (${asset.id}). Restore the file or remove the image from its character gallery, then try again. No incomplete backup was created.`,
      );
    }
  }

  const resolvedPromptTemplates: ResolvedTemplateSnapshot[] = (['outline', 'prose'] as const).map(
    (kind) => {
      const resolved = resolvePromptTemplate(projectId, kind);
      return {
        kind,
        name: resolved.name,
        content: resolved.content,
        scope: resolved.scope,
      };
    },
  );
  const resolvedImage = resolveImagePromptTemplate(projectId);

  const manifest: ProjectBackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: APP_VERSION,
    exportedAt: timestamp(),
    project: projectRow,
    projectSettings: projectSettings ?? null,
    outlineRevisions,
    chapters,
    chapterRevisions,
    conversations,
    messages,
    characters,
    chapterMemory,
    storyStates: (() => {
      const prefix = inspectStoryState(projectId, Infinity).validPrefix;
      const through = prefix ? getChapter(prefix.chapter_id).orderIndex : -1;
      const validIds = new Set(listChapters(projectId).filter((chapter) => chapter.orderIndex <= through).map((chapter) => chapter.id));
      return dbAll<StoryStateRow>('SELECT * FROM story_states WHERE project_id = ?', projectId)
        .filter((row) => validIds.has(row.chapter_id)).map((row) => ({ chapter_id: row.chapter_id, content: row.content }));
    })(),
    facts,
    lorebooks,
    loreEntries,
    proseInstructions,
    promptTemplates,
    resolvedPromptTemplates,
    imagePromptTemplates,
    resolvedImagePromptTemplate: {
      name: resolvedImage.name,
      content: resolvedImage.content,
      scope: resolvedImage.scope,
    },
    imageAssets: exportedAssets,
  };

  const tar = writeTar([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ...imageEntries,
  ]);
  const bytes = zlib.gzipSync(tar, { level: 9 });
  const stats: ProjectBackupStats = {
    chapters: chapters.length,
    revisions: chapterRevisions.length,
    characters: characters.length,
    facts: facts.length,
    loreEntries: loreEntries.length,
    conversations: conversations.length,
    images: exportedAssets.length,
    missingImages: imageAssets.length - exportedAssets.length,
  };
  return {
    filename: `${slugify(project.title) || 'story-architect-project'}-backup.tar.gz`,
    bytes,
    stats,
  };
}

function assertManifest(value: unknown): ProjectBackupManifest {
  if (!value || typeof value !== 'object') throw badRequest('The backup manifest is missing.');
  const manifest = value as Partial<ProjectBackupManifest>;
  if (manifest.format !== BACKUP_FORMAT) {
    throw badRequest('This file is not a Story Architect project backup.');
  }
  if (!manifest.version || manifest.version > BACKUP_VERSION) {
    throw badRequest(
      'This backup was made by a newer version of Story Architect. Upgrade the server before restoring it.',
    );
  }
  if (!manifest.project || typeof manifest.project !== 'object' || !manifest.project.title) {
    throw badRequest('The backup does not contain a project.');
  }
  for (const key of [
    'outlineRevisions',
    'chapters',
    'chapterRevisions',
    'conversations',
    'messages',
    'characters',
    'chapterMemory',
    'facts',
    'lorebooks',
    'loreEntries',
    'proseInstructions',
    'promptTemplates',
    'imagePromptTemplates',
    'imageAssets',
  ] as const) {
    if (!Array.isArray(manifest[key])) {
      throw badRequest(`The backup is missing ${key}.`);
    }
  }
  return manifest as ProjectBackupManifest;
}

function newId(): string {
  return crypto.randomUUID();
}

function remapSignature(signature: string, chapterMap: Map<string, string>): string {
  if (!signature) return '';
  return signature
    .split('|')
    .map((part) => {
      const separator = part.indexOf(':');
      if (separator === -1) return part;
      const oldId = part.slice(0, separator);
      return `${chapterMap.get(oldId) ?? oldId}${part.slice(separator)}`;
    })
    .join('|');
}

export function restoreProjectBackup(body: Buffer): RestoreResult {
  if (!body || body.length === 0) throw badRequest('Choose a backup file to restore.');
  if (body.length > MAX_RESTORE_BYTES) throw badRequest('That backup is larger than 512 MB.');
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(body, { maxOutputLength: MAX_RESTORE_BYTES });
  } catch {
    throw badRequest('The backup file is not a valid gzipped archive, or it is too large.');
  }
  const entries = readTar(tar);
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) throw badRequest('The backup manifest is missing.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw badRequest('The backup manifest is not valid JSON.');
  }
  const manifest = assertManifest(parsed);

  const projectId = newId();
  const chapterMap = new Map<string, string>();
  for (const chapter of manifest.chapters) {
    if (chapter.id) chapterMap.set(chapter.id, newId());
  }
  for (const outline of manifest.outlineRevisions) {
    for (const chapter of parseOutlineChapters(outline.chapters)) {
      if (!chapterMap.has(chapter.id)) chapterMap.set(chapter.id, newId());
    }
  }
  const revisionMap = new Map(manifest.chapterRevisions.map((row) => [row.id, newId()]));
  const characterMap = new Map(manifest.characters.map((row) => [row.id, newId()]));
  const conversationMap = new Map(manifest.conversations.map((row) => [row.id, newId()]));
  const bookMap = new Map(manifest.lorebooks.map((row) => [row.id, newId()]));
  const entryMap = new Map(manifest.loreEntries.map((row) => [row.id, newId()]));
  const instructionMap = new Map(manifest.proseInstructions.map((row) => [row.id, newId()]));
  const promptTemplateMap = new Map(manifest.promptTemplates.map((row) => [row.id, newId()]));
  const imageTemplateMap = new Map(manifest.imagePromptTemplates.map((row) => [row.id, newId()]));
  const assetMap = new Map(manifest.imageAssets.map((row) => [row.id, newId()]));

  const mapChapter = (id: string | null): string | null =>
    id === null || id === undefined ? null : (chapterMap.get(id) ?? null);
  const mapRevision = (id: string | null): string | null =>
    id === null || id === undefined ? null : (revisionMap.get(id) ?? null);
  const mapCharacter = (id: string | null): string | null =>
    id === null || id === undefined ? null : (characterMap.get(id) ?? null);
  const mapAsset = (id: string | null): string | null =>
    id === null || id === undefined ? null : (assetMap.get(id) ?? null);

  const imageFiles: Array<{ absolute: string; bytes: Buffer }> = [];
  const storedAssets: Array<{ asset: ImageAssetRow; archivePath: string; relative: string }> = [];
  const portraitUpdates: Array<{ characterId: string; assetId: string }> = [];
  for (const character of manifest.characters) {
    const characterId = characterMap.get(character.id);
    const assetId = mapAsset(character.portrait_asset_id);
    if (characterId && assetId) portraitUpdates.push({ characterId, assetId });
  }
  for (const asset of manifest.imageAssets) {
    const newAssetId = assetMap.get(asset.id);
    if (!newAssetId) continue;
    const archivePath = safeArchivePath(asset.archivePath || archiveNameForAsset(asset));
    const bytes = entries.get(archivePath);
    if (!bytes) {
      throw badRequest(`The backup is missing the image file for "${asset.prompt.slice(0, 60)}".`);
    }
    const extension = imageExtension(asset);
    const relative = `${projectId}/${newAssetId}.${extension}`;
    imageFiles.push({ absolute: path.join(imagesRoot(), relative), bytes });
    storedAssets.push({ asset, archivePath, relative });
  }

  const projectImagesDir = path.join(imagesDir, projectId);
  if (imageFiles.length > 0) {
    fs.mkdirSync(projectImagesDir, { recursive: true });
    for (const file of imageFiles) fs.writeFileSync(file.absolute, file.bytes);
  }

  try {
    transaction(() => {
      const projectRow = manifest.project;
      const at = timestamp();
      dbRun(
        `INSERT INTO projects (
           id, title, premise, genre, tone, pov, tense, style_notes, content_preferences,
           instructions, chapter_count, target_chapter_words, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        projectId,
        projectRow.title,
        projectRow.premise ?? '',
        projectRow.genre ?? '',
        projectRow.tone ?? '',
        projectRow.pov ?? '',
        projectRow.tense ?? '',
        projectRow.style_notes ?? '',
        projectRow.content_preferences ?? '',
        projectRow.instructions ?? '',
        projectRow.chapter_count ?? null,
        projectRow.target_chapter_words ?? null,
        projectRow.created_at ?? at,
        at,
      );

      if (manifest.projectSettings) {
        dbRun(
          'INSERT INTO project_settings (project_id, settings) VALUES (?, ?)',
          projectId,
          manifest.projectSettings.settings,
        );
      }

      for (const outline of manifest.outlineRevisions) {
        const chapters = parseOutlineChapters(outline.chapters).map((chapter) => ({
          id: chapterMap.get(chapter.id) ?? chapter.id,
          title: chapter.title,
          brief: chapter.brief,
        }));
        dbRun(
          `INSERT INTO outline_revisions
             (id, project_id, version, status, chapters, source, raw_text, approved_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId(),
          projectId,
          outline.version,
          outline.status,
          JSON.stringify(chapters),
          outline.source,
          outline.raw_text,
          outline.approved_at,
          outline.created_at,
        );
      }

      for (const chapter of manifest.chapters) {
        const newChapterId = chapterMap.get(chapter.id) ?? newId();
        dbRun(
          `INSERT INTO chapters
             (id, project_id, order_index, title, brief, brief_approved, current_revision_id,
              status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newChapterId,
          projectId,
          chapter.order_index,
          chapter.title,
          chapter.brief ?? '',
          chapter.brief_approved ? 1 : 0,
          mapRevision(chapter.current_revision_id),
          chapter.status ?? 'planned',
          chapter.created_at,
          chapter.updated_at,
        );
      }

      for (const revision of manifest.chapterRevisions) {
        const chapterId = chapterMap.get(revision.chapter_id);
        if (!chapterId) continue;
        dbRun(
          `INSERT INTO chapter_revisions
             (id, chapter_id, version, content, word_count, source, editable, job_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          revisionMap.get(revision.id) ?? newId(),
          chapterId,
          revision.version,
          revision.content,
          revision.word_count,
          revision.source,
          revision.editable ? 1 : 0,
          revision.created_at,
        );
      }

      for (const conversation of manifest.conversations) {
        dbRun(
          'INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          conversationMap.get(conversation.id) ?? newId(),
          projectId,
          conversation.title,
          conversation.created_at,
          conversation.updated_at,
        );
      }

      for (const message of manifest.messages) {
        const conversationId = conversationMap.get(message.conversation_id);
        if (!conversationId) continue;
        dbRun(
          `INSERT INTO messages
             (id, conversation_id, role, content, incomplete, job_id, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
          newId(),
          conversationId,
          message.role,
          message.content,
          message.incomplete ? 1 : 0,
          message.created_at,
        );
      }

      for (const character of manifest.characters) {
        dbRun(
          `INSERT INTO characters (
             id, project_id, name, role, identity, appearance, personality, goals, relationships,
             notes, status, source, portrait_asset_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          characterMap.get(character.id) ?? newId(),
          projectId,
          character.name,
          character.role ?? '',
          character.identity ?? '',
          character.appearance ?? '',
          character.personality ?? '',
          character.goals ?? '',
          character.relationships ?? '',
          character.notes ?? '',
          character.status ?? 'active',
          character.source ?? 'manual',
          null,
          character.created_at,
          character.updated_at,
        );
      }

      for (const memory of manifest.chapterMemory) {
        const chapterId = chapterMap.get(memory.chapter_id);
        if (!chapterId) continue;
        dbRun(
          `INSERT INTO chapter_memory (
             chapter_id, project_id, summary, source_revision_id, source_content_hash,
             source_word_count, preceding_signature, generated_at, updated_at, job_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          chapterId,
          projectId,
          memory.summary,
          mapRevision(memory.source_revision_id),
          memory.source_content_hash ?? '',
          memory.source_word_count ?? 0,
          remapSignature(memory.preceding_signature ?? '', chapterMap),
          memory.generated_at,
          memory.updated_at,
        );
      }

      // Checkpoints use newly mapped revision/chapter IDs and a new parent
      // chain. Older backups simply rebuild them on the next generation.
      const restoredStates = new Map((Array.isArray(manifest.storyStates) ? manifest.storyStates : [])
        .map((state) => [chapterMap.get(state.chapter_id), state.content]));
      for (const chapter of listChapters(projectId).filter((entry) => entry.status === 'drafted')) {
        const content = restoredStates.get(chapter.id);
        if (!content) break;
        const parent = inspectStoryState(projectId, chapter.orderIndex).checkpoint;
        const signature = stateSource(chapter, parent?.version ?? null).signature;
        saveStoryState(chapter.id, content, signature, parent?.version ?? null);
      }

      for (const fact of manifest.facts) {
        dbRun(
          `INSERT INTO facts (
             id, project_id, kind, fact_class, statement, character_id, chapter_id,
             scope_chapter_id, source_revision_id, source_content_hash, status, origin,
             accepted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId(),
          projectId,
          fact.kind,
          fact.fact_class ?? 'established',
          fact.statement,
          mapCharacter(fact.character_id),
          mapChapter(fact.chapter_id),
          mapChapter(fact.scope_chapter_id),
          mapRevision(fact.source_revision_id),
          fact.source_content_hash,
          fact.status ?? 'proposed',
          fact.origin ?? 'extracted',
          fact.accepted_at,
          fact.created_at,
          fact.updated_at,
        );
      }

      for (const book of manifest.lorebooks) {
        const newBookId = bookMap.get(book.id) ?? newId();
        dbRun(
          `INSERT INTO lorebooks (id, project_id, name, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          newBookId,
          projectId,
          book.name,
          book.description ?? '',
          book.created_at,
          book.updated_at,
        );
        dbRun(
          'INSERT INTO lorebook_links (project_id, lorebook_id, created_at) VALUES (?, ?, ?)',
          projectId,
          newBookId,
          timestamp(),
        );
      }

      for (const entry of manifest.loreEntries) {
        const bookId = bookMap.get(entry.lorebook_id);
        if (!bookId) continue;
        dbRun(
          `INSERT INTO lore_entries (
             id, lorebook_id, title, content, triggers, enabled, always_include, priority,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          entryMap.get(entry.id) ?? newId(),
          bookId,
          entry.title,
          entry.content,
          entry.triggers ?? '[]',
          entry.enabled ? 1 : 0,
          entry.always_include ? 1 : 0,
          entry.priority ?? 0,
          entry.created_at,
          entry.updated_at,
        );
      }

      for (const instruction of manifest.proseInstructions) {
        dbRun(
          `INSERT INTO prose_instructions (id, project_id, name, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          instructionMap.get(instruction.id) ?? newId(),
          projectId,
          instruction.name,
          instruction.content,
          instruction.created_at,
          instruction.updated_at,
        );
      }

      for (const template of manifest.promptTemplates) {
        dbRun(
          `INSERT INTO prompt_templates
             (id, project_id, kind, name, content, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          promptTemplateMap.get(template.id) ?? newId(),
          projectId,
          template.kind,
          template.name,
          template.content,
          template.is_default ? 1 : 0,
          template.created_at,
          template.updated_at,
        );
      }

      // If the project relied on a global or built-in prompt without its own
      // default, preserve the effective prompt as a project-scoped copy.
      for (const kind of ['outline', 'prose'] as const) {
        const hasDefault = manifest.promptTemplates.some(
          (template) => template.kind === kind && template.is_default,
        );
        const resolved = manifest.resolvedPromptTemplates?.find((entry) => entry.kind === kind);
        if (!hasDefault && resolved && resolved.scope !== 'builtin') {
          dbRun(
            `INSERT INTO prompt_templates
               (id, project_id, kind, name, content, is_default, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
            newId(),
            projectId,
            kind,
            resolved.name,
            resolved.content,
            timestamp(),
            timestamp(),
          );
        }
      }

      for (const template of manifest.imagePromptTemplates) {
        dbRun(
          `INSERT INTO image_prompt_templates
             (id, project_id, name, content, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          imageTemplateMap.get(template.id) ?? newId(),
          projectId,
          template.name,
          template.content,
          template.is_default ? 1 : 0,
          template.created_at,
          template.updated_at,
        );
      }

      const hasImageDefault = manifest.imagePromptTemplates.some((template) => template.is_default);
      const resolvedImage = manifest.resolvedImagePromptTemplate;
      if (!hasImageDefault && resolvedImage && resolvedImage.scope !== 'builtin') {
        dbRun(
          `INSERT INTO image_prompt_templates
             (id, project_id, name, content, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          newId(),
          projectId,
          resolvedImage.name,
          resolvedImage.content,
          timestamp(),
          timestamp(),
        );
      }

      for (const stored of storedAssets) {
        const asset = stored.asset;
        const newAssetId = assetMap.get(asset.id) ?? newId();
        const characterId = mapCharacter(asset.character_id);
        if (!characterId) {
          throw badRequest('The backup contains an image without its character.');
        }
        const imageSettings = JSON.parse(asset.settings || '{}') as Record<string, unknown>;
        imageSettings.sourceRevisionId = mapRevision(typeof imageSettings.sourceRevisionId === 'string' ? imageSettings.sourceRevisionId : null);
        imageSettings.referenceAssetId = mapAsset(typeof imageSettings.referenceAssetId === 'string' ? imageSettings.referenceAssetId : null);
        dbRun(
          `INSERT INTO image_assets (
             id, project_id, character_id, chapter_id, job_id, file_name, mime_type, prompt,
             negative_prompt, template_id, template_name, template_content, connection_id,
             connection_name, provider_kind, settings, created_at
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          newAssetId,
          projectId,
          characterId,
          mapChapter(asset.chapter_id),
          stored.relative,
          asset.mime_type,
          asset.prompt,
          asset.negative_prompt ?? '',
          asset.template_id ? (imageTemplateMap.get(asset.template_id) ?? null) : null,
          asset.template_name,
          asset.template_content ?? '',
          asset.connection_name,
          asset.provider_kind,
          JSON.stringify(imageSettings),
          asset.created_at,
        );
        if (asset.selected_for_chapter === 1 && asset.chapter_id) {
          dbRun('UPDATE image_assets SET selected_for_chapter = 1 WHERE id = ?', newAssetId);
        }
      }

      for (const portrait of portraitUpdates) {
        dbRun(
          'UPDATE characters SET portrait_asset_id = ?, updated_at = ? WHERE id = ?',
          portrait.assetId,
          timestamp(),
          portrait.characterId,
        );
      }
    });
  } catch (error) {
    try {
      fs.rmSync(projectImagesDir, { recursive: true, force: true });
    } catch {
      // The database transaction already failed; leftover files are harmless.
    }
    throw error;
  }

  const project = getProject(projectId);
  return {
    project,
    stats: {
      chapters: manifest.chapters.length,
      revisions: manifest.chapterRevisions.length,
      characters: manifest.characters.length,
      facts: manifest.facts.length,
      loreEntries: manifest.loreEntries.length,
      conversations: manifest.conversations.length,
      images: storedAssets.length,
      missingImages: 0,
    },
  };
}

interface TarEntry {
  name: string;
  data: Buffer;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  header.write(`${text.slice(-(length - 1))}\0`, offset, length, 'ascii');
}

function writeTarHeader(name: string, size: number, mtimeMs: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const safeName = name.slice(0, 100);
  header.write(safeName, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(mtimeMs / 1000));
  header.fill(' ', 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('story-architect', 265, 32, 'ascii');
  header.write('story-architect', 297, 32, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  const mtime = Date.now();
  for (const entry of entries) {
    const name = safeArchivePath(entry.name);
    parts.push(writeTarHeader(name, entry.data.length, mtime));
    parts.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

function readString(header: Buffer, offset: number, length: number): string {
  return header.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '').trim();
}

function readTar(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = safeArchivePath(readString(header, 0, 100));
    const sizeText = readString(header, 124, 12);
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      throw badRequest('The backup archive is malformed.');
    }
    offset += 512;
    if (offset + size > buffer.length) throw badRequest('The backup archive is truncated.');
    entries.set(name, buffer.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}
