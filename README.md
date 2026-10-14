# pstack for DeepSeek Harness

A DSH plugin that ports [pstack](https://github.com/cursor/plugins/tree/main/pstack) — Lauren Tan's
agent methodology — onto DeepSeek Harness.

pstack is prose that tells a model how to delegate: 23 principles, 23 playbooks, a sticky
`poteto-mode` operating style, and two agents. The methodology text here is upstream's, carried
byte-identical from a pinned commit. Only the harness call layer is ours: how a role becomes a
spawn, how a model and reasoning effort are applied to it, and how you choose them.

Pinned upstream: `cursor/plugins` at `5bf2b1544db739998121a306340631963c2ff3de` (MIT).

## What you get

- **47 skills** — 46 ported from the pin, plus `pstack-self-check`; 23 principles and 23 playbooks
  among them, and 2 agents.
- **Three tools** for the model to delegate with.
- **A settings page** — *pstack Fleet*, where you assign models to kinds of work.

## Install

Requires `dsh` and `pnpm` on your `PATH`. No npm account, no build step — the compiled entry is
committed, so an install works straight from this repository:

```sh
dsh plugin --profile web add "github:tenazur/pstack-dsh#path:/plugin"
```

The plugin is in the `plugin/` subdirectory, and a git URL resolves from the repository root, which
has no `package.json`. The `#path:/plugin` is what tells pnpm where the package is; without it the
install fails.

Restart the Host afterwards, then reload the page. `add` writes the profile but does not hot-load a
running process. A client-side change (the *pstack Fleet* page) also needs a hard refresh, because
the browser caches the bundle. Run `pstack_status` to confirm the install took.

## Using it in your repository

Nothing to install per project. The plugin registers once, and everything it adds is available in
whatever repository you open:

- **The 47 skills** sit in your agent's catalog, so `/how`, `/architect`, `/tdd`, `poteto-mode` and
  the rest work on any checkout. They read the code in front of them; they add no files to it.
- **Tasks come from the fleet**, not from your project. `feature`, `bug-fix`, `refactoring` and the
  others are pstack's vocabulary, and their models are whatever you assigned on the settings page.
- **Routing is global.** The overlay and groups file live in `$DSH_HOME`, so one fleet covers every
  repository you work in. A role resolves to the same model whichever project is open.

Two things follow from how DSH runs children, and both surprise people once:

- **A spawned child shares your workspace, not a copy.** There is no isolation field. If two workers
  must not touch the same tree, the parent runs `git worktree add` and puts that path in the prompt.
  Several playbooks do this for you; a plain `pstack_spawn` does not.
- **Your model decides the role.** `pstack_spawn` is a tool the agent calls; you can also just ask
  for the work and let it pick. Naming a role in your prompt — "use `poteto-agent` for this" — is
  the direct way to route one task.

## Settings

There are two ways to say which model does what, and they write different files:

- **`/setup-pstack`** — guided. Detects the models this session can spawn on, asks for a budget, and
  writes `$DSH_HOME/pstack.json`.
- **The *pstack Fleet* page** — **Settings → pstack Fleet**. Edits the richer groups file, and is
  what the overlay is derived from.

On a fresh machine they are equivalent. **Once a groups file exists, that file wins** — a later
`/setup-pstack` run writes its map and the next load overwrites it from the groups file. From then
on, edit the fleet on the page.

Details, including the file formats and the reasoning-effort rules, are below.

## Skills

47 skills, all invoked by name and all usable in any repository. The ones you will reach for:

| Skill | What it does |
|---|---|
| `poteto-mode` | The front door. Give it a goal and it picks the playbook, then calls the other skills as steps need them |
| `how` / `why` | What the code does now; why it is shaped that way. Both before you edit |
| `teach` | `how` and `why` woven into one explanation |
| `architect` | Settles types and boundaries before implementation |
| `arena` | Runs several attempts at one brief and merges the best parts |
| `interrogate` | Has other models try to break a result |
| `swarm` | Fans out slices or races, then aggregates |
| `tdd`, `unslop`, `no-comments` | Build and clean: a failing test first, prose discipline, comment hygiene |
| `blast-radius` | What a change could break beyond the diff |
| `reflect` | Reviews the active transcript and routes findings to a skill edit |

plus **23 principles** you steer with by name mid-task, and **23 playbooks** `poteto-mode` selects
from. The rest are listed in [`plugin/README.md`](plugin/README.md).

You do not have to name a skill. Describe the goal and a checkable outcome and `poteto-mode` routes
it; naming one is how you override that choice.

## Settings in detail

Open **Settings → pstack Fleet**. pstack routes by **task**, not by agent name: you group tasks, and
every child spawned for a task in that group runs on the group's models.

A group is called a **violin** — one or more model selections, each a provider, a model and a
reasoning effort. Nine exist on first use:

| Band | Violins | What they are for |
|---|---|---|
| Predefined | `general`, `working`, `planning`, `fast`, `vision` | everyday work; `general` is the fallback |
| Comparison | `arena-runners`, `arena-cross-judge-pool`, `architect-runners`, `interrogate-reviewers` | one per panel task, built to hold several selections |
| Custom | whatever you add | yours; the only band you can delete |

- **Assign a task** by picking a violin from its picker. Every task key the build knows is either in
  a violin or listed as Unassigned; an unassigned task runs on `general`.
- **Move a task** by picking a different violin. It is moved, not copied — a task belongs to exactly
  one violin.
- **Edit selections** by expanding a violin and choosing provider, model and reasoning effort. Each
  picker offers only what this install has registered.
- **Add group** creates a custom violin with no tasks.
- **Refresh models** re-reads the registered models, for after you enable or configure a provider.

There is no Save button and no JSON editor. Every edit is written immediately; a refusal prints the
host's reason and keeps your edit on screen.

Four rules the page enforces:

- One task belongs to exactly one violin; a violin may hold many tasks.
- A violin with several selections may only hold comparison tasks. Two models on `feature` would
  make "which model ran my child" unanswerable.
- A violin with no selection points its tasks at `inherit-parent`.
- A capability the catalog does not offer leaves that violin empty.

### The command-line alternative

`/setup-pstack` walks the same decision from the chat: it detects the models this session can spawn
on, asks for a budget, shows every role with its model, and writes `$DSH_HOME/pstack.json` — the
overlay, which is a plain role-to-model map rather than the groups file. The overlap and which one
wins are described under [Settings](#settings) above.

## The tools

The stock DSH `subagent` tool can carry a route (`provider`, `model`, `reasoning_effort`), but only
when the Host preference `subagent-model-selection` is enabled, and it defaults off. This plugin
does not touch that preference. It owns a spawn tool instead, which works on a default install and
is where pstack's routing policy lives.

**`pstack_status`** — whether the plugin is live: the boot marker, the files it resolved, the skills
it can see. Read-only, no arguments. Use it to confirm an install took.

**`pstack_spawn`** — runs one child on a role's model and reasoning effort.

| Parameter | Required | What it is |
|---|---|---|
| `role` | yes | A role key, resolved against the fleet |
| `prompt` | yes | The complete task. The child does not see the parent's conversation |
| `description` | no | A short label for the transcript |
| `route_index` | no | For a panel role, which entry of its route list to use |

A role with no usable mapping inherits the parent's model rather than falling back to a sibling. The
tool refuses a model the live catalog does not carry, or an effort that route does not advertise,
naming the offender.

Valid `role` values are the fleet's task keys — `feature`, `refactoring`, `bug-fix`, `perf-issue`,
`hillclimb`, `judgment-and-prose`, `hardest-tasks`, `how-explorer`, `how-explainer`,
`why-investigators`, `why-synthesizer`, `reflect-tooling`, `reflect-judgment`, `swarm-workers`,
`independent-verifier` — plus three the ported skills use by name: `generalPurpose` (generic
delegate, no agent file), `poteto-agent` (reads `poteto-mode` in full) and `comment-sicko`
(read-only comment reviewer). `generalPurpose` is not folded into `poteto-agent`.

**`pstack_spawn_panel`** — runs one child per selection of a panel role, all with the same prompt.
The children cannot see each other.

| Parameter | Required | What it is |
|---|---|---|
| `role` | yes | One of the four comparison roles; any other role is refused |
| `prompt` | yes | The same prompt for every child |
| `description` | no | A short label for the transcripts |
| `count` | no | Children when the role inherits (1–4, default 2) |

Children run sequentially and the width is capped at 4. A same-route panel buys **coverage, not
corroboration**: it widens a search, it does not give you independent review. The result says so
when the panel was same-route.

## Develop

```sh
git clone https://github.com/tenazur/pstack-dsh.git
cd pstack-dsh
dsh plugin --profile web add "$PWD/plugin"
```

This links the checkout, so `plugin/lib/` is read live.

`src/` is TypeScript and ships uncompiled; the Host loads `lib/`. A `src/` change is invisible until
you build:

```sh
npm --prefix plugin install --include=dev   # once
npm --prefix plugin run build               # after every src/ change
```

`npm --prefix plugin run verify` runs the build, the type checker and the tests.

The gates:

```sh
./scripts/check-parity.sh           # skills tree against the pinned upstream
./scripts/check-call-sites.sh       # no Cursor leftovers, no invented model slugs
node scripts/check-dead-exports.mjs
node scripts/check-page-layout.mjs  # renders the built page in headless Chromium
node scripts/check-package.mjs      # what the package ships, and whether it would run
./scripts/check-route.sh            # boots a Host and calls the fleet route
```

`check-layout-witness.sh` and `check-route-witness.sh` seed a defect each and confirm the gate
refuses it.

Two need something from your machine: `check-page-layout.mjs` wants
`node scripts/page-harness/extract-react.mjs` run once first (it cuts React from an installed DSH)
and `/usr/bin/chromium`; `check-route.sh` wants a working `dsh`. Both print what they are missing.

## Layout

```
plugin/    the package — lib/ (compiled), src/, skills/, agents/, tests/
scripts/   the gates, and host-fixture/ (the profile the route gate boots)
```

## Licence

MIT. The methodology text is Lauren Tan's, from `cursor/plugins`; see [`plugin/LICENSE`](plugin/LICENSE).
