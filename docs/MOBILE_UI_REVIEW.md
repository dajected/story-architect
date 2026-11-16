# Mobile UI review

Date: 16 November 2026
Scope: every route and overlay in the web client at phone and small-tablet widths.

## Method

- Chromium mobile emulation (touch, DPR 2) at **390 x 844** and **320 x 700**, plus **768 x 900** for the tablet breakpoint.
- Light and dark themes.
- Screens: Library, Reader/Manuscript, Outline, Characters, Story memory, World notes, Activity, Images, Settings (Connections, Models & roles, Advanced generation, Prompt templates, Image services, Image prompt templates).
- Overlays: workspace menu, chapter tools, work queue, chapter drawer, Assistant drawer, New novel modal, Novel settings modal, Chapter images modal, portrait studio, appearance notes, image viewer.
- Behaviour checks: viewport/layout width, horizontal overflow, Escape dismissal, focus placement, backdrop dismissal, native menu dismissal.
- Source review of `src/styles.css` and the affected components.
- Data came from the seeded UI-test database. Empty-state findings were observed on the "Mobile reading" project; populated findings used "The Glass Harbour".

The review is a code and emulation review, not a physical-device pass. iOS Safari, Android Chrome, and standalone/PWA safe areas still need a real-device check.

## Verdict

The mobile reader is in good shape: it uses document scrolling, hides its chrome on scroll, keeps a fixed 44px navigation bar, and accounts for the bottom safe area. Dialogs share a genuinely accessible implementation (focus trap, Escape, scroll lock, `aria-modal`).

The weak points are the navigation shell and the management screens. The workspace keeps a three-row header on every phone screen, action menus can render off-screen, two drawers are not keyboard or screen-reader dialogs, and several pages are much taller than they need to be. At 320px the Settings header and the work-queue popover actually exceed the viewport.

## Findings

### P1 - blocks or seriously breaks use

1. **Chapter tools menu opens partly off-screen.**
   `.action-menu-content` is right-anchored with a 290px width (`src/styles.css:4356`). In the chapter header the trigger sits at x=150 on a 390px screen, so the menu runs to x=-50 and its labels are clipped. At 320px it is worse.
   Evidence: `work/mobile-review/16-chapter-tools-clipped.png`.
   Recommendation: on `max-width: 720px` render action menus as a bottom sheet or a fixed panel inset by 12px, not an absolutely positioned 290px card. Apply the same treatment to the workspace menu, cast "More" menu, and image-viewer menu.

2. **The Settings page forces a 352px layout on a 320px phone.**
   `.page-header` is a single non-wrapping row (`src/styles.css:708`) and `.page-nav` is a non-wrapping flex row (`src/styles.css:739`). Brand + Library + App settings + Dark measure 352px, so mobile Chrome shrink-to-fits the page and clips the theme toggle off the right edge.
   Evidence: `work/mobile-review/14-settings-320-overflow.png`.
   Recommendation: below 420px hide the brand wordmark (keep the mark), reduce the nav gap, and let the header wrap. Do not rely on `scrollWidth` tests alone; assert `window.innerWidth` equals the requested width.

3. **The work-queue popover overflows the viewport.**
   It is `left: 0` with `width: min(360px, 90vw)` (`src/styles.css:4587`). At 320px the trigger is at x=80, so the 288px panel reaches x=368 and expands the mobile layout viewport to 369px, clipping the "Activity" action.
   Evidence: `work/mobile-review/15-queue-320-overflow.png`.
   Recommendation: right-align the popover to its trigger and cap it with `max-width: calc(100vw - 24px)`, or turn it into a bottom sheet under 720px. Also place it in a portal so the topbar cannot clip it.

4. **The chapter and Assistant drawers are overlays without dialog behaviour.**
   `ChapterSidebar` (`src/components/ChapterSidebar.tsx:41-49`) and `AssistantPanel` (`src/components/AssistantPanel.tsx:249-260`) render a scrim plus a fixed panel, but neither has `role="dialog"`, `aria-modal`, a focus move, a focus trap, or Escape-to-close. The global Escape handler only clears focus mode (`src/pages/WorkspacePage.tsx:129`). Opening the Assistant leaves focus on the menu summary behind the scrim.
   Recommendation: reuse the `Modal` hook from `src/components/ui.tsx:95-119`, or extract it into a shared `useDialog` hook and apply it to both drawers. Restore focus to the trigger on close.

### P2 - significant friction or layout damage

5. **Menus do not close on an outside tap.**
   All action menus are native `<details>` elements. Tapping the manuscript or another card leaves them open; only an explicit item click or Escape closes the workspace menu. Verified for the workspace menu and Chapter tools.
   Recommendation: add one document-level `pointerdown` handler that closes any open `details.action-menu`/`.workspace-menu` when the click is outside it, and restore focus to its summary.

6. **Model role controls are unusable on narrow screens.**
   `.role-row` stacks to one column at 900px, but `.role-inputs` remains a flex row and its select has `width: 42%; min-width: 130px` (`src/styles.css:1104-1148`, mobile rule at `2528-2588`). The connection select and model field are squeezed side by side; the model placeholder is visibly truncated at 390 and 320. The third OpenRouter provider select makes it worse.
   Evidence: `work/mobile-review/12-settings-models-390.png`.
   Recommendation: at `max-width: 720px`, make `.role-inputs` a one-column grid with all controls at 100% width.

7. **The workspace header is three rows deep and repeats the section name.**
   At 720px and below, the tabs are replaced by the section picker (`src/styles.css:4644-4648`), producing: row 1 Library + Queue, row 2 project title + Menu, row 3 the section select. The select value is then immediately repeated as an eyebrow and an H1 (Characters, Story memory, World notes), and Cast adds a fourth "Characters" heading above the filters.
   Recommendation: collapse to two rows (back + title + menu on row 1; section picker + queue on row 2), or move the queue into the menu. Drop the eyebrow where the select already names the section. Do not repeat the page title as a filter heading.

8. **Reader navigation is buried and the toolbar lacks context.**
   Chapter switching requires Menu -> Workspace -> Show chapters. The fixed bottom bar only offers Previous / Focus on story / Next (`src/components/ChapterEditor.tsx:804-806`), and it does not say which chapter is open once the headers hide. "Focus on story" is also an unclear label for a chrome-hiding mode.
   Recommendation: add a Chapters button (or a chapter counter such as "1 / 2") to the bottom bar and an icon for focus mode. Keep the queue out of the reader topbar when it is empty.

9. **The outline is extremely tall on phones.**
   Each chapter card is roughly 320px tall at 390px (title, brief, an empty "No chapter images yet" block, and an "Edit order" button). A 25-chapter outline is roughly 8,000px of scrolling.
   Evidence: `work/mobile-review/04-outline-cards-390.png`, `work/mobile-review/19-long-outline-390.png`.
   Recommendation: make chapter cards collapsible (title + two-line brief by default), hide the image block when there are no images, and replace per-chapter "Edit order" with one reorder mode or a chapter action menu.

10. **Activity is dominated by six large stat cards.**
    The 2 x 3 metric grid consumes more than one phone screen before the filters and log appear. The explanatory paragraph is six lines.
    Recommendation: one compact summary row (jobs, tokens, cost, attention) plus a "Details" disclosure for cache/usage wording. Move the filters directly below the summary.

11. **Empty management screens keep controls that cannot be used.**
    Cast with no characters still shows All/Key filters, "Create images for all" (disabled), and two count labels before the empty state; Lore shows "New lorebook" and then a second "Create a lorebook" button. Memory spends its first screen on explanation and a 2 x 2 stat grid.
    Recommendation: when a collection is empty, show the primary action and one short empty state only. Hide filter and bulk controls until there is content.

12. **Library card actions wrap badly and put Delete beside Archive.**
    `.library-list .project-card-actions` wraps at 760px (`src/styles.css:4615-4617`). At 390 the second row contains only "Delete"; at 320 all four actions wrap.
    Recommendation: keep one primary "Continue" link and move Back up / Archive / Delete into a single overflow menu. This also reduces destructive-action adjacency.

13. **Settings navigation wraps into three or four ragged rows.**
    `.settings-nav nav` goes from a column to a wrapping row at 900px (`src/styles.css:2528-2543`) but keeps the vertical-tab active style (inset left accent, `src/styles.css:997-1001`). The same problem appears inside Novel settings, where the tabs take four rows before the first field.
    Recommendation: use a select, a horizontally scrollable chip row, or an accordion on phones. Give the selected chip a bottom border or filled background, not a left accent.

14. **Prompt-template intro and button fight for width.**
    `.section-toolbar` is a non-wrapping flex row (`src/styles.css:1169-1174`). On phones the paragraph is forced into a four- to six-line column next to the "New template" button.
    Recommendation: stack the toolbar below 600px; place the action after the paragraph or make it full width.

15. **The image gallery is one enormous column.**
    `.image-gallery` becomes `minmax(min(230px, 100%), 1fr)` (`src/styles.css:4386`), so a 390px content area can only fit one column and each portrait fills the screen.
    Recommendation: use two columns from 360px upward (`minmax(140px, 1fr)`) with a fixed aspect ratio, or a horizontal filmstrip with the selected image below it.

### P3 - polish, consistency, and robustness

16. **Novel-settings field actions are squeezed.** Title/premise inputs sit beside a "Suggest" button. Stack the Suggest action under the field below 600px, and make the challenge textarea full width.

17. **Collapsed cards have excess empty height.** "Chapter brief and continuity" and "Create images" keep noticeable blank space when closed. Tighten the summary padding/min-height at `max-width: 720px`.

18. **Dark mode has hard-coded light surfaces.** The quick-create note uses `background: #f0f5fc; color: #49658d` (`src/styles.css:4603`) and the kicker uses `#4167a4` (`src/styles.css:4595`). Both are visibly wrong in the dark New novel modal. Move them to theme tokens.

19. **Danger text fails contrast in dark mode.** `.library-delete` is `#b14c4c` (`src/styles.css:4616`), about 4.0:1 against the dark surface, below AA for 13px text. Use a semantic danger token that lightens in dark mode.

20. **Safe-area top inset is missing.** The reader bottom bar uses `env(safe-area-inset-bottom)` (`src/styles.css:4658`), but the sticky `.page-header` and `.workspace-topbar` do not use the top inset. In standalone/PWA mode the header can sit under the status bar/notch.

21. **The character star is a small target.** `.character-star` is 30px wide (`src/styles.css:4548`). Give it a 44px hit area even if the glyph stays 24px.

22. **Queue polling runs every 2.5s even when idle.** `WorkspaceQueue` polls unconditionally (`src/components/WorkspaceQueue.tsx:18`). Back off when the count is zero and pause on `visibilitychange`.

23. **Desktop wording leaks into the phone UI.** The Assistant shows "Ctrl+Enter to send"; on touch it should say "Send" or "Tap Send". The disabled send button also stays visually prominent.

24. **The chapter-images dialog shows one full-bleed image.** With multiple images the user must scroll a large image to reach the next one. Use a thumbnail strip or a 2-column grid inside the dialog.

25. **The library utility actions look like plain text.** "Restore backup" and the archive toggle have no border or icon. Group them in an overflow menu or give them a clear secondary treatment.

## What already works

- The reader uses document scrolling, hides chrome after a 16px scroll, restores it near the top, and keeps 90px of bottom padding for the fixed toolbar.
- Touch targets are raised to 44px under `pointer: coarse`, and prose/input text is increased.
- Prose measure, line height, and contrast are comfortable at 390 and 320.
- Modals are accessible: focus is moved inside, Tab is trapped, Escape closes, body scroll is locked, and focus is restored (`src/components/ui.tsx:95-119`).
- The image viewer becomes a true full-screen surface with safe-area padding and clear Previous/Next/More controls.
- The work-queue count, save state, and generation status are announced and visible.
- The workspace section picker is an accessible native select at phone widths.

## Suggested order of work

1. Action-menu placement (bottom sheet under 720px) and outside-tap dismissal.
2. Settings 320px header, work-queue positioning, and a real 320px mobile-context regression test.
3. Dialog semantics, Escape, and focus management for the chapter and Assistant drawers.
4. Stack role inputs and panel header/actions.
5. Compress the workspace header and remove repeated section labels.
6. Reader chapter navigation in the bottom bar.
7. Collapse outline cards and compact Activity/Memory/Cast empty states.
8. Library and Settings navigation as overflow/select patterns.
9. Gallery grid, prompt-template toolbar, dark tokens, and safe-area/contrast polish.

## Test gap

The current responsive tests only assert `document.documentElement.scrollWidth <= innerWidth + 2` (`tests/workspace.e2e.ts:84-86`, `193-198`). Mobile Chrome can expand `innerWidth` itself when content has a minimum width, so the Settings failure passes that check. Add assertions that `innerWidth` equals the requested viewport, and cover `/settings`, the Queue popover, and open action menus at 320px in a mobile context.
