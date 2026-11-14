# Stage 1–2 implementation notes

Status: stages 1 and 2 implemented and runnable. These notes are for maintainers
and the next stage; the product requirements live in
[PRODUCT_PLAN.md](PRODUCT_PLAN.md).

## Layout

| Path | Contents |
| --- | --- |
| `server/` | Express API, provider adapters, generation jobs, persistence. |
| `server/store/` | Small data-access modules for each aggregate. |
| `server/routes/` | HTTP routes grouped by area. |
| `shared/` | Types, defaults, word counting, and context presets used by both sides. |
| `src/` | React interface, API client, job streaming hook, components, styles. |
| `docs/` | Product plan and these notes. |

The server is compiled with `tsc` to `dist-server/`, including the `shared/`
modules it imports. Vite builds the interface to `dist/`. In production the
server serves both from the working directory.

## Runtime and storage

- Node 24 and `node:sqlite`; no native database dependency.
- `DATA_DIR` (default `./data`) holds `story-architect.db`, SQLite WAL files, and
  `secret.key`.
- SQLite runs in WAL mode with foreign keys enabled and a five-second busy
  timeout.
- Migrations are an ordered array in `server/db.ts`; `PRAGMA user_version` records
  the applied version. Add new stages as new array entries rather than editing
  migration 1.
- API keys are encrypted with AES-256-GCM (`v1:iv:tag:ciphertext`). The key comes
  from `STORY_ARCHITECT_ENCRYPTION_KEY` or is generated once at
  `DATA_DIR/secret.key`.
- On boot, jobs left in `queued`/`running` are marked `interrupted` with their
  saved partial output intact.

## Data model

Core tables:

- `settings` — global generation defaults, stored as JSON.
- `connections` — endpoint metadata and encrypted `api_key`; discovered models
  cached as JSON.
- `role_assignments` — `(scope, scope_id, role)` with scope `global` or
  `project`; missing task roles fall back to the default assignment.
- `projects` — questionnaire fields, status, and target length.
- `project_settings` — per-project generation overrides.
- `prompt_templates` — global or project-scoped outline/prose prompts with one
  default per scope and kind.
- `outline_revisions` — ordered, versioned chapter arrays plus raw model output;
  statuses `draft`, `approved`, `superseded`.
- `chapters` — the current approved outline projection, order, brief approval
  flag, and pointer to the current revision.
- `chapter_revisions` — immutable generated/restored snapshots and a mutable
  `editable` working copy; version is unique per chapter.
- `conversations` and `messages` — assistant history, separate from prose;
  `incomplete` marks a recovered partial reply.
- `generation_jobs` — kind, status, model, prompt, context metadata, streamed
  output, error, usage, and resulting revision. Kinds are `outline`, `chapter`,
  `chat`, `memory`, and `characters`.
- `characters` — stable project-scoped IDs, profile fields, status
  (`proposed`/`active`/`archived`), and source (`manual`/`outline`/`memory`).
- `chapter_memory` — one derived summary per chapter, with its source revision,
  a short content hash (so in-place autosave edits are noticed), source word
  count, the preceding-text fingerprint at generation time, and the producing
  job. Staleness is computed by comparing these to the current manuscript.
- `facts` — reviewable continuity records with kind, class
  (`authored`/`established`/`plan`), status
  (`proposed`/`established`/`superseded`/`rejected`), origin, optional character,
  source chapter, source revision, source content hash, and optional chapter
  scope.

Reserved for later stages: lorebooks and image assets. The `image_prompt` role
row already exists.

## Revision semantics

- A generated revision is immutable (`editable = 0`). It becomes `current` only
  when the chapter has no non-empty current text.
- The first edit of a non-editable revision forks a new editable revision and
  makes it current. Autosave then updates that editable revision in place.
- "Use as current" points the chapter at an existing revision without copying.
- "Restore" copies an old revision into a new editable revision; intervening
  versions remain.
- A failed/cancelled/interrupted job may be recovered as a `recovered` revision
  through `POST /api/jobs/:id/apply-partial`.

## Generation flow

1. Route resolution picks a model from the project assignment, global
   assignment, or global default, and decrypts the connection key.
2. The server renders the selected prompt template with project data, context,
   and additional instructions.
3. A `generation_jobs` row is created before any provider call.
4. A runtime object holds an `AbortController`, buffered output, and SSE
   listeners. Output is flushed to SQLite at most every 500 ms and on finish.
5. `GET /api/jobs/:id/stream` sends a snapshot, then deltas, then a terminal
   status. Reconnecting gets the full buffered output. A browser refresh can
   reattach while the job runs.
6. On completion:
   - outline: parse and insert a new draft revision;
   - chapter: insert a generated revision, applying it only when the chapter is
     empty;
   - chat: insert the assistant message.
7. Cancellation aborts the provider request; existing chapter text is untouched,
   and the partial output remains on the job.

## Context assembly

The context builder works in two layers:

1. **Required input** — project metadata, standing instructions, the chapter
   brief, additional instructions, and the prompt template. Estimated tokens for
   this layer are checked first. Output capacity is reserved from the smaller of
   the configured max-output tokens or roughly 1.5 tokens per target word, with a
   800-token floor.
2. **Optional memory and prose** — within the remaining input budget, capped by
   the selected model's known context window when available:
   - chapter summaries (most recent first, rendered chronologically);
   - active character profiles ranked by mention in the brief, recent summaries,
     and linked facts;
   - established, in-scope facts. Facts from later chapters and plans scoped to
     later chapters are excluded;
   - recent preceding prose trimmed at a line boundary.

Presets are roughly 4,000 / 8,000 / 16,000 input tokens for Focused, Balanced,
and Broad. A single oversized section is shed rather than allowed to overflow.
If required input cannot fit, generation returns a 409 with the estimate, the
preset or model window, and the reserved output capacity instead of silently
dropping instructions. All token counts are estimates (four characters per
token) and are labelled as such in the interface.

The inspector response and the job's `context_json` record each section's
included state, token estimate, item counts, omissions, stale-summary count, and
pending-fact count. Custom prose templates without `{{story_memory}}` still
receive the memory block, appended after rendering.

## Memory flow

1. When a generated or recovered chapter draft becomes current, an automatic
   `memory` job starts if a memory role resolves. Editing, restoring, or choosing
   an alternative does not auto-run; staleness is shown and rebuild is explicit.
2. The memory job reads the current chapter revision plus preceding summaries,
   established facts, and cast names, and requests JSON with a summary and facts.
3. The summary is saved against the source revision and a fingerprint of every
   preceding chapter revision. Unparseable output keeps the job and raw reply for
   retry; a prose-only reply can still be saved as a summary.
4. Facts are inserted as `proposed`. Identical statements already proposed,
   established, or rejected in that chapter are skipped; superseded facts may be
   proposed again after a rebuild.
5. Staleness is computed, not stored: a summary is stale when its source
   revision or source content hash changed, or its preceding-text fingerprint no
   longer matches. Later summaries become stale when an earlier chapter changes,
   including in-place autosave edits. Facts expose `sourceOutdated` when their
   source revision or content hash differs from the chapter's current text.
6. `POST /projects/:id/memory/rebuild` queues stale or missing chapters as
   `queued` jobs and runs one at a time per project. Queued jobs survive a
   restart as `interrupted` through the existing boot recovery.

The memory role also powers outline casting. Proposals are stored as
`proposed` characters and are excluded from context until accepted. Existing
names are never overwritten.

## API surface

All routes are under `/api`; responses are JSON except Markdown export and SSE.

- Connections: `GET/POST /connections`, `PATCH/DELETE /connections/:id`,
  `POST /connections/:id/test`, `POST /connections/:id/refresh-models`.
- Settings and roles: `GET/PATCH /settings`, `GET/PUT /model-roles`.
- Prompt templates: `GET/POST /templates`, `PATCH/DELETE /templates/:id`,
  `POST /templates/:id/default`.
- Projects: `GET/POST /projects`, `GET/PATCH /projects/:id`,
  `POST /projects/:id/archive|unarchive`, `GET/PATCH /projects/:id/settings`,
  `GET /projects/:id/export.md`.
- Outline: `GET /projects/:id/outline`,
  `POST /projects/:id/outline/generate|manual`,
  `PUT /projects/:id/outline`, `POST /projects/:id/outline/:revisionId/approve`.
- Chapters: `GET /projects/:id/chapters`, `GET /chapters/:id`,
  `PUT /chapters/:id/content`, `POST /chapters/:id/append`,
  `POST /chapters/:id/generate`, `GET /chapters/:id/context`.
- Revisions: `GET /revisions/:id`, `POST /revisions/:id/use|restore`.
- Jobs: `GET /jobs/:id`, `GET /jobs/:id/stream`, `POST /jobs/:id/cancel`,
  `POST /jobs/:id/apply-partial`.
- Chat: `GET /projects/:id/conversations`,
  `POST /projects/:id/conversations`, `DELETE /conversations/:id`,
  `GET /conversations/:id/messages`, `POST /conversations/:id/messages`.
- Suggestions: `POST /suggest`.
- Characters: `GET/POST /projects/:id/characters`,
  `POST /projects/:id/characters/propose`, `PATCH /characters/:id`,
  `POST /characters/:id/accept|archive`.
- Memory: `GET /projects/:id/memory`, `GET /chapters/:id/memory`,
  `POST /chapters/:id/memory/rebuild`, `PATCH /chapters/:id/memory`,
  `POST /projects/:id/memory/rebuild`,
  `POST /projects/:id/memory/supersede-outdated`,
  `GET/POST /projects/:id/memory/facts`, `GET/PATCH/DELETE /facts/:id`,
  `POST /facts/:id/accept|reject|supersede`.
- Health: `GET /health`.

## Provider adapter contract

`server/providers.ts` assumes an OpenAI-compatible API base such as
`https://openrouter.ai/api/v1` or `http://host:1234/v1`. It appends
`/chat/completions` and `/models`, sends a bearer token when present, parses
server-sent events, tolerates string or content-part deltas, and surfaces
non-2xx bodies as visible job errors. OpenRouter receives attribution headers.
Connection tests try `/models` and fall back to a one-token completion for
servers without discovery.

Sampling fields are omitted when unset so each provider's defaults apply. Usage
is recorded when the provider reports prompt and completion tokens.

## Stage 3 preparation

- Add migration 3; do not rewrite migrations 1 or 2.
- Lore can use the same section shape as memory in the context builder: a
  labelled, trimmed section with provenance in the inspector.
- `facts` already carries class, scope, source revision, and review status;
  lorebook entries should stay separate from canon facts rather than overloading
  this table.
- Selected-text rewrite actions should flow through the existing persisted job
  and revision pipeline, and should mark affected chapter memory stale exactly as
  an ordinary edit does.
- The prose template already exposes `{{story_memory}}`; add lore through an
  explicit placeholder or an appended section so custom templates do not silently
  lose it.
