---
name: pstack-self-check
description: Confirm the dsh-pstack plugin is actually live in the current Host — plugin layer mounted, skill provider registered, pstack_status tool registered, fleet groups file loaded — instead of merely installed. Use before trusting any pstack behaviour, when a pstack skill or tool seems missing, or right after adding or updating the plugin in a profile.
whenToUse: after installing, updating, or debugging the dsh-pstack plugin in a DSH profile
---

# pstack self-check

Installed is not loaded, and loaded is not registered. Check the layer, then the
registrations, then the fleet, then the mechanism.

## 1. Is the plugin a layer, not just a dependency?

`dsh plugin --profile <name> add <package>` only makes the package a profile **layer** when its
manifest declares `dsh.bundle`. A package without it installs as a plain dependency and never
runs, while the install still reports success.

```bash
dsh --profile <name> --dump-config | grep -A2 pstack
```

Expect an inserted row:

```yaml
- id: pstack
  name: dsh-pstack
```

Absent row: the package is in `node_modules` but not in `dsh.profile.bundles` of the profile's
`package.json`. `--dump-config` proves composition only — it never executes the plugin.

## 2. Did `apply()` actually run?

The plugin logs one line when it applies. It is not a bare heartbeat: every field names something
that was registered, so the line is evidence on its own.

```
[dsh-pstack] loaded overlay=<path> skillProvider=<provider|none> tool=pstack_status spawn=pstack_spawn spawnPanel=pstack_spawn_panel spawnProvider=<name> effortListener=<event> httpRoute=<paths|none> skillsDir=<path>
```

Compare it field by field, not as a whole string — the tail is the part that changes as the plugin
grows. `skillProvider=none` means this composition disabled skills; `httpRoute=none` means no web
plane, so the settings page is simply absent rather than broken. Find the line in the Host's own
output (a boot log, or `ctx.logger` if the Host installs a console exporter — the stock DSH
logger buffers and prints nothing).

## 3. Ask the plugin to describe itself

Call the `pstack_status` tool. It takes no arguments and reports the boot marker, the overlay it
resolved, the fleet groups file the violin page edits, and the bundled skills visible on disk:

```json
{
  "plugin": "pstack",
  "bootMarker": "[dsh-pstack] loaded",
  "overlayPath": "$DSH_HOME/pstack.json",
  "overlayPresent": false,
  "overlayRoles": [],
  "groupsPath": "$DSH_HOME/pstack-fleet.json",
  "groupsViolins": [],
  "skillsDirectory": "$DSH_HOME/node_modules/dsh-pstack/skills",
  "skillNames": ["pstack-self-check"],
  "notes": []
}
```

Every one of those nine fields is always present. Read it as a checklist, not a success banner:

| Field | What a wrong value means |
|---|---|
| `bootMarker` | differs from the constant in `src/index.ts` — you are running a stale `lib/` |
| `overlayPresent` false | no role overlay; routing falls back to the resolver's defaults, and `overlayRoles` is empty with it |
| `groupsPath` empty | the caller configured no groups file at all — the overlay is then the whole truth, and the violin page has nothing to edit |
| `groupsViolins` empty, file present | the file was rejected; the reason is in `notes`, and the page will refuse the same file |
| `groupsViolins` missing `general` | a real failure: `general` is predefined and every unassigned task runs on it, so the derived overlay has no home for them |
| `skillsDirectory` / `skillNames` empty | `skills/` is unreadable or every `SKILL.md` was skipped — a skip is warned in `notes`, never silent |
| `notes` non-empty | the reason to read before trusting the rest |

## 4. Does the fleet the person configured actually load?

There are two files, and the one the settings page edits is the second:
**`$DSH_HOME/pstack-fleet.json`**, the groups file holding **violins** — a named group with its
model selections and the task keys assigned to it. The overlay is derived
from it by `toOverlay`; the spawn path reads only the overlay and never learns violins exist.

So a self-check that stops at the overlay cannot tell a person whether their fleet loaded. From
the same `pstack_status` call:

- `groupsPath` is the resolved file, and `groupsViolins` is the violin ids in file order. Compare
  it against the built-in fleet: the five predefined violins (`general`, `working`, `planning`, `fast`,
  `vision`) are present from the first load and cannot be deleted, and one comparison violin exists
  per panel role.
- A `groupsViolins` list **missing `general`** is a real failure, not a cosmetic one.
- A violin id **is** a model name in the overlay; an id the overlay does not carry means the two
  files disagree, and the next load reconciles them (groups win) — say so rather than hand-editing.
- This tool reports **only** ids. It has no error field: when the groups file is rejected the list
  is empty and the parse reason arrives in `notes`. `groupsError` lives on the settings page's own
  payload (`GET /api/pstack/fleet`), not here — read the note first, then load the page to edit.

## 5. Is the skill registered on the registry, not just on disk?

A file on disk proves nothing; the skill must reach `ctx.skills`. The model-facing catalogue is
rendered from the registry by `@deepseek-ai/dsh-tool-skill` on `agent/pre-step`. If
`pstack-self-check` is not in the session catalogue, either the provider did not register, or
this skill was skipped — the skip warning names the file and the reason.

## What to report

State which of the five steps you ran and what each returned. "The plugin is installed" is not
a finding. "Layer present, boot line observed at boot, `pstack_status` returned
`skillNames: [pstack-self-check]` and `groupsViolins` containing `general`, catalogue lists it" is.
