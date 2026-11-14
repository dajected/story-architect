import crypto from 'node:crypto';
import type { ChatMessage, ChatRole, Conversation } from '../../shared/types.js';
import { dbAll, dbGet, dbRun, timestamp } from '../db.js';
import { notFound } from '../errors.js';

interface ConversationRow {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: ChatRole;
  content: string;
  incomplete: number;
  job_id: string | null;
  created_at: string;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    messageCount: Number(row.message_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    incomplete: Number(row.incomplete) === 1,
    jobId: row.job_id,
    createdAt: row.created_at,
  };
}

export function listConversations(projectId: string): Conversation[] {
  const rows = dbAll<ConversationRow>(
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c WHERE c.project_id = ? ORDER BY c.updated_at DESC`,
    projectId,
  );
  return rows.map(mapConversation);
}

export function getConversation(id: string): Conversation {
  const row = dbGet<ConversationRow>(
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c WHERE c.id = ?`,
    id,
  );
  if (!row) throw notFound('Conversation not found.');
  return mapConversation(row);
}

export function createConversation(projectId: string, title = 'New conversation'): Conversation {
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    'INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id,
    projectId,
    title,
    at,
    at,
  );
  return getConversation(id);
}

export function deleteConversation(id: string): void {
  getConversation(id);
  dbRun('DELETE FROM conversations WHERE id = ?', id);
}

export function listMessages(conversationId: string): ChatMessage[] {
  const rows = dbAll<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    conversationId,
  );
  return rows.map(mapMessage);
}

export function addMessage(params: {
  conversationId: string;
  role: ChatRole;
  content: string;
  incomplete?: boolean;
  jobId?: string | null;
}): ChatMessage {
  const id = crypto.randomUUID();
  const at = timestamp();
  dbRun(
    `INSERT INTO messages (id, conversation_id, role, content, incomplete, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    params.conversationId,
    params.role,
    params.content,
    params.incomplete ? 1 : 0,
    params.jobId ?? null,
    at,
  );
  dbRun('UPDATE conversations SET updated_at = ? WHERE id = ?', at, params.conversationId);
  const row = dbGet<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
  if (!row) throw notFound('Message was not saved.');
  return mapMessage(row);
}

export function setConversationTitle(id: string, title: string): void {
  dbRun('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', title, timestamp(), id);
}
