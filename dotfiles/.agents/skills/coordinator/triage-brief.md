You are triaging one new issue of the operator's tracker in an `analysis` run: read the code and the issue, and propose how the work should go. You change nothing: leave the tree clean. You can't ask anything mid-run and you have no GitHub access: what you know of the board is the list at the end of this brief, and of the code, the checkout.

**What to find out.**

- **The ask:** restate it in one or two sentences, as you understand it. If it can be read two ways, say which you assume and make the other a question.
- **The code:** the files and functions the work would touch, as links to the checked-out repository (`https://github.com/OWNER/REPO/blob/BASE/PATH#L10-L20`), a handful at most. Read enough to judge the size; don't design the change.
- **Prior work:** the board items below that this duplicates, depends on or continues, as links. Say plainly when it duplicates one.
- **Scope and acceptance criteria:** what is in, what is left out, and three to six checkable criteria (a test that passes, a behaviour seen, a doc updated).
- **Epic:** the open epic (an item marked `[epic]` below) it belongs under, or none.
- **Priority:** P0 blocks right now, or is something the operator wants done quickly; P1 is active work in a focus area, under that area's epic; P2 is backlog, nice to have or deliberately deferred. When unsure between two, take the lower.
- **Estimated cost**, in model tokens for an agent doing the work: XS under 200k, S under 1M, M under 5M, L under 20M, XL more.
- **Dispatchable or not:** dispatchable means a worker could start now without asking anyone: the target repository is known (the issue has a `Repo: OWNER/REPO` line, or names exactly one repository), the scope is clear and no design decision is open. Otherwise it needs the operator first; say what decision.
- **Questions:** only what the operator alone can answer (intent, priorities, trade-offs, access), each with the option you recommend first. Not what reading the code answers.

**Your output.** Exactly one request in `~/out/safe-outputs.jsonl`, an `add_comment` on the issue named below: `{"type": "add_comment", "item_number": N, "body": "..."}`. No other request: a second one, or one of any other type, gets the whole run refused. The body is Markdown, concise (under 400 words before the block), with these sections in order: **Ask**, **Relevant code and prior work**, **Proposal** (scope, acceptance criteria, epic, priority, estimate, dispatchable), **Questions for the operator** (omit when there are none). It ends with one fenced `json` block of the fields, which is applied to the board as written, so keep it consistent with the text:

```json
{"schema": "triage/v1", "priority": "P1", "epic": "https://github.com/OWNER/tracker/issues/123", "estimate": "S", "dispatchable": false, "repo": "OWNER/REPO", "questions": ["Should X keep Y? I recommend yes, because ..."]}
```

`priority` is `P0`, `P1`, `P2` or `null`; `epic` an issue URL from the board list or `null`; `estimate` `XS`, `S`, `M`, `L`, `XL` or `null`; `dispatchable` `true` or `false`; `repo` the target `OWNER/REPO` or `null`; `questions` the questions of your comment, as a list (empty when none). No other keys, and no second block with `"schema": "triage/v1"`. The bot adds a footer naming this run; don't sign the comment.

Then write `~/out/outcome.json` as usual: `summary` is your triage in two or three sentences, `tests` the commands you ran (if any), `questions` the same questions.
