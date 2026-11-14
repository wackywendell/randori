# Herdr jj workspaces

Six JavaScript mods and one layout give each jj workspace its own space in Herdr. A linked workspace's space sits under its main checkout's space, every jj space shows a status line with its nearest bookmark and its changes in `@`, and a Changes panel shows the stack and its diffs. Herdr runs the mods, and no separate program is needed.

The mods are copies of Herdr 0.1.15's shipped mods with jj added. `jj-spaces` comes from `spaces`, `jj-workspace` from `worktree`, `jj-menu` from `menu`, `jj-new-menu` from `new-menu`, `jj-tabs` from `tabs` and `jj-changes` from `changes`. Folders outside jj keep the shipped Git behavior. The [jj workspace lifecycle design](design/jj-workspace-lifecycle.md) explains the architecture and the staged plan. [Contributor guidance](AGENTS.md) covers project goals and development rules.

## Install

```sh
just install
herdr-app do layout.switch '{"name":"jj-tui"}'
```

`just install` copies each `mods/jj-*` folder and `layouts/jj-tui.json` and `layouts/jj-tui.svg` into `${HERDR_APP_HOME:-~/.config/herdr-app}`, replacing earlier copies of those project-owned names. It leaves Herdr's shipped mods and layouts unchanged. Switch back with `herdr-app do layout.switch '{"name":"main"}'`.

The layout mounts Herdr's own `agents` list, the Files panel and the `jj-changes` panel. Key bindings for the agents list are the shipped `agents` mod's.

## Settings

Settings are props on the `jj-spaces` block of the installed `layouts/jj-tui.json`. New workspace reads them each time it runs.

| Prop        | Default                            | Meaning                                                                                                                 |
| ----------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `directory` | `~/.herdr/worktrees/{repo}/{name}` | Where New workspace puts a checkout. `{repo}` is the main checkout's folder name and `{name}` the workspace name, made safe for a folder. |
| `links`     | `[]`                               | Paths, relative to the main checkout, that New workspace links into the new checkout with `ln -s`.                      |
| `miseTrust` | `true`                             | Run `mise trust` on each linked mise configuration file, when `mise --version` succeeds.                               |

## New and Open workspace

Right-click a jj space, or open the tab bar's + menu from a jj checkout, and choose New workspace… or Open workspace….

New workspace asks for a name and shows the folder it will use and what the checkout starts from. A name matching a local bookmark starts on that bookmark. Any other name starts from the current checkout's parent, jj's default. Enter makes the folder's parent, runs `jj workspace add`, links each `links` path that exists in the main checkout and is absent from the new one, trusts linked mise files, and opens a space on the new checkout. jj's error stays in the dialog when it refuses. A skipped or failed link shows one notification naming each path, and the space still opens.

Open workspace lists the repository's workspaces, main checkout first, filtered as you type. Enter selects the space already on that workspace, or opens a new one. A workspace created before jj 0.38 has no recorded folder and shows as unavailable.

## Status lines

A jj space's row reads, for example, `master~4 ~3 +120 -8`. That is the nearest bookmark at or below `@` and its distance, then the number of changed files, in bold, and the lines added and removed in `@`. An empty `@` shows `∅`. A jj error shows as a dim `stale`, `divergent` or `error`, with jj's message as its tooltip. The line describes the checkout of the first terminal in the space's active tab, so a space with tabs in several repositories shows the one you are on. As on Git rows, the repository's name comes first unless the space's name or its place in the tree already gives it.

The line refreshes after any jj operation in the repository, through a watch on its `.jj/repo/op_heads/heads` folder, and after an agent's turn or a command ends in the space. That second read lets jj snapshot the checkout first. Every other read passes `--ignore-working-copy`. A repository the watch cannot cover, or one on another machine, rereads every 30 seconds. A hidden or narrow sidebar starts no jj process.

## Changes panel

The Changes button in the tab bar opens the panel for the focused pane's checkout. The header gives the checkout's folder name, the time of the last refresh and a Refresh button. Below it is the stack, the changes from `trunk()` to `@`, newest first, with each change's ID, description, conflict state and lines added and removed. The stack shows at most 100 changes.

Click a change to see its files and its diff against its parent. Shift-click a second change to see what changed from the older one, labelled FROM, to the newer one, labelled TO. The older change's own edits are left out of that diff. Click a file to see its diff. A diff shows at most 5,000 lines or 1 MiB and says when it was cut short. `@` stays selected as jj rewrites it, and a selected change that another command rewrites or abandons is cleared with the note "Selected change was rewritten".

Showing the panel and pressing Refresh run `jj util snapshot` and then read the stack. After any jj operation in the repository, the panel rereads the stack without a snapshot. A hidden panel starts no jj process. In a Git-only folder the panel is Herdr's shipped Changes panel, with its Commit box and ten-second Git refresh. The panel has no commit action in jj checkouts.

## Finish workspace

Finish workspace, in the menu of a space with a terminal in a linked workspace, removes workspaces and their folders. Close stays as it is and deletes nothing.

The dialog lists each linked workspace a terminal of the space works in, with its folder, in tab order. The first is checked. Space checks or unchecks the selected row, and the arrow keys move between rows. Under a checked workspace, a line names any other space with a terminal there, since those terminals end too.

Enter runs three steps on the checked workspaces.

1. It confirms jj still lists each one at its folder, then runs `jj status` in each. That snapshots edits and fails on a held lock, a stale workspace or a missing folder. A held lock fails after 10 seconds.
2. It ends every terminal working in those folders, including parked ones, and waits up to 10 seconds for them to stop. Herdr closes their panes, and a space with none left.
3. It runs `jj workspace remove` for one workspace at a time.

Edits jj tracks stay in the repository, in the workspace's last change. Files jj does not track, including ignored files, are deleted with the folder. The first failure stops Finish and shows its message beside the workspace's name, and nothing after it runs. Enter then starts again with the workspaces not yet removed. The dialog is a window, so it stays open while its space closes, and closes when every checked workspace is removed.

## Develop and verify

Versions live in `.tool-versions` and tasks in `Justfile`. `.envrc` activates mise tools when mise is present.

```sh
just verify
just bench
```

`just verify` runs the Node tests, the native `herdr-app check` of every mod and `node --check` on every script and mod file. `scripts/check-mods.js` also fails when a mod's copy of the shared section of `mods/jj-spaces/jj.js` differs from the original. `tests/mods.test.js` runs the mods against fake Herdr and fake commands. `tests/jj.test.js` runs the mods' jj code against real jj in disposable repositories. The tests and the bench load the user's jj config followed by `tests/jj-test.toml`, which turns off signing and sets `trunk()` to `master`, so they never ask a signing agent and write no repo config into the user's config folder.

`just bench` times the status line and the Changes panel's reads, and writes `.tmp/bench.json`. With jj 0.47.1 and Watchman on macOS, a status line read took 22 to 51 ms, the read after an agent turn 198 to 307 ms, a 20-workspace refresh 363 to 839 ms, showing the panel in a 100,000-file repository 219 ms, a 100-change stack 83 ms and a 5,000-line diff 25 ms. A change in the stack that touches many files slows every stack read, by about 5 seconds for 10,000 added files.

`scripts/app-trial.js` runs CUJs 1 to 6 in a separate temporary HOME, app home and core session, and never touches an existing app home. Run `prepare`, start `run` with `hc run --bg`, then `resources`, `new`, `edit`, `open`, `shot` and `verify`, or `resources`, `panel`, `pair` and `verify-panel`. For Finish, after `new` run `finish-setup`, then `finish topic` and `verify-finish topic`, `finish review review` and `verify-finish review`, and `lock`, `finish locked`, `unlock`, `again` and `verify-finish locked`. End with `quit` and `stop-core`. The window draws frames only while it is shown, so screenshots need it in front.

## Limits

- The tested versions are jj 0.47.1 and Herdr 0.1.15 on macOS. Linux and remote machines are untested. On another machine the Changes panel refreshes only when shown or when you press Refresh.
- The native trial covers New and Open workspace, nesting and a status line refresh after an operation. The Changes panel's native trial covers showing it, the snapshot of an unrecorded edit, a FROM and TO pair and the reread after a jj operation. The trial selects the pair from a test subclass, so clicks are covered by fake tests only. The refresh after an agent's turn is covered by fake tests only. Finish's native trial covers a space with one workspace, one workspace of a space with two, and a held lock with its retry, each choosing workspaces from a test subclass. Its key presses and checkbox clicks are covered by fake tests only.
- jj 0.47.1 brings a workspace up to date when another workspace rewrites its `@`, so no test produces a real `stale` error.
