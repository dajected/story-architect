# Stage 1–5 implementation notes

Status: stages 1–5 implemented and runnable. These notes are for maintainers;
the product requirements live in [PRODUCT_PLAN.md](PRODUCT_PLAN.md).

## Layout

| Path | Contents |
| --- | --- |
| `server/` | Express API, provider adapters, generation jobs, persistence. |
| `server/store/` | Small data-access modules for each aggregate. |
| `server/routes/` | HTTP routes grouped by area. |
| `server/backup.ts` | Portable project archive writer/reader and restore remapping. |
| `shared/` | Types, defaults, word counting, and context presets used by both sides. |
| `src/` | React interface, API client, job streaming hook, components, styles. |
| `docs/` | Product plan and these notes. |

The server is compiled with `tsc` to `dist-server/`, including the `shared/`
modules it imports. Vite builds the interface to `dist/`. In production the
server serves both from the working directory.

## Runtime and storage

- Node 24 and `node:sqlite`; no native database dependency.
- `DATA_DIR` (default `./data`) holds `story-architect.db`, SQLite WAL files,
  `secret.key`, generated images under `images/<project-id>/`, and automatic
  pre-migration copies under `backups/`.
- SQLite runs in WAL mode with foreign keys enabled and a five-second busy
  timeout.
- Migrations are an ordered array in `server/db.ts`; `PRAGMA user_version` records
  the applied version. Add new stages as new array entries rather than editing
  migration 1.
- Before applying a later migration to an existing database, `migrate()` writes a
  consistent `VACUUM INTO` copy to
  `backups/pre-migration-v<version>-<timestamp>.db`. A failed copy is logged and
  does not block the upgrade.
- `GET /api/health` checks that SQLite answers and reports the app version, applied
  schema version, latest known migration, and uptime. A database error returns 503.
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
  output, error, usage, resulting revision, a sampling-settings snapshot, cached
  model pricing, and an estimated cost. Kinds are `outline`, `chapter`, `chat`,
  `memory`, `characters`, `rewrite`, `review`, and `image_prompt`.
- `characters` — stable project-scoped IDs, profile fields, status
  (`proposed`/`active`/`archived`), source (`manual`/`outline`/`memory`), and an
  optional portrait asset.
- `chapter_memory` — one derived summary per chapter, with its source revision,
  a short content hash (so in-place autosave edits are noticed), source word
  count, the preceding-text fingerprint at generation time, and the producing
  job. Staleness is computed by comparing these to the current manuscript.
- `facts` — reviewable continuity records with kind, class
  (`authored`/`established`/`plan`), status
  (`proposed`/`established`/`superseded`/`rejected`), origin, optional character,
  source chapter, source revision, source content hash, and optional chapter
  scope.
- `lorebooks` — a named book with an optional owning project. Books without an
  owner are shared; every book is attached to a project through
  `lorebook_links`, so one book can serve several novels.
- `lore_entries` — title, text, JSON keyword triggers, enabled flag,
  always-include flag, and priority. Entries belong to a book and are never
  stored as canon facts.
- `lore_pins` — `(project_id, entry_id)` retained until the next chapter
  generation consumes them.
- `prose_instructions` — reusable named instruction text, project-scoped or
  global.
- `image_connections` — separate image-service credentials and settings, keyed by
  kind. `openai-images` stores a model, size, and optional quality; `comfyui` stores
  an API-format workflow and node mappings for prompt, negative prompt, seed, and
  output.
- `image_prompt_templates` — global or project-scoped templates expanded by the
  image-prompt role, with one default per scope.
- `image_jobs` — persistent image generation state, including the exact prompt,
  negative prompt, template snapshot, provider settings, remote ComfyUI prompt ID,
  resulting asset ID, status, and error. Image jobs are deliberately separate from
  `generation_jobs`, which continue to model streamed text tasks.
- `image_assets` — saved images with their prompt, template snapshot, connection
  name, provider settings, and character/chapter links. `characters.portrait_asset_id`
  points at one asset for the portrait.

The `image_prompt` generation-job kind covers template expansion through the text
role; it does not create prose revisions.

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
- An accepted selected-text rewrite inserts an immutable `rewrite` revision that
  becomes current. The pre-rewrite working copy remains in history, and the
  chapter summary becomes stale because the source hash changed.

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
   - chat: insert the assistant message;
   - rewrite: keep the proposal on the job; no revision until
     `POST /api/jobs/:id/apply-rewrite`;
   - review: keep the advisory report on the job.
7. Cancellation aborts the provider request; existing chapter text is untouched,
   and the partial output remains on the job.

## Generation log and cost

- Each job stores the effective sampling settings (`temperature`, `topP`,
  `maxTokens`, and, where relevant, the context preset and target words) at
  creation. The provider's usage is saved on completion when it reports prompt and
  completion tokens.
- Pricing is read from the connection's cached model list at job creation. OpenRouter
  publishes per-token prompt and completion prices; most OpenAI-compatible endpoints
  do not. The snapshot is stored on the job so a later model refresh does not
  rewrite history.
- `estimated_cost` is prompt tokens × prompt price + completion tokens × completion
  price, rounded to six decimal places. Jobs without usage or cached pricing show
  no estimate and are counted as unpriced.
- `GET /projects/:id/generation-history` returns the newest 200 jobs by default
  (maximum 1,000) with chapter titles, connection names, settings, duration, usage,
  cost, error text, and summary totals. The Activity tab renders that response.
- The endpoint is read-only. Image jobs continue to live in the character gallery
  as `image_jobs` rows because they have no token usage.

## Context assembly

The context builder works in two layers:

1. **Required input** — project metadata, standing instructions, the chapter
   brief, additional instructions, and the prompt template. Estimated tokens for
   this layer are checked first. Output capacity is reserved from the smaller of
   the configured max-output tokens or roughly 1.5 tokens per target word, with a
   800-token floor.
2. **Optional lore, memory and prose** — within the remaining input budget, capped by
   the selected model's known context window when available:
   - activated lore entries (see below);
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

Lore takes roughly 16 / 20 / 24 percent of the remaining input budget, capped at
12,000 tokens. Memory then takes its usual share of what remains, and recent
prose gets the rest.

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

## Lore activation

1. Every enabled entry in a book linked to the project is a candidate. Entries
   that appear in several linked books cannot duplicate because an entry belongs
   to exactly one book and a project links each book once.
2. The match text is the chapter brief, the additional generation instructions,
   and the final 6,000 characters of the most recent preceding chapter. Matching
   is case-insensitive; a single-word trigger matches whole words, and a phrase
   matches as a substring.
3. Ordering is manual pins first, then always-include, then keyword matches
   (more matched triggers before fewer), then priority, then title.
4. Entries are packed until the lore budget is reached. An entry that does not
   fit is reported with reason `budget` in `ContextInfo.lore.entries`; it is
   never cut in half. `lore.budgetTokens` and `lore.usedTokens` are shown in the
   inspector.
5. `POST /chapters/:id/generate` clears the project's pins after the job row is
   created, so manual inclusion applies to exactly one generation. The job's
   `context_json` keeps the activation snapshot.
6. The prose template has a `{{lore}}` placeholder. A custom template without it
   receives the lore block appended, exactly like `{{story_memory}}`.

## Writing tools

- `POST /chapters/:id/rewrite` validates the selected range against the current
  saved text, then streams a replacement through the prose role. The selection,
  offsets, action, and instruction live on the job; no revision is created.
- The proposal can be edited in the interface before
  `POST /jobs/:id/apply-rewrite`. Applying re-validates the original selection
  against current text and inserts a new `rewrite` revision. A changed chapter
  returns 409 rather than replacing the wrong passage.
- `POST /chapters/:id/review` runs a continuity report through the memory role,
  with the current chapter, brief, and accepted memory. The report is advisory
  and stored on the job.
- `prose_instructions` is a small named-text library. The chapter form and the
  rewrite form can append an instruction to their free-text instructions; the
  library itself never edits prose.

## Image flow

1. `POST /characters/:id/images/prompt` resolves the image-prompt role, renders the
   selected image template with the character profile, optional chapter brief and
   excerpt, scene, clothing, visual style, and instructions, and starts a normal
   text job of kind `image_prompt`. The streamed reply is editable prompt text; no
   image request is made yet.
2. `POST /characters/:id/images` takes the edited prompt, validates the character,
   chapter, and image connection, snapshots the connection settings and template
   revision onto an `image_jobs` row, and starts one job per character.
3. The image adapters return image bytes. The server verifies the file type by magic
   bytes, writes the file under `DATA_DIR/images/<project-id>/<asset-id>.<ext>`, and
   inserts an `image_assets` row. SQLite stores only the relative path.
4. The OpenAI Images adapter calls `POST /images/generations` and accepts
   `b64_json`, an image URL, or a data URL. The ComfyUI adapter submits the mapped
   workflow to `POST /prompt`, stores the returned prompt ID, polls
   `/history/<prompt-id>`, and downloads the output from `/view`.
5. Cancellation is local for both adapters: the job is marked `cancelled`, the
   request/polling is aborted, and any remote ComfyUI work is left alone. The saved
   prompt is available for a new attempt.
6. On boot, queued or running image jobs become `interrupted`. A startup pass resumes
   polling each existing ComfyUI request with a remote ID, marking it `running`
   while recovery is active. Recovered output is saved and the job becomes `completed`.
   A timeout or connection error returns it to `interrupted`; Retry resumes polling
   the same remote ID without submitting another workflow. OpenAI-style jobs have no remote ID to reconcile
   and stay recoverable through their stored prompt.
7. `POST /characters/:id/portrait` sets or clears the portrait. Deleting an asset
   clears a matching portrait pointer and removes the file.

## Project backup and restore

The project archive is a gzipped POSIX tar with no external archive dependency.

1. `manifest.json` carries `format: "story-architect-project"`, an archive
   version, the app version, and the project rows: project settings, outline
   revisions, chapters and chapter revisions, conversations and messages,
   characters, chapter memory, facts, linked lorebooks and entries, project
   prose instructions, project prompt templates plus the effective outline/prose
   snapshot, project image-prompt templates plus the effective snapshot, and
   image-asset metadata.
2. Image files are stored as `images/<asset-id>.<ext>` and referenced from the
   manifest by `archivePath`. A missing image file is skipped at export rather
   than failing the archive.
3. Connections, image connections, role assignments, global settings, API keys,
   lore pins, and generation/image job rows are excluded. The manifest contains
   no credential material.
4. Restore reads the tar into memory, validates the format/version, and creates a
   new project ID. Every project-scoped row receives a new ID and references are
   remapped: chapter IDs inside outline revisions and memory fingerprints, source
   revision IDs, character/chapter links on facts and images, conversation IDs on
   messages, and asset IDs on character portraits.
5. Shared lorebooks are restored as new project-owned books. Image connection IDs
   are dropped while the connection name, provider kind, settings snapshot, and
   prompt provenance remain.
6. Chapters are inserted before their revision rows because `current_revision_id`
   is plain text, not a foreign key. Characters are inserted with a null portrait,
   image assets are inserted next, then portrait pointers are updated, which
   respects the circular character/image foreign key.
7. If the effective prompt or image template was global or built-in rather than
   project-scoped, restore inserts a project-scoped default copy so generation
   behaves the same in a fresh installation.
8. Files are written under the new project directory before the database
   transaction. A failed transaction removes that directory again.

The restore route accepts `application/gzip` (or `application/octet-stream`) as a
raw body up to 512 MB. The UI uploads the selected file directly.

## Upgrades and recovery

- `PRAGMA user_version` remains the source of truth. A health response with
  `schemaVersion < latestSchemaVersion` means the running server has not applied
  every migration it knows about; inspect the container logs.
- The pre-migration copy is taken only for an existing database (`user_version > 0`).
  A brand-new installation has nothing to preserve.
- Rolling back requires restoring that database copy and running the previous
  image tag. Never point an older build at a database with a newer
  `user_version`; migrations are not reversed.
- Interrupted generation and image jobs retain their partial output/prompt and are
  surfaced through the existing recovery paths.

## API surface

All routes are under `/api`; responses are JSON except Markdown export and SSE.

- Connections: `GET/POST /connections`, `PATCH/DELETE /connections/:id`,
  `POST /connections/:id/test`, `POST /connections/:id/refresh-models`.
- Settings and roles: `GET/PATCH /settings`, `GET/PUT /model-roles`.
- Prompt templates: `GET/POST /templates`, `PATCH/DELETE /templates/:id`,
  `POST /templates/:id/default`.
- Projects: `GET/POST /projects`, `GET/PATCH /projects/:id`,
  `POST /projects/:id/archive|unarchive`, `GET/PATCH /projects/:id/settings`,
  `GET /projects/:id/export.md`, `GET /projects/:id/backup`,
  `POST /projects/restore`, `GET /projects/:id/generation-history`.
- Outline: `GET /projects/:id/outline`,
  `POST /projects/:id/outline/generate|manual`,
  `PUT /projects/:id/outline`, `POST /projects/:id/outline/:revisionId/approve`.
- Chapters: `GET /projects/:id/chapters`, `GET /chapters/:id`,
  `PUT /chapters/:id/content`, `POST /chapters/:id/append`,
  `POST /chapters/:id/generate`, `GET /chapters/:id/context`,
  `POST /chapters/:id/rewrite`, `POST /chapters/:id/review`.
- Revisions: `GET /revisions/:id`, `POST /revisions/:id/use|restore`.
- Jobs: `GET /jobs/:id`, `GET /jobs/:id/stream`, `POST /jobs/:id/cancel`,
  `POST /jobs/:id/apply-partial`, `POST /jobs/:id/apply-rewrite`.
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
- Lore: `GET /projects/:id/lore`, `POST /projects/:id/lorebooks`,
  `PATCH/DELETE /projects/:id/lorebooks/:bookId`,
  `POST /projects/:id/lorebooks/:bookId/link|unlink`,
  `POST /projects/:id/lorebooks/:bookId/entries`,
  `PATCH/DELETE /projects/:id/lore-entries/:entryId`,
  `PUT/DELETE /projects/:id/lore/pins`.
- Saved instructions: `GET/POST /projects/:id/prose-instructions`,
  `PATCH/DELETE /projects/:id/prose-instructions/:instructionId`.
- Image connections: `GET/POST /image-connections`,
  `PATCH/DELETE /image-connections/:id`, `POST /image-connections/:id/test`.
- Image templates: `GET/POST /image-prompt-templates`,
  `PATCH/DELETE /image-prompt-templates/:id`,
  `POST /image-prompt-templates/:id/default`.
- Character images: `GET /characters/:id/images`,
  `POST /characters/:id/images/prompt`, `POST /characters/:id/images`,
  `POST /characters/:id/portrait`.
- Image jobs and assets: `GET /image-jobs/:id`, `POST /image-jobs/:id/cancel`,
  `POST /image-jobs/:id/retry`, `GET /image-assets/:id/file`,
  `DELETE /image-assets/:id`.
- Health: `GET /health` — app version, schema version, latest migration, uptime;
  HTTP 503 when SQLite cannot answer.
- Backup/restore: `GET /projects/:id/backup` (gzipped tar) and
  `POST /projects/restore` (raw gzip body).

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

`server/image-providers.ts` implements the image side separately:

- **OpenAI Images** — `POST <base>/images/generations` with a model, prompt, one
  image, and optional size/quality. Base64, URL, and data-URL replies are accepted.
  The negative prompt is appended as an “Avoid” note because the API has no separate
  negative field.
- **ComfyUI** — the saved workflow is parsed as an API-format object, the prompt and
  optional negative prompt are written into the configured node inputs, and an
  optional seed node receives a random value. `POST /prompt` returns the remote ID;
  `/history/<id>` and `/view` are polled and downloaded. Workflow/mapping failures are
  reported with the offending node ID.
- Connection tests use `/system_stats` for ComfyUI and `/models` for OpenAI-style
  services. Image bytes are validated by magic bytes before they are written.

## Stage 3 implementation notes

- Migration 3 adds `lorebooks`, `lorebook_links`, `lore_entries`, `lore_pins`,
  and `prose_instructions`; migrations 1 and 2 are unchanged.
- Lore stays separate from `facts`. A lore entry is authoring material, not
  accepted canon, and never enters the continuity review as established fact.
- Activation and budgeting live in `server/context.ts`; the store only provides
  linked, enabled entries and pin state. The inspector receives the activation
  list with reasons, so the interface can explain both inclusion and exclusion.
- Rewrites reuse the persisted job and revision pipeline. Applying one inserts a
  `rewrite` revision and relies on the existing content-hash comparison to mark
  derived memory stale. No later chapter is rewritten automatically.
- The default prose template now carries `{{lore}}`; custom templates that omit it
  receive the block appended.

## Stage 4 implementation notes

- Migration 4 adds `image_connections`, `image_prompt_templates`, `image_jobs`,
  `image_assets`, and `characters.portrait_asset_id`; migrations 1–3 are unchanged.
- The first hosted image adapter is the **OpenAI Images API** because it is a small,
  widely proxied JSON contract. The ComfyUI adapter is the configurable-workflow
  option. The two connections never share rows, credentials, or role assignments with
  text connections.
- Prompt expansion is a text job of kind `image_prompt`, routed through the existing
  role resolver and SSE stream. The final image request is a separate `image_jobs`
  row created only after the author edits the prompt.
- The template snapshot is copied onto the job and the asset, so editing a template
  later does not rewrite a saved image's provenance.
- Generated files are named by asset UUID and stored under
  `DATA_DIR/images/<project-id>/`. SQLite contains relative paths, keeping the Compose
  data mount a single backup unit.
- Image jobs are marked interrupted on boot. The startup reconciler polls ComfyUI
  history for jobs with a remote ID and saves completed output, using the saved
  output mapping and timeout. An interrupted ComfyUI retry checks the same remote
  request. Other jobs keep their prompt and failure message for an explicit retry.
- The image studio loads a character's overview on open, reattaches to any active job,
  polls until terminal, and refreshes the gallery when the job finishes.

## Stage 5 implementation notes

- Migration 5 adds `generation_jobs.settings`, `pricing`, and `estimated_cost`;
  migrations 1–4 are unchanged.
- The archive format is a small hand-written ustar writer/reader in
  `server/backup.ts`. It uses only `node:zlib` and `node:fs`, so the Docker image
  gains no archive dependency. Archive names are limited to paths this server
  writes, and the reader rejects absolute paths and `..` segments.
- Restore always creates a new project ID and remaps every project-scoped row.
  That allows repeated restores of one archive and avoids overwriting an existing
  project. Image files are written under the new project directory.
- Generation history is computed from persisted jobs rather than a separate log
  table. This keeps one source of truth and lets older jobs appear with whatever
  settings/pricing were available.
- Cost is an estimate from cached model pricing, not a provider invoice. The UI
  labels it and lists unpriced jobs separately.
- Chapter navigation uses a sidebar filter and previous/next editor controls.
  Word count uses `useDeferredValue`, and autosave coalesces memory-status reads
  into one trailing refresh three seconds after typing stops, so long writing
  sessions stay responsive without hiding stale summaries.
- Health now queries SQLite and reports schema state, so the Docker health check
  fails when the database is unavailable rather than only when the process is gone.
- Duplicate-request protection remains the active-job checks in
  `startChapterGeneration`, rewrite, review, chat, outline, memory, and image
  routes. A browser refresh reattaches to the persisted job; it does not submit a
  second request.
