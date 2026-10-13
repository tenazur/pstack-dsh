# dsh-pstack

pstack for **DeepSeek Harness**: poteto's agent methodology (playbooks, principles, a sticky
`poteto-mode`) with a DSH-native call layer.

**Main writer:** `ofar` — the DSH port, its call layer, its settings surface and its gates. The
methodology text is not mine; see **Porting** below. The package ships under the MIT licence so the
work can be forked freely.

## Porting, and what changed

**What pstack is.** [pstack](https://github.com/cursor/plugins/tree/main/pstack) is Lauren Tan's
agent methodology, written for Cursor and its `Task` tool: 23 principles that constrain how an agent
decides, 23 playbooks that sequence a kind of work, a sticky `poteto-mode` operating style, and two
named agents. It is prose that tells a model *how* to delegate — which is exactly the part that does
not survive a change of host.

**What this package is.** A port of that methodology onto DeepSeek Harness, plus the call layer DSH
needs for the prose to mean anything. The skills were copied **byte-identical** from the pinned
upstream commit and then edited at their *call sites only* — the places where upstream says "use
Cursor's Task tool" and DSH has something else. The methodology itself is untouched.

| | |
|---|---|
| Upstream | `cursor/plugins`, `pstack/` at `5bf2b1544db739998121a306340631963c2ff3de` (MIT, Lauren Tan) |
| Ported | **47** skill directories — **23** principles, **23** playbooks — and **2** agents |
| Ours | `pstack-self-check`, the call layer, the fleet surface, the gates |
| Deliberately not shipped | Cursor-only pieces (`make-bot-ui`, control skills), the 10-chapter upstream guide |

**What changed at those call sites.** Three things, and no others:

1. **One frontmatter line was dropped from 46 of the 47 skills** — `disable-model-invocation: true`
   (`setup-pstack`, the 47th, never carried it upstream). DSH filters a skill carrying that key out of
   the model's catalog *and* refuses a named `skill` call for it, so keeping it would ship skills
   whose own text tells the model to load them and which the model then cannot reach. This is the
   single line that decides whether all 23 principles are visible or none are. (One skill still
   mentions the key in its **body**, describing it as a convention for the skills *it* generates —
   that is prose, not frontmatter, and it is upstream's.)
2. **Cursor's tool parameters were translated to DSH's.** Upstream addresses the `Task` tool;
   `pstack_spawn` is what exists here. The ported prose now names only parameters this plugin's tools
   actually declare — a skill that tells a model to pass a parameter the tool rejects costs a whole
   turn, and the fix is in the skill, not in a tool that would accept and ignore it.
3. **Route names were replaced by role names.** Upstream's defaults name specific Cursor models
   (`grok-4.6-fast-xhigh`, `claude-fable-5-1-thinking-max`) that do not exist in DSH. Those survive
   in exactly one place — a fenced block in `setup-pstack` that quotes them in order to say *these are
   Cursor's defaults and they do not resolve here*. Everywhere else a role resolves through the
   overlay against the **live** route catalog, so a name that is not installed is refused rather than
   invented.

Everything else in the skill tree is upstream's words. `UPGRADE.md` records the porting rule and how
to re-sync with a newer pin.

## What it is

pstack is Lauren Tan's agent methodology, written for Cursor and its `Task` tool. **The stock DSH
`subagent` tool can carry a route** — `provider`, `model`, `reasoning_effort` — but only when a
Host-owned user preference (`subagent-model-selection`, `{enabled, allowedModels}`) is on, and
**it defaults off** (`dsh-tool-subagent/lib/index.js:412-430`;
`dsh-tool-subagent/lib/model-selection-settings.js:45,51,59`). So the capability exists and is
unavailable on a default install — which is why this plugin owns a spawn tool: it works on a
fresh install with default settings, and it is where pstack's policy belongs, namely the
role→route table, refusing a route that is not usable, and refusing an effort the route does not
advertise.

**The plugin must never flip that preference.** A plugin that silently turns on a user setting is
a plugin that surprises its owner. The spawn tool therefore owns routing outright: it reads the
overlay itself, resolves the role, and refuses a route or an effort the live catalog does not
advertise. The long form — the three DSH layers that disagree about whether model selection is on,
and why riding the stock tool would make routing depend on a setting its owner never chose — is
decision `0002` in the repository this package was built from
(<https://github.com/cursor/plugins>); it is not restated here beyond that.

## Install

From the published repository — no npm account and no build step:

```sh
dsh plugin --profile web add "github:tenazur/pstack-dsh#path:/plugin"
```

The `#path:/plugin` part is required, not decoration: this package lives in a subdirectory of
<https://github.com/tenazur/pstack-dsh>, and a git URL resolves from the repository root, which has
no `package.json`. Without it pnpm finds no package and the install fails.

From a checkout, which is what you want while developing — it links the tree so `lib/` is read live:

```sh
dsh plugin --profile web add "link:$PWD/plugin"   # `add` needs pnpm on PATH
```

`add` writes the profile but does **not** hot-load a running process: restart the Host and reload
the page afterwards.

**Then check the profile actually lists it.** `add` edits
`~/.dsh/profiles/<name>/package.json` in two places — `dependencies` and `dsh.profile.bundles` — and
a DSH **upgrade that rebuilds the profile drops both**, silently. That is not hypothetical: the
`web` profile on this machine was rebuilt for 0.2.0-rc.2 and came back without `dsh-pstack`, so the
plugin was simply absent, with nothing in the boot log to say so (the pre-upgrade profile survives
as `web.bak-0.1.5` and still lists it). A package missing from `bundles` never loads, however
healthy its `dependencies` entry looks. Read the file back after installing, and again after any
DSH upgrade:

```sh
node -e 'const p=require(process.env.HOME+"/.dsh/profiles/web/package.json");console.log(p.dsh.profile.bundles.includes("dsh-pstack"))'
```

Then: reload the page, open **Settings → pstack Fleet**, and check the route line at the top of the
page. If it reads `0 routes available`, no LLM provider adapter is registered — nothing to route to
yet, and configuring a credential will not change that. Assigning tasks is **[Usage](#usage)** below.

## Usage

### The agent selection interface — violins

pstack routes work by **task**, not by agent name. Upstream answered "which model runs this"
with named agents; this port **ditched the named-agent menu** and replaced it with **violins** —
a named group of one or more model selections (provider + model + reasoning effort) that owns some
tasks. Nothing is assigned to a *person* or a *persona*; you assign a **task** to a group, and
every child spawned for that task runs on that group's models.

Open **Settings → pstack Fleet**. Nine violins exist the first time you look — five **predefined**,
four **comparison** — and the page shows them in three bands, followed by the tasks no violin has
claimed:

| Band | Violins | What they are for |
|---|---|---|
| Predefined | `general`, `working`, `planning`, `fast`, `vision` | the everyday groups; `general` is the fallback |
| Comparison | `arena-runners`, `arena-cross-judge-pool`, `architect-runners`, `interrogate-reviewers` | one per panel task, built to hold several selections |
| Custom | anything you add with **Add group** | yours; the only band that can be deleted |

Using it:

- **Assign a task** by picking a violin from its picker. Every task key the build knows is either
  in a violin or listed as **Unassigned**, so nothing is invisible — and an unassigned task runs on
  `general` rather than nowhere.
- **Move a task** by picking a different violin: a task already in a violin is *moved*, not copied,
  because a task belongs to one violin. Taking it out of its violin leaves it unassigned again.
- **Edit a violin's selections**: expand it and set provider, model and reasoning effort. Each
  picker offers only what the live catalog reports for this install.
- **Add a group** names a new custom violin; it starts with no tasks, and only a custom violin can
  be deleted.
- **Refresh models** re-reads the live route catalog (`GET /api/pstack/fleet?refresh=1`), so the
  pickers offer what this machine has registered right now. Do this after adding or enabling a
  provider adapter.
- There is **no Save button and no JSON editor**. Every structural edit is written immediately, and
  a refusal prints the host's own sentence and keeps your edit on screen.

Rules you will meet, each enforced by the parser or the write gate and each naming the offender:

- **One task belongs to exactly one violin.** A violin may hold many tasks.
- **A violin with several selections may only hold comparison tasks.** Two models on `feature`
  would make "which model ran my child" unanswerable.
- **A violin with no selection** points its tasks at `inherit-parent` rather than at a name with
  nothing behind it.
- **A capability the catalog does not offer leaves that violin empty** rather than pointing it at a
  model that cannot do the job.

The **groups file is the source of truth** and the overlay is derived from it, so hand-editing the
overlay is not a supported edit. The rules above are the whole set a user needs; when this page and
the code disagree, `src/roles/fleet-groups.ts` is the authority.

### The two ways to configure it, and the one asymmetry

There are two doors — `/setup-pstack`, and the interface — and they behave differently depending on
what is already on disk. The reconciliation is one function, `resolveGroups`
(`plugin/src/settings/fleet-http.ts:152-198`), which is the authority for everything below:

| On disk | What a load does |
|---|---|
| **no groups file**, an overlay present | imports the overlay into a groups file, once (`fleet-http.ts:174-182`), origin `imported` |
| **no groups file**, no overlay | writes the default fleet (`fleet-http.ts:192-197`), origin `defaults` |
| **a groups file that parses** | that file wins; it is served as-is (`fleet-http.ts:157-159`), origin `file` |
| **a groups file that does not parse** | the overlay is imported instead and the groups file is rebuilt, with the parse error reported (`fleet-http.ts:160-170`) |

That gives the asymmetry to know about:

- On a machine with **no** groups file, the two doors are **equivalent**: a `/setup-pstack` run is
  imported into a groups file on the next load (`fleet-http.ts:174-182`), so the skill's choices
  become the fleet's starting state.
- On a machine that **already has** a groups file, **that file wins**. A `/setup-pstack` re-run
  writes the overlay; the next load re-derives the overlay from the groups file and rewrites it
  (`fleet-http.ts:275-282`, which also reports the repair), so the skill's edit does not stick.
  Once violins exist, edit the fleet in the interface.

Two more consequences of the same shape:

- `PUT /api/pstack/overlay` is a `405` naming the fleet route: with a groups file in front of it, a
  write there would answer `200` and be reverted by the next load, so the route refuses instead
  (`plugin/src/settings/http.ts:597-628`).
- The writes go **groups first, then overlay**, each an atomic rename. A crash between the two
  leaves a groups file the next load can re-derive from, rather than an overlay no violin agrees
  with (`fleet-http.ts:351-353`).

### The three tools

| Tool | What it is for |
|---|---|
| `pstack_status` | whether the plugin is live, the files it resolved, the skills it sees. Read-only |
| `pstack_spawn` | one child on a role's resolved route; an inheriting role sends no route at all |
| `pstack_spawn_panel` | one child per selection of a panel violin; children run **sequentially**, width capped at 4 |

### The roles you can pass

`pstack_spawn` takes a `role`. Three values come from the ported skills' own text —
**`generalPurpose`** (the generic delegate: no agent file, the parent's model and guidance),
**`poteto-agent`** (the routing target that reads `poteto-mode` in full) and **`comment-sicko`**
(the read-only comment reviewer) — plus the kebab-case task keys: `feature`, `refactoring`,
`bug-fix`, `perf-issue`, `hillclimb`, `judgment-and-prose`, `hardest-tasks`, `how-explorer`,
`how-explainer`, `why-investigators`, `why-synthesizer`, `reflect-tooling`, `reflect-judgment`,
`swarm-workers`, `independent-verifier`, and the four comparison tasks. `generalPurpose` is **not**
folded into `poteto-agent`; a role with no usable mapping inherits the parent rather than falling
back to a sibling role. `src/roles/overlay.ts` (`ROLE_KEYS`, `PANEL_ROLES`) is the list of record.

### Setup

`/setup-pstack` is the guided run: it detects the routes this session can spawn on, asks for a
budget, shows every role with its model and writes `$DSH_HOME/pstack.json`. It works as it always
did — see [`skills/setup-pstack/SKILL.md`](skills/setup-pstack/SKILL.md), which ships in this
package. Its own steps describe the *file*, because that is the file it writes; on a machine that
already has a groups file, read the asymmetry above.

## What you get

Three model-facing tools:

- **`pstack_status`** — reports whether the plugin is live: boot marker, the overlay file it
  resolved, and the bundled skills it sees on disk. Read-only, no arguments.
- **`pstack_spawn`** — one child on a role's resolved route; an inheriting role sends no route
  at all.
- **`pstack_spawn_panel`** — one child per route entry of a panel role
  (`arena-runners`, `arena-cross-judge-pool`, `architect-runners`, `interrogate-reviewers`), one
  child per named model the task lists. Children run **sequentially**; width is capped at 4.

Plus **47 skill directories** — 46 ported from the pinned upstream and `pstack-self-check`, ours —
of which **23 are principles** and **23 are playbooks**, and **2 agents**. The upstream 10-chapter
`docs/guide` is **not** shipped.

Plus a **settings page**: a `settings.section` client slot labelled *pstack Fleet*, backed by the
host's fleet route, `GET|PUT /api/pstack/fleet`. A **violin** is a named group of one or more model
selections that owns some tasks; the page shows the predefined violins, the comparison violins, any
custom ones, and the tasks no violin has claimed. Every provider, model and effort it offers comes
from the catalog payload it fetched. A `PUT` body is parsed, checked against the live catalog, and
written atomically with mode `0600` — **both files, groups first**.

## The two files

Model assignments and task mappings live in **`$DSH_HOME/pstack.json`** (`defaultOverlayPath()`),
and that is the file the spawn path reads. It is a **projection**, not the source of truth: the page
edits a second file, **`$DSH_HOME/pstack-fleet.json`** (`defaultGroupsPath()`), which holds the
violins, and `toOverlay()` derives the overlay from it on every write. There is exactly **one
writer**, `PUT /api/pstack/fleet`; `PUT /api/pstack/overlay` is a `405` because with a groups file
in front of it a write there would answer `200` and be silently reverted by the next load's
reconciliation.

The rule behind that shape: **the page must never write a file a later load would overwrite.** A
route that answers `200` and is then silently reverted is worse than a route that refuses, because
the caller believes the write landed. So the groups file is the source of truth, the overlay is
derived on every write, and both are renamed into place — groups first — so a crash between the two
leaves a groups file that the next load can re-derive from rather than an overlay no violin agrees
with. Decision `0005` in the source repository holds the full argument.

The overlay has **two levels**, because the question is *which model does what*:

1. **Models** — a friendly name maps to one concrete assignment: one provider, one model, one
   reasoning effort. `off` is a legitimate effort, not an absence. The name is what a person
   reads; `provider/model · effort` is the detail behind it.
2. **Tasks** — a role key maps to the **named model(s)** it may run on. Tasks point at names,
   never at raw routes. A panel task (`arena-runners`, `arena-cross-judge-pool`,
   `architect-runners`, `interrogate-reviewers`) may list several names; any other task may list
   exactly one, and a second name is refused by name rather than narrowed to the first.

```json
{
  "version": 2,
  "models": {
    "general":  { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "off", "description": "the default; unassigned tasks" },
    "planning": { "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "max", "description": "planning and hard reasoning" },
    "fast":     { "provider": "deepseek-official", "model": "deepseek-v4-flash", "reasoningEffort": "low", "description": "cheap parallel work" },
    "vision":   { "provider": "deepseek-official", "model": "deepseek-v4-flash-vision-exp" }
  },
  "tasks": {
    "feature":             ["general"],
    "judgment-and-prose":  ["planning"],
    "arena-runners":       ["planning", "general", "fast"],
    "bug-fix":             ["general"]
  }
}
```

The projection's model names are the **violin ids**, because a violin with one selection names its
model after itself; a violin with several names them `id-1 … id-n`, since a task's value is a list
and a repeated name would say nothing about which selection it meant. So the overlay above is what
a fleet of `general`, `planning`, `fast` and `vision` projects to, and it is illustrative of the
shape rather than a capture of the file on disk — read `$DSH_HOME/pstack.json` for that.

**A hand-written overlay needs no boilerplate.** `{"version": 2}` alone resolves the built-in names
against the live catalog, using the adapter's own description of what each model suits: `main`
(`deepseek-flash`, effort `off`), `smart` (`deepseek-v4-pro`, `max`), `fast` (`deepseek-v4-flash`,
`low`), `vision` (`deepseek-v4-flash-vision-exp`), and `inherit-parent` (not a route: a task
pointing at it runs wherever the parent runs). A `models` entry **overrides** a built-in of the
same name. These built-in names are **vestigial**: no violin writes them any more. They are kept
only so that an overlay written before violins existed still resolves; treating them as the
supported surface would mean documenting a shape nothing produces. A hand-written overlay is read
**once**, imported into a groups file on the next load; after that the groups file is the truth
and the overlay is rewritten from it.

**A name that is neither built-in nor declared is an error at parse time**, naming the task and
the name. A task never silently inherits a route nobody assigned — that is the failure mode the
whole program keeps finding. A task with no entry, or an empty list, or `inherit-parent`, does
inherit the parent, which is the correct one-route behaviour rather than a degraded one.

Task keys are normalised, so `judgment and prose` and `judgment-and-prose` are the same task — and
writing both spellings in one file is an error, not last-one-wins.

**`version: 1` still reads, and says what reading it costs.** A v1 file (`{version, roles}`) is
read as *everything inherits the parent*: v1's keys are role keys and its values are routes, while
v2's keys are tasks and its values are model names, and those are different things. The page and
`pstack_status` report that a v1 file is present, and the page names the routes v1 carried and no
longer applies, rather than pretending the file still works.

## Reasoning effort per model

A model's `reasoningEffort` is part of its assignment and is applied to that child through the
**`agent/request` waterfall** (`src/effort.ts`), keyed on the child the spawn tool published. Which
effort ids exist is the route adapter's answer, not this package's: `off`, `low`, `high` and `max`
on this machine. An effort the route does not advertise is **refused on write and reported on
read**, never passed through and never silently downgraded — which is also why no *tier name* is
offered. A word like `xhigh` that names a model on some other host's ladder is not an id this
adapter advertises, and the page would reject it.

## The one-route reality

The settings page states the measurement rather than implying a fleet. This is what it says when
the catalog offers a single route:

```
1 route available: deepseek-official/deepseek-flash
Panel roles fan out same-route. No cross-family review — seed diversity, not parity.
Measured at width 2 on bounded exploration: the pair agreed on 7 of 19 points and each
raised points the other missed (7 and 5), so same-route fan-out buys a wider search.
Do not read panel agreement as corroboration.
```

A same-route panel buys **coverage, not corroboration**.

## Develop

```sh
cd plugin
npm install --include=dev   # npm defaults to omit=dev here (standing order 13), so a plain
                            # `npm install` installs nothing and the check has no compiler
npm run build               # tsc -> lib/ and lib/client.js
npm run check               # typecheck + tests
npm test                    # node --experimental-strip-types --test tests/*.spec.ts
```

## Where the truth lives

[`HARNESS.md`](HARNESS.md) records every DSH API this plugin uses with the source it was confirmed
against, and **outranks any README**. It ships in this package; read it before changing anything
that touches the Host.

Everything else this README refers to lives in the source repository, not in this tarball: the
program, the evidence, and the numbered decisions. That is deliberate — a published package carries
what it needs to run and to be read on its own, and the design record belongs to the repository that
produces it. The upstream methodology this port is derived from is at
<https://github.com/cursor/plugins>.

## Re-syncing with upstream

[`UPGRADE.md`](UPGRADE.md) **ships in this package** and is linked above. It records the pinned
upstream commit (`cursor/plugins` `5bf2b15…`, MIT, Lauren Tan), how to reconstitute that tree, and
the porting rule that every changed skill must satisfy.

It ships because it is the one document about this package's *provenance* rather than its *design*,
and provenance is exactly what a stranger installing a port needs: which upstream revision these 46
skills came from, and how to tell whether a later one is better. The re-sync scripts it names
(`fetch-upstream.sh`, `check-parity.sh`, `check-call-sites.sh`, `batch-plan.sh`) live in the source
repository, and `UPGRADE.md` says so — running them is an authoring task, not an installing one.

## License

MIT. The methodology text is Lauren Tan's, from `cursor/plugins`; see [`LICENSE`](LICENSE), which
carries the attribution and ships in this package.

