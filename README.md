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

The `jj workspace` dialog (`560x480`) is a single filter-first list for opening and creating jj workspaces:

- On open, the dialog immediately loads the target space's repositories (focused repository first, then tab order) while keeping default selection inside the current space. In the background, it discovers repositories in other Herdr spaces (current machine first, then other machines, in sidebar order within each) and disk repositories under the `directory` base and configured `repos` patterns (scanning the current machine plus local when on a remote machine, ordered current machine first and by most recent jj operation in `.jj/repo/op_heads/heads` within each). Remote repositories show their host badge (and local repositories show a `local` badge when opened from a remote space).
- Each repository lists its workspaces (`root` marks the main checkout; pre-0.38 `default` checkouts recover their folder from the main checkout, while other unrecorded linked workspaces show `unavailable`) alongside an inline `New workspace` row.
- Type to filter by repository name or workspace name. Typing a repository name floats that repository to the top with `New workspace` first and displays an inline ghost completion (`iles/` for prefix matches, ` → .dotfiles/` for mid-string matches). Type `/` or press `→` at the end of the text to complete `<repo>/`, then type a name (for example `.dotfiles/fix`) to filter or create inside that repository. Exact workspace matches hide the duplicate `New` row so `Enter` opens the existing workspace directly.
- Moving with `↑`/`↓` pins your selected row key so continued typing, completion, or background loading never pull selection away from a row you scrolled to (and backspacing restores a temporarily hidden pinned row).
- `Enter` switches to an existing terminal pane when a workspace is already open (preferring a dedicated space, else switching to the matching space and tab). For new or closed workspaces, `Enter` opens a new nested space by default (`openIn: "space"`) or a new tab in the target space when `openIn: "tab"` is configured (falling back to a new space for a repository on a different machine). `Shift+Enter` opens in the opposite destination (and always opens a new tab for an already-open same-machine workspace, naming a main-checkout tab after the repository name); the footer always labels both destinations (`↵ new space · ⇧↵ new tab`, `↵ new tab · ⇧↵ new space`, or `↵ switch · ⇧↵ new tab`). For a repository on a different machine, `Shift+Enter` leaves the dialog open with an inline error.
- Creating a workspace makes the parent folder, runs `jj workspace add` from the repository's main checkout (starting on a matching local bookmark or the main checkout's `@-`), links each `links` path present in the main checkout and absent from the new checkout (silently skipping paths absent from the main checkout or already present in the new checkout), runs `mise trust` on linked mise files when `miseTrust` is enabled and `mise` is available, and opens the new space or tab. jj's error stays in the dialog when it refuses; link or `mise trust` failures appear in one `New jj workspace` warning notification while the space or tab still opens.

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

`Finish jj workspace` removes linked workspaces and their folders. It appears in a tab's right-click menu when any terminal pane in that tab works in a linked jj workspace, and in a space's right-click menu when any terminal pane in that space works in a linked jj workspace. Ordinary `Close` stays non-destructive.

- From a tab right-click, the window lists only that tab's linked workspaces, all checked.
- From a space right-click, the window lists every linked workspace across all repositories in the space (labeled `<repo> / <workspace>` when multiple repositories appear), with only the active tab's linked workspaces checked (zero checked if the active tab is outside any linked workspace, in which case `Enter` is a no-op).
- `Space` toggles the selected row and arrow keys move between rows. Under every checked row, a line names every individual terminal that will end with its tab, other space, `parked`, or `child of <parent>` context.

`Enter` runs three steps on the checked workspaces.

1. Check. It reads `jj workspace list` once per checked repository, confirms each workspace still maps to its folder, refuses any checked folder containing another known workspace root, and runs `jj status` (10 s timeout) in each checked checkout.
2. Verify and end terminals. It re-evaluates the affected terminals (matching both each terminal's launch folder and its live pane folder, plus transitive child terminals) immediately before killing and refuses if any new terminal appeared after preview (asking you to review and press `Enter` again). Otherwise it kills every direct terminal in the checked checkouts and waits up to 10 seconds for all affected terminals (including children) to stop. It closes the target space only when no panes of any kind remain outside the ended terminals, and closes any remaining panes showing ended terminals.
3. Remove. It runs `jj workspace remove` sequentially from each checked workspace's own main checkout.

Edits jj tracks stay in the repository, in the workspace's last change. Files jj does not track, including ignored files, are deleted with the folder. The first failure stops Finish and shows its message beside the workspace's name, and nothing after it runs. `Enter` then starts again with the workspaces not yet removed. The dialog is a window overlay, so it stays open while its space closes, and closes once every checked workspace is removed.

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
- The native trial (`scripts/app-trial.js`) covers `jj-workspace` creation and opening, nesting, status line refresh after an operation, Changes panel snapshots, pairs, Hunk diff panes, and Finish across single-workspace, two-workspace, and held-lock retry flows. Interactive dialog navigation (`cmd-shift-n`, background discovery of other spaces and `repos`, `/` and `→` completion with inline ghost suffix, `selectedKey` stability, and `root` recovery) was verified live in Herdr 0.1.15 on macOS and in fake Node tests (`tests/mods.test.js`); `Shift+Enter` new-tab placement, tab right-click Finish, and the `jj diff` fallback without Hunk are covered by fake Node tests.
- The stack actions are covered by fixture tests and by checking their jj commands in a disposable repository. The hover buttons, the right-click menu and the Enter key in the describe textarea have not been tried in the app.
- jj 0.47.1 brings a workspace up to date when another workspace rewrites its `@`, so no test produces a real `stale` error.
