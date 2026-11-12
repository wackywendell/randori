# Herdr jj workspaces

`herdr-jj` is a Rust CLI for jj workspace management. Six JavaScript mods provide organizational space rows and an explicit workspace manager. Herdr runs the mods in its own runtime. Node is needed only for development tests and checks.

Spaces can span several repositories. Their rows retain machine grouping, user order, names and attention status. They do no VCS inspection, nesting or repository-driven reordering. Agent/pane VCS summaries, the Changes inspector and Streams integration remain deferred.

The [workspace management design](design/workspace-management.md) explains the architecture, safety model and deferred work. [Contributor guidance](AGENTS.md) covers project goals and development rules.

## Develop and verify

Versions live in `.tool-versions`; tasks live in `Justfile`. `.envrc` activates available mise tools and adds `target/debug` to PATH. Tool installation, mise state and direnv approval stay local.

```sh
just build
just verify
just bench
```

`just verify` runs Rust lifecycle tests, JavaScript behavior tests, native checks for all six mods, formatting and Clippy. Native checks use disposable app homes and mod copies. Rust lifecycle tests use disposable jj repositories and fake Herdr resources.

`scripts/app-trial.js` is a manual native lifecycle fixture. It creates a separate temporary HOME, app home, XDG directories and core session. Its commands address only that owned environment. It must never be pointed at an existing app home or user checkout. A visible disposable native trial verified tab closure, final writer-edit preservation, checkout deletion, preservation of another tab, completion notification delivery and the dialog's close hook. The confirmation and result were captured and inspected. Interactive Create/Open flows remain covered by the JavaScript harness.

The tested command surface is jj 0.47.1 and Herdr 0.1.15. Colocated checkout removal also requires the Git CLI on PATH for read-only index checks. Removal supports macOS and Linux; Linux and remote execution remain unverified. Generated types, build output and local review/trial records stay out of source control.

## Workspace manager

Open Workspaces… from the sidebar header, a space's context menu or the tab bar's plus menu. Opening these menus starts no repository processes.

1. Choose Create, Open or Remove.
2. Choose a machine and repository folder. Terminal folders are candidates you select explicitly. You can enter an absolute path; Browse selects a local folder without probing it until you press Use folder.
3. For Create, enter a workspace name. For Open or Remove, select an exact registered checkout. The main checkout cannot be removed.
4. Create and Open require a destination. Choose a new tab in a named existing organizational space, or an explicitly named new space. A space-menu launch offers that space as the visible destination; it does not pick its repository.
5. Remove requires a separate tab/space selection. The final confirmation names the checkout, closure scope, terminal IDs and files outside the current snapshot.

Open creates a new tab, even if the checkout already has another tab. Removal refuses other known users of the checkout; ordinary Close remains non-destructive. Choosing an entire space closes all its tabs, including tabs using other repositories. Only the selected checkout receives a final snapshot. Other checkout files remain on disk, but closing their processes can lose unsaved in-memory work. Choose a single tab when the other tabs should remain open.

After removal confirmation, the dialog stays busy until the helper returns. It then reports success or failure through a notification and closes. Keep the dialog and app open until completion. Forcibly closing or reloading the dialog, or quitting the app, can interrupt reporting while the helper continues. Inspect the operation's effects before retrying.

This manager is jj-only. Non-jj selections show an error; existing Git tools remain separate. No Git worktree action is inferred from a thematic space.

## Use the helper

Each command accepts `--cwd PATH`. Success prints one JSON value. Errors print JSON to stderr and exit nonzero.

```sh
herdr-jj probe --cwd /path/to/project
herdr-jj inspect --cwd /path/to/project
herdr-jj inspect --snapshot --cwd /path/to/project
herdr-jj list --cwd /path/to/project
herdr-jj create feature/topic --cwd /path/to/project
herdr-jj create experiment --revision main --cwd /path/to/project
herdr-jj open feature/topic --cwd /path/to/project
```

`probe` discovers jj through filesystem metadata and starts no jj process. `inspect` reads the current workspace's recorded change. `--snapshot` includes current working files first. The summary contains workspace name, change ID, description, bookmarks, changed-file count and conflict count. The app does not currently display this summary or run an automatic refresh loop.

Creation uses `../workspaces/<name>` beside the main checkout. Slashes become hyphens. An existing path must belong to the same repository and registered workspace; the old `<main>/workspaces/<name>` location is also recognised. Existing destinations and tracked configuration are preserved. A failed add or setup leaves its partial destination for inspection.

An explicit revision selects the new working copy's parent. Otherwise the helper looks for a local bookmark, then origin and upstream, before using jj's default workspace-add behaviour. Absent agent configuration (`.claude`, `CLAUDE.md`, `AGENTS.md`) and tool configuration (`.tool-versions`, `Justfile`, `.envrc`, `mise.toml`, `mise.local.toml`) is linked from the main checkout. `CLAUDE.local.md` and `AGENTS.local.md` are created when absent with workspace/root instructions and any existing main-checkout local notes. Execution approvals for direnv or mise remain manual.

The CLI `open` command resolves an owned workspace and returns its path. The app manager lists registered workspaces and revalidates a selected checkout's physical root and repository before opening its tab.

## Remove a workspace

Removal requires a running local Herdr app and an exact linked-workspace root. Choose one existing tab or space. Run the helper outside both the target checkout and the terminals being closed.

```sh
herdr-jj remove-plan --cwd /path/to/workspaces/topic --tab TAB_ID
```

Review `root`, `scope`, `terminals` and `excluded`, then copy `approval` into the removal command. `hc exec` runs outside the selected terminal and has no terminal identity of its own.

```sh
hc exec --cwd /path/to/project --timeout 600 herdr-jj remove \
  --cwd /path/to/workspaces/topic --tab TAB_ID \
  --yes --approval APPROVAL_TOKEN
```

Use `--space SPACE_ID` instead only to close that whole space. Add `--discard-excluded` after reviewing files outside the current snapshot, including ignored files, untracked files and local configuration notes. The app presents this approval as one final confirmation with a scrollable file list.

Removal validates identity and ownership, closes the selected scope, stops its surviving terminals and verifies that those core terminals have finished. This covers supervised foreground jobs. Stop background or detached writers before removal; they can survive terminal closure and escape the helper's checks. The final snapshot covers the selected checkout. It rejects new or changed excluded content, rechecks the registered workspace name/root, forgets the workspace and deletes its checkout.

Substantive snapshotted work remains in jj's shared repository. Landing work and recovery bookmarks are not required. From the main checkout, `jj --ignore-working-copy log -r 'heads(all())'` can help find retained anonymous heads. `jj --ignore-working-copy file show -r CHANGE PATH` reads a file from a selected change. Files still excluded from the final snapshot are deleted without a jj recovery copy.

The helper refuses the main checkout, other known users, conflicting ownership, new descendants, nested repositories, special files and mounted trees. It refuses unknown data inside .jj and external Git worktree-registration metadata. Only the observed jj 0.47 local-state layout and standard Git registration files, including logs/HEAD, are recognised. Git's index must be readable and match HEAD; staged or conflicted state blocks removal even when the working files look clean. Review and preserve or resolve that state with Git before retrying. The helper does not unstage or discard it. Non-full sparse checkouts are refused because tracked files outside the sparse set may escape snapshots. Directory symlinks are removed without following their targets. Input aliases identify the canonical physical checkout; approval pins its repository and root identity.

Every failure stops later stages. Errors include `stage` and `completed`, which records confirmed stage successes. A failing mutating stage can have partial or unknown effects, including when `completed` is empty. Operations are not atomic. Unknown writers, mount changes and simultaneous clients are not globally locked. Closing the dialog during creation does not roll back an already-started helper.

### After a removal failure

1. Inspect the selected scope with `herdr-app ls` and the remaining terminals with `hc ls --json`. Stop surviving background or detached writers.
2. From the main checkout, run `jj --ignore-working-copy workspace list` to check registration. Inspect the remaining checkout files before deciding on recovery or cleanup.
3. Obtain and review a fresh plan before retrying. A closed scope or forgotten workspace can prevent a normal retry. A forgotten but retained directory requires deliberate manual recovery or cleanup after any needed files are preserved and writers have stopped.

## Installation

Complete a visible disposable trial before using this layout with real work. Keep the existing layout available for rollback.

1. Run `cargo build --release --locked` and put `target/release/herdr-jj` on the PATH Herdr uses. Check for an existing executable before adding a link or copy.
2. Copy each `mods/jj-*` directory to its same-named directory under `~/.config/herdr-app/mods/`. Check that those personal names are unused. Keep generated types in runtime copies.
3. Copy `layouts/jj-tui.json` and `layouts/jj-tui.svg` under those names into `~/.config/herdr-app/layouts/`.
4. Select `jj-tui` when ready. The test scripts use isolated app homes and leave the active user layout unchanged.

Place agent navigation bindings in the `layout:jj-tui` section of `keys.json`.

```json
{
  "cmd-[": "jj-agents.prev",
  "cmd-]": "jj-agents.next",
  "cmd-;": "jj-agents.prev",
  "cmd-'": "jj-agents.next"
}
```

The layout mounts Files and omits the shipped Changes mod entirely. A hidden Changes mod would still run its Git poller. The agent view preserves Focused/All, pins, external sub-agent attention and scoped navigation. Keep Herdr's shipped mods and layouts unchanged when installing these project-owned copies.

## Cost and remaining limits

Space rows and their menus have no VCS probes, watches, timers or snapshots. The manager runs helper commands only after an explicit selection or operation. Automatic repository refresh is deferred with VCS summary placement; the retired scheduler is not shipped.

A serial single-workspace debug-build benchmark with 1,000 tracked files measured median startup-inclusive requests of 5.4 ms for a filesystem probe, 40 ms for metadata, and 209 ms for an unchanged snapshot. A single 1,000-file changed snapshot took 569 ms. Probes started zero jj processes; each other request started one. Nine samples were taken for unchanged operations; timings include an exec-only process-counting wrapper. A concurrent verification run was slower; actual latency depends on workload and contention. `just bench` reruns the measurements.

Remote discovery/create/open can run through `hc exec --on MACHINE` with the helper installed there. Remote removal and fully headless layout cleanup are unsupported. Native checks cover initial rendering; interactive/visual states and lifecycle outcomes must be distinguished from harness coverage. The space view has basic grouping and manual ordering, without the old rail or machine-repair controls.

## Command data

`probe` returns null outside jj, otherwise `{root, repo, main, name, linked}`. `inspect` adds `kind`, `workspace`, `change`, `description`, `bookmarks`, `conflicts`, `files`, `warning`, `watch`.

`list` returns `{name, root: string|null, current, main}[]`. `create` adds `created`, nullable `start` and `note` to a repository value. `open` returns a repository value.

`remove-plan` adds `workspace`, `scope`, `terminals`, `excluded`, `approval`, `identity`. Each excluded entry has a relative `path` and SHA-256 `digest` covering its entry kind and content. `remove` returns `root` and `completed` confirmed stage names.

All errors contain `error`, `stage` and `completed`; `stage` is null outside removal's staged execution. Install the 0.1.0 helper and mods together.
