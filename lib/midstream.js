// Midstreams and real forks in the forge org. A midstream's default branch
// mirrors its upstream exactly and moves only by fast-forward sync: its
// pull requests are review vehicles, opened as drafts and never merged. A
// real (possibly temporary) fork may carry its own commits, and its pull
// requests may merge. The repository's topic says which (see
// bot-pr fork-setup); the bot's own repositories are neither.
"use strict";

const MIDSTREAM_TOPIC = "bot-midstream";
const FORK_TOPIC = "bot-fork";
// The ruleset fork-setup puts on a midstream's default branch.
const RULESET_NAME = "bot-midstream-no-merge";
// The required status check of that ruleset, which nothing ever reports,
// so that a pull request can't merge without an admin bypassing the rules
// on purpose.
const RULESET_CHECK = "bot-midstream-never-merge";

// kind(repo, forgeOrg): "midstream", "fork" or null (not a mirror at all)
// for a repository as GitHub's REST API describes it ({fork, topics,
// owner}). The topic decides; a GitHub fork in the forge org with neither
// is a midstream, the safe default (a fork elsewhere, such as the bot's
// own repositories, is not a mirror unless a topic says so).
function kind(repo, forgeOrg) {
  const topics = (repo && repo.topics) || [];
  if (topics.includes(FORK_TOPIC)) return "fork";
  if (topics.includes(MIDSTREAM_TOPIC)) return "midstream";
  const owner = repo && repo.owner && repo.owner.login;
  return repo && repo.fork && owner === forgeOrg ? "midstream" : null;
}

module.exports = { MIDSTREAM_TOPIC, FORK_TOPIC, RULESET_NAME, RULESET_CHECK, kind };
