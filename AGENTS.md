# Project guidance

## Goals

Provide jj workspaces in Herdr as general-purpose mods with low idle cost and explicit control over destructive actions. Use jj's workspace, change, bookmark and conflict concepts throughout. Give each workspace its own space, nested under its main checkout's space. Keep ordinary Close non-destructive. Finish deletes only the checkouts you check, and names every terminal it ends before you confirm.

## Contributor rules

- Keep changes focused on the requested behavior. Surface API or design limitations before adding workarounds.
- Keep the work in Herdr mods in JavaScript. Node is a development and test dependency.
- Keep design decisions and their rationale in `design/`. Put usage, installation and command contracts in `README.md`.
- Use `herdr-app --skill` and `hc --skill` to discover supported interfaces. Verify API assumptions before implementing changes.
- Own implementation, tests and documentation in this repository. Keep generated types, build output and fixture state out of source control.
- Use project-owned mod and layout names. Leave Herdr's shipped originals, generated API files and signed app bundle unchanged.
- Test lifecycle operations with disposable repositories, isolated app homes and separate core sessions. Tests must leave user terminals, checkouts and active layouts untouched.
- Read task configuration before running checks. Run `just verify` after code changes, including the native check for every mod. Measure performance claims with `just bench`.
- Distinguish fixture coverage from native lifecycle, visual and remote verification. State unverified behavior explicitly.
- Prefer jj for version control. Commit, publish, create remotes or open pull requests only when requested.

See [jj workspace lifecycle design](design/jj-workspace-lifecycle.md) for the current architecture, safety model and staged work.
