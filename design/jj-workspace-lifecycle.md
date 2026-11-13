# jj workspace lifecycle in Herdr

Author: Wendell Smith
Status: Draft
Date: 2026-11-13

---

## Overview

This design adds jj workspaces to Herdr as a general-purpose set of mods. One person can run several pieces of work in parallel in one jj repository, each in its own Herdr space, and see where each piece stands without leaving Herdr.

This document uses these terms.

- A jj workspace is a working directory that shares one repository's history with the others. The repository's first workspace is its main checkout, and every other one is a linked workspace. This document calls a workspace's directory its checkout.
- `@` is the jj change a checkout is editing, and `@-` is its parent.
- A snapshot is jj recording the checkout's files into `@`. jj snapshots at the start of most commands.
- An operation is one entry in the repository's operation log, which jj writes after every command that changes the repository, including a snapshot that finds edits. All workspaces of a repository share one operation log. Divergent operations are two operations written concurrently, which the next ordinary jj command merges.
- A workspace is stale when another workspace's command rewrote its `@`. jj then refuses to snapshot it until `jj workspace update-stale` runs.
- A bookmark is jj's name for a branch. `trunk()` is jj's revset for the repository's main bookmark, such as `master`.
- A Herdr space is a named group of tabs in the Herdr app, listed in the sidebar.
- A status line is the short text after a space's name in the sidebar's Spaces list, where Herdr shows a Git branch.

The work covers three moments.

1. Starting. You choose New workspace from a space's menu or the + menu and type a name. A space opens on a new linked workspace, nested under the main checkout's space.
2. Returning. Each space's status line shows its checkout's state with content similar to your shell prompt, such as `master~4 ~3 +120 -8`. A changes panel, opened from the tab bar, shows the stack of changes since `trunk()`, the files each change touches, file diffs and a comparison between two changes.
3. Finishing. Finish workspace, in the space's menu, closes the terminals working in the checkout and removes the workspace. Its edits stay in the repository.

The design follows Herdr's own support for Git worktrees. Herdr's space menu and + menu offer New, Open and Remove worktree in a dialog, its sidebar nests worktree spaces under their repository's space and shows each one's branch, and its Changes panel opens from the tab bar. This design offers the jj equivalents in the same places, and each mod starts as a copy of the Herdr mod it follows.

The work ships in two stages. Stage 1 adds the nesting sidebar, status lines, and the New and Open workspace dialogs, which delete nothing. Stage 2 adds the changes panel and Finish.

## The Problem

Parallel work in jj needs a checkout per piece of work, a terminal in each, and a way to see what each one holds and where it stands.

- Starting a checkout takes `jj workspace add` with a path and revision, links to local files the repository ignores, often `mise trust`, and a new Herdr space and tab in the right folder.
- Returning means switching to the checkout and running `jj log` and `jj diff` to remember what it holds. Herdr's sidebar shows Git branches, which a jj checkout lacks. Herdr's Changes panel reads Git, so it misses the jj stack. In a new 10,000-file jj workspace it also costs 5.9 seconds per refresh, every ten seconds, because jj leaves Git's file timestamps zeroed and the panel never lets Git correct them.
- Finishing means closing every terminal in the checkout, then removing the workspace and its directory.

The design gives each workspace its own space. A space's identity then answers "which checkout", its status line answers "what state is it in", and finishing it removes the checkout.

## Goals

- Start from a name. Typing a name and pressing Enter creates the workspace, checkout and nested space. The dialog says where the checkout goes and what it starts from. When the name or folder is taken, jj's error appears in the dialog.
- See each workspace's state at a glance. Each nested space's status line shows its nearest bookmark, the number of changes since it, and the files and lines changed in `@`, or `∅` when `@` has no changes. An agent's edits appear when its turn ends. The format is configurable.
- Inspect progress in jj terms. The changes panel shows the stack since `trunk()`, per-change line totals, the files a change touches, any file's diff and a diff between two changes. In jj repositories every number comes from jj and matches `jj log`.
- Stay quiet when unwatched. Nothing refreshes while hidden, and no timer runs where file watching works. Nothing runs `jj workspace update-stale`.
- Finish in one action. In the common case the Finish dialog opens with the space's own workspace checked, and Enter removes it. Before you confirm, the dialog says which folders it deletes, that edits jj tracks stay in the repository, and that files jj does not track are deleted.
- Work in any jj repository. Nothing assumes a project's files or tools. Linked files and `mise` trust are settings.
- Fit Herdr. Entry points sit where Herdr puts its worktree actions. Dialogs, menus, notifications, colors and controls are Herdr's own, so the UI follows light and dark themes.
- Explain failures. A failed action shows jj's error where it happened. The panel keeps the last good data visible beside the error, and Herdr's log records every error.

## Non-Goals

- Editing history. The panel offers no rebase, squash, describe, commit, bookmark, tag, operation log, undo or redo. You use jj for these.
- Interdiff and drag and drop.
- Automatic recovery from stale workspaces. They are reported, never updated.
- Publishing work. Nothing commits, pushes or merges automatically.
- Keeping untracked files at Finish. Files jj does not track, such as ignored `.local/` notes, are deleted with the checkout. You track them in jj or move them first.
- Moving existing checkouts. Checkouts outside Herdr's worktree location keep working where they are.
- Rearranging existing mixed spaces. Spaces you already use for several repositories keep their tabs.
- Editing Herdr's shipped mods. Each mod here is a project-owned copy.
- Streams integration, remote machines and Linux. The mods pass each space's machine to every command, as Herdr's worktree mod does, but remote machines and Linux remain untested.

## Open Questions

- Whether Herdr's `pane.close` closes a pane running an agent without asking. Finish depends on it when a space keeps terminals in other folders. Stage 2 verifies it in an isolated app before building on it.

## Critical User Journeys (CUJs)

### CUJ 1: Start a workspace

- Given the main checkout `herdr-jj-workspaces` is open in a space of the same name. Its `mise.toml` is trusted, and the layout lists `mise.toml` and `AGENTS.local.md` as linked files.
- When you choose New workspace from that space's menu and type `nesting`.
- Then the dialog says the checkout goes in `~/.herdr/worktrees/herdr-jj-workspaces/` and starts from the same parent as this checkout. After you press Enter, a space `nesting` opens below the main space, drawn as its child, with a terminal in the checkout. Both files are links to the main checkout's copies, and `mise` runs there without a trust prompt.

### CUJ 2: Glance at status

- Given three nested workspaces, one with an agent editing files.
- When the agent's turn ends.
- Then that space's status line changes, for example to `master~2 ~3 +40 -5`, within about a second. The other two status lines refresh once and keep their text. A space with no changes in `@` shows `∅`.

### CUJ 3: Inspect and compare

- Given a workspace whose stack has four changes since `trunk()`.
- When you open the changes panel.
- Then the panel lists the four changes with lines added and removed, and the files changed in `@`. Selecting a file shows its diff. Selecting two changes lists the files that differ between them and shows the diff from the older to the newer, labelled with both change IDs. Running `jj describe` in a terminal updates the panel. Hiding the panel stops all of its work.

### CUJ 4: Finish

- Given the `nesting` space holds two terminals, one of them an agent, both in the checkout. The checkout has an edited `src/lib.rs` and an ignored `build.log`.
- When you choose Finish workspace from the space's menu.
- Then the dialog lists `nesting`, checked, with its folder `~/.herdr/worktrees/herdr-jj-workspaces/nesting`. It says the space closes, that edits jj tracks stay in the repository, and that files jj does not track are deleted. After you press Enter, the space closes, jj snapshots the edit to `src/lib.rs` into the workspace's change, and the checkout and `build.log` are gone. `jj log` in the main checkout shows the change.

### CUJ 5: Finish a space that holds two workspaces

- Given a space `review` with one tab in workspace `review` and another in workspace `nesting`. Space `nesting` also has a terminal in that checkout.
- When you choose Finish workspace from `review`'s menu.
- Then the dialog lists `review` checked and `nesting` unchecked. Checking `nesting` adds a line saying its terminal in space `nesting` closes too. After you press Enter with only `review` checked, the tab in `review`'s checkout closes, the `nesting` tab stays open, and workspace `review` is removed.

### CUJ 6: Finish fails

- Given another process holds jj's lock on the repository for longer than Finish waits.
- When you press Enter in the Finish dialog.
- Then the dialog shows jj's error, and every space and terminal stays open. Pressing Enter again retries.

### CUJ 7: Git-only repository

- Given a space whose folder is a Git repository with no `.jj`.
- When you open the changes panel or the space's menu.
- Then both behave as Herdr's own do. The panel lists changed files and diffs from Git with no stack, and the menu offers Herdr's worktree entries. The sidebar nests linked Git worktrees and shows their branches.

## Trade-offs

- Status lines describe one repository. A space whose terminals work in several repositories, or in none, shows no status line.
- A snapshot at each agent turn. When an agent's turn or a foreground command ends, its space's status line reads with a snapshot, so the edits appear. A snapshot that finds edits records an operation, which refreshes the other status lines of that repository. A snapshot that finds none records nothing. Every other read leaves the checkout alone.
- Automatic `mise` trust. Trusting a `mise` file lets it run commands when you enter the directory. New workspace trusts only the `mise` files it links from the main checkout, and reports a trust failure in a notification. `mise` files that come from the start revision stay untrusted. Turning the setting off skips trust entirely.
- Reads that disagree for a moment. A jj command that lands between two reads can make them disagree until the next refresh. Each read is one jj call, so its own numbers agree.
- Divergent operations are shown, never merged. Reads use the current operation without merging divergence, and show `divergent` until the next ordinary jj command merges it.
- Finish deletes files jj does not track. Ignored build output, scratch files and notes are lost with the checkout, as untracked files are with Herdr's Remove worktree. The dialog says so before you confirm.
- Finish closes terminals in other spaces. A terminal in another space working in a checked checkout closes with it, since its folder disappears. The dialog names those spaces before you confirm.
- Command-line tools only. Every read starts a `jj` process, about 16 ms of start-up before any work. A long-running helper could avoid it but would be a binary to install and keep running, which Herdr's mods never need.

## Technical Plan (Architecture)

Project-owned JavaScript mods do all of the work. They read and change jj state by running `jj` as a command, as Herdr's worktree mod runs `git`.

These Herdr interfaces appear below. Herdr's mod guide, `~/.config/herdr-app/AGENTS.md`, defines them in full.

- `mod.clone` copies a shipped mod into a project-owned mod with a new name.
- `exec` runs a command on a space's machine and returns its exit code, output and errors. It caps output at 8 MiB.
- `watchFolder` reports file changes in a folder on this machine.
- `layout()` returns the current layout, including each mod block's props.
- `spaces()` and `panes()` list spaces and panes from memory, including each terminal pane's folder.
- `shared()` and `setShared()` read and write values every mod can see.
- `space.new`, `space.move`, `space.close` and `pane.close` open, reorder and close spaces and panes.

```text
 Herdr app (jj-tui layout)                                  command-line tools
 ─────────────────────────                                  ──────────────────
 jj-spaces   (copy of spaces)
   identity of each new folder     ── once per folder ───▶  jj workspace root, read .jj/repo
   status line after an operation  ── one call ──────────▶  jj --at-op=@ log
   status line after an agent turn ── one call ──────────▶  jj log   (snapshots first)
 jj-changes  (copy of changes)
   on file events                  ── one call ──────────▶  jj util snapshot
   on show and operations          ── one or two calls ──▶  jj --at-op=@ log
   on selection                    ── one or two calls ──▶  jj --at-op=@ log / diff
 jj-workspace (copy of worktree)
   New workspace                   ──────────────────────▶  jj workspace add, ln -s, mise trust
   Open workspace                  ──────────────────────▶  jj --at-op=@ workspace list
   Finish workspace                ── check, close, ─────▶  jj status, jj workspace remove
```

### Mods and their Herdr originals

Each mod starts as a `mod.clone` of the shipped mod it replaces, so it keeps Herdr's spacing, fonts, theme colors and keyboard behavior. The copy changes only its data source and the jj-specific parts.

| Project mod              | Copied from        | What changes                                                                                                                                                     |
| ------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jj-spaces`              | `spaces`           | Repository identity comes from jj, with the shipped Git check as fallback, and is published for the other mods. jj spaces show a status line in place of a branch. |
| `jj-changes`             | `changes`          | jj repositories get the stack, two-change selection and jj data, with no timer and no commit bar. Git-only repositories keep the shipped Git behavior unchanged. |
| `jj-workspace`           | `worktree`         | New, Open and Finish workspace dialogs for jj spaces, with the worktree dialog's layout, input, filtered list, key hints and busy spinner.                      |
| `jj-menu`, `jj-new-menu` | `menu`, `new-menu` | jj spaces get New, Open and Finish workspace where Herdr shows its worktree entries. Git spaces get Herdr's worktree entries, which open Herdr's `worktree` mod. |
| `jj-tabs`                | `tabs`             | The + button and a tab's right-click open the jj menus. The Changes button stays hidden until Stage 2.                                                           |

The `jj-tui` layout mounts Herdr's own `agents` mod in the sidebar. It puts `jj-changes` in the right panel stack's `changes` entry, which the tab bar's Changes button opens. The shipped `changes` mod is never mounted, so its Git poller never runs in jj repositories.

Colors come from Herdr's theme. Status text and secondary labels use `dim` and `muted`. Lines added use `ansi2` and lines removed use `ansi1`, the colors the shipped sidebar uses for commits ahead and behind and the shipped Changes panel uses for diff lines. Errors use `blocked`. Controls use the component library's lists, `Scrollbar`, `Input`, `Checkbox` and `Button`.

Every command passes the space's machine to `exec`. `watchFolder` works only on this machine, so a remote space's status line refreshes on agent turns, folder changes and a 30-second interval while visible.

### Reading jj state

Every read is one jj call. Reads that need no snapshot pass `--at-op=@`, which reads the current operation without snapshotting and without merging divergent operations. Two reads snapshot, the status line's read after an agent turn and the changes panel's `jj util snapshot` after file events. A jj error saying the workspace is stale shows as `stale`, and divergent operations show as `divergent`.

### Repository identity and nesting

The shipped sidebar asks Git once per new folder which repository it belongs to, then nests linked worktrees under the main checkout's space. `jj-spaces` asks jj first. `jj --ignore-working-copy workspace root` gives the checkout's root. In the main checkout `<root>/.jj/repo` is a folder, and in a linked workspace it is a file holding the main checkout's `.jj/repo` path, which `readTextFile` reads. That path identifies the repository. Folders jj does not recognize get the shipped Git check. Answers are cached per folder, as the shipped sidebar caches Git's.

`jj-spaces` publishes the answers with `setShared`, keyed by machine and folder. The menus and dialogs read them to choose between jj and Git entries, so only `jj-spaces` asks. Every jj mod needs `jj-spaces` in the layout, which also holds the settings.

A space's repositories are those of its terminal panes' folders. A space with exactly one jj repository gets a status line, describing the checkout Herdr's sidebar uses for its branch, the space's first terminal with a folder.

### Status lines

One `jj log --no-graph` call over `@ | heads(::@ & bookmarks())::@`, limited to 64 changes, yields the nearest bookmark, the distance to it, and the files and lines changed in `@`. The template computes `diff.stat()` only for `@`, using `if(current_working_copy, ...)`. On 3, 10,000 and 100,000 files this took a median of 32 to 38 ms, set by the number of changed files in `@`.

The text comes from the `status` setting, defaulting to `{bookmark} {files} {loc}`. Placeholders are `{repo}`, `{workspace}`, `{bookmark}`, `{files}` and `{loc}`. `{bookmark}` renders as `master~4`, the bookmark and the number of changes after it in the result. When several bookmarked ancestors are heads, it uses the one jj lists first. When no bookmark is within 64 changes, `{bookmark}` renders empty. `{files}` renders as `~3` and `{loc}` as `+120 -8`. An empty `@` renders `∅` in place of `{files} {loc}`. A stale workspace, divergent operations or a failed read render one dim word, `stale`, `divergent` or `error`, with jj's message as a tooltip. The text sits where the shipped sidebar shows a branch, and is cut from the left when the row is narrow.

A status line refreshes in three cases.

- After an operation. One watch on the repository's `.jj/repo/op_heads/heads/` folder, which jj rewrites after every operation, serves every workspace of that repository. Each operation refreshes the status lines of that repository's spaces one at a time, with `--at-op=@`.
- After an agent's turn or a foreground command ends in the space, the edge the shipped sidebar uses to refresh a branch. The read omits `--at-op=@`, so jj snapshots the checkout first.
- After a space's first terminal changes folder.

Where `watchFolder` rejects a watch, status lines fall back to a 30-second interval while visible.

### Changes panel

The stack is the list of changes from `trunk()` to `@`, the revset `@ | (trunk().. & first_ancestors(@))`, newest first. One `jj --at-op=@ log` call returns each change's commit ID, change ID, description, emptiness, conflict state and line totals, and for `@` each changed file's path, status and line counts from the template's `diff.stat().files()`. The stack stops at 100 changes, and the panel then says how many it shows. Line totals are kept per commit ID, and a second read computes them only for commits the panel has not seen.

Selecting a change other than `@` runs one `jj --at-op=@ log -r <commit>` for its files and line counts. Selecting two changes runs `jj --at-op=@ diff --from <older> --to <newer>` with a template listing each file's path and status, and the panel shows the pair's totals from jj's summary. Selecting a file runs `jj --at-op=@ diff --git` for that file, by commit ID, with `-r <commit>` or `--from` and `--to`. The output is Git's diff format, so the shipped panel's diff parser and line renderer apply unchanged. The panel shows at most 5,000 lines or 1 MiB of a diff, whichever comes first, and says when it cut one short.

The panel has three regions, top to bottom.

1. A header with the workspace name, the age of the data once it is more than a minute old, as "updated 5 minutes ago", a refresh button, and the last error with the last good data still shown below it.
2. The stack, with `@` first. Selecting a change shows its files and its diff against its parent. Selecting a second change compares them. The panel orders the pair by stack position, labels them FROM and TO with both change IDs, and says the older change's own edits are excluded. A refresh that finds a selected change rewritten or gone says so and clears that selection.
3. The files of the current selection with status and counts, then the selected file's diff in the shipped panel's virtual list.

The panel refreshes in two cases while visible.

- File events in the checkout, outside `.jj/` and `.git/`, gathered over 300 ms, run `jj util snapshot`. A snapshot that finds edits records an operation. One that finds none records nothing, so build output in ignored folders costs one snapshot and no read.
- An operation, from the same `op_heads` watch the status lines use, and becoming visible run the stack read.

Hidden, it does no work, although Herdr keeps its copy alive. In a Git-only repository the panel runs the shipped panel's Git code unchanged, including its ten-second timer.

### Refresh rules

`jj-spaces` and `jj-changes` each keep their own refresh loop, as the shipped `spaces` and `changes` mods do. Each loop keeps separate state per repository for status lines and per open panel, and

- runs at most one jj call at a time;
- marks a request that arrives during a run as pending, then runs once more after the current run ends, so the last change always produces a final refresh;
- tags each run with a generation number and drops a result whose generation is older than the newest selection or checkout;
- runs nothing while its view is hidden, and refreshes once when it is shown again.

### New and Open workspace

The New workspace dialog follows Herdr's New worktree dialog. It has one input for the name, a line saying where the checkout goes and what it starts from, and the key hints `↵ create · esc cancel`. On Enter it runs these steps in the current checkout.

1. Make the name safe for a folder, as Herdr's worktree mod does with branch names, and fill the `directory` setting's `{repo}` with the main checkout's folder name and `{name}` with the safe name.
2. Run `jj --ignore-working-copy workspace add --name <name> <directory>`, adding `-r <name>` when a bookmark of that name exists. Any other name starts from the current checkout's parent, jj's default. When jj refuses, its error stays in the dialog and nothing else runs.
3. For each path in the `links` setting that exists in the main checkout, create the parent folder and link it into the new checkout with `ln -s` and an absolute target. A path that already exists in the new checkout, because the start revision tracks it, stays as it is.
4. When the `miseTrust` setting is on and `mise --version` succeeds, run `mise trust` on each file step 3 linked that `mise` reads as configuration, such as `mise.toml`.
5. Open a space with `space.new {folder}`, leaving it unnamed as Herdr's worktree dialog does, so it takes its name from the checkout folder.

When step 3 or 4 fails, or skips a path, the space still opens, and a notification names each path.

The Open workspace dialog follows Herdr's Open worktree dialog. It lists the repository's workspaces from `jj --at-op=@ workspace list` with their folders, filtered as you type, marks those already open in a space, and selects that space or opens a new one. Workspaces created before jj 0.38 record no folder. The list shows them as unavailable.

### Finish workspace

The Finish workspace dialog follows Herdr's Remove worktree dialog. The menus offer it for a jj space with a terminal in a linked workspace. A space that shows a main checkout and has no terminal in a linked workspace gets the dialog with "This is the repository's main checkout." and only Esc.

The dialog lists every linked workspace in which a terminal of the space works, with its folder. The workspace the space shows comes first and is checked, and the others follow in tab order, unchecked. Under each checked workspace, a line names any other space with a terminal in that checkout, since those terminals close too. Workspaces with no recorded folder are listed as unavailable and cannot be checked. The text says "Closes the terminals working in the checked folders and deletes the folders. Edits jj tracks stay in the repository. Files jj does not track, including ignored files, are deleted." The key hints are `space check · ↵ finish · esc cancel`.

On Enter it runs three steps.

1. Check. Run `jj --at-op=@ workspace list` from the main checkout and confirm each checked name still has the folder the dialog shows. Then run `jj status` in each checked checkout, which snapshots it and fails on a held lock, a stale workspace or a missing checkout. Any failure shows jj's error and leaves every space and terminal open.
2. Close. When every terminal of the space works in a checked checkout, close the space with `space.close {id, confirmed: true}`, as Herdr's Remove worktree does. Otherwise close each pane working in a checked checkout with `pane.close`. Panes in other spaces working in a checked checkout close the same way.
3. Remove. Run `jj workspace remove <name>...` from the main checkout for every checked workspace, with the ten-minute timeout Herdr's worktree mod gives `git worktree remove`.

When step 3 fails, the dialog stays open with jj's error, and Enter runs the three steps again. Closed terminals stay closed.

In a disposable repository, `jj workspace remove` on jj 0.47.1 snapshotted the checkout's edits into a commit, removed the colocated Git worktree, and deleted the checkout, including an ignored file, in 0.62 seconds. A symbolic link in the checkout pointing outside it was removed without touching its target. jj refuses to remove the main workspace.

### Settings

Settings are props on the `jj-spaces` block in whichever layout shows the sidebar, which is how Herdr's mods take their options. The New workspace dialog reads them from `layout()`, so one place configures every mod. Herdr applies edits to the layout file live.

```json
{
  "mod": "jj-spaces",
  "props": {
    "status": "{bookmark} {files} {loc}",
    "directory": "~/.herdr/worktrees/{repo}/{name}",
    "links": [],
    "miseTrust": true
  }
}
```

The shipped `jj-tui` layout uses these defaults. Installing copies it into `~/.config/herdr-app/layouts/`, replacing an edited copy. A personal layout kept elsewhere, such as in dotfiles and linked in, keeps its own settings, such as `links` for `AGENTS.local.md` and `mise.toml`.

### Stages

Stage 1 delivers `jj-spaces` with nesting and status lines, the New and Open workspace dialogs, the settings, and the menu entries. It deletes no checkout, and its only snapshot is the status line's read after an agent turn. Stage 1 also removes this repository's `herdr-jj` Rust helper and its Workspaces manager dialog, so the repository holds only mods, layouts, scripts and tests, and updates `AGENTS.md` to match. Until Stage 2 lands, you remove a workspace by running `jj workspace remove` yourself.

Stage 2 delivers `jj-changes` and the Finish workspace dialog.

### Performance budget

| Work                                           | Budget | Measured basis           |
| ---------------------------------------------- | ------ | ------------------------ |
| One status line                                | 40 ms  | 32 to 38 ms median       |
| Status lines of 20 workspaces after one jj run | 1 s    | not yet measured         |
| Changes panel snapshot and read, 100,000 files | 400 ms | 348 ms snapshot and stat |
| Work while hidden                              | none   |                          |
| Timers where watches work                      | none   |                          |

`just bench` gains status line, panel and diff cases on the 3, 10,000 and 100,000 file fixtures, a 100-change stack and a 20-workspace repository, which the cost investigation did not measure.

## Alternatives Considered

### A Rust helper binary for repository work

- Pros. Removal code with identity, mount and sparse-checkout checks, approval tokens and Rust tests already exists. A helper could keep one bounded log file for every read.
- Cons. Herdr's mods ship no binaries, so users would install one beside the mods. Every read pays about 5 ms more for the helper's start-up. `jj workspace remove` already snapshots, removes the colocated Git worktree and deletes the checkout without following links out of it.
- Reason for rejection. Rejected by author. The mods can do all of the work through `exec`, as Herdr's worktree mod does with `git`, and a general-purpose mod set should install as mods alone.

### Git reads for the files changed in a jj checkout

- Pros. Herdr's Changes panel already works this way, and Git counts new files.
- Cons. Git and jj disagree on a merge `@`, intent-to-add deletions, files jj has not yet snapshotted, a root parent and files above jj's new-file size limit. Fast Git reads need `git update-index --refresh` first, because jj leaves Git's file timestamps zeroed. Repositories with no Git have no data.
- Reason for rejection. Rejected by author after measurement. The panel would count differently from `jj log`. Git reads remain only in Git-only repositories, through the shipped panel's code.

### Pinning every read to one operation ID

- Pros. All reads in one refresh agree.
- Cons. Each refresh needs an extra step to find the current operation's ID and pass it to every read.
- Reason for rejection. Rejected by author. One jj call per read gives consistent numbers within a result, and a later refresh corrects a race between results. `--at-op=@` already stops reads from merging divergent operations.

### Status lines that never snapshot

- Pros. The sidebar never writes to a repository.
- Cons. Agents edit files with their own tools, so a status line would show the last snapshot, often `∅`, while an agent works.
- Reason for rejection. Rejected by author. One snapshot when an agent's turn ends keeps the status line true for the main use, and records nothing when nothing changed.

### Reusing the shell prompt's status

- Pros. `jj-starship` and the `prompt_diff` alias already compute similar text, and starship takes 14 to 16 ms.
- Cons. `jj-starship` counts no files or lines and writes a "reconcile divergent operations" operation when operations diverge. `prompt_diff` computes the diff up to six times, 450 ms on 1,000 changed files against 106 ms for one pass.
- Reason for rejection. Rejected by author. One `jj log` call with a single `diff.stat()` gives the same content at lower cost.

### Linking jj's library or running a resident service

- Pros. It avoids jj's start-up for each read.
- Cons. Start-up is about 16 ms of the 33 ms a status read takes. The library ties the code to jj's storage formats, and a service adds a process to install and keep running.
- Reason for rejection. Rejected by author. The measured cost of one `jj` process per read is acceptable.

### Herdr's Spaces sidebar and Changes panel unchanged

- Pros. Nothing to maintain.
- Cons. Every jj space shows `(detached)` as its branch, and repositories without Git do not nest. The Changes panel reads Git, misses the jj stack, and costs 5.9 seconds per refresh in a new 10,000-file jj workspace.
- Reason for rejection. Rejected by author. Copies keep Herdr's look and change only the jj parts. The copy of the Changes panel keeps its Git code for Git-only repositories.

### One refresh module shared by the mods

- Pros. The single-flight, pending and generation rules would be written once.
- Cons. Herdr's mods import only from their own folder, so sharing needs a build step that copies the module. The two loops refresh different things on different events.
- Reason for rejection. Rejected by author. Each mod keeps its own loop, as Herdr's `spaces` and `changes` mods do, and `jj-spaces` shares repository identity through `setShared`.

### Status lines on their own row

- Pros. A long status would never crowd the space's name.
- Cons. Every nested space would take two rows, and Herdr's sidebar shows a branch on the name's row.
- Reason for rejection. Rejected by author. The status line takes the branch's place on the same row.

### Drawing nesting without moving spaces

- Pros. The sidebar would leave Herdr's space order alone.
- Cons. Switching between spaces follows the real order, so the display and the switching order would disagree.
- Reason for rejection. Rejected by author. The copy moves spaces with `space.move`, as Herdr's sidebar does for worktrees.

### Removing the checkout on ordinary Close

- Pros. One action fewer.
- Cons. Close stops being safe to use without thinking.
- Reason for rejection. Rejected by author. Close stays non-destructive, and Finish is a separate menu entry.

### Preserving `.tmp/` and `.local/` at Finish

- Pros. Notes in `.local/` would survive, copied into the main checkout through a verified staging folder, with a dated name on collision.
- Cons. Finish would have six stages and a partial-failure report. It would treat two project conventions as built in, which a general-purpose mod set should not.
- Reason for rejection. Rejected by author. Finish should be predictable and straightforward, following Herdr's Remove worktree. Untracked files are deleted, and the dialog says so.

### Finish refusing spaces shared with other checkouts

- Pros. Finish would never close a terminal outside the checkout it removes, and the dialog would need no list.
- Cons. A space with tabs in two workspaces, or a checkout also open in another space, could not be finished at all.
- Reason for rejection. Rejected by author. The dialog lists the space's workspaces with its own checked, so the common case is one Enter and the others are explicit choices.

### Settings in their own file, in code constants, or in shared state

- Pros. A file such as `~/.config/herdr-app/jj.json` survives reinstalls and serves every layout. Constants follow Herdr's worktree location. Shared state could have a settings dialog.
- Cons. No shipped Herdr mod reads its own settings file. Constants mean editing code. Shared state lives in `shared.json`, which Herdr writes, and needs a dialog to edit.
- Reason for rejection. Rejected by author. Props on the `jj-spaces` layout block are Herdr's convention for mod options.

### Starting every workspace from `trunk()`

- Pros. Every new checkout starts from the same place.
- Cons. Herdr's New worktree starts from the current checkout, and `jj workspace add` starts from the current checkout's parent by default.
- Reason for rejection. Rejected by author. Following Herdr and jj, a name that matches a bookmark starts on it and any other name uses jj's default.

### Leaving `mise` trust to the user

- Pros. New workspace runs no extra commands and trusts nothing on your behalf.
- Cons. Every new checkout with linked `mise` files prompts for trust before its tools work.
- Reason for rejection. Rejected by author. Trust is a setting, on by default, that runs only when `mise` is installed and covers only the linked files.

### Hourly refresh and a ten-second cache

- Pros. Fewer missed updates and fewer repeated reads.
- Cons. A timer runs while nothing changes, and a cache shows old data.
- Reason for rejection. Rejected by author. File watches start refreshes, and each loop's pending flag guarantees a final refresh after the last change.

## Non-Functional Requirements

- Performance. The Performance budget table sets the limits, and `just bench` checks them. No mod starts a process while its view is hidden, and no timer runs where `watchFolder` works.
- Safety. Only Finish deletes anything, and only after its check step passes. Nothing runs `jj workspace update-stale`, overwrites an existing path when linking, or commits, pushes or merges. Ordinary Close and `space.close` from Herdr's own menus stay non-destructive.
- Command safety. Every command runs through `exec` with an argument list, so workspace names, folders and revsets never pass through a shell. `mise trust` covers only files New workspace linked from the main checkout.
- Rollout and rollback. Installing copies the mods into `~/.config/herdr-app/mods/` and the layout into `~/.config/herdr-app/layouts/`. Switching back with `herdr-app do layout.switch '{"name":"main"}'`, or to any other layout, stops every jj mod, and deleting the `jj-*` mod folders uninstalls them. Existing checkouts and workspaces stay as they are. Stage 1 retires the `herdr-jj` command, so scripts that call it stop working.

### Additional Resources

- Herdr's mod guide and interface types, `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`.
- Herdr's shipped `spaces`, `changes`, `worktree`, `menu`, `new-menu` and `tabs` mods in `~/.config/herdr-app/mods/`, which the project mods copy.
- jj's template language, `jj help -k templates`, and workspace commands, `jj workspace --help`.

### Future Improvements

- History actions in the changes panel, such as describe, squash and abandon.
- An interdiff between two versions of one change.
- Verified support for remote machines and Linux.
- A status line for spaces that work in several repositories.
- An explicit Update stale workspace action.

## Detailed Implementation Plan

The plan lands in two stages. Each stage ends with `just verify` and `just bench` passing.

Fresh copies come from the shipped mods with `mod.clone` in an isolated app home, never the personal one.

```sh
HERDR_APP_HOME=$(mktemp -d) herdr-app do mod.clone '{"name":"spaces","as":"jj-spaces"}'
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
- Change. Replace `check(key)` with a call to `identity()` from `jj.js`, falling back to the shipped Git code when it returns null. For each place with a jj identity, keep `{repo, root, main}` in the place's record and publish every record with `setShared("jj.places", {"<machine>\t<folder>": record})`.
- Change. Nest spaces by `repo` for jj places, with the main checkout's space as parent, through the shipped `space.move` ordering.
- Change. Replace `gitTail()` for jj places with the status text. A space qualifies when all of its terminal panes' places resolve to one `repo`. It renders `{text, error}` from the last status read, in `dim`, with `ansi2` and `ansi1` for `+N` and `-N`, and a tooltip holding jj's message on error.
- Change. Keep one `watchFolder(<repo>/op_heads/heads)` loop per local repository. A batch marks every qualifying space on that repository pending with `snapshot: false`. The shipped busy edge in `due()` marks its space pending with `snapshot: true`. A folder change marks its space pending with `snapshot: false`.
- Change. One refresh loop runs pending reads one at a time, `snapshot: true` first. Each entry holds `{running, pending, generation}`. A rejected watch, and every remote repository, switch to a 30-second interval while `window().active`.
- Change. Read settings from the block's `props()`, merged over the defaults in `jj.js`.

#### 5. `mods/jj-spaces/jj.js` (Create)

- Type. Module imported by `main.js`.
- `DEFAULTS`. `{status: "{bookmark} {files} {loc}", directory: "~/.herdr/worktrees/{repo}/{name}", links: [], miseTrust: true}`.
- `identity(folder, on)`. Runs `jj --ignore-working-copy workspace root` in `folder`. A failure returns null. Then `readTextFile("<root>/.jj/repo", {on})`. Text means a linked workspace, and `repo` is that text resolved against `<root>/.jj/`. Null means a main checkout when `readTextFile("<root>/.jj/repo/store/type", {on})` returns text, and `repo` is `<root>/.jj/repo`. `main` is the folder two levels above `repo`. Returns `{root, repo, main, linked: root !== main}`.
- `STATUS_TEMPLATE`. One JSON line per change, `json({"commit" => commit_id, "at" => current_working_copy, "bookmarks" => local_bookmarks.map(|b| b.name()).join(" ")})`, extended for `@` with `empty`, `diff.stat().files().len()`, `diff.stat().total_added()` and `diff.stat().total_removed()`.
- `readStatus(root, on, snapshot)`. Runs `jj [--at-op=@] log --no-graph --limit 64 -r '@ | heads(::@ & bookmarks())::@' -T STATUS_TEMPLATE` in `root` with a ten-second timeout. Returns `{bookmark, distance, empty, files, added, removed}`, where `bookmark` is the first name on the first line, in output order, that has one, and `distance` is that line's index. Errors return `{error: "stale" | "divergent" | "error", message}`, matched on jj's "stale" and "resolved to more than one operation" messages.
- `renderStatus(format, status, names)`. Fills `{repo}`, `{workspace}`, `{bookmark}` (`name~N`, `name` at distance 0, empty with no bookmark), `{files}` (`~N`) and `{loc}` (`+A -R`), and replaces `{files} {loc}` with `∅` when `@` is empty. Returns segments with their color names.

#### 6. `mods/jj-workspace/main.js`, `mods/jj-workspace/mod.json` (Replace)

- Type. Mod, fresh copy of `worktree`.
- Change. Accept `props.action` of `new`, `open` and, in Stage 2, `finish`, with `props.space`. Read the space's record from `shared("jj.places")` and the settings from the `jj-spaces` block in `layout()`.
- `new`. Keep the shipped dialog's input, key hints and spinner. `slug()` is the shipped one. The info line shows the filled directory and either "starts on bookmark <name>" or "starts from this checkout's parent", decided by `jj --at-op=@ bookmark list -T 'name ++ "\n"' <name>` as you type, at most once per 300 ms. Enter runs `jj --ignore-working-copy workspace add --name <name> [-r <name>] <directory>` in `root`, then for each link `mkdir -p <parent>` and `ln -s <main>/<path> <directory>/<path>` when `<main>/<path>` exists and `<directory>/<path>` does not, then `mise trust <file>` for linked files named `mise.toml`, `.mise.toml`, `mise.local.toml`, `.mise.local.toml` or under `.mise/` or `mise/`, then `space.new {folder: directory, machine}`. Skipped and failed paths go to one `notify` call.
- `open`. Lists `jj --at-op=@ workspace list -T 'json({"name" => name, "root" => root})'` with the shipped filtered list, marking a workspace open when a pane's folder sits inside its root. Enter selects that space or runs `space.new {folder, machine}`. A workspace with an empty root is listed as unavailable.
- Change. Errors from any command show in the dialog in `blocked` and go to `console.log`.

#### 7. `mods/jj-menu/main.js`, `mods/jj-menu/mod.json` (Replace)

- Type. Mod, fresh copy of `menu`.
- Change. In `items()`, a space whose place has a record in `shared("jj.places")` gets New workspace and Open workspace, opening `jj-workspace` with `{space, action}` at the shipped sizes. Any other space keeps the shipped `checkout()` probe and worktree entries.

#### 8. `mods/jj-new-menu/main.js`, `mods/jj-new-menu/mod.json` (Replace)

- Type. Mod, fresh copy of `new-menu`.
- Change. The New worktree and Open worktree rows open `jj-workspace` when the focused pane's place has a jj record, and Herdr's `worktree` otherwise, with labels New workspace and Open workspace for jj.

#### 9. `mods/jj-tabs/main.js` (Modify)

- Type. Mod, existing copy of `tabs`.
- Change. Keep the + and right-click overlays on `jj-new-menu` and `jj-menu` and the panel list `["files"]`. No change in Stage 1 beyond confirming the copy matches the current shipped `tabs` apart from these three lines.

#### 10. `layouts/jj-tui.json` (Modify)

- Type. Layout.
- Change. Mount `agents` in place of `jj-agents`. Give the `jj-spaces` block the default props from the Settings section.

#### 11. `tests/mod-harness.js` (Modify)

- Type. Test harness.
- Change. Add fakes for `exec` (scripted results by command and arguments, recording each call), `readTextFile`, `watchFolder` (a controllable promise), `shared` and `setShared`, `layout()` with block props, `notify` and `run`, so tests can assert every command a mod runs.

#### 12. `tests/mods.test.js` (Replace)

- Type. Mod behavior tests with the harness.
- Cases. `jj-spaces` nests linked workspaces under the main checkout, renders each status example from the Status lines section, renders `stale`, `divergent` and `error` with tooltips, and shows no status line for a space with panes in two repositories. An `op_heads` batch runs one `--at-op=@` read per qualifying space, in series. A busy edge runs one read without `--at-op=@`. A request during a run produces exactly one more run. Hidden, nothing runs.
- Cases. New workspace runs the commands of item 6 in order, adds `-r` only for an existing bookmark, skips an existing link path and names it in one notification, runs no `mise` when `mise --version` fails or `miseTrust` is off, and keeps jj's error in the dialog when `workspace add` fails. Open lists, filters, marks open workspaces and lists an empty root as unavailable.
- Cases. The menus offer jj entries for jj places and the shipped worktree entries otherwise. The layout mounts no `changes` and no `jj-agents`.

#### 13. `tests/jj.test.js` (Create)

- Type. Tests against real jj in disposable `/tmp` repositories, removed afterwards.
- Cases. `identity()` for a main checkout, a linked workspace and a plain folder. `readStatus()` for an empty `@`, edits in `@`, a bookmark at distance 0 and 3, no bookmark, a merge with two bookmarked heads, a stale workspace and divergent operations. A `--at-op=@` read records no operation. `jj workspace add --ignore-working-copy` leaves the source checkout's operation count unchanged.

#### 14. `scripts/bench.js` (Replace)

- Type. Benchmark.
- Change. Measure `readStatus()` at 3, 10,000 and 100,000 files, and an `op_heads` refresh across 20 workspaces, against the Performance budget. Write results to `.tmp/bench.json`.

#### 15. `scripts/app-trial.js` (Replace)

- Type. Native trial in an isolated app home, a separate core session and a disposable repository.
- Change. Install the mods and layout, create a workspace through `jj-workspace`, and record the space's nesting, the status text before and after an edit with a finished command, and the Open list. Screenshots go to `.tmp/`.

#### 16. `Justfile` (Modify)

- Type. Task configuration.
- Change. Remove `build` and the Cargo steps. `test` runs `node --test tests/*.test.js`. `verify` runs `test`, `check-mods` and `node --check` on every script and mod file. `bench` runs `node scripts/bench.js`. Add `install`, copying `mods/jj-*` and `layouts/jj-tui.*` into `${HERDR_APP_HOME:-~/.config/herdr-app}`.

#### 17. `.tool-versions`, `.envrc`, `.gitignore` (Modify)

- Type. Tool configuration.
- Change. Remove `rust`, the `PATH_add target/debug` line and the `target/` entry.

#### 18. `AGENTS.md` (Modify)

- Type. Contributor rules.
- Change. Replace the Rust helper rule with "Keep the work in Herdr mods in JavaScript. Node is a development and test dependency." Point the design link at `design/jj-workspace-lifecycle.md`.

#### 19. `README.md` (Replace)

- Type. Usage documentation.
- Change. Sections Install, Settings (the four props and their defaults), New and Open workspace, Status lines, Remove a workspace (`jj workspace remove` until Stage 2), Develop and verify, and Limits (remote machines, Linux, `pane.close` behavior).

### Stage 2

#### 20. `mods/jj-changes/main.js`, `mods/jj-changes/mod.json` (Create)

- Type. Mod, fresh copy of `changes`.
- Change. On init and on each place change, read the place's record from `shared("jj.places")`. Without one, run the shipped code unchanged.
- Change. With one, start two loops while visible. One watches the checkout root, drops paths under `.jj/` and `.git/`, gathers batches for 300 ms and runs `jj util snapshot` with a ten-second timeout. The other watches `<repo>/op_heads/heads` and runs `readStack()`. Becoming visible runs `readStack()`. Each loop holds `{running, pending, generation}`.
- Change. Render the header, stack and file list described in the Changes panel section with the shipped virtual list and diff rows. Selection holds up to two commit IDs. A refresh drops a selected ID that is no longer in the stack and shows "Selected change was rewritten".
- Change. `load(path)` runs `jj --at-op=@ diff --git -r <commit> <path>` or `--from <older> --to <newer> <path>` and stops parsing at 5,000 lines or 1 MiB with a "diff cut short" row.

#### 21. `mods/jj-changes/jj.js` (Create)

- Type. Module imported by `main.js`.
- `readStack(root, on)`. Runs `jj --at-op=@ log --no-graph --limit 100 -r '@ | (trunk().. & first_ancestors(@))' -T STACK_TEMPLATE`, one JSON line per change with `commit`, `change`, `description`, `empty`, `conflict` and `at`. For `@` the line includes `files`, each `{path, status, added, removed}` from `diff.stat().files()`.
- `readTotals(root, on, commits)`. For commits missing from the per-commit cache, one `jj --at-op=@ log --no-graph -r '<commit> | <commit> ...' -T` read returning `{commit, added, removed}` lines. The caller skips it when every commit is cached.
- `readChange(root, on, commit)`. The same file list for one commit.
- `readPair(root, on, from, to)`. `jj --at-op=@ diff --from <from> --to <to> -T 'json({"path" => path, "status" => status})'` for the list, and `jj --at-op=@ diff --from <from> --to <to> --stat` for the summary totals.

#### 22. `mods/jj-workspace/main.js` (Modify)

- Type. Mod.
- Change. Add `finish`. List the linked workspaces from the space's panes' places, the space's place first and checked. For each checked one, list other spaces with a pane in its root. The space bar toggles the focused row's `Checkbox`. Enter runs the check, close and remove steps of the Finish section, with `space.close {id, confirmed: true}` when every terminal pane of the space sits in a checked root, and `pane.close {pane}` for each pane in a checked root otherwise. Removal runs `jj workspace remove <names...>` in `main` with a 600,000 ms timeout.

#### 23. `mods/jj-menu/main.js`, `mods/jj-tabs/main.js`, `layouts/jj-tui.json` (Modify)

- Type. Mods and layout.
- Change. `jj-menu` adds Finish workspace for spaces with a pane in a linked workspace. `jj-tabs` restores the panel list `["files", "changes"]`. The layout adds a `changes` entry to `panel-body` mounting `jj-changes`.

#### 24. `tests/mods.test.js`, `tests/jj.test.js`, `scripts/bench.js`, `scripts/app-trial.js`, `README.md` (Modify)

- Type. Tests, benchmark, trial and documentation.
- Cases. The panel snapshots once per 300 ms batch, ignores `.jj/` and `.git/` paths, refreshes on `op_heads` batches, stops when hidden, clears a rewritten selection and cuts a long diff. The stack read covers `@` on `trunk()`, a 4-change stack and a 100-change cap. Finish checks the space's own workspace first, refuses before closing anything when `jj status` fails, closes the space when every pane is in checked roots, closes only those panes otherwise, names and closes panes in other spaces, and retries removal on Enter.
- Benchmark. Panel snapshot and read at 100,000 files, and diff cases.
- Trial. Finish in an isolated app, recording that the space closes and `jj log` keeps the change, and whether `pane.close` asks first for a pane running a program.
- README. Changes panel and Finish workspace sections, and Remove a workspace pointing at Finish.

### Verification Plan

- Build. None. The mods run as source.
- Unit and behavior tests. `just test` runs `tests/mods.test.js` against the harness and `tests/jj.test.js` against real jj in `/tmp` repositories.
- Static checks. `just check-mods` runs `herdr-app check` on every mod in an isolated app home. `just verify` adds `node --check` on every script and mod file.
- Coverage. Every command each mod runs appears in at least one test asserting its arguments, and every state in CUJs 1 to 7 has a test.
- Performance. `just bench` meets the Performance budget at 3, 10,000 and 100,000 files and across 20 workspaces.
- Native. `node scripts/app-trial.js` in an isolated app home and core session covers CUJs 1, 2, 4, 5 and 6, and answers the open question about `pane.close`. Remote machines, Linux and visual review in the personal app remain unverified until run by hand.
