# Stage 1 implementation notes

Status: stage 1 implemented and runnable. These notes are for maintainers and the
next stage; the product requirements live in
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
  output, error, usage, and resulting revision.

Reserved for later stages: memory/continuity records, characters, lorebooks, and
image assets. The role rows for `memory` and `image_prompt` already exist.

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

The context builder uses presets of roughly 2,500 / 6,000 / 12,000 tokens. It
reserves room for project metadata and the brief, then keeps the most recent
preceding prose, trimming at a line boundary and recording how many chapters were
dropped. Token counts are estimates (four characters per token) and are labelled
as such in the interface.

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

## Stage 2 preparation

- Add migrations; do not rewrite migration 1.
- Memory roles already resolve through the same routing table.
- The context builder is the place to insert summaries, character facts, and
  lore with explicit provenance and budgets.
- Outline revisions and chapter revisions carry stable IDs suitable for source
  references from derived memory.
- Editing/restoring a chapter currently does not mark derived memory stale
  because that feature does not exist yet; the revision IDs are the anchor for
  adding it.
