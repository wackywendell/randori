# Explicit jj workspace management

A Herdr space is an organizational group of tabs containing terminal panes. It can hold a server checkout in one tab and a documentation checkout in another. A workspace action must name the checkout it changes and the terminals it closes.

Jujutsu (jj) is a version control system. A linked workspace has its own working files and shares repository history with the main checkout.

The workspace manager provides explicit Create, Open and Remove operations. A short-lived Rust helper owns repository discovery and workspace lifecycle operations. JavaScript mods present those operations in Herdr. The [README](../README.md) describes usage, command data and verification limits.

## Organizational spaces

Space rows show names, attention status, machine grouping and user-chosen order. They perform no repository inspection. This preserves the meaning of a thematic space when its tabs use different repositories.

Create and Open require a repository selection and an opening destination. The destination is a tab in a chosen space or an explicitly named new space. Launching from a space menu supplies a destination hint. The repository still requires selection.

Remove requires selecting both the exact linked checkout to delete and the tab or space to close. Closing a whole space affects every tab, including tabs using other repositories. One final confirmation follows these selections and names that effect, selected terminal IDs and files outside the current snapshot. Only the selected checkout receives a final snapshot. Other checkouts remain on disk, but closing their processes can lose unsaved in-memory work. Changing the target discards its approval.

## Shared helper

The app and command-line callers use the same `herdr-jj` executable. Rust keeps the helper independent of Herdr's JavaScript runtime, while direct jj CLI calls reuse the installed version's workspace behavior. Node remains a development and test dependency.

Each helper process serves one request. This keeps idle cost low and avoids introducing a persistent service. A service would need evidence that direct calls cannot meet measured performance or remote-event requirements.

Discovery checks jj metadata before Git metadata in colocated repositories. A broken jj repository produces an error. Filesystem discovery starts no jj process, and metadata reads leave working files unsnapshotted unless the caller requests a snapshot.

## Creation and opening

Managed linked checkouts live under `../workspaces/<name>` beside the main checkout. Lookup also recognises the legacy `<main>/workspaces/<name>` location. Creation normalises names and checks existing destinations against shared-repository identity and workspace registration. A matching directory name alone does not establish ownership.

An explicit revision selects the new working copy's parent. Otherwise creation searches local, origin and upstream bookmarks before using jj's default workspace-add behavior. Shared development-tool and agent configuration is linked only when absent. Workspace-local agent instructions name the workspace and constrain edits to its root. Existing files are preserved; execution approvals for tools such as direnv and mise remain manual.

Open revalidates the selected checkout before creating its tab. The CLI returns the owned checkout path; the app controls the organizational destination. An already-started creation can leave a checkout if its dialog closes or setup fails. A setup failure reports the partial destination and leaves it for inspection.

## Mechanical removal

Removal closes a chosen scope and deletes its linked checkout after taking a final snapshot. It requires a running local Herdr app. The main checkout and shared repository cannot be removal targets. Ordinary Close remains non-destructive.

Herdr Core is the terminal and process supervisor exposed through the `hc` CLI. The helper combines its inventory with app layout information. Approved users are the terminal IDs selected within the chosen tab or space, including their core-managed descendants. A known user outside that scope blocks removal.

The checks cover launch folders, current foreground folders and pane references. Core terminal labels named `herdr.space` and `herdr.tab` associate terminals with app scope IDs. Incompatible labels, references from another scope or a newly arriving descendant stop the operation.

The approval token binds physical checkout identity, repository registration, closure scope, selected terminal IDs and excluded files. An excluded file is a file outside the current snapshot, such as an ignored file or untracked local note. Its digest covers both entry kind and content, so replacing a symlink with a regular file invalidates approval even if their bytes match.

The helper executes outside the target checkout and selected terminals. Removal proceeds in this order.

1. Validate identity, registration, known users and the approved excluded-file manifest.
2. Close the selected tab or space, stop surviving selected terminals and verify they have finished.
3. Recheck users and identity, then take the final snapshot.
4. Validate excluded data and workspace registration again.
5. Forget the workspace and delete its checkout.

The shutdown check covers selected core terminals and their supervised foreground jobs. Background or detached processes may survive terminal closure. Users must stop those writers before removal; the helper cannot verify all operating-system processes.

The final snapshot preserves edits in the selected checkout after the supervised jobs finish. Substantive snapshotted work remains in the shared jj repository after forgetting the linked workspace. Landing work and recovery bookmarks are not required. Excluded files receive no jj recovery copy and need explicit discard approval.

### Filesystem authority

Deletion is limited to a verified checkout tree. Input aliases resolve to the physical root, whose device and inode are included in approval. Traversal leaves directory-symlink targets untouched. Mounted trees, nested repositories, special files and non-full sparse checkouts cause refusal. A sparse checkout could otherwise contain tracked files that a final snapshot would miss.

The helper recognises a narrow set of jj local metadata and colocated Git worktree-registration files. Unknown entries cause refusal because deletion could discard user data. This also applies to external Git registration data removed by `jj workspace forget`. Compatibility with another jj metadata layout may require an allowlist update.

A Git index can contain staged content absent from working files and the final jj snapshot. For colocated checkouts, removal requires a readable index matching Git HEAD. A read-only Git CLI check uses the verified registration and index paths, disables external diff helpers and avoids optional index writes. Staged, conflicted or unreadable state causes refusal before closure. The check repeats before snapshot and forget. This is a deletion safety guard; Git staging controls remain outside the UI.

### Partial failure and races

Every failure stops later stages and reports the failing stage and confirmed completed stages. The failing stage can also have partial or unknown effects. A close can take effect before its response is lost, and a failed recursive deletion can already have removed files. There is no rollback or atomic transaction across the app, core and filesystem.

Repeated checks narrow races involving known resources. Unregistered writers, mount changes and simultaneous clients are outside a global lock. Any failure in a mutating stage requires inspecting the layout, terminal state, registration and remaining checkout. A normal retry may be impossible after the scope closes or the workspace is forgotten. A forgotten but retained directory needs deliberate manual recovery or cleanup. Review a fresh plan for any retry the manager still supports.

The app keeps the busy removal dialog open until the helper returns, then sends a result notification and closes it. The dialog remains available after the selected tab or space closes. Herdr cancels tasks when their mod copy unloads, including tasks with no view owner. Keeping the dialog alive preserves result delivery during the normal workflow. Force-closing or reloading that copy, or quitting the app, can interrupt reporting after the helper has already changed state; inspect those effects before retrying.

## Performance and future scope

Organizational rows and their menus start no repository work. The manager calls the helper after explicit selection or an operation. The optional CLI inspector exposes recorded change details and explicit snapshots without adding automatic UI refresh.

Any future background refresh must measure idle and burst cost, coalesce work, and separate working-file invalidation from jj-metadata invalidation. Events arriving during a refresh must remain pending. These requirements prevent snapshot feedback loops and lost updates; a fixed polling interval alone does not establish acceptable performance.

The location of repository summaries and the choice of a change inspector remain open. The supplied layout omits the shipped Git Changes panel, including its hidden poller. A read-only inspector or Hunk integration remains a possible follow-up.

Remote Create and Open use core remote execution with the helper installed on the target machine. Remote execution and Linux removal remain unverified. Remote removal and fully headless layout cleanup are unsupported. An app layout must not be reconstructed by editing core state files.

Streams integration remains separate work. Its eventual app/core adapter should reuse its existing projection; this project does not introduce another work catalog or summarizer. Workspace management also leaves agent completion, checkpointing, commits, pushes and merges to separate workflows.
