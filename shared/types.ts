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
  memory: 'Writes chapter summaries, proposes continuity facts, and casts characters from the outline.',
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
    description:
      'The brief, key character facts and the last summary or two, with a short run of recent prose.',
    budgetTokens: 4000,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description:
      'The default. Chapter summaries, active characters and continuity facts plus a few pages of recent prose.',
    budgetTokens: 8000,
  },
  {
    id: 'broad',
    label: 'Broad',
    description:
      'A larger memory and prose window for sweeping continuity across many chapters.',
    budgetTokens: 16000,
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

export type GenerationJobKind = 'outline' | 'chapter' | 'chat' | 'memory' | 'characters';

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

export type CharacterStatus = 'proposed' | 'active' | 'archived';

export type CharacterSource = 'manual' | 'outline' | 'memory';

export interface Character {
  id: string;
  projectId: string;
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
  factCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterInput {
  name: string;
  role?: string;
  identity?: string;
  appearance?: string;
  personality?: string;
  goals?: string;
  relationships?: string;
  notes?: string;
}

export type MemoryStatus = 'current' | 'stale' | 'missing' | 'pending' | 'empty';

export interface ChapterMemory {
  chapterId: string;
  projectId: string;
  chapterTitle: string;
  orderIndex: number;
  wordCount: number;
  summary: string | null;
  sourceRevisionId: string | null;
  sourceWordCount: number;
  generatedAt: string | null;
  updatedAt: string | null;
  status: MemoryStatus;
  staleReasons: string[];
  activeJobId: string | null;
  proposedFactCount: number;
}

export type FactKind =
  | 'character_development'
  | 'relationship'
  | 'timeline'
  | 'plot_thread'
  | 'world';

export const FACT_KIND_LABELS: Record<FactKind, string> = {
  character_development: 'Character development',
  relationship: 'Relationship',
  timeline: 'Timeline event',
  plot_thread: 'Unresolved thread',
  world: 'World detail',
};

/** Authored world facts, established events, and future plans are kept distinct. */
export type FactClass = 'authored' | 'established' | 'plan';

export const FACT_CLASS_LABELS: Record<FactClass, string> = {
  authored: 'World fact',
  established: 'Established',
  plan: 'Plan',
};

export type FactStatus = 'proposed' | 'established' | 'superseded' | 'rejected';

export type FactOrigin = 'authored' | 'extracted';

export interface Fact {
  id: string;
  projectId: string;
  kind: FactKind;
  factClass: FactClass;
  statement: string;
  characterId: string | null;
  characterName: string | null;
  chapterId: string | null;
  chapterTitle: string | null;
  chapterOrder: number | null;
  scopeChapterId: string | null;
  scopeChapterTitle: string | null;
  scopeChapterOrder: number | null;
  sourceRevisionId: string | null;
  sourceOutdated: boolean;
  status: FactStatus;
  origin: FactOrigin;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactInput {
  kind?: FactKind;
  factClass?: FactClass;
  statement?: string;
  characterId?: string | null;
  scopeChapterId?: string | null;
  chapterId?: string | null;
}

export interface MemoryCounts {
  chapters: number;
  current: number;
  stale: number;
  missing: number;
  pending: number;
  proposedFacts: number;
  establishedFacts: number;
  outdatedFacts: number;
  activeCharacters: number;
  proposedCharacters: number;
}

export interface MemoryOverview {
  projectId: string;
  chapters: ChapterMemory[];
  characters: Character[];
  facts: Fact[];
  counts: MemoryCounts;
  activeJobs: GenerationJob[];
  recentJobs: GenerationJob[];
  memoryRole: { connectionId: string; connectionName: string | null; model: string } | null;
}

export interface ContextSection {
  id: string;
  label: string;
  tokens: number;
  included: boolean;
  detail: string;
  note?: string;
}

export interface ContextInfo {
  preset: ContextPreset;
  budgetTokens: number;
  reservedOutputTokens: number;
  availableInputTokens: number;
  requiredTokens: number;
  estimatedTokens: number;
  totalEstimatedTokens: number;
  tokenEstimate: 'approximate';
  model: {
    connectionName: string | null;
    model: string | null;
    contextLength: number | null;
  };
  sections: ContextSection[];
  warnings: string[];
  includedWords: number;
  includedChapters: number;
  omittedChapters: number;
  staleSummaries: number;
  pendingFacts: number;
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
