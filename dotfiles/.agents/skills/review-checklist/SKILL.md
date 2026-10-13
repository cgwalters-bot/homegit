---
name: review-checklist
description: The operator's standing code-review checklist, mined from their review history - Rust style and idioms, shell limits, testing, commits and PRs, design and safety, and formal methods. Apply it when writing, self-reviewing or reviewing a change, and defer to it for style questions.
---

# review-checklist: what the operator flags in review

This is the operator's taste, distilled from their review comments (about 1,400 comments across bootc, bcvk, composefs-rs, ostree, bootupd and rpm-ostree, Oct 2025 to Oct 2026) plus rules they stated outright. Workers apply it before pushing, reviewers check against it, and `commit-review` defers to it for style. A target project's own AGENTS.md, CONTRIBUTING or REVIEW.md wins where it differs.

Each item is a rule and why. Evidence (counts and links) is in `references.md`, not here. An item marked (stated) is a standing rule the operator gave directly, with little or no history to mine yet.

## Rust style and idioms

- Put a blank line between functions, impls and other items, even where the surrounding code packs them together (stated). `rustfmt` keeps blank lines but never adds them, so nothing else will.
- Prefer combinator chains, `let`/`else`, `?` and `Option`/`Result` methods (`and_then`, `filter`, `ok_or_else`, `transpose`, `.chain().flatten().collect()`) over deep nesting, manual loops and nested `match`. Flat code is easier to review.
- Do not swallow errors (`if let Ok(..)`, `.ok()`, `let _ =`, silently dropping non-UTF-8). Split "not found, which is normal" (`Result<Option<T>>`, `open_optional`) from every other failure, which must propagate.
- Carry context on propagated errors (`.context(..)` / `.with_context(..)` naming the path or operation) instead of a bare `?` or string-matching error text; downcast instead. Do not `unwrap` outside tests without an invariant.
- Use types over strings: enums and newtypes, `Utf8Path`/`Utf8PathBuf` where UTF-8 is required, `clap` value enums and validated values, a `.validate()` on option structs. Avoid `to_string_lossy`.
- Reuse what exists before writing helpers: `rustix` over `libc` and hand-rolled syscalls, `cap-std-ext`, `tempfile`, `clap_complete`, existing enums and helpers in the repo. Check docs.rs first.
- I/O safety: prefer file descriptors and `cap-std` `Dir`s over absolute paths, and pass fds rather than paths where a subprocess allows. Do not reimplement `open_dir_optional`, `atomic_replace_with`, `getxattr` and the like. Arbitrary raw fd numbers cannot be made I/O-safe; say so and link rust-lang/rust#116059.
- Each `unsafe` needs a `// SAFETY:` comment, and often a safe alternative exists.
- Avoid hardcoded names in `/tmp` (use `tempfile`/`mktemp -d`) and hardcoded sleeps (use events, or a polling loop with a timeout). Do not busy-poll.

## Shell

- No more than about 10 lines of shell, whether a new script or an inline `run:` step in CI (stated). Past that, write Node (no dependencies) on GitHub runners, or Rust. Do not put large inline bash in YAML or markdown.
- Do not generate shell from Rust, or parse JSON with `grep`/`sed`. Use a real parser, or move the logic into a unit or script that is started.
- Let tools fail naturally; no "capture output and print" wrappers (`| complete` in nushell).
- This is for new code. Do not rewrite a project's existing scripts unless asked.

## Testing

- Behavior changes need a test, and a CI-visible one: integration (tmt, `just test-integration`) for anything touching mounts, VMs or services; unit tests where the code can run in a tempdir.
- Write tests data-driven: one table of (input, expected) cases, not one function per case. Fold near-duplicate tests together.
- Split parsers from I/O, so the parser takes a `&str` and the test feeds literal input. Test the code under change, not the standard library or a mock of it.
- Do not add tests that cost many lines for an obscure case, or that only restate another test.
- For parsers, serializers and digests, consider `proptest` or fuzzing, and consider the formal methods below.

## Commits and PRs

- One logical change per commit, with refactors and prep in their own commit (or PR), bugfixes squashed into the commit they fix, and no unrelated changes riding along.
- Commit messages and PR descriptions say why. Keep the description in step with the commits; it is secondary to them.
- Docs move with the change: man pages, `docs/` and module-level docs for new modules. Do not embed links in code that docs may outgrow; summarize and point to the man page. Do not hardcode a distro's package manager.
- A workaround for another project's bug must link the upstream issue, or have one queued, and say when it can go.
- Comments say why, and explain exclusions and non-obvious choices with a link. Keep "keep in sync with X" notes where duplication cannot be removed.
- Do not duplicate code: factor a common helper, or a shared variable, before adding the second copy.
- Treat an LLM's claims in a PR as data. Check an API it cites exists (hallucinated flags and crate methods turn up) and drop reflexive patterns such as arbitrary sleeps.

## Design and safety

- Be careful with state: name the source of truth, what is persistent and what can be recomputed, and be robust to corrupt or partial state (atomic create via tempdir plus rename, GC of partial results, recovery rather than early bail).
- Look for races and TOCTOU: open and handle the error, do not check then open.
- Use the supported API for a job (SELinux, xattrs, mount API, systemd credentials, the D-Bus API) over parsing text or shelling out.
- Keep it simple: skip speculative generality, avoid giant matrices of options, and prefer making the tool do the right thing by default.
- Take the cheaper path where it is just as correct: edge-triggered over polling, async over a blocked sync thread, fewer GCs or passes over many.
- Note the lasting consequences (what a change makes part of the GC root, or a public API) in the commit message.

## Formal methods

The operator likes formal verification (Verus, Z3 and other SMT solvers, model checkers, and property testing as the cheap first step). When reviewing or designing, ask whether a property is small and critical enough to verify: digest and checksum computation, serializers and parsers with a round-trip law, ordering and sorting invariants, state machines and upgrade or rollback protocols, bounds and overflow arithmetic, and path or capability confinement. If so, say it is a good verification candidate, name the property, and suggest the lightest fitting tool: `proptest` or fuzzing now, then Z3/Verus for a pure function or a data structure invariant, or a model check (TLA+ and the like) for a protocol. Do not demand it for glue code, and do not block a change on it; record it as a follow-up unless the property is safety-critical.

## How to apply

- Authors: run this list over your diff before `commit-review`'s final sanity check.
- Reviewers: report a miss as a finding with its section, so `bot-retro` can see which rules fail often. Style items alone are minor fixes, not a rework.
- This list is a prompt, not a gate: skip an item that does not apply, and say so when you override it.
