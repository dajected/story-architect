# UI review implementation

Implemented against the 48-item review and the interactive concepts in `work/ui-mockups.html`. The live interface uses real project data; illustrative mockup content is not installed in the library.

| Review items | Implementation |
| --- | --- |
| 1–2 | Chapter images action with a count beside the title; compact selected-image strip; full controls and alternatives in a dialog. |
| 3–5 | One persistent image per character per chapter, independent of the main character portrait. Selected chapter thumbnails appear in the manuscript. |
| 6–7 | Quick generation and editable portrait studio; start, end, and custom story moments. Changing the chapter or moment clears the previous prompt. |
| 8 | Saved project art direction and selectable character reference images. ComfyUI uploads references and maps them to a configured LoadImage node. |
| 9 | Review/edit appearance, outfit, scene, style, instructions, and the final interpreted image prompt before sending it to the service. |
| 10 | Captured source revision and SHA-256 content fingerprint; old/unknown sources are labelled for review, including edits within an existing editable revision. |
| 11 | Select multiple cast members, inspect request count, confirm batch submissions, and see active and completed/failed/cancelled/interrupted statuses. |
| 12–13 | Shared in-app viewer with full-image fit, zoom, navigation, download, selection, customization, and deletion. Thumbnails preserve the full image. |
| 14–15 | Cast appearance timeline in chapter order; Images workspace section with chapter, character, and selected-image filters. |
| 16 | Actionable missing-service/model guidance and a return-to-project link from settings. |
| 17 | Per-request outcomes and status counts; cancellation/failure is never reported as successful generation. |
| 18 | Named individual downloads and self-contained illustrated HTML manuscript export. Selected images are embedded so the download works away from the server. Plain Markdown export remains available. |
| 19 | Two-row workspace navigation and a project menu for export, backup, settings, theme, and writing preferences. |
| 20–21 | Focus mode; remembered panel state; keyboard/pointer panel resizing; saved font size, line spacing, and text width. |
| 22–23 | Collapsed brief/continuity details and a secondary chapter-tools menu, keeping drafting prominent. |
| 24–25 | Saved workspace section; explicit Continue writing links; chapter selection opens the manuscript from any section. |
| 26–28 | Saved/saving/unsaved feedback, prose display preferences, and discoverable focus/assistant/preview/chapter shortcuts. |
| 29–31 | Approval previews added, reordered, edited, and removed chapters. Existing manuscripts remain editable while an outline is pending. Removal of chapters containing text remains blocked by the server. |
| 32–33 | Scannable Cast cards with short descriptions, expandable full profiles, search, and status/missing-portrait filters. |
| 34 | Structured continuity findings show the source passage, established reference, affected chapter, and suggested correction. Accept/dismiss decisions persist on the device. Applying a correction validates the unchanged manuscript and creates a new revision. Older free-text reports remain readable. |
| 35 | Continuity navigation, heading, and role terminology, with explanations of summaries, accepted facts, and prompt participation. |
| 36–37 | First-run writing/image setup checklist; title/premise-first novel creation with optional genre, voice, and standing instructions. |
| 38–39 | Continue writing/review outline actions, library sorting, and persistent compact/card views. |
| 40–42 | Image setup explains the text-model/service/template relationship. Effective model sources and per-field generation inheritance are visible, with reset-to-inherited settings. Endpoint and sampling details are expandable. |
| 43–47 | Larger workspace utility labels, touch targets, focus outlines, modal focus trapping/restoration, selected/current navigation semantics, live status announcements, and shared asynchronous in-app confirmations. |
| 48 | Automated populated-layout checks at 320, 390, 720, 1024, and 1440px, plus 200% CSS zoom, keyboard focus, nested dialogs, and actual image decoding. |

## Additional defects fixed

- Image files inside dot-directory installations such as `.t3` were refused by Express's default file-serving policy. Image serving now allows those validated paths.
- Project generation settings selected the database column as `settings` but read it as `value`, silently discarding overrides. Reads now use the correct alias.
- A remembered Assistant state could cover the editor on small screens. Narrow layouts start with the Assistant closed and close it when crossing the breakpoint.
- Chapter selection, source fingerprints, art direction, and reference-image IDs survive backup/restore with remapped IDs.

## Validation

- `npm run typecheck`
- `npm test` — 28 tests, including selected-image isolation, stale sources, backup/restore, illustrated export, settings inheritance, reference uploads, and revision-preserving corrections.
- `npm run test:ui` — end-to-end chapter image generation with mock providers, batch confirmation/status, viewer/studio/timeline navigation, focus mode, responsive layout, decoded portraits, setup, search, and keyboard focus. Uses installed Microsoft Edge and isolated test data.
- `npm run build`
- `git diff --check`

## Provider limits

Image prices are not supplied by the configured services, so the UI displays request counts and states that cost estimates are unavailable. Reference-image conditioning is implemented for configured ComfyUI workflows; the existing OpenAI-compatible generation adapter uses the written character profile. Provider tests use local mocks and do not spend credits or contact a live paid service.

Illustrated export preserves manuscript Markdown as readable text and embeds the selected portraits. It is a portable HTML document, not a typeset book/PDF export.
