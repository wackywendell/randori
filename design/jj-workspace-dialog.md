# jj workspace dialogs and menus

Author: Wendell Smith
Status: Approved
Date: 2026-11-21

---

## Overview

This design updates how Randori creates, opens, and finishes jj workspaces across multi-repository and multi-tab Herdr spaces. Randori is a set of JavaScript mods for Herdr that adds Jujutsu (jj) workspace management alongside Herdr's shipped Git behavior. See [jj workspace lifecycle in Herdr](./jj-workspace-lifecycle.md) and [README](../README.md) for background on Randori's existing mods (`jj-spaces`, `jj-changes`, `jj-tabs`, `jj-menu`, `jj-new-menu`, `jj-workspace`), workspace path templates, `links` symlinking, and `mise trust`.

This design makes two connected changes.

1. Unified New and Open dialog. The separate New workspace and Open workspace dialogs become one dialog titled jj workspace with two views, New and Open. It discovers every jj repository open in the target space, expands lazily to repositories open in other spaces, and opens a workspace either via Enter (switching to an existing terminal in that checkout or opening a new nested space) or via Shift+Enter (opening a new tab in the target space when on the same machine).
2. Multi-repository and tab-scoped Finish. Finish jj workspace becomes available from both a tab's right-click menu and a space's right-click menu whenever a terminal works in a linked jj workspace. It supports linked workspaces across multiple repositories in one space, pre-checks all linked workspaces in the clicked or active tab, and names every individual terminal (including parent-owned child terminals) in each checked checkout before confirmation.

This document uses these terms.

- A jj workspace is a checkout folder on disk that shares one repository's history with its sibling checkouts. The first checkout is the main checkout, and every other checkout is a linked workspace.
- A repository is the shared jj store identified by its main checkout path and machine. Two tabs working in different linked workspaces of the same repository belong to one repository entry.
- `@` is the working-copy change a checkout is editing, and `@-` is its parent revision in jj history (a commit in the repository graph).
- A Herdr space (referred to below as a space) is a named group of tabs in Herdr's left sidebar. A space can hold tabs working in several repositories or jj workspaces, and every tab inside a space runs on that space's machine (local or one remote machine).
- A Herdr tab holds one or more split panes. A Herdr pane displays either a terminal or a mod view.
- A parked terminal is a live Herdr Core terminal not currently shown in any pane of any space (such as a parked sub-agent or background worker).
- A dialog overlay is a modal centered overlay dismissed by Escape. A window overlay is a draggable non-modal window that stays open even if its originating space closes.
- The target space is the space the dialog operates on. It is the active space when opened from the tab bar + menu or a key binding, and the right-clicked space when opened from the sidebar space menu.
- The active view is either New or Open inside the jj workspace dialog. Tab and Shift+Tab switch between the two views, keeping the typed text and the chosen repository.
- The entry points are the tab bar + menu (`jj-new-menu`), a space's right-click menu (`jj-menu`), a tab's right-click menu (`jj-menu`), and a user key binding in `keys.json` mapped to `mod.open:jj-workspace`.

All user-facing menu labels, dialog titles, and notifications use the phrase jj workspace so they stay distinct from Herdr spaces and Git worktrees. Finish jj workspace remains a separate window overlay because it ends terminals and deletes folders.

## The Problem

Creating, opening, and finishing jj workspaces in Randori currently assume one repository per space and one checkout per space.

- In a space whose tabs touch more than one repository, New and Open inspect only a single folder (the space's first terminal or the focused pane). Working on another repository open in the same space forces you to focus a terminal in that repository first or switch spaces.
- Starting a new jj workspace has no keyboard shortcut, so every creation requires clicking the + menu or right-clicking the sidebar.
- New and Open always open a new space, pulling you out of a multi-tab space when you want the workspace as a new tab beside related tabs.
- Typing an existing workspace name in New fails after invoking `jj workspace add`, forcing you to close the dialog and open Open. Typing an unknown name in Open forces you to close Open and retype it in New.
- Once jj workspaces can live in tabs of a shared space, Finish breaks in three ways. It is absent from tab right-click menus, it fails when a space holds linked workspaces from more than one repository, and its confirmation only names other spaces, omitting individual terminals in the same space, multiple terminals in other spaces, and parent-owned child terminals that will also end.
- Menu labels say "New workspace", "Open workspace", and "Finish workspace", colliding with Herdr's own space and workspace vocabulary.

## Goals

- Enable full keyboard creation from any entry point. Pressing the configured key binding, typing a name, optionally moving Up or Down to choose a repository, and pressing Enter (or Shift+Enter for a new tab) creates and opens the jj workspace without using the mouse.
- Keep New focused on repositories. In New, Up and Down move through repositories only, never through existing jj workspaces, even when a repository has many workspaces.
- Unify New and Open while preserving input and repository selection. Pressing Tab or Shift+Tab (or clicking New or Open in the header) switches views while keeping the typed text and the chosen repository, even when the filter hides all rows of that repository in Open.
- Open existing names directly from New. When the typed name matches an existing jj workspace in the chosen repository, the detail line states that it already exists and Enter (or Shift+Enter) opens that workspace without running `jj workspace add`.
- Support both space/tab jumping and new-tab placement. Enter selects an existing terminal pane working in that checkout (preferring a dedicated space, else switching to the matching space and tab) or opens a new nested space. Shift+Enter always opens a new tab in the target space whenever the chosen repository lives on the target space's machine.
- Limit startup subprocesses to the target space and expand lazily. Opening the dialog probes only the target space's folders. A trailing row probes repositories in other spaces on demand and stays expanded across Tab switches during that dialog session.
- Make Finish work across tabs and multiple repositories while upholding `AGENTS.md` safety rules. Finish appears in both tab right-click menus and space right-click menus, lists linked workspaces across all repositories in scope, pre-checks all linked workspaces in the clicked or active tab (and none when the active tab has no linked workspace), names every individual terminal and parent-owned child that will end before confirmation, and refuses silent broadening of the kill set or deletion of nested checkouts.
- Standardize labels on jj workspace across menus, dialogs, and notifications.
- Preserve existing creation, linking, trust, and removal mechanics (path templating, matching-bookmark start revision, `links` symlinking, `mise trust`, bounded `jj status` lock checks, terminal-kill waiting, and sequential `jj workspace remove`).

## Non-Goals

- Merging Finish into the New and Open dialog. Finish ends terminals and deletes folders, so it remains a separate window overlay triggered only from space and tab context menus.
- Picking an arbitrary start revision in New. New starts on a local bookmark matching the workspace name when one exists and otherwise starts from the chosen checkout's parent revision (`@-`).
- Filtering the repository list in New. Typing in New always sets the workspace name, and Up and Down select the repository.
- Opening a remote repository's jj workspace as a tab inside a space on a different machine. Herdr's `tab.new` has no `machine` parameter because every tab runs on its space's machine, so Shift+Enter is allowed only when the chosen repository matches the target space's machine.
- Persisting the expanded other-spaces state across dialog openings. Each opening starts scoped to the target space.
- Shipping a default key binding in `keys.json`. Herdr mods cannot ship bindings; the user adds the binding to `keys.json`, documented in `README.md`.
- Adding a toolbar button beside the tab bar + button or hover buttons on sidebar rows.
- Changing how `jj-spaces` nests spaces, how `jj-changes` reads stacks, or how Git-only repositories use Herdr's shipped `worktree` dialog (including its `460x280` New dialog size).

## Operating Assumptions and Failure Boundaries

- Scale. A single space typically holds 1 to 10 tabs touching 1 to 4 repositories. A sidebar may hold 10 to 40 spaces across local and remote machines, which is why other spaces are probed only when the user activates the expand row.
- Single dialog instance. Only one `jj-workspace` overlay is active at a time. No background polling runs while the dialog is open.
- Missing or broken jj binaries. If `identity()` reports an error for a folder (such as `jj` missing on a remote host), the dialog shows that error inline and skips that folder while keeping other discovered repositories usable.
- Unprobed other spaces. Before expansion, the trailing row counts other spaces because probing them upfront defeats lazy discovery. Expanding may find zero additional jj repositories and reports that inline.
- Cross-machine tab placement boundary. When a repository from another space lives on a different machine than the target space, the Shift+Enter hint is omitted and pressing Shift+Enter shows an inline error stating that tabs in this space cannot open a workspace on that remote machine and directing the user to press Enter for a new space.
- Finish when the active tab has no linked workspace. When sidebar Finish opens on a space whose active tab works outside any linked workspace (such as the main checkout or `~`), Finish lists the space's linked workspaces with zero rows checked. Pressing Enter with zero rows checked is a no-op.
- Finish preview-to-kill consistency and residual non-atomic boundary. Finish snapshots the terminal addresses named in the preview, re-evaluates the live affected set immediately before sending kill signals, and fails fast with an inline error if any unnamed terminal appeared (requiring a fresh confirmation). After the final pre-kill check, a new process or terminal could still enter the folder before `jj workspace remove` deletes it; Herdr provides no filesystem transaction across processes.
- Overlapping checkout roots in Finish. Using the fetched workspace lists, Finish refuses to remove a checked workspace whose folder contains another known workspace root, asking the user to finish the inner workspace first. Nested third-party repositories or unrecorded directories inside a checkout remain outside jj's workspace list and are deleted with the folder.
- Creation, lookup, and removal failures. Failures in `jj workspace list`, `jj bookmark list`, `mkdir`, `jj workspace add`, `jj status`, terminal kill wait, or `jj workspace remove` surface the error inline without closing the dialog or retrying automatically. Partial `links` or `mise trust` problems still open the new space or tab and report each path in one warning notification.
- Workspaces created before jj 0.38. Older jj versions did not record each workspace's checkout path, so `jj workspace list` returns an empty `root`. Open displays those entries as unavailable and ignores Enter, Shift+Enter, and clicks on them.

## Open Questions

- Native `Tab` and `Shift+Tab` delivery while `Input` has focus. Confirm in an isolated native Herdr trial whether `gpui-base` `Input` lets `Tab` and `Shift+Tab` reach the dialog's `on_key_down` handler before GPUI focus traversal consumes them (if consumed, `key_context` and `cx.bind_keys` in `gpui-kit.d.ts` provide the supported fallback). Also confirm first-frame `Input` focus before removing the existing 100 ms post-mount focus timer.

## Critical User Journeys (CUJs)

### CUJ 1. Create a jj workspace in a new space by keyboard from a multi-repository space

- Given a space with tab 1 in `randori` (focused) and tab 2 in `streams`, and a `keys.json` binding for `cmd-shift-n` mapped to `mod.open:jj-workspace`,
- When you press `cmd-shift-n`, press Down to highlight `streams`, type `fix-auth`, and press Enter,
- Then the dialog opens in New with `randori` highlighted first and `streams` below it. Moving to `streams` updates the destination line to `streams`'s configured checkout path. Pressing Enter creates the `fix-auth` jj workspace from `streams`'s checkout, applies configured links and `mise trust`, closes the dialog, and opens a new nested space on the checkout.

### CUJ 2. Create or open a jj workspace as a new tab in the target space

- Given a local space holding tab 1 in `randori` (focused) and tab 2 in `streams`, both local repositories,
- When you open the jj workspace dialog, highlight `streams`, type `fix-auth`, and press Shift+Enter,
- Then the dialog creates the `fix-auth` jj workspace in `streams`, applies configured links and `mise trust`, closes the dialog, and opens a new tab named `fix-auth` in the target space on that checkout. In Open, Shift+Enter similarly opens a new tab in the target space on an existing same-machine checkout (naming a main-checkout tab after the repository name).

### CUJ 3. Type an existing workspace name in New

- Given a space in `randori`, which already has a jj workspace named `nesting` open in tab 2 of `randori`,
- When you open the dialog in New and type `nesting`,
- Then the detail line states that `nesting` already exists in `randori` and that Enter opens it (and Shift+Enter opens a new tab). Pressing Enter closes the dialog and switches directly to `randori` tab 2 without creating a duplicate workspace or space. Pressing Shift+Enter opens another new tab in the target space on `nesting`.

### CUJ 4. Switch from Open to New without losing typed text or chosen repository

- Given a space with `randori` (tab 1) and `streams` (tab 2), where `randori` has a workspace named `bench-fix` and `streams` does not,
- When you open the dialog in New, highlight `streams`, type `bench-fix`, press Tab to peek at Open (which shows only `randori`'s `bench-fix`), press Tab back to New, and press Enter,
- Then `streams` remains the chosen repository with `bench-fix` preserved in the input, and Enter creates `bench-fix` in `streams`.

### CUJ 5. Open or create a jj workspace in a repository from another space

- Given local space A in `randori` (focused) and remote space B in `streams` on machine `retriever`,
- When you open the jj workspace dialog from space A, press Down to reach the trailing row for other spaces, press Enter, highlight `streams` (labeled `retriever`), type `remote-test`, and press Enter,
- Then expanding probes space B on demand, appends `streams` under an Other spaces divider with its machine label, hides the Shift+Enter tab hint because `retriever` differs from space A's machine, and Enter creates the workspace on `retriever` and opens a new space there.

### CUJ 6. Finish jj workspaces from a tab right-click menu

- Given a space with tab 1 in `randori` main checkout, tab 2 split across linked workspace `nesting` (two panes) and linked workspace `topic` (one pane), and tab 3 also in `nesting`,
- When you right-click tab 2 and choose Finish jj workspace,
- Then the Finish window lists only tab 2's linked workspaces (`nesting` and `topic`), with both checked, and names every individual terminal in each checked checkout (including both panes in tab 2, the terminal in tab 3, any other spaces, parked terminals, and any parent-owned child terminals). Unchecking `topic` and pressing Enter snapshots `nesting`, ends every confirmed terminal in `nesting`, closes their panes while keeping tab 1 and the space open, and removes `nesting`.

### CUJ 7. Finish from a sidebar space right-click in a multi-repository space

- Given a space whose active tab works in linked workspace `fix-auth` of `streams` and whose second tab works in linked workspace `nesting` of `randori`,
- When you right-click that space in the sidebar and choose Finish jj workspace,
- Then the Finish window lists both `streams / fix-auth` and `randori / nesting`, with only `streams / fix-auth` (the active tab's linked workspace) checked and `randori / nesting` unchecked, naming every terminal that will end under each checked row. Pressing Enter removes only the checked workspaces, running removal in each checked workspace's own main checkout.

## Technical Plan (Architecture)

All changes stay inside existing Randori mods (`mods/jj-workspace`, `mods/jj-menu`, `mods/jj-new-menu`), the test suite (`tests/mod-harness.js`, `tests/mods.test.js`), the isolated trial script (`scripts/app-trial.js`), and repository documentation (`README.md`, `design/jj-workspace-lifecycle.md`). No new mod, background daemon, or modification to the shared `jj.js` identity block is introduced.

```text
Entry points
  keys.json (mod.open:jj-workspace) ──> props: { overlay }
  jj-new-menu (+ button)            ──> props: { space, folder, action: "new"|"open" }
  jj-menu (space right-click)       ──> props: { space, folder, action: "new"|"open"|"finish" }
  jj-menu (tab right-click)         ──> props: { space, tab, action: "finish" }
                                              │
                                              ▼
                                    mods/jj-workspace/main.js
                                     ┌────────┴────────┐
                                     ▼                 ▼
                      Unified New / Open dialog   Finish jj workspace window
                      (kind: "dialog", 560x480)   (kind: "window", 520x360)
                       │                            │
                       ├─ probe target space only   ├─ probe clicked tab or whole space
                       ├─ lazy expand other spaces  ├─ group linked checkouts by repo
                       ├─ Tab switches New <-> Open ├─ pre-check target tab's roots
                       ├─ Enter -> jump or space    ├─ name every terminal + children
                       └─ Shift+Enter -> new tab    └─ check -> verify -> kill -> remove
```

### Overlay declaration and props contract

`mods/jj-workspace/mod.json` declares a `560x480` `dialog` overlay block so Herdr's native `mod.open:jj-workspace` command toggles the dialog directly from `keys.json` without `nextCommand()`. `jj-menu` and `jj-new-menu` open both New and Open at `560x480` so view switching keeps constant geometry, while preserving `460x280` for Herdr's shipped Git `worktree` New dialog. Finish remains a `520x360` `window` overlay.

Herdr injects `overlay` into `props()` for closing the overlay via `closeOverlay(props()?.overlay)`. Callers may also pass optional `space`, `folder`, `action` (`"new"`, `"open"`, or `"finish"`), `tab` (tab ID for Finish, or initial tab name forwarded to `space.new`), and `argv` (command arguments forwarded to `space.new` or `tab.new`). When opened with no `space` or `folder` prop (as from `mod.open:jj-workspace`), the dialog resolves the target space from the focused space (falling back to the active space), defaults to New, and uses the focused pane's folder within that space (falling back to the space's first terminal or folder). When opened from a sidebar space right-click, the dialog binds to that clicked target space and its machine, showing the target space name in the dialog whenever it differs from the active space.

### Repository discovery and lazy expansion

For a space, discovery collects unique terminal pane folders in tab order followed by the space's own folder when present, then probes each folder in parallel via `identity()`.

- Repositories are deduplicated by machine and main checkout path while preserving tab order natively (no reordering or post-sort helper). When the initial focus folder matches a discovered repository, that checkout becomes the repository's branch-from checkout and the initially chosen repository.
- For each newly discovered repository, the dialog fetches its machine's home folder (cached per machine), workspace list, and local bookmarks concurrently so switching between New and Open requires no second `jj` round-trip and New detects existing workspace names immediately.
- Folders where `identity()` returns an error surface the error in the dialog banner while keeping valid repositories usable.
- Spaces other than the target space are never probed on open. When other spaces exist and have not been expanded, a trailing selectable row displays the count of other spaces. Activating it deduplicates `(folder, machine)` pairs across other spaces (excluding already-probed target-space pairs) and updates the dialog as each folder or repository settles, so a slow remote host does not block reachable local repositories from appearing while still showing per-folder errors. Newly discovered repositories appear below an Other spaces divider labeled with their remote machine name when remote, and stay expanded across Tab switches during that dialog session.

### Unified New and Open state and interactions

The dialog mounts one `Input` unconditionally from the first frame with a fixed placeholder so keystrokes buffer while discovery runs, gating action execution until the highlighted repository finishes loading and keeping the post-mount focus timer until native verification confirms first-frame focus. The list container attaches a `ScrollHandle` so keyboard navigation and lazy expansion scroll the highlighted row into view.

Selection separates the authoritative chosen repository key from the active view's integer highlight index.

- Changing the filter text in Open resets the list highlight to 0 without changing the chosen repository key.
- Explicit Up, Down, or click onto a repository or workspace row updates both the highlight index and the chosen repository key.
- Switching views via Tab, Shift+Tab, or clicking the New and Open header buttons preserves the input text and maps selection from the authoritative repository key (highlighting that repository in New, or its first visible workspace in Open; switching from the expand row returns to the chosen repository in New, or the first repository when none is chosen).

In New, the list contains repositories only (omitted when only one repository exists, no other spaces exist, and the dialog is not expanded). Typing sets the workspace name. When the typed name matches an existing workspace in the chosen repository, the detail line states that it already exists and Enter or Shift+Enter routes to opening that workspace without running `jj workspace add`.

In Open, workspaces are grouped under repository headers (main checkout first, then alphabetical) and filtered across all listed repositories by name or path. Each workspace row checks all terminal panes across all spaces on that machine (deepest checkout wins), preferring a dedicated space whose first terminal is in that checkout (`open`), else the first matching tab in another space (`open in <space>`).

Placement rules on Enter vs Shift+Enter follow four cases.

- On the trailing expand row, Enter triggers lazy expansion.
- On a workspace (in Open, or an existing name in New), Enter jumps to the matched dedicated space via `space.select`, or jumps to the matched space and tab via `space.select` and `tab.select`, or creates a new nested space via `space.new` when not open anywhere.
- On a new name in New, Enter creates the workspace, links configured files, runs `mise trust`, and opens a new nested space via `space.new`.
- Shift+Enter checks whether the chosen repository lives on the target space's machine. When it matches, Shift+Enter always opens a new tab in the target space via `tab.new` (naming a main-checkout tab after the repository name and any linked checkout tab after its workspace name). When the repository lives on a different machine, Shift+Enter leaves the dialog open and shows an inline error.

### Multi-repository and tab-scoped Finish jj workspace

Finish runs in its separate window overlay.

- Scope and discovery. When opened from a tab right-click (with `tab` in props), Finish inspects terminal panes in that tab only. When opened from a space right-click (no `tab` prop), Finish inspects terminal panes across every tab of that space. Unique linked workspaces across all repositories are collected, each carrying its own main checkout and repository name, and `jj workspace list` runs once per distinct repository in parallel to resolve workspace names.
- Pre-checking rule. For tab right-click, every linked workspace present in the clicked tab starts checked. For space right-click, every linked workspace present in the space's active tab starts checked and all other rows start unchecked (zero rows checked if the active tab has no linked workspace).
- Affected terminals and confirmation. One helper derives the affected terminals for any checked checkout root from live `terminals()`, collecting direct terminals whose `cwd` lies inside the root plus transitive child terminals owned via `parent` in Herdr Core. Each terminal is labeled with its name or address and its context (same-space tab name using `TabInfo` metadata, other space name, parked, or child of its parent). Under every checked row, Finish lists every affected terminal individually.
- Execution and safety gates. Pressing Enter with zero checked rows is a no-op. Otherwise Finish captures the previewed terminal address set and runs three sequential steps across checked, unremoved rows.
  1. Check. Fetch `jj workspace list` once per distinct repository in the checked set, verify each workspace still maps to its recorded folder, refuse any checked root that contains another known workspace root from those lists, and run `jj status` (10 s timeout) in each checked root.
  2. Verify and end terminals. Re-evaluate the live affected-terminal set immediately before killing; if any terminal address not in the confirmed preview set appeared, fail fast with an inline error so the user sees the new terminal and confirms again. Otherwise send `terminal.kill` to the direct terminals and wait up to 10 s for them to leave `terminals()` (Herdr Core ends non-outliving children without blocking on `--outlive-parent` children). Close the target space with `space.close { id, confirmed: true }` only when no panes of any kind remain outside the ended terminals; close every remaining pane showing an ended terminal via `pane.close` (Herdr closes tabs and spaces whose last pane closes).
  3. Remove. Run `jj workspace remove <name>` sequentially from each checked row's own main checkout (600 s timeout), marking each row removed on completion.

### Menu updates in `jj-menu` and `jj-new-menu`

- `jj-menu` space right-click probes all unique folders of the space in parallel via `identity()`. If any folder is in a jj repository, the menu offers `New jj workspace` and `Open jj workspace` (passing `space` and the first jj folder, preferring the space's first terminal when jj, opening at `560x480`). If any terminal pane folder is in a linked jj workspace, it also offers `Finish jj workspace` (opening at `520x360` as a window). Git fallback runs only when no folder is jj and no jj error occurred.
- `jj-menu` tab right-click looks up the clicked tab's space (for its machine) and probes the clicked tab's unique terminal pane folders via `identity()`. When any pane works in a linked jj workspace, it inserts `Finish jj workspace` before `Close` (passing `space`, `tab`, and `action: "finish"`).
- `jj-new-menu` probes the focused pane's folder and any remaining unique folders of the active space (continuing even if the focused pane has no `cwd` or hits an `identity()` error, while suppressing Git fallback for errored folders). When any folder is jj, the menu displays `New jj workspace…` (with the user's `mod.open:jj-workspace` shortcut hint if bound) and `Open jj workspace…`, passing `space` and `folder` and opening at `560x480`. Otherwise it preserves Herdr's shipped `worktree` rows and `460x280` / `560x480` dialog sizes.

### Non-Functional Requirements

- Startup subprocess scope. Opening the dialog runs `identity()` only on unique folders in the target space, followed by parallel `workspace list` and `bookmark list` reads per unique repository. Other spaces incur zero subprocesses until explicitly expanded.
- Idle cost. No timers or background polling run while the dialog is open (aside from the single post-mount focus timer pending native verification).

### Risks and Limits

- Retained destructive and trust boundaries from [jj workspace lifecycle in Herdr](./jj-workspace-lifecycle.md). Finish deletes every file jj does not track, including ignored files such as `.local/` notes; configured `links` point directly into the main checkout so edits through a link modify the main checkout's copy; `mise trust` permits tool execution for linked mise files.
- Non-atomic Finish window. Pre-kill re-verification prevents silent expansion of the kill set during `jj status`, but a new terminal or process can still enter the directory between the final check and `jj workspace remove`.
- Nested non-workspace paths. Overlapping-root refusal protects known jj workspaces listed by `jj workspace list`; unrecorded directories or nested repositories placed inside a checkout are deleted with the folder.
- Native input routing. Fake Node tests cannot prove GPUI focus traversal for `Tab` / `Shift+Tab` or native first-frame focus inside `Input`; both require an isolated native trial check.

## Alternatives Considered

### A single merged list mixing workspaces and "+ New" rows

- Pros. One flat view with no Tab switch and a single menu entry (`jj workspace…`).
- Cons. When creating a new jj workspace, Up and Down must step past every existing workspace of every listed repository before reaching the next repository. Enter performs two different actions (create or open) depending on the highlighted row, increasing the chance of misclicks.
- Reason for rejection. When opening from New, Up and Down should scroll across base repositories only without stepping through existing jj workspaces. Two views (New and Open) switched with Tab keep both workflows direct while sharing one dialog and input.

### Keeping New and Open as two separate dialogs

- Pros. Smaller change to `mods/jj-workspace/main.js` and no view-switching state.
- Cons. Typing an existing name in New or a missing name in Open requires closing the dialog, opening the other one, and retyping the name.
- Reason for rejection. One dialog with New and Open views preserves typed text and the chosen repository across Tab and lets New open an existing match directly.

### Probing all open spaces upfront by default

- Pros. Every open jj repository across all spaces is immediately listed without an expand step, and the dialog can display an exact count of repositories in other spaces.
- Cons. A sidebar with dozens of spaces, including remote SSH machines, would spawn `jj` identity, workspace list, and bookmark list processes across every space on every dialog open, increasing startup work and remote traffic even when working inside the target space.
- Reason for rejection. Scoping to the target space by default with a lazy trailing expand row limits startup subprocesses while preserving keyboard-only access to other spaces.

### Adding a toolbar button beside + or hover buttons on sidebar rows

- Pros. One-click access to New jj workspace without opening a menu.
- Cons. Adds extra controls to `jj-tabs` or `jj-spaces` that duplicate entries already available in the + menu and space right-click menu.
- Reason for rejection. The + menu, space right-click menu, and `cmd-shift-n` key binding provide sufficient entry points without adding extra buttons.

### Always opening a space or always opening a tab

- Pros. One placement path with no modifier shortcut in the hint bar.
- Cons. Always opening a space pulls users out of multi-tab spaces when they want a jj workspace as a new tab beside related tabs. Always opening a tab breaks Herdr's convention of giving each checkout its own nested sidebar space and status line.
- Reason for rejection. Keeping space/existing-terminal selection on Enter preserves Herdr's nesting and status model while Shift+Enter adds same-machine new-tab placement when desired.

### Restricting sidebar Finish to the space's first checkout or single-repository spaces

- Pros. Keeps Finish single-repository and avoids per-row repository metadata and multi-repository `jj workspace list` calls.
- Cons. Breaks or hides sidebar Finish on spaces where Shift+Enter opened linked workspaces from multiple repositories as tabs, or where tab 1 sits outside jj.
- Reason for rejection. Supporting a multi-repository checklist in sidebar Finish with only the active tab's linked workspaces pre-checked stays consistent with multi-repository tab placement while leaving unrelated workspaces unchecked.

### Routing `cmd-shift-n` through `<mod>.<command>` and `nextCommand()`

- Pros. Allows separate command names for opening directly in New or Open.
- Cons. Requires a permanently mounted mod block in the layout to listen on `nextCommand()`, coupling the shortcut to a specific layout even though `jj-workspace` has `place: "none"`.
- Reason for rejection. Declaring `overlay` in `mods/jj-workspace/mod.json` lets Herdr's native `mod.open:jj-workspace` toggle the dialog from `keys.json` with no layout changes, and Tab switches to Open in one keypress.

## Detailed Implementation Plan

### Execution Phases and Checkpoints

- Phase 1 (Unified dialog, multi-repository Finish, and workspace unit tests). Modify `mods/jj-workspace/mod.json`, `mods/jj-workspace/main.js`, `tests/mod-harness.js`, and the `jj-workspace` tests in `tests/mods.test.js`. Checkpoint is `just verify` passing all tests and native `herdr-app check`.
- Phase 2 (Menu integration and menu tests). Modify `mods/jj-menu/main.js`, `mods/jj-new-menu/main.js`, and the menu tests in `tests/mods.test.js`. Checkpoint is `just verify` passing all tests and native `herdr-app check`.
- Phase 3 (Isolated native trial and documentation). Modify `scripts/app-trial.js`, `README.md`, and (once reviewed and implemented) `design/jj-workspace-lifecycle.md`. Checkpoint is `just verify`, the isolated `scripts/app-trial.js` lifecycle sequence, and the isolated manual keyboard and visual check.

### Target Files to Create or Modify

#### 1. `mods/jj-workspace/mod.json` (Modify, Phase 1)

- Type and scope. Herdr mod manifest.
- Proposed changes. Add `"overlay": { "kind": "dialog", "width": 560, "height": 480 }` alongside `place` and `cloned_from`.

#### 2. `mods/jj-workspace/main.js` (Modify, Phase 1)

- Type and scope. Herdr overlay view mod implementing New, Open, and Finish.
- Proposed changes.
  - Imports and local helpers.
    - Import `focused` from `"herdr"` and `ScrollHandle` from `"gpui-base"`.
    - Add local helper `folders(space, paneList)` returning unique pane `cwd` paths in tab order followed by `space.folder` when present.
    - Replace `spaceOf()` with `whereOpen(path, all, on, spaceList, paneList)` searching all terminal panes on `on` with deepest-checkout matching, preferring a space whose `place(s)` is in `path` (`{ space, tab: null, dedicated: true }`), else the first matching `{ space, tab, dedicated: false }`.
    - Add helper `tabLabel(tab, index)` returning `tab.named !== false && tab.name && !/^(tb)?\d+$/.test(tab.name) ? tab.name : \`tab ${tab.index ?? index + 1}\``.
  - Target resolution and discovery.
    - Update `space()` and add `focusFolder(s)` guarding `focused()?.pane`, scoping pane lookup to `s`'s tabs (`tabs.has(p.tab)`), and honoring explicit `props()?.folder` before falling back to the focused pane in `s` or `place(s)`. Capture `this.spaceId`, `this.spaceMachine`, and `this.spaceName`.
    - Add `homeOf(on)` caching per-machine home directories in `this.homes`. For Finish, set `this.on = this.spaceMachine` and `this.userHome = await this.homeOf(this.on)` before `this.prepare()`.
    - Implement `probe(spaceList, other, focusFolder)` probing unique `(folder, machine)` pairs in tab order (excluding already-probed pairs on `expand()`). Deduplicate into `{ key, name, main, checkout, on, other, list, names, error }`. When `!other && folder === focusFolder`, set `r.checkout = id.root`, `this.focusKey = key`, and initialize `this.repoKey = key` (falling back to the first discovered repo's key when `focusFolder` is outside jj). Record `identity()` errors (`id.main === undefined`) on `this.error` without discarding valid repositories; record `workspaces()` / `bookmarks()` failures on `r.error`.
    - In `expand(cx)`, settle and `cx.notify()` per folder/repository as probes finish so slow remote hosts do not stall local repositories. Set `this.ready = true` in `finally` on initial load so subclasses and enter guards never hang on errors.
  - Unified New and Open state, methods, and exact UI contract.
    - State fields are `view` (`"new" | "open"`), `text`, `repos`, `ready`, `expanded`, `expanding`, `repoKey`, `at` (integer index into `picks()`), `scroll = ScrollHandle.new()`, `busy`, and `error`.
    - Mount `Input.new(this.input)` (`placeholder: "jj workspace name or filter"`) unconditionally from frame 1, keeping the 100 ms post-mount `input.focus()` timer pending native trial verification. Wire `InputState`'s `submit` listener to `this.enter(cx, Boolean(e?.shift))`, and `change` to update `this.text`, clear `this.error`, and reset `this.at = 0` in Open without changing `this.repoKey`.
    - `items()` yields display entries with shapes `{ kind: "repo", key, repo, pick: true }`, `{ kind: "header", repo }`, `{ kind: "ws", key, repo, ws, pick: true }`, `{ kind: "divider" }`, `{ kind: "looking" }`, `{ kind: "more", pick: true }`. `picks()` filters `e.pick`; `current()` returns `picks()[this.at]`.
    - `move(delta)` updates `this.at` modulo `picks().length`, updates `this.repoKey = cur.repo.key` whenever `cur.repo` is present, and calls `this.scroll.scroll_to_item(displayIndex)` on the flat `items()` index of `cur`.
    - `switchView(next, cx)` switches `this.view`, keeps `this.text`, maps `this.at` to the row matching `this.repoKey` (in New, that repo's row; in Open, that repo's first visible workspace or `0` without changing `this.repoKey`), scrolls to it, and refocuses `this.input`.
    - Keep trial-compatible signatures `planned(r = this.current()?.repo, name = this.text.trim())` and `work(r = this.current()?.repo, cx, asTab = false)`.
    - `canTab(r)` returns `Boolean(this.spaceId) && (r.on ?? null) === (this.spaceMachine ?? null)`. `create(r, asTab)` and `open(w, r, asTab)` enforce `canTab(r)` when `asTab` is true, showing inline error `Tabs in this space cannot open a workspace on ${r.on}. Press Enter for a new space.` when disallowed, and calling `tab.new { space: this.spaceId, folder, name: w?.main ? r.name : name, ...(p.argv ? { argv: p.argv } : {}) }` when allowed. For `asTab === false`, `open()` uses `whereOpen()` to call `space.select` (plus `tab.select { id: found.tab.id }` when `!found.dedicated`) or `space.new`, and `create()` passes `tab: p.tab, argv: p.argv` to `space.new`. Notification title in `create()` reads `New jj workspace`.
    - Exact element IDs and copy are header title `jj workspace`, view buttons `view-new` (`New`) and `view-open` (`Open`), scroll container `wt-list` with `.track_scroll(this.scroll)`, pickable rows `wt-${n}`, expand row `Repositories in ${n} other space${n === 1 ? "" : "s"}`, zero-repo notice `No jj repositories in this space.` when `others().length > 0` (preserving `${this.folder ? tilde(this.folder, home) : "This folder"} is not in a jj repository.` when `others().length === 0`), New detail line `${tilde(plan.path, home)}, ${plan.bookmark ? \`starts on bookmark ${plan.name}\` : "starts from this checkout's parent"}.` (or `${there.name} already exists in ${r.name}. ↵ opens it${canTab(r) ? " · ⇧↵ new tab" : ""}.`), and target-space note `(tab in ${this.spaceName})` in the footer hint whenever `this.spaceId` is not the active space.
  - Multi-repository and tab-scoped Finish.
    - Store `{ name, root, main, repoName, checked, removed, error }` per row, `this.ready`, `this.multiRepo`, and `this.confirmed` (last previewed affected terminal address set).
    - `prepare()` scans panes in `props().tab` alone when set, or all tabs of `s` when omitted, collecting every unique linked workspace across repositories, running `workspaces()` once per distinct `main`, and pre-checking every row whose `root` appears in `targetTabId` (`props().tab || s.tabs.find(c => c.active)?.id`). Set `this.ready = true` in `finally`.
    - `affectedTerminals(roots)` queries `terminals()` on `this.on`, collects `direct` (`t.cwd && roots.some(root => inside(t.cwd, root))`) and transitive `children` (`t.parent` in `direct ∪ children`), and annotates each entry with its terminal display label (`t.name || t.address`) and context (`tabLabel(tab, i)`, `space ${s.name}`, `parked`, or `child of ${parentLabel}`). Render under every checked, unremoved row as `Ends ${labels.join(", ")}.`.
    - In `finish(cx)`, return early if `!todo.length`; snapshot the confirmed address set from `this.confirmed`; in step 1 assign `at` to the first row of each `r.main` before calling `workspaces()`, verify each row's folder, refuse any checked `r.root` containing another known workspace path from those lists (`${r.name} contains workspace ${inner.name}. Finish ${inner.name} first.`), and run bounded 10 s `jj status`. Immediately before step 2, recompute `affectedTerminals(todoRoots)` and fail fast if any live address was not in the confirmed snapshot (`New terminal ${label} appeared. Review the list and press Enter again.`). In `endTerminals()`, kill and wait up to 10 s on `direct` terminals, close the target space only when `!all.some(p => tabs.has(p.tab) && !(p.terminal && ends.has(p.terminal)))`, and close remaining ended-terminal panes via `pane.close`. In step 3, run `jj workspace remove ${r.name}` from each row's own `r.main`.
    - Finish title reads `Finish jj workspace` (or `Finish jj workspace of ${repoName}` when `!this.multiRepo`), and rows render `${w.repoName} / ${w.name}` when `this.multiRepo` is true.

#### 3. `mods/jj-menu/main.js` (Modify, Phase 2)

- Type and scope. Context menu mod for panes, tabs, and spaces.
- Proposed changes.
  - Add local `folders(space)` helper returning unique pane folders in tab order plus `space.folder`.
  - Rename space menu labels to `New jj workspace`, `Open jj workspace`, and `Finish jj workspace`, passing `{ space: tg.id, folder: this.jj, action }` and opening New/Open at `560x480` (keeping Git `worktree` sizes unchanged).
  - For `tab: "space"`, probe all unique folders of the space in parallel via `identity()`. Set `this.jj` to `place(space)` if jj else the first jj folder found, and set `this.linked` only when a terminal pane folder (`p.terminal && p.cwd`) has `id.linked`. Fall back to Git `checkout(place(space))` only when no folder is jj and no jj error occurred.
  - For `tab: "tab"`, resolve `const space = spaces().find(s => s.id === p.target?.space)` so `space?.machine` is passed to `identity()` for each unique terminal pane folder in `tg.id`. When any pane has `id.linked`, insert `["Finish jj workspace", "jj-workspace", { space: tg.space, tab: tg.id, action: "finish" }]` before `Close`, opening as a `520x360` window.

#### 4. `mods/jj-new-menu/main.js` (Modify, Phase 2)

- Type and scope. Tab bar `+` menu mod.
- Proposed changes.
  - Add local `folders(space)` helper and probe the focused pane's `cwd` (if any) plus all remaining unique folders of the active space via `identity()`, continuing across sibling folders even if the focused pane has no `cwd` or hits an `identity()` error (suppressing Git fallback if the focused folder errored). Keep the focused folder as `this.folder` when it is jj, else the first jj folder found (or the original focused folder when none is jj).
  - Rename rows in jj spaces to `New jj workspace…` (with hint `jj ? shortcut("mod.open:jj-workspace") : ""`) and `Open jj workspace…`, passing `{ space: space?.id, folder: this.folder, action }`, and size the New dialog as `...(jj ? { width: 560, height: 480 } : { width: 460, height: 280 })` so Herdr's shipped Git `worktree` dialog keeps its original size.

#### 5. `tests/mod-harness.js` (Modify, Phase 1)

- Type and scope. Node test harness for Herdr mods.
- Proposed changes. Update fake `InputState.emit(event, next, payload = {})` to pass `payload` to listeners so unit tests exercise `Shift+Enter` (`{ shift: true }`).

#### 6. `tests/mods.test.js` (Modify, Phases 1 and 2)

- Type and scope. Mod unit and behavior tests.
- Proposed changes.
  - Update existing assertions for `jj workspace` labels, `560x480` dialog dimensions, and update `'a folder outside jj says so'` fixture to use a single non-jj space (`spaces: [space('s1', '/g')]`, `panes: [pane('s1', '/g')]`).
  - Discovery and expansion tests (Phase 1). Multi-repository discovery in tab order with focused repository highlighted first; lazy expansion of other spaces (including remote machine `$HOME`, deduplication against target-space folders, and zero-new-repositories notice); `mod.open:jj-workspace` startup with only `{ overlay }` props (including from a non-jj space with other spaces available); `identity()` error inline while sibling repository stays usable.
  - Navigation, view switching, and placement tests (Phase 1). Up/Down repository selection in New and `ScrollHandle.scroll_to_item`; Tab and Shift+Tab round-trip preserving typed text and chosen repository even when Open filters out the chosen repository or lands on the expand row; duplicate workspace name in New routing to `open()` without `jj workspace add`; `whereOpen()` matching dedicated spaces (`space.select`) and secondary tabs (`space.select` + `tab.select`); `Shift+Enter` calling `tab.new` on same-machine repositories (naming main checkout after repo name, targeting clicked inactive space) and showing an inline error on cross-machine repositories.
  - Menu gating tests (Phase 2). `jj-menu` space right-click when tab 1 is outside jj and tab 2 is in a linked jj workspace (and verifying `space.folder` alone does not set `linked`); `jj-menu` tab right-click on local and remote spaces showing `Finish jj workspace` only when the clicked tab has a linked workspace; `jj-new-menu` sibling discovery when focused pane has no `cwd` or hits an `identity()` error, shortcut hint display, and preserved `460x280` Git `worktree` size.
  - Finish safety tests (Phase 1). Tab right-click Finish scoping to the clicked tab with split-pane multiple linked workspaces all checked; sidebar multi-repository Finish pre-checking only the active tab's linked workspaces (and zero when active tab is outside linked checkouts, with Enter as a no-op) and removing each from its own `main`; individual terminal naming across same-space tabs (with live `TabInfo.named === false` and legacy fixture tabs), other spaces, parked terminals, and parent-owned child terminals; preview-to-kill drift refusal when a new terminal arrives before kill; overlapping checkout-root refusal; preserving unrelated mod-only panes/tabs when closing ended-terminal panes.

#### 7. `scripts/app-trial.js` (Modify, Phase 3)

- Type and scope. Isolated native Herdr trial runner.
- Proposed changes.
  - Update `trial-launcher` to open New and Open at `560x480`.
  - Update `trial-new` and `trial-finish` subclasses to wait on `this.ready` (terminating cleanly on error so wait loops never hang) and invoke `this.planned(repo)` / `this.work(repo, cx)` with the current repository.
  - Pass `focus: false` when `finish-setup` opens the secondary `nesting` tab in `ids.review` so `review` remains the active tab of `ids.review` under the active-tab pre-check rule.

#### 8. `README.md` (Modify, Phase 3)

- Type and scope. User-facing documentation for installation, commands, settings, and limits.
- Proposed changes. Update "New and Open workspace" and "Finish workspace" headings and prose to "jj workspace", documenting the unified dialog, Tab view switching, repository selection, lazy other-spaces expansion, Enter vs Shift+Enter placement, the optional `keys.json` snippet (`"cmd-shift-n": "mod.open:jj-workspace"`), tab right-click Finish, multi-repository Finish, individual terminal confirmation, and updated Limits distinguishing fake, trial-subclass, and manual native coverage.

#### 9. `design/jj-workspace-lifecycle.md` (Modify, Phase 3, after implementation approval)

- Type and scope. Existing approved lifecycle design document.
- Proposed changes. Replace the superseded details in "New and Open workspace" and "Finish workspace" with concise summaries linking to `./jj-workspace-dialog.md`.

### Verification Plan

- Automated tests and native mod checks (after every phase). Run `just verify`, which executes `tests/jj.test.js`, `tests/mods.test.js`, `scripts/check-mods.js` (shared `jj.js` drift check and `herdr-app check` on every mod including the new `mod.json` overlay schema), and `node --check`.
- Isolated native lifecycle trial (Phase 3). Run `scripts/app-trial.js` in its disposable `HOME`, `HERDR_APP_HOME`, and `HC_SESSION=trial` (`prepare`, `run`, `resources`, `new`, `open`, `finish-setup`, `finish topic`, `verify-finish topic`, `finish review review`, `verify-finish review`, `quit`, `stop-core`). Because `trial-new` and `trial-finish` invoke mod methods directly, this verifies native Herdr mod loading, real `jj workspace add` and `remove`, symlink and mise execution, space nesting, and Finish terminal termination. Native keyboard routing and visual layout are verified separately in the manual check below.
- Isolated manual native keyboard and visual check (Phase 3). Inside that same isolated trial `HERDR_APP_HOME` and separate core session (with a trial-only `keys.json` binding `"cmd-shift-n": "mod.open:jj-workspace"` and disposable repositories, leaving personal `just install-mods` and user `keys.json` untouched), verify in the trial window that `cmd-shift-n` toggles the `560x480` dialog, first-frame typing works, `Tab` and `Shift+Tab` switch New and Open while `Input` has focus, `Up`/`Down` scrolls `#wt-list`, `Shift+Enter` opens a same-machine workspace as a new tab in the target space, and right-clicking a workspace tab shows `Finish jj workspace` naming every affected terminal before confirmation. Record any untested surface explicitly in `README.md` Limits.

---

Drafted with EGM
