use anyhow::{Result, bail};
use herdr_jj::*;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    main: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().canonicalize().unwrap().join("project");
        command(
            "jj",
            &["git", "init", "--colocate", main.to_str().unwrap()],
            temp.path(),
        )
        .unwrap();
        for (key, value) in [
            ("user.name", "Fixture"),
            ("user.email", "fixture@example.invalid"),
            ("signing.behavior", "drop"),
            ("snapshot.auto-track", "all()"),
            ("snapshot.max-new-file-size", "1MiB"),
        ] {
            command("jj", &["config", "set", "--repo", key, value], &main).unwrap();
        }
        Self { _temp: temp, main }
    }
    fn workspace(&self) -> Repo {
        let repo = create(&self.main, "topic", None).unwrap().repo;
        fs::write(repo.root.join("file"), "before").unwrap();
        fs::write(repo.root.join(".gitignore"), "ignored\n").unwrap();
        // Explicitly track our generated fixture notes, independently of the
        // developer's global ignore rules. The ignored-data tests add their own.
        command(
            "jj",
            &[
                "file",
                "track",
                "--include-ignored",
                "AGENTS.local.md",
                "CLAUDE.local.md",
                "file",
                ".gitignore",
            ],
            &repo.root,
        )
        .unwrap();
        inspect(&repo.root, true).unwrap();
        repo
    }
}
fn scope() -> Scope {
    Scope {
        kind: ScopeKind::Space,
        id: "owned-space".into(),
    }
}
fn terminal(id: &str, root: &Path, parent: Option<&str>) -> Terminal {
    Terminal {
        address: id.into(),
        cwd: root.into(),
        foreground: Some(Foreground {
            cwd: Some(root.into()),
        }),
        parent: parent.map(str::to_owned),
        state: "live".into(),
        labels: BTreeMap::new(),
    }
}
fn space(id: &str, root: &Path, terminal: &str) -> Space {
    Space {
        id: id.into(),
        folder: root.into(),
        machine: None,
        tabs: vec![Tab {
            id: format!("{id}-tab"),
            terminals: vec![PaneTerminal {
                terminal: terminal.into(),
                sub_agents: vec![],
            }],
        }],
    }
}
struct FakeApp {
    inv: Inventory,
    events: Vec<String>,
    root: PathBuf,
    on_close: Option<Box<dyn FnOnce() -> Result<()>>>,
    fail_close: bool,
    leave_live: bool,
    spawn_child: bool,
}
impl FakeApp {
    fn new(repo: &Repo) -> Self {
        Self {
            inv: Inventory {
                spaces: vec![space("owned-space", &repo.root, "owned-root")],
                terminals: vec![
                    terminal("owned-root", &repo.root, None),
                    terminal("owned-child", &repo.root, Some("owned-root")),
                ],
            },
            events: vec![],
            root: repo.root.clone(),
            on_close: None,
            fail_close: false,
            leave_live: false,
            spawn_child: false,
        }
    }
}
impl App for FakeApp {
    fn inventory(&mut self) -> Result<Inventory> {
        Ok(self.inv.clone())
    }
    fn close(&mut self, scope: &Scope) -> Result<()> {
        self.events.push("close".into());
        if self.fail_close {
            bail!("fixture close failed");
        }
        if let Some(action) = self.on_close.take() {
            action()?;
        }
        fs::write(self.root.join("file"), "final writer edit")?;
        if self.spawn_child {
            self.inv.terminals.push(terminal(
                "new-child",
                self.root.parent().unwrap(),
                Some("owned-root"),
            ));
        }
        match scope.kind {
            ScopeKind::Space => self.inv.spaces.retain(|s| s.id != scope.id),
            ScopeKind::Tab => {
                for space in &mut self.inv.spaces {
                    space.tabs.retain(|t| t.id != scope.id);
                }
                self.inv.spaces.retain(|s| !s.tabs.is_empty());
            }
        }
        Ok(())
    }
    fn kill(&mut self, id: &str) -> Result<()> {
        self.events.push(format!("kill {id}"));
        if !self.leave_live {
            self.inv
                .terminals
                .iter_mut()
                .find(|t| t.address == id)
                .unwrap()
                .state = "finished".into();
        }
        Ok(())
    }
}
fn options(approval: &str, discard_excluded: bool) -> RemoveOptions<'_> {
    RemoveOptions {
        yes: true,
        approval,
        discard_excluded,
        caller: None,
    }
}

#[test]
fn discovery_and_metadata_reads_do_not_snapshot() {
    let f = Fixture::new();
    assert!(discover(f.main.parent().unwrap()).unwrap().is_none());
    let initial = inspect(&f.main, false).unwrap().unwrap();
    assert_eq!(initial.kind, "jj");
    assert_eq!(initial.workspace, "default");
    assert!(!initial.repo.linked);
    fs::write(f.main.join("file"), "hello").unwrap();
    assert_eq!(inspect(&f.main, false).unwrap().unwrap().files, 0);
    assert_eq!(inspect(&f.main, true).unwrap().unwrap().files, 1);
    assert_eq!(list(&f.main).unwrap()[0].root.as_ref(), Some(&f.main));
}

#[test]
fn create_reuse_configuration_and_collisions() {
    let f = Fixture::new();
    fs::write(f.main.join("AGENTS.md"), "instructions").unwrap();
    fs::write(f.main.join(".tool-versions"), "rust 1.99.1\n").unwrap();
    let result = create(&f.main, "topic/new", None).unwrap();
    assert_eq!(
        result.repo.root,
        f.main.parent().unwrap().join("workspaces/topic-new")
    );
    assert_eq!(
        fs::read_to_string(result.repo.root.join("AGENTS.md")).unwrap(),
        "instructions"
    );
    assert_eq!(
        fs::read_to_string(result.repo.root.join(".tool-versions")).unwrap(),
        "rust 1.99.1\n"
    );
    assert!(
        fs::read_to_string(result.repo.root.join("AGENTS.local.md"))
            .unwrap()
            .contains("topic-new")
    );
    assert_eq!(
        inspect(&result.repo.root, false)
            .unwrap()
            .unwrap()
            .workspace,
        "topic-new"
    );
    assert!(!create(&f.main, "topic/new", None).unwrap().created);
    assert_eq!(
        locate(&f.main, "topic/new").unwrap().unwrap().root,
        result.repo.root
    );
    fs::create_dir(f.main.parent().unwrap().join("workspaces/collision")).unwrap();
    assert!(create(&f.main, "collision", None).is_err());
    assert!(workspace_name("../escape").is_err());
    assert!(workspace_name("--option").is_err());
    let foreign = Fixture::new();
    command(
        "jj",
        &[
            "workspace",
            "add",
            f.main
                .parent()
                .unwrap()
                .join("workspaces/foreign")
                .to_str()
                .unwrap(),
            "--name",
            "foreign",
        ],
        &foreign.main,
    )
    .unwrap();
    assert!(create(&f.main, "foreign", None).is_err());
}

#[test]
fn legacy_lookup_and_explicit_revision() {
    let f = Fixture::new();
    let legacy = f.main.join("workspaces/old");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    command(
        "jj",
        &[
            "workspace",
            "add",
            legacy.to_str().unwrap(),
            "--name",
            "old",
        ],
        &f.main,
    )
    .unwrap();
    assert_eq!(locate(&f.main, "old").unwrap().unwrap().root, legacy);
    let result = create(&f.main, "explicit", Some("root()")).unwrap();
    assert_eq!(result.start.as_deref(), Some("root()"));
    let invalid = create(&f.main, "invalid-revision", Some("no-such-revision"))
        .err()
        .unwrap();
    assert!(format!("{invalid:#}").contains("partial"));
    assert!(
        f.main
            .parent()
            .unwrap()
            .join("workspaces/invalid-revision")
            .exists()
    );
}

#[test]
fn mechanical_removal_stops_writers_then_preserves_final_edit() {
    let f = Fixture::new();
    let repo = f.workspace();
    let change = inspect(&repo.root, false).unwrap().unwrap().change;
    let mut app = FakeApp::new(&repo);
    let plan = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    assert!(plan.excluded.is_empty());
    let result = remove(
        &repo.root,
        &scope(),
        options(&plan.approval, false),
        &mut app,
    )
    .unwrap();
    assert_eq!(app.events, ["close", "kill owned-child", "kill owned-root"]);
    assert_eq!(
        result.completed,
        [
            "closed layout scope",
            "stopped selected terminals",
            "final snapshot",
            "forgot workspace",
            "deleted checkout"
        ]
    );
    assert!(!repo.root.exists());
    assert!(!list(&f.main).unwrap().iter().any(|w| w.name == "topic"));
    assert!(!f.main.join(".git/worktrees/topic").exists());
    let (content, _) = command(
        "jj",
        &[
            "--ignore-working-copy",
            "file",
            "show",
            "-r",
            &change,
            "file",
        ],
        &f.main,
    )
    .unwrap();
    assert_eq!(content, "final writer edit");
}

#[test]
fn reject_main_other_users_and_removing_caller_before_close() {
    let f = Fixture::new();
    let repo = f.workspace();
    let mut app = FakeApp::new(&repo);
    assert!(plan_removal(&f.main, &scope(), &mut app, None).is_err());
    assert!(plan_removal(&repo.root, &scope(), &mut app, Some("owned-child")).is_err());
    app.inv
        .terminals
        .push(terminal("other-user", &repo.root, None));
    assert!(plan_removal(&repo.root, &scope(), &mut app, None).is_err());
    app.inv.terminals.pop();
    app.inv
        .spaces
        .push(space("other-space", &repo.root, "other"));
    assert!(plan_removal(&repo.root, &scope(), &mut app, None).is_err());
    assert!(app.events.is_empty());
    assert!(repo.root.exists());
}

#[test]
fn excluded_approval_and_changed_plan_fail_before_close() {
    let f = Fixture::new();
    let repo = f.workspace();
    fs::write(repo.root.join("ignored"), "private data").unwrap();
    let mut app = FakeApp::new(&repo);
    let plan = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    assert_eq!(plan.excluded.len(), 1);
    assert!(
        remove(
            &repo.root,
            &scope(),
            options(&plan.approval, false),
            &mut app
        )
        .is_err()
    );
    fs::write(repo.root.join("ignored"), "changed data").unwrap();
    assert!(
        remove(
            &repo.root,
            &scope(),
            options(&plan.approval, true),
            &mut app
        )
        .is_err()
    );
    assert!(app.events.is_empty());
    let fresh = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    remove(
        &repo.root,
        &scope(),
        options(&fresh.approval, true),
        &mut app,
    )
    .unwrap();
}

#[test]
fn excluded_drift_after_close_reports_partial_completion() {
    let f = Fixture::new();
    let repo = f.workspace();
    let root = repo.root.clone();
    fs::write(root.join("ignored"), "before").unwrap();
    let mut app = FakeApp::new(&repo);
    let plan = plan_removal(&root, &scope(), &mut app, None).unwrap();
    app.on_close = Some(Box::new(move || {
        fs::write(root.join("ignored"), "after")?;
        Ok(())
    }));
    let error = remove(
        &repo.root,
        &scope(),
        options(&plan.approval, true),
        &mut app,
    )
    .unwrap_err();
    let message = format!("{error:#}");
    assert!(message.contains("Stopped at verify snapshot"), "{message}");
    assert!(message.contains("closed layout scope"));
    let failure = error.downcast_ref::<RemovalFailure>().unwrap();
    assert_eq!(failure.stage, "verify snapshot");
    assert_eq!(
        failure.completed,
        [
            "closed layout scope",
            "stopped selected terminals",
            "final snapshot"
        ]
    );
    assert!(repo.root.exists());
    assert!(list(&f.main).unwrap().iter().any(|w| w.name == "topic"));
}

#[test]
fn close_failure_and_live_terminal_do_not_forget_or_delete() {
    let f = Fixture::new();
    let repo = f.workspace();
    let mut app = FakeApp::new(&repo);
    let plan = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    app.fail_close = true;
    assert!(
        format!(
            "{:#}",
            remove(
                &repo.root,
                &scope(),
                options(&plan.approval, false),
                &mut app
            )
            .unwrap_err()
        )
        .contains("Stopped at close")
    );
    app.fail_close = false;
    app.leave_live = true;
    assert!(
        format!(
            "{:#}",
            remove(
                &repo.root,
                &scope(),
                options(&plan.approval, false),
                &mut app
            )
            .unwrap_err()
        )
        .contains("Stopped at stop writers")
    );
    assert!(repo.root.exists());
    assert!(list(&f.main).unwrap().iter().any(|w| w.name == "topic"));
}

#[cfg(unix)]
#[test]
fn symlinks_are_not_followed_and_nested_repositories_are_refused() {
    let f = Fixture::new();
    let repo = f.workspace();
    let outside = f.main.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("precious"), "keep").unwrap();
    std::os::unix::fs::symlink(&outside, repo.root.join("ignored")).unwrap();
    let mut app = FakeApp::new(&repo);
    let plan = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    remove(
        &repo.root,
        &scope(),
        options(&plan.approval, true),
        &mut app,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(outside.join("precious")).unwrap(),
        "keep"
    );
    let repo = f.workspace();
    fs::create_dir_all(repo.root.join("nested/.git")).unwrap();
    let mut app = FakeApp::new(&repo);
    assert!(
        format!(
            "{:#}",
            plan_removal(&repo.root, &scope(), &mut app, None).unwrap_err()
        )
        .contains("Nested VCS")
    );
}

#[test]
fn descendant_shown_in_another_scope_is_not_owned_by_removal() {
    let f = Fixture::new();
    let repo = f.workspace();
    let mut app = FakeApp::new(&repo);
    app.inv
        .spaces
        .push(space("outside-scope", &f.main, "owned-child"));
    let error = plan_removal(&repo.root, &scope(), &mut app, None).unwrap_err();
    assert!(format!("{error:#}").contains("another scope"));
    assert!(app.events.is_empty());
}

#[test]
fn registration_reassignment_during_close_does_not_forget_the_new_workspace() {
    let f = Fixture::new();
    let repo = f.workspace();
    let main = f.main.clone();
    let alternate = main.parent().unwrap().join("alternate");
    let destination = alternate.clone();
    let mut app = FakeApp::new(&repo);
    let plan = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    app.on_close = Some(Box::new(move || {
        command("jj", &["workspace", "forget", "topic"], &main)?;
        command(
            "jj",
            &[
                "workspace",
                "add",
                destination.to_str().unwrap(),
                "--name",
                "topic",
            ],
            &main,
        )?;
        Ok(())
    }));
    assert!(
        remove(
            &repo.root,
            &scope(),
            options(&plan.approval, false),
            &mut app
        )
        .is_err()
    );
    assert!(repo.root.exists());
    assert_eq!(
        list(&f.main)
            .unwrap()
            .into_iter()
            .find(|w| w.name == "topic")
            .unwrap()
            .root,
        Some(alternate)
    );
}

#[test]
fn tab_removal_leaves_unrelated_space_tabs_and_terminals_open() {
    let f = Fixture::new();
    let repo = f.workspace();
    let mut app = FakeApp::new(&repo);
    app.inv.spaces[0].folder = f.main.clone();
    app.inv.spaces[0].tabs.push(Tab {
        id: "outside-tab".into(),
        terminals: vec![PaneTerminal {
            terminal: "outside".into(),
            sub_agents: vec![],
        }],
    });
    app.inv.terminals.push(terminal("outside", &f.main, None));
    let scope = Scope {
        kind: ScopeKind::Tab,
        id: "owned-space-tab".into(),
    };
    let plan = plan_removal(&repo.root, &scope, &mut app, None).unwrap();
    remove(&repo.root, &scope, options(&plan.approval, false), &mut app).unwrap();
    assert_eq!(app.inv.spaces.len(), 1);
    assert_eq!(app.inv.spaces[0].tabs[0].id, "outside-tab");
    assert_eq!(
        app.inv
            .terminals
            .iter()
            .find(|t| t.address == "outside")
            .unwrap()
            .state,
        "live"
    );
}

#[test]
fn sparse_checkouts_are_refused_before_any_scope_is_closed() {
    let f = Fixture::new();
    let repo = f.workspace();
    command(
        "jj",
        &["sparse", "set", "--clear", "--add", "file"],
        &repo.root,
    )
    .unwrap();
    let mut app = FakeApp::new(&repo);
    assert!(
        format!(
            "{:#}",
            plan_removal(&repo.root, &scope(), &mut app, None).unwrap_err()
        )
        .contains("full sparse checkout")
    );
    assert!(app.events.is_empty());
}

#[test]
fn conflicting_descendant_labels_are_other_ownership_even_without_a_pane() {
    let f = Fixture::new();
    let repo = f.workspace();
    let mut app = FakeApp::new(&repo);
    app.inv.terminals[1]
        .labels
        .insert("herdr.space".into(), "another-space".into());
    assert!(
        format!(
            "{:#}",
            plan_removal(&repo.root, &scope(), &mut app, None).unwrap_err()
        )
        .contains("another space")
    );
    assert!(app.events.is_empty());
}

#[test]
fn new_descendants_after_close_stop_cleanup_before_snapshot() {
    let f = Fixture::new();
    let repo = f.workspace();
    let mut app = FakeApp::new(&repo);
    let plan = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    app.spawn_child = true;
    let error = remove(
        &repo.root,
        &scope(),
        options(&plan.approval, false),
        &mut app,
    )
    .unwrap_err();
    assert!(format!("{error:#}").contains("New selected descendants"));
    assert!(repo.root.exists());
    assert!(list(&f.main).unwrap().iter().any(|w| w.name == "topic"));
}

#[test]
fn unrelated_home_folder_spaces_do_not_block_removal_planning() {
    let f = Fixture::new();
    let repo = f.workspace();
    let mut app = FakeApp::new(&repo);
    app.inv
        .spaces
        .push(space("home-space", Path::new(""), "outside"));
    assert!(plan_removal(&repo.root, &scope(), &mut app, None).is_ok());
}

#[test]
fn unknown_workspace_metadata_is_never_silently_discarded() {
    let f = Fixture::new();
    let repo = f.workspace();
    let mut app = FakeApp::new(&repo);
    for name in [".jj/notes.txt", ".jj/working_copy/notes.txt"] {
        fs::write(repo.root.join(name), "valuable untracked notes").unwrap();
        let error = plan_removal(&repo.root, &scope(), &mut app, None).unwrap_err();
        assert!(format!("{error:#}").contains("Unknown workspace metadata"));
        assert!(app.events.is_empty());
        fs::remove_file(repo.root.join(name)).unwrap();
    }
    let plan = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    let root = repo.root.clone();
    app.on_close = Some(Box::new(move || {
        fs::write(root.join(".jj/notes.txt"), "notes created while closing")?;
        Ok(())
    }));
    assert!(
        remove(
            &repo.root,
            &scope(),
            options(&plan.approval, false),
            &mut app
        )
        .is_err()
    );
    assert_eq!(
        fs::read_to_string(repo.root.join(".jj/notes.txt")).unwrap(),
        "notes created while closing"
    );
    assert!(list(&f.main).unwrap().iter().any(|w| w.name == "topic"));
}

#[cfg(unix)]
#[test]
fn excluded_symlink_changed_to_a_file_with_identical_bytes_stops_removal() {
    let f = Fixture::new();
    let repo = f.workspace();
    std::os::unix::fs::symlink("hello", repo.root.join("ignored")).unwrap();
    let mut app = FakeApp::new(&repo);
    let plan = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    let root = repo.root.clone();
    app.on_close = Some(Box::new(move || {
        fs::remove_file(root.join("ignored"))?;
        fs::write(root.join("ignored"), "hello")?;
        Ok(())
    }));
    let error = remove(
        &repo.root,
        &scope(),
        options(&plan.approval, true),
        &mut app,
    )
    .unwrap_err();
    assert!(format!("{error:#}").contains("New or changed excluded files"));
    assert!(repo.root.exists());
    assert!(list(&f.main).unwrap().iter().any(|w| w.name == "topic"));
}

#[test]
fn unknown_external_git_registration_data_is_never_silently_discarded() {
    let f = Fixture::new();
    let repo = f.workspace();
    fs::write(
        f.main.join(".git/worktrees/topic/notes.txt"),
        "valuable worktree notes",
    )
    .unwrap();
    let mut app = FakeApp::new(&repo);
    assert!(
        format!(
            "{:#}",
            plan_removal(&repo.root, &scope(), &mut app, None).unwrap_err()
        )
        .contains("Unknown Git worktree metadata")
    );
    assert!(app.events.is_empty());
}

#[test]
fn default_git_head_reflog_is_metadata_but_unknown_siblings_are_not() {
    let f = Fixture::new();
    command(
        "git",
        &["config", "--local", "core.logAllRefUpdates", "true"],
        &f.main,
    )
    .unwrap();
    let repo = f.workspace();
    let (commit, _) = command(
        "jj",
        &[
            "--ignore-working-copy",
            "log",
            "-r",
            "@",
            "--no-graph",
            "-T",
            "commit_id",
        ],
        &repo.root,
    )
    .unwrap();
    command(
        "git",
        &["update-ref", "--create-reflog", "HEAD", commit.trim()],
        &repo.root,
    )
    .unwrap();
    let logs = f.main.join(".git/worktrees/topic/logs");
    assert!(logs.join("HEAD").is_file());
    let mut app = FakeApp::new(&repo);
    assert!(plan_removal(&repo.root, &scope(), &mut app, None).is_ok());
    fs::write(logs.join("notes.txt"), "untracked registration data").unwrap();
    assert!(
        format!(
            "{:#}",
            plan_removal(&repo.root, &scope(), &mut app, None).unwrap_err()
        )
        .contains("Unknown Git worktree log data")
    );
    assert!(app.events.is_empty());
}

#[test]
fn replacement_checkout_root_after_close_is_not_snapshotted_or_deleted() {
    let f = Fixture::new();
    let repo = f.workspace();
    let mut app = FakeApp::new(&repo);
    let plan = plan_removal(&repo.root, &scope(), &mut app, None).unwrap();
    let root = repo.root.clone();
    let moved = repo.root.with_file_name("moved-topic");
    let backup = moved.clone();
    app.on_close = Some(Box::new(move || {
        fs::rename(&root, &moved)?;
        fs::create_dir(&root)?;
        fs::write(root.join("unrelated"), "new checkout contents")?;
        Ok(())
    }));
    let error = remove(
        &repo.root,
        &scope(),
        options(&plan.approval, false),
        &mut app,
    )
    .unwrap_err();
    assert!(format!("{error:#}").contains("identity changed before snapshot"));
    assert_eq!(
        fs::read_to_string(repo.root.join("unrelated")).unwrap(),
        "new checkout contents"
    );
    assert_eq!(fs::read_to_string(backup.join("file")).unwrap(), "before");
    assert!(list(&f.main).unwrap().iter().any(|w| w.name == "topic"));
}
