use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};
use wait_timeout::ChildExt;

mod mounts;
const LIMIT: usize = 16 * 1024 * 1024;

fn output(mut reader: impl Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    let mut overflow = false;
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        if bytes.len() + n <= LIMIT {
            bytes.extend_from_slice(&buffer[..n]);
        } else {
            overflow = true;
        }
    }
    ensure!(!overflow, "Command output exceeded 16 MiB");
    Ok(bytes)
}

pub fn command(program: &str, args: &[&str], cwd: &Path) -> Result<(String, String)> {
    run_command(Command::new(program).args(args).current_dir(cwd), program)
}

fn run_command(command: &mut Command, program: &str) -> Result<(String, String)> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("Start {program}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || output(stdout));
    let err = thread::spawn(move || output(stderr));
    let status = match child.wait_timeout(Duration::from_secs(120))? {
        Some(status) => status,
        None => {
            child.kill()?;
            child.wait()?;
            bail!("{program} timed out; stopped before continuing");
        }
    };
    let stdout = String::from_utf8(
        out.join()
            .map_err(|_| anyhow::anyhow!("stdout reader failed"))??,
    )?;
    let stderr = String::from_utf8(
        err.join()
            .map_err(|_| anyhow::anyhow!("stderr reader failed"))??,
    )?;
    ensure!(
        status.success(),
        "{program}: {}",
        if stderr.is_empty() { &stdout } else { &stderr }
    );
    Ok((stdout, stderr))
}

fn jj(cwd: &Path, args: &[&str]) -> Result<(String, String)> {
    command(
        "jj",
        &[&["--no-pager", "--color=never"][..], args].concat(),
        cwd,
    )
}
fn text(path: &Path) -> Result<&str> {
    path.to_str().context("Non-UTF-8 paths are not supported")
}
fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn json_lines<T: for<'a> Deserialize<'a>>(output: &str) -> Result<Vec<T>> {
    output
        .lines()
        .filter(|s| !s.is_empty())
        .map(|line| Ok(serde_json::from_str(line)?))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Repo {
    pub root: PathBuf,
    pub repo: PathBuf,
    pub main: PathBuf,
    pub name: String,
    pub linked: bool,
}

pub fn discover(cwd: &Path) -> Result<Option<Repo>> {
    let mut root = cwd.canonicalize()?;
    loop {
        if present(&root.join(".jj"))? {
            let pointer = root.join(".jj/repo");
            let repo = if fs::metadata(&pointer)?.is_file() {
                root.join(".jj")
                    .join(fs::read_to_string(&pointer)?.trim())
                    .canonicalize()?
            } else {
                pointer.canonicalize()?
            };
            let main = repo
                .parent()
                .and_then(Path::parent)
                .context("Invalid repository path")?
                .canonicalize()?;
            // A linked/symlinked repository directory must still have the shared
            // checkout layout. Never infer a deletable main from an arbitrary store.
            ensure!(
                main.join(".jj/repo").canonicalize()? == repo,
                "Shared repository checkout is unavailable"
            );
            return Ok(Some(Repo {
                name: text(
                    main.file_name()
                        .context("Missing repository name")?
                        .as_ref(),
                )?
                .to_owned(),
                linked: main != root,
                root,
                repo,
                main,
            }));
        }
        if !root.pop() {
            return Ok(None);
        }
    }
}

const SUMMARY: &str = r#"if(current_workspace,
json(name) ++ "\n" ++ json(target.change_id().short(8)) ++ "\n" ++
json(target.description().first_line()) ++ "\n" ++
json(target.bookmarks().map(|b| b.name())) ++ "\n" ++
json(target.conflicted_files().len()) ++ "\n" ++ json(target.diff().files().len()) ++ "\n")"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    #[serde(flatten)]
    pub repo: Repo,
    pub kind: String,
    pub workspace: String,
    pub change: String,
    pub description: String,
    pub bookmarks: Vec<String>,
    pub conflicts: usize,
    pub files: usize,
    pub warning: String,
    pub watch: Vec<PathBuf>,
}

pub fn inspect(cwd: &Path, snapshot: bool) -> Result<Option<Summary>> {
    let Some(repo) = discover(cwd)? else {
        return Ok(None);
    };
    let mut args = vec!["workspace", "list", "-T", SUMMARY];
    if !snapshot {
        args.insert(0, "--ignore-working-copy");
    }
    let (stdout, warning) = jj(&repo.root, &args)?;
    let fields: Vec<serde_json::Value> = json_lines(&stdout)?;
    ensure!(
        fields.len() == 6,
        "Expected one current workspace; got {} summary fields",
        fields.len()
    );
    let watch = vec![
        repo.root.clone(),
        repo.repo.join("op_heads"),
        repo.root.join(".jj/working_copy"),
    ];
    Ok(Some(Summary {
        repo,
        kind: "jj".into(),
        workspace: serde_json::from_value(fields[0].clone())?,
        change: serde_json::from_value(fields[1].clone())?,
        description: serde_json::from_value(fields[2].clone())?,
        bookmarks: serde_json::from_value(fields[3].clone())?,
        conflicts: serde_json::from_value(fields[4].clone())?,
        files: serde_json::from_value(fields[5].clone())?,
        warning: warning.trim().into(),
        watch,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub name: String,
    pub root: Option<PathBuf>,
    pub current: bool,
    pub main: bool,
}

pub fn list(cwd: &Path) -> Result<Vec<Workspace>> {
    let repo = discover(cwd)?.context("Not a jj workspace")?;
    let template =
        r#""[" ++ json(name) ++ "," ++ json(root) ++ "," ++ json(current_workspace) ++ "]\n""#;
    let (out, _) = jj(
        &repo.root,
        &["--ignore-working-copy", "workspace", "list", "-T", template],
    )?;
    let rows: Vec<(String, Option<PathBuf>, bool)> = json_lines(&out)?;
    Ok(rows
        .into_iter()
        .map(|(name, root, current)| Workspace {
            main: root.as_ref() == Some(&repo.main),
            name,
            root,
            current,
        })
        .collect())
}

pub fn workspace_name(name: &str) -> Result<String> {
    let name = name.replace('/', "-");
    ensure!(
        name.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
        "Use letters, digits, dots, hyphens or underscores; start with a letter or digit"
    );
    Ok(name)
}

pub fn locate(cwd: &Path, requested: &str) -> Result<Option<Repo>> {
    let repo = discover(cwd)?.context("Not a jj workspace")?;
    let name = workspace_name(requested)?;
    for candidate in [
        repo.main.parent().unwrap().join("workspaces").join(&name),
        repo.main.join("workspaces").join(&name),
    ] {
        if !present(&candidate)? {
            continue;
        }
        let owner =
            discover(&candidate)?.context("Workspace path collision: not a jj workspace")?;
        ensure!(
            owner.repo == repo.repo && owner.root == candidate.canonicalize()?,
            "Workspace path collision at {}",
            candidate.display()
        );
        ensure!(
            list(&candidate)?
                .iter()
                .any(|w| w.current && w.name == name),
            "Path is not registered as workspace {name}"
        );
        return Ok(Some(owner));
    }
    Ok(None)
}

fn setup(main: &Path, root: &Path, name: &str) -> Result<()> {
    for file in [
        ".claude",
        "CLAUDE.md",
        "AGENTS.md",
        ".tool-versions",
        "Justfile",
        ".envrc",
        "mise.toml",
        "mise.local.toml",
    ] {
        if !present(&root.join(file))? && present(&main.join(file))? {
            // Canonical absolute targets also work when the workspace pool is
            // reached through a directory symlink.
            #[cfg(unix)]
            std::os::unix::fs::symlink(main.join(file), root.join(file))?;
            #[cfg(not(unix))]
            bail!("Configuration symlink setup is supported on Unix only");
        }
    }
    for file in ["CLAUDE.local.md", "AGENTS.local.md"] {
        if present(&root.join(file))? {
            continue;
        }
        let existing = if present(&main.join(file))? {
            fs::read_to_string(main.join(file))?
        } else {
            String::new()
        };
        use std::io::Write;
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(root.join(file))?;
        writeln!(
            output,
            "You are working in jj workspace '{name}'.\nYour working directory is the project root — do NOT edit files outside it.\n{existing}"
        )?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Created {
    #[serde(flatten)]
    pub repo: Repo,
    pub created: bool,
    pub start: Option<String>,
    pub note: String,
}

pub fn create(cwd: &Path, requested: &str, revision: Option<&str>) -> Result<Created> {
    let repo = discover(cwd)?.context("Not a jj workspace")?;
    let name = workspace_name(requested)?;
    if let Some(existing) = locate(cwd, requested)? {
        return Ok(Created {
            repo: existing,
            created: false,
            start: None,
            note: String::new(),
        });
    }
    let mut start = revision.map(str::to_owned);
    if start.is_none() {
        for rev in [
            requested.to_owned(),
            format!("{requested}@origin"),
            format!("{requested}@upstream"),
        ] {
            if jj(
                &repo.main,
                &[
                    "--ignore-working-copy",
                    "log",
                    "-r",
                    &rev,
                    "--no-graph",
                    "-T",
                    "commit_id",
                ],
            )
            .is_ok()
            {
                start = Some(rev);
                break;
            }
        }
    }
    let root = repo.main.parent().unwrap().join("workspaces").join(&name);
    fs::create_dir_all(root.parent().unwrap())?;
    fs::create_dir(&root).with_context(|| format!("Reserve workspace path {}", root.display()))?;
    let mut args = vec!["workspace", "add", text(&root)?, "--name", &name];
    if let Some(rev) = &start {
        args.extend(["-r", rev]);
    }
    jj(&repo.main, &args)
        .and_then(|_| setup(&repo.main, &root, &name))
        .with_context(|| format!("Creation may be partial at {}", root.display()))?;
    Ok(Created {
        repo: discover(&root)?.context("Created workspace is unavailable")?,
        created: true,
        start,
        note: "Shared configuration linked; approve direnv/mise configuration separately if needed"
            .into(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    Space,
    Tab,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scope {
    pub kind: ScopeKind,
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneTerminal {
    pub terminal: String,
    #[serde(default)]
    pub sub_agents: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tab {
    pub id: String,
    #[serde(default)]
    pub terminals: Vec<PaneTerminal>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Space {
    pub id: String,
    pub folder: PathBuf,
    pub machine: Option<String>,
    pub tabs: Vec<Tab>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Foreground {
    pub cwd: Option<PathBuf>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Terminal {
    pub address: String,
    pub state: String,
    pub cwd: PathBuf,
    pub foreground: Option<Foreground>,
    pub parent: Option<String>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}
#[derive(Debug, Clone)]
pub struct Inventory {
    pub spaces: Vec<Space>,
    pub terminals: Vec<Terminal>,
}

pub trait App {
    fn inventory(&mut self) -> Result<Inventory>;
    fn close(&mut self, scope: &Scope) -> Result<()>;
    fn kill(&mut self, terminal: &str) -> Result<()>;
}

pub struct LocalApp {
    pub cwd: PathBuf,
}
impl App for LocalApp {
    fn inventory(&mut self) -> Result<Inventory> {
        #[derive(Deserialize)]
        struct AppList {
            spaces: Vec<Space>,
        }
        #[derive(Deserialize)]
        struct CoreList {
            terminals: Vec<CoreRef>,
        }
        #[derive(Deserialize)]
        struct CoreRef {
            address: String,
        }
        let spaces =
            serde_json::from_str::<AppList>(&command("herdr-app", &["ls"], &self.cwd)?.0)?.spaces;
        let core: CoreList = serde_json::from_str(&command("hc", &["ls", "--json"], &self.cwd)?.0)?;
        let mut terminals = Vec::new();
        for t in core
            .terminals
            .into_iter()
            .filter(|t| !t.address.contains('/'))
        {
            terminals.push(serde_json::from_str(
                &command("hc", &["get", &t.address, "--json"], &self.cwd)?.0,
            )?);
        }
        Ok(Inventory { spaces, terminals })
    }
    fn close(&mut self, scope: &Scope) -> Result<()> {
        let name = match scope.kind {
            ScopeKind::Space => "space.close",
            ScopeKind::Tab => "tab.close",
        };
        command(
            "herdr-app",
            &[
                "do",
                name,
                &serde_json::json!({ "id": scope.id, "confirmed": true }).to_string(),
            ],
            &self.cwd,
        )?;
        Ok(())
    }
    fn kill(&mut self, terminal: &str) -> Result<()> {
        command("hc", &["kill", terminal, "--json"], &self.cwd)?;
        Ok(())
    }
}

fn scope_space<'a>(inv: &'a Inventory, scope: &Scope) -> Result<&'a Space> {
    inv.spaces
        .iter()
        .find(|s| match scope.kind {
            ScopeKind::Space => s.id == scope.id,
            ScopeKind::Tab => s.tabs.iter().any(|t| t.id == scope.id),
        })
        .context("Selected space/tab is not open")
}
fn scoped_tab(scope: &Scope, tab: &Tab) -> bool {
    matches!(scope.kind, ScopeKind::Space) || tab.id == scope.id
}
fn terminal_uses(t: &Terminal, root: &Path) -> Result<bool> {
    let dirs = [
        Some(&t.cwd),
        t.foreground.as_ref().and_then(|f| f.cwd.as_ref()),
    ];
    for dir in dirs.into_iter().flatten() {
        if dir.canonicalize()?.starts_with(root) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn folder(path: &Path) -> Result<PathBuf> {
    if path.as_os_str().is_empty() {
        PathBuf::from(std::env::var_os("HOME").context("Cannot resolve a home-folder space")?)
            .canonicalize()
            .map_err(Into::into)
    } else {
        path.canonicalize().map_err(Into::into)
    }
}

fn descendants(inv: &Inventory, mut ids: BTreeSet<String>) -> BTreeSet<String> {
    loop {
        let before = ids.len();
        for t in &inv.terminals {
            if t.parent.as_ref().is_some_and(|p| ids.contains(p)) {
                ids.insert(t.address.clone());
            }
        }
        if before == ids.len() {
            return ids;
        }
    }
}

fn check_users(
    repo: &Repo,
    inv: &Inventory,
    scope: &Scope,
    caller: Option<&str>,
) -> Result<BTreeSet<String>> {
    let space = scope_space(inv, scope)?;
    ensure!(space.machine.is_none(), "Remote removal is not supported");
    let tabs: BTreeSet<_> = space
        .tabs
        .iter()
        .filter(|t| scoped_tab(scope, t))
        .map(|t| t.id.as_str())
        .collect();
    let mut ids: BTreeSet<String> = space
        .tabs
        .iter()
        .filter(|t| scoped_tab(scope, t))
        .flat_map(|t| &t.terminals)
        .flat_map(|p| std::iter::once(p.terminal.clone()).chain(p.sub_agents.clone()))
        .collect();
    // Include parked/labeled roots as well as pane roots; the app may own them
    // even when its current inventory has no visible pane for the terminal.
    for t in &inv.terminals {
        let labelled = match scope.kind {
            ScopeKind::Space => t.labels.get("herdr.space") == Some(&space.id),
            ScopeKind::Tab => t
                .labels
                .get("herdr.tab")
                .is_some_and(|id| tabs.contains(id.as_str())),
        };
        if labelled {
            ids.insert(t.address.clone());
        }
    }
    ids = descendants(inv, ids);
    for t in inv.terminals.iter().filter(|t| ids.contains(&t.address)) {
        ensure!(
            t.labels.get("herdr.space").is_none_or(|id| id == &space.id),
            "Selected terminal belongs to another space: {}",
            t.address
        );
        ensure!(
            !matches!(scope.kind, ScopeKind::Tab)
                || t.labels.get("herdr.tab").is_none_or(|id| id == &scope.id),
            "Selected terminal belongs to another tab: {}",
            t.address
        );
    }
    for other in inv.spaces.iter().filter(|s| s.machine.is_none()) {
        for tab in &other.tabs {
            let selected = other.id == space.id && scoped_tab(scope, tab);
            if !selected {
                ensure!(
                    !tab.terminals.iter().any(|p| ids.contains(&p.terminal)
                        || p.sub_agents.iter().any(|id| ids.contains(id))),
                    "Selected descendant is also shown in another scope: {}",
                    tab.id
                );
            }
        }
    }
    ensure!(
        !ids.iter().any(|id| id.contains('/')),
        "A selected remote descendant needs separate cleanup"
    );
    ensure!(
        !caller.is_some_and(|id| ids.contains(id)),
        "Run removal outside the terminals being closed (use hc exec)"
    );
    let mut owns = folder(&space.folder)?.starts_with(&repo.root);
    for other in inv.spaces.iter().filter(|s| s.machine.is_none()) {
        let outside = other.id != space.id
            || (matches!(scope.kind, ScopeKind::Tab)
                && other.tabs.iter().any(|t| t.id != scope.id));
        ensure!(
            !outside || !folder(&other.folder)?.starts_with(&repo.root),
            "Another space/tab uses this checkout: {}",
            other.id
        );
    }
    for t in inv.terminals.iter().filter(|t| t.state == "live") {
        if terminal_uses(t, &repo.root)? {
            ensure!(
                ids.contains(&t.address),
                "Another terminal uses this checkout: {}",
                t.address
            );
            owns = true;
        }
    }
    ensure!(owns, "Selected scope does not use this checkout");
    Ok(ids)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Excluded {
    pub path: PathBuf,
    pub digest: String,
}
fn hex(hash: impl AsRef<[u8]>) -> String {
    hash.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
fn digest(value: &impl Serialize) -> Result<String> {
    Ok(hex(Sha256::digest(serde_json::to_vec(value)?)))
}

// jj 0.47 adds a colocated Git worktree by default. Only its verified
// pointer is metadata: a real .git directory may contain independent history.
fn validate_git_pointer(repo: &Repo) -> Result<()> {
    let file = repo.root.join(".git");
    if !present(&file)? {
        return Ok(());
    }
    ensure!(
        fs::symlink_metadata(&file)?.is_file(),
        "Root .git is not a shared worktree pointer"
    );
    let pointer = fs::read_to_string(&file)?;
    let target = pointer
        .trim()
        .strip_prefix("gitdir: ")
        .context("Invalid .git pointer")?;
    let gitdir = repo
        .root
        .join(target)
        .canonicalize()
        .context("Resolve Git worktree pointer")?;
    let shared = PathBuf::from(
        jj(&repo.root, &["--ignore-working-copy", "git", "root"])?
            .0
            .trim(),
    )
    .canonicalize()?;
    let common =
        fs::read_to_string(gitdir.join("commondir")).context("Read shared Git directory")?;
    ensure!(
        gitdir.join(common.trim()).canonicalize()? == shared
            && gitdir.starts_with(shared.join("worktrees")),
        "Git worktree pointer does not belong to the shared repository"
    );
    let backlink = fs::read_to_string(gitdir.join("gitdir"))?;
    ensure!(
        gitdir.join(backlink.trim()).canonicalize()? == file.canonicalize()?,
        "Git worktree backlink mismatch"
    );
    // workspace forget also removes this external registration directory. Stop
    // on user additions or worktree-local refs whose preservation is unknown.
    for entry in fs::read_dir(&gitdir)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == "refs" {
            ensure!(
                entry.file_type()?.is_dir() && fs::read_dir(entry.path())?.next().is_none(),
                "Worktree-local refs require inspection before removal"
            );
        } else if name == "logs" {
            ensure!(
                entry.file_type()?.is_dir(),
                "Git worktree logs must be a real directory"
            );
            for log in fs::read_dir(entry.path())? {
                let log = log?;
                ensure!(
                    log.file_name() == "HEAD" && log.file_type()?.is_file(),
                    "Unknown Git worktree log data; checkout retained: {}",
                    log.path().display()
                );
            }
        } else {
            ensure!(
                ["commondir", "gitdir", "HEAD", "index"]
                    .iter()
                    .any(|allowed| name == *allowed)
                    && entry.file_type()?.is_file(),
                "Unknown Git worktree metadata; checkout retained: {}",
                entry.path().display()
            );
        }
    }
    // The index can hold content absent from the working files and final jj
    // snapshot. Pin inspection to this registration, not inherited Git paths.
    run_command(
        Command::new("git")
            .args([
                "--git-dir", text(&gitdir)?, "--work-tree", text(&repo.root)?,
                "-c", "core.fsmonitor=false", "diff", "--cached", "--quiet",
                "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--",
            ])
            .env("GIT_INDEX_FILE", gitdir.join("index"))
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_NAMESPACE")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .current_dir(&repo.root),
        "git",
    ).context("Git index must match HEAD before removal; resolve staged/conflicted state or fix Git inspection (Git CLI required)")?;
    Ok(())
}

// Removal supports the observed jj 0.47 local-working-copy layout. Unknown
// metadata may be user data or a newer format, so stop rather than deleting it.
fn validate_workspace_metadata(root: &Path) -> Result<()> {
    let metadata = root.join(".jj");
    ensure!(
        fs::symlink_metadata(&metadata)?.is_dir(),
        "Workspace .jj must be a real directory"
    );
    for entry in fs::read_dir(&metadata)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        if name == "working_copy" {
            ensure!(
                kind.is_dir(),
                "Workspace working_copy must be a real directory"
            );
            for state in fs::read_dir(entry.path())? {
                let state = state?;
                ensure!(
                    ["checkout", "tree_state", "type"]
                        .iter()
                        .any(|name| state.file_name() == *name)
                        && state.file_type()?.is_file(),
                    "Unknown workspace metadata; checkout retained: {}",
                    state.path().display()
                );
            }
            let backend = fs::read(entry.path().join("type"))?;
            ensure!(
                backend == b"local" || backend == b"local\n",
                "Unsupported working-copy backend"
            );
        } else {
            ensure!(
                (name == "repo" || name == ".gitignore") && kind.is_file(),
                "Unknown workspace metadata; checkout retained: {}",
                entry.path().display()
            );
            if name == ".gitignore" {
                let ignore = fs::read(entry.path())?;
                ensure!(
                    ignore == b"/*" || ignore == b"/*\n",
                    "Custom .jj/.gitignore content is not removable"
                );
            }
        }
    }
    Ok(())
}

fn excluded(repo: &Repo) -> Result<Vec<Excluded>> {
    // A tracked file manually written outside the sparse set can be omitted by
    // snapshots despite appearing in the manifest. Refuse this unsupported case.
    ensure!(
        jj(&repo.root, &["--ignore-working-copy", "sparse", "list"])?
            .0
            .trim()
            == ".",
        "Removal requires a full sparse checkout; excluded tracked paths cannot be verified"
    );
    mounts::check(&repo.root)?;
    validate_workspace_metadata(&repo.root)?;
    validate_git_pointer(repo)?;
    let (out, _) = jj(
        &repo.root,
        &[
            "--ignore-working-copy",
            "file",
            "list",
            "-T",
            r#"json(path) ++ "\n""#,
        ],
    )?;
    let tracked: BTreeSet<PathBuf> = json_lines::<PathBuf>(&out)?.into_iter().collect();
    let mut files = Vec::new();
    fn walk(
        root: &Path,
        dir: &Path,
        tracked: &BTreeSet<PathBuf>,
        files: &mut Vec<Excluded>,
    ) -> Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let abs = entry.path();
            let rel = abs.strip_prefix(root)?;
            if rel == Path::new(".jj") || rel == Path::new(".git") {
                continue;
            }
            ensure!(
                entry.file_name() != ".git" && entry.file_name() != ".jj",
                "Nested VCS metadata is not removable: {}",
                rel.display()
            );
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(root, &abs, tracked, files)?;
                continue;
            }
            ensure!(
                kind.is_file() || kind.is_symlink(),
                "Special file is not removable: {}",
                rel.display()
            );
            if !tracked.contains(rel) {
                let mut hash = Sha256::new();
                if kind.is_symlink() {
                    hash.update(b"symlink\0");
                    hash.update(text(&fs::read_link(&abs)?)?.as_bytes());
                } else {
                    hash.update(b"file\0");
                    let mut file = File::open(&abs)?;
                    let mut buffer = [0; 65536];
                    loop {
                        let n = file.read(&mut buffer)?;
                        if n == 0 {
                            break;
                        }
                        hash.update(&buffer[..n]);
                    }
                }
                files.push(Excluded {
                    path: rel.into(),
                    digest: hex(hash.finalize()),
                });
            }
        }
        Ok(())
    }
    walk(&repo.root, &repo.root, &tracked, &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

#[derive(Debug, Clone, Serialize)]
pub struct RemovalPlan {
    #[serde(flatten)]
    pub repo: Repo,
    pub workspace: String,
    pub scope: Scope,
    pub terminals: BTreeSet<String>,
    pub excluded: Vec<Excluded>,
    pub approval: String,
    pub identity: (u64, u64),
}
fn identity(root: &Path) -> Result<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let s = fs::symlink_metadata(root)?;
        Ok((s.dev(), s.ino()))
    }
    #[cfg(not(unix))]
    {
        bail!("Workspace removal is supported on Unix only")
    }
}

pub fn plan_removal(
    cwd: &Path,
    scope: &Scope,
    app: &mut impl App,
    caller: Option<&str>,
) -> Result<RemovalPlan> {
    let repo = discover(cwd)?.context("Not a jj workspace")?;
    ensure!(
        repo.linked,
        "Main/shared-repository checkout cannot be removed"
    );
    ensure!(
        cwd.canonicalize()? == repo.root,
        "Removal --cwd must be the exact workspace root"
    );
    let workspace = list(&repo.root)?
        .into_iter()
        .find(|w| w.current)
        .context("Workspace is not registered")?;
    ensure!(
        workspace
            .root
            .context("Workspace has no registered root")?
            .canonicalize()?
            == repo.root,
        "Workspace registration/root does not match"
    );
    let terminals = check_users(&repo, &app.inventory()?, scope, caller)?;
    let excluded = excluded(&repo)?;
    let identity = identity(&repo.root)?;
    let approval = digest(&(
        &repo,
        &workspace.name,
        scope,
        &terminals,
        &excluded,
        identity,
    ))?;
    Ok(RemovalPlan {
        repo,
        workspace: workspace.name,
        scope: scope.clone(),
        terminals,
        excluded,
        approval,
        identity,
    })
}

pub struct RemoveOptions<'a> {
    pub yes: bool,
    pub approval: &'a str,
    pub discard_excluded: bool,
    pub caller: Option<&'a str>,
}
#[derive(Debug, Serialize)]
pub struct Removed {
    pub root: PathBuf,
    pub completed: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct RemovalFailure {
    pub error: String,
    pub stage: &'static str,
    pub completed: Vec<&'static str>,
}
impl std::fmt::Display for RemovalFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.error)
    }
}
impl std::error::Error for RemovalFailure {}

pub fn remove(
    cwd: &Path,
    scope: &Scope,
    options: RemoveOptions<'_>,
    app: &mut impl App,
) -> Result<Removed> {
    ensure!(
        options.yes && !options.approval.is_empty(),
        "Review remove-plan, then pass --yes --approval TOKEN"
    );
    let mut stage = "preflight";
    let mut completed = Vec::new();
    let result = (|| {
        let plan = plan_removal(cwd, scope, app, options.caller)?;
        ensure!(
            !std::env::current_dir()?
                .canonicalize()?
                .starts_with(&plan.repo.root),
            "Run the helper from outside the checkout being removed"
        );
        ensure!(
            plan.approval == options.approval,
            "Checkout or its users changed; review a fresh remove-plan"
        );
        ensure!(
            plan.excluded.is_empty() || options.discard_excluded,
            "Files outside the snapshot exist; review them and pass --discard-excluded"
        );
        stage = "close";
        app.close(scope)?;
        completed.push("closed layout scope");
        stage = "stop writers";
        let inv = app.inventory()?;
        ensure!(
            descendants(&inv, plan.terminals.clone()) == plan.terminals,
            "New selected descendants appeared after confirmation; checkout retained"
        );
        for id in &plan.terminals {
            if inv
                .terminals
                .iter()
                .any(|t| &t.address == id && t.state == "live")
            {
                app.kill(id)?;
            }
        }
        let inv = app.inventory()?;
        ensure!(
            descendants(&inv, plan.terminals.clone()) == plan.terminals,
            "New selected descendants appeared while stopping writers; checkout retained"
        );
        ensure!(
            scope_space(&inv, scope).is_err(),
            "Selected layout scope is still open"
        );
        ensure!(
            !inv.terminals
                .iter()
                .any(|t| plan.terminals.contains(&t.address) && t.state == "live"),
            "Selected terminals have not finished; checkout retained"
        );
        for s in inv.spaces.iter().filter(|s| s.machine.is_none()) {
            ensure!(
                !folder(&s.folder)?.starts_with(&plan.repo.root),
                "Checkout still in a space: {}",
                s.id
            );
        }
        for t in inv.terminals.iter().filter(|t| t.state == "live") {
            ensure!(
                !terminal_uses(t, &plan.repo.root)?,
                "New checkout user: {}",
                t.address
            );
        }
        completed.push("stopped selected terminals");
        stage = "snapshot";
        ensure!(
            discover(&plan.repo.root)?.as_ref() == Some(&plan.repo)
                && identity(&plan.repo.root)? == plan.identity,
            "Workspace identity changed before snapshot"
        );
        validate_git_pointer(&plan.repo)?;
        jj(&plan.repo.root, &["util", "snapshot"])?;
        completed.push("final snapshot");
        stage = "verify snapshot";
        let approved: BTreeMap<_, _> = plan.excluded.iter().map(|f| (&f.path, &f.digest)).collect();
        ensure!(
            excluded(&plan.repo)?
                .iter()
                .all(|f| approved.get(&f.path) == Some(&&f.digest)),
            "New or changed excluded files appeared; checkout retained for review"
        );
        ensure!(
            discover(&plan.repo.root)?.as_ref() == Some(&plan.repo)
                && identity(&plan.repo.root)? == plan.identity,
            "Workspace identity changed"
        );
        stage = "forget";
        let registration = list(&plan.repo.root)?
            .into_iter()
            .find(|w| w.current)
            .context("Workspace registration disappeared")?;
        ensure!(
            registration.name == plan.workspace
                && registration
                    .root
                    .as_ref()
                    .map(|p| p.canonicalize())
                    .transpose()?
                    .as_ref()
                    == Some(&plan.repo.root),
            "Workspace registration changed; checkout retained"
        );
        mounts::check(&plan.repo.root)?;
        validate_git_pointer(&plan.repo)?;
        jj(
            &plan.repo.main,
            &[
                "--ignore-working-copy",
                "workspace",
                "forget",
                &plan.workspace,
            ],
        )?;
        completed.push("forgot workspace");
        stage = "delete checkout";
        mounts::check(&plan.repo.root)?;
        validate_workspace_metadata(&plan.repo.root)?;
        ensure!(
            identity(&plan.repo.root)? == plan.identity,
            "Checkout was replaced after forget"
        );
        fs::remove_dir_all(&plan.repo.root)?;
        completed.push("deleted checkout");
        Ok(Removed {
            root: plan.repo.root,
            completed: completed.clone(),
        })
    })();
    result.map_err(|cause: anyhow::Error| {
        RemovalFailure {
            error: format!(
                "Stopped at {stage}. Confirmed completed stages: {}. A failing mutating stage may have partial or unknown effects; inspect the layout, registration and remaining checkout before retry or manual cleanup. {cause:#}",
                if completed.is_empty() {
                    "none".into()
                } else {
                    completed.join(", ")
                }
            ),
            stage,
            completed,
        }
        .into()
    })
}
