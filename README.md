# Herdr jj workspaces

Five JavaScript mods and one layout give each jj workspace its own space in Herdr. A linked workspace's space sits under its main checkout's space, and every jj space shows a status line with its nearest bookmark and its changes in `@`. Herdr runs the mods, and no separate program is needed.

The mods are copies of Herdr 0.1.15's shipped mods with jj added. `jj-spaces` comes from `spaces`, `jj-workspace` from `worktree`, `jj-menu` from `menu`, `jj-new-menu` from `new-menu` and `jj-tabs` from `tabs`. Folders outside jj keep the shipped Git behavior. The [jj workspace lifecycle design](design/jj-workspace-lifecycle.md) explains the architecture and the staged plan. [Contributor guidance](AGENTS.md) covers project goals and development rules.

## Install

```sh
just install
herdr-app do layout.switch '{"name":"jj-tui"}'
```

`just install` copies each `mods/jj-*` folder and `layouts/jj-tui.json` and `layouts/jj-tui.svg` into `${HERDR_APP_HOME:-~/.config/herdr-app}`, replacing earlier copies of those project-owned names. It leaves Herdr's shipped mods and layouts unchanged. Switch back with `herdr-app do layout.switch '{"name":"main"}'`.

The layout mounts Herdr's own `agents` list and the Files panel. It mounts no Changes panel, since the shipped one polls Git every ten seconds. Key bindings for the agents list are the shipped `agents` mod's.

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

A jj space's row reads, for example, `master~4 ~3 +120 -8`. That is the nearest bookmark at or below `@` and its distance, then the number of changed files and the lines added and removed in `@`. An empty `@` shows `∅`. A jj error shows as a dim `stale`, `divergent` or `error`, with jj's message as its tooltip. A space whose terminals sit in more than one jj repository shows no status line.

The line refreshes after any jj operation in the repository, through a watch on its `.jj/repo/op_heads/heads` folder, and after an agent's turn or a command ends in the space. That second read lets jj snapshot the checkout first. Every other read passes `--ignore-working-copy`. A repository the watch cannot cover, or one on another machine, rereads every 30 seconds. A hidden or narrow sidebar starts no jj process.

## Remove a workspace

Stage 1 has no Finish action. Close the workspace's space with Herdr's Close, then remove the workspace from its main checkout.

```sh
jj workspace remove <name>
```

`jj workspace remove` snapshots the checkout and then deletes its folder, including untracked files. Snapshotted work stays in the repository.

## Develop and verify

Versions live in `.tool-versions` and tasks in `Justfile`. `.envrc` activates mise tools when mise is present.

```sh
just verify
just bench
```

`just verify` runs the Node tests, the native `herdr-app check` of every mod and `node --check` on every script and mod file. `scripts/check-mods.js` also fails when a mod's copy of the shared section of `mods/jj-spaces/jj.js` differs from the original. `tests/mods.test.js` runs the mods against fake Herdr and fake commands. `tests/jj.test.js` runs the shared jj code against real jj in disposable repositories.

`just bench` times the status line read at 3, 10,000 and 100,000 files and one refresh of 20 workspaces, and writes `.tmp/bench.json`. With jj 0.47.1 and Watchman on macOS, a read took 37 to 51 ms, the read after an agent turn 253 to 257 ms, and the 20-workspace refresh 839 ms.

`scripts/app-trial.js` runs CUJs 1 and 2 in a separate temporary HOME, app home and core session, and never touches an existing app home. Run `prepare`, start `run` with `hc run --bg`, then `resources`, `new`, `edit`, `open`, `shot` and `verify`, and end with `quit` and `stop-core`. The window draws frames only while it is shown, so screenshots need it in front.

## Limits

- The tested versions are jj 0.47.1 and Herdr 0.1.15 on macOS. Linux and remote machines are untested.
- The native trial covers New and Open workspace, nesting and a status line refresh after an operation. The refresh after an agent's turn is covered by fake tests only.
- jj 0.47.1 brings a workspace up to date when another workspace rewrites its `@`, so no test produces a real `stale` error.
