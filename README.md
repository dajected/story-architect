<img src="assets/icon.svg" width="64" height="64" alt="">

# Story Architect

A self-hosted AI writing workspace for novels. Plan a premise, approve a chapter
outline, draft chapters with a model of your choice, revise with full history,
talk ideas through with an assistant, and export the manuscript as Markdown.

Stage 1 is implemented: the complete outline-to-chapter workflow described in
[docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md).

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
- **Simple context presets** — Focused, Balanced, and Broad, assembled from
  project instructions, the current brief, and recent preceding prose within a
  token budget. The estimated context size is shown before generation.
- **Assistant chat** — conversations saved separately from the manuscript, with
  streaming replies. Suggestions enter the manuscript only through an explicit
  "Insert into chapter" action.
- **Markdown export** — current chapter text in manuscript order.
- **Docker** — a Linux amd64 image and Compose file with persistent `/data`
  storage for the TrueNAS host.

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

## Run on the NAS with Docker

1. Copy `.env.example` to `.env` and set the storage path:

   ```bash
   cp .env.example .env
   ```

   ```dotenv
   STORY_ARCHITECT_PORT=3000
   STORY_ARCHITECT_DATA_PATH=/mnt/tank/apps/story-architect
   ```

2. Build and start:

   ```bash
   docker compose up -d --build
   ```

3. Open `http://<nas-address>:3000`.

The image targets Linux amd64. To build it on another machine:

```bash
docker buildx build --platform linux/amd64 -t story-architect:0.1.0 --load .
```

If you prefer not to use Compose, build and run directly:

```bash
docker build -t story-architect:0.1.0 .
docker run -d \
  --name story-architect \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /mnt/tank/apps/story-architect:/data \
  story-architect:0.1.0
```

On TrueNAS, use a dataset for `STORY_ARCHITECT_DATA_PATH` and make sure the
container can write to it. The Compose file publishes the application's only
port and keeps the application container independent of any text model or
ComfyUI installation; both run elsewhere.

The health endpoint is `GET /api/health`; the Dockerfile and Compose file both
use it for container health checks. Streaming replies use server-sent events at
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
| `APP_ROOT` | working directory | Location containing `dist/`; normally leave unset. |

### Backups

Stop the container before copying the data directory so SQLite's write-ahead
log is consistent:

```bash
docker compose stop
rsync -a "$STORY_ARCHITECT_DATA_PATH"/ /safe/backups/story-architect/
docker compose start
```

Back up `story-architect.db`, `secret.key` (or the environment variable that
replaces it), and any future asset folders together. Without the encryption key,
stored API keys cannot be decrypted; manuscript text, revisions, outline, and
chats are unaffected and remain readable.

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
7. Ask the assistant for help. Use **Insert into chapter** only when you want a
   message to become manuscript text.
8. **Export** downloads the current manuscript as Markdown.

## How generation behaves

- Outline generation streams the raw model response and parses JSON, fenced
  JSON, a bare array/object, or a numbered list. Unreadable output is kept on
  the failed job so nothing is lost.
- The latest outline revision must be approved before drafting. Saving changes
  to an approved outline creates a new revision and pauses drafting until that
  revision is approved. Removing a chapter that already has text is refused.
- Chapter context uses project instructions, the chapter brief, and the current
  text of preceding chapters. The context preset sets an approximate budget;
  the inspector line before generation shows estimated tokens and how many
  earlier chapters were trimmed.
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
- Provider adapters share an OpenAI chat-completions streaming path, with
  OpenRouter-specific headers and model metadata.
- Persisted generation jobs stream to the browser over server-sent events and
  keep partial text for recovery.
- Server code is in [`server/`](server), shared contracts in
  [`shared/`](shared), and the interface in [`src/`](src). See
  [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) for the data model and API.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

`npm test` includes unit tests for outline parsing and word counting plus an
in-process end-to-end workflow against a mock OpenAI-compatible provider. A
manual pass can use any real endpoint. The stage 1 completion criteria are listed
in [docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md).

## Deferred beyond stage 1

Memory and character tracking, lorebooks, rewrite tools, image generation, and
backup tooling are planned in later stages. The data model reserves roles and
tables for them, but the stage 1 interface does not expose those features.
