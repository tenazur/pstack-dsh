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
scratch/    gitignored; gate working directories, recreated on each run
```

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
- **A settings page** — *pstack Fleet*, where a **violin** is a named group of model selections
  that owns some tasks.

Usage, the fleet model, the tools, the roles and the porting history are all in
[`plugin/README.md`](plugin/README.md) — the document that ships inside the package. This file does
not repeat them.

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

Two of those gates can be shown to fail rather than merely passing:
`./scripts/check-layout-witness.sh` and `./scripts/check-route-witness.sh` seed defects and assert
the gate refuses. A fresh worktree must supply two gitignored inputs before the layout and route
gates will run — `node scripts/page-harness/extract-react.mjs`, and a `scratch/dsh-home` throwaway
Host home with its credential seam (`scratch/p4-settings/settings.keyless.yaml`).
Both scripts name what they are missing rather than skipping.
## Licence

MIT. The methodology text is Lauren Tan's, from `cursor/plugins`; see [`plugin/LICENSE`](plugin/LICENSE).
