export type ConnectionKind = 'openrouter' | 'openai-compatible';

export type TaskRole = 'default' | 'outline' | 'prose' | 'memory' | 'image_prompt';

export const TASK_ROLES: TaskRole[] = ['default', 'outline', 'prose', 'memory', 'image_prompt'];

export const ROLE_LABELS: Record<TaskRole, string> = {
  default: 'Default model',
  outline: 'Outline',
  prose: 'Prose',
  memory: 'Memory',
  image_prompt: 'Image prompt',
};

export const ROLE_HINTS: Record<TaskRole, string> = {
  default: 'Used by any task that has no override.',
  outline: 'Plans the novel and its chapter outline.',
  prose: 'Drafts chapters and powers the assistant chat.',
  memory: 'Reserved for summaries and continuity once stage 2 ships.',
  image_prompt: 'Reserved for image prompt expansion once stage 4 ships.',
};

export type ContextPreset = 'focused' | 'balanced' | 'broad';

export interface ContextPresetInfo {
  id: ContextPreset;
  label: string;
  description: string;
  /** Approximate input budget for the chapter brief plus recent prose. */
  budgetTokens: number;
}

export const CONTEXT_PRESETS: ContextPresetInfo[] = [
  {
    id: 'focused',
    label: 'Focused',
    description: 'Project instructions, the current brief and a short run of recent prose.',
    budgetTokens: 2500,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'The default. A few pages of recent prose alongside the brief.',
    budgetTokens: 6000,
  },
  {
    id: 'broad',
    label: 'Broad',
    description: 'A larger slice of preceding prose for sweeping continuity.',
    budgetTokens: 12000,
  },
];

export const DEFAULT_GENERATION = {
  temperature: 0.8,
  topP: null as number | null,
  maxTokens: null as number | null,
  contextPreset: 'balanced' as ContextPreset,
  targetWords: 1800,
};

export interface GenerationSettings {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  contextPreset: ContextPreset;
  targetWords: number | null;
}

export interface ModelOption {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: string;
  completionPrice?: string;
}

export interface ConnectionPublic {
  id: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  hasApiKey: boolean;
  models: ModelOption[];
  modelsFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleAssignment {
  role: TaskRole;
  connectionId: string | null;
  model: string | null;
}

export interface ResolvedRole extends RoleAssignment {
  connectionName: string | null;
  source: 'project' | 'global' | 'default' | 'unset';
}

export interface GlobalSettings {
  generation: GenerationSettings;
}

export interface ProjectSettings {
  generation: GenerationSettings;
  roles: ResolvedRole[];
}

export type ProjectStatus = 'active' | 'archived';

export interface Project {
  id: string;
  title: string;
  premise: string;
  genre: string;
  tone: string;
  pov: string;
  tense: string;
  styleNotes: string;
  contentPreferences: string;
  instructions: string;
  chapterCount: number | null;
  targetChapterWords: number | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  chapterTotal: number;
  currentWords: number;
  outlineStatus: OutlineStatus;
}

export type OutlineStatus = 'none' | 'draft' | 'approved';

export interface OutlineChapter {
  id: string;
  title: string;
  brief: string;
}

export type OutlineRevisionStatus = 'draft' | 'approved' | 'superseded';

export interface OutlineRevision {
  id: string;
  projectId: string;
  version: number;
  status: OutlineRevisionStatus;
  chapters: OutlineChapter[];
  source: 'generated' | 'edited' | 'manual';
  rawText: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export type ChapterStatus = 'planned' | 'drafted';

export interface Chapter {
  id: string;
  projectId: string;
  orderIndex: number;
  title: string;
  brief: string;
  briefApproved: boolean;
  status: ChapterStatus;
  wordCount: number;
  currentRevisionId: string | null;
  updatedAt: string;
}

export type ChapterRevisionSource = 'generated' | 'edited' | 'restored' | 'recovered' | 'imported';

export interface ChapterRevision {
  id: string;
  chapterId: string;
  version: number;
  content: string;
  wordCount: number;
  source: ChapterRevisionSource;
  editable: boolean;
  jobId: string | null;
  createdAt: string;
}

export interface ChapterRevisionMeta extends Omit<ChapterRevision, 'content'> {
  preview: string;
}

export interface ChapterDetail extends Chapter {
  content: string;
  revisions: ChapterRevisionMeta[];
  latestJob: GenerationJob | null;
}

export type GenerationJobKind = 'outline' | 'chapter' | 'chat';

export type GenerationJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface GenerationJob {
  id: string;
  projectId: string;
  kind: GenerationJobKind;
  status: GenerationJobStatus;
  chapterId: string | null;
  conversationId: string | null;
  connectionId: string;
  model: string;
  output: string;
  error: string | null;
  usage: TokenUsage | null;
  revisionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  incomplete: boolean;
  jobId: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export type PromptTemplateKind = 'outline' | 'prose';

export interface PromptTemplate {
  id: string;
  projectId: string | null;
  kind: PromptTemplateKind;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDraft {
  title: string;
  premise: string;
  genre: string;
  tone: string;
  pov: string;
  tense: string;
  styleNotes: string;
  contentPreferences: string;
  instructions: string;
  chapterCount: string;
  targetChapterWords: string;
}

export const EMPTY_PROJECT_DRAFT: ProjectDraft = {
  title: '',
  premise: '',
  genre: '',
  tone: '',
  pov: '',
  tense: '',
  styleNotes: '',
  contentPreferences: '',
  instructions: '',
  chapterCount: '',
  targetChapterWords: '',
};

export const POV_OPTIONS = [
  'First person',
  'Second person',
  'Third person limited',
  'Third person omniscient',
  'Multiple viewpoints',
];

export const TENSE_OPTIONS = ['Past tense', 'Present tense'];
