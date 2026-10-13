# HARNESS.md — DSH call-layer contract

**This file outranks any README**, including upstream's and the port's. Every row is either
confirmed against DSH source on this machine or explicitly marked unconfirmed. When DSH and
this file disagree, DSH wins and this file is wrong.

Status: **current, re-verified 2026-10-13 against DSH `0.2.0-rc.2`.** Every row was verified in
Phase 1 against the DSH source then installed; that pass corrected three rows. A second full pass on
2026-10-13 re-derived every citation against `0.2.0-rc.2` and found **five substantive errors and a
tail of line drift** — most importantly that `ctx.settings.register`/`installSection` no longer exist
at all. Those rows now say so. When a row and DSH disagree, DSH wins and this file is wrong.

**How to keep this honest.** Cite files that are stable across releases, and where a line number is
given, re-derive it rather than trusting it. Never cite `dsh/lib/plugin-*.js`: the hash rotates
every build, so such a citation is dead on arrival and silently so.

## The constraint everything follows from

DSH's model-facing `subagent` tool carries `description`, `prompt`, `run_in_background`, and —
**when model selection is enabled** — `provider`, `model` and `reasoning_effort`
(`dsh-tool-subagent/lib/index.js:412-430`). It never carries `isolation`, `subagent_type` or
`resume_from`; those are on no schema anywhere in DSH.

**This paragraph was wrong until 2026-09-16, and the correction is the interesting part.** It
previously said the tool carries "No model. No effort." Phase 1 refuted that: the capability is
shipped. What is true is narrower — it is gated on a Host-owned user preference
(`subagent-model-selection`, `{enabled, allowedModels}`) that **defaults off**
(`dsh-tool-subagent/lib/model-selection-settings.js:45,51,59`), so on a default install the
fields are simply absent.

So role routing *can* ride on the stock tool, but only after the user turns a preference on, and
it cannot ride on it on a fresh install. That is why this package owns a spawn tool: it works
with default settings, and it is where pstack's policy belongs — the role→route table, refusing
a route that is not usable, and refusing an effort the route does not advertise.
The rule is absolute, and this package's design rests on it: **the plugin must never flip that
preference.** It registers its own spawn tool instead, which needs no user setting changed.

## Map

| Need | DSH API | Status | Source |
|---|---|---|---|
| Skill discovery | `@deepseek-ai/dsh-skill-filesystem`, mounted with `ctx.skills` | confirmed | package README |
| Skill format | `<name>/SKILL.md` or flat `<name>.md`; nested `**/SKILL.md` **not** discovered | confirmed | package README |
| Frontmatter | required `name`, `description`; optional `whenToUse`, `metadata`, `disable-model-invocation`, `user-invocable` | confirmed — parser at `dsh-skill-filesystem/lib/index.js:849`; camelCase aliases `disableModelInvocation`/`modelInvocable`/`userInvocable` are rejected (`:850-861`), but that throw is **caught at `:692-694`** and degrades to a warn-and-skip, so an alias **drops that one skill file** rather than failing the load — the silent-failure shape §Rules 9 is about | Phase 1, corrected |
| Skill name rule | `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` — so `Poteto Mode` is invalid | **confirmed** — `dsh-skill/lib/index.js:17`, first rejecting gate `:454` via `:360`; verified live | Phase 1 |
| Root ranks | 100 `.dsh/skills`, 200 `.agents/skills`, 300 custom, 400 `$DSH_HOME/skills`, 500 `~/.agents/skills`, 600 bundled | confirmed | package README |
| Model-facing spawn | `subagent` tool. Fields: `description`, `prompt`, `run_in_background`; **plus `provider`, `model`, `reasoning_effort` on model-selection-enabled instances** | confirmed — `dsh-tool-subagent/lib/index.js:401-430` (model block `:412-425`, `run_in_background` `:426`). Two gates, and the doc had the second one backwards until 2026-10-13: the base row omits model selection (`dsh-base/cordis.patch.yml:370-375`) and the web **presets enable the capability** (`dsh-web-app/presets/standard.patch.yml:95` `modelSelectionSettings: true`), so the gate that actually leaves the fields absent is the Host preference `subagent-model-selection.enabled`, defaulting false (`dsh-tool-subagent/lib/model-selection-settings.js:44`). `modelSelectionSettings` itself defaults false (`dsh-tool-subagent/lib/index.js:255`), so a non-web deployment has neither | Phase 1, corrected again |
| Programmatic start | `ctx.subagents.start(name, request)`; continuable: `ctx.subagents.startContinuable(spec)` | confirmed — `dsh-subagent/lib/types/index.d.ts:300`, `:142` | Phase 1 |
| Per-child model | `SubagentStartRequest.agentOptions` = `{ provider?, model?, reasoningEffort?, maxTokens? }`, **merge-extensible** | confirmed — `dsh-subagent/lib/types/types.d.ts:162`, `dsh-agent/lib/types/runtime-types.d.ts:21`; `subagentDepth?` is added by `dsh-subagent/lib/types/depth.d.ts:12`, so a closed 4-field copy would narrow wrongly | Phase 1, corrected |
| Per-role effort | `LlmCallConfig.reasoningEffort` via the `agent/request` waterfall | **confirmed by execution** — fires for an in-process child, and an outermost listener's override persists in the child's own request header while the parent's is unchanged (`src/effort.ts`; `tests/effort.spec.ts` reproduces it) | Phase 1 |
| Isolation | **no field**; in-process children inherit the parent's workspace. Parent runs `git worktree add` and puts the path in the prompt | confirmed — note "isolation" does appear in DSH as a word (code-runtime, connection-pump), never as this field | Phase 1, corrected |
| Wait | continuable → settlement notice + `send_message`; background → `job_output` | confirmed | this session |
| Cancel | `interrupt_agent` / `job_kill` | confirmed | this session |
| Bundle layer | `cordis.patch.yml`, top-level array, `insert: [{id, name}]`; `dsh.bundle.patch` in `package.json` is what makes a package a layer | confirmed — `dsh-app-boot/lib/index.js:495-499` (`bundlePatchFiles`), manifest shape at `dsh-app-boot/lib/types/profile.d.ts:9-10`, array enforced by `parsePatchList` `:3566`. **Do not cite `dsh/lib/plugin-*.js`**: those names are build hashes and rotate every release (the `plugin-Ddi42qoW.js` citation this row carried until 2026-10-13 named a file that no longer exists) | Phase 1, corrected |
| Install | `dsh plugin --profile <name> add <pkg>` | confirmed | CLI requires `--profile` |
| Home path | `$DSH_HOME`, else `~/.dsh` | confirmed | this machine |
| Credentials | `ctx.credentials.describe(ref)` → `{ configured, source?, writable }`, never the value | confirmed — `dsh-credentials/lib/types/index.d.ts:136`; the value path is `resolve(ref)` `:129`. **This package no longer reads it.** `enumerateRoutes` used it to withhold routes whose credential looked unconfigured; that judgement was removed 2026-10-13 (see the catalogue row below) | Phase 1, unused since 2026-10-13 |
| Settings | host service is `SettingsForms` (`configure`/`describe`/`update`/`replace`/`mutate`); the `settings.section` **page slot is client-side** via `ctx.slots.register` | refuted as written, corrected twice — `dsh-settings/lib/types/index.d.ts:80,96,102` (the file is 118 lines, so the old `:216` cited nothing) vs `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:73`; `openSection` is onboarding-only, so a slash skill cannot open the page. **`register(ns, schema)` and `installSection` do not exist anywhere in 0.2.0-rc.2** (whole-tree grep: zero hits); a plugin's own settings surface is its Schemastery `Config` plus `configure()`. This package called `installSection` guarded, so it degraded to a warning; that dead path was deleted 2026-10-13 | Phase 1, corrected again |
| Client-plane services | a browser bundle's `inject` list is resolved like any Cordis plugin's: every name must be **provided**, or the entry never activates | **confirmed the hard way.** `settingsScope` is gone from the Harness (whole-tree grep: nothing), and `src/client/client.ts` still declared it, so the web profile refused to boot: `1 entry did not activate dsh-pstack: pending (waiting for service: settingsScope)`. The page never used it — its only data path is `fetch('/api/pstack/fleet')` — so the name was pure boot cost. `plugin/package.json` `dsh.client.inject` said `["slots"]` all along, which is why no build-time check caught the drift; the two lists are independent, and only the bundle's own wins at boot. Now `['slots']`, asserted by **exact equality** in `tests/client-exec.spec.ts` and `tests/client.spec.ts` | measured 2026-10-13 |
| Reading another plugin's config | **one way, and only one: `describe()[].value`.** `SettingsForms` has no `get(ns)`; a plugin exposes its resolved values through the descriptor `describe()` returns (`dsh-settings/lib/index.js:441`), or through its own `Config`. There is no other supported cross-plugin settings read | **confirmed, and fixed in this package 2026-10-13.** The defect was `roles/catalog.ts` calling `SettingsLike.get(ns)`, an API that does not exist. Nothing threw *to the caller*: the absent method raised `TypeError`, the probe's own `catch` scored the candidate **`unusable`** — a decision, not a race — and the loop stopped on the first attempt. `resolveRole` fell through to the **derived** `DEEPSEEK_OFFICIAL_API_KEY`, `catalog.routes` came back empty, and every role inherited. The retry ladder never engaged, so the timing defences could not help: not a read that was early, an API that was not there. `SettingsLike` now requires `describe()` and the value comes from the same descriptor that proves registration (`readSettingsNamespace`). Two adjacent `get` call sites were fixed with it: `settings/http.ts` `readModelSelection` and `index.ts` `readSessionDefault`, both of which had been silently answering `undefined` for every install. Verified live: a throwaway Host on the `web` profile went from **0 to 22 routes**, all `credentialSource: 'declared'` | measured 2026-10-13 |
| Route catalogue | `enumerateRoutes(llm)` lists what `ctx.llm` reports, and consults **no credential**. `RouteCatalog.unavailable` carries registration facts only | **redesigned 2026-10-13; the old design is the cautionary half of this row.** It resolved each provider's declared `apiKeyEnv` by guessing settings namespaces (`llm-<vendor>`, …) with an 8-attempt retry ladder, a directory join and three fallback tiers, then **omitted** every model whose ref looked unconfigured. Two independent failures: DSH removed the settings API it read from (see the row above), and the derived `${PROVIDER}_API_KEY` fallback is a guess — `deepseek-official` declares `DEEPSEEK_API_KEY` (`dsh-llm-deepseek/lib/index.js:1838`) while the derivation yields `DEEPSEEK_OFFICIAL_API_KEY`, so every route was withheld and every role silently inherited. A missing credential now surfaces at spawn time as the adapter's own `MISSING_CREDENTIAL`, which is more accurate than anything derivable here, and the user cannot run a model before the client starts anyway. Net effect: `roles/catalog.ts` **861 → 323 lines**, and `credentials`/`settings` left `inject`. Measured: a throwaway home with **no** `.credentials.yaml` and **no** `settings.yaml` answers `routes=2 problems=[]` | measured 2026-10-13 |
| Logger | `ctx.logger.info` reaches a **buffering** exporter only; DSH ships no console exporter (`cordis/lib/index.js:583` `bufferSize`, `:598-604` the default exporter), so a boot line is invisible without an instrument | confirmed by execution | Phase 2, citation corrected |

## Rules that follow

1. **Do not send `isolation`, `subagent_type`, `resume_from`, `thinking`, or `environment`**
   on a model-facing spawn. They are on no schema anywhere in DSH.
   `model`, `provider`, `reasoning_effort` are a special case: they exist on the `subagent`
   tool only when model selection is enabled, which is a Host-owned user preference that
   **defaults off**. Never assume they are available; a call that needs one must either run
   through our own spawn tool or say plainly that routing is off.
2. **No invented model slugs.** Routes come from the live catalog. A hardcoded Cursor slug
   (`grok-4.6-fast-xhigh`, `claude-fable-5-1-thinking-max`) is a bug, not a default.
3. **Missing overlay means inherit the parent.** That is the correct behaviour on a
   single-route install, not a degraded one.
4. **Effort is rejected unless the route advertises it.** `resolveModelInfo().reasoning.efforts`
   is the authority. Never copy an effort id from another vendor.
5. **`xhigh`/`high`/`medium`/`low`/`max` are not universal.** They exist only if that
   exact id is on that exact route. This route advertises `off, low, high, max`.
6. **Isolation is the parent's job.** There is no field for it. If two workers must not
   share a tree, the parent makes the worktree and writes the path into the prompt.
7. **bun is installed here** (1.4.2 at `~/.bun/bin/bun`, by human decision), and the upstream
   `poteto-mode/scripts/` subtree runs as written: `bun test plugin/skills/poteto-mode/scripts/orch
   plugin/skills/poteto-mode/scripts/watch-pr` → 52 tests, 0 failures. Two constraints that follow:
   `~/.bun/bin` reaches PATH only after `source ~/.bash_profile`, so invoke `bun` explicitly in a
   non-interactive shell; and `scripts/bootstrap.ts` runs `bun install --frozen-lockfile` on first
   use and re-execs, so **no plugin code path may call into `scripts/`** — a tool that fetches and
   executes network code has no business in a boot, a tool registration, or a settings read.
8. **Declare `export const inject` for every service `apply()` touches.** Cordis holds the
   plugin inactive until they exist (`cordis/lib/index.js:1635`). Reaching for `ctx.get(…)`
   instead registers nothing, silently, depending on activation order — and activation order
   is **not** bundle order.
   The current set is `['llm', 'skills', 'subagents', 'tools']`: route enumeration, the bundled
   skill provider, `pstack_spawn`'s side effect, and the three registered tools. `'credentials'`
   and `'settings'` left this list on 2026-10-13 with the credential gate they existed for
   (see the route-catalogue row above) — every name here is a service Cordis *waits* for, so
   dropping them is two fewer ways for a composition to hold the plugin inactive. The effort
   listener touches nothing but the `agent/request` event, so it adds no name.
   `tests/apply.spec.ts` asserts the set is **exact**, deliberately: a service used by `apply()`
   and missing from `inject` is the failure mode where a plugin registers nothing and says
   nothing. Update that assertion rather than loosening it to a contains-check.

   **Optional services must be read with `ctx.get(name)`, never as `ctx.<name>`.** Cordis throws
   `cannot get property "settings" without inject` for an undeclared field read, so the two are
   not interchangeable conveniences: a field read is a hard activation failure. This package reads
   `settings` through `optionalSettings(ctx)` for exactly that reason — it is wanted, not required,
   and being wanted is not a reason to make it a boot dependency.
9. **`disable-model-invocation: true` makes a skill unreachable by the model, not merely
   quiet.** The catalog is filtered by `snapshot.skills.filter(isModelInvocable)`
   (`dsh-tool-skill/lib/index.js:217`), and a `skill` call for a filtered name throws
   `skill "<name>" is not available for model invocation` at `:147`/`:150`, before
   `ctx.skills.get()` is ever reached. Measured in a live session: the registry's `list()`
   returned 7 skills, the session's rendered catalog held 6, and the model's own call for the
   filtered one came back an error. The **only** remaining path is a human `/name` gesture,
   gated on `userInvocable` (default true). Our ported skills therefore **omit the key** —
   upstream's text names principles for the model to load, so keeping it would ship skills the
   model is told to load and cannot. That is why 46 of the 47 ported skills drop the key.
