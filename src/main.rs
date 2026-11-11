use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use herdr_jj::{LocalApp, RemoveOptions, Scope, ScopeKind};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about = "Short-lived jj workspace operations for Herdr")]
struct Cli {
    #[arg(long, global = true, default_value = ".")]
    cwd: PathBuf,
    #[command(subcommand)]
    command: Operation,
}

#[derive(Args)]
#[group(required = true, multiple = false)]
struct Target {
    #[arg(long)]
    space: Option<String>,
    #[arg(long)]
    tab: Option<String>,
}
impl Target {
    fn scope(self) -> Scope {
        match self.space {
            Some(id) => Scope {
                kind: ScopeKind::Space,
                id,
            },
            None => Scope {
                kind: ScopeKind::Tab,
                id: self.tab.unwrap(),
            },
        }
    }
}

#[derive(Subcommand)]
enum Operation {
    Probe,
    Inspect {
        #[arg(long)]
        snapshot: bool,
    },
    List,
    Create {
        name: String,
        #[arg(long)]
        revision: Option<String>,
    },
    /// Resolve an existing owned workspace; the app owns its space/tab.
    Open {
        name: String,
    },
    RemovePlan {
        #[command(flatten)]
        target: Target,
    },
    Remove {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        approval: String,
        #[arg(long)]
        discard_excluded: bool,
    },
}

fn execute(cli: Cli) -> Result<Value> {
    let cwd = cli.cwd.canonicalize().context("Resolve --cwd")?;
    Ok(match cli.command {
        Operation::Probe => serde_json::to_value(herdr_jj::discover(&cwd)?)?,
        Operation::Inspect { snapshot } => {
            serde_json::to_value(herdr_jj::inspect(&cwd, snapshot)?)?
        }
        Operation::List => serde_json::to_value(herdr_jj::list(&cwd)?)?,
        Operation::Create { name, revision } => {
            serde_json::to_value(herdr_jj::create(&cwd, &name, revision.as_deref())?)?
        }
        Operation::Open { name } => {
            serde_json::to_value(herdr_jj::locate(&cwd, &name)?.context("Workspace not found")?)?
        }
        Operation::RemovePlan { target } => {
            let repo = herdr_jj::discover(&cwd)?.context("Not a jj workspace")?;
            let mut app = LocalApp { cwd: repo.main };
            serde_json::to_value(herdr_jj::plan_removal(
                &cwd,
                &target.scope(),
                &mut app,
                std::env::var("HC_TERMINAL_ID").ok().as_deref(),
            )?)?
        }
        Operation::Remove {
            target,
            yes,
            approval,
            discard_excluded,
        } => {
            let repo = herdr_jj::discover(&cwd)?.context("Not a jj workspace")?;
            let mut app = LocalApp { cwd: repo.main };
            let caller = std::env::var("HC_TERMINAL_ID").ok();
            serde_json::to_value(herdr_jj::remove(
                &cwd,
                &target.scope(),
                RemoveOptions {
                    yes,
                    approval: &approval,
                    discard_excluded,
                    caller: caller.as_deref(),
                },
                &mut app,
            )?)?
        }
    })
}

fn main() {
    let result = match Cli::try_parse() {
        Ok(cli) => execute(cli),
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            print!("{error}");
            return;
        }
        Err(error) => Err(error.into()),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            let value = if let Some(failure) = error.downcast_ref::<herdr_jj::RemovalFailure>() {
                serde_json::to_value(failure).unwrap()
            } else {
                serde_json::json!({ "error": format!("{error:#}"), "stage": null, "completed": [] })
            };
            eprintln!("{value}");
            std::process::exit(1);
        }
    }
}
