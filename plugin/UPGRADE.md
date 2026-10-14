# UPGRADE — re-syncing this port with upstream

For whoever moves `plugin/` to a newer pin. This file ships inside the published package, so it
names the source repository rather than linking into it: the program and the record of *why* live
there, not in the tarball.

## The pinned upstream

| What | Value |
|---|---|
| Repo | `cursor/plugins`, `pstack/` (<https://github.com/cursor/plugins>) |
| Commit | `5bf2b1544db739998121a306340631963c2ff3de` |
| Licence | MIT (Lauren Tan, 2026) |

`scripts/fetch-upstream.sh` in the source repository reconstitutes that tree at
`.upstream/cursor-plugins` (the checkout is gitignored: a clone tracks `main` and drifts, so the
script is the durable artifact). **That script is the single home of the pin** — change it there.
Verified: `git -C .upstream/cursor-plugins rev-parse HEAD` prints the pin.


## How to re-sync

1. Set the new commit in `scripts/fetch-upstream.sh`, then run the
   script. It fetches and checks out `FETCH_HEAD` and exits non-zero if HEAD is not the pin.
2. `scripts/check-parity.sh` — reads counts from **both** trees: skills, principles, playbooks,
   agents, plus the two principles a sibling port dropped. It proves the *shape* matches
   (`47 = 47 upstream − make-bot-ui + pstack-self-check`); it cannot prove the text is faithful,
   and it says nothing about call sites.
3. `scripts/check-call-sites.sh` — no Cursor/Grok leftovers in `plugin/skills` + `plugin/agents`
   (`--baseline` shows what the rules catch on the dirty upstream tree). It covers two of the three
   call-site kinds: tool names and model slugs. It proves nothing that *should* have changed was
   missed; it cannot prove a translated call site now says the right thing.
4. **By hand: the path kind.** `grep -rn 'scripts/orch\|scripts/watch-pr\|check-plan.mjs'
   plugin/skills` — every hit should read `<skillsDirectory>/…`, not a bare relative path. No gate
   checks this, because a bare path is indistinguishable from ordinary prose.
5. `scripts/batch-plan.sh` — re-partitions the pinned skill set into per-path writer batches and
   prints each batch's size. It plans only; it never writes into `plugin/`.

Then re-apply the port rule below to every changed skill, and finish with
`cd plugin && npm install --include=dev && npm run check`.

## The porting rule

Quoted from [`skills/README.md`](skills/README.md):

> **Translate call sites only, and drop exactly one frontmatter line.** Methodology text must
> stay byte-identical otherwise.

So: copy byte-identical, translate call sites, drop exactly one line —
`disable-model-invocation: true`. That line is not a judgement call: DSH filters a skill carrying it
out of the model-facing catalog **and** refuses a named `skill` call for it, so keeping it ships
skills the text tells the model to load and the model cannot. `setup-pstack` never had the key; the
other 46 directories drop it. The plugin's own `tests/invocation.spec.ts` enforces that against the
real bundled tree.

**What counts as a call site**, since the rule turns on it: any name a model or a person is told to
*use*, where the name does not resolve here. Three kinds, and only these:

| Kind | Example | What it becomes |
|---|---|---|
| A tool | Cursor's `Task` tool | `pstack_spawn` |
| A model slug | `grok-4.6-fast-xhigh` | a role resolved against the live catalog |
| A path | `scripts/orch/orch.ts` | `<skillsDirectory>/poteto-mode/scripts/orch/orch.ts` |

The path kind was added late and is the one that hides best: a bare relative path is prose, so it
reads as methodology, but a reader in *their own* repository resolves it against the wrong root and
finds nothing.

Everything else stays upstream's words. `scripts/check-call-sites.sh` enforces the first two; the
third is checked by reading, which is why it took a dedicated pass to find.

## Deliberately not shipped

- **`make-bot-ui`** — Cursor-only, no content to translate.
- **The 10-chapter guide** (`pstack/docs/guide/`) — 10 upstream chapters, 0 shipped here.
- **`poteto-mode/scripts/`** ships whole — dropping it would leave four playbooks instructing a
  person to run a tool that is not there. Its *code* is upstream's, unmodified, but the four
  playbooks that name it had their paths translated, because the bare form was not a call site a
  user could follow: `scripts/orch/orch.ts` resolves from this repository's root, which is a path
  only the author has. They now read `<skillsDirectory>/poteto-mode/scripts/…`, and
  `pstack_status` reports the absolute `skillsDirectory`. bun **is** installed (`~/.bun/bin/bun`,
  1.4.2), and `scripts/bootstrap.ts` runs `bun install --frozen-lockfile` and re-execs on first
  use — so running it fetches a dependency from the network. That is exactly why **no plugin code
  path may call into `scripts/`**: not a boot, not a tool registration, not a settings read.

## `lib/` is committed on purpose

A `github:` install must not run `prepare`, so the built entry ships in the repo — `.gitignore`
keeps `lib/` unignored and says why in a comment. The consequence for anyone editing `src/`:
**run `npm run build` before trusting a live profile**, or the Host loads a stale `lib/`.
`npm run verify` is `build` then `check`, in that order.
