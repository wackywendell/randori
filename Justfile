default:
    @just --list

test:
    node --test tests/*.test.js

check-mods:
    node scripts/check-mods.js

verify: test check-mods
    for f in scripts/*.js tests/*.js mods/*/*.js; do node --check "$f"; done

bench:
    node scripts/bench.js

# Copies the jj mods into the Herdr app home.
install-mods:
    #!/usr/bin/env sh
    set -eu
    dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
    mkdir -p "$dest/mods"
    for m in mods/jj-*; do rm -rf "$dest/$m"; cp -R "$m" "$dest/mods/"; done

# Copies the mods and layout into the Herdr app home.
install: install-mods
    #!/usr/bin/env sh
    set -eu
    dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
    mkdir -p "$dest/layouts"
    cp layouts/jj.json "$dest/layouts/"
