# jj workspace lifecycle in Herdr

Author: Wendell Smith
Status: Draft
Date: 2026-11-13

---

## Overview

This design adds jj workspaces to Herdr as a general-purpose set of mods. One person can run several pieces of work in parallel in one jj repository, each in its own Herdr space, and see where each piece stands without leaving Herdr.

This document uses five terms.

- A _jj workspace_ is a second working directory that shares history with the repository's main checkout. This document calls its directory the checkout.
- A _Herdr space_ is a named group of tabs in the Herdr app, listed in the sidebar.
- `@` is the jj change the checkout is editing, and `@-` is its parent.
- A _snapshot_ is jj recording the checkout's files into `@`. jj snapshots at the start of most commands.
- A _status line_ is the short text under a space's name in the sidebar's Spaces list, where Herdr shows a Git branch today.

The work covers three moments.

1. Starting. You choose New workspace from a space's menu or the + menu and type a name. Herdr runs `jj workspace add` with a checkout in Herdr's worktree location, `~/.herdr/worktrees/{repo}/{name}`, and opens a space on it, nested under the main checkout's space. A name that matches a bookmark starts the checkout on that bookmark. Any other name starts from the same parent as the current checkout, as `jj workspace add` does by default. Files you list in the settings are linked from the main checkout, and when `mise` is installed the linked `mise` files are trusted.
2. Returning. Each space's status line shows the checkout's status with content similar to your shell prompt, such as `master~4 ~3 +120 -8`, in the theme colors Herdr uses for a Git branch. Its text is dim, and lines added and removed use the green and red the sidebar uses for commits ahead and behind. A changes panel, opened from the tab bar like Herdr's Changes panel, shows the stack of changes since `trunk()` with lines added and removed per change, the files changed in `@`, file diffs and a comparison between two changes.
3. Finishing. Finish workspace, in the space's menu, closes the space and runs `jj workspace remove`. jj snapshots the checkout, so its edits stay in the repository, then deletes the checkout.

The design follows Herdr's own support for Git worktrees. Herdr's space menu and + menu offer New, Open and Remove worktree in a dialog, its sidebar nests worktree spaces under their repository's space and shows each one's branch, and its Changes panel opens from the tab bar. This design offers the jj equivalents in the same places. Each mod starts as a clone of the Herdr mod it follows, so it keeps Herdr's theme colors, dialogs, menus, notifications and components. Like Herdr's mods, these mods run command-line tools such as `jj`, `ln` and `mise`, and ship no binary of their own.

The work ships in two stages. Stage 1 adds the nesting sidebar, status lines, and the New and Open workspace dialogs. These read jj state and create workspaces; they delete nothing. Stage 2 adds the changes panel and Finish, which snapshot and delete.

## The Problem

Parallel work in jj needs a checkout per piece of work, a terminal in each, and a way to see what each one holds and where it stands.

- Starting a checkout takes `jj workspace add` with a path and revision, links to local files the repository ignores, often `mise trust`, and a new Herdr space and tab in the right folder.
- Returning means switching to the checkout and running `jj log` and `jj diff` to remember what it holds. Herdr's sidebar shows Git branches, which a jj checkout lacks. Herdr's Changes panel reads Git, so it misses the jj stack. In a new 10,000-file jj workspace it also costs 5.9 seconds per refresh, every ten seconds, because jj leaves Git's file timestamps zeroed and the panel never lets Git correct them.
- Finishing means closing every terminal in the checkout, then removing the workspace and its directory.

The design gives each workspace its own space. A space's identity then answers "which checkout", its status line answers "what state is it in", and finishing it removes the checkout.

## Goals

- Start from a name. Typing a name and pressing Enter creates the workspace, checkout and nested space. The dialog says where the checkout goes and what it starts from. When the name or folder is taken, jj's error appears in the dialog.
- See each workspace's status at a glance. Each nested space's status line shows its nearest bookmark, the number of changes since it, and the files and lines changed in `@`, or `∅` when `@` has no changes. The format is configurable. A status line costs about 35 ms to refresh and refreshes only after something changed.
- Inspect progress in jj terms. The changes panel shows the stack since `trunk()`, per-change line totals, the files changed in `@` with line counts, any file's diff and a diff between two changes in the stack. In jj repositories all of it comes from jj, mostly from one jj call per refresh, so the numbers match `jj log` and never mix jj and Git counting.
- Stay quiet when unwatched. Nothing refreshes while hidden. No timer runs where file watching works. Status lines never snapshot, and nothing runs `jj workspace update-stale`. Only the visible changes panel snapshots.
- Finish in one action. Finish closes the space and runs `jj workspace remove`. Before you confirm, the dialog says which folder it deletes, that edits jj tracks stay in the repository, and that files jj ignores are deleted.
- Work in any jj repository. Nothing assumes a project's files or tools. The list of linked files is a setting with no entries by default. `mise trust` runs only when its setting is on, which is the default, and `mise` is installed.
- Fit Herdr. Entry points sit where Herdr puts its worktree actions. Dialogs, menus and notifications use Herdr's shipped dialog, menu and notification behavior. Every color comes from Herdr's theme, so the UI follows light and dark themes. Lists, tabs, buttons and inputs use Herdr's component library, and diffs reuse the Changes panel's look.
- Explain failures. A failed action shows jj's error in the dialog or panel where it happened. The panel keeps the last good data visible beside the error and says how old the data is once it is more than a minute old. Mods also write each error to Herdr's log with `console.log`.

## Non-Goals

- Editing history. The panel offers no rebase, squash, describe, commit, bookmark, tag, operation log, undo or redo. You use jj for these.
- Interdiff and drag and drop.
- Automatic recovery from stale workspaces. They are reported, never updated.
- Publishing work. Nothing commits, pushes or merges automatically.
- Keeping ignored files at Finish. Files jj ignores, such as `.local/` notes, are deleted with the checkout. You track them in jj or move them first.
- Moving existing checkouts. Checkouts outside Herdr's worktree location keep working where they are.
- Changing existing mixed spaces. Spaces you already use for several repositories keep their tabs. Finish acts on the checkout a space shows, as Herdr's Remove worktree does.
- Editing Herdr's shipped mods. Each mod here is a project-owned clone.
- Streams integration, remote machines and Linux. The mods pass each space's machine to every command, as Herdr's worktree mod does, but remote machines and Linux remain untested.

## Open Questions

None.

## Critical User Journeys (CUJs)

### CUJ 1: Start a workspace

- Given the main checkout `herdr-jj-workspaces` is open in a space of the same name. Its `mise.toml` is trusted, and the layout lists `mise.toml` and `AGENTS.local.md` as linked files.
- When you choose New workspace from that space's menu and type `nesting`.
- Then the dialog says the checkout goes in `~/.herdr/worktrees/herdr-jj-workspaces/` and starts from the same parent as this checkout. After you press Enter, a space `nesting` opens below the main space, drawn as its child, with a terminal in the checkout. Both files are links to the main checkout's copies, and `mise` runs there without a trust prompt.

### CUJ 2: Glance at status

- Given three nested workspaces, one with edits an agent has made.
- When the agent's turn ends.
- Then that space's status line changes, for example to `master~2 ~3 +40 -5`, within about a second. The other status lines start no processes. A space with no changes in `@` shows `∅`.

### CUJ 3: Inspect and compare

- Given a workspace whose stack has four changes since `trunk()`.
- When you open the changes panel.
- Then the panel snapshots, then lists the four changes with lines added and removed, and the files changed in `@`. Selecting a file shows its diff. Selecting two changes shows the diff from the older to the newer, labelled with both change IDs. Hiding the panel stops all of its work.

### CUJ 4: Finish

- Given the `nesting` space holds two terminals, one of them an agent. The checkout has an edited `src/lib.rs` and an ignored `build.log`.
- When you choose Finish workspace from the space's menu.
- Then the dialog says it closes the space and deletes `~/.herdr/worktrees/herdr-jj-workspaces/nesting`, that edits jj tracks stay in the repository, and that files jj ignores are deleted. After you press Enter, the space closes, jj snapshots the edit to `src/lib.rs` into the workspace's change, and the checkout and `build.log` are gone. `jj log` in the main checkout shows the change.

### CUJ 5: Finish fails

- Given another process holds jj's lock on the repository for longer than Finish waits.
- When you press Enter in the Finish dialog.
- Then the space has already closed, and the dialog stays open showing jj's error. The checkout and workspace remain. Pressing Enter again retries, and Open workspace still lists the checkout.

### CUJ 6: Git-only repository

- Given a space whose folder is a Git repository with no `.jj`.
- When you open the changes panel.
- Then the panel behaves as Herdr's Changes panel does, listing changed files and diffs from Git with no stack. The sidebar nests linked Git worktrees and shows their branches as Herdr's sidebar does.

## Trade-offs

- Status lines. A status line describes one checkout. A space whose tabs use several repositories has no single checkout to describe, so it shows no status line. Spaces this feature creates hold one checkout each, so they show one. Each status read costs about 35 ms and runs only after a jj command, an agent turn or a folder change in that space.
- Automatic `mise` trust. Trusting a `mise` file lets it run commands when you enter the directory. Start trusts only the `mise` files it links from the main checkout, and reports a trust failure in a notification. `mise` files that come from the start revision stay untrusted. Turning the setting off skips trust entirely.
- Snapshots from the changes panel. A snapshot after edits records a jj operation, as any jj command does, and refreshes the status lines. The panel snapshots only while visible, never in response to jj's own operation changes, and reports a stale workspace without running `jj workspace update-stale`.
- Reads are not pinned to one jj operation. A jj command that lands between two reads can make them disagree until the next refresh. Each refresh uses one jj call where it can, so its own numbers agree. When jj finds divergent operations, a read merges them, as every jj command does.
- Finish deletes files jj ignores. Build output, scratch files and notes in ignored folders are lost with the checkout, as untracked files are with Herdr's Remove worktree. The dialog says so before you confirm.
- Finish closes the whole space. Terminals in the space that work in other directories close too. Terminals in other spaces that sit in the checkout stay open, and their folder disappears under them, as with Herdr's Remove worktree.
- Command-line tools only. Every read starts a `jj` process, about 16 ms of start-up before any work. A long-running helper could avoid it but would be a binary to install and keep running, which Herdr's mods never need.

## Technical Plan (Architecture)

Project-owned JavaScript mods do all of the work. Each is a clone of the Herdr mod it follows. They read and change jj state by running `jj` through Herdr's `exec`, as Herdr's worktree mod runs `git`. A shared module holds the jj calls, their parsing and the refresh routine.

```text
 Herdr app (jj-tui layout)                                  command-line tools
 ─────────────────────────                                  ──────────────────
 jj-spaces   (clone of spaces)
   identity of each new folder     ── once per folder ───▶  jj workspace root, read .jj/repo
   status line after a change      ── one call ──────────▶  jj log --ignore-working-copy
 jj-changes  (clone of changes)
   on show and file events         ── one call ──────────▶  jj log   (snapshots first)
   on selection                    ── one call ──────────▶  jj diff --git --ignore-working-copy
 jj-workspace (clone of worktree)
   New workspace                   ──────────────────────▶  jj workspace add, ln -s, mise trust
   Open workspace                  ──────────────────────▶  jj workspace list
   Finish workspace                ── after space.close ─▶  jj workspace remove
```

### Mods and their Herdr originals

Each mod starts as a `mod.clone` of the shipped mod it replaces, so it keeps Herdr's spacing, fonts, theme colors and keyboard behavior. The clone changes only its data source and the jj-specific parts.

| Project mod              | Cloned from        | What changes                                                                                                                                                                         |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jj-spaces`              | `spaces`           | Repository identity comes from jj, with the shipped Git check as fallback. jj spaces show a jj status line where the shipped sidebar shows a Git branch.                            |
| `jj-changes`             | `changes`          | jj repositories get the stack, two-change selection and jj data, with no timer and no commit bar. Git-only repositories keep the shipped Git behavior unchanged.                   |
| `jj-workspace`           | `worktree`         | New, Open and Finish workspace dialogs, with the worktree dialog's layout, input, filtered list, key hints and busy spinner.                                                        |
| `jj-menu`, `jj-new-menu` | `menu`, `new-menu` | jj spaces get New workspace, Open workspace and, for linked workspaces, Finish workspace, in the places Herdr shows its worktree entries. Git spaces keep Herdr's worktree entries. |
| `jj-tabs`                | `tabs`             | The tab bar's Changes button opens `jj-changes`. Herdr remembers the open panel per space, as it does today.                                                                        |

The `jj-tui` layout adds `jj-changes` to the right panel stack beside Files. The shipped `changes` mod is never mounted, so its Git poller never runs in jj repositories.

Colors come from `theme()`. Status text and secondary labels use `dim` and `muted`. Lines added use `ansi2` and lines removed use `ansi1`, the colors the shipped sidebar uses for commits ahead and behind and the shipped Changes panel uses for diff lines. Errors use `blocked`. Controls use the component library's lists, `Scrollbar`, `Input` and `Button`.

Every command passes the space's machine to `exec`, as Herdr's worktree mod does. Herdr's `watchFolder` works only on this machine, so a remote space's status line refreshes on agent turns and folder changes alone.

### Reading jj state

In a jj repository every number comes from jj, and each refresh uses one jj call where it can. Status lines pass `--ignore-working-copy`, so they read the last snapshot and never take one. The changes panel's call snapshots first, as an ordinary jj command does. A jj error saying the workspace is stale shows as `stale`, and nothing runs `jj workspace update-stale`.

### Repository identity and nesting

The shipped sidebar asks Git once per new folder which repository it belongs to, then nests linked worktrees under the main checkout's space. `jj-spaces` asks jj first. `jj --ignore-working-copy workspace root` gives the checkout's root. In the main checkout `<root>/.jj/repo` is a folder, and in a linked workspace it is a file holding the main checkout's `.jj/repo` path, which `readTextFile` reads. That path identifies the repository, and the checkout whose `.jj/repo` is a folder is the main one. Folders jj does not recognize get the shipped Git check. Answers are cached per folder, as the shipped sidebar caches Git's.

### Status lines

For each jj space, one `jj --ignore-working-copy log --no-graph` call over `heads(::@ & bookmarks())::@`, limited to 64 changes, yields the nearest bookmark, the distance to it, and the files and lines changed in `@`. The template computes `diff.stat()` only for `@`, using `if(current_working_copy, ...)`. On 3, 10,000 and 100,000 files this took a median of 32 to 38 ms, set by the number of changed files in `@`.

The text comes from the `status` setting, defaulting to `{bookmark} {files} {loc}`. Placeholders are `{repo}`, `{workspace}`, `{bookmark}`, `{files}` and `{loc}`. `{bookmark}` renders as `master~4`, `{files}` as `~3` and `{loc}` as `+120 -8`. An empty `@` renders `∅` in place of `{files} {loc}`. A stale workspace or a failed read renders one dim word, `stale` or `error`, with jj's message as a tooltip.

Spaces whose tabs use several repositories, or no repository, show no status line.

### Changes panel

The stack is the list of changes from `trunk()` to `@`, the revset `trunk().. & first_ancestors(@)`, newest first. One `jj log` call returns each change's ID, description, emptiness, conflict state and line totals, and for `@` each changed file's path, status and line counts from the template's `diff.stat().files()`. The call snapshots first and has a ten-second timeout, which bounds waiting on jj's working-copy lock. The stack stops at 100 changes, and the panel then says how many it shows.

Selecting a change or file runs `jj diff --git --ignore-working-copy`, with `-r <change>` for a change against its parent or `--from <older> --to <newer>` for two changes, and an optional file path. The output is Git's diff format, so the shipped panel's diff parser and line renderer apply unchanged. The panel shows at most 5,000 lines of a diff and says when it cut one short. Herdr caps a command's output at 8 MiB.

The panel has three regions, top to bottom.

1. A header with the workspace name, the age of the data once it is more than a minute old, as "updated 5 minutes ago" or "updated 2 hours ago", a refresh button, and the last error with the last good data still shown below it.
2. The stack, with `@` first. Selecting a change shows its files and its diff against its parent. Selecting a second change compares them. The panel orders the pair by stack position, labels them FROM and TO with both change IDs, and says the older change's own edits are excluded. A refresh that finds a selected change rewritten or gone says so and clears that selection.
3. The files of the current selection with status and counts, then the selected file's diff in the shipped panel's virtual list.

The panel snapshots when it becomes visible and after file events while visible. It ignores events under `.jj/` and `.git/`, which its own snapshot causes, and never snapshots in response to operation changes. Hidden, it does no work, although Herdr keeps its copy alive.

In a Git-only repository the panel runs the shipped panel's Git code unchanged, including its ten-second timer.

### Shared refresh routine

One module serves `jj-spaces` and `jj-changes`, written once and shared. If Herdr cannot import it across mod folders, the build copies it into each mod.

The routine keeps separate state for each thing it refreshes. That is either the status lines of every space on one repository, or one open changes panel. For each, it

- runs at most one jj call at a time;
- marks a request that arrives during a run as pending, then runs once more after the current run ends, so the last change always produces a final refresh;
- tags each run with a generation number and drops a result whose generation is older than the newest selection or checkout;
- coalesces file events over 300 ms before starting a run;
- runs nothing while its view is hidden, and refreshes once when it is shown again.

Status lines refresh on writes to the repository's `.jj/repo/op_heads/heads/` folder, which jj rewrites after every command, on an agent turn ending in that space, and on a folder change. One watch serves every workspace of a repository, since they share one operation log. Each jj command refreshes the status line of each of that repository's spaces in turn, at about 35 ms each. Where `watchFolder` rejects a watch, the routine falls back to a 30-second interval while visible.

### New and Open workspace

The New workspace dialog follows Herdr's New worktree dialog. It has one input for the name, a line saying where the checkout goes and what it starts from, and the key hints `↵ create · esc cancel`. On Enter it runs these steps in the current checkout, on the space's machine.

1. Make the name safe for a folder, as Herdr's worktree mod does with branch names, and fill the `directory` setting's `{repo}` with the main checkout's folder name and `{name}` with the safe name.
2. Run `jj workspace add --name <name> <directory>`, adding `-r <name>` when a bookmark of that name exists. When jj refuses, its error stays in the dialog and nothing else runs.
3. For each path in the `links` setting that exists in the main checkout, create the parent folder and run `ln -s` to link it into the new checkout.
4. When the `miseTrust` setting is on and `mise --version` succeeds, run `mise trust` on each linked file that `mise` reads as configuration, such as `mise.toml`.
5. Open a space with `space.new {folder}`, leaving it unnamed as Herdr's worktree dialog does, so it takes its name from the checkout folder.

A failure in step 3 or 4 still opens the space, and a notification says which link or trust failed.

The Open workspace dialog follows Herdr's Open worktree dialog. It lists the repository's workspaces from `jj workspace list` with their folders, filtered as you type, marks those already open in a space, and selects that space or opens a new one.

### Finish workspace

The Finish workspace dialog follows Herdr's Remove worktree dialog. The menus offer it only for a space whose checkout is a linked jj workspace. For a main checkout the dialog says "This is the repository's main checkout." and offers only Esc.

The dialog's title is "Finish workspace nesting?". Its text says "Closes the space and deletes ~/.herdr/worktrees/herdr-jj-workspaces/nesting. Edits jj tracks stay in the repository. Files jj ignores are deleted." Its key hints are `↵ finish · esc cancel`. On Enter it runs two steps.

1. Close the space with `space.close {id, confirmed: true}`, as Herdr's Remove worktree does, so no terminal holds the folder.
2. Run `jj workspace remove <name>` from the main checkout, with the ten-minute timeout Herdr's worktree mod gives `git worktree remove`.

In a disposable repository, `jj workspace remove` on jj 0.47.1 snapshotted the checkout's edits into a commit, removed the colocated Git worktree, and deleted the checkout, including an ignored file, in 0.62 seconds. A symbolic link in the checkout pointing outside it was removed without touching its target. jj refuses to remove the main workspace.

When jj fails, the dialog stays open with jj's error. The checkout and workspace remain, and Enter retries.

### Settings

Settings are props on the `jj-spaces` block in whichever layout shows the sidebar, which is how Herdr's mods take their options. The New and Finish dialogs read them from `layout()`, so one place configures every mod. Herdr applies edits to the layout file live.

```json
"content": {
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

Stage 1 delivers `jj-spaces` with nesting and status lines, the shared refresh routine, the New and Open workspace dialogs, the settings, and the menu entries. It deletes nothing and never snapshots.

Stage 2 delivers `jj-changes` and the Finish workspace dialog.

### Performance budget

| Work                                       | Budget | Measured basis           |
| ------------------------------------------ | ------ | ------------------------ |
| One status line                            | 40 ms  | 32 to 38 ms median       |
| Changes panel with snapshot, 100,000 files | 400 ms | 348 ms snapshot and stat |
| Work while hidden                          | none   |                          |
| Timers where watches work                  | none   |                          |

`just bench` gains status line, panel and diff cases on the 3, 10,000 and 100,000 file fixtures, and a 100-change stack, which the cost investigation did not measure.
