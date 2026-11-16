import type {
  Chapter,
  ChapterBatch,
  ChapterBatchMode,
  ChapterDetail,
  ChapterMemory,
  ChapterPortraitOverview,
  ChapterPortraitRequest,
  ChapterRevision,
  Character,
  CharacterAppearance,
  CharacterImageOverview,
  CharacterInput,
  ChatMessage,
  ConnectionKind,
  ConnectionPublic,
  ContextInfo,
  Conversation,
  Fact,
  FactInput,
  GenerationHistory,
  GenerationHistoryEntry,
  GenerationJob,
  ImageConnectionInput,
  ImageConnectionPublic,
  ImageJob,
  ImageAsset,
  ImagePromptTemplate,
  ImageProviderSettings,
  LoreEntry,
  LoreEntryInput,
  LoreOverview,
  Lorebook,
  MemoryOverview,
  ModelOption,
  ModelProviderOption,
  OutlineChapter,
  OutlineRevision,
  PortraitBatch,
  Project,
  ProjectSettings,
  ProseInstruction,
  PromptTemplate,
  ResolvedRole,
  RewriteAction,
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

  if (method !== 'GET') window.dispatchEvent(new Event('refresh-work-queue'));
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
  generationSources?: Record<string,string>;
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

export interface ChapterRewriteInput {
  action: RewriteAction;
  selection: string;
  start: number;
  end: number;
  instruction?: string;
}

export interface LorebookInput {
  name: string;
  description?: string;
}

export interface ImagePromptExpansionInput {
  moment?: 'start' | 'end' | 'custom';
  chapterId?: string | null;
  templateId?: string | null;
  scene?: string;
  clothing?: string;
  visualStyle?: string;
  instructions?: string;
}

export interface ImageGenerationInput {
  moment?: 'start' | 'end' | 'custom';
  sourceRevisionId?: string | null;
  sourceTextHash?: string;
  referenceAssetId?: string | null;
  connectionId: string;
  prompt: string;
  negativePrompt?: string;
  chapterId?: string | null;
  templateId?: string | null;
  templateName?: string | null;
  templateContent?: string | null;
}

export interface ChapterPortraitInput {
  moment?: 'start' | 'end' | 'custom';
  scene?: string;
  visualStyle?: string;
  characterId: string;
  connectionId?: string | null;
  templateId?: string | null;
  instructions?: string;
}

export interface PortraitBatchInput {
  moment?: 'start' | 'end' | 'custom';
  scene?: string;
  visualStyle?: string;
  connectionId?: string | null;
  templateId?: string | null;
  instructions?: string;
  skipExisting?: boolean;
  selectForChapter?: boolean;
}

export interface ImageTemplateInput {
  projectId: string | null;
  name: string;
  content: string;
  isDefault?: boolean;
}

export interface RestoreProjectResponse {
  project: Project;
  stats: {
    chapters: number;
    revisions: number;
    characters: number;
    facts: number;
    loreEntries: number;
    conversations: number;
    images: number;
  };
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
  getModelProviders: (id: string, model: string) =>
    request<{ providers: ModelProviderOption[] }>(
      'GET',
      `/connections/${id}/model-providers?model=${encodeURIComponent(model)}`,
    ).then((r) => r.providers),

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
    assignments: Array<{ role: TaskRole; connectionId: string | null; model: string | null; providerSlug?: string | null }>;
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
  deleteProject: (id: string) => request<void>('DELETE', `/projects/${id}`),
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
  backupUrl: (id: string) => `/api/projects/${id}/backup`,
  getProjectQueue: (id: string) => request<{ jobs: GenerationHistoryEntry[]; chapterBatch: ChapterBatch | null; portraitBatches: PortraitBatch[]; characters: Pick<Character, 'id' | 'name'>[] }>('GET', `/projects/${id}/queue`),
  getGenerationHistory: (id: string, limit = 200) =>
    request<GenerationHistory>(
      'GET',
      `/projects/${id}/generation-history?limit=${encodeURIComponent(String(limit))}`,
    ),
  restoreProject: async (file: File): Promise<RestoreProjectResponse> => {
    const response = await fetch('/api/projects/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file,
    });
    if (!response.ok) {
      let message = `Restore failed (${response.status}).`;
      try {
        const data = (await response.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // Keep the fallback message.
      }
      throw new ApiError(response.status, message);
    }
    return (await response.json()) as RestoreProjectResponse;
  },

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
  getChapterBatch: (projectId: string) =>
    request<{ batch: ChapterBatch | null }>(
      'GET',
      `/projects/${projectId}/chapter-batch`,
    ).then((r) => r.batch),
  startChapterBatch: (projectId: string, mode: ChapterBatchMode = 'draft') =>
    request<{ batch: ChapterBatch }>('POST', `/projects/${projectId}/chapter-batch`, {
      mode,
    }).then((r) => r.batch),
  cancelChapterBatch: (projectId: string) =>
    request<{ batch: ChapterBatch }>(
      'POST',
      `/projects/${projectId}/chapter-batch/cancel`,
    ).then((r) => r.batch),
  getContextInfo: (chapterId: string, preset?: ContextPreset) =>
    request<ContextInfo>(
      'GET',
      `/chapters/${chapterId}/context${preset ? `?preset=${preset}` : ''}`,
    ),
  rewriteChapter: (chapterId: string, input: ChapterRewriteInput) =>
    request<{ job: GenerationJob }>('POST', `/chapters/${chapterId}/rewrite`, input).then(
      (r) => r.job,
    ),
  applyRewrite: (jobId: string, replacement?: string) =>
    request<{ revisionId: string; chapterId: string; chapter: ChapterDetail }>(
      'POST',
      `/jobs/${jobId}/apply-rewrite`,
      replacement === undefined ? {} : { replacement },
    ),
  reviewChapter: (chapterId: string) =>
    request<{ job: GenerationJob }>('POST', `/chapters/${chapterId}/review`).then((r) => r.job),
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

  // Lore
  getLore: (projectId: string) => request<LoreOverview>('GET', `/projects/${projectId}/lore`),
  createLorebook: (projectId: string, input: LorebookInput) =>
    request<{ lorebook: Lorebook }>('POST', `/projects/${projectId}/lorebooks`, input).then(
      (r) => r.lorebook,
    ),
  updateLorebook: (projectId: string, bookId: string, input: Partial<LorebookInput>) =>
    request<{ lorebook: Lorebook }>(
      'PATCH',
      `/projects/${projectId}/lorebooks/${bookId}`,
      input,
    ).then((r) => r.lorebook),
  deleteLorebook: (projectId: string, bookId: string) =>
    request<{ result: { deleted: boolean } }>(
      'DELETE',
      `/projects/${projectId}/lorebooks/${bookId}`,
    ).then((r) => r.result),
  linkLorebook: (projectId: string, bookId: string) =>
    request<{ lorebook: Lorebook }>(
      'POST',
      `/projects/${projectId}/lorebooks/${bookId}/link`,
    ).then((r) => r.lorebook),
  unlinkLorebook: (projectId: string, bookId: string) =>
    request<void>('POST', `/projects/${projectId}/lorebooks/${bookId}/unlink`),
  createLoreEntry: (projectId: string, bookId: string, input: LoreEntryInput) =>
    request<{ entry: LoreEntry }>(
      'POST',
      `/projects/${projectId}/lorebooks/${bookId}/entries`,
      input,
    ).then((r) => r.entry),
  updateLoreEntry: (projectId: string, entryId: string, input: Partial<LoreEntryInput>) =>
    request<{ entry: LoreEntry }>(
      'PATCH',
      `/projects/${projectId}/lore-entries/${entryId}`,
      input,
    ).then((r) => r.entry),
  deleteLoreEntry: (projectId: string, entryId: string) =>
    request<void>('DELETE', `/projects/${projectId}/lore-entries/${entryId}`),
  setLorePins: (projectId: string, entryIds: string[]) =>
    request<{ pinnedEntryIds: string[] }>('PUT', `/projects/${projectId}/lore/pins`, {
      entryIds,
    }).then((r) => r.pinnedEntryIds),
  clearLorePins: (projectId: string) =>
    request<void>('DELETE', `/projects/${projectId}/lore/pins`),

  // Saved prose instructions
  listProseInstructions: (projectId: string) =>
    request<{ instructions: ProseInstruction[] }>(
      'GET',
      `/projects/${projectId}/prose-instructions`,
    ).then((r) => r.instructions),
  createProseInstruction: (projectId: string, input: { name: string; text: string }) =>
    request<{ instruction: ProseInstruction }>(
      'POST',
      `/projects/${projectId}/prose-instructions`,
      input,
    ).then((r) => r.instruction),
  updateProseInstruction: (projectId: string, id: string, input: { name?: string; text?: string }) =>
    request<{ instruction: ProseInstruction }>(
      'PATCH',
      `/projects/${projectId}/prose-instructions/${id}`,
      input,
    ).then((r) => r.instruction),
  deleteProseInstruction: (projectId: string, id: string) =>
    request<void>('DELETE', `/projects/${projectId}/prose-instructions/${id}`),

  // Image connections and prompt templates
  listImageConnections: () =>
    request<{ connections: ImageConnectionPublic[] }>('GET', '/image-connections').then(
      (r) => r.connections,
    ),
  createImageConnection: (input: ImageConnectionInput) =>
    request<{ connection: ImageConnectionPublic }>('POST', '/image-connections', input).then(
      (r) => r.connection,
    ),
  updateImageConnection: (id: string, input: Partial<ImageConnectionInput>) =>
    request<{ connection: ImageConnectionPublic }>(
      'PATCH',
      `/image-connections/${id}`,
      input,
    ).then((r) => r.connection),
  deleteImageConnection: (id: string) =>
    request<void>('DELETE', `/image-connections/${id}`),
  testImageConnection: (id: string) =>
    request<{ ok: boolean; message: string }>('POST', `/image-connections/${id}/test`),

  listImageTemplates: (projectId?: string) =>
    request<{ templates: ImagePromptTemplate[] }>(
      'GET',
      `/image-prompt-templates${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ).then((r) => r.templates),
  createImageTemplate: (input: ImageTemplateInput) =>
    request<{ template: ImagePromptTemplate }>('POST', '/image-prompt-templates', input).then(
      (r) => r.template,
    ),
  updateImageTemplate: (
    id: string,
    input: { name?: string; content?: string; isDefault?: boolean },
  ) =>
    request<{ template: ImagePromptTemplate }>('PATCH', `/image-prompt-templates/${id}`, input).then(
      (r) => r.template,
    ),
  deleteImageTemplate: (id: string) =>
    request<void>('DELETE', `/image-prompt-templates/${id}`),
  setDefaultImageTemplate: (id: string) =>
    request<{ template: ImagePromptTemplate }>(
      'POST',
      `/image-prompt-templates/${id}/default`,
    ).then((r) => r.template),

  // Character images
  applyReviewCorrection: (id:string,input:{jobId:string;expectedContent:string;passage:string;replacement:string}) => request<{chapter:ChapterDetail}>('POST',`/chapters/${id}/review-correction`,input).then(r=>r.chapter),
  saveVisualStyle: (id:string,visualStyle:string) => request<void>('PATCH', `/projects/${id}/visual-style`, {visualStyle}),
  resetProjectGeneration: (id: string) => request<void>('DELETE', `/projects/${id}/generation-settings`),
  listProjectImages: (id: string) => request<{assets: ImageAsset[]}>('GET', `/projects/${id}/images`).then(r => r.assets),
  selectChapterImage: (chapterId: string, assetId: string) => request<{asset: ImageAsset}>('POST', `/chapters/${chapterId}/selected-image`, {assetId}).then(r => r.asset),
  getCharacterImages: (characterId: string) =>
    request<CharacterImageOverview>('GET', `/characters/${characterId}/images`),
  getChapterPortraits: (chapterId: string) =>
    request<ChapterPortraitOverview>('GET', `/chapters/${chapterId}/portraits`),
  listCharacterAppearances: (characterId: string) =>
    request<{ appearances: CharacterAppearance[] }>('GET', `/characters/${characterId}/appearances`)
      .then(data => data.appearances),
  saveChapterAppearance: (chapterId: string, characterId: string, appearance: string) =>
    request<{ appearance: CharacterAppearance }>(
      'PATCH',
      `/chapters/${chapterId}/appearances/${characterId}`,
      { appearance },
    ).then((r) => r.appearance),
  startChapterPortrait: (chapterId: string, input: ChapterPortraitInput) =>
    request<{ request: ChapterPortraitRequest }>(
      'POST',
      `/chapters/${chapterId}/portraits`,
      input,
    ).then((r) => r.request),
  cancelChapterPortrait: (requestId: string) =>
    request<{ request: ChapterPortraitRequest }>(
      'POST',
      `/chapter-portrait-requests/${requestId}/cancel`,
    ).then((r) => r.request),
  getCharacterPortraitBatch: (characterId: string) =>
    request<{ batch: PortraitBatch | null }>(
      'GET',
      `/characters/${characterId}/portrait-batch`,
    ).then((r) => r.batch),
  startCharacterPortraitBatch: (characterId: string, input: PortraitBatchInput = {}) =>
    request<{ batch: PortraitBatch }>(
      'POST',
      `/characters/${characterId}/portrait-batch`,
      input,
    ).then((r) => r.batch),
  cancelPortraitBatch: (batchId: string) =>
    request<{ batch: PortraitBatch }>(
      'POST',
      `/portrait-batches/${batchId}/cancel`,
    ).then((r) => r.batch),
  expandImagePrompt: (characterId: string, input: ImagePromptExpansionInput) =>
    request<{ job: GenerationJob }>('POST', `/characters/${characterId}/images/prompt`, input).then(
      (r) => r.job,
    ),
  generateCharacterImage: (characterId: string, input: ImageGenerationInput) =>
    request<{ job: ImageJob }>('POST', `/characters/${characterId}/images`, input).then(
      (r) => r.job,
    ),
  getImageJob: (jobId: string) =>
    request<{ job: ImageJob }>('GET', `/image-jobs/${jobId}`).then((r) => r.job),
  cancelImageJob: (jobId: string) =>
    request<{ job: ImageJob }>('POST', `/image-jobs/${jobId}/cancel`).then((r) => r.job),
  retryImageJob: (jobId: string) =>
    request<{ job: ImageJob }>('POST', `/image-jobs/${jobId}/retry`).then((r) => r.job),
  setCharacterPortrait: (characterId: string, assetId: string | null) =>
    request<{ character: Character }>('POST', `/characters/${characterId}/portrait`, {
      assetId,
    }).then((r) => r.character),
  deleteImageAsset: (assetId: string) => request<void>('DELETE', `/image-assets/${assetId}`),
};

export type { ImageProviderSettings };
