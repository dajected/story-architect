# Story Architect product plan

Status: stage 1 implemented. See [README](../README.md) and
[IMPLEMENTATION.md](IMPLEMENTATION.md); later stages remain planned.

## Agreed direction

- A self-hosted AI writing workspace for novels, with both a manuscript editor and a chat assistant.
- Ask about premise, genre, tone, point of view, tense, chapter count, chapter length, writing style, and content preferences when creating a project. Allow an explicit "let the AI suggest" answer and later editing.
- Generate an editable chapter outline first. The author approves it before chapter drafting becomes available.
- Generate chapters individually, with manual editing and version history.
- Support third-party connections and separate model choices for planning, prose, memory, and image-prompt creation.
- Initial text providers are OpenRouter and custom OpenAI-compatible endpoints.
- Use simple context presets rather than requiring detailed prompt configuration.
- Maintain chapter summaries and story continuity; propose changes to established facts for review.
- Keep lorebooks simple. Imports are outside the initial scope.
- Generate images on demand for a selected story character, through ComfyUI or an image API. Reference images are outside the initial scope.
- Run on the user's custom TrueNAS machine on x86-64 using Docker, without application user accounts. The deployment image targets Linux amd64.
- Deliver working increments, with each stage usable before starting the next.

## Working defaults

These are recommendations rather than additional user requirements.

- A quiet writing workspace: chapter navigation on the left, manuscript in the centre, collapsible assistant on the right.
- A guided setup form rather than a long compulsory chat interview.
- Markdown manuscript export first, since no particular export format is required.
- Add native provider adapters beyond the agreed OpenRouter and custom OpenAI-compatible connections only as needed; a custom URL does not imply support for every provider's protocol.
- Start with one default model and allow each task role to inherit it or select another connection/model.
- Single linear manuscript with restorable revisions. Alternate plot branches are deferred.
- Desktop browser first, with responsive layouts for smaller screens.

## Core user journey

1. Add and test a text connection, then choose the default model.
2. Create a novel through the setup questionnaire.
3. Generate the outline, edit chapter titles and briefs, and approve it.
4. Select a chapter and optionally give additional instructions.
5. Generate a draft, edit it in the manuscript, or ask the assistant for help.
6. Accept a chapter revision as the current text. Generated alternatives never silently overwrite existing prose.
7. From stage 2 onward, update its summary and review proposed continuity changes.
8. Repeat for later chapters and export the manuscript.
9. From stage 4 onward, select a story character and generate images using a chosen prompt template.

The assistant can brainstorm, discuss the outline, and suggest edits. Its conversation is saved separately from the manuscript. Suggestions affect the manuscript only through an explicit apply action; brainstorming does not automatically become story canon.

## Stage 1: usable outline-to-chapter workflow

### Scope

- Linux amd64 Docker image and Compose configuration for the TrueNAS host, with persistent application data and a configurable host storage path.
- Novel library: create, open, rename, and archive projects.
- Connection manager: named connections, server-side API credentials, endpoint URL, connection test, model discovery where supported, and manual model IDs.
- Model roles for outline, prose, memory, and image-prompt generation; unused roles can be configured before their features ship.
- Global defaults with project overrides, including generation length and provider-supported sampling settings.
- Editable prompt presets for outlining and prose generation.
- Project questionnaire and editable, versioned chapter outline.
- Explicit outline approval. Structural outline changes create a new revision; affected unstarted chapters need an approved brief before drafting.
- Manuscript editor, assistant chat, autosave, word counts, and chapter navigation.
- Streamed chapter generation, stop/cancel, visible failures, and retained partial drafts.
- Chapter revision history, preview, and restore. Restoring creates a new revision rather than deleting intervening work.
- A simple context preset selector. Initially use project instructions, the current chapter brief, and recent preceding prose within a budget. Stage 2 adds persistent memory.
- Markdown export of current chapter text in manuscript order.

### Completion criteria

- A user can configure a real provider, complete setup, approve an outline, draft two chapters, edit and restore a revision, and export the manuscript.
- Restarting or recreating the container preserves projects, connection settings, chats, and revisions.
- A failed or cancelled generation leaves existing text intact and any saved partial draft recoverable.
- Task model overrides work without changing the project's other model roles.

## Stage 2: memory, characters, and revision awareness

### Scope

- Characters can be created manually or proposed from the outline and accepted into the story's cast.
- Character profiles cover identity, appearance, personality, goals, and relationships. Stable IDs connect characters to chapters, facts, and later images.
- Automatic chapter summaries derived from the accepted manuscript revision.
- Track character developments, relationships, timeline events, and unresolved plot threads as reviewable fact updates with source chapter/revision references.
- Distinguish authored world facts, established events, and future plans. Future outline beats are labelled as plans rather than events that already happened.
- Simple context presets: Focused, Balanced (default), and Broad. These control how much recent prose, summary detail, and relevant memory is included; exact budgets are calibrated during implementation.
- Reserve output capacity and reject an oversized required context with a useful explanation rather than silently dropping essential instructions.
- Context inspector showing included sections, selected model, and token estimates. Estimates are labelled when exact token counting is unavailable.
- Editing or restoring an earlier chapter marks its derived memory and dependent later material as potentially outdated. Rebuild summaries from current text and review fact changes; do not silently rewrite later chapters.
- Facts can be scoped to a chapter or story point, so later developments do not leak into earlier scenes as established events.

### Completion criteria

- Later chapter requests include preceding summaries and relevant character facts while staying within the configured budget.
- An edited early chapter produces a visible stale-memory state; rebuilding updates the derived information against its source revision.
- Superseded facts stop entering new prompts. Proposed canon changes require acceptance.
- Selecting a chapter does not treat future events as completed history.

## Stage 3: simple lorebooks and writing tools

### Scope

- One or more lorebooks attached to a novel; reusable books may be linked to other novels.
- Entries have a title, text, keyword triggers, enabled state, priority, and an optional always-include flag.
- Manual inclusion for the next generation and a list explaining which entries activated.
- Match against the current chapter brief, additional generation instructions, and bounded recent prose. Deduplicate entries and respect the lore budget.
- No recursive activation, embeddings, or import compatibility in this stage.
- Selected-text rewrite, expand, shorten, and style adjustment actions, with proposed changes and revision preservation.
- Reusable prose instructions and continuity review using the same model-routing system.

### Completion criteria

- Relevant lore activates predictably, and the context inspector explains inclusion and budget exclusions.
- An accepted rewrite creates a recoverable revision and invalidates affected derived memory.

## Stage 4: character image generation

### Scope

- Select an existing story character explicitly; optionally choose the chapter whose appearance/state should be used.
- Create and save image-prompt templates with variables such as character name, appearance, clothing, scene, and visual style.
- Route template expansion through the configured image-prompt LLM role.
- Preview and edit the resulting image prompt before submitting it to the image service.
- Separate image connection settings from text-model connections.
- ComfyUI integration using a configured workflow and mapped prompt/output fields, plus an initial API adapter selected before this stage begins.
- Track queued/running/completed/failed image jobs and allow local cancellation; remote cancellation depends on provider support.
- Save images in a character gallery with the prompt, template revision, provider settings, and character link.
- Set an image as the character's portrait. No reference-image workflow is required.

### Completion criteria

- A selected character can generate an editable image prompt and receive a saved image through ComfyUI and the selected API adapter.
- Browser refreshes preserve job state. Interrupted jobs reconcile with the provider where possible and otherwise display a recoverable interrupted state.
- Changing image settings does not alter the prose model configuration.

## Stage 5: NAS operation and polish

### Scope

- Project backup and restore, covering manuscript, revisions, accepted memory, lore, templates, chats, and images. Credentials are excluded from portable project backups.
- Document full installation backup separately, including how to preserve credential encryption keys when used.
- Clear generation history with model, settings, available token usage, and estimated cost where provider pricing is known.
- Improve long-novel navigation and editor performance based on actual use.
- Container health checks, upgrade instructions, database migrations, and documented recovery.
- Additional export formats or provider adapters only where needed.

### Completion criteria

- Restore a project backup into a fresh installation and confirm text, revisions, relationships, and assets survive.
- Upgrade a populated installation without losing data.
- Confirm a long-running provider task reports its state after a browser refresh or server interruption and does not silently submit duplicate paid requests.

## Proposed architecture

- React and TypeScript browser interface, with a TypeScript server serving the UI and handling provider calls.
- SQLite for structured data, plus files for generated images and exports. The database lives on storage local to the NAS host, exposed to the container as persistent storage; other devices use the application API rather than opening the database over SMB/NFS.
- One application container and one persistent data location initially. Text models and ComfyUI run externally; no model hosting or GPU requirement inside this container.
- Provider adapters keep text and image protocols separate. Supported features are explicit per adapter rather than assumed from a model name.
- A context builder assembles project instructions, chapter brief, story memory, lore, and recent prose with clear budgets and provenance.
- Persisted generation jobs and manuscript revisions prevent a closed browser from losing work. Stage 1 marks interrupted jobs and retains saved drafts; provider reconciliation grows with later integrations.
- API credentials stay on the server and are masked in responses and logs. The initial deployment is for a private NAS network or existing authenticated reverse proxy, without built-in accounts.
- Package and validate the deployment image for Linux amd64, matching the confirmed x86-64 TrueNAS host. Record any deployment checks that still require access to the actual NAS.

Design the data model around projects, outline revisions, chapters, chapter revisions, conversations, connections, task model assignments, prompt templates, generation jobs, characters, memory records, lorebooks, and image assets. Add feature-specific tables as stages ship, using migrations.

## Deferred decisions

These do not prevent stage 1 planning or implementation:

- Choose the first hosted image API and ComfyUI workflow before stage 4.
- Tune preset budgets and the exact editor styling against the first working build.

## References

- SillyTavern connection profiles: https://docs.sillytavern.app/usage/core-concepts/connection-profiles/
- SillyTavern lorebooks: https://docs.sillytavern.app/usage/core-concepts/worldinfo/
- Marinara Engine features: https://github.com/Pasta-Devs/Marinara-Engine#features
- React UI components: https://react.dev/
- SQLite deployment suitability and database placement: https://www.sqlite.org/whentouse.html
- Docker persistent volumes: https://docs.docker.com/engine/storage/volumes/
