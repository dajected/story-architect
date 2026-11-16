# Mobile review implementation

Date: 16 November 2026

This records the implementation of the 25 findings in [MOBILE_UI_REVIEW.md](MOBILE_UI_REVIEW.md), including the refinements agreed during review.

| Finding | Implementation |
| --- | --- |
| 1. Clipped chapter tools | Shared `ActionMenu` renders in a portal, with viewport-bounded desktop placement and an inset mobile action sheet. All action menus use it, including workspace, cast, outline, library, images, and image viewer. |
| 2. Settings overflow | Narrow headers keep the brand mark, wrap navigation, and reduce spacing. The home link retains an accessible name. |
| 3. Queue overflow | Queue uses the shared portal menu rather than anchoring a wide card to its trigger. Placement checks both viewport edges. |
| 4. Drawer accessibility | Chapter and Assistant overlays share `useDialog`: initial focus, focus trapping, Escape, scroll locking, and focus restoration. Closed mobile drawers are inert. Desktop sidebars retain nonmodal behaviour. |
| 5. Outside dismissal | Shared menus dismiss on outside pointer input. Desktop dismissal preserves the field or control the user clicked; Escape restores the trigger. Selecting an action closes the menu after the action runs. |
| 6. Role inputs | Connection, model, and optional OpenRouter provider controls stack at phone widths. |
| 7. Workspace header | Phone header uses two rows: Library/title/menu, then section picker/queue. Redundant section eyebrows and the repeated active-cast heading are hidden on phones; page headings remain. |
| 8. Reader navigation | Bottom toolbar includes a Chapters button and chapter position, plus a labelled focus toggle with expand/contract icons and pressed state. Empty queues disappear from the reader. |
| 9. Outline height | Phone chapter cards show a title and two-line brief, expanding to reveal editing and chapter actions. Empty image blocks are omitted. Unsaved edits survive collapse. Whole-novel generation controls are disclosed on phones, opening for active work or errors. |
| 10. Activity density | Four compact summary values replace the six-card overview. Filters follow immediately; token/cache/pricing explanations remain in a details disclosure. |
| 11. Empty management screens | Cast hides filters, counts, bulk image controls, and unavailable generation controls when empty. Lore has one creation action. Empty Memory hides statistics and unusable rebuild/model controls. |
| 12. Library actions | Each card retains its primary link and one More menu for backup/archive/restore/delete. |
| 13. Settings navigation | App and Novel settings use native section selects on phones; desktop navigation remains available. |
| 14. Template toolbar | Introductory copy and actions stack at narrow widths. |
| 15. Image gallery | Two columns from 360px through phone widths, using the existing fixed image aspect ratio. Compact cards retain image actions; prompt/source details remain available in the viewer. |
| 16. Field actions | Novel settings fields and Suggest buttons stack below 600px, with full-width inputs and textareas. No separate challenge textarea exists in the current implementation. |
| 17. Closed disclosures | Closed brief and image-creation disclosures use compact block layout and accessible summary targets. |
| 18. Dark surfaces | Novel creation uses existing theme tokens for its kicker, helper copy, and note. |
| 19. Danger contrast | Library deletion uses the existing theme-aware danger token. |
| 20. Safe areas | Viewport opts into `viewport-fit=cover`; top headers, mobile drawers, action sheets, and the existing reader/viewer bottom controls account for safe-area insets. Physical-device validation remains outstanding. |
| 21. Character star | Star hit area is at least 44 × 44px. |
| 22. Queue polling | Polls at 2.5s during work, backs off to 15s when idle and up to 30s on failures, pauses while hidden, and refreshes when visible or after an API mutation. Requests do not overlap. |
| 23. Assistant wording | Touch users see “Tap Send when ready”; disabled Send uses a quieter secondary surface. Keyboard shortcuts remain available. |
| 24. Chapter image dialog | Uses the same compact two-column gallery on phones from 360px, opening images in the existing full-screen viewer. |
| 25. Library utilities | Restore backup and archive visibility have bordered secondary buttons; the archive toggle exposes its expanded state. |

## Validation

Checks passed: TypeScript type checking, production build, 105 unit/integration tests, and 19 Playwright UI tests. The production build reports a non-blocking bundle-size warning.

The mobile regression suite uses Chromium mobile contexts with touch and DPR 2 at 320, 390, and 768px, in light and dark themes. It checks both the requested layout viewport width and document overflow across every workspace section and Settings section.

Behaviour checks cover bounded action sheets, outside dismissal, action execution, drawer focus trapping/restoration, Escape, inert closed drawers, scroll-lock cleanup, collapsed outline edits, stacked role inputs, queue backoff/visibility, desktop outside-click focus, compact galleries, empty management screens, and Novel settings field actions. Existing reader, generation, nested-dialog, and desktop workflows are retained in the UI suite.

Screenshots produced by the UI suite are in `work/test-results/` for local inspection. They are generated artifacts rather than committed baselines.

## Device checks still needed

Emulation cannot verify physical notches, status bars, or software keyboards. Check iOS Safari, Android Chrome, and an installed/standalone browser session, including safe areas, opening the Assistant keyboard, scrolling action sheets, and focus restoration. No physical-device pass was performed in this workspace.
