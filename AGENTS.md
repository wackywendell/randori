# Project guidance

## Goals

Provide jj-native workspace management for Herdr with low idle cost and explicit user control over destructive actions. Use jj's workspace, change, bookmark and conflict concepts throughout.

Treat spaces as organizational groups that can contain several repositories. Keep ordinary Close non-destructive and protect unrelated terminals and checkouts during workspace removal.

## Contributor rules

- Keep changes focused on the requested behavior. Surface API or design limitations before adding workarounds.
- Keep the helper in Rust and Herdr mods in JavaScript. Node is a development and test dependency.
- Keep design decisions and their rationale in `design/`. Put usage, installation and command contracts in `README.md`.
- Use `herdr-app --skill` and `hc --skill` to discover supported interfaces. Verify API assumptions before implementing changes.
- Own implementation, tests and documentation in this repository. Keep generated types, build output and fixture state out of source control.
- Use project-owned mod and layout names. Leave Herdr's shipped originals, generated API files and signed app bundle unchanged.
- Test lifecycle operations with disposable repositories, isolated app homes and separate core sessions. Tests must leave user terminals, checkouts and active layouts untouched.
- Read task configuration before running checks. Run `just verify` after code changes, including the native check for every mod. Measure performance claims with `just bench`.
- Distinguish fixture coverage from native lifecycle, visual and remote verification. State unverified behavior explicitly.
- Prefer jj for version control. Commit, publish, create remotes or open pull requests only when requested.

See [workspace management design](design/workspace-management.md) for the current architecture, safety model and deferred work.
