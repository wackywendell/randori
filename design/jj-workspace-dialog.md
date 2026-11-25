# Unified jj Workspace Dialog and Finish Design

Status: Implemented  
Scope: `mods/jj-workspace`, `mods/jj-finish`, `mods/jj-menu`, `mods/jj-new-menu`, `mods/jj-spaces/jj.js`  
Owner: Wendell Smith  

## Problem and Goals

Herdr spaces often span multiple jj repositories, remote machines, and disk checkouts outside open spaces. Opening or creating a jj workspace should take one fast dialog with predictable keyboard rules. Finishing a linked workspace should stay a separate, explicit, single-checkout confirmation window that names every terminal it ends before touching disk.

The design enforces five guarantees.

1. Identity is `(machine, path)` everywhere. Every check, open-checkout lookup, terminal preview, kill, and pane cleanup filters by machine and resolves nested checkouts with longest-prefix ownership (`ownerRoot`).
2. Flat Search pairs with an optional Repo Chip in Herdr's native picker style. Repositories appear as non-selectable dim headers above compact workspace rows (`default` with a `main` tag for the main checkout), with no separate repo rows and no counterfeit space avatars. While unscoped, `/` unconditionally locks the highlighted row's repository into a Repo Chip (`/` locks the current repository, `strea/` locks `streams`, and arrowing to another repository before `/` locks that one); clicking a header or activating `+ New workspace in <repo>…` does the same. Once scoped, `/` is a literal character (so `/feat/auth` creates `"feat/auth"`), and pressing `Backspace` on an empty input pops the chip.
3. Handlers act on what was displayed. `render()` computes one immutable view model (`vm`). Every key and click handler acts on `vm`, and background discovery never moves the highlighted row.
4. Finish removes one explicitly selected linked checkout per confirmation. It fails closed if the space or tab vanishes, separates direct in-checkout terminals from spared or outlive-parent children, and never silently absorbs newly spawned terminals on non-drift errors.
5. Idle cost stays low. Disk repositories stay idle (no upfront `jj workspace list` fan-out), bookmarks load only at create time, and neither mod keeps idle timers.

## Shared Identity and Herdr Layer

Because Herdr mods import only from their own folder, shared code uses two parity-checked blocks enforced by `just check-mods` and `tests/jj.test.js`.

- `shared:start`..`shared:end` (canonical in `mods/jj-spaces/jj.js`, copied to all six jj mods) holds `joinPath`, `identity`, `visible`, `machineOf`, `sameMachine`, `base`, `tabOrderedPanes`, `spaceFolders`, `spacePlace`, and `focusFolder`.
- `workspaces:start`..`workspaces:end` (canonical in `mods/jj-workspace/jj.js`, copied only to `mods/jj-finish/jj.js`) holds `addressMachine`, `locKey`, `inside`, `tilde`, `ownerRoot`, and `workspaces(main, on, io, { synthesizeDefault })`. The picker enables `synthesizeDefault` to recover pre-0.38 `default` roots from `main`. Finish disables it so destructive removal requires a real recorded path.

## Workspace Dialog (`mods/jj-workspace`)

### Architecture

- `mods/jj-workspace/core.js` holds the pure settings parser (`parseSettings`), link normalizer (`normalizeLink`), creation planner (`planCreate`, `buildLinkScript`), `DISK_SCAN` shell script and parser, immutable reducer (`emptyModel`, `reduce`, `sortedRepos`), open-checkout indexer (`indexOpenCheckouts`), placement truth table (`destination`, `placementFor`), and view-model projection (`project`).
- `mods/jj-workspace/discovery.js` runs effects (`RepoDiscovery`) to resolve remote `$HOME` for every discovered machine, probe the target space first, load workspaces for other open spaces in the background, scan disk repositories at depth 1 and 2 under `directory` and configured strict `repos` globs (leaving disk repos in `idle` state until opened), and expose create-time `hasLocalBookmark` (failing loudly on jj error).
- `mods/jj-workspace/main.js` is a thin GPUI view with an explicit `phase` (`loading`, `ready`, `creating`, `closed`), immutable `model`, `scopedRepoKey`, `selection` (`auto`, `implicit`, `pinned`), and last projected `vm`. User dismissal calls `dismiss()`; host teardown implements `close()` without calling `closeOverlay`.

### User Flows

- On an empty query, the dialog shows non-selectable dim repository headers (`randori  ~/code/randori`) above compact workspace rows (`default` with a `main` badge, plus linked workspaces) for the current space and `Other spaces` (current machine first, sidebar order). Disk-only repositories fold behind `Type to search N other repositories` whenever any open-space repository exists, and appear with their header and `+ New workspace in <repo>…` row when no open-space repository exists.
- During Flat Search (any non-empty query), repositories whose name matches appear first (lazily loading matching disk repositories), each with its dim header, `+ New workspace in <repo>…` highlighted first, and its workspaces below. Direct workspace name matches across other loaded open-space repositories follow. When the focused repository is loaded and has no exact matching workspace, the list includes `Create "<query>" in <repo>`.
- While unscoped, typing `/` unconditionally locks the currently highlighted row's repository (`vm.current.repo`, falling back to `focusedRepo`) into a Repo Chip (`scopedRepoKey`) and clears the input (so bare `/` scopes the current repository, `strea/` scopes `streams`, and pasting `streams/fix` or `/feat/auth` scopes the repository with the remainder in the input). Clicking a repository header or activating `+ New workspace in <repo>…` does the same, and loads that repository's workspaces if it was `idle`. Once a Repo Chip is active, `/` is a literal character. Pressing `Backspace` when both the previous rendered `vm.query` and the live input are empty, or clicking the chip, returns to Flat Search.
- Typing resolves an `implicit` selection key; `↑`/`↓` or clicking sets a `pinned` key. Background discovery events update `model` without changing `selection`, so late results never steal `Enter`.
- Placement follows the `destination` truth table. When a workspace is already open, `Enter` switches to its space and tab (preferring a dedicated single-checkout space). When new or closed on the target space's machine, `Enter` follows `openIn` (`"space"` default, or `"tab"`), and `Shift+Enter` uses the opposite destination. On a different machine, `Enter` switches or opens a new space, while `Shift+Enter` stays in the dialog with an inline error under both `openIn: "space"` and `openIn: "tab"`.
- Creating a workspace fetches local bookmarks at create time, creates the parent folder, runs `jj workspace add --name=<name> -- <dest>` from `repo.main`, executes one `sh -c` script for configured `links` (skipping absent sources or existing destinations silently) and optional `mise trust`, and opens the space or tab. Pressing `Escape` while `phase === "creating"` stops propagation and keeps the dialog open.

## Finish Window (`mods/jj-finish`)

### Architecture

- `mods/jj-finish/mod.json` declares `"overlay": { "kind": "window", "width": 520, "height": 360 }`. `jj-menu` opens it with `key: "jj-finish"` so at most one Finish window exists at a time.
- `mods/jj-finish/core.js` holds pure machine-scoped `snapshotHerdr`, fail-closed `collectScopeFolders`, single-checkout `planAffected`, `detectDrift`, `findNestedWorkspace`, and `planCleanup`.
- `mods/jj-finish/main.js` implements a five-phase state machine (`loading`, `error`, `confirm`, `running`, `closed`) with strictly read-only `render(cx)`, typed `DriftError`, a single bounded `waitForExit` poll (100 ms active-only, 10 s timeout, zero idle timers), and separate `dismiss()` and host `close()` methods.

### Safety Model

1. `snapshotHerdr` filters `terminals()` by address prefix and `panes()` by space machine strictly to the target space's machine.
2. A missing explicit `spaceId` or `tabId` enters `error` and refuses to target another space or tab. Pre-0.38 jj returning empty roots is refused.
3. A single linked workspace goes straight to confirmation; multiple linked workspaces render a radio list (`↑`/`↓` or click, defaulting to the active tab's checkout) and finish only the selected checkout.
4. `planAffected` puts every live terminal on that machine whose live pane folder or launch folder is owned by the checkout into `direct` (`mustExit`). Finish sends `terminal.kill` to each direct terminal and waits for all of them to exit. Descendant terminals outside the checkout follow Herdr's documented `terminal.kill` branch-sparing rule (stopping at children with a pane or `herdr.space` label) and appear as an advisory note (`dependentChildren`) without blocking removal if Core keeps `--outlive-parent` children alive.
5. `acknowledged` updates only on load, row selection change, or a `DriftError` refusal. Non-drift failures (such as a `jj status` lock timeout) leave `acknowledged` unchanged so newly opened terminals still trigger drift refusal on retry.
6. Finish runs `jj workspace remove -- <name>` from the main checkout, then runs `planCleanup` even when all terminals had already exited. `space.close` requires a non-empty pane list where every pane belonged to the removed checkout.

## Context Menus (`mods/jj-menu`, `mods/jj-new-menu`)

- Both menus share `spaceFolders`, `spacePlace`, `focusFolder`, and `identity` from `./jj.js`, guard async spawns with `checking()` and host `close()`, and agree on `anyError` when probing a space for jj repositories.
- `jj-menu` tracks selection by stable item key (`selectedKey`) so async `jj workspace…` and `Finish jj workspace` rows splicing above `Close` never move the highlight, resolves `mod.open:jj-workspace` shortcut hints, opens `jj-finish` with `key: "jj-finish"`, and passes `{ space }` on space right-click so `jj-workspace` uses `focusFolder`.

## Failure Boundaries and Limits

- An external process can still enter the checkout directory between the final drift check and `jj workspace remove` (irreducible filesystem window without OS directory locks).
- Detached `window` overlays in Herdr do not reliably repaint when background terminals exit `terminals()`, so `jj-finish` uses a bounded 100 ms active-only poll while waiting for killed terminals to exit (cancelled immediately on exit, close, or 10 s timeout).
- `tests/mod-harness.js` simulates Herdr's post-`await` `props() === undefined` clearing with `AsyncLocalStorage`, forbids `cx.notify()`, `focus_handle()`, and `InputState.new()` inside `render()`, runs host `close()` on `closeOverlay`, and models `cx.stop_propagation()` on dialog `Escape`.
