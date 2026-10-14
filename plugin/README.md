# dsh-pstack

pstack for **DeepSeek Harness**: Lauren Tan's agent methodology (23 principles, 23 playbooks, a
sticky `poteto-mode`, 2 agents) with a DSH-native call layer.

The methodology text is upstream's, copied byte-identical from a pinned commit. The call layer is
this package's: how a role becomes a spawn, how a model and reasoning effort are applied to it, and
how you choose them.

**Main writer:** `ofar`. MIT.

## Install

Requires `dsh` and `pnpm` on your `PATH`. No npm account and no build step — the compiled entry is
committed:

```sh
dsh plugin --profile web add "github:tenazur/pstack-dsh#path:/plugin"
```

The `#path:/plugin` is required: this package is in a subdirectory of
<https://github.com/tenazur/pstack-dsh>, and a git URL resolves from the repository root, which has
no `package.json`.

From a checkout, which is what you want while developing — it links the tree so `lib/` is read live:

```sh
dsh plugin --profile web add "link:$PWD/plugin"
```

Restart the Host afterwards and reload the page. `add` writes the profile but does not hot-load a
running process.

**Check the profile lists it.** `add` edits `~/.dsh/profiles/<name>/package.json` in two places —
`dependencies` and `dsh.profile.bundles` — and a DSH upgrade that rebuilds the profile drops both,
silently. A package missing from `bundles` never loads, however healthy its `dependencies` entry
looks. Read the file back after installing, and again after any DSH upgrade:

```sh
node -e 'const p=require(process.env.HOME+"/.dsh/profiles/web/package.json");console.log(p.dsh.profile.bundles.includes("dsh-pstack"))'
```

Then open **Settings → pstack Fleet**. If the route line reads `0 routes available`, no LLM provider
adapter is registered — nothing to route to yet, and configuring a credential will not change that.

## The tools

Three model-facing tools. The stock DSH `subagent` tool can carry a route (`provider`, `model`,
`reasoning_effort`), but only when the Host preference `subagent-model-selection` is enabled, and it
defaults off. This plugin does not touch that preference; it owns a spawn tool instead, which works
on a default install and is where pstack's routing policy lives.

### `pstack_status`

Reports whether the plugin is live: the boot marker, the overlay file it resolved, the fleet groups
file, and the bundled skills it can see on disk. Read-only, no arguments. Use it to confirm an
install took, rather than reading the filesystem.

### `pstack_spawn`

Runs one child on a role's resolved model and reasoning effort.

| Parameter | Required | What it is |
|---|---|---|
| `role` | yes | A role key, resolved against the fleet |
| `prompt` | yes | The complete, self-contained task. The child does not see this conversation |
| `description` | no | A short label for the transcript; defaults to the role key |
| `route_index` | no | For a panel role, which entry of its route list to use. Ignored by a scalar role |

A role with no usable mapping **inherits the parent's model** — it does not fall back to a sibling
role. That is the correct behaviour on a single-route install, not a degraded one.

The tool refuses at call time rather than passing a bad route through: a model the live catalog does
not carry, or a reasoning effort that route does not advertise, is rejected by name.

### `pstack_spawn_panel`

Runs one child per selection of a panel role, all with the same prompt. The children cannot see each
other.

| Parameter | Required | What it is |
|---|---|---|
| `role` | yes | One of the four comparison roles; any other role is refused |
| `prompt` | yes | The same prompt for every child |
| `description` | no | A short label for the transcripts |
| `count` | no | Children to spawn when the role inherits (1–4, default 2). Ignored when the role has a usable route list, whose length sets the width |

Children run **sequentially** and the width is capped at 4. A same-route panel buys **coverage, not
corroboration** — it widens a search, it does not give you independent review. The result says so
when the panel was same-route.

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

### The roles you can pass

Three values come from the ported skills' own text:

- **`generalPurpose`** — the generic delegate: no agent file, the parent's model.
- **`poteto-agent`** — the routing target that reads `poteto-mode` in full.
- **`comment-sicko`** — the read-only comment reviewer.

Plus every task key from the fleet page: `feature`, `refactoring`, `bug-fix`, `perf-issue`,
`hillclimb`, `judgment-and-prose`, `hardest-tasks`, `how-explorer`, `how-explainer`,
`why-investigators`, `why-synthesizer`, `reflect-tooling`, `reflect-judgment`, `swarm-workers`,
`independent-verifier`, and the four comparison tasks.

`generalPurpose` is **not** folded into `poteto-agent`.

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

## The two files

`$DSH_HOME/pstack-fleet.json` holds the violins and is the source of truth.
`$DSH_HOME/pstack.json` is the overlay the spawn path reads, derived from the groups file on every
write.

There is one writer, `PUT /api/pstack/fleet`. `PUT /api/pstack/overlay` answers `405`: with a groups
file in front of it, a write there would succeed and then be reverted by the next load, so the route
refuses instead. Both files are renamed into place, groups first, so a crash between the two leaves
a groups file the next load can re-derive from.

The overlay has two levels, because the question is *which model does what*:

1. **Models** — a friendly name maps to one provider, one model, one reasoning effort. `off` is a
   legitimate effort, not an absence.
2. **Tasks** — a role key maps to the named model(s) it may run on. Tasks point at names, never at
   raw routes. A panel task may list several names; any other task may list exactly one, and a
   second name is refused rather than narrowed to the first.

```json
{
  "version": 2,
  "models": {
    "general":  { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "off" },
    "planning": { "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "max" },
    "fast":     { "provider": "deepseek-official", "model": "deepseek-v4-flash", "reasoningEffort": "low" }
  },
  "tasks": {
    "feature":            ["general"],
    "judgment-and-prose": ["planning"],
    "arena-runners":      ["planning", "general", "fast"],
    "bug-fix":            ["general"]
  }
}
```

`{"version": 2}` alone is a valid overlay: it resolves the built-in names (`main`, `smart`, `fast`,
`vision`, `inherit-parent`) against the live catalog. A `models` entry overrides a built-in of the
same name. The built-ins are vestigial — no violin writes them — and are kept only so an overlay
written before violins existed still resolves.

A name that is neither built-in nor declared is an error at parse time, naming the task and the
name. A task with no entry, an empty list, or `inherit-parent` inherits the parent.

Task keys are normalised, so `judgment and prose` and `judgment-and-prose` are the same task; writing
both spellings in one file is an error.

`version: 1` still reads, as *everything inherits the parent*. v1's keys are role keys and its values
are routes, while v2's are tasks and model names. The page reports that a v1 file is present and
names the routes it carried and no longer applies.

## Reasoning effort

A model's `reasoningEffort` is part of its assignment and is applied to that child through the
`agent/request` waterfall, keyed on the child the spawn tool published.

Which effort ids exist is the route adapter's answer, not this package's. An effort the route does
not advertise is **refused on write and reported on read**, never passed through and never silently
downgraded. That is also why no tier name is offered: a word like `xhigh` that names a model on some
other host's ladder is not an id this adapter advertises.

## What ships

- **47 skill directories** — 46 ported from the pin, plus `pstack-self-check`. 23 principles and 23
  playbooks among them.
- **2 agents.**
- **Three tools** — `pstack_status`, `pstack_spawn`, `pstack_spawn_panel`.
- **A `settings.section` client slot** labelled *pstack Fleet*, backed by
  `GET|PUT /api/pstack/fleet`.

Not shipped: the upstream 10-chapter guide, and the Cursor-only pieces (`make-bot-ui`, the control
skills).

## Develop

```sh
cd plugin
npm install --include=dev   # a plain `npm install` omits dev deps here, so the check has no compiler
npm run build               # tsc -> lib/ and lib/client.js
npm run check               # typecheck + tests
```

`src/` is TypeScript and ships uncompiled; the Host loads `lib/`. Rebuild after any `src/` change.

## Where the truth lives

[`HARNESS.md`](HARNESS.md) records every DSH API this plugin uses, with the source each claim was
confirmed against. It outranks this README. Read it before changing anything that touches the Host.

[`UPGRADE.md`](UPGRADE.md) records the porting rule and how to re-sync with a newer upstream pin.

## Porting

Upstream: `cursor/plugins`, `pstack/` at `5bf2b1544db739998121a306340631963c2ff3de` (MIT, Lauren
Tan), at <https://github.com/cursor/plugins>.

| | |
|---|---|
| Ported | 47 skill directories (23 principles, 23 playbooks), 2 agents |
| Ours | `pstack-self-check`, the call layer, the fleet surface, the gates |
| Not shipped | `make-bot-ui`, the control skills, the 10-chapter guide |

Four things changed at the call sites, and no others:

1. **One frontmatter line was dropped from 46 of the 47 skills** — `disable-model-invocation: true`
   (`setup-pstack` never carried it). DSH filters a skill with that key out of the model's catalog
   and refuses a named `skill` call for it, so keeping it would ship skills whose own text tells the
   model to load them and which the model cannot reach.
2. **Cursor's tool parameters were translated to DSH's.** Upstream addresses the `Task` tool;
   `pstack_spawn` is what exists here. The ported prose names only parameters this plugin's tools
   declare.
3. **Route names were replaced by role names.** Upstream's defaults name Cursor models that do not
   exist in DSH. A role resolves through the overlay against the live catalog, so a name that is not
   installed is refused rather than invented.
4. **Script paths were anchored to this package.** Four playbooks said to run `scripts/orch/orch.ts`
   and `scripts/watch-pr/watch-pr`, which resolves from upstream's repository root and nowhere else.
   They now name `<skillsDirectory>/poteto-mode/scripts/…`, and `pstack_status` reports the absolute
   `skillsDirectory`.

Everything else in the skill tree is upstream's words. See [`UPGRADE.md`](UPGRADE.md) for the rule
and the re-sync procedure.

## License

MIT. The methodology text is Lauren Tan's, from `cursor/plugins`; see [`LICENSE`](LICENSE).
