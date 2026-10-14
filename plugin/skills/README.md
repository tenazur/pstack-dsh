# skills/

Ported pstack skills land here in **Phase 3**. Phase 2 holds exactly one hand-written skill,
[`pstack-self-check`](./pstack-self-check/SKILL.md) — a real skill, not a placeholder, whose job
is to make the skill-provider mechanism provable on its own before 47 files depend on it.

## What goes here

The 47 upstream SKILL.md directories from `cursor/plugins` `pstack/`, at the commit pinned in
`scripts/fetch-upstream.sh` (upstream: <https://github.com/cursor/plugins>).

## The rule for porting

**Translate call sites only, and drop exactly one frontmatter line.** Methodology text must
stay byte-identical otherwise. **No gate proves that** — `check-parity.sh` compares counts, and
`check-call-sites.sh` catches tool names and model slugs, so the byte-identity half of this rule is
held by reading the diff, not by a script. The changes made are:

| Upstream | Ours |
|---|---|
| `name: Poteto Mode` | `name: poteto-mode` |
| `disable-model-invocation: true` | **deleted** — see below |
| `Task` tool | `pstack_spawn` |
| `AskQuestion` | `ask_user_question` |
| `TodoWrite` | `todo_write` |
| `subagent_type: X` | `role: X` |
| `~/.cursor/rules/*.mdc` | `$DSH_HOME/pstack.json` |
| `cursor-team-kit` `deslop` | the bundled `unslop` |
| Cursor control skills | drive the real surface (browser, CLI, tests) |
| `/loop` | `create_goal` / `update_goal` |
| `scripts/orch/orch.ts` | `<skillsDirectory>/poteto-mode/scripts/orch/orch.ts` |
| `git show origin/main:pstack/skills/…` | `<skillsDirectory>/…` |

`skillsDirectory` is the absolute path `pstack_status` reports. Upstream's bare paths resolve from
its own repository root, and `origin/main:pstack/skills/…` assumes the methodology repo *is* the
one you are working in — both are layouts only the author has.

**Why the invocation line goes, and it is not a judgement call.** 46 of the 47 upstream skills
set `disable-model-invocation: true`. DSH honours it by filtering the model-facing catalog
(`dsh-tool-skill/lib/index.js:217`) *and* by refusing a named `skill` call with
`Error: skill "<name>" is not available for model invocation` (`:147`, `:150`), before
`ctx.skills.get()` is reached. A live session proved both halves: the registry's `list()`
returned 7 skills, the session's rendered catalog held 6, and the model's own call for the
filtered one errored. Upstream's text names principles and playbooks for the model to load —
"the **prove-it-works** principle skill" — so keeping the key would ship 46 skills the model is
instructed to load and cannot. Full evidence: decision `0003` in the source repository.

`setup-pstack` never had the key, so it is unchanged. Every other directory drops that one line.

**`poteto-mode/scripts/` ships byte-identical, and it stays that way.** Seven playbooks
reference it by path (`babysit.md:12` and `shipping.md:14` → `watch-pr`;
`multi-phase-plan.md:10` → `check-plan.mjs`; `orchestrate.md:15,:23` → `orch.ts`;
`worktree-cleanup.md:5` → `worktree-audit.sh`), so dropping it would leave dangling
instructions, and rewriting it would destroy the mechanical diff that makes the port reviewable.

**The human decided to keep bun rather than rewrite these to Node** (2026-09-16). bun 1.4.2 is
installed at `~/.bun/bin/bun`, and the suite runs as written: `bun test orch watch-pr` from this
directory, 52 tests, 0 failures. `bun.lock`, `package.json`, the `bun:test` imports, the
`#!/usr/bin/env bun` shebang and `bun-types` all stay. `check-plan.mjs` is plain Node either way.

Two facts about it that a future reader needs:

- `~/.bun/bin` is on PATH only after `source ~/.bash_profile`, so a fresh shell needs the
  absolute path. A `bun: command not found` here is a PATH problem, not a missing install.
- `scripts/bootstrap.ts` runs `bun install --frozen-lockfile` on first invocation and then
  re-execs, so **running these tools fetches a dependency from the network**. That is upstream's
  behaviour and is kept deliberately, but it is why no plugin code path may call into
  `scripts/` — see `../../HARNESS.md`.

**Which of these are mechanical, and which are not.** The first eight are string
substitutions: a worker applies them and the diff speaks for itself. The last two are not,
and a brief that treats them as such will produce text that names a tool we do not have.
`control-ui` / `control-cli` come from `cursor-team-kit`; a ported playbook must describe how
*our* surface is driven, and if we have no control skill for that surface the honest answer is
to say so in the text, not to silently drop the lane. `/loop` has no single replacement:
`create_goal` / `update_goal` cover the continuation case, and anything broader is a
judgement call to record in the port report.

**Measured at the pin, by `scripts/check-call-sites.sh --baseline`,** so a worker can see the
size of the job before starting: `AskQuestion` appears in 6 content files, `~/.cursor` in 18,
model slugs (`grok-`, `claude-`, `gpt-5...`) in 27+, `subagent_type` in 12, `Task` in 3,
`cursor-team-kit` in 10. `TodoWrite` and `make-bot-ui` appear in **no** content file — the
former because upstream already uses `todo_write`, the latter because it is a Cursor-only
skill with no content to translate. Do not report them as done work.

Anything else that differs is a porting defect, not a judgement call.

**Do not drop a principle or a playbook.** The sibling port that did so
(`shiwenbin1617/pstack`) is missing `principle-attack-the-premise` and
`principle-test-behavior-not-implementation`, and abridged `unslop` from 6,093 to 894
bytes. It looks complete and is not. Counts come from the tree, never from a README.

`make-bot-ui` is the one deliberate exclusion: Cursor-only. Excluding it must be recorded,
not silent.
