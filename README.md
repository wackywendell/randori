# Randori

Randori is seven JavaScript mods and one layout that give each jj workspace its own space in Herdr. A linked workspace's space sits under its main checkout's space, every jj space shows a status line with its nearest bookmark and its changes in `@`, a space you aren't on ends with `●` when its agents need you or `○` while they work, and a Changes panel shows the stack and opens its diffs in a pane beside your terminal. Herdr runs the mods, and no separate program is needed.

The mods are copies of Herdr 0.1.15's shipped mods with jj added, plus a dedicated Finish window. `jj-spaces` comes from `spaces`, `jj-workspace` from `worktree`, `jj-finish` is the Finish jj workspace window, `jj-menu` comes from `menu`, `jj-new-menu` from `new-menu`, `jj-tabs` from `tabs` and `jj-changes` from `changes`. Folders outside jj keep the shipped Git behavior. The [jj workspace lifecycle design](design/jj-workspace-lifecycle.md) and [jj workspace dialogs and menus design](design/jj-workspace-dialog.md) explain the architecture and UX contracts. [Contributor guidance](AGENTS.md) covers project goals and development rules.

## Install

```sh
just install
herdr-app do layout.switch '{"name":"jj"}'
```

`just install` copies each `mods/jj-*` folder and `layouts/jj.json` into `${HERDR_APP_HOME:-~/.config/herdr-app}`, replacing earlier copies of those project-owned names. `just install-mods` copies only the `mods/jj-*` folders, for custom layouts that mount them directly. Both leave Herdr's shipped mods and layouts unchanged. Switch back with `herdr-app do layout.switch '{"name":"main"}'`.

The layout mounts Herdr's own `agents` list, the Files panel and the `jj-changes` panel. Key bindings for the agents list are the shipped `agents` mod's.

## Settings

Settings are props on blocks of the installed `layouts/jj.json`. New workspace reads the `jj-spaces` block's props each time it runs, and the Changes panel reads the `jj-changes` block's props each time it reads the stack.

| Prop        | Default                            | Meaning                                                                                                                 |
| ----------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `directory` | `~/.herdr/worktrees/{repo}/{name}` | Where `jj workspace` puts a new checkout. `{repo}` is the main checkout's folder name and `{name}` the workspace name, made safe for a folder. The static prefix before `{repo}` is also scanned for local repositories. |
| `repos`     | `[]`                               | Optional list of local repository paths or glob patterns (for example `["~/dd/*", "~/code/*", "~/.dotfiles"]`) scanned in the `jj workspace` dialog. Strict: plain paths match only that repository; use `/*` (or `/*/*`) to scan child directories. |
| `openIn`    | `"space"`                          | Default destination on `Enter` for new and closed workspaces (`"space"` or `"tab"`). `Shift+Enter` uses the other destination; already-open workspaces still switch on `Enter`, and cross-machine workspaces fall back to a new space. |
| `links`     | `[]`                               | Paths, relative to the main checkout, that `jj workspace` links into a new checkout with `ln -s`.                      |
| `miseTrust` | `true`                             | Run `mise trust` on each linked mise configuration file, when `mise --version` succeeds.                               |
| `idLength`  | `6`                                | On the `jj-changes` block, the fewest characters the Changes panel shows of a change ID.                               |
| `rows`      | `"full"`                           | On the `jj-changes` block, `"full"` puts each change's description on a second line under its ID, bookmarks and counts. `"compact"` keeps each change on one line. |

In custom layouts using `jj-tabs`, the tab bar discovers panel toggle buttons from the `panel-body` stack's non-hidden child blocks. The built-in `files` and `changes` panels follow `workspace.panels`, while any additional block is shown in stack order using `content.props.label` (defaulting to its capitalized `id`) and optional `content.props.icon` (an `.svg` path or a symbol string). The open panel stays open as you switch spaces and tabs, as in Herdr. Tab right-clicks open the `jj-tabs` block's `props.menu`, `terminal_menu` at the layout root, or `"jj-menu"`, and the `+` button opens `props.newMenu` or `"jj-new-menu"`.

## jj workspace

Right-click a jj space or open the tab bar's `+` menu from a space with any jj checkout, and choose `jj workspace…`. You can also bind a key in `~/.config/herdr-app/keys.json` to open the dialog directly:

```json
{
  "global": {
    "cmd-shift-n": "mod.open:jj-workspace"
  }
}
```

The `jj workspace` dialog (`560x480`) uses Flat Search with an optional Repo Chip in Herdr's native picker style:

- On open, the dialog loads the target space's repositories first (focused repository first, then tab order). In the background, it discovers repositories in other Herdr spaces (loading their workspaces so cross-repo workspace search works immediately, ordered current machine first then other machines in sidebar order) and disk repositories under the `directory` base (depth 1 and 2) and configured `repos` patterns (ordered current machine first, newest jj operation first). Disk repositories stay idle (no upfront `jj workspace list` calls) and fold behind a `Type to search N other repositories` hint on an empty query whenever open-space repositories exist.
- Repositories appear as non-selectable dim headers (`randori  ~/code/randori`) above compact workspace rows (`default` with a `main` badge for the main checkout, plus each linked workspace). Typing filters both repository names and workspace names across open spaces (lazily loading matching disk repositories). Matching repositories appear first with `+ New workspace in <repo>…` selected above their workspaces.
- When no Repo Chip is active, typing `/` unconditionally locks the highlighted row's repository into a Repo Chip (`streams ×`) and clears the input (so bare `/` locks the current repository, `strea/` locks `streams`, and arrowing to another repository before `/` locks that one). Clicking a repository header or pressing `Enter` on `+ New workspace in <repo>…` does the same. Once a Repo Chip is active, `/` is a literal character (so `/feat/auth` creates `"feat/auth"` in the current repository), and `Backspace` on an empty input (or clicking the chip) returns to Flat Search.
- Selection is pinned by user keystrokes and clicks (`↑`/`↓` or typing); late background discovery results never move the highlighted row under you.
- `Enter` switches to an existing terminal pane when a workspace is already open (preferring a dedicated space, using longest-prefix ownership so nested checkouts never alias their parent). For new or closed workspaces, `Enter` opens a new nested space by default (`openIn: "space"`) or a new tab in the target space when `openIn: "tab"` is configured (falling back to a new space on a different machine). `Shift+Enter` opens in the opposite destination, and refuses tab placement on a different machine with an inline error.
- Creating a workspace fetches local bookmarks at create time (failing inline if the lookup errors), makes the parent folder, runs `jj workspace add --name=<name> -- <dest>` from the main checkout, runs one `sh -c` script for configured `links` (silently skipping absent sources or existing destinations) and optional `mise trust`, and opens the new space or tab.

## Status lines

A jj space's row reads, for example, `master~4 ~3 +120 -8`. That is the nearest bookmark at or below `@` and its distance, then the number of changed files, in bold, and the lines added and removed in `@`. An empty `@` shows `∅`. A jj error shows as a dim `stale`, `divergent` or `error`, with jj's message as its tooltip. The line describes the checkout of the first terminal in the space's active tab, so a space with tabs in several repositories shows the one you are on. As on Git rows, the repository's name comes first unless the space's name or its place in the tree already gives it.

The line refreshes after any jj operation in the repository, through a watch on its `.jj/repo/op_heads/heads` folder, and after an agent's turn or a command ends in the space. That second read lets jj snapshot the checkout first. Every other read passes `--ignore-working-copy`. A repository the watch cannot cover, or one on another machine, rereads every 30 seconds. A hidden or narrow sidebar starts no jj process.

## Changes panel

The Changes button in the tab bar opens the panel for the focused pane's checkout. The header gives the checkout's folder name, the stack's base, the time of the last refresh, a diff button and a refresh button. Below it is the stack, the changes after the base up to `@` and any above `@`, newest first, then the change they start from, dimmed and marked base. Each row shows the change ID with its shortest unique prefix in purple, up to two bookmarks, the description, the conflict state, the number of files changed as an orange `~N` like the status line's, and the lines added and removed. When the base is not an ancestor of `@`, the last row is the newest change both share. The stack shows at most 100 changes.

The base is `trunk()` until you change it. Click it to open a picker with your 20 newest bookmarks, local and remote, filtered as you type. Typing highlights the first match. As in a browser's address bar, ↑ and ↓ move through the list and put the highlighted bookmark in the input, where you can apply it or keep typing to edit it. Moving past either end puts back what you typed, and Escape puts it back too, then closes the picker. Enter or a click applies the highlighted bookmark. Enter with nothing highlighted applies the input's text, and an empty one returns to `trunk()`. Each workspace keeps its own base, saved by Herdr. When jj cannot resolve the base, the panel shows jj's error.

Click a change to see its files. Shift-click a second change to see the files that changed from the older one, labelled FROM, to the newer one, labelled TO. The older change's own edits are left out of that comparison. Click a file, or diff, to open the selection's diff in a pane right of the focused one, in the checkout's folder. The pane runs [Hunk](https://hunk.dev/) when `hunk` is installed, as `hunk show <change>` or `hunk diff <from> <to>` for the whole selection, so you can add comments with Hunk. A new Hunk window starts at its first file, and a later click on a file moves the window to it. Without Hunk the pane runs `jj diff` for the clicked file with your diff formatter, paged by `less -R`, which stays open until you press `q`. Each tab has one diff pane. A later click reloads the Hunk window in it when the selection's commits changed, or replaces the pane when it runs `jj diff` or its Hunk window cannot be found by process ID. Quitting closes the pane. The diff names changes by change ID, so it follows them as jj rewrites them. `@` stays selected as jj rewrites it, and a selected change that another command rewrites or abandons is cleared with the note "Selected change was rewritten".

Showing the panel and pressing refresh run `jj util snapshot` and then read the stack. After any jj operation in the repository, the panel rereads the stack without a snapshot. A hidden panel starts no jj process. In a Git-only folder the panel is Herdr's shipped Changes panel, with its Commit box and ten-second Git refresh. The panel has no commit or push action in jj checkouts.

The panel edits the stack with one jj command per click, and shows jj's error when one fails. `jj undo` reverses any of them.

| Action | How | jj command |
|---|---|---|
| New change on `@` | `+` in the header | `jj new` |
| New change after a change, and edit it | `+` on the row, shown on hover | `jj new --insert-after <change>` |
| Squash a change into its parent | `↓` on the row, shown on hover | `jj squash -r <change>` |
| Describe a change | Double-click its description. Enter saves, Shift+Enter adds a line, Escape cancels | `jj describe -r <change> -m <text>` |
| Edit a change | Right-click menu | `jj edit <change>` |
| Abandon a change | Right-click menu | `jj abandon <change>` |
| Copy a change ID | Right-click menu | |

When both changes have descriptions, squash joins them with a blank line, the text jj's editor would start with. The base row has no buttons, and its menu only copies its ID. `↓` is left off the change above the base.

## Finish jj workspace

`Finish jj workspace` removes one linked workspace and its folder per confirmation. It appears in a tab's or space's right-click menu when a terminal pane in that scope works in a linked jj workspace, opening a keyed singleton `jj-finish` window (`520x360`). Ordinary `Close` stays non-destructive.

- When one linked workspace is in scope, the window goes straight to confirmation. When multiple linked workspaces are in scope, `↑`/`↓` (or a click) chooses one checkout (defaulting to the active tab's checkout).
- Every preview, drift check, kill, and cleanup is scoped strictly to the target space's machine. The confirmation names every direct live terminal on that machine whose live pane folder or launch folder lies inside the chosen checkout, and notes any non-spared dependent child terminals outside the checkout without waiting on children Herdr keeps alive (`--outlive-parent` or kept panes).

`Enter` runs three steps on the chosen workspace:

1. Check. It reads `jj workspace list` (requiring a real recorded path, never guessing legacy pre-0.38 roots), refuses if another known workspace lives inside the folder, and runs `jj status` (10 s timeout).
2. Verify and end terminals. It re-evaluates direct live terminals immediately before killing and refuses via a typed drift error if any new terminal appeared (non-drift errors never silently absorb new terminals). Otherwise it sends `terminal.kill` to each direct terminal and waits up to 10 seconds via a bounded active-only poll for all of them to exit.
3. Remove and clean up. It runs `jj workspace remove -- <name>` from the main checkout, then closes panes belonging to that checkout (closing the space only when its pane list is non-empty and every pane belonged to the removed checkout).

Edits jj tracks stay in the repository; untracked and ignored files are deleted with the folder. If a failure occurs, Finish stays open with the error message and retries cleanly on `Enter`.

## Develop and verify

Versions live in `.tool-versions` and tasks in `Justfile`. `.envrc` activates mise tools when mise is present.

```sh
just verify
just bench
```

`just verify` runs the Node tests, the native `herdr-app check` of every mod and `node --check` on every script and mod file. `scripts/check-mods.js` also fails when a mod's copy of the shared section of `mods/jj-spaces/jj.js` differs from the original. `tests/mods.test.js` runs the mods against fake Herdr and fake commands. `tests/jj.test.js` runs the mods' jj code against real jj in disposable repositories. The tests and the bench load the user's jj config followed by `tests/jj-test.toml`, which turns off signing and sets `trunk()` to `master`, so they never ask a signing agent and write no repo config into the user's config folder.

`just bench` times the status line and the Changes panel's reads, and writes `.tmp/bench.json`. With jj 0.47.1 and Watchman on macOS, a status line read took 22 to 51 ms, the read after an agent turn 198 to 307 ms, a 20-workspace refresh 363 to 839 ms, showing the panel in a 100,000-file repository 219 ms, and a 100-change stack 83 ms. A change in the stack that touches many files slows every stack read, by about 5 seconds for 10,000 added files.

`scripts/app-trial.js` runs CUJs 1 to 6 in a separate temporary HOME, app home and core session, and never touches an existing app home. Run `prepare`, start `run` with `hc run --bg`, then `resources`, `new`, `edit`, `open`, `shot` and `verify`, or `resources`, `panel`, `pair`, `verify-panel`, `diff`, `verify-diff`, `diff second`, `verify-diff second` and `quit-diff`. For the base picker, after `panel` run `base mi`, `base-apply` and `verify-base mid`, which drive the picker through the mod's own methods, so native key presses stay untested. For Finish, after `new` run `finish-setup`, then `finish topic` and `verify-finish topic`, `finish review review` and `verify-finish review`, and `lock`, `finish locked`, `unlock`, `again` and `verify-finish locked`. End with `quit` and `stop-core`. The window draws frames only while it is shown, so screenshots need it in front.

## Limits

- The tested versions are jj 0.47.1 and Herdr 0.1.15 on macOS. One hand-run trial covered a Linux remote machine. Herdr on Linux is untested.
- Install the mods only where the Herdr app runs. A remote machine needs `jj` on the `PATH` its herdr-core starts with, which can differ from your login shell's. Hunk and mise there are optional. A folder inside a jj checkout where `jj` cannot start shows `no jj`, with the reason in its tooltip.
- On another machine the status line refreshes after agent turns and every 30 seconds, and the Changes panel only when shown or when you press refresh. jj commands you run there show up then.
- The native trial (`scripts/app-trial.js`) covers `jj-workspace` creation and opening, nesting, status line refresh after an operation, Changes panel snapshots, pairs, Hunk diff panes, and Finish across single-workspace, two-workspace choose-one, and held-lock retry flows. Flat Search, Repo Chip (`Enter` / `Backspace`), cross-machine safety, `Shift+Enter` placement, tab right-click Finish, and the `jj diff` fallback without Hunk are covered by pure core tests (`tests/workspace-core.test.js`, `tests/finish-core.test.js`) and fake-Herdr integration tests (`tests/mods.test.js`).
- The stack actions are covered by fixture tests and by checking their jj commands in a disposable repository. The hover buttons, the right-click menu and the Enter key in the describe textarea have not been tried in the app.
- jj 0.47.1 brings a workspace up to date when another workspace rewrites its `@`, so no test produces a real `stale` error.
