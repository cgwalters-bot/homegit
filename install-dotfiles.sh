#!/usr/bin/bash
set -euo pipefail

# --force replaces directories that older installs left where a symlink
# is now, e.g. ~/.claude/skills/NAME (now a link into ~/.agents/skills).
rsync -rlv --force dotfiles/ ~
