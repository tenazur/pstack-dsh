---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes an always-applied rule that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write `$DSH_HOME/pstack.json`, the overlay that sets pstack's model per role.

## Steps

### 1. Detect available models

Enumerate the model routes you can pass to a `pstack_spawn` subagent in this session. That is the dependable source. If DSH also exposes a models API or CLI that lists the user's entitled models, prefer it for completeness. If you cannot detect any, ask the user to paste the routes they have access to. Never write a real slug you have not confirmed is available. The alias `inherit-parent` is always valid even though it is not a detected slug.

### 2. Load current state

The default role-to-model mapping is the rule shape shown in step 5 below. If `$DSH_HOME/pstack.json` already exists, read it and treat its `models` and `tasks` as the current choices. Otherwise start from those defaults.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer ask_user_question over free text. Offer these four options with these exact labels, and name the current budget when the overlay records one.

- `unlimited — keep max`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`). `unlimited` leaves every effort as in that table. `large`, `medium`, and `small` set the effort token of every real slug, panel entries included, to `xhigh`, `high`, or `medium`. The effort token is the last token, or the one before a trailing `fast`, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. If the result is not a detected slug, use the same family's detected slug with the highest effort at or below the target, else mark the role as needing a choice. `inherit-parent` does not change. The slugs in the table below are Cursor's; read the live catalog for the equivalents this install actually has.

**(c) Show the roles and confirm.** Show every role with its model, marking any real slug not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` (it means: this role runs on the parent chat model) as the options. Prefer ask_user_question over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real slug written must be in the detected set. `inherit-parent` always passes. If a chosen real slug is not available, stop and ask again.

### 5. Write the rule

Write `$DSH_HOME/pstack.json` in the **version 2** overlay shape: a named model is one concrete assignment, and a task points at the names it may run on. Overwrite the whole file so re-runs stay idempotent. Shape:

```
{
  "version": 2,
  "models": {
    "main":  { "provider": "<a provider the live catalog reports>", "model": "<from that provider's list>", "reasoningEffort": "<an effort that route advertises>" },
    "smart": { "provider": "<same or another provider>", "model": "<from that provider's list>", "reasoningEffort": "<an effort that route advertises>", "description": "planning and hard reasoning" }
  },
  "tasks": {
    "feature": ["main"],
    "judgment-and-prose": ["smart"],
    "arena-runners": ["smart", "main"]
  }
}
```

Every route and effort in the file must be one the live catalog reports, and `reasoningEffort` must be an id **that route advertises** — the ladder in step 3 is Cursor's, so map the chosen budget onto the target route's own advertised ids rather than writing `xhigh` or `medium` unless the route lists them. A `models` entry named `main`, `smart`, `fast`, or `vision` overrides the built-in of that name; a name that is neither built-in nor declared is a parse error, so never point a task at a name you did not write into `models`. `inherit-parent` remains a valid task value meaning "run where the parent runs". `$DSH_HOME/pstack.json` is the overlay the spawn path reads, and it is **derived**: `$DSH_HOME/pstack-fleet.json` (the fleet groups file) is the source of truth, and the next load re-derives the overlay from it. On a machine that has no groups file yet this file is imported into one, so the choices below stick; on a machine that already has one, edit the fleet in **Settings → pstack Fleet** instead, because a later load overwrites this file from that one.

The overlay's task keys are the kebab-case menu published by the fleet reference (`feature`, `bug-fix`, `judgment-and-prose`, `interrogate-reviewers`, `arena-cross-judge-pool`, `swarm-workers`, `comment-sicko`, …). Cursor's defaults for those roles, one line per role here for readability:

```
# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` as a value: the role runs on the parent chat model (omit the spawn's `model`). Alias entries in a panel list still count toward its fan-out.
# budget: unlimited (max)
feature, refactoring: grok-4.6-fast-xhigh
bug-fix: grok-4.6-fast-xhigh
perf-issue: grok-4.6-fast-xhigh
hillclimb: grok-4.6-fast-xhigh
judgment and prose: claude-fable-5-1-thinking-max
hardest tasks: claude-fable-5-1-thinking-max
how explorer: grok-4.6-fast-xhigh
how explainer: claude-fable-5-1-thinking-max
why investigators: grok-4.6-fast-xhigh
why synthesizer: claude-fable-5-1-thinking-max
reflect tooling: gpt-5.6-sol-max
reflect judgment, divergent, synthesizer: claude-fable-5-1-thinking-max
arena runners: claude-fable-5-1-thinking-max, gpt-5.6-sol-max, grok-4.6-fast-xhigh, claude-opus-5-thinking-xhigh
arena cross-judge pool: claude-fable-5-1-thinking-max, gpt-5.6-sol-max, grok-4.6-fast-xhigh, claude-opus-5-thinking-xhigh
swarm workers: grok-4.6-fast-xhigh
architect runners: claude-fable-5-1-thinking-max, gpt-5.6-sol-max, grok-4.6-fast-xhigh, claude-opus-5-thinking-xhigh
interrogate reviewers: claude-fable-5-1-thinking-max, gpt-5.6-sol-max, grok-4.6-fast-xhigh, claude-opus-5-thinking-xhigh
```

Those defaults are Cursor slugs and none of them resolve in DSH. Every role runs on `inherit-parent` until a human maps it to a route the live catalog reports; do not write a real slug you did not read from that catalog.

### 6. Confirm

Tell the user the rule was written and that it applies to new sessions. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill` (resolves wherever pstack is installed: workspace, user, or plugin). On no, move on without pushing.
