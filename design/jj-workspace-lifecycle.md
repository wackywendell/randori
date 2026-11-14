# jj workspace lifecycle in Herdr

Author: Wendell Smith
Status: Approved
Date: 2026-11-13

---

## Overview

This design adds jj workspaces to Herdr as a general-purpose set of mods. One person can run several pieces of work in parallel in one jj repository, each in its own Herdr space, and see where each piece stands without leaving Herdr.

This document uses these terms.

- A jj workspace is a working directory that shares one repository's history with the others. The repository's first workspace is its main checkout, and every other one is a linked workspace. This document calls a workspace's directory its checkout.
- A change is jj's unit of work. Its change ID stays the same when the change is rewritten, and its commit ID names one version of it.
- `@` is the change a checkout is editing, and `@-` is its parent.
- A snapshot is jj recording the checkout's files into `@`. jj snapshots at the start of most commands.
- An operation is one entry in the repository's operation log, which jj writes after every command that changes the repository, including a snapshot that finds edits. All workspaces of a repository share one operation log. Divergent operations are two operations written concurrently, which the next jj command that snapshots or writes merges.
- A workspace is stale when another workspace's command rewrote its `@`. jj then refuses to snapshot it until `jj workspace update-stale` runs.
- A bookmark is jj's name for a branch. `trunk()` is jj's revset for the repository's main bookmark, such as `master`.
- A colocated repository keeps a Git repository beside jj's, so Git tools also work in it.
- A Herdr space is a named group of tabs in the Herdr app, listed in the sidebar.
- A status line is the short text after a space's name in the sidebar's Spaces list, where Herdr shows a Git branch.
- Herdr's shipped mods are the mods Herdr installs and restores at start-up, such as its sidebar and Changes panel.
- `mise` is a tool manager that reads per-project configuration files and asks you to trust a file before running it.

The work covers three moments.

1. Starting. You choose New workspace from a space's menu or the + menu and type a name. A space opens on a new linked workspace, nested under the main checkout's space.
2. Returning. Each space's status line shows its checkout's state with content similar to your shell prompt, such as `master~4 ~3 +120 -8`. A changes panel, opened from the tab bar, shows the stack of changes since `trunk()`, the files each change touches and a comparison between two changes, and opens diffs in a tab.
3. Finishing. Finish workspace, in the space's menu, ends the terminals working in the checkout and removes the workspace. Its edits stay in the repository.

The design follows Herdr's own support for Git worktrees. Herdr's space menu offers New, Open and Remove worktree, its + menu offers New and Open worktree, its sidebar nests worktree spaces under their repository's space and shows each one's branch, and its Changes panel opens from the tab bar. This design offers the jj equivalents in the same places, and each mod starts as a copy of the shipped mod it follows.

The work ships in two stages. Stage 1 adds the nesting sidebar, status lines, and the New and Open workspace dialogs, which delete nothing. Stage 2 adds the changes panel and Finish.

## The Problem

Parallel work in jj needs a checkout per piece of work, a terminal in each, and a way to see what each one holds and where it stands.

- Starting a checkout takes `jj workspace add` with a path and revision, links to local files the repository ignores, often `mise trust`, and a new Herdr space and tab in the right folder.
- Returning means switching to the checkout and running `jj log` and `jj diff` to remember what it holds. Herdr's sidebar shows Git branches, which a jj checkout lacks. Herdr's Changes panel reads Git, so it misses the jj stack. In a new 10,000-file jj workspace it also costs 5.9 seconds per refresh, every ten seconds.
- Finishing means closing every terminal in the checkout, then removing the workspace and its directory.

The design gives each workspace its own space. A space's identity then answers "which checkout", its status line answers "what state is it in", and finishing it removes the checkout.

## Goals

- Start from a name. Typing a name and pressing Enter creates the workspace, checkout and nested space. The dialog says where the checkout goes and what it starts from. When the name or folder is taken, jj's error appears in the dialog.
- See each workspace's state at a glance. The status line of each jj space shows its nearest bookmark, the number of changes since it, and the files and lines changed in `@`, or `∅` when `@` has no changes. An agent's edits appear when its turn ends.
- Inspect progress in jj terms. The changes panel shows the stack since `trunk()`, per-change line totals, the files a change touches and the files that differ between two changes, and opens any of those diffs in a tab you can comment on. In jj repositories every number comes from jj and matches `jj log`.
- Stay quiet when unwatched. In jj checkouts, a hidden sidebar or panel starts no jj process, and jj refreshes follow file watches and agent turns, with no timer where file watching works.
- Finish in one action. In the common case the Finish dialog opens with the space's own workspace checked, and Enter removes it. Before you confirm, the dialog says which folders it deletes, that edits jj tracks stay in the repository, and that files jj does not track are deleted.
- Work in any jj repository. Nothing assumes a project's files or tools. Linked files and `mise` trust are settings.
- Fit Herdr. Entry points sit where Herdr puts its worktree actions. Dialogs, menus, notifications, colors and controls are Herdr's own, so the UI follows light and dark themes.
- Fail early and visibly. A failed action stops at the first error and shows jj's message where it happened. The panel keeps the last good data visible beside the error.

## Non-Goals

- Editing history. The panel offers no rebase, squash, describe, commit, bookmark, tag, operation log, undo or redo. You use jj for these.
- Interdiff and drag and drop.
- Automatic recovery from stale workspaces. They are reported, never updated.
- Publishing work. No mod runs commit, push or merge in a jj checkout. jj records edits in the working-copy change when it snapshots.
- Keeping untracked files at Finish. Files jj does not track, such as ignored `.local/` notes, are deleted with the checkout. You track them in jj or move them first.
- Live file events in the changes panel. Edits saved by an editor appear at the next agent turn, jj command or Refresh.
- Moving existing checkouts. Checkouts outside Herdr's worktree location keep working where they are.
- Rearranging existing mixed spaces. Spaces you already use for several repositories keep their tabs.
- Editing Herdr's shipped mods. Each mod here is a project-owned copy.
- Streams integration, remote machines and Linux. The mods pass each space's machine to every command, but remote machines and Linux remain untested.

## Open Questions

None.

## Critical User Journeys (CUJs)

### CUJ 1. Start a workspace

- Given the main checkout `randori` is open in a space of the same name, and the repository has no bookmark named `nesting`. Its `mise.toml` is trusted, and the layout lists `mise.toml` and `AGENTS.local.md` as linked files.
- When you choose New workspace from that space's menu and type `nesting`.
- Then the dialog shows `~/.herdr/worktrees/randori/nesting` and "starts from this checkout's parent". After you press Enter, a space `nesting` opens below the main space, drawn as its child, with a terminal in the checkout. Both files are links to the main checkout's copies, and `mise` runs there without a trust prompt.

### CUJ 2. Glance at status

- Given three nested workspaces, one with an agent editing files.
- When the agent's turn ends.
- Then that space's status line changes, for example to `master~2 ~3 +40 -5`, within about a second. The other two status lines refresh once and keep their text. A space with no changes in `@` shows `∅`.

### CUJ 3. Inspect and compare

- Given a workspace whose stack has four changes since `trunk()`.
- When you open the changes panel.
- Then the panel lists the four changes with lines added and removed, and the files changed in `@`. Selecting a file opens its diff in a new tab. Shift-clicking a second change lists the files that differ between the two, labelled with both change IDs, and their diff opens from the older to the newer. Running `jj describe` in a terminal updates the panel. Hiding the panel stops all of its work.

### CUJ 4. Finish

- Given the `nesting` space holds two terminals, one of them an agent, both in the checkout. The checkout has an edited `src/lib.rs` and an ignored `build.log`.
- When you choose Finish workspace from the space's menu.
- Then the dialog lists `nesting`, checked, with its folder `~/.herdr/worktrees/randori/nesting`. It says the terminals end, that edits jj tracks stay in the repository, and that files jj does not track are deleted. After you press Enter, both terminals end and the space closes, jj snapshots the edit to `src/lib.rs` into the workspace's change, and the checkout and `build.log` are gone. `jj log` in the main checkout shows the change.

### CUJ 5. Finish a space that holds two workspaces

- Given a space `review` with one tab in workspace `review` and another in workspace `nesting`. Space `nesting` also has a terminal in that checkout.
- When you choose Finish workspace from `review`'s menu.
- Then the dialog lists `review` checked and `nesting` unchecked. Checking `nesting` adds a line saying its terminal in space `nesting` ends too. After you press Enter with only `review` checked, the terminal in `review`'s checkout ends and its tab closes, the `nesting` tab stays open, and workspace `review` is removed.

### CUJ 6. Finish fails

- Given another process holds jj's lock on the repository for longer than Finish waits.
- When you press Enter in the Finish dialog.
- Then the dialog shows jj's error beside the workspace's name, and every space and terminal stays open. Pressing Enter again starts Finish over.

### CUJ 7. Git-only repository

- Given a space whose folder is a Git repository with no `.jj`.
- When you open the space's menu or, from Stage 2, the changes panel.
- Then both behave as Herdr's own do. The menu offers Herdr's worktree entries, and the panel lists changed files and diffs from Git with no stack. The sidebar nests linked Git worktrees and shows their branches.

## Trade-offs

- Status lines describe one repository. A space whose terminals work in several repositories, or in none, shows no status line.
- A snapshot at each agent turn. When an agent's turn or a foreground command ends, its space's status line reads with a snapshot, so the edits appear. A snapshot that finds edits records an operation, which refreshes the other status lines of that repository. A snapshot that finds none records nothing. Every other automatic read leaves the checkout alone.
- Snapshots behave as jj commands do. A snapshot merges divergent operations and reports a stale workspace, as any jj command in a terminal would. Reads that skip the snapshot show `divergent` until the next snapshot or jj command merges it, and cannot see that a checkout is stale. A status line shows `stale` after its next snapshot finds it.
- No live file events in the panel. The panel snapshots when shown and on Refresh, and otherwise follows operations, so build output never starts a snapshot. An editor's save shows at the next agent turn, jj command or Refresh.
- Automatic `mise` trust. Trusting a `mise` file lets it run commands when you enter the directory. New workspace trusts only the `mise` files it links from the main checkout, and reports a trust failure in a notification. `mise` files that come from the start revision stay untrusted. Turning the setting off skips trust entirely.
- Reads that disagree for a moment. A jj command that lands between two reads of the current operation can make them disagree until the next refresh. Reads that name commits by commit ID always agree, because a commit ID names fixed content.
- Finish deletes files jj does not track. Ignored build output, scratch files and notes are lost with the checkout, as untracked files are with Herdr's Remove worktree. The dialog says so before you confirm.
- Finish ends terminals in other spaces. A terminal in another space working in a checked checkout ends with it, since its folder disappears. The dialog names those spaces before you confirm.
- Command-line tools only. Every read starts a `jj` process, about 16 ms of start-up before any work. A long-running helper could avoid it but would be a binary to install and keep running, which Herdr's mods never need.

## Technical Plan (Architecture)

Project-owned JavaScript mods do all of the work. They read and change jj state by running `jj` as a command, as Herdr's worktree mod runs `git`.

These Herdr interfaces appear below. Herdr's mod guide, `~/.config/herdr-app/AGENTS.md`, defines them in full.

- `mod.clone` copies a shipped mod into a project-owned mod with a new name.
- `exec` runs a command on a space's machine and returns its exit code, output and errors. It caps output at 8 MiB.
- `readTextFile` reads a text file of up to 1 MiB, on a space's machine.
- `watchFolder` reports file changes in a folder on this machine.
- `layout()` returns the current layout, including each block's props, `hidden` flags and each stack's `active` child.
- `spaces()`, `panes()` and `terminals()` list spaces, panes and every terminal from memory, with each terminal's folder. `terminals()` includes parked terminals and workers that have no pane.
- `space.new`, `space.move`, `space.close`, `pane.close` and `terminal.kill` open, reorder and close spaces and panes, and end terminals.

### Mods

Each mod starts as a `mod.clone` of the shipped mod it replaces, so it keeps Herdr's spacing, fonts, theme colors and keyboard behavior. The copy changes only its data source and the jj-specific parts.

| Project mod    | Copied from | What changes                                                                                                                                       |
| -------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jj-spaces`    | `spaces`    | Repository identity comes from jj, with the shipped Git check as fallback. jj spaces show a status line in place of a branch. Right-click opens `jj-menu`. |
| `jj-changes`   | `changes`   | jj checkouts get the stack, two-change selection and jj data, with no timer, no file watch and no commit bar. Git-only repositories keep the shipped Git behavior. |
| `jj-workspace` | `worktree`  | New, Open and Finish workspace dialogs for jj spaces, with the worktree dialog's layout, input, filtered list, key hints and busy spinner.        |
| `jj-menu`      | `menu`      | jj spaces get New, Open and Finish workspace where the shipped menu shows its worktree entries. Git spaces keep the shipped worktree entries.     |
| `jj-new-menu`  | `new-menu`  | jj spaces get New and Open workspace in place of New and Open worktree. Git spaces keep the shipped entries.                                      |
| `jj-tabs`      | `tabs`      | The + button and a tab's right-click open the jj menus. The Changes button stays hidden until Stage 2.                                            |

This repository's `jj-tui` layout mounts Herdr's own `agents` mod in the sidebar. From Stage 2 it puts `jj-changes` in the right panel stack's `changes` entry, which the tab bar's Changes button opens. The shipped `changes` mod is never mounted, so its Git poller never runs in jj checkouts.

Colors come from Herdr's theme. Status text and secondary labels use `dim` and `muted`. The status line's changed file count is bold in `working`, Herdr's color for agents at work, so edits in `@` stand out. Lines added use `ansi2` and lines removed use `ansi1`, the colors the shipped sidebar uses for commits ahead and behind and the shipped Changes panel uses for diff lines. Errors use `blocked`. Controls use the component library's lists, `Scrollbar`, `Input`, `Checkbox` and `Button`.

Every command passes the space's machine to `exec`. `watchFolder` works only on this machine, so a remote space's status line refreshes on agent turns, folder changes and a 30-second interval while visible.

```text
 Herdr app                                   jj and other commands
 jj-spaces
   new folder                     ─────────▶  jj workspace root, read .jj/repo
   after an operation             ─────────▶  jj log, current operation only
   after an agent turn            ─────────▶  jj log with a snapshot
 jj-changes
   shown or Refresh               ─────────▶  jj util snapshot, then jj log
   after an operation             ─────────▶  jj log, current operation only
   selection                      ─────────▶  jj log or jj diff by commit ID
   file or Open diff              ─────────▶  hunk --version once, then tab.new
 jj-workspace
   New workspace                  ─────────▶  jj workspace add, ln -s, mise trust
   Open workspace                 ─────────▶  jj workspace list
   Finish workspace               ─────────▶  check, end terminals, jj workspace remove
```

The diagram shows that only an agent turn, a shown panel, Refresh and Finish make jj snapshot, and that every other read uses the current operation without touching the checkout.

### Reading jj state

Reads that need no snapshot pass `--ignore-working-copy`, which reads the repository without snapshotting the checkout. They avoid `--at-op=@`, which snapshots in jj 0.47.1. Two reads snapshot, the status line's read after an agent turn and the changes panel's `jj util snapshot` when it is shown or refreshed. These snapshot as any jj command does and report a stale workspace. A jj error saying the workspace is stale shows as `stale`, and one saying the operation resolved to more than one operation shows as `divergent`.

Every template below was run against jj 0.47.1.

### Repository identity and nesting

Each mod finds a folder's repository when it first needs it, and keeps the answer in its own memory. `identity(folder)` runs `jj --ignore-working-copy workspace root`, which gives the checkout's root. In the main checkout `<root>/.jj/repo` is a folder, and in a linked workspace it is a file holding the path to the main checkout's `.jj/repo`. The repository's `.jj/repo` path identifies it, and the main checkout is the folder that holds it.

A mod uses the shipped Git code for a folder only when `jj` is not installed or reports "There is no jj repo". Any other failure shows as an error in that mod. Until the answer arrives, the mod shows nothing for the folder and runs no Git command.

`jj-spaces` nests every linked workspace's space under its main checkout's space with `space.move`, as the shipped sidebar does for worktrees. A space nests by the checkout of its first terminal with a folder, as in the shipped sidebar. Its status line describes the checkout of the first terminal in its active tab when that is a jj checkout, so a space with tabs in several repositories shows the one you are on, and switching tabs moves no space in the tree. As on Git rows, the line starts with the repository's name, the main checkout's folder name, unless the space's name or its nesting under that repository already gives it.

### Status lines

One `jj log --no-graph` call over `@ | heads(::@ & bookmarks())::@`, limited to 64 changes, yields the nearest bookmark, the distance to it, and the files and lines changed in `@`. The template computes `diff.stat()` only for `@`. On 3, 10,000 and 100,000 files this took a median of 32 to 38 ms, set by the number of changed files in `@`.

The text is the bookmark and distance, the file count and the line totals, as `master~4 ~3 +120 -8`. A bookmark at distance 0 shows as `master`. When several bookmarked changes are heads, it uses the one nearest `@` in jj's output order. When no bookmark is within 64 changes, the bookmark part is empty. An empty `@` shows `∅` in place of the file count and line totals. A stale workspace, divergent operations or a failed read show one dim word, `stale`, `divergent` or `error`, with jj's message as a tooltip. The text sits where the shipped sidebar shows a branch, and is cut from the left when the row is narrow.

A status line refreshes in three cases.

- After an operation. One watch on the repository's `.jj/repo/op_heads/heads/` folder, which jj rewrites after every operation, serves every workspace of that repository. Each operation refreshes the status lines of that repository's spaces one at a time, with `--ignore-working-copy`. A checkout no space shows is skipped, and read once when a space shows it again.
- After an agent's turn or a foreground command ends in the space, when the space's terminals go from busy to idle. The read omits `--ignore-working-copy`, so jj snapshots the checkout that terminal works in first, when a space shows it, and the space's own checkout otherwise. Other spaces of the repository refresh through the operation the snapshot records.
- After a space's first terminal changes folder, or its active tab changes to another checkout.

Where `watchFolder` rejects a watch, status lines fall back to a 30-second interval while visible.

### Changes panel

The panel shows the checkout of the focused pane's folder, as the shipped panel chooses its folder.

The stack is the list of changes from `trunk()` to `@`, the revset `@ | (trunk().. & first_ancestors(@))`, newest first. One `jj --ignore-working-copy log` call returns each change's commit ID, change ID, description, emptiness, conflict state and line totals, and for `@` each changed file's path, status and line counts. The stack stops at 100 changes, and the panel then says how many it shows.

Clicking a change selects it alone. Shift-clicking a second change selects the pair. Selecting a change other than `@` runs one `jj --ignore-working-copy log -r <commit>` for its files and line counts. Selecting a pair runs one `jj --ignore-working-copy diff --from <older> --to <newer>` with a template listing each file's path and status. Clicking a file, or Open diff for the whole selection, opens a terminal tab with `tab.new` in the active space and the checkout's folder. The tab runs Hunk, a terminal diff viewer with comments that reads jj repositories, when `hunk --version` succeeds on the checkout's machine. The panel asks once per machine. A single change opens as `hunk show <change>` and a pair as `hunk diff <older> <newer>`. Without Hunk the tab runs `jj --config 'ui.pager=less -R' diff` with `-r <change>` or `--from` and `--to`, so the user's diff formatter applies. jj's default pager, `less -FRX`, exits at once on a short diff, which would close the tab before it could be read. A file adds `-- 'root-file:"<path>"'`, a fileset Hunk passes on to jj. The tab names changes by change ID, so it shows the change's latest commit. Quitting the program closes the tab, and Herdr shows a toast with the exit code and last output when it exits nonzero within two seconds.

The diff opens in a tab because the panel is narrow and read-only. A tab gets the main area and Hunk's comments for annotation, and running a program in a tab needs no new interface. Editing stays in the editors and terminals of the space.

The panel has three regions, top to bottom.

1. A header with the checkout's folder name, the time of the last refresh, as "updated 14:03", an Open diff button while a change is selected, a Refresh button, and the last error with the last good data still shown below it.
2. The stack, with `@` first. A selected change shows its files. A selected pair is ordered by stack position and labelled FROM and TO with both change IDs, and the panel says the older change's own edits are excluded. A refresh that finds a selected change rewritten or gone says so and clears that selection.
3. The files of the current selection with status, and line counts for a single change. Clicking one opens its diff.

While visible, the panel snapshots with `jj util snapshot` and reads the stack when it is shown and when you press Refresh. After an operation, from the same `op_heads` watch the status lines use, it reads the stack without a snapshot. A hidden panel starts no jj process, although Herdr keeps its copy alive. In a Git-only repository the panel runs the shipped panel's Git code, including its ten-second timer.

### Refresh rules

`jj-spaces` and `jj-changes` each keep one refresh loop, as the shipped `spaces` and `changes` mods do. Each loop follows four rules.

- It runs at most one jj command at a time.
- A request that arrives during a run marks the loop pending, and the loop runs once more after the current run ends, so the last change always produces a final refresh.
- Each run carries a generation number, and a result older than the newest selection or checkout is dropped.
- A hidden view starts no run, and refreshes once when it is shown again.

A view is visible when its block and every block above it lack `hidden: true`, and each stack above it has the child holding it as `active`. `jj-spaces` also counts the sidebar as hidden while it is drawn narrow, since status lines are not drawn then.

### New and Open workspace

The New workspace dialog has one input for the name, a line showing the filled folder and what the checkout starts from, and the key hints `↵ create · esc cancel`. It loads the repository's local bookmark names once when it opens. On Enter it runs these steps in the current checkout.

1. Make the name safe for a folder, as Herdr's worktree mod does with branch names, and fill the `directory` setting's `{repo}` with the main checkout's folder name and `{name}` with the safe name.
2. Make the directory's parent folder with `mkdir -p`, since jj makes only the last folder. Run `jj workspace add --name <name> <directory>`, adding `-r <name>` when a local bookmark of that name exists. jj refuses `--ignore-working-copy` on this command, so it snapshots the current checkout first. Any other name starts from the current checkout's parent, jj's default. When jj refuses, its error stays in the dialog and nothing else runs.
3. For each path in the `links` setting that exists in the main checkout, create its parent folder and link it into the new checkout with `ln -s` and an absolute target. A path that already exists in the new checkout, as a file, folder or link, because the start revision tracks it, is left as it is.
4. When the `miseTrust` setting is on and `mise --version` succeeds, run `mise trust` on each file step 3 linked whose name is `mise.toml`, `.mise.toml`, `mise.<env>.toml` or `.mise.<env>.toml`, or that sits under `.mise/`, `mise/` or `.config/mise/`.
5. Open a space with `space.new {folder, machine}` and no name, so it takes its name from the checkout folder.

When step 3 or 4 fails, or skips a path, the space still opens, and one notification names each path and the reason.

The Open workspace dialog lists the repository's workspaces from `jj --ignore-working-copy workspace list` with their folders, filtered as you type, marks those already open in a space, and selects that space or opens a new one. A workspace created before jj 0.38 records no folder, and the list shows it as unavailable.

### Finish workspace

The space menu offers Finish workspace for a jj space with a terminal in a linked workspace.

The dialog lists every linked workspace in which a terminal of the space works, with its folder, in tab order. The workspace of the space's first terminal comes first when it is linked, and is checked. Otherwise the first linked workspace is checked. The others are unchecked. Under each checked workspace, a line names any other space with a terminal in that checkout, since those terminals end too. The text says "Ends the terminals working in the checked folders and deletes the folders. Edits jj tracks stay in the repository. Files jj does not track, including ignored files, are deleted." The key hints are `space check · ↵ finish · esc cancel`.

When it opens, the dialog runs `jj --ignore-working-copy workspace list` from the main checkout and records each listed workspace's name, matched by folder, the main checkout, the machine and the space's ID. Enter runs three steps on the checked workspaces.

1. Check. Run `jj --ignore-working-copy workspace list` from the main checkout and confirm each checked name still has its recorded folder. Then run `jj status` in each checked checkout, which snapshots it and fails on a stale workspace or a missing checkout. jj waits on a held lock without limit, so `jj status` is stopped after 10 seconds.
2. End terminals. Run `terminal.kill` for every terminal in `terminals()` whose folder is inside a checked checkout, which covers panes, parked terminals and workers. Wait up to 10 seconds for `terminals()` to stop listing them. When the recorded space has no terminals left, close it with `space.close {id, confirmed: true}`. Close any other pane still showing an ended terminal with `pane.close`.
3. Remove. Run `jj workspace remove <name>` from the main checkout for one checked workspace at a time, with the ten-minute timeout Herdr's worktree mod gives `git worktree remove`. The dialog marks each name as it is removed.

The first failure stops Finish and shows its message beside the workspace's name. Failures include jj's errors from the check, "Terminal <name> in <folder> did not stop." from step 2, and jj's error from step 3. Enter then starts again from step 1 with the names not yet removed. A name jj no longer lists stops step 1 with "jj no longer lists <name>. Its folder <folder> remains.", and Finish takes no further action on it. The dialog is a window overlay, so it stays open after its space closes.

In the native trial, Herdr closed each killed terminal's pane, and the space once it had no panes, about half a second after `terminal.kill` and before `terminals()` stopped listing the terminal. The `space.close` and `pane.close` calls in step 2 then find nothing to close, and cover a pane that stays. A held lock ended Finish with the timeout error from `exec` beside the workspace, and every space stayed open.

In a disposable repository, `jj workspace remove` on jj 0.47.1 snapshotted the checkout's edits into a commit, removed the colocated Git worktree, and deleted the checkout, including an ignored file, in 0.62 seconds. A symbolic link in the checkout pointing outside it was removed without touching its target. jj refuses to remove the main workspace.

### Settings

Settings are props on the `jj-spaces` block in whichever layout shows the sidebar, which is how Herdr's mods take their options. The New workspace dialog reads them from `layout()`, with its own defaults for any prop the block omits, so a layout without the block still works. Herdr applies edits to the layout file live.

```json
{
  "mod": "jj-spaces",
  "props": {
    "directory": "~/.herdr/worktrees/{repo}/{name}",
    "links": [],
    "miseTrust": true
  }
}
```

This repository's `jj-tui` layout uses these defaults. Installing copies it into `~/.config/herdr-app/layouts/`, replacing an edited copy. A personal layout kept elsewhere, such as in dotfiles and linked in, keeps its own settings, such as `links` for `AGENTS.local.md` and `mise.toml`.

### Stages

Stage 1 delivers `jj-spaces` with nesting and status lines, the New and Open workspace dialogs, the settings, and the menu entries. Stage 1 also removes this repository's `herdr-jj` Rust helper and its Workspaces manager dialog, so the repository holds only mods, layouts, scripts and tests.

Stage 2 delivers `jj-changes` and the Finish workspace dialog.

### Performance budget

| Work                                           | Budget | Measured basis           |
| ---------------------------------------------- | ------ | ------------------------ |
| One status line                                | 200 ms | 22 to 42 ms median       |
| Status lines of 20 workspaces after one jj run | 1 s    | 363 to 839 ms median     |
| Changes panel snapshot and read, 100,000 files | 400 ms | 219 ms median            |
| Stack read, 100 changes                        | 400 ms | 83 ms median             |

`just bench` measures every row with the user's jj config followed by `tests/jj-test.toml` and writes `.tmp/bench.json`. It uses 3, 10,000 and 100,000 file fixtures with `trunk()` at their bookmark and three edited files in `@`, a 20-workspace repository, and a stack of 100 one-line changes. The ranges cover separate runs. The stack's line totals read every file each change touches, so a change of 10,000 added files adds about 5 seconds to each stack read while it is in the stack. The read after an agent turn snapshots first and measured 253 to 257 ms at every size, most of it jj's Watchman query.

## Alternatives Considered

### A Rust helper binary for repository work

- Pros. Removal code with identity, mount and sparse-checkout checks, approval tokens and Rust tests already exists. A helper could keep one bounded log file for every read.
- Cons. Herdr's mods ship no binaries, so users would install one beside the mods. Every read pays about 5 ms more for the helper's start-up. `jj workspace remove` already snapshots, removes the colocated Git worktree and deletes the checkout without following links out of it.
- Reason for rejection. Rejected by author. The mods can do all of the work through `exec`, and a general-purpose mod set should install as mods alone. Finish relies on jj's own checks and stops at jj's first error.

### Git reads for the files changed in a jj checkout

- Pros. Herdr's Changes panel already works this way, and Git counts new files.
- Cons. Git and jj disagree on a merge `@`, intent-to-add deletions, files jj has not yet snapshotted, a root parent and files above jj's new-file size limit. Fast Git reads need `git update-index --refresh` first, because jj leaves Git's file timestamps zeroed. Repositories with no Git have no data.
- Reason for rejection. Rejected by author after measurement. The panel would count differently from `jj log`. Git reads remain only in Git-only repositories, through the shipped panel's code.

### A diff inside the panel

- Pros. The shipped Changes and Files panels draw diffs and previews in the panel, and a click shows a diff with no new tab.
- Cons. The panel is a sidebar column, so long lines and side-by-side views do not fit. Mods write files only under `~/.config/herdr-app`, so comments would need their own storage and an editor would need shell writes. Each diff needs a cap to keep the panel responsive.
- Reason for rejection. Rejected by author after trying it. A terminal tab running Hunk gets the main area, comments and Hunk's own navigation for no new code beyond `tab.new`.

### Pinning every read to one operation ID

- Pros. All reads in one refresh agree.
- Cons. Each refresh needs an extra step to find the current operation's ID and pass it to every read.
- Reason for rejection. Rejected by author. Each read sees one operation, reads by commit ID always agree, and a later refresh corrects a race between reads.

### Status lines that never snapshot

- Pros. The sidebar never writes to a repository.
- Cons. Agents edit files with their own tools, so a status line would show the last snapshot, often `∅`, while an agent works.
- Reason for rejection. Rejected by author. One snapshot when an agent's turn ends keeps the status line true for the main use, and records nothing when nothing changed.

### A panel that snapshots on file events

- Pros. An editor's save would show within a second.
- Cons. On macOS file watches report ignored folders, so a build writing to `target/` would start a snapshot every 300 ms for the length of the build, each holding jj's working-copy lock. The panel would need a second loop and a recursive watch.
- Reason for rejection. Rejected by author. Snapshots on show, on Refresh and at agent turns cover the common cases with one loop.

### Reusing the shell prompt's status

- Pros. `jj-starship` and a shell alias for the diff already compute similar text, and starship takes 14 to 16 ms.
- Cons. `jj-starship` counts no files or lines and writes a "reconcile divergent operations" operation when operations diverge. The alias computes the diff up to six times, 450 ms on 1,000 changed files against 106 ms for one pass.
- Reason for rejection. Rejected by author. One `jj log` call with a single `diff.stat()` gives the same content at lower cost.

### Linking jj's library or running a resident service

- Pros. It avoids jj's start-up for each read.
- Cons. Start-up is about 16 ms of the 33 ms a status read takes. The library ties the code to jj's storage formats, and a service adds a process to install and keep running.
- Reason for rejection. Rejected by author. The measured cost of one `jj` process per read fits within the 200 ms budget.

### Herdr's Spaces sidebar and Changes panel unchanged

- Pros. Nothing to maintain.
- Cons. Every jj space shows `(detached)` as its branch, and repositories without Git do not nest. The Changes panel reads Git, misses the jj stack, and costs 5.9 seconds per refresh in a new 10,000-file jj workspace.
- Reason for rejection. Rejected by author. Copies keep Herdr's look and change only the jj parts. The copy of the Changes panel keeps its Git code for Git-only repositories.

### Repository identity shared between mods

- Pros. Only the sidebar would ask jj, and the menus and panel would read its answers from `setShared`.
- Cons. Shared values persist in `shared.json` across restarts, every write redraws every mod, and a folder the sidebar has not probed falls through to Git code. Every mod would need the sidebar in its layout.
- Reason for rejection. Rejected by author. Each mod asks jj when it needs to, for about 20 ms per new folder, and keeps the answer in memory.

### One refresh module shared by the mods

- Pros. The single-flight, pending and generation rules would be written once.
- Cons. Herdr's mods import only from their own folder, so sharing needs a build step that copies the module. The two loops refresh different things on different events.
- Reason for rejection. Rejected by author. Each mod keeps its own loop, as Herdr's `spaces` and `changes` mods do.

### A configurable status format

- Pros. Users could reorder the parts or add the repository and workspace names.
- Cons. No journey needs another format, and the row already shows the space's name. A template engine adds a parser and its tests.
- Reason for rejection. Rejected by author. The status line has one fixed format.

### Status lines on their own row

- Pros. A long status would never crowd the space's name.
- Cons. Every nested space would take two rows, and Herdr's sidebar shows a branch on the name's row.
- Reason for rejection. Rejected by author. The status line takes the branch's place on the same row.

### Drawing nesting without moving spaces

- Pros. The sidebar would leave Herdr's space order alone.
- Cons. Switching between spaces follows the real order, so the display and the switching order would disagree.
- Reason for rejection. Rejected by author. The copy moves spaces with `space.move`.

### Removing the checkout on ordinary Close

- Pros. One action fewer.
- Cons. Close stops being safe to use without thinking.
- Reason for rejection. Rejected by author. Close stays non-destructive, and Finish is a separate menu entry.

### Preserving `.tmp/` and `.local/` at Finish

- Pros. Notes in `.local/` would survive, copied into the main checkout through a verified staging folder, with a dated name on collision.
- Cons. Finish would have six stages and a partial-failure report. It would treat two project conventions as built in, which a general-purpose mod set should not.
- Reason for rejection. Rejected by author. Finish keeps to three steps with no project-specific paths, following Herdr's Remove worktree. Untracked files are deleted, and the dialog says so.

### Finish for the space's own workspace only

- Pros. No checklist, and one removal per Finish.
- Cons. A space with tabs in two workspaces would need one Finish per workspace, and the second would have to find the space's remaining terminals again.
- Reason for rejection. Rejected by author. The checklist opens with the space's own workspace checked, so the common case is one Enter and the others are explicit choices. Removing one name at a time keeps each failure to one workspace.

### Finish refusing spaces shared with other checkouts

- Pros. Finish would never end a terminal outside the checkout it removes, and the dialog would need no list.
- Cons. A space with tabs in two workspaces, or a checkout also open in another space, could not be finished at all.
- Reason for rejection. Rejected by author. The dialog names every space whose terminals end.

### Settings in their own file, in code constants, or in shared state

- Pros. A file such as `~/.config/herdr-app/jj.json` survives reinstalls and serves every layout. Constants follow Herdr's worktree location. Shared state could have a settings dialog.
- Cons. No shipped Herdr mod reads its own settings file. Constants mean editing code. Shared state lives in `shared.json`, which Herdr writes, and needs a dialog to edit.
- Reason for rejection. Rejected by author. Props on the `jj-spaces` layout block are Herdr's convention for mod options.

### Starting every workspace from `trunk()`

- Pros. Every new checkout starts from the same place.
- Cons. Herdr's New worktree starts from the current checkout, and `jj workspace add` starts from the current checkout's parent by default.
- Reason for rejection. Rejected by author. A name that matches a local bookmark starts on it, and any other name uses jj's default.

### Leaving `mise` trust to the user

- Pros. New workspace runs no extra commands and trusts nothing on your behalf.
- Cons. Every new checkout with linked `mise` files prompts for trust before its tools work.
- Reason for rejection. Rejected by author. Trust is a setting, on by default, that runs only when `mise` is installed and covers only the linked files.

### Hourly refresh and a ten-second cache

- Pros. Fewer missed updates and fewer repeated reads.
- Cons. A timer runs while nothing changes, and a cache shows old data.
- Reason for rejection. Rejected by author. Operation watches and agent turns start refreshes, and each loop's pending flag guarantees a final refresh after the last change.

## Non-Functional Requirements

- Performance. The Performance budget table sets the limits, and `just bench` checks them. In jj checkouts, no mod starts a jj process while its view is hidden, and no timer runs where `watchFolder` works. Git-only repositories and the shipped sidebar's machine list keep Herdr's own timers.
- Safety. Only Finish deletes anything, and only after its check step passes. Nothing runs `jj workspace update-stale`, overwrites an existing path when linking, or runs commit, push or merge in a jj checkout. Git-only folders keep the shipped Changes panel's commit action. Ordinary Close and `space.close` from Herdr's own menus stay non-destructive.
- Command safety. Every command runs through `exec` with an argument list, so workspace names, folders and revsets never pass through a shell. File paths reach `jj diff` and Hunk as `root-file:` patterns after `--`, and diff tabs run their program from an argument list with `tab.new`.
- Errors. Every mod writes each failure with `console.log` and shows it where the action happened.
- Rollout and rollback. Installing copies the mods into `~/.config/herdr-app/mods/` and the layout into `~/.config/herdr-app/layouts/`. Switching back with `herdr-app do layout.switch '{"name":"main"}'`, or to any other layout, stops every jj mod, and deleting the `jj-*` mod folders uninstalls them. Existing checkouts and workspaces stay as they are. Stage 1 retires the `herdr-jj` command, so scripts that call it stop working.

## Risks and Limits

- Caps. The status line looks back 64 changes for a bookmark, the stack shows 100 changes, and `exec` returns at most 8 MiB. Each cap shows as a visible note or an empty bookmark, never as wrong numbers.
- Trust. A linked `mise` file runs commands when trusted. Only files linked from the main checkout are trusted, and the setting turns trust off.
- Links. Linked files point into the main checkout, so edits through a link change the main checkout's copy. Finish removes the link and leaves its target alone.
- Terminals that ignore an end request. Finish stops with the terminal's name after 10 seconds and deletes nothing.
- Untested platforms. Remote machines and Linux have no verification. On Linux, `watchFolder` skips Git-ignored folders, which changes no behavior here since no mod watches the checkout.

## Additional Resources

- Herdr's mod guide and interface types, `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`, in the local Herdr installation.
- Herdr's shipped `spaces`, `changes`, `worktree`, `menu`, `new-menu` and `tabs` mods in `~/.config/herdr-app/mods/`, which the project mods copy.
- jj's template language, `jj help -k templates`, and workspace commands, `jj workspace --help`.
- [mise](https://mise.jdx.dev/) and its [trust command](https://mise.jdx.dev/cli/trust.html).

## Future Improvements

- History actions in the changes panel, such as describe, squash and abandon.
- An interdiff between two versions of one change.
- Verified support for remote machines and Linux.
- A status line for spaces that work in several repositories.
- An explicit Update stale workspace action.

## Detailed Implementation Plan

The plan lands in two stages. Each stage ends with `just verify` and `just bench` passing.

Fresh copies come from the shipped mods with `mod.clone`, run against the isolated app that `scripts/app-trial.js` starts, never the personal one.

```sh
HERDR_APP_HOME=<trial home> herdr-app do mod.clone '{"name":"spaces","as":"jj-spaces"}'
```

The copy's folder then replaces the repository's mod folder of the same name, and the jj changes are applied on top, so each mod's diff against its original stays reviewable.

### Stage 1

#### 1. `Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `src/main.rs`, `src/mounts.rs`, `tests/workspaces.rs` (Delete)

- Type. Rust helper and its tests.
- Change. Remove the `herdr-jj` helper. The mods replace every command it offered.

#### 2. `mods/jj-agents/main.js`, `mods/jj-agents/mod.json` (Delete)

- Type. Mod.
- Change. Remove the copy of the personal `tui-agents` mod. The layout mounts Herdr's own `agents`.

#### 3. `design/workspace-management.md` (Delete)

- Type. Design document.
- Change. Remove the helper's architecture. This document replaces it.

#### 4. `mods/jj-spaces/main.js`, `mods/jj-spaces/mod.json` (Replace)

- Type. Mod, fresh copy of `spaces`.
- Change. Probe every terminal's folder with `identity()` from its own `jj.js`, once per folder, keyed by `JSON.stringify([machine, folder])` as the shipped sidebar keys its cache. Use the shipped Git check only for folders `identity()` reports as not jj.
- Change. Nest spaces by `repo`, with the main checkout's space as parent, through the shipped `space.move` ordering.
- Change. Replace `gitTail()` for spaces whose active tab is in a jj checkout by the status elements, after the repository's name as `gitTail()` places it, drawn on the same row, with the bookmark in `dim`, the file count bold in `working`, `+N` in `ansi2`, `-N` in `ansi1`, and a dim `stale`, `divergent` or `error` word with jj's message as a tooltip.
- Change. Keep one `watchFolder(<repo>/op_heads/heads)` per local repository while visible. A batch marks that repository's spaces pending with `snapshot: false`. The shipped busy-to-idle edge in `due()` marks only its own space pending with `snapshot: true`, without the shipped `sameRepo` spread. A folder change marks its space pending with `snapshot: false`.
- Change. One refresh loop runs pending reads one at a time, `snapshot: true` first, with `{running, pending, generation}` per space. It starts nothing while the sidebar is hidden or narrow by the Refresh rules. A rejected watch, and every remote repository, switch to a 30-second interval while visible.
- Change. Right-click on a space row opens `jj-menu`. The shipped copy opens `menu`, which `mod.clone` leaves unchanged.

#### 5. `mods/jj-spaces/jj.js` (Create)

- Type. Module imported by `main.js`. Every function takes `exec` and `readTextFile` as arguments, so Node tests and the benchmark pass real ones. This file holds the source of `identity()`, `joinPath()` and `visible()`. Herdr mods import only from their own folder, so `jj-workspace`, `jj-menu`, `jj-new-menu` and, in Stage 2, `jj-changes` each keep a `jj.js` with identical copies, and `scripts/check-mods.js` fails when a copy differs.
- Change. `identity(folder, on, io)` runs `jj --ignore-working-copy workspace root` in `folder`. jj's "There is no jj repo" returns `{jj: false, final: true}`, which the mod keeps. An `exec` rejection for a missing `jj` returns `{jj: false}`, which the mod asks again on the next change to the folder. Any other failure returns `{error, message}`. It then reads `<root>/.jj/repo` with `readTextFile`, treating rejection as absent. Text means a linked workspace, and `repo` is that text, trimmed, joined to `<root>/.jj/` and normalized. Otherwise, when `<root>/.jj/repo/store/type` reads as text, `repo` is `<root>/.jj/repo`. `main` is the folder two levels above `repo`. Returns `{jj: true, root, repo, main, linked: root !== main}`. A small pure `joinPath()` normalizes `.` and `..`.
- Change. `STATUS_TEMPLATE` is the following, one JSON line per change.

```text
if(current_working_copy,
  json({"commit" => commit_id, "at" => true,
        "bookmarks" => local_bookmarks.map(|b| b.name()),
        "empty" => empty, "files" => diff.stat().files().len(),
        "added" => diff.stat().total_added(), "removed" => diff.stat().total_removed()}),
  json({"commit" => commit_id, "at" => false,
        "bookmarks" => local_bookmarks.map(|b| b.name())})) ++ "\n"
```

- Change. `readStatus(root, on, snapshot, io)` runs `jj [--ignore-working-copy] log --no-graph --limit 64 -r '@ | heads(::@ & bookmarks())::@' -T STATUS_TEMPLATE` in `root` with a ten-second timeout. It returns `{bookmark, distance, empty, files, added, removed}`, where `bookmark` is the first name on the first line, in output order, that has one, and `distance` is that line's index. Errors return `{error: "stale" | "divergent" | "error", message}`, matched on jj's "stale" and "resolved to more than one operation" messages.

#### 6. `mods/jj-workspace/main.js`, `mods/jj-workspace/mod.json`, `mods/jj-workspace/jj.js` (Replace)

- Type. Mod, fresh copy of `worktree`.
- Change. Accept `props.action` of `new`, `open` and, in Stage 2, `finish`, with `props.space` and `props.folder`, the folder the menu was opened for. Run `identity()` from its own `jj.js` on `props.folder`, and read the settings from the `jj-spaces` block in `layout()` over its own `DEFAULTS`, `{directory: "~/.herdr/worktrees/{repo}/{name}", links: [], miseTrust: true}`.
- `new`. Keep the shipped dialog's input, key hints and spinner, and the shipped `slug()`. On open, load `jj --ignore-working-copy bookmark list -T 'if(!remote && present, name ++ "\n")'` into a set. The info line shows the filled directory and either "starts on bookmark <name>" or "starts from this checkout's parent". Enter runs, in `root`, `mkdir -p <parent of directory>` and then `jj workspace add --name <name> [-r <name>] <directory>`. For each link it runs `test -e <main>/<path>`, skips the link when `test -e` or `test -L` on `<directory>/<path>` succeeds, then runs `mkdir -p <parent>` and `ln -s <main>/<path> <directory>/<path>`. When `miseTrust` is on it runs `mise --version`, then `mise trust <file>` for each linked file matching the rule in the New workspace section. Last it runs `space.new {folder: directory, machine}`. Skipped and failed paths go to one `notify({title: "New workspace", body, level: "warning"})` call.
- `open`. Lists `jj --ignore-working-copy workspace list -T 'json({"name" => name, "root" => root}) ++ "\n"'` with the shipped filtered list, marking a workspace open when a terminal's folder sits inside its root. Enter selects that space or runs `space.new {folder, machine}`. A workspace with an empty root is listed as unavailable.
- Change. Errors from any command show in the dialog in `blocked` and go to `console.log`.

#### 7. `mods/jj-menu/main.js`, `mods/jj-menu/mod.json`, `mods/jj-menu/jj.js` (Replace)

- Type. Mod, fresh copy of `menu`.
- Change. In `items()`, run `identity()` from its own `jj.js` on the space's first terminal folder. A jj space gets New workspace and Open workspace, opening `jj-workspace` with `{space, folder, action}` at the shipped sizes. Any other space keeps the shipped `checkout()` probe and worktree entries.

#### 8. `mods/jj-new-menu/main.js`, `mods/jj-new-menu/mod.json`, `mods/jj-new-menu/jj.js` (Replace)

- Type. Mod, fresh copy of `new-menu`.
- Change. Run `identity()` from its own `jj.js` on the focused pane's folder. For jj, the rows read `New workspace…` and `Open workspace…` and open `jj-workspace` with `{space, folder, action}`. Otherwise they keep the shipped `New worktree…` and `Open worktree…`, opening Herdr's `worktree`.

#### 9. `mods/jj-tabs/main.js` (Modify)

- Type. Mod, existing copy of `tabs`.
- Change. Keep the + and right-click overlays on `jj-new-menu` and `jj-menu` and the panel list `["files"]`. Confirm the copy matches the current shipped `tabs` apart from these three lines.

#### 10. `layouts/jj-tui.json` (Modify)

- Type. Layout.
- Change. Mount `agents` in place of `jj-agents`. Give the `jj-spaces` block the default props from the Settings section.

#### 11. `tests/mod-harness.js` (Modify)

- Type. Test harness.
- Change. Load a mod's own `./jj.js` into its sandbox in place of stripping the import.
- Change. Add fakes for `exec` (scripted results by command and arguments, recording each call), `readTextFile`, `watchFolder` (a controllable promise), `terminals()`, `layout()` with block props, `hidden` and stack `active`, `notify`, `run`, `Scrollbar`, and `InputState` with its `change` and `submit` callbacks, so tests can assert every command a mod runs. Stage 2 adds `v_virtual_list` and `Checkbox`.

#### 12. `tests/mods.test.js` (Replace)

- Type. Mod behavior tests with the harness.
- Cases. `jj-spaces` nests linked workspaces under the main checkout, renders each status example from the Status lines section, renders `stale`, `divergent` and `error` with tooltips, and shows no status line for a space with terminals in two repositories. A folder whose probe is pending runs no Git command. A probe failure other than "no jj repo" shows `error`. An `op_heads` batch runs one `--ignore-working-copy` read per space of that repository, in series. A busy-to-idle edge runs one read without `--ignore-working-copy` for its own space only. A request during a run produces exactly one more run. A hidden or narrow sidebar runs nothing. Right-clicking a space row opens `jj-menu`.
- Cases. New workspace runs the commands of item 6 in order, adds `-r` only for a local bookmark, names an existing link path in one notification, runs no `mise` when `mise --version` fails or `miseTrust` is off, and keeps jj's error in the dialog when `workspace add` fails. Open lists, filters, marks open workspaces and lists an empty root as unavailable.
- Cases. The menus offer jj entries for jj folders and the shipped worktree entries otherwise. The layout mounts no `changes` and no `jj-agents`.

#### 13. `tests/jj.test.js` (Create)

- Type. Tests against real jj in disposable `/tmp` repositories, removed afterwards.
- Cases. `identity()` for a main checkout, a linked workspace, a plain folder and a missing `jj`. `readStatus()` for an empty `@`, edits in `@`, a bookmark at distance 0 and 3, no bookmark and a merge with two bookmarked heads. `readStatus(snapshot: false)` records no operation. `errorWord()` maps jj's stale and divergent messages. jj 0.47.1 updates a workspace rewritten from another workspace without reporting it stale, so no fixture produces a stale error.

#### 14. `scripts/bench.js` (Replace)

- Type. Benchmark.
- Change. Measure `readStatus()` at 3, 10,000 and 100,000 files, and an `op_heads` refresh across 20 workspaces, against the Performance budget. Write results to `.tmp/bench.json`.

#### 15. `scripts/app-trial.js` (Replace)

- Type. Native trial in an isolated app home, a separate core session and a disposable repository.
- Change. Install the mods and layout, then cover CUJs 1 and 2. Create a workspace through `jj-workspace`, and record the space's nesting, the status text before and after an edit with a finished command, and the Open list. Screenshots go to `.tmp/`.

#### 16. `Justfile`, `scripts/check-mods.js` (Modify)

- Type. Task configuration.
- Change. Remove `build` and the Cargo steps. `test` runs `node --test tests/*.test.js`. `verify` runs `test`, `check-mods` and `node --check` on every script and mod file. `bench` runs `node scripts/bench.js`. Add `install`, copying `mods/jj-*` and `layouts/jj-tui.*` into `${HERDR_APP_HOME:-~/.config/herdr-app}`.
- Change. `scripts/check-mods.js` also fails when the `identity()`, `joinPath()` and `visible()` source in any mod's `jj.js` differs from `mods/jj-spaces/jj.js`.

#### 17. `.tool-versions`, `.envrc`, `.gitignore` (Modify)

- Type. Tool configuration.
- Change. Remove `rust`, the `PATH_add target/debug` line and the `target/` entry.

#### 18. `AGENTS.md` (Modify)

- Type. Contributor rules.
- Change. Replace the Goals with "Provide jj workspaces in Herdr as general-purpose mods with low idle cost and explicit control over destructive actions. Use jj's workspace, change, bookmark and conflict concepts throughout. Give each workspace its own space, nested under its main checkout's space. Keep ordinary Close non-destructive. Finish deletes only the checkouts you check, and names every terminal it ends before you confirm."
- Change. Replace the Rust helper rule with "Keep the work in Herdr mods in JavaScript. Node is a development and test dependency." Point the design link at `design/jj-workspace-lifecycle.md`.

#### 19. `README.md` (Replace)

- Type. Usage documentation.
- Change. Sections Install, Settings (the three props and their defaults), New and Open workspace, Status lines, Remove a workspace (`jj workspace remove` until Stage 2), Develop and verify, and Limits (remote machines, Linux).

### Stage 2

#### 20. `mods/jj-changes/main.js`, `mods/jj-changes/mod.json` (Create)

- Type. Mod, fresh copy of `changes`.
- Change. On init and on each folder change, run `identity()` from its own `jj.js` on the shipped `location()` folder. Until it answers, render nothing and start nothing. For `{jj: false}`, run the shipped Git code. For an error, show it in the header.
- Change. For jj, keep one refresh loop with `{running, pending, generation}`. Becoming visible and Refresh run `jj util snapshot` with a ten-second timeout, then `readStack()`. A `watchFolder(<repo>/op_heads/heads)` batch runs `readStack()` alone while the panel is visible and nothing while it is hidden. The shipped ten-second timer and Git watch never start for jj.
- Change. Render the header, stack and file list described in the Changes panel section with the shipped virtual list and diff rows, mapping `status` to the shipped row's `status`, `added` to `add` and `removed` to `del`. Click replaces the selection, and Shift-click adds a second commit ID. A refresh drops a selected ID that is no longer in the stack and shows "Selected change was rewritten".
- Change. Clicking a file, or Open diff, opens a `tab.new` tab in the checkout running `hunk show` or `hunk diff` when `hunk --version` succeeds on its machine, else `jj --config 'ui.pager=less -R' diff`, as the Changes panel section describes. The panel draws no diff.

#### 21. `mods/jj-changes/jj.js` (Create)

- Type. Module imported by `main.js`, with the shared section copied from `mods/jj-spaces/jj.js` and the same `exec` and `readTextFile` arguments.
- Change. `CHANGE_TEMPLATE` is the following, one JSON line per change. `files` is a list of JSON strings, each parsed again.

```text
json({"commit" => commit_id, "change" => change_id.short(),
      "description" => description.first_line(), "empty" => empty,
      "conflict" => conflict, "at" => current_working_copy,
      "added" => diff.stat().total_added(), "removed" => diff.stat().total_removed(),
      "files" => diff.stat().files().map(|f| json({"path" => f.path(),
        "status" => f.status_char(), "added" => f.lines_added(),
        "removed" => f.lines_removed()}))}) ++ "\n"
```

- Change. `STACK_TEMPLATE` is `if(current_working_copy, <CHANGE_TEMPLATE without ++ "\n">, <the same map without "files">) ++ "\n"`, so only `@` computes its file list.
- Change. `readStack(root, on, io)` runs `jj --ignore-working-copy log --no-graph --limit 100 -r '@ | (trunk().. & first_ancestors(@))' -T STACK_TEMPLATE`.
- Change. `readChange(root, on, commit, io)` runs `jj --ignore-working-copy log --no-graph -r <commit> -T CHANGE_TEMPLATE` and returns its files.
- Change. `readPair(root, on, from, to, io)` runs `jj --ignore-working-copy diff --from <from> --to <to> -T 'json({"path" => path, "status" => status_char}) ++ "\n"'`.
- Change. `snapshot(root, on, io)` runs `jj util snapshot` with a ten-second timeout.
- Change. `filePattern(path)` returns `root-file:"<path>"` with backslashes and quotes escaped, a fileset naming one path from the checkout's root.

#### 22. `mods/jj-workspace/main.js` (Modify)

- Type. Mod.
- Change. Add `finish`. Run `identity()` on each of the space's terminal folders and list the linked workspaces in tab order, with the first terminal's workspace first and checked when linked, else the first one. For each checked one, list other spaces with a terminal in its root. The space bar toggles the focused row's `Checkbox`.
- Change. On open, run the `open` action's `workspace list` read in `main` and record each listed workspace's name, matched by root, and its root, `main`, the machine and the space's ID. Enter runs the Finish section's steps on the checked names not yet removed. Step 2 runs `terminal.kill {terminal}` for each terminal in `terminals()` inside a checked root, waits up to 10,000 ms for them to leave `terminals()`, then runs `space.close {id, confirmed: true}` when the recorded space has no terminals and `pane.close {pane}` for any remaining pane showing an ended terminal. Step 3 runs `jj workspace remove <name>` in `main`, one name at a time, with a 600,000 ms timeout, and marks each name removed.
- Change. The first failure stops the run and shows its message beside the name.

#### 23. `mods/jj-menu/main.js`, `mods/jj-tabs/main.js`, `layouts/jj-tui.json` (Modify)

- Type. Mods and layout.
- Change. `jj-menu` adds Finish workspace for spaces with a terminal in a linked workspace. `jj-tabs` restores the panel list `["files", "changes"]`. The layout adds a `changes` entry to `panel-body` mounting `jj-changes`.

#### 24. `tests/mods.test.js` (Modify)

- Type. Mod behavior tests.
- Cases. The panel renders nothing while its probe is pending, runs the shipped Git code for a Git-only folder (CUJ 7), snapshots then reads on show and Refresh, reads without a snapshot on `op_heads` batches, starts nothing when hidden, replaces the selection on click and adds on Shift-click, clears a rewritten selection, opens a file's or a pair's diff in Hunk in a new tab, asks once whether Hunk runs, and opens `jj diff` in `less -R` without Hunk.
- Cases. Finish checks the first terminal's workspace first, stops before ending anything when `jj status` fails, kills every terminal in a checked root including one with no pane, stops when a terminal stays listed past 10 seconds, closes the space when it has no terminals left, closes only the panes in checked roots otherwise, removes one name at a time, and on Enter after a failure retries only the names not yet removed.

#### 25. `tests/jj.test.js` (Modify)

- Type. Tests against real jj.
- Cases. `readStack()` for `@` on `trunk()`, a 4-change stack and the 100-change cap. `readChange()` and `readPair()` for added, modified and deleted files, and a file whose path has spaces and parentheses, which `filePattern()` selects alone in `jj diff`. `jj workspace remove` for two workspaces in turn, the second failing on a held lock.

#### 26. `scripts/bench.js` (Modify)

- Type. Benchmark.
- Change. Add the panel snapshot and read at 3, 10,000 and 100,000 files, and the 100-change stack read.

#### 27. `scripts/app-trial.js` (Modify)

- Type. Native trial.
- Change. Cover CUJs 3, 4, 5 and 6. Open the panel and select a pair through a `trial-changes` subclass that the trial's layout copy mounts, and record what the panel shows after an outside `jj describe`. Open one file's diff of the pair and record the new tab's name and screen. Seed `frame.welcomed` so the first-run welcome stays closed. Finish a single-workspace space and record that it closes and `jj log` keeps the change. Finish one workspace of a two-workspace space and record which tabs remain. Hold jj's lock during Finish and record the error, the open spaces and the retry. Record that the dialog stays open after its space closes and whether a pane closes when its terminal is killed.

#### 28. `README.md` (Modify)

- Type. Usage documentation.
- Change. Add Changes panel and Finish workspace sections, with Finish workspace in place of Remove a workspace.

## Verification Plan

- Build. None. The mods run as source.
- Unit and behavior tests. `just test` runs `tests/mods.test.js` against the harness and `tests/jj.test.js` against real jj in `/tmp` repositories.
- Static checks. `just check-mods` runs `herdr-app check` on every mod in an isolated app home. `just verify` adds `node --check` on every script and mod file, and the check that every copy of the shared section matches.
- Coverage. Every command each mod runs appears in at least one test asserting its arguments. CUJs 1, 2, 4 and 7 have harness tests, and CUJs 3, 5 and 6 have harness tests and real-jj tests.
- Performance. `just bench` meets every row of the Performance budget.
- Native. `node scripts/app-trial.js` in an isolated app home and core session covers CUJs 1 and 2 in Stage 1, and CUJs 3, 4, 5 and 6 in Stage 2. Remote machines, Linux and visual review in the personal app remain unverified until run by hand.
