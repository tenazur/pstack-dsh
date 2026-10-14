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
- **Three tools** — `pstack_status` reports whether the plugin is live; `pstack_spawn` runs one
  child on a role's model and reasoning effort; `pstack_spawn_panel` runs one child per selection of
  a panel role.
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
the browser caches the bundle.

Check it took with `pstack_status`, which reports the files the plugin resolved and the skills it
can see.

## Usage

### Assign models to work

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

### Configure from the command line

`/setup-pstack` is the guided alternative: it detects the models this session can spawn on, asks for
a budget, and writes `$DSH_HOME/pstack.json`.

It writes a different file from the page. That file is a role-to-model map, and the fleet groups
file the page edits is the richer document it is derived from. So:

- **On a fresh machine the two are equivalent.** Run `/setup-pstack` and its choices become the
  starting fleet on the next load.
- **Once a groups file exists, that file wins.** A later `/setup-pstack` run writes its map, but the
  next load re-derives it from the groups file and overwrites it. Edit the fleet on the page from
  then on.

### Run work

`pstack_spawn` takes a `role` and a `prompt`:

- The three values the ported skills use: `generalPurpose` (generic delegate), `poteto-agent`
  (reads `poteto-mode` in full) and `comment-sicko` (read-only comment reviewer).
- Any task key from the fleet page: `feature`, `refactoring`, `bug-fix`, `perf-issue`, `hillclimb`,
  `judgment-and-prose`, `hardest-tasks`, `how-explorer`, `how-explainer`, `why-investigators`,
  `why-synthesizer`, `reflect-tooling`, `reflect-judgment`, `swarm-workers`, `independent-verifier`.

A role with no usable mapping inherits the parent's model rather than falling back to a sibling.

`pstack_spawn_panel` takes one of the four comparison roles and runs one child per selection.

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
