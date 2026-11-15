<img src="assets/icon.svg" width="64" height="64" alt="">

# Story Architect

A self-hosted AI writing workspace for novels. Plan a premise, approve a chapter
outline, draft chapters with a model of your choice, revise with full history,
talk ideas through with an assistant, and export the manuscript as Markdown.

Stage 5 is implemented: portable project backup and restore, a generation log with
token usage and cost estimates, faster long-novel navigation, a health check that
reports schema state, and documented upgrade and recovery paths, on top of the
stage 1–4 workflow described in [docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md).

## What is in stage 1

- **Novel library** — create, open, rename, search, archive, and restore projects.
- **Guided questionnaire** — premise, genre, tone, point of view, tense, length,
  style, content preferences, and standing instructions, with an AI suggestion
  for any field. Blank answers are left to the model.
- **Connections** — named OpenRouter or custom OpenAI-compatible endpoints.
  API keys are encrypted on the server and masked in every response. Test a
  connection, discover its models, or enter model IDs manually.
- **Model roles** — a default model plus outline, prose, memory, and image-prompt
  roles, with global defaults and per-project overrides.
- **Editable prompt presets** — versioned in the database and editable through
  the UI, with a placeholder reference.
- **Versioned outline** — generated from JSON with a tolerant parser, or written
  manually. Every structural change creates a revision; older revisions stay
  readable. Approval unlocks drafting.
- **Streamed drafting** — live token streaming, stop/cancel, visible provider
  errors, and a persisted job log. A failed or cancelled run leaves the current
  chapter untouched, and partial output can be recovered as a new revision.
- **Manuscript editor** — Markdown editing with preview, autosave, word counts,
  chapter navigation, and a chapter brief always in view.
- **Revision history** — preview any version, use a generated alternative as the
  current text, or restore an old version as a new revision. Generated drafts
  never silently replace existing prose.
- **Simple context presets** — Focused, Balanced, and Broad, with a token budget
  applied to every chapter request. Stage 2 adds memory and the full inspector.
- **Assistant chat** — conversations saved separately from the manuscript, with
  streaming replies. Suggestions enter the manuscript only through an explicit
  "Insert into chapter" action.
- **Markdown export** — current chapter text in manuscript order.
- **Docker** — a Linux amd64 image and Compose file with persistent `/data`
  storage for the TrueNAS host.

## What stage 2 adds

- **Cast** — characters created manually or proposed from the approved outline.
  Proposals stay separate until accepted. Profiles cover identity, appearance,
  personality, goals, relationships, and notes, and feed chapter context.
- **Memory role** — the assigned memory model writes summaries, extracts
  continuity facts, and casts characters, routing separately from prose.
- **Chapter summaries** — the memory role summarises a chapter after its draft
  becomes current. You can rebuild or hand-edit a summary at any time.
- **Continuity facts** — character developments, relationships, timeline events,
  unresolved threads, and world details are proposed for review with their source
  chapter and revision. Only accepted facts enter new prompts; superseded facts
  stop entering immediately.
- **Class and scope** — authored world facts, established events, and future
  plans are labelled distinctly. Facts can be story-wide or scoped to a chapter,
  so later developments never read as established history in earlier scenes.
- **Revision-aware stale memory** — editing or restoring an earlier chapter marks
  its summary stale and later dependent summaries as potentially outdated.
  Rebuilds update derived information against the current revision; later prose
  is never rewritten silently.
- **Context inspector** — shows the selected model, its context window, the
  required and optional sections, token estimates, trimming, stale summaries,
  and facts awaiting review before a chapter is generated.
- **Budget safety** — output capacity is reserved up front. If the required brief
  and instructions cannot fit, generation is refused with an explanation rather
  than dropping essential instructions.

## What stage 3 adds

- **Lorebooks** — one or more books per novel, each holding titled entries. A book
  can be linked to other novels, so shared world notes do not need copying.
- **Keyword activation** — entries activate against the chapter brief, additional
  generation instructions, and a bounded tail of recent prose. Matching is
  whole-word and case-insensitive, and each entry is counted once.
- **Pins and always-include** — an entry can be pinned for the next generation or
  marked always-include. Pins are consumed by one generation, so they never leak
  into later chapters by accident.
- **Lore budget** — activation shares the input budget with memory and prose.
  Priority, automatic matches, and pins order the entries, and the context
  inspector lists every activated entry with its reason plus any entries excluded
  by the budget.
- **Selected-text rewrites** — rewrite, expand, shorten, or adjust the style of a
  passage. The model streams a proposal, you can edit it before applying, and the
  current text is untouched until you accept it.
- **Recoverable rewrite revisions** — an accepted rewrite becomes a new revision
  with its own source label. The previous text stays in History, and the chapter
  summary is marked stale until you rebuild it.
- **Saved prose instructions** — reusable voice and style notes that can be added
  to chapter generation or a style rewrite.
- **Continuity review** — an advisory pass over one chapter against accepted
  summaries, facts, and cast. It reports conflicts without changing the
  manuscript, and it uses the memory role.

## What stage 4 adds

- **Image service connections** — a separate connection list for images. Use an
  OpenAI Images-compatible endpoint (`/images/generations`) or a ComfyUI server. Image
  credentials and settings never touch the text-model connections or role assignments.
- **Image prompt templates** — global or project-scoped templates with placeholders
  for character name, role, identity, appearance, clothing, scene, chapter context,
  visual style, and novel details.
- **Model-expanded prompts** — the image-prompt role turns the template and the chosen
  character and chapter into a draft prompt. The reply streams into the studio, where
  you can edit it before spending an image request.
- **ComfyUI workflows** — paste an API-format workflow and map the prompt, optional
  negative prompt, seed, and output image nodes. Story Architect queues the workflow,
  polls the run history, and downloads the result.
- **Character gallery** — each image is saved under the data directory with its prompt,
  template snapshot, provider settings, and character link. Set any image as the
  character's portrait or remove it later.
- **Persisted image jobs** — queued, running, completed, failed, cancelled, and
  interrupted states survive a browser refresh. Interrupted ComfyUI jobs are reconciled
  against the service at startup when possible, and the stored prompt makes every other
  interrupted job retryable.

## What stage 5 adds

- **Portable project backups** — download one `.tar.gz` containing the project,
  outline and chapter revisions, accepted memory and facts, cast, lorebooks,
  templates, saved instructions, chats, image files, and image metadata. API keys,
  text connections, image connections, role assignments, and global settings are
  deliberately excluded.
- **Restore into a fresh installation** — upload a project backup from the library.
  Every internal ID is regenerated, so the same backup can be restored more than
  once without colliding with existing work. Shared lorebooks become project-owned
  copies, and character portraits keep pointing at the restored image.
- **Generation log** — a project-level Activity tab lists outline, chapter, chat,
  memory, casting, rewrite, review, and image-prompt jobs with the model, sampling
  settings, provider-reported token usage, duration, status, and an estimated cost
  where cached model pricing is available.
- **Cost estimates with provenance** — pricing is captured when a job starts, so a
  later model-list refresh does not rewrite history. Providers that do not publish
  prices show usage without a cost.
- **Long-novel navigation** — the chapter sidebar filters by title or brief and
  keeps the current chapter in view, and the editor has previous/next chapter
  controls. Word counting is deferred while typing, and memory-status reads are
  coalesced into one trailing refresh instead of firing on every autosave.
- **Operational polish** — `/api/health` reports the app version, schema version,
  latest available migration, and uptime. Before a later migration runs, the server
  writes a consistent `VACUUM INTO` copy under `DATA_DIR/backups/`.
- **Upgrade and recovery documentation** — see [Upgrading](#upgrading) and
  [Recovery](#recovery).

## Batch drafting and chapter portraits

- **Draft the whole novel** — once the outline is approved, **Generate all
  chapters** drafts every empty chapter in outline order. Each chapter waits for
  the previous draft and its automatic summary, so the memory and preceding prose
  carried into later chapters are real; chapters that already have text are
  skipped. Progress, failures, and the current chapter are visible in the Outline
  tab, and a batch can be stopped at any time.
- **Regenerate the full story** — **Regenerate full story** in the same panel
  re-drafts every chapter from the approved outline, including chapters that
  already have prose. Each new draft becomes the chapter's current text; the
  replaced draft stays available in the revision history, so nothing is lost.
  As with drafting, chapters run one at a time and each waits for the previous
  chapter's summary.
- **End-of-chapter portraits** — every chapter's editor lists the cast members
  named in that chapter. **Generate portrait** builds a prompt from the chapter's
  closing passage and the continuity facts recorded for that character, then sends
  it to the image service, so the portrait shows how they look *after* the
  chapter's events — clothing, injuries, weariness, and all. Images stay attached
  to the chapter and can be set as the character's portrait.
- **One character, every chapter** — in the chapter images dialog, choose a
  single character under **One character, every chapter** and queue one image
  for every chapter with prose. The batch runs in chapter order, one image at a
  time, using the selected image service, story moment, scene, and visual style.
  Finished images are automatically selected as that chapter's image for the
  character; chapters without prose are skipped, and an optional filter skips
  chapters that already have an image. Progress and failures are shown in the
  dialog and stay available after it is reopened.

## Get the code

```bash
git clone https://github.com/dajected/story-architect.git
cd story-architect
```

## Quick start (development)

Requires Node.js 24 or newer, which provides `node:sqlite`. The Docker image uses
Node 24.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The API runs on port 3000; Vite proxies `/api`.

Production build locally:

```bash
npm run build
npm start
```

The interface is then served from `http://localhost:3000`.

## Run with Docker

The published image is **`ghcr.io/dajected/story-architect:latest`** for Linux
amd64. Compose pulls it directly; no local build is required.

1. Copy `.env.example` to `.env` and set the storage path:

   ```bash
   cp .env.example .env
   ```

   ```dotenv
   STORY_ARCHITECT_PORT=3000
   STORY_ARCHITECT_DATA_PATH=/mnt/tank/apps/story-architect
   STORY_ARCHITECT_IMAGE=ghcr.io/dajected/story-architect:latest
   ```

2. Pull and start:

   ```bash
   docker compose pull
   docker compose up -d
   ```

3. Open `http://<nas-address>:3000`.

Update later with:

```bash
docker compose pull
docker compose up -d
```

See [Upgrading](#upgrading) for the database backup and rollback path.

The image is public, so no registry login is needed. Available tags include
`latest`, `v0.2.0`, and `sha-<short>`. Set `STORY_ARCHITECT_IMAGE` to a version
or SHA tag for a reproducible deployment; `latest` follows the `main` branch.
`STORY_ARCHITECT_PULL_POLICY` controls checking for updates (`missing` by
default, or `always`).

### Prefer to build locally?

The Compose file intentionally references the registry image. Use the build
override when you want to build from source:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Or build and run without Compose:

```bash
docker build -t story-architect:local .

docker run -d \
  --name story-architect \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /mnt/tank/apps/story-architect:/data \
  story-architect:local
```

To build on a machine with a different architecture:

```bash
docker buildx build --platform linux/amd64 -t story-architect:local --load .
```

Images are built and pushed by
[`.github/workflows/docker.yml`](.github/workflows/docker.yml) on every push to
`main`, every `v*` tag, and by manual dispatch.

### TrueNAS notes

Use a dataset for `STORY_ARCHITECT_DATA_PATH` and make sure the container can
write to it. For a TrueNAS custom app, use the image
`ghcr.io/dajected/story-architect:latest`, publish port `3000`, and mount the
dataset at `/data`. The container is independent of any text model or ComfyUI
installation; both run elsewhere.

The health endpoint is `GET /api/health`; the Dockerfile and Compose file both
use it for container health checks. It returns `ok`, the app version, the applied
schema version, the latest schema version this build knows about, and uptime. A
database failure returns HTTP 503. Streaming replies use server-sent events at
`/api/jobs/:id/stream`, so an authenticating reverse proxy should disable
response buffering for `/api/`. There is no built-in login.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port inside the container. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `./data` | SQLite database, WAL files, and the encryption key. Mount this persistently. |
| `STORY_ARCHITECT_ENCRYPTION_KEY` | generated | 32 bytes as base64 or 64 hex characters. If unset, a key is created at `DATA_DIR/secret.key`. |
| `PUBLIC_URL` | none | Attribution URL for OpenRouter and generated links. |
| `STORY_ARCHITECT_IMAGE` | `ghcr.io/dajected/story-architect:latest` | Image Compose pulls. Pin a `sha-*` or release tag for reproducibility. |
| `STORY_ARCHITECT_PULL_POLICY` | `missing` | `missing` pulls only when absent; `always` checks for updates on every start. |
| `APP_ROOT` | working directory | Location containing `dist/`; normally leave unset. |

### Backups

There are two complementary backups.

**Project backups** are portable and credential-free. Use **Back up** beside a
novel in the library, or **Backup** in the workspace. One `.tar.gz` contains the
project, outline and chapter revisions, memory and facts, cast, lore, templates,
saved instructions, chats, image metadata, and image files. Restore it from
**Restore backup** in the library; every internal ID is regenerated, so restoring
the same file twice creates two independent projects. Connections, API keys, role
assignments, and global settings are not included, so configure those again on a
fresh installation. If an image file is missing or unreadable, backup stops and
shows an error; restore the file or remove that image from its gallery before retrying.

**Full installation backups** preserve everything, including credentials:

```bash
docker compose stop
# Use the host path you set as STORY_ARCHITECT_DATA_PATH in .env.
rsync -a /mnt/tank/apps/story-architect/ /safe/backups/story-architect/
docker compose start
```

Back up `story-architect.db`, `secret.key` (or the environment variable that
replaces it), the `images/` folder, and the `backups/` folder together. Without
the encryption key, stored API keys cannot be decrypted; manuscript text,
revisions, outline, chats, and image files are unaffected and remain readable.
Copying while the container is stopped keeps SQLite's write-ahead log consistent.

### Upgrading

1. Take a full installation backup and optionally a project backup for anything
   important.
2. Pull and recreate the container:

   ```bash
   docker compose pull
   docker compose up -d
   ```

3. Watch the container become healthy:

   ```bash
   docker compose ps
   curl -fsS http://127.0.0.1:3000/api/health
   ```

The server applies ordered SQLite migrations on boot. When the existing database
is at an older schema version, it first writes a consistent copy to
`DATA_DIR/backups/pre-migration-v<version>-<timestamp>.db` using `VACUUM INTO`.
The health response reports the applied and latest schema versions; they match
after a successful upgrade.

To roll back, stop the container, replace `story-architect.db` with the
pre-migration copy (and keep its `-wal`/`-shm` files removed), then run the older
image with `STORY_ARCHITECT_IMAGE` pinned to the previous tag.

### Recovery

- **Interrupted text generation** — after a restart, queued or running jobs become
  `interrupted`. Open the chapter; saved partial output is offered as a
  recoverable draft. Current prose is never changed automatically.
- **Interrupted image generation** — jobs become `interrupted` on boot. ComfyUI
  jobs with a remote ID resume polling the existing request. If recovery times out,
  Retry checks that same request without submitting a duplicate workflow. Other jobs
  keep their prompt for retry.
- **Lost or replaced project** — restore its project backup from the library. If
  the project still exists, the restored copy is added as a separate project, so
  the original is not overwritten.
- **Lost encryption key** — re-enter API keys in Settings. Manuscripts, chats,
  revisions, lore, and images remain readable without the key.
- **Full data-directory recovery** — stop the container, restore the saved
  `story-architect.db`, `secret.key`, `images/`, and `backups/` into
  `STORY_ARCHITECT_DATA_PATH`, then start the container. The health endpoint should
  report the expected schema version.

## First-run walkthrough

1. Open **Settings → Connections** and add OpenRouter or an OpenAI-compatible
   endpoint. Test it to discover models.
2. Open **Settings → Models & roles** and set the default model, or route
   outline and prose separately.
3. Create a novel in the library. Use **Suggest** on any field, or leave it blank.
4. In the project, generate an outline or write one manually. Edit titles and
   briefs, save, then **Approve outline**.
5. Select a chapter and **Generate chapter**. Watch tokens arrive, stop if
   needed, then edit the draft in the manuscript.
6. Open **History** to compare revisions, use a generated alternative, or
   restore an older version as a new revision.
7. Open **Cast** to add characters or propose them from the outline. Accept the
   proposals you want in the story.
8. After a chapter becomes current, open **Continuity** to review its summary
   and proposed facts. Accept the facts that are canon, supersede anything the
   new text has made obsolete, and rebuild stale summaries after editing.
9. Open **Lore** to create a lorebook, add keyword-triggered entries, and pin
   anything that must appear in the next generation. Link the same book from
   another novel to reuse it.
10. Select a passage in the manuscript to **Rewrite**, **Expand**, **Shorten**,
    or **Adjust style**. Review the proposal, edit it if needed, then apply it as
    a new revision.
11. Use **Review continuity** for an advisory check against accepted memory.
12. Under **Settings → Image service**, add an OpenAI Images-compatible endpoint or
    ComfyUI. For ComfyUI, paste an API-format workflow and map its prompt and output
    nodes. Set the image-prompt role under **Models & roles** if it should not inherit
    the default model.
13. Open **Cast**, choose a character, and select **Portrait & gallery**. Pick a
    template and optional chapter, build the prompt, edit it, then generate. Set the
    result as the character's portrait.
14. In the Outline tab, use **Generate all chapters** to draft every empty chapter in
    order once the outline is approved. Watch progress there and open any chapter as
    it lands. **Regenerate full story** rewrites every chapter instead, keeping the
    replaced drafts in revision history.
15. In the chapter editor, use **Generate portrait** beside a named character to
    create an image of them as they look at the end of that chapter. Use
    **One character, every chapter** in the same dialog to queue that image for the
    whole story.
16. Ask the assistant for help. Use **Insert into chapter** only when you want a
    message to become manuscript text.
17. **Export** downloads the current manuscript as Markdown.
18. Open **Activity** to review generation jobs, models, sampling settings, token
    usage, and estimated cost.
19. Use **Backup** in the workspace or **Back up** in the library to download a
    portable project archive. **Restore backup** in the library imports one into a
    new project.
20. For NAS maintenance, use `GET /api/health`, the pre-migration copies under
    `DATA_DIR/backups/`, and the upgrade and recovery notes above.

## How generation behaves

- Outline generation streams the raw model response and parses JSON, fenced
  JSON, a bare array/object, or a numbered list. Unreadable output is kept on
  the failed job so nothing is lost.
- The latest outline revision must be approved before drafting. Saving changes
  to an approved outline creates a new revision and pauses drafting until that
  revision is approved. Removing a chapter that already has text is refused.
- Chapter context uses required project instructions, the current brief, and
  **one compact story-state checkpoint**, never an accumulated chapter-summary
  list. Checkpoints describe the current situation, unresolved threads,
  relationships and character knowledge, and cannot exceed 4,000 characters.
  Each update uses the previous checkpoint plus one chapter's verified summary
  (or a bounded source excerpt when no current summary exists).
  Existing projects build missing checkpoints automatically before drafting.
  Earlier text or summary edits invalidate dependent checkpoints; stale state
  is excluded and rebuilt in order. Valid checkpoints are reused and backed up.
  References are retrieved by relevance to the chapter brief, extra instructions
  and current state: at most 650 tokens each for selected profiles and facts,
  and 600 tokens for activated lore. Future, unapproved and outdated facts stay
  out. Raw prose is limited to the preceding chapter's ending (300/500/650 tokens
  for Focused/Balanced/Broad). Presets cap input at 3,000/4,000/5,000 tokens;
  the packet stays bounded as the manuscript grows.
  The context inspector shows the actual story-state text, selected sections, the model's
  known window, and how much output capacity is reserved. Automatic chapter output
  capacity allows two tokens per target word plus 2,048 tokens, capped by the
  model's reply limit and half its usable context; known model windows
  also leave 5% (at least 256 tokens) for estimation and message overhead. Replies
  that reach a token limit continue from a bounded excerpt of the current draft's
  ending, with at most four requests per chapter. Automatic reply allowances can
  grow within the model limits; explicit max-output settings stay fixed. Usage
  is accumulated across requests and partial output stays recoverable on failure
  or cancellation. A full-story batch stops if a chapter still fails, leaving
  later chapters untouched rather than continuing with broken continuity.
- Every language-model request is budgeted again after rendering, including all
  messages, custom-template substitutions, reply capacity, and message overhead.
  Chat, memory, reviews, rewrites, casting, and image prompts share this check.
  Essential instructions and the latest task stay intact; optional background is
  fitted by priority, source excerpts get a minimum allowance, and old chat turns
  are omitted as whole turns. Missing model metadata uses a conservative
  16,000-token total window; advertised reply limits are checked separately.
  Requests whose essential input cannot fit are rejected before contacting the
  provider. Generation history's Context details show what was included,
  excerpted, or omitted. Token-limit replies remain partial instead of being
  applied as completed chapters, memory, rewrites, or image prompts.
- Editing or restoring a chapter changes its revision ID. Its summary is marked
  stale, and later summaries whose preceding revisions changed are marked
  potentially outdated. Rebuilding replaces the derived memory from the current
  text; later chapters are never rewritten automatically.
- Only accepted facts enter prompts. Proposed facts wait in Continuity, and
  superseded or rejected facts are excluded. Facts scoped to a later chapter, and
  plans without a scope, are kept out of earlier scenes.
- Lore activates from whole-word keyword matches in the chapter brief, extra
  generation instructions, and the last few thousand characters of preceding
  prose. Pinned entries come first, then always-include entries, then keyword
  matches by priority. Entries that do not fit the lore share of the preset
  budget are listed as excluded rather than truncated mid-entry. Pins clear after
  one generation.
- A selected-text rewrite streams as a proposal and creates no revision until you
  apply it. Applying inserts a new `rewrite` revision, keeps the previous text in
  History, and leaves the chapter summary stale for an explicit rebuild.
- A continuity review uses the memory role and is advisory only. Its report is
  stored on the job and never changes the manuscript.
- The memory role also proposes the cast from the approved outline. Proposed
  characters are excluded from context until accepted.
- Image prompts are expanded from a saved template by the image-prompt role. The
  template is rendered server-side with character, scene, clothing, style, and
  chapter details, then the model returns editable prompt text. No image request is
  made until you press **Generate image**.
- Image jobs are separate from prose and memory jobs. Only one image can run per
  character at a time. The prompt, template revision, image connection, and provider
  settings are snapshotted onto the job and the saved image, so later setting changes
  do not rewrite history.
- The OpenAI Images adapter sends `POST /images/generations` and accepts base64 or
  URL responses. ComfyUI receives an API-format workflow, polls `/history`, and
  downloads the image from `/view`. A missing mapping fails with the node details
  instead of silently generating with an empty prompt.
- Generation never overwrites current prose. If the chapter is empty, the new
  draft becomes current; otherwise it is stored as an alternative revision that
  can be previewed and explicitly made current.
- Editing current text creates an editable working revision, preserving the
  generated revision. Autosave updates that working copy; restores create new
  revisions rather than deleting intervening work.
- Jobs are persisted. Reopening the browser reattaches to a running stream. If
  the server stops mid-generation, the job is marked interrupted on restart,
  its saved partial output can be recovered as a revision, and current text is
  unchanged.

## Security model

- There are no application accounts. Run this on a trusted private network or
  behind an authenticated reverse proxy.
- API keys are encrypted with AES-256-GCM before they touch SQLite and are never
  sent back to the browser. Provider requests are made only from the server.
- Request bodies are not logged. Error messages may include provider response
  details, but not the stored key.
- The container does not host models and needs no GPU.

## Architecture

- React 19 + TypeScript interface, bundled by Vite.
- TypeScript server (Express 5) serving the built interface and API.
- SQLite through Node's built-in `node:sqlite`, with migrations tracked by
  `PRAGMA user_version`; generated files live under `DATA_DIR`.
- Text provider adapters share an OpenAI chat-completions streaming path, with
  OpenRouter-specific headers and model metadata. Image adapters implement the
  OpenAI Images API and ComfyUI separately, and generated files live under
  `DATA_DIR/images/`.
- Persisted generation jobs stream to the browser over server-sent events and
  keep partial text for recovery. The same rows feed the Activity log, including
  settings snapshots, usage, and cost estimates.
- Project archives are gzipped POSIX tar files containing a JSON manifest and the
  project's images. No archive library is added to the runtime image.
- Server code is in [`server/`](server), shared contracts in
  [`shared/`](shared), and the interface in [`src/`](src). See
  [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) for the data model and API.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

`npm test` includes unit tests for outline and continuity parsing plus an
in-process end-to-end workflow against a mock OpenAI-compatible provider covering
the stage 1 drafting loop, stage 2 memory, cast, staleness, fact review, and
context budgeting, stage 3 lore activation, pinned entries, reused lorebooks,
rewrite application, continuity review, and saved instructions, stage 4 image
prompt expansion, OpenAI Images output, ComfyUI workflow mapping, saved assets,
portrait assignment, and separation from text connections, and stage 5 health and
schema reporting, duplicate-request refusal for a running job, generation-cost
accounting, and a full project backup/restore round trip with images, memory,
facts, lore, templates, chats, and portrait links. A manual pass can use any real
endpoint. The stage completion criteria are listed in
[docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md).

## Deferred beyond stage 5

Reference-image workflows, image editing, automatic image generation, alternate
plot branches, and additional export formats remain outside the current scope.
The project archive is the supported interchange format; it is intentionally not
a general filesystem snapshot.
