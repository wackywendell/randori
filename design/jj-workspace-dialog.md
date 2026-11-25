# jj workspace dialogs and menus

Author: Wendell Smith
Status: Approved
Date: 2026-11-25

---

## Overview

This design updates how Randori creates, opens, and finishes jj workspaces across multi-repository and multi-tab Herdr spaces. Randori is a set of JavaScript mods for Herdr that adds Jujutsu (jj) workspace management alongside Herdr's shipped Git behavior. See [jj workspace lifecycle in Herdr](./jj-workspace-lifecycle.md) and [README](../README.md) for background on Randori's mods (`jj-spaces`, `jj-changes`, `jj-tabs`, `jj-menu`, `jj-new-menu`, `jj-workspace`, `jj-finish`), workspace path templates, `links` symlinking, and `mise trust`.

This design makes two connected changes.

1. Single filter-first jj workspace dialog. The separate New workspace and Open workspace dialogs become one dialog titled jj workspace (`560x480`) opened from a single `jj workspace…` menu entry or a key binding (`mod.open:jj-workspace`). It opens immediately on the target space's repositories, automatically discovers repositories in other Herdr spaces and on local disk in the background, supports `repo/name` filtering with `/` and `→` completion and inline ghost text, and opens or creates workspaces via Enter (switching to an existing terminal or opening a new nested space) or Shift+Enter (opening a new tab in the target space when on the same machine).
2. Multi-repository and tab-scoped Finish. Finish jj workspace becomes available from both a tab's right-click menu and a space's right-click menu whenever a terminal works in a linked jj workspace. It supports linked workspaces across multiple repositories in one space, pre-checks all linked workspaces in the clicked or active tab, and names every individual terminal (including parent-owned child terminals) in each checked checkout before confirmation.

This document uses these terms.

- A jj workspace is a checkout folder on disk that shares one repository's history with its sibling checkouts. The first checkout is the main checkout (labeled `root` in the dialog), and every other checkout is a linked workspace.
- A repository is the shared jj store identified by its main checkout path and machine. Two tabs working in different linked workspaces of the same repository belong to one repository entry.
- `@` is the working-copy change a checkout is editing, and `@-` is its parent revision in jj history (a commit in the repository graph).
- A Herdr space (referred to below as a space) is a named group of tabs in Herdr's left sidebar. A space can hold tabs working in several repositories or jj workspaces, and every tab inside a space runs on that space's machine (local or one remote machine).
- A Herdr tab holds one or more split panes. A Herdr pane displays either a terminal or a mod view.
- A parked terminal is a live Herdr Core terminal not currently shown in any pane of any space (such as a parked sub-agent or background worker).
- A dialog overlay is a modal centered overlay dismissed by Escape. A window overlay is a draggable non-modal window that stays open even if its originating space closes.
- The target space is the space the dialog operates on. It is the active space when opened from the tab bar + menu or a key binding, and the right-clicked space when opened from the sidebar space menu.
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

- Enable full keyboard creation and switching from one unified filter-first list. Pressing the configured key binding, typing a workspace name or `repo/name`, optionally moving Up or Down, and pressing Enter (or Shift+Enter for a new tab) opens or creates the jj workspace without using the mouse.
- Keep one consistent list without mode switching. Existing workspaces and inline `New workspace` rows appear together under each repository header. Exact workspace name matches hide the duplicate `New` row so Enter opens the existing workspace directly.
- Float matching repositories and support `/` and `→` completion. Typing a repository prefix such as `.dotf` floats `.dotfiles` to the top with `New workspace` first and displays an inline ghost completion (`iles/` for prefix matches, ` → .dotfiles/` for mid-string matches). Typing `/` or pressing `→` at the end of the text completes `.dotfiles/` so typing a new name immediately targets that repository.
- Preserve deterministic order and stable selection. Repositories sort into three sections (source first, current machine first within each), with current space first (focused repository first then tab order), Other spaces next (current machine first then other machines in sidebar order), and Repositories on disk last (current machine first then local ordered by `.jj/repo/op_heads/heads` mtime then alphabetical). Selection uses a kind-prefixed row key (`selectedKey`) so typing, completion, or background discovery never hijack a row you scrolled to.
- Open immediately and discover other spaces and disk repositories in the background. Opening the dialog blocks only on the target space's folders, then probes other Herdr spaces, the worktrees base folder, and configured `repos` folders asynchronously without stealing input focus or pulling default selection out of the current space.
- Support both space/tab jumping and new-tab placement, with configurable default destination (`openIn: "space" | "tab"`). Already-open workspaces always switch on Enter (`↵ switch · ⇧↵ new tab`, preferring a dedicated space, else switching to the matching space and tab). For new and closed workspaces on the target space's machine, `openIn` selects whether Enter opens a new space (`↵ new space · ⇧↵ new tab`, default) or a new tab in the target space (`↵ new tab · ⇧↵ new space`), with Shift+Enter using the opposite destination. Cross-machine repositories fall back cleanly to a new space on Enter (`↵ new space`).
- Make Finish work across tabs and multiple repositories while upholding `AGENTS.md` safety rules. Finish appears in both tab right-click menus and space right-click menus, lists linked workspaces across all repositories in scope, pre-checks all linked workspaces in the clicked or active tab (and none when the active tab has no linked workspace), names every individual terminal and parent-owned child that will end before confirmation, and refuses silent broadening of the kill set or deletion of nested checkouts.
- Standardize labels on jj workspace across menus, dialogs, and notifications, and avoid unnecessary polling timers across mods.
- Preserve existing creation, linking, trust, and removal mechanics (path templating, matching-bookmark start revision, running `jj workspace add` from the repository's main checkout so new workspaces start from its `@-`, `links` symlinking, `mise trust`, bounded `jj status` lock checks, event-driven terminal-kill waiting, and sequential `jj workspace remove`).

## Non-Goals

- Merging Finish into the jj workspace dialog. Finish ends terminals and deletes folders, so it remains a separate window overlay triggered only from space and tab context menus.
- Picking an arbitrary start revision in the dialog. New workspaces start on a local bookmark matching the workspace name when one exists and otherwise start from the repository's main checkout parent revision (`@-`).
- Overriding GPUI's native `Tab` focus traversal inside `Input`. Live testing confirmed GPUI intercepts `Tab` before `on_key_down`, blurring the input; the dialog uses `/` and `→` completion and avoids fragile blur workarounds.
- Opening a remote repository's jj workspace as a tab inside a space on a different machine. Herdr's `tab.new` has no `machine` parameter because every tab runs on its space's machine, so Shift+Enter is allowed only when the chosen repository matches the target space's machine.
- Shipping a default key binding in `keys.json`. Herdr mods cannot ship bindings; the user adds the binding to `keys.json`, documented in `README.md`.
- Adding a toolbar button beside the tab bar + button or hover buttons on sidebar rows.
- Changing how `jj-spaces` nests spaces, how `jj-changes` reads stacks, or how Git-only repositories use Herdr's shipped `worktree` dialog (including its `460x280` New dialog size).

## Operating Assumptions and Failure Boundaries

- Scale. A single space typically holds 1 to 10 tabs touching 1 to 4 repositories. A sidebar may hold 10 to 40 spaces across local and remote machines, and local `repos` patterns may match dozens of repositories. Opening the dialog waits only for the target space's folders, then runs other-space probes and a single POSIX glob scan (`[ -d "$d/.jj" ]`, deduplicating linked worktrees via `.jj/repo` pointers before invoking `jj`) in the background so slow remote hosts never block local use.
- Single dialog instance and low idle timer cost. Only one `jj-workspace` overlay is active at a time. No polling timers run while `jj-workspace` or `jj-finish` is open and idle; during the brief post-kill exit wait in `jj-finish`, both reactive `render(cx)` and a bounded 100 ms poll (cancelled as soon as terminals exit or at 10 s) detect terminal exit reliably in detached `window` overlays.
- Missing or broken jj binaries. If `identity()` reports an error for a folder in the target space (such as `jj` missing on a remote host), the dialog shows that error inline and skips that folder while keeping other discovered repositories usable. Background errors (including `scanDisk` failures) are logged via `log()` without disrupting the dialog banner.
- Cross-machine tab placement boundary. When a repository from another space lives on a different machine than the target space, the Shift+Enter hint is omitted and pressing Shift+Enter shows an inline error stating that tabs in this space cannot open a workspace on that remote machine and directing the user to press Enter for a new space.
- Finish when the active tab has no linked workspace. When sidebar Finish opens on a space whose active tab works outside any linked workspace (such as the main checkout or `~`), Finish lists the space's linked workspaces with zero rows checked. Pressing Enter with zero rows checked is a no-op.
- Finish preview-to-kill consistency and residual non-atomic boundary. Finish snapshots the terminal addresses named in the preview, re-evaluates the live affected set immediately before sending kill signals, and fails fast with an inline error if any unnamed terminal appeared (requiring a fresh confirmation). After the final pre-kill check, a new process or terminal could still enter the folder before `jj workspace remove` deletes it; Herdr provides no filesystem transaction across processes.
- Overlapping checkout roots in Finish. Using the fetched workspace lists, Finish refuses to remove a checked workspace whose folder contains another known workspace root, asking the user to finish the inner workspace first. Nested third-party repositories or unrecorded directories inside a checkout remain outside jj's workspace list and are deleted with the folder.
- Creation, lookup, and removal failures. Failures in `jj workspace list`, `jj bookmark list`, `mkdir`, `jj workspace add`, `jj status`, terminal kill wait, or `jj workspace remove` surface the error inline without closing the dialog or retrying automatically. Missing `links` sources and files already present in the new checkout are silently skipped; actual `ln -s` or enabled `mise trust` failures still open the new space or tab and report each failed path in one warning notification.
- Workspaces created before jj 0.38. Older jj versions did not record each workspace's checkout path, so `jj workspace list` returns `root: null`. When `default` has `root: null` and no other entry claims `repo.main`, the dialog recovers `repo.main` as `default`'s folder (labeled `root`) so switching to it works. Other unrecorded linked workspaces stay unavailable and ignore Enter, Shift+Enter, and clicks.

## Live Findings (Resolved Open Questions)

- GPUI `Tab` focus traversal. Live testing in Herdr confirmed GPUI consumes `Tab` inside `Input` at the window focus-traversal layer before `on_key_down` fires, blurring the input even with `tab_stop(false)` on the outer container. Replacing `Tab`-switched views with a single filter-first list and using `/` and `→` for repository completion eliminated the need to intercept `Tab`.
- GPUI `Input` `submit` and bubbled `Enter`. QuickJS drains microtasks at the end of `Input`'s `submit` callback before GPUI bubbles the `enter` keydown event to `#worktree`'s `on_key_down`, so microtask-cleared dedup flags fail and can open two terminals on one keypress. Making `Input`'s `submit` the sole Enter owner (matching Herdr's shipped `picker`) and guarding `close()` with `this.closed = true` eliminates double-firing completely.
- GNU versus BSD `stat` in `DISK_SCAN`. Running `stat -f %m` first causes GNU `stat` (Linux and Homebrew coreutils) to interpret `-f` as filesystem status and emit a 5-line report to stdout before exiting non-zero. Trying `stat -c %Y` first fails silently on BSD `stat` and falls through to `stat -f %m`; pairing this with a strict 3-field tab parser drops any stray stdout lines.
- `props()` lifetime across `await`. Herdr clears `props()` after an `await` inside `cx.spawn`, so `init()` caches parsed props (`this.cfg = parseProps(props())`) synchronously.
- Detached `window` overlay repaints on terminal exit. Live native trials (`scripts/app-trial.js`) showed that when `jj-finish` runs as a `kind: "window"` overlay and kills a terminal in another space, Herdr does not always repaint the detached Finish window when that terminal leaves `terminals()`. Pairing reactive `render(cx)` wake-up with a bounded 100 ms active-only poll during the kill wait (immediately cancelled on exit or at the 10 s deadline) keeps idle timer cost at zero while waking promptly on exit.
- First-frame focus. Focusing `this.input` once in `init()` works on frame 1; calling `this.handle.focus()` plus a 100 ms focus timer caused a visible focus bounce and was removed.

## Critical User Journeys (CUJs)

### CUJ 1. Create a jj workspace in a new space by keyboard from a multi-repository space

- Given a space with tab 1 in `randori` (focused) and tab 2 in `streams`, and a `keys.json` binding for `cmd-shift-n` mapped to `mod.open:jj-workspace`,
- When you press `cmd-shift-n`, type `streams/fix-auth` (or `str` then `/` then `fix-auth`), and press Enter,
- Then the dialog opens immediately with `randori` first and `streams` below it. Typing `str` floats `streams` to the top with `New workspace` highlighted and inline ghost `eams/`. Typing `/` completes `streams/`, typing `fix-auth` highlights `New "fix-auth"`, and pressing Enter creates `fix-auth` from `streams`'s main checkout, applies configured links and `mise trust`, closes the dialog, and opens a new nested space on the checkout.

### CUJ 2. Create or open a jj workspace as a new tab in the target space

- Given a local space holding tab 1 in `randori` (focused) and tab 2 in `streams`, both local repositories,
- When you open the jj workspace dialog, type `streams/fix-auth`, and press Shift+Enter,
- Then the dialog creates the `fix-auth` jj workspace in `streams`, applies configured links and `mise trust`, closes the dialog, and opens a new tab named `fix-auth` in the target space on that checkout. Shift+Enter on an existing same-machine workspace similarly opens a new tab in the target space (naming a main-checkout tab after the repository name).

### CUJ 3. Type an existing workspace name

- Given a space in `randori`, which already has a jj workspace named `nesting` open in tab 2 of `randori`,
- When you open the dialog and type `nesting`,
- Then `nesting` matches at the top of the list and its duplicate `New "nesting"` row is hidden. Pressing Enter closes the dialog and switches directly to `randori` tab 2 without creating a duplicate workspace or space. Pressing Shift+Enter opens another new tab in the target space on `nesting`.

### CUJ 4. Scroll to another workspace and keep editing without selection jumping

- Given `.dotfiles` open in another space with `default` and another workspace,
- When you type `.dotf`, press Down onto `default`, type `i` (`.dotfi`), press `→` (completing `.dotfiles/`), or type `x` (temporarily hiding `default`) and press Backspace,
- Then `default` remains pinned across typing `i` and completing `.dotfiles/`, falls back to row 0 while hidden by `x`, and returns to `default` when Backspace brings it back.

### CUJ 5. Open or create a jj workspace in a repository from another space or on disk

- Given local space A in `randori` (focused), remote space B in `streams` on machine `retriever`, and local repository `dd-source` matched by configured `repos` (`["~/dd/*", "~/code/*", "~/.dotfiles"]`),
- When you open the jj workspace dialog from space A,
- Then `randori` appears immediately with default selection staying inside `randori`, while `streams` loads in the background under Other spaces (in sidebar order, badged `retriever`, with the Shift+Enter hint hidden) and `dd-source` loads under Repositories (sorted by most recent jj operation). Typing `streams/remote-test` and pressing Enter creates the workspace on `retriever` using remote `$HOME` and opens a new space there.

### CUJ 6. Finish jj workspaces from a tab right-click menu

- Given a space with tab 1 in `randori` main checkout, tab 2 split across linked workspace `nesting` (two panes) and linked workspace `topic` (one pane), and tab 3 also in `nesting`,
- When you right-click tab 2 and choose Finish jj workspace,
- Then the Finish window lists only tab 2's linked workspaces (`nesting` and `topic`), with both checked, and names every individual terminal in each checked checkout (including both panes in tab 2, the terminal in tab 3, any other spaces, parked terminals, and any parent-owned child terminals). Unchecking `topic` and pressing Enter snapshots `nesting`, ends every confirmed terminal in `nesting`, closes their panes while keeping tab 1 and the space open, and removes `nesting`.

### CUJ 7. Finish from a sidebar space right-click in a multi-repository space

- Given a space whose active tab works in linked workspace `fix-auth` of `streams` and whose second tab works in linked workspace `nesting` of `randori`,
- When you right-click that space in the sidebar and choose Finish jj workspace,
- Then the Finish window lists both `streams / fix-auth` and `randori / nesting`, with only `streams / fix-auth` (the active tab's linked workspace) checked and `randori / nesting` unchecked, naming every terminal that will end under each checked row. Pressing Enter removes only the checked workspaces, running removal in each checked workspace's own main checkout.

## Technical Plan (Architecture)

All changes live inside Randori's seven mods (`mods/jj-workspace`, `mods/jj-finish`, `mods/jj-menu`, `mods/jj-new-menu`, plus event-driven timer cleanups in `mods/jj-spaces`, `mods/jj-changes`, and `mods/jj-tabs`), the test suite (`tests/mod-harness.js`, `tests/workspace-core.test.js`, `tests/finish-core.test.js`, `tests/mods.test.js`, `tests/jj.test.js`), the isolated trial script (`scripts/app-trial.js`), and repository documentation (`README.md`, `design/jj-workspace-lifecycle.md`). No background daemon or modification to the shared `jj.js` identity block is introduced.

```text
Entry points
  keys.json (mod.open:jj-workspace) ──> jj-workspace  props: { overlay }
  jj-new-menu (+ button)            ──> jj-workspace  props: { space, folder }
  jj-menu (space right-click)       ──> jj-workspace  props: { space, folder }
                                    ──> jj-finish     props: { space, folder }
  jj-menu (tab right-click)         ──> jj-finish     props: { space, tab }

  mods/jj-workspace/                          mods/jj-finish/
   (kind: "dialog", 560x480)                   (kind: "window", 520x360)
   ├─ core.js (pure paths, glob parser,        ├─ core.js (snapshotHerdr,
   │   upsert/sort, query, ghost, placement)   │   planAffected, detectDrift,
   ├─ discovery.js (target + bg discovery)     │   findNestedWorkspace, planCleanup)
   └─ main.js (Workspace picker View)          └─ main.js (4-phase Finish View)
```

### Module structure, overlay declaration, and props contract

Picker and Finish live in two independent mods with zero runtime coupling between them.

- `mods/jj-workspace/` holds the filter-first picker across three focused modules. `core.js` holds pure path, slug, and link validation helpers, `DISK_SCAN` and its strict 3-field parser, `upsertRepo` promotion, `sortRepos`, `parseQuery`, `shouldAutoCompleteSlash`, `buildItems`, selection resolution, ghost computation, and tagged `placement()`. `discovery.js` holds `RepoDiscovery` for target-space and background discovery (cancellation-aware after every `await`), plus `workspaces()` and `bookmarks()`. `main.js` holds the `Workspace` view.
- `mods/jj-finish/` holds the destructive Finish window across two focused modules. `core.js` holds `snapshotHerdr`, `planAffected`, `detectDrift`, `findNestedWorkspace`, `planCleanup`, and `collectScopeFolders`. `main.js` holds a 4-phase state machine (`loading`, `error`, `confirm`, `running`) with strictly read-only `render()` and explicit confirmation snapshots.

`mods/jj-workspace/mod.json` declares a `560x480` `dialog` overlay block so Herdr's native `mod.open:jj-workspace` command toggles the dialog directly from `keys.json` without `nextCommand()`. `mods/jj-finish/mod.json` declares a `520x360` `window` overlay block. `jj-menu` and `jj-new-menu` each expose one `jj workspace…` row opening `jj-workspace` at `560x480`, while preserving `460x280` for Herdr's shipped Git `worktree` New dialog. `jj-menu` opens `jj-finish` at `520x360` as a window.

Herdr injects `overlay` into `props()` for closing the overlay via `closeOverlay(this.cfg.overlay)` (parsed once in `init()`). Callers pass optional `space`, `folder`, and `argv` to `jj-workspace`, and `space`, optional `tab`, and optional `folder` to `jj-finish`. When `jj-workspace` opens with no `space` or `folder` prop (as from `mod.open:jj-workspace`), it resolves the target space from `focused().space` (falling back to the active space) and uses the focused pane's folder within that space (falling back to the active tab or the space's first terminal or folder). When opened from a sidebar space right-click, it binds to that clicked target space and its machine, showing `new tab in <space>` in the footer whenever it differs from the active space. Both views ignore `Escape` while an action or removal is running so overlays cannot strand background mutations.

### Repository discovery, background loading, and deterministic ordering

Opening the dialog probes only unique terminal pane folders (plus `space.folder`) in the target space first, then launches background discovery with `Promise.allSettled`.

- Other Herdr spaces (`source: "other"`). Probes each unique `(folder, machine)` pair across non-target spaces, updating as each settles so slow remote machines never stall local repositories.
- Disk repositories (`source: "disk"`). Runs a single POSIX glob scan (`DISK_SCAN`) on the target space's machine (and also on local when the target space is remote) across the static base of `settings().directory` (depth 1 and 2) and configured `settings().repos` patterns (strictly matching exact repository paths or `*` globs such as `~/code/*`, `~/src/*/*`, and `~/.dotfiles` without descending into matched repositories), emitting each repository's `.jj/repo/op_heads/heads` mtime and optional linked `.jj/repo` pointer so both local and remote scans deduplicate worktrees in one shell call before invoking `jj`.
- Canonical ordering (`sortRepos()`). Regardless of async completion order, repositories always sort into three sections (source first, current machine first within each section).
  1. Current space (`source: "space"`). Focused repository first, then tab order.
  2. Other spaces (`source: "other"`). Current machine first, then other machines, in sidebar order within each.
  3. Repositories (`source: "disk"`). Current machine first, then local (when on a remote machine), by most recent jj `op_heads/heads` mtime descending and case-insensitive alphabetical tie-breaking within each.
- For each discovered repository, the dialog caches its machine's home folder and loads `workspaces()` (recovering `repo.main` when pre-0.38 `default` has `root: null`) and local `bookmarks()` concurrently. Repository headers display remote host badges (plus a `local` badge on local repositories when opened from a remote space).

### Filter-first list, selection invariant, and completion

The dialog mounts one `Input` (`placeholder: "Name or repo/name"`) focused once in `init()`, wrapped in a bordered search box (`search.svg`) with an inline ghost mirror layer (`#00000000` typed prefix + dim suffix) behind `Input`.

Selection follows one invariant driven by a single field `selectedKey` (`null` until the user explicitly moves with `↑`/`↓` or clicks).

- `resolve(picks)`. If `selectedKey` is set and currently visible in `picks`, select it; otherwise fall back to row `0` (when filtering) or `initialIndex(picks)` (when input is empty), leaving `selectedKey` intact so backspacing brings a temporarily hidden pinned row straight back.
- `initialIndex(picks)`. Stays inside the current space (first other available workspace in `focusKey`, else `focusKey`'s `New workspace`, else another workspace or `New workspace` in `source: "space"`), falling back to other spaces or disk repositories only when the current space has no jj repository. Background loading never pulls the default highlight out of the current space.

Query parsing (`parseQuery()`) and ranking (`items()`) operate in three modes.

- Empty input. Lists current-space repositories followed by `Other spaces`, with workspaces followed by `New workspace` under each repository header. Disk-only repositories stay folded behind a `Type to search N other repositories` hint while open-space repositories exist (and appear directly when no open-space repository exists so a non-jj space is never blank).
- Scoped input (`repo/name`, when the prefix before the first `/` matches one or more loaded repositories). Restricts the list to matching repositories and uses the text after `/` as the workspace filter and creation name, putting `New workspace` first when the text after `/` is empty so rows stay stable across completion. Slashes whose prefix matches no repository (such as `feat/auth`) remain literal workspace names.
- Unscoped search input. Floats repositories matching by repository name or workspace name above non-matching repositories (`Create elsewhere`). When a query matches a repository name and zero workspace names in that repository, `New workspace` sits first under that repository header. Exact workspace matches hide the duplicate `New` row.

Ghost completion and `/` / `→` follow the highlighted row (`this.current()`).

- `ghost()` shows only when the highlighted row's repository matches the typed query (with no `/` yet). Prefix matches show the remainder plus `/` (`.dotf` shows `iles/`), and mid-string matches show ` → <repo>/`. Scrolling to a non-matching repository hides the ghost.
- Typing `/` or pressing `→` at the rightmost cursor edge completes `<repo>/` via `completeRepo()` without altering `selectedKey`.
- Pressing Enter on an empty `New workspace` row also fills `<repo>/`; pressing Enter on an already-scoped empty `<repo>/` is a no-op.

Visual presentation uses colored repository initial avatars from `shared("space.colors")`, remote host pills (`server.svg`), hairline section dividers, `branch.svg` (accent-tinted when open) and bordered `+` row icons, a left accent selection bar, subtle bordered `root` and `unavailable` pills, a `bookmark` pill when a new name matches a local bookmark, and footer keycaps (`↵`, `⇧↵`).

Placement rules on Enter vs Shift+Enter follow three cases (with the footer explicitly naming each destination).

- On an already-open workspace row, Enter switches to the matched dedicated space via `space.select` or to the matched space and tab via `space.select` and `tab.select` (`↵ switch`), and Shift+Enter opens a new tab in the target space via `tab.new` when `canTab(r)` is true (`⇧↵ new tab`).
- On a closed workspace row or a non-empty `New "<name>"` row on the same machine (`canTab(r)`), `openIn` (`"space"` default, or `"tab"`) controls whether Enter opens a new nested space (`space.new`) or a new tab in the target space (`tab.new`, naming a main-checkout tab after `r.name` and a linked checkout tab after its workspace name), and Shift+Enter uses the opposite destination. Creating runs `jj workspace add` from `r.main` (so new workspaces always start from the main checkout's `@-`, or `-r <name>` on a matching local bookmark), links configured files, and runs `mise trust` when `mise` is available.
- On a cross-machine repository (`!canTab(r)`), Enter gracefully opens a new nested space (`↵ new space`) even when `openIn: "tab"` is configured, and pressing Shift+Enter keeps the dialog open with an inline error.

### Multi-repository and tab-scoped Finish jj workspace

Finish runs in its separate `mods/jj-finish/` window overlay as a 4-phase state machine (`loading`, `error`, `confirm`, `running`).

- Scope and discovery. When opened from a tab right-click (with `tab` in props), Finish inspects terminal panes in that tab only. When opened from a space right-click (no `tab` prop), Finish inspects terminal panes across every tab of that space. Unique linked workspaces across all repositories are probed in parallel via `identity()` (recording non-fatal errors without aborting sibling repositories), and `jj workspace list` runs once per distinct repository in parallel to resolve workspace names.
- Pre-checking rule. For tab right-click, every linked workspace present in the clicked tab starts checked. For space right-click, every linked workspace present in the space's active tab starts checked and all other rows start unchecked (zero rows checked if the active tab has no linked workspace).
- Affected terminals and explicit confirmation. `snapshotHerdr(spaces, panes, terminals)` joins live pane folders (`pane.cwd`) with launch folders (`terminal.cwd`) so terminals that `cd` into a checkout are caught alongside terminals launched there, and tracks transitive `parent` ownership in Herdr Core. `planAffected()` derives `{ direct, children, all }` for checked roots and labels each terminal with its name or address and context (same-space tab name using `TabInfo` metadata, other space name, parked, or child of its parent). `render()` is strictly read-only and never mutates the confirmed terminal set; `syncConfirmed()` refreshes `confirmed` only on initial load, checkbox toggle, or drift refusal so reactive updates never silently absorb newly spawned terminals.
- Execution and safety gates. Pressing Enter with zero checked rows is a no-op. Otherwise Finish transitions to `running` (blocking Escape and toggles) and runs three sequential steps across checked, unremoved rows.
  1. Check. Fetch `jj workspace list` once per distinct repository in the checked set, verify each workspace still maps to its recorded folder, refuse any checked root that contains another known workspace root from those lists (or another unchecked row's root across repositories), and run `jj status` (10 s timeout) in each checked root.
  2. Verify and end terminals. Re-evaluate `planAffected()` against a fresh Herdr snapshot immediately before killing; if `detectDrift()` finds any terminal address not in `confirmed`, update `confirmed` to the live set and fail fast with an inline error so the user reviews the new terminal and presses Enter again. Otherwise send `terminal.kill` to `live.direct` and wait (via reactive `render(cx)` plus a bounded 100 ms active-only poll, capped at 10 s) until every terminal in `live.all` (including children) leaves `terminals()`. Use `planCleanup()` to close the target space with `space.close { id, confirmed: true }` only when no panes of any kind remain outside `live.all`, and close every remaining pane showing an ended terminal (including kept child panes) via `pane.close`.
  3. Remove. Run `jj workspace remove <name>` sequentially from each checked row's own main checkout (600 s timeout), marking each row removed on completion.

### Menu updates in `jj-menu` and `jj-new-menu`

- `jj-menu` space right-click probes all unique folders of the space in parallel via `identity()`. If any folder is in a jj repository, the menu offers one `jj workspace…` row (passing `space` and the first jj folder, preferring the space's first terminal when jj, opening at `560x480`). If any terminal pane folder is in a linked jj workspace, it also offers `Finish jj workspace` (opening `jj-finish` at `520x360` as a window). Git fallback runs only when no folder is jj and no jj error occurred.
- `jj-menu` tab right-click looks up the clicked tab's space (for its machine) and probes the clicked tab's unique terminal pane folders via `identity()`. When any pane works in a linked jj workspace, it inserts `Finish jj workspace` before `Close` (opening `jj-finish` with `space` and `tab`).
- `jj-new-menu` probes the focused pane's folder and any remaining unique folders of the active space (continuing even if the focused pane has no `cwd` or hits an `identity()` error, while suppressing Git fallback for errored folders). When any folder is jj, the menu displays one `jj workspace…` row (with the user's `mod.open:jj-workspace` shortcut hint if bound), passing `space` and `folder` and opening at `560x480`. Otherwise it preserves Herdr's shipped `worktree` rows and `460x280` / `560x480` dialog sizes.

### Event-driven updates and idle cost across mods

- `jj-workspace` and `jj-finish`. Zero timers while open and idle; `jj-finish` uses reactive `render(cx)` plus one bounded 100 ms active-only poll and a 10 s deadline timer only during the brief post-kill terminal exit wait.
- `jj-spaces`. Drives `checkNew(cx, true)` reactively from `render(cx)` whenever `spaces()`, `panes()`, `machines()`, or `layout()` change, replacing the shipped 250 ms polling loop with a 30 s fallback timer (`JJ_FALLBACK`) for unwatched/remote repositories and Git fallback (plus a one-shot 250 ms timer only while a newly created space or `space.move` is settling).
- `jj-changes` and `jj-tabs`. Replaces the 1 s visibility polling timer in `jj-changes` with a shared counter (`jj-changes:opened`) bumped by `jj-tabs` whenever the Changes panel transitions from hidden to visible, so re-opening the panel triggers one snapshot immediately with zero polling timers in jj mode.

### Risks and Limits

- Retained destructive and trust boundaries from [jj workspace lifecycle in Herdr](./jj-workspace-lifecycle.md). Finish deletes every file jj does not track, including ignored files such as `.local/` notes; configured `links` point directly into the main checkout so edits through a link modify the main checkout's copy; `mise trust` permits tool execution for linked mise files.
- Non-atomic Finish window. Pre-kill re-verification prevents silent expansion of the kill set during `jj status`, but a new terminal or process can still enter the directory between the final check and `jj workspace remove`.
- Nested non-workspace paths. Overlapping-root refusal protects known jj workspaces listed by `jj workspace list`; unrecorded directories or nested repositories placed inside a checkout are deleted with the folder.
- Inline ghost alignment. The inline ghost suffix relies on a mirror layer behind `Input` matching its font size and inset; verified visually on macOS in Herdr 0.1.15.

## Alternatives Considered

### Two views (New and Open) switched with Tab

- Pros. Keeps New strictly repository-only when scrolling with Up and Down.
- Cons. Live testing showed GPUI's window focus traversal intercepts `Tab` inside `Input` before `on_key_down`, blurring the input. Switching between two modes also adds duplicate menu entries and mental overhead compared to a single filter-first list.
- Reason for rejection. A single filter-first list with `repo/name` syntax, `/` and `→` completion, and `New workspace` placed first on repo-name matches handles both opening and creating from one prompt without touching `Tab`.

### Manual lazy expand row for other spaces

- Pros. Zero background subprocesses until the user explicitly activates the expand row.
- Cons. Requires scrolling past current-space rows and pressing Enter before typing a repository name from another space or local disk.
- Reason for rejection. Opening immediately on the target space and running other-space probes plus a shallow disk scan asynchronously in `Promise.allSettled` keeps initial open fast while letting you type any repository name immediately.

### Keeping New and Open as two separate dialogs

- Pros. Smaller change to `mods/jj-workspace/main.js`.
- Cons. Typing an existing name in New or a missing name in Open requires closing the dialog, opening the other one, and retyping the name.
- Reason for rejection. One filter-first dialog lets you open existing matches and create new names from the same input.

### Adding a toolbar button beside + or hover buttons on sidebar rows

- Pros. One-click access to jj workspace without opening a menu.
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

- Pros. Allows separate command names for different actions.
- Cons. Requires a permanently mounted mod block in the layout to listen on `nextCommand()`, coupling the shortcut to a specific layout even though `jj-workspace` has `place: "none"`.
- Reason for rejection. Declaring `overlay` in `mods/jj-workspace/mod.json` lets Herdr's native `mod.open:jj-workspace` toggle the dialog from `keys.json` with no layout changes.

## Verification Status

- Automated tests and native mod checks. `just verify` passes all 117 tests across `tests/jj.test.js`, `tests/workspace-core.test.js`, `tests/finish-core.test.js`, and `tests/mods.test.js`, native `herdr-app check` on all seven mods, and `node --check`.
- Isolated native lifecycle trial (`scripts/app-trial.js`). Re-verified end-to-end in a disposable `HOME`, `HERDR_APP_HOME`, and core session after splitting `jj-finish` out of `jj-workspace`, covering `jj-workspace` creation, space nesting, two-workspace Finish (`review` removed while `nesting` stayed intact), and held-lock Finish followed by unlock and retry (`locked` removed).
- Live interactive verification (earlier commit). Visual layout, inline ghost alignment, and `cmd-shift-n` keybinding were previously verified in Herdr 0.1.15 on macOS; interactive visual re-check and remote-host end-to-end testing after the `jj-finish` split remain to be exercised in your active Herdr session after `just install-mods`.

---

Drafted with EGM
