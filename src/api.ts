import type {
  Chapter,
  ChapterDetail,
  ChapterMemory,
  ChapterRevision,
  Character,
  CharacterInput,
  ChatMessage,
  ConnectionKind,
  ConnectionPublic,
  ContextInfo,
  Conversation,
  Fact,
  FactInput,
  GenerationJob,
  MemoryOverview,
  ModelOption,
  OutlineChapter,
  OutlineRevision,
  Project,
  ProjectSettings,
  PromptTemplate,
  ResolvedRole,
  RoleAssignment,
  GenerationSettings,
  ContextPreset,
  TaskRole,
} from '@shared/types';

export type { ContextInfo } from '@shared/types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Keep the fallback message.
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface OutlineResponse {
  revisions: OutlineRevision[];
  latest: OutlineRevision | null;
  activeJob: GenerationJob | null;
  lastJob: GenerationJob | null;
}

export interface MessagesResponse {
  conversation: Conversation;
  messages: ChatMessage[];
  activeJob: GenerationJob | null;
}

export interface SettingsResponse {
  generation: GenerationSettings;
  roles: ResolvedRole[];
  assignments: RoleAssignment[];
}

export interface ProjectSettingsResponse {
  generation: GenerationSettings;
  roles: ResolvedRole[];
  templates: PromptTemplate[];
}

export interface ConnectionInput {
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  apiKey?: string | null;
}

export interface TemplateInput {
  projectId: string | null;
  kind: 'outline' | 'prose';
  name: string;
  content: string;
  isDefault?: boolean;
}

export interface ChapterGenerateInput {
  instructions?: string;
  contextPreset?: ContextPreset;
  targetWords?: number | null;
}

export const api = {
  // Connections
  listConnections: () =>
    request<{ connections: ConnectionPublic[] }>('GET', '/connections').then((r) => r.connections),
  createConnection: (input: ConnectionInput) =>
    request<{ connection: ConnectionPublic }>('POST', '/connections', input).then((r) => r.connection),
  updateConnection: (id: string, input: Partial<ConnectionInput>) =>
    request<{ connection: ConnectionPublic }>('PATCH', `/connections/${id}`, input).then(
      (r) => r.connection,
    ),
  deleteConnection: (id: string) => request<void>('DELETE', `/connections/${id}`),
  testConnection: (id: string) =>
    request<{ ok: boolean; message: string; models: ModelOption[] }>(
      'POST',
      `/connections/${id}/test`,
    ),
  refreshModels: (id: string) =>
    request<{ connection: ConnectionPublic; models: ModelOption[] }>(
      'POST',
      `/connections/${id}/refresh-models`,
    ),

  // Global settings and roles
  getSettings: () => request<SettingsResponse>('GET', '/settings'),
  updateSettings: (generation: Partial<GenerationSettings>) =>
    request<{ generation: GenerationSettings; roles: ResolvedRole[] }>('PATCH', '/settings', {
      generation,
    }),
  getModelRoles: (projectId?: string) =>
    request<{ roles: ResolvedRole[]; assignments: RoleAssignment[] }>(
      'GET',
      `/model-roles${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  setModelRoles: (params: {
    scope: 'global' | 'project';
    projectId?: string;
    assignments: Array<{ role: TaskRole; connectionId: string | null; model: string | null }>;
  }) => request<{ roles: ResolvedRole[] }>('PUT', '/model-roles', params),

  // Prompt templates
  listTemplates: (projectId?: string) =>
    request<{ templates: PromptTemplate[] }>(
      'GET',
      `/templates${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ).then((r) => r.templates),
  createTemplate: (input: TemplateInput) =>
    request<{ template: PromptTemplate }>('POST', '/templates', input).then((r) => r.template),
  updateTemplate: (id: string, input: { name?: string; content?: string; isDefault?: boolean }) =>
    request<{ template: PromptTemplate }>('PATCH', `/templates/${id}`, input).then(
      (r) => r.template,
    ),
  deleteTemplate: (id: string) => request<void>('DELETE', `/templates/${id}`),
  setDefaultTemplate: (id: string) =>
    request<{ template: PromptTemplate }>('POST', `/templates/${id}/default`).then(
      (r) => r.template,
    ),
  suggest: (field: string, draft: Record<string, string>, currentChapterCount?: number) =>
    request<{ value: string }>('POST', '/suggest', { field, draft, currentChapterCount }).then(
      (r) => r.value,
    ),

  // Projects
  listProjects: (includeArchived = false) =>
    request<{ projects: Project[] }>(
      'GET',
      `/projects${includeArchived ? '?includeArchived=1' : ''}`,
    ).then((r) => r.projects),
  createProject: (input: Record<string, unknown>) =>
    request<{ project: Project }>('POST', '/projects', input).then((r) => r.project),
  getProject: (id: string) =>
    request<{ project: Project }>('GET', `/projects/${id}`).then((r) => r.project),
  updateProject: (id: string, input: Record<string, unknown>) =>
    request<{ project: Project }>('PATCH', `/projects/${id}`, input).then((r) => r.project),
  archiveProject: (id: string) =>
    request<{ project: Project }>('POST', `/projects/${id}/archive`).then((r) => r.project),
  unarchiveProject: (id: string) =>
    request<{ project: Project }>('POST', `/projects/${id}/unarchive`).then((r) => r.project),
  getProjectSettings: (id: string) =>
    request<ProjectSettingsResponse>('GET', `/projects/${id}/settings`),
  updateProjectSettings: (id: string, generation: Partial<GenerationSettings>) =>
    request<{ generation: GenerationSettings }>('PATCH', `/projects/${id}/settings`, {
      generation,
    }).then((r) => r.generation),
  exportUrl: (id: string) => `/api/projects/${id}/export.md`,

  // Outline
  getOutline: (projectId: string) => request<OutlineResponse>('GET', `/projects/${projectId}/outline`),
  generateOutline: (projectId: string, instructions?: string) =>
    request<{ job: GenerationJob }>('POST', `/projects/${projectId}/outline/generate`, {
      instructions,
    }).then((r) => r.job),
  createManualOutline: (projectId: string) =>
    request<{ revision: OutlineRevision }>('POST', `/projects/${projectId}/outline/manual`).then(
      (r) => r.revision,
    ),
  saveOutline: (projectId: string, chapters: OutlineChapter[], revisionId?: string) =>
    request<{ revision: OutlineRevision }>('PUT', `/projects/${projectId}/outline`, {
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        brief: chapter.brief,
      })),
      revisionId,
    }).then((r) => r.revision),
  approveOutline: (projectId: string, revisionId: string) =>
    request<{ revision: OutlineRevision }>(
      'POST',
      `/projects/${projectId}/outline/${revisionId}/approve`,
    ).then((r) => r.revision),

  // Chapters and revisions
  listChapters: (projectId: string) =>
    request<{ chapters: Chapter[] }>('GET', `/projects/${projectId}/chapters`).then(
      (r) => r.chapters,
    ),
  getChapter: (chapterId: string) =>
    request<{ chapter: ChapterDetail }>('GET', `/chapters/${chapterId}`).then((r) => r.chapter),
  saveChapterContent: (chapterId: string, content: string) =>
    request<{ chapter: ChapterDetail }>('PUT', `/chapters/${chapterId}/content`, { content }).then(
      (r) => r.chapter,
    ),
  appendToChapter: (chapterId: string, text: string) =>
    request<{ chapter: ChapterDetail }>('POST', `/chapters/${chapterId}/append`, { text }).then(
      (r) => r.chapter,
    ),
  generateChapter: (chapterId: string, input: ChapterGenerateInput) =>
    request<{ job: GenerationJob }>('POST', `/chapters/${chapterId}/generate`, input).then(
      (r) => r.job,
    ),
  getContextInfo: (chapterId: string, preset?: ContextPreset) =>
    request<ContextInfo>(
      'GET',
      `/chapters/${chapterId}/context${preset ? `?preset=${preset}` : ''}`,
    ),
  getRevision: (revisionId: string) =>
    request<{ revision: ChapterRevision }>('GET', `/revisions/${revisionId}`).then(
      (r) => r.revision,
    ),
  useRevision: (revisionId: string) =>
    request<{ chapter: ChapterDetail }>('POST', `/revisions/${revisionId}/use`).then(
      (r) => r.chapter,
    ),
  restoreRevision: (revisionId: string) =>
    request<{ revision: ChapterRevision; chapter: ChapterDetail }>(
      'POST',
      `/revisions/${revisionId}/restore`,
    ),

  // Jobs
  getJob: (jobId: string) =>
    request<{ job: GenerationJob }>('GET', `/jobs/${jobId}`).then((r) => r.job),
  cancelJob: (jobId: string) =>
    request<{ job: GenerationJob }>('POST', `/jobs/${jobId}/cancel`).then((r) => r.job),
  applyPartialJob: (jobId: string) =>
    request<{ revisionId: string; applied: boolean; chapterId: string; chapter: ChapterDetail }>(
      'POST',
      `/jobs/${jobId}/apply-partial`,
    ),
  jobStreamUrl: (jobId: string) => `/api/jobs/${jobId}/stream`,

  // Chat
  listConversations: (projectId: string) =>
    request<{ conversations: Conversation[] }>('GET', `/projects/${projectId}/conversations`).then(
      (r) => r.conversations,
    ),
  createConversation: (projectId: string) =>
    request<{ conversation: Conversation }>('POST', `/projects/${projectId}/conversations`, {}).then(
      (r) => r.conversation,
    ),
  deleteConversation: (conversationId: string) =>
    request<void>('DELETE', `/conversations/${conversationId}`),
  getMessages: (conversationId: string) =>
    request<MessagesResponse>('GET', `/conversations/${conversationId}/messages`),
  sendMessage: (conversationId: string, content: string, chapterId?: string | null) =>
    request<{ job: GenerationJob; messageId: string; conversation: Conversation }>(
      'POST',
      `/conversations/${conversationId}/messages`,
      { content, chapterId },
    ),

  // Characters
  listCharacters: (projectId: string) =>
    request<{ characters: Character[]; activeJob: GenerationJob | null }>(
      'GET',
      `/projects/${projectId}/characters`,
    ),
  createCharacter: (projectId: string, input: CharacterInput) =>
    request<{ character: Character }>('POST', `/projects/${projectId}/characters`, input).then(
      (r) => r.character,
    ),
  updateCharacter: (id: string, input: Partial<CharacterInput>) =>
    request<{ character: Character }>('PATCH', `/characters/${id}`, input).then(
      (r) => r.character,
    ),
  acceptCharacter: (id: string) =>
    request<{ character: Character }>('POST', `/characters/${id}/accept`).then(
      (r) => r.character,
    ),
  archiveCharacter: (id: string) =>
    request<{ character: Character }>('POST', `/characters/${id}/archive`).then(
      (r) => r.character,
    ),
  proposeCharacters: (projectId: string) =>
    request<{ job: GenerationJob }>('POST', `/projects/${projectId}/characters/propose`).then(
      (r) => r.job,
    ),

  // Memory and continuity
  getProjectMemory: (projectId: string) =>
    request<MemoryOverview>('GET', `/projects/${projectId}/memory`),
  getChapterMemory: (chapterId: string) =>
    request<{ memory: ChapterMemory; activeJob: GenerationJob | null }>(
      'GET',
      `/chapters/${chapterId}/memory`,
    ),
  rebuildChapterMemory: (chapterId: string) =>
    request<{ job: GenerationJob }>('POST', `/chapters/${chapterId}/memory/rebuild`).then(
      (r) => r.job,
    ),
  rebuildMemory: (projectId: string, chapterIds?: string[]) =>
    request<{ jobs: GenerationJob[] }>('POST', `/projects/${projectId}/memory/rebuild`, {
      chapterIds,
    }).then((r) => r.jobs),
  saveChapterMemorySummary: (chapterId: string, summary: string) =>
    request<{ memory: ChapterMemory }>('PATCH', `/chapters/${chapterId}/memory`, {
      summary,
    }).then((r) => r.memory),
  createFact: (projectId: string, input: FactInput) =>
    request<{ fact: Fact }>('POST', `/projects/${projectId}/memory/facts`, input).then(
      (r) => r.fact,
    ),
  updateFact: (id: string, input: Partial<FactInput>) =>
    request<{ fact: Fact }>('PATCH', `/facts/${id}`, input).then((r) => r.fact),
  acceptFact: (id: string) =>
    request<{ fact: Fact }>('POST', `/facts/${id}/accept`).then((r) => r.fact),
  rejectFact: (id: string) =>
    request<{ fact: Fact }>('POST', `/facts/${id}/reject`).then((r) => r.fact),
  supersedeFact: (id: string) =>
    request<{ fact: Fact }>('POST', `/facts/${id}/supersede`).then((r) => r.fact),
  deleteFact: (id: string) => request<void>('DELETE', `/facts/${id}`),
  supersedeOutdatedFacts: (projectId: string) =>
    request<{ count: number }>('POST', `/projects/${projectId}/memory/supersede-outdated`).then(
      (r) => r.count,
    ),
};
