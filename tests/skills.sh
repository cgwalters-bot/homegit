#!/usr/bin/env bash
# The skills live once, in dotfiles/.agents/skills (the Agent Skills
# location most agents read); dotfiles/.claude/skills only links each of
# them for Claude Code, which reads nothing else. Checks that every skill
# is a valid Agent Skill and linked exactly once, and that
# install-dotfiles.sh sets up both in a fresh HOME and over the copies an
# older install left in ~/.claude/skills.
#   tests/skills.sh
set -euo pipefail
shopt -s inherit_errexit nullglob

TOP=$(cd "$(dirname "$0")/.." && pwd)
readonly TOP
readonly SKILLS=dotfiles/.agents/skills CLAUDE_SKILLS=dotfiles/.claude/skills
readonly LINK_PREFIX=../../.agents/skills

fail=0
err() { echo "error: $*" >&2; fail=1; }

# The frontmatter value of KEY in FILE, between the leading --- lines.
frontmatter() {
    sed -n '1{/^---$/!q};1d;/^---$/q;p' "$2" | sed -n "s/^$1: *//p"
}

cd "${TOP}"
names=()
for dir in "${SKILLS}"/*/; do
    name=$(basename "${dir}")
    names+=("${name}")
    file=${dir}SKILL.md
    if [[ ! -f ${file} ]]; then
        err "${dir} has no SKILL.md"
        continue
    fi
    [[ $(frontmatter name "${file}") == "${name}" ]] ||
        err "${file}: frontmatter name must be '${name}', the directory name"
    [[ -n $(frontmatter description "${file}") ]] ||
        err "${file}: frontmatter has no description"
    link=${CLAUDE_SKILLS}/${name}
    [[ -L ${link} && $(readlink "${link}") == "${LINK_PREFIX}/${name}" ]] ||
        err "${link} must be a symlink to ${LINK_PREFIX}/${name}: ln -sfn ${LINK_PREFIX}/${name} ${link}"
done
((${#names[@]} > 0)) || err "no skills in ${SKILLS}"
for entry in "${CLAUDE_SKILLS}"/*; do
    [[ -d ${SKILLS}/$(basename "${entry}") ]] ||
        err "${entry} is not a link to a skill in ${SKILLS}; skills go there"
done

# The brief templates: what heads a subagent's prompt must carry the
# board item's "Item:" line (bot-cost attributes tokens by it), as a
# placeholder line of its own. runner-preamble.md and triage-brief.md, a
# devspace run's, are exempt: bot-runs titles the run "agent PVTI_...",
# which bot-cost reads instead, and the coordinator's SKILL.md shows a
# filled-in example.
readonly ITEM_LINE='Item: ITEM_URL'
readonly ITEM_EXEMPT=("${SKILLS}/coordinator/SKILL.md" "${SKILLS}/coordinator/runner-preamble.md" "${SKILLS}/coordinator/triage-brief.md")
for file in "${SKILLS}"/coordinator/*.md "${SKILLS}/topic-lead/SKILL.md"; do
    [[ " ${ITEM_EXEMPT[*]} " == *" ${file} "* ]] && continue
    grep -qxF "${ITEM_LINE}" "${file}" ||
        err "${file} has no '${ITEM_LINE}' line: briefs from it would leave the subagent's tokens unattributed"
done
grep -q "^Item: " "${SKILLS}/coordinator/SKILL.md" ||
    err "${SKILLS}/coordinator/SKILL.md's briefing example has no 'Item:' line"

# Install into a HOME that has an older install's copy of a skill and a
# directory Claude Code keeps there itself.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/skills-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/.claude/skills/${names[0]}" "${WORK}/.claude/skills/synced/keep"
echo stale >"${WORK}/.claude/skills/${names[0]}/SKILL.md"
HOME=${WORK} ./install-dotfiles.sh >/dev/null
jq -e '.env.CLAUDE_CODE_SHELL == "/bin/bash" and .env.DISABLE_AUTOUPDATER == "1"' \
    "${WORK}/.claude/settings.json" >/dev/null ||
    err "installed Claude settings must select Bash and preserve DISABLE_AUTOUPDATER"
[[ -d ${WORK}/.claude/skills/synced/keep ]] || err "install removed ~/.claude/skills/synced"
for name in "${names[@]}"; do
    installed=${WORK}/.agents/skills/${name}/SKILL.md
    [[ -f ${installed} && ! -L ${WORK}/.agents/skills/${name} ]] ||
        err "install did not copy ${name} to ~/.agents/skills"
    [[ $(realpath -m "${WORK}/.claude/skills/${name}/SKILL.md") == "$(realpath "${installed}")" ]] ||
        err "installed .claude/skills/${name} does not lead to .agents/skills/${name}"
done

((fail == 0)) || exit 1
echo "ok: ${#names[@]} skills, linked for Claude Code and installed"
