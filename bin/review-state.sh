# shellcheck shell=bash
# Whether cgwalters' review of one of the bot's upstream PRs is still
# waiting for an answer: the one predicate that bot-watch's "Outstanding
# reviews" and 'bot-pr rebase' share (sourced; not executable, so
# install-bin.sh leaves it out).
# shellcheck disable=SC2016,SC2034 # jq, and used by those sourcing it

# The first line of a text that isn't blank or quoted (a reply starts by
# quoting what it answers), without control or bidi characters that a
# terminal would act on; $len is its maximum length.
readonly EXCERPT_JQ='def excerpt:
    [(. // "") | splits("\n") | gsub("[[:cntrl:]‎‏‪-‮⁦-⁩]"; " ")
     | select(test("\\S") and (test("^\\s*>") | not))]
    | (first // "") | gsub("^\\s+|\\s+$"; "") | gsub("\\s+"; " ")
    | if length > $len then .[:$len] + "..." else . end;'

# Over the PR's reviews and issue comments (slurped, in any order), with
# $bot and $req the bot's and the requester's logins, $push when the
# PR's head was pushed by either of them (the head commit's committer
# date, "" for anyone else's push, e.g. GitHub's "Update branch") and
# $len for the excerpt: prints what $req asked that has no answer yet, as
# {at, type, review_state, link, excerpt, count} of his latest; else
# null. A review requesting changes is answered by such a push after it,
# or by his own later review (a dismissed one is gone); his other
# reviews and comments by such a push or a reply of the bot's. His
# approval answers all before it; after it, only his reviews and the
# comments that mention the bot count, until another review.
readonly OUTSTANDING_REVIEW_JQ="${EXCERPT_JQ}"'
    [.[] | select(.user.login == $bot or .user.login == $req)
     | if has("submitted_at") then select(.submitted_at != null and (.state | IN("PENDING", "DISMISSED") | not))
           | {type: "review", review_state: .state, at: .submitted_at}
       else {type: "comment", at: .created_at} end
       + {author: .user.login, link: .html_url, body: (.body // "")}]
    | ([.[] | select(.author == $bot) | .at] | max // "") as $bot_reply
    | [.[] | select(.author == $req)] as $his
    | ([$his[] | select(.type == "review")] | sort_by(.at)) as $his_reviews
    | ([$his_reviews[] | select(.review_state == "APPROVED") | .at] | max // "") as $approved
    | [$his[] | . as $x
       | select(.at > $approved and .review_state != "APPROVED")
       # A comment right after his approval is a thank-you, unless it
       # asks the bot for something.
       | select(.type == "review" or ([$his_reviews[] | select(.at <= $x.at)] | last | .review_state) != "APPROVED"
                or (.body | test("@" + $bot + "(?![A-Za-z0-9-])"; "i")))
       | select(if .review_state == "CHANGES_REQUESTED"
                # Any later review of his replaces it, even one that
                # only comments: he said what he still wants there.
                then ($push > $x.at or any($his_reviews[]; .at > $x.at)) | not
                else [$push, $bot_reply] | max <= $x.at end)]
    | sort_by(.at) as $open
    | if ($open | length) == 0 then null
      else $open[-1] + {count: ($open | length), excerpt: ($open[-1].body | excerpt)} | del(.author, .body) end'

# The head commit's JSON (repos/R/commits/SHA) to $push for
# OUTSTANDING_REVIEW_JQ: only a push of the bot's, or his own (he acted
# on it himself), can answer him.
readonly REVIEW_PUSH_JQ='if .committer.login | IN($bot, $req) then .commit.committer.date else "" end'
