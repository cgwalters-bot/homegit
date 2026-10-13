# review-checklist evidence

Where each rule in SKILL.md comes from. Mined 2026-10-02 from cgwalters' inline PR review comments (1,743 since 2025-10-01 in 21 repos, of which 1,435 are his own words once quoted AI review output is dropped) and 199 review summaries, in bootc-dev/{bootc,bcvk,infra,gh-agentic-workflows,actions}, composefs/composefs-rs, ostreedev/ostree, coreos/{bootupd,rpm-ostree}, and others. A raw cache sits in `~/.cache/bot-work/review-checklist/` (not committed).

Counts are comments matching a keyword regex, so they overcount and are a rough ranking. They are not a tally of distinct findings. Rules that carry no count are stated by the operator.

## Rust style and idioms

- Blank lines between items: stated (AGENTS.md, task of this checklist). No review comment mentions it, so it has no history to cite.
- Combinators, `let`/`else`, less nesting (about 13): https://github.com/bootc-dev/bootc/pull/2135#discussion_r3069764312, https://github.com/bootc-dev/bootc/pull/2105#discussion_r3033297473, https://github.com/bootc-dev/bootc/pull/2081#discussion_r2960773768, https://github.com/bootc-dev/bootc/pull/2032#discussion_r2872327631.
- No error swallowing (about 14, 6 repos): https://github.com/bootc-dev/bootc/pull/2135#discussion_r3070168881, https://github.com/bootc-dev/bootc/pull/2114#discussion_r3028882689, https://github.com/bootc-dev/bootc/pull/2497#discussion_r4097298464, https://github.com/bootc-dev/bcvk/pull/92#discussion_r2464128075.
- Error context, structured errors (few; style rather than a recurring nit): https://github.com/bootc-dev/bcvk/pull/184#discussion_r2708741545, https://github.com/bootc-dev/bootc/pull/2497#discussion_r4128444657, https://github.com/bootc-dev/bootc/pull/2384#discussion_r3806475412.
- Types over strings, UTF-8 paths (about 31): https://github.com/bootc-dev/bootc/pull/2114#discussion_r3028874881, https://github.com/bootc-dev/bootc/pull/2532#discussion_r4169988737, https://github.com/bootc-dev/bootc/pull/2500#discussion_r4148122134, https://github.com/bootc-dev/bootc/pull/2531#discussion_r4169299591.
- Reuse existing crates and helpers (about 73): https://github.com/bootc-dev/bcvk/pull/259#discussion_r3209345702 (rustix), https://github.com/bootc-dev/bootc/pull/1881#discussion_r2665516960 (clap_complete), https://github.com/bootc-dev/bootc/pull/2497#discussion_r4097304176, https://github.com/bootc-dev/bootc/pull/2343#discussion_r3665024360.
- fd-relative I/O and cap-std (about 37): https://github.com/bootc-dev/bootc/pull/1601#discussion_r2617192543, https://github.com/bootc-dev/bootc/pull/1752#discussion_r2665100260, https://github.com/bootc-dev/bootc/pull/2248#discussion_r4064798345, https://github.com/bootc-dev/bootc/pull/2531#discussion_r4169322760 (raw fd numbers and I/O safety).
- Temp files and sleeps (about 6): https://github.com/bootc-dev/bcvk/pull/232#discussion_r2999733980, https://github.com/bootc-dev/bootc/pull/2411#discussion_r3864980206, https://github.com/bootc-dev/bcvk/pull/300#discussion_r3606019063.
- `unsafe` and `SAFETY`: carried over from commit-review, with little review history.

## Shell

- No 10+ line shell (about 10, plus the stated rule): https://github.com/bootc-dev/gh-agentic-workflows/pull/123#discussion_r4157684529 ("I hate anything that's more than 10 lines of bash"), https://github.com/bootc-dev/gh-agentic-workflows/pull/87#discussion_r3919380771, https://github.com/bootc-dev/bcvk/pull/166#discussion_r2581975997, https://github.com/bootc-dev/bcvk/pull/259#discussion_r3383201158.
- Natural failure over wrappers: https://github.com/bootc-dev/bootc/pull/2114#discussion_r3053988916.

## Testing

- Integration tests expected (about 43): https://github.com/bootc-dev/bcvk/pull/167#pullrequestreview-3531116749, https://github.com/bootc-dev/bcvk/pull/232#pullrequestreview-3992089681, https://github.com/bootc-dev/bootc/pull/2380#discussion_r3968256656.
- Unit tests, parser split (about 30): https://github.com/bootc-dev/bcvk/pull/167#discussion_r2582004589, https://github.com/bootc-dev/bcvk/pull/182#discussion_r2632975729, https://github.com/bootc-dev/bootc/pull/2448#discussion_r4107985972.
- Table-driven (about 7): https://github.com/bootc-dev/bootc/pull/1881#discussion_r2665503362, https://github.com/bootc-dev/bcvk/pull/232#discussion_r2999759093.
- Low-value tests: https://github.com/bootc-dev/bcvk/pull/229#discussion_r2962393384, https://github.com/bootc-dev/bootc/pull/2329#discussion_r3616410278.
- Proptest and fuzzing: https://github.com/composefs/composefs-rs/pull/338#discussion_r3500277251, https://github.com/composefs/composefs-rs/pull/321#discussion_r3466873296.

## Commits and PRs

- Prep commits and squashing (about 20): https://github.com/bootc-dev/bootc/pull/2028#discussion_r2878241871, https://github.com/bootc-dev/bootc/pull/2000#discussion_r2795355255, https://github.com/bootc-dev/bcvk/pull/385#pullrequestreview-5344856905 (praise for a well-split series).
- Description in step with commits: https://github.com/bootc-dev/bootc/pull/1942#discussion_r2722630225.
- Docs with the change (about 22): https://github.com/bootc-dev/bcvk/pull/389#discussion_r4148504001, https://github.com/bootc-dev/bootc/pull/2448#discussion_r4107975432, https://github.com/bootc-dev/bootc/pull/2500#discussion_r4144414154.
- Workarounds link upstream (about 7): https://github.com/bootc-dev/bcvk/pull/394#discussion_r4156302711 ("We need to propose a review checklist item for this"), https://github.com/bootc-dev/actions/pull/60#discussion_r4156733145.
- Comments explain why: https://github.com/bootc-dev/actions/pull/58#discussion_r4008386054.
- No duplication (about 31): https://github.com/bootc-dev/bcvk/pull/259#discussion_r3470923268, https://github.com/bootc-dev/bootc/pull/2397#discussion_r3825666296, https://github.com/bootc-dev/bootc/pull/2531#discussion_r4169336697.
- LLM output skepticism (about 28 mentions): https://github.com/bootc-dev/bootc/pull/1842#discussion_r2606849896 (hallucinated command), https://github.com/bootc-dev/bcvk/pull/184#discussion_r2662497230 (arbitrary sleeps).

## Design and safety

- State, atomicity and corrupt-state robustness (about 24): https://github.com/bootc-dev/bootc/pull/2108#discussion_r3016443766, https://github.com/bootc-dev/bootc/pull/2248#discussion_r4031519484, https://github.com/bootc-dev/bootc/pull/2490#discussion_r4086389584.
- Supported APIs over text parsing: https://github.com/bootc-dev/bootc/pull/2368#discussion_r3722057564, https://github.com/bootc-dev/bootc/pull/2411#discussion_r3864980206.
- Simplicity, defaults: https://github.com/bootc-dev/actions/pull/51#discussion_r3815824953, https://github.com/bootc-dev/bootc/pull/2483#discussion_r4096055111.

## Formal methods

Stated by the operator ("I like formal verification Verus and Z3 and stuff"). The history has only a few explicit mentions (about 2 real ones of 9 keyword hits), but they match: https://github.com/composefs/composefs-rs/pull/338#discussion_r3500792257 ("Stuff like this cries out to be unit tested. (Actually I bet we might be able to do some formal verification even)"), https://github.com/composefs/composefs-rs/pull/338#discussion_r3500277251 (proptest for digests), https://github.com/composefs/composefs-rs/pull/225#discussion_r3341080428.
