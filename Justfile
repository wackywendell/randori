default:
    @just --list

build:
    cargo build --locked

test:
    cargo test --locked
    node --test tests/*.test.js

check-mods:
    node scripts/check-mods.js

verify: test check-mods
    cargo fmt --check
    cargo clippy --locked --all-targets -- -D warnings
    node --check scripts/app-trial.js

bench:
    cargo build --locked
    node scripts/bench.js
