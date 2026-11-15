import crypto from 'node:crypto';
import type {
  Character,
  CharacterInput,
  CharacterSource,
  CharacterStatus,
} from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { getProjectRow, touchProject } from './projects.js';

export interface CharacterRow {
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
  status: CharacterStatus;
  source: CharacterSource;
  key_character: number;
  portrait_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CharacterQueryRow extends CharacterRow {
  fact_count: number;
}

function mapCharacter(row: CharacterQueryRow): Character {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    role: row.role,
    identity: row.identity,
    appearance: row.appearance,
    personality: row.personality,
    goals: row.goals,
    relationships: row.relationships,
    notes: row.notes,
    status: row.status,
    source: row.source,
    keyCharacter: Number(row.key_character) === 1,
    factCount: Number(row.fact_count ?? 0),
    portraitAssetId: row.portrait_asset_id ?? null,
    portraitUrl: row.portrait_asset_id
      ? `/api/image-assets/${row.portrait_asset_id}/file`
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const characterSelect = `
  SELECT c.*,
    (SELECT COUNT(*) FROM facts f
      WHERE f.character_id = c.id AND f.status IN ('proposed', 'established')) AS fact_count
  FROM characters c
`;

export function listCharacters(projectId: string): Character[] {
  getProjectRow(projectId);
  // Bring characters created by the old proposal workflow into the cast.
  dbRun("UPDATE characters SET status = 'active', updated_at = ? WHERE project_id = ? AND status = 'proposed'", timestamp(), projectId);
  const rows = dbAll<CharacterQueryRow>(
    `${characterSelect} WHERE c.project_id = ? ORDER BY
       CASE c.status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
       c.name COLLATE NOCASE`,
    projectId,
  );
  return rows.map(mapCharacter);
}

export function getCharacterRow(id: string): CharacterRow {
  const row = dbGet<CharacterRow>('SELECT * FROM characters WHERE id = ?', id);
  if (!row) throw notFound('Character not found.');
  return row;
}

export function getCharacter(id: string): Character {
  const row = dbGet<CharacterQueryRow>(`${characterSelect} WHERE c.id = ?`, id);
  if (!row) throw notFound('Character not found.');
  return mapCharacter(row);
}

export function findCharacterByName(projectId: string, name: string): Character | null {
  const row = dbGet<CharacterQueryRow>(
    `${characterSelect} WHERE c.project_id = ? AND c.name = ? COLLATE NOCASE`,
    projectId,
    name.trim(),
  );
  return row ? mapCharacter(row) : null;
}

function clean(value: string | undefined, max: number, label: string): string {
  const text = (value ?? '').trim();
  if (text.length > max) throw badRequest(`${label} must be ${max} characters or fewer.`);
  return text;
}

export function createCharacter(
  projectId: string,
  input: CharacterInput,
  options: { status?: CharacterStatus; source?: CharacterSource } = {},
): Character {
  getProjectRow(projectId);
  const name = clean(input.name, 160, 'Character name');
  if (!name) throw badRequest('A character name is required.');
  if (findCharacterByName(projectId, name)) {
    throw badRequest(`A character named "${name}" already exists in this novel.`);
  }
  const id = crypto.randomUUID();
  const at = timestamp();
  const status = options.status ?? 'active';
  dbRun(
    `INSERT INTO characters (
       id, project_id, name, role, identity, appearance, personality, goals, relationships,
       notes, status, source, key_character, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    projectId,
    name,
    clean(input.role, 120, 'Character role'),
    clean(input.identity, 4000, 'Identity'),
    clean(input.appearance, 4000, 'Appearance'),
    clean(input.personality, 4000, 'Personality'),
    clean(input.goals, 4000, 'Goals'),
    clean(input.relationships, 4000, 'Relationships'),
    clean(input.notes, 8000, 'Character notes'),
    status,
    options.source ?? 'manual',
    input.keyCharacter ? 1 : 0,
    at,
    at,
  );
  touchProject(projectId);
  return getCharacter(id);
}

export function updateCharacter(id: string, input: Partial<CharacterInput>): Character {
  const current = getCharacterRow(id);
  const name = input.name === undefined ? current.name : clean(input.name, 160, 'Character name');
  if (!name) throw badRequest('A character name is required.');
  const duplicate = dbGet<{ id: string }>(
    'SELECT id FROM characters WHERE project_id = ? AND name = ? COLLATE NOCASE AND id != ?',
    current.project_id,
    name,
    id,
  );
  if (duplicate) throw badRequest(`A character named "${name}" already exists in this novel.`);

  dbRun(
    `UPDATE characters SET
       name = ?, role = ?, identity = ?, appearance = ?, personality = ?, goals = ?,
       relationships = ?, notes = ?, key_character = ?, updated_at = ?
     WHERE id = ?`,
    name,
    input.role === undefined ? current.role : clean(input.role, 120, 'Character role'),
    input.identity === undefined ? current.identity : clean(input.identity, 4000, 'Identity'),
    input.appearance === undefined
      ? current.appearance
      : clean(input.appearance, 4000, 'Appearance'),
    input.personality === undefined
      ? current.personality
      : clean(input.personality, 4000, 'Personality'),
    input.goals === undefined ? current.goals : clean(input.goals, 4000, 'Goals'),
    input.relationships === undefined
      ? current.relationships
      : clean(input.relationships, 4000, 'Relationships'),
    input.notes === undefined ? current.notes : clean(input.notes, 8000, 'Character notes'),
    input.keyCharacter === undefined
      ? current.key_character
      : input.keyCharacter
        ? 1
        : 0,
    timestamp(),
    id,
  );
  touchProject(current.project_id);
  return getCharacter(id);
}

export function setCharacterStatus(id: string, status: CharacterStatus): Character {
  const current = getCharacterRow(id);
  if (!['proposed', 'active', 'archived'].includes(status)) {
    throw badRequest('Unknown character status.');
  }
  dbRun('UPDATE characters SET status = ?, updated_at = ? WHERE id = ?', status, timestamp(), id);
  touchProject(current.project_id);
  return getCharacter(id);
}

/**
 * Store characters proposed by the outline casting pass. Names that already
 * exist in the project are skipped so proposals never overwrite the author's
 * cast.
 */
export function addProposedCharacters(
  projectId: string,
  input: CharacterInput[],
  source: CharacterSource = 'outline',
): Character[] {
  getProjectRow(projectId);
  const created: Character[] = [];
  for (const entry of input) {
    const name = (entry.name ?? '').trim();
    if (!name) continue;
    if (findCharacterByName(projectId, name)) continue;
    try {
      created.push(
        createCharacter(projectId, { ...entry, name }, { status: 'active', source }),
      );
    } catch {
      // A malformed proposal should not abort the rest of the cast.
    }
  }
  return created;
}

export function setCharacterPortrait(id: string, assetId: string | null): Character {
  const current = getCharacterRow(id);
  if (assetId) {
    const asset = dbGet<{ id: string; character_id: string }>(
      'SELECT id, character_id FROM image_assets WHERE id = ?',
      assetId,
    );
    if (!asset) throw badRequest('That image does not exist.');
    if (asset.character_id !== id) {
      throw badRequest('That image belongs to another character.');
    }
  }
  dbRun(
    'UPDATE characters SET portrait_asset_id = ?, updated_at = ? WHERE id = ?',
    assetId,
    timestamp(),
    id,
  );
  touchProject(current.project_id);
  return getCharacter(id);
}

export function activeCharacters(projectId: string): Character[] {
  const rows = dbAll<CharacterQueryRow>(
    `${characterSelect} WHERE c.project_id = ? AND c.status = 'active' ORDER BY c.name COLLATE NOCASE`,
    projectId,
  );
  return rows.map(mapCharacter);
}
