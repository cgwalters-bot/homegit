# shellcheck shell=bash
# Whether a repository wants DCO sign-offs, shared by bot-pr and
# dco-signoff, which source this file (it is not executable, so
# install-bin.sh leaves it out). The caller defines ghapi ('gh api' that
# returns DCO_NOTFOUND for a 404) and warn.

# What ghapi returns when GitHub says the resource doesn't exist.
readonly DCO_NOTFOUND=4
# A required status check or check run with a name matching this (as a
# whole word, case-insensitively) is a DCO check.
readonly DCO_NAME_RE='(^|[^[:alnum:]])dco([^[:alnum:]]|$)'
# The GitHub Apps whose check runs on a PR head count as DCO checks. On
# PR heads, where a PR's own workflows can report any name, only these
# count; on the base branch, which only maintainers push to, the name does.
readonly DCO_APP_SLUGS='["dco", "dco-2"]'
# How many of a repository's latest PRs dco_checks looks at.
readonly DCO_RECENT_PRS=5

# dco_check_runs REPO REF JQ_FILTER: the names of REF's check runs that
# JQ_FILTER selects, one per line; nothing if they can't be read (with a
# warning, except for a 404).
dco_check_runs() {
    local rc=0
    ghapi --paginate -X GET "repos/$1/commits/$2/check-runs" -f per_page=100 \
        --jq ".check_runs[] | select($3) | .name" || rc=$?
    test "${rc}" -eq 0 || test "${rc}" -eq "${DCO_NOTFOUND}" ||
        warn "cannot read the check runs of $1@${2:0:12}; if it requires DCO, sign off or add a note to the PR by hand"
}

# dco_checks REPO BASE: prints the names of the DCO checks REPO runs on PRs
# into BASE, as a JSON array, empty if it wants no DCO: those that BASE's
# rules require, or else a DCO check run on BASE's head, or else one by
# the DCO app on the head of one of REPO's latest DCO_RECENT_PRS PRs. The
# DCO app, where installed, fails every PR that lacks sign-offs, so a
# repository running it wants them even where its rules don't list the
# check (or can't be read: classic branch protection needs admin rights).
# Only what GitHub enforces or runs counts, never what CONTRIBUTING says.
dco_checks() {
    local repo=$1 base=$2 names heads sha
    local by_name="(.name | test(\"${DCO_NAME_RE}\"; \"i\"))"
    names=$(ghapi -X GET "repos/${repo}/rules/branches/${base}" \
        --jq '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context') ||
        warn "cannot read the branch rules of ${repo}:${base}; looking only for DCO check runs"
    names=$(jq -R '{name: .} | select('"${by_name}"') | .name' <<<"${names}")
    test -n "${names}" || names=$(dco_check_runs "${repo}" "${base}" "${by_name}" | jq -R .)
    if test -z "${names}"; then
        heads=$(ghapi -X GET "repos/${repo}/pulls" -f state=all -f per_page="${DCO_RECENT_PRS}" --jq '.[].head.sha') ||
            warn "cannot list the PRs of ${repo}; looking for DCO check runs on ${base} only"
        for sha in ${heads}; do
            names=$(dco_check_runs "${repo}" "${sha}" "(.app.slug // \"\") | IN(${DCO_APP_SLUGS}[])" | jq -R .)
            test -z "${names}" || break
        done
    fi
    jq -sc 'unique' <<<"${names}"
}
