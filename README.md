# pstack for DeepSeek Harness

A **DSH plugin** that ports **pstack** — [poteto](https://github.com/cursor/plugins/tree/main/pstack)'s
agent methodology — onto DeepSeek Harness. The methodology text (playbooks, principles, a sticky
`poteto-mode`) is upstream's, carried byte-identical from a pinned commit; only the harness call
layer is ours. Pinned upstream: `cursor/plugins` at `5bf2b1544db739998121a306340631963c2ff3de`
(MIT, Lauren Tan).

## Layout

```
plugin/     the published package — lib/ (built), src/ (TypeScript), skills/, agents/, tests/
scripts/    the gates. Seven of them, each a command that exits non-zero
```

A `scratch/` directory appears while you work — the gates write their working directories there —
but it is gitignored and is **not** in this repository. Nothing you need is in it; one gate asks for
input you supply yourself, which the section below spells out.

## Install

There is **no npm package and no build step for you to run**. The compiled entry (`lib/`) is
committed on purpose, so an install works straight from this repository with nothing but `dsh` and
`pnpm` on your `PATH`.

The plugin lives in the `plugin/` subdirectory, and a git URL resolves from the repository root,
which holds no `package.json` — so the URL has to name the subdirectory. Use the `#path:` form:

```sh
dsh plugin --profile web add "github:tenazur/pstack-dsh#path:/plugin"
```

The `#path:/plugin` form is the part that matters: without it pnpm looks for `package.json` at the
repository root, finds none, and the install fails. Verified on this machine against a local git repo with the same layout — pnpm
resolved the subdirectory, read its `package.json` and linked the package.

### From a clone (or to work on the plugin)

```sh
git clone https://github.com/tenazur/pstack-dsh.git
cd pstack
dsh plugin --profile web add "$PWD/plugin"
```

This is the form to use while developing: it links the checkout, so `plugin/lib/` is read live.

### If you edit `src/`, rebuild first

`src/` is TypeScript and ships **uncompiled**; the Host loads `lib/`. A `link:` install reads `lib/`
directly, so a `src/` change is invisible until you build:

```sh
npm --prefix plugin install --include=dev   # once
npm --prefix plugin run build               # after every src/ change
```

`npm --prefix plugin run verify` is `build` + typecheck + tests, and `plugin/tests/lib-artifact.spec.ts`
fails if `lib/` is older than `src/`, so a stale build cannot pass silently.

### Finishing any install

`add` writes the profile but does **not** hot-load a running Host. Restart it, then reload the page.
A client-side change (the *pstack Fleet* page) additionally needs a hard refresh, because the browser
caches the bundle.

To confirm it took, ask the plugin rather than the filesystem: `pstack_status` reports the boot
marker, the overlay it resolved, the fleet file and the skills it can see. Or check the profile:

```sh
node -e 'const p=require(process.env.HOME+"/.dsh/profiles/web/package.json");console.log(p.dsh.profile.bundles.includes("dsh-pstack"))'
```

## What you get

- **47 skills** — 46 ported from the pin, plus our own `pstack-self-check`; 23 principles and
  23 playbooks among them, and **2 agents**.
- **Three model-facing tools** — `pstack_status` (is the plugin live?), `pstack_spawn` (one child
  on a role's resolved route and reasoning effort), `pstack_spawn_panel` (one child per route of a
  panel role, width capped at 4).
- **A settings page** — *pstack Fleet*. See below.

## The pstack Fleet settings page

Open **Settings → pstack Fleet**. This is where you say which model runs which kind of work.

pstack routes by **task**, not by agent name. Upstream answered "which model runs this" with named
agents; this port replaced that menu with **violins** — a named group of one or more model
selections (provider + model + reasoning effort) that owns some tasks. You assign a **task** to a
group, and every child spawned for that task runs on that group's models. Nothing is assigned to a
persona.

Nine violins exist the first time you look: five **predefined** (`general` is the fallback,
`working`, `planning`, `fast`, `vision`), four **comparison** (one per panel task, built to hold
several selections), plus any **custom** group you add — the only band you can delete.

What you do on the page:

- **Assign a task** by picking a violin from its picker. Every task key the build knows is either in
  a violin or listed as **Unassigned**, so nothing is invisible; an unassigned task runs on
  `general` rather than nowhere.
- **Move a task** by picking a different violin — it is *moved*, not copied, because a task belongs
  to exactly one violin.
- **Edit a violin's selections** by expanding it and choosing provider, model and reasoning effort.
  Each picker offers only what this install has registered.
- **Add group** creates a custom violin, starting with no tasks.
- **Refresh models** re-reads the live route catalog, for after you enable or configure a provider.

There is **no Save button and no JSON editor**: every edit is written immediately, and a refusal
prints the host's own sentence and leaves your edit on screen.

Four rules the page enforces, each naming the offender:

- One task belongs to exactly one violin; a violin may hold many tasks.
- A violin with several selections may only hold **comparison** tasks — two models on `feature`
  would make "which model ran my child" unanswerable.
- A violin with no selection points its tasks at `inherit-parent`, not at a name with nothing behind
  it.
- A capability the catalog does not offer leaves that violin empty rather than pointing at a model
  that cannot do the job.

## The other way to configure it, and which to use

`/setup-pstack` is the original, guided route: it detects the routes this session can spawn on, asks
for a budget, shows every role with its model, and writes `$DSH_HOME/pstack.json` — the **overlay**.
It still works, and it works alongside the page rather than instead of it.

The two write different things. The overlay is a role-to-route map; the fleet **groups file** is the
richer document the page edits, and the overlay is *derived* from it. That gives one asymmetry worth
knowing:

| On disk | What happens on the next load |
|---|---|
| no groups file, an overlay present | the overlay is **imported** into a groups file, once |
| no groups file, no overlay | the default fleet is written |
| a groups file that parses | that file wins; it is served as it stands |

So:

- **On a fresh machine the two are equivalent.** Run `/setup-pstack`, and its choices become the
  fleet's starting state on the next load.
- **Once a groups file exists, that file wins.** A `/setup-pstack` re-run writes the overlay, but
  the next load re-derives the overlay from the groups file and overwrites it, so the skill's edit
  does not stick. From then on, edit the fleet on the page.

Verified on a live Host: a home with a hand-written overlay and no groups file loaded as
`origin: imported`, and the overlay's task assignments appeared as a violin holding exactly those
tasks and that model.

The tools, the role keys, and the porting history are in [`plugin/README.md`](plugin/README.md),
the document that ships inside the package.

## Prove it

```sh
npm --prefix plugin run verify     # build + typecheck + tests
./scripts/check-parity.sh          # our skills tree vs the pin
./scripts/check-call-sites.sh      # no Cursor leftovers, no invented slugs
node scripts/check-dead-exports.mjs
node scripts/check-page-layout.mjs # drives the built page in headless Chromium
node scripts/check-package.mjs     # what npm would ship, and whether it would run
./scripts/check-route.sh           # boots a throwaway Host and calls the fleet route
```

Two of those gates can be shown to *fail* rather than merely passing:
`./scripts/check-layout-witness.sh` and `./scripts/check-route-witness.sh` seed a defect each and
assert the gate refuses it. A gate that cannot fail proves nothing, so these are the ones to run
when you want to trust the others.

**From a fresh clone, two gates need input this repository does not ship.** Both say so by name
rather than skipping silently, which is deliberate: a gate that skips is the problem they exist to
solve.

- `check-page-layout.mjs` needs `node scripts/page-harness/extract-react.mjs` to run first. It
  extracts React out of an installed DSH rather than vendoring it here.
- `check-route.sh` boots a throwaway Host, so it needs a throwaway `DSH_HOME` under `scratch/` with
  a web-app profile in it. Point it at one with `ROUTE_GATE_HOME`, or let it copy a template from
  `scratch/dsh-home` if you are working inside a checkout that has one.
## Licence

MIT. The methodology text is Lauren Tan's, from `cursor/plugins`; see [`plugin/LICENSE`](plugin/LICENSE).
