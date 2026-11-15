export type ConnectionKind = 'openrouter' | 'openai-compatible';

export type TaskRole = 'default' | 'outline' | 'prose' | 'memory' | 'image_prompt';

export const TASK_ROLES: TaskRole[] = ['default', 'outline', 'prose', 'memory', 'image_prompt'];

export const ROLE_LABELS: Record<TaskRole, string> = {
  default: 'Default model',
  outline: 'Outline',
  prose: 'Prose',
  memory: 'Continuity',
  image_prompt: 'Image prompt',
};

export const ROLE_HINTS: Record<TaskRole, string> = {
  default: 'Used by any task that has no override.',
  outline: 'Plans the novel and its chapter outline.',
  prose: 'Drafts chapters and powers the assistant chat.',
  memory: 'Writes chapter summaries, proposes continuity facts, and casts characters from the outline.',
  image_prompt: 'Expands character image templates into a final prompt for an image service.',
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
      'Current story state, the chapter brief, a few relevant references and a short prose handoff.',
    budgetTokens: 3000,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description:
      'Current story state with relevant characters, continuity facts and the preceding chapter’s ending.',
    budgetTokens: 4000,
  },
  {
    id: 'broad',
    label: 'Broad',
    description:
      'The same compact story state, with room for more relevant references and a longer handoff.',
    budgetTokens: 5000,
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
  maxOutputTokens?: number;
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

export type ChapterRevisionSource =
  | 'generated'
  | 'edited'
  | 'restored'
  | 'recovered'
  | 'rewrite'
  | 'imported';

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

export type GenerationJobKind =
  | 'outline'
  | 'chapter'
  | 'chat'
  | 'memory'
  | 'characters'
  | 'rewrite'
  | 'review'
  | 'image_prompt'
  /** Image-service runs from the separate image job queue; shown in the history log. */
  | 'image';

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
  reasoningTokens?: number;
}

/** Sampling settings captured when a job is created, for the generation log. */
export interface JobSettingsSnapshot {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  contextPreset?: ContextPreset;
  targetWords?: number | null;
}

/** Cached provider pricing, in USD per token, captured with the job. */
export interface JobPricing {
  promptPerToken: number;
  completionPerToken: number;
  currency: 'USD';
}

export interface RequestBudgetInfo {
  requestCount?: number;
  contextLength: number;
  contextLengthKnown: boolean;
  inputBudgetTokens: number;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  safetyTokens: number;
  sections: Array<{ label: string; included: boolean; trimmed: boolean; tokens: number }>;
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
  settings: JobSettingsSnapshot | null;
  requestBudget?: RequestBudgetInfo | null;
  pricing: JobPricing | null;
  estimatedCost: number | null;
  revisionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface GenerationHistoryEntry {
  id: string;
  kind: GenerationJobKind;
  status: GenerationJobStatus;
  model: string;
  connectionName: string | null;
  chapterId: string | null;
  chapterTitle: string | null;
  chapterOrder: number | null;
  /** What the job was about, e.g. the character name for image runs. */
  subject?: string | null;
  settings: JobSettingsSnapshot | null;
  requestBudget?: RequestBudgetInfo | null;
  usage: TokenUsage | null;
  estimatedCost: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface GenerationHistorySummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  active: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Null when no completed job had usable provider pricing. */
  estimatedCost: number | null;
  pricedJobs: number;
  unpricedJobs: number;
}

export interface GenerationHistory {
  projectId: string;
  entries: GenerationHistoryEntry[];
  summary: GenerationHistorySummary;
  limit: number;
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
  portraitAssetId: string | null;
  portraitUrl: string | null;
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

export interface Lorebook {
  id: string;
  name: string;
  description: string;
  /** Project that owns the book, or null for a shared book. */
  projectId: string | null;
  /** True when the current project owns this book. */
  owned: boolean;
  entryCount: number;
  linkedProjectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LoreEntry {
  id: string;
  lorebookId: string;
  lorebookName: string;
  title: string;
  content: string;
  triggers: string[];
  enabled: boolean;
  alwaysInclude: boolean;
  priority: number;
  /** True when this entry is pinned for the next generation in the current project. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoreEntryInput {
  title: string;
  content: string;
  triggers?: string[];
  enabled?: boolean;
  alwaysInclude?: boolean;
  priority?: number;
}

export interface LoreOverview {
  projectId: string;
  books: Lorebook[];
  entries: LoreEntry[];
  pinnedEntryIds: string[];
  /** Books that exist elsewhere and can be linked to this novel. */
  unlinkedBooks: Lorebook[];
}

export type LoreActivationReason = 'manual' | 'always' | 'keyword' | 'budget';

export interface ContextLoreEntry {
  id: string;
  title: string;
  lorebookName: string;
  tokens: number;
  reason: LoreActivationReason;
  matched: string[];
}

export interface ContextLore {
  entries: ContextLoreEntry[];
  activated: number;
  omitted: number;
  totalEntries: number;
  triggeredEntries: number;
  budgetTokens: number;
  usedTokens: number;
}

export type RewriteAction = 'rewrite' | 'expand' | 'shorten' | 'style';

export const REWRITE_ACTION_LABELS: Record<RewriteAction, string> = {
  rewrite: 'Rewrite',
  expand: 'Expand',
  shorten: 'Shorten',
  style: 'Adjust style',
};

export interface RewriteRequest {
  action: RewriteAction;
  selection: string;
  start: number;
  end: number;
  instruction?: string;
}

export interface ProseInstruction {
  id: string;
  projectId: string | null;
  name: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export type ImageConnectionKind = 'openai-images' | 'comfyui';

export const IMAGE_CONNECTION_LABELS: Record<ImageConnectionKind, string> = {
  'openai-images': 'OpenAI Images API',
  comfyui: 'ComfyUI',
};

/** Per-connection image provider settings. Image credentials stay separate from text connections. */
export interface ImageProviderSettings {
  sourceRevisionId?: string | null;
  sourceTextHash?: string;
  moment?: 'start' | 'end' | 'custom';
  referenceAssetId?: string | null;
  /** ComfyUI LoadImage node to receive a reference uploaded to /upload/image. */
  referenceNode?: string;
  referenceInput?: string;
  /** OpenAI Images model such as gpt-image-1 or dall-e-3. */
  model?: string;
  size?: string;
  quality?: string;
  /** ComfyUI API-format workflow JSON. */
  workflow?: string;
  promptNode?: string;
  promptInput?: string;
  negativeNode?: string;
  negativeInput?: string;
  seedNode?: string;
  seedInput?: string;
  outputNode?: string;
  timeoutSeconds?: number;
}

export interface ImageConnectionPublic {
  id: string;
  name: string;
  kind: ImageConnectionKind;
  baseUrl: string;
  hasApiKey: boolean;
  settings: ImageProviderSettings;
  createdAt: string;
  updatedAt: string;
}

export interface ImageConnectionInput {
  name: string;
  kind: ImageConnectionKind;
  baseUrl: string;
  apiKey?: string | null;
  settings?: ImageProviderSettings;
}

export interface ImagePromptTemplate {
  id: string;
  projectId: string | null;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export const IMAGE_TEMPLATE_VARIABLES: Array<{ name: string; description: string }> = [
  { name: 'novel_title', description: 'Novel title.' },
  { name: 'genre', description: 'Genre.' },
  { name: 'tone', description: 'Tone.' },
  { name: 'project_style', description: 'The novel’s style notes.' },
  { name: 'character_name', description: 'Character name.' },
  { name: 'character_role', description: 'Character role.' },
  { name: 'identity', description: 'Character identity.' },
  { name: 'appearance', description: 'Character appearance, including lasting physical details.' },
  { name: 'clothing', description: 'Clothing or outfit supplied for this image.' },
  { name: 'personality', description: 'Character personality.' },
  { name: 'goals', description: 'Character goals.' },
  { name: 'notes', description: 'Character notes.' },
  { name: 'scene', description: 'Scene or moment supplied for this image.' },
  { name: 'chapter_title', description: 'Selected chapter title.' },
  { name: 'chapter_brief', description: 'Selected chapter brief.' },
  { name: 'visual_style', description: 'Visual style supplied for this image.' },
  { name: 'additional_instructions', description: 'Extra instructions for this image.' },
];

export type ImageJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface ImageJob {
  id: string;
  projectId: string;
  characterId: string;
  chapterId: string | null;
  connectionId: string;
  providerKind: ImageConnectionKind;
  status: ImageJobStatus;
  prompt: string;
  negativePrompt: string;
  templateId: string | null;
  templateName: string | null;
  templateContent: string;
  settings: ImageProviderSettings;
  remoteId: string | null;
  assetId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ImageAsset {
  selectedForChapter: boolean;
  sourceOutdated: boolean;
  id: string;
  projectId: string;
  characterId: string;
  chapterId: string | null;
  jobId: string | null;
  url: string;
  mimeType: string;
  prompt: string;
  negativePrompt: string;
  templateId: string | null;
  templateName: string | null;
  templateContent: string;
  connectionId: string | null;
  connectionName: string | null;
  providerKind: ImageConnectionKind;
  settings: ImageProviderSettings;
  createdAt: string;
}

export interface CharacterImageOverview {
  visualStyle?: string;
  character: Character;
  assets: ImageAsset[];
  jobs: ImageJob[];
  activeJob: ImageJob | null;
  connections: ImageConnectionPublic[];
  templates: ImagePromptTemplate[];
  imagePromptRole: ResolvedRole | null;
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
  storyState?: StoryStateInfo;
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
  lore: ContextLore;
  includedWords: number;
  includedChapters: number;
  omittedChapters: number;
  staleSummaries: number;
  pendingFacts: number;
}

export interface StoryStateInfo {
  status: 'empty' | 'current' | 'missing' | 'stale';
  throughChapterId: string | null;
  throughChapterNumber: number | null;
  version: string | null;
  text: string;
}

export type ChapterBatchItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface ChapterBatchItem {
  chapterId: string;
  orderIndex: number;
  title: string;
  status: ChapterBatchItemStatus;
  jobId: string | null;
  revisionId: string | null;
  error: string | null;
}

export type ChapterBatchStatus = 'running' | 'completed' | 'cancelled' | 'interrupted';

/**
 * `draft` fills chapters that are still empty; `regenerate` re-drafts every
 * chapter and makes each new draft the current one, keeping old drafts in the
 * revision history.
 */
export type ChapterBatchMode = 'draft' | 'regenerate';

/** A sequential "draft every chapter" run for one project. */
export interface ChapterBatch {
  id: string;
  projectId: string;
  mode: ChapterBatchMode;
  status: ChapterBatchStatus;
  items: ChapterBatchItem[];
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChapterPortraitStatus =
  | 'prompting'
  | 'imaging'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** One character portrait generated against a specific chapter's end state. */
export interface ChapterPortraitRequest {
  id: string;
  projectId: string;
  chapterId: string;
  characterId: string;
  status: ChapterPortraitStatus;
  promptJobId: string;
  imageJobId: string | null;
  prompt: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PortraitBatchItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PortraitBatchItem {
  chapterId: string;
  orderIndex: number;
  title: string;
  status: PortraitBatchItemStatus;
  /** The chapter portrait request that produced (or is producing) this image. */
  requestId: string | null;
  /** The image asset saved for this chapter, once it finishes. */
  assetId: string | null;
  error: string | null;
}

export type PortraitBatchStatus = ChapterBatchStatus;

/**
 * A sequential run that draws one named character across every chapter of a
 * project. Each image is generated from that chapter's own ending, one chapter
 * at a time, because a character can only have one portrait in flight.
 */
export interface PortraitBatch {
  id: string;
  projectId: string;
  characterId: string;
  status: PortraitBatchStatus;
  items: PortraitBatchItem[];
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterPortraitCandidate {
  character: Character;
  /** Whole-word mentions of the character's name in the chapter text. */
  mentionCount: number;
  /** Images already generated for this character in this chapter. */
  assets: ImageAsset[];
  activeRequest: ChapterPortraitRequest | null;
  latestRequest: ChapterPortraitRequest | null;
}

export interface ChapterPortraitOverview {
  requests: ChapterPortraitRequest[];
  visualStyle?: string;
  chapterId: string;
  chapterTitle: string;
  chapterNumber: number;
  hasText: boolean;
  /** Cast members named in the chapter, most-mentioned first. */
  named: ChapterPortraitCandidate[];
  /** Other non-archived cast members, for a manual pick. */
  others: Character[];
  /** Every image already generated for this chapter. */
  assets: ImageAsset[];
  /** Portraits currently building or drawing for this chapter. */
  activeRequests: ChapterPortraitRequest[];
  connections: ImageConnectionPublic[];
  templates: ImagePromptTemplate[];
  imagePromptRole: ResolvedRole | null;
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
