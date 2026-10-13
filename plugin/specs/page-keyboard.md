# The violin page: keyboard and screen-reader contract

Status of every finding below: **verified** by reading `plugin/src/client/client.ts` at the line
cited (branch `w8-a11y`, 1578 lines, card work not yet merged). Nothing here is inferred from a
screenshot or from memory. Where a claim is about what the browser or an assistive technology does
with a given DOM shape, it is labelled.

This file is a **contract for a later implementing unit**. Each requirement is one line, names the
element it applies to, and names the DOM attribute or key event that satisfies it. Every line
carries its current-state finding: `MET` (already correct in the source — do not redo it) or
`BROKEN` (defect, with the line that causes it).

Scope: the whole rendered page — toolbar, per-card controls, task chips, and the unassigned band.
The page is `PstackFleetPage` (`client.ts:910`).

---

## 0. What is already correct — the implementing unit must not redo these

| # | Element | Requirement | Current state |
|---|---|---|---|
| 0.1 | Card header toggle (`client.ts:1319-1334`) | The expand/collapse control is a real `<button type="button">`, so it is focusable and activates on **both Enter and Space** with no key handler of our own. | **MET** — `React.createElement('button', { type: 'button', 'data-pviolin-header': …, 'aria-expanded': isOpen, onClick: … })`. Native `<button>` gives Enter+Space for free. |
| 0.2 | Card header toggle | It carries `aria-expanded` reflecting open state. | **MET** — `'aria-expanded': isOpen` (`client.ts:1325`), `isOpen` computed at `client.ts:1114`. |
| 0.3 | Card header toggle | The state is also exposed for the test harness, not only to AT. | **MET** — `'data-pviolin-open': isOpen` on the `<li>` (`client.ts:1316`). |
| 0.4 | Every picker (`picker()`, `client.ts:846-880`) | The provider/model/effort/task-assign controls are native `<select>` elements, therefore keyboard-native (arrow keys, type-ahead, Enter) and do not need a `role` or `tabIndex`. | **MET** — `React.createElement('select', { value, onChange, … })` (`client.ts:855-867`). All four card pickers (`client.ts:1154`, `1164`, `1175`, `1274`) and the unassigned chip's picker (`client.ts:1511`) route through this one helper. |
| 0.5 | Selection remove (`client.ts:1191-1200`) | The `×` that drops one selection is a real `<button>`. | **MET** — `React.createElement('button', { key: 'remove', type: 'button', 'data-pviolin-remove-selection': …, onClick: … }, '×')`. |
| 0.6 | Task chip unassign (`client.ts:1253-1264`) | The `×` that takes a task out of a violin is a real `<button>` with a **specific** accessible name. | **MET** — `'aria-label': 'take ${task} out of ${violin.name}; it then runs on general'` (`client.ts:1259`). Names both the task and the violin. This is the model the other controls should follow. |
| 0.7 | Add-model, Delete-group, Refresh, Add-group, confirm-Add buttons (`client.ts:1209`, `1296`, `1389`, `1400`, `1432`) | Every one is a real `<button type="button">` with visible text as its name. | **MET** — verified at each cited line. |
| 0.8 | Unassigned chip picker (`client.ts:1511-1527`) | The picker that moves an unassigned task has an accessible name naming the task. | **MET** — `'aria-label': 'assign ${task} to a violin'` (`client.ts:1526`). Names the task; see 6.3 for the residual gap. |
| 0.9 | Name / new-group text inputs (`client.ts:891`, `1419`) | Both are real `<input type="text">`; the page's own Enter-to-commit is wired for the name field (`client.ts:898-900`) and the new-group field (`client.ts:1427-1429`). | **MET** — native `<input>` is focusable and typeable; Enter is handled explicitly at both sites. |

**Net: 9 requirements are already met.** Requirements 1.x–7.x below are the ones that need work.

---

## 1. Tab order through a violin card

The card is a `<li>` (`client.ts:1310`) whose children are, in document order: the header
`<button>` (`client.ts:1319`), then — only when open (`client.ts:1364`) — a `<div style=STYLE.body>`
(`client.ts:1365`) wrapping `<div style=STYLE.bodyInner>` (`client.ts:1368`) holding the `body[]`
array pushed at `client.ts:1122`, `1146`, `1208`, `1226`, `1270`, `1295`.

`body[]` is pushed in this order, which **is** the DOM order and therefore the tab order:

1. `client.ts:1122` — the name row: `field('name', textInput)` → one `<input>`.
2. `client.ts:1145-1204` — for **each** selection: provider `<select>`, model `<select>`, effort
   `<select>`, and (only when `selections.length > 1`) the remove `<button>`.
3. `client.ts:1207-1221` — "Add a model" `<button>`, only when `selections.length !== 1`.
4. `client.ts:1226-1268` — the tasks row: a `<div style=STYLE.chips>` containing a `tasks:` label
   `<span>`, then one `<span>` chip per task, each holding one unassign `<button>`.
5. `client.ts:1274-1290` — the assign-task `<select>`.
6. `client.ts:1295-1308` — "Delete group" `<button>`, only when `origin === 'custom'`.

| # | Element | Requirement | Current state |
|---|---|---|---|
| 1.1 | Card tab order | Tabbing inside an open card must visit header → name input → per-selection picker(s) → that selection's remove control → next selection's pickers… → task chips' remove controls → assign-task picker → Delete group. | **MET for order** — the DOM order above already yields it, because nothing sets `tabIndex` anywhere in the file (verified: no `tabIndex`/`tabindex` token exists in `client.ts`). Positive `tabIndex` must **not** be introduced: it would reorder the page. |
| 1.2 | Card tab order | The name `<input>` is currently the **first** stop inside the body (`client.ts:1122`), ahead of the pickers. | **BROKEN relative to the stated contract** — the contract asks for header → pickers → chips. Either accept the name field as stop #2 (it is a real control and harmless there) or move its push below the selection pushes. This is a **decision for the implementing unit**, not a defect to fix blindly. Do not "fix" it by adding `tabIndex`. |
| 1.3 | Collapsed card | A collapsed card exposes exactly one tab stop (its header), and the body must not be merely hidden with CSS while remaining focusable. | **MET** — the body is not rendered at all when closed: `isOpen ? React.createElement(…) : null` (`client.ts:1364-1370`). Nothing inside can take focus when collapsed. |
| 1.4 | Closed card's subtree | Because the body is unmounted rather than hidden, no `hidden`/`aria-hidden`/`inert` attribute is needed. | **MET** — same cite as 1.3. |
| 1.5 | Card header toggle | The header must be reachable as the **first** stop of its card, before anything in the body. | **MET** — the header button is child 1 of the `<li>` (`client.ts:1319`), the body is child 2 (`client.ts:1365`). |
| 1.6 | Unassigned band (`client.ts:1500-1529`) | Tab order across `li[data-pfleet-unassigned]` items: each item's picker, in band order. | **MET** — each `<li>` (`client.ts:1501`) holds one picker and nothing else focusable. Note the chip label `<span>` is not focusable and does not need to be. |
| 1.7 | Toolbar (`client.ts:1377-1412`) | Refresh, then Add group, before the cards. | **MET** — pushed first into `children` (`client.ts:1376`), ahead of the band `<ul>`s (`client.ts:1473-1480`). |

---

## 2. The expand/collapse control

| # | Element | Requirement | Current state |
|---|---|---|---|
| 2.1 | Header toggle `button[data-pviolin-header]` | Must be a real `<button>`. | **MET** — `client.ts:1319-1323`. |
| 2.2 | Header toggle | Must carry `aria-expanded`. | **MET** — `client.ts:1325`. |
| 2.3 | Header toggle | Must be operable with **Enter and Space**. | **MET** — native activation behaviour of `<button>`; no `onKeyDown` is needed and none exists, which is correct. |
| 2.4 | Header toggle | Must carry **`aria-controls`** pointing at the id of the region it expands. | **BROKEN** — there is no `aria-controls` (`client.ts:1319-1334`) and **the body `<div>` has no `id`** (`client.ts:1365-1369`: only `{ key: 'body', style: STYLE.body }`). Fix: give the body `id={\`pviolin-body-${violin.id}\`}` and set `'aria-controls': \`pviolin-body-${violin.id}\`` on the header. Note the body is conditionally rendered, so `aria-controls` will point at a non-existent id while collapsed — that is permitted and is the normal pattern. |
| 2.5 | Header toggle | The accessible name must say which violin it expands, not just its label text. | **BROKEN** — the button's name is the concatenation of its `<span>` children: the violin name (`client.ts:1340`), the route summary (`client.ts:1346`), the count badge (`client.ts:1349-1357`) and the `⌄` chevron (`client.ts:1358-1362`). The name therefore *does* include the violin name — **verified by reading the tree** — but it also reads out the whole route summary and a decorative `⌄`. Fix: add `'aria-hidden': true` to the chevron `<span>` (`client.ts:1358`) so it is not announced, and keep the name span as the name source. Do **not** add an `aria-label` that discards the route summary unless the summary is given its own `aria-describedby`. |
| 2.6 | Chevron `span` (`client.ts:1358-1362`) | The `⌄` is decorative; its rotation is the visual state, and the state is already carried by `aria-expanded`. | **BROKEN** — no `aria-hidden`. Screen readers announce a stray `⌄` inside the header name. Fix: `'aria-hidden': true`. |

---

## 3. Pickers — and every element that is a `div`/`span` with a handler

The authoritative question is: **which elements carry `onClick`/`onKeyDown`/`onChange` and are not
a `<button>`/`<select>`/`<input>`?** Running the static probe over `client.ts` answers it. There are
**11 handler sites** in the source. Nine of them are `select`/`input`/`button`:

| Handler site | Element | Verdict |
|---|---|---|
| `client.ts:860` (`picker()`) | `<select>` | keyboard-operable by construction |
| `client.ts:896`, `898`, `897` (`textInput()`) | `<input>` | keyboard-operable by construction |
| `client.ts:1197` | `<button>` | keyboard-operable |
| `client.ts:1215` | `<button>` | keyboard-operable |
| `client.ts:1260` | `<button>` | keyboard-operable |
| `client.ts:1302` | `<button>` | keyboard-operable |
| `client.ts:1327` | `<button>` | keyboard-operable |
| `client.ts:1391` | `<button>` | keyboard-operable |
| `client.ts:1405` | `<button>` | keyboard-operable |
| `client.ts:1426`, `1427` | `<input>` | keyboard-operable |
| `client.ts:1438` | `<button>` | keyboard-operable |

| # | Element | Requirement | Current state |
|---|---|---|---|
| 3.1 | All pickers | Every picker is a native `<select>`. | **MET** — see 0.4. There is **no** `<div>`/`<span>` with a click handler anywhere in this file (verified by AST walk, not by grep: `page-keyboard.probe.mjs` reports 11 handler sites, 0 on a non-interactive element against the pristine source). The expected "chip picker is a div" defect **does not exist here** — do not go looking for it. |
| 3.2 | The `taskHelp()` mark | The `?` that explains a task was a `<span>` with an interactive affordance (`cursor: help`) and **no handler**; it was not focusable. | **REMOVED** — `taskHelp` was dead code (its only producer, `data-phelp`, was unreachable), so the mark and its `STYLE.help` were deleted and the defect went with them. The explanation is delivered by the chip's own hover, which inlines the same sentence, and no `?` remains to squeeze the task key out of the chip. The assertion that no `data-phelp` survives is in `tests/client.spec.ts` and was shown able to fail. |
| 3.3 | Task chip `<span data-pviolin-task>` (`client.ts:1238-1265`) | A chip must not be a click target; only its inner `×` button acts. | **MET** — the chip `<span>` carries `aria-label` and styles but **no** handler; the only interactive child is the unassign `<button>` (`client.ts:1253`). |
| 3.4 | Chip `<span>` with `aria-label` (`client.ts:1238-1245`) | A non-interactive `<span>` with an `aria-label` and no role is announced inconsistently: `aria-label` on a generic element is ignored by some AT. | **BROKEN (low severity)** — verified `client.ts:1243` sets `'aria-label'` on a bare `<span>`. The task text is also its visible text child (`client.ts:1251`), so the content is not lost. Fix: drop the `aria-label` from the wrapper and instead set the accessible name on the **button** (already done, `client.ts:1259`). Do not add `role="button"` to the chip — it is not one. |

---

## 4. Focus visibility

The page ships **no stylesheet at all** (verified: no `.css` file exists under `plugin/`, excluding
`node_modules`) and styles everything inline via the `STYLE` object (`client.ts:330-577`).

| # | Element | Requirement | Current state |
|---|---|---|---|
| 4.1 | Every focusable control | Nothing may set `outline: none` without a replacement ring. | **MET** — verified: the tokens `outline`, `focus`, `focusVisible` and `boxShadow` **do not appear anywhere** in `client.ts` (AST walk over every identifier and string literal). So the page never removes the outline, and the browser's default focus ring survives on the header button, the pickers, the inputs and the `×` buttons. |
| 4.2 | Every focusable control | The page should nonetheless carry an explicit ring, matching the shell's own convention. | **BROKEN (weak)** — the page relies on the UA default ring, which on a custom-styled `<button>`/`<select>` with `appearance: none` (`STYLE.cardHeader` `client.ts:386`, `STYLE.chipButton` `client.ts:524`, `STYLE.chipPicker` `client.ts:548`) is inconsistent across browsers. The shell's own settings bundle does it explicitly: `…:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}` and `.…_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}` — verified in `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` (8 `:focus-visible` rules in that file). Fix: since the page has no stylesheet, the ring must be applied per-element. A `STYLE` entry cannot express `:focus-visible`, so the implementing unit must either (a) accept the UA ring and record that decision, or (b) move these controls to a class plus a `<style>` element injected once by the section. **Do not** add `outline: 'none'` inline without the box-shadow replacement. |
| 4.3 | Colour tokens | The earlier fix for control colours (`--dsh-*` → `--dsw-alias-*`) must have an analogue for the focus ring. | **MET as a caution** — verified `client.ts:469-474` documents that `--dsh-*` tokens do not exist in the shell and the page now uses `--dsw-alias-*` (`STYLE.picker` `client.ts:485-487`, `STYLE.option` `client.ts:491-494`, `STYLE.input` `client.ts:501-503`). Any ring added under 4.2 must use `--dsw-alias-border-l3` (the token the shell uses) **and** carry a literal fallback, as every other token here does (e.g. `client.ts:371`, `437-438`), so a shell that stops defining it does not render an invisible ring. |

---

## 5. The live region — the refused write must be announced

The page's only channel for a refusal is the status `<div>` at `client.ts:1452-1465`.

| # | Element | Requirement | Current state |
|---|---|---|---|
| 5.1 | Status div `[data-pfleet-status]` (`client.ts:1454`) | Must be a live region so a host refusal is announced without the user hunting for it. | **BROKEN** — it carries `'data-pfleet-status': '1'`, an optional `'data-pfleet-error': '1'`, and a style, and **no** `role` and **no** `aria-live` (verified `client.ts:1454-1461`). A screen-reader user learns nothing when a PUT is rejected: the sentence appears silently. |
| 5.2 | Status div | A refusal should interrupt; a note should not. | **BROKEN** — fix: the div is already only *rendered* when it has something to say (`client.ts:1452`), so it must be **permanently mounted** for a live region to fire reliably; a region that is inserted at the same moment its text arrives is announced inconsistently across AT. Requirement: render the container unconditionally, and give it `role="status"` / `aria-live="polite"` for a note and `role="alert"` / `aria-live="assertive"` when `data-pfleet-error` is set (`client.ts:1459`). Testable marker: `data-pfleet-status` must be present in the tree **before** any refusal. Note the existing spec `tests/client.spec.ts` asserts on this attribute; changing when it renders will need that assertion updated by the owning unit. |
| 5.3 | Status div | The refusal's per-problem sentences are newline-joined. | **MET for content, BROKEN for AT** — `lines.join('\n')` (`client.ts:1462`) inside a `whiteSpace: 'pre-wrap'` box (`STYLE.error` `client.ts:358`) renders correctly, but a live region announcement may collapse the newlines. Requirement: acceptable as-is; do not add markup, as multi-line announcement is AT-dependent and out of the page's control. |
| 5.4 | Loaded payload notes (`client.ts:1451`, `statusNotes` `client.ts:747-758`) | Repairs, a rejected file's parse error, and every catalog problem are also status text and are announced by the same region. | **BROKEN** — same root cause as 5.1. One fix covers both. |

---

## 6. Labels — an accessible name must say *which violin* and *which task*

| # | Element | Requirement | Current state |
|---|---|---|---|
| 6.1 | Provider/model/effort pickers (`client.ts:1154`, `1164`, `1175`) | Each picker's accessible name must name the violin it belongs to. | **BROKEN** — they are wrapped by `field()` (`client.ts:761-768`), a `<label>` whose content is `<span>provider</span>` plus the control. Verified: the label **does** associate implicitly (a `<select>` nested in a `<label>` is the label's labelled control), so the accessible name is `"provider"` — and it is the same string on all 9 cards. A screen-reader user tabbing through hears "provider, combobox" nine times with no way to tell which violin they are on. Fix: add `'aria-label': \`\${label} for \${violin.name}\`` passed through `picker()`'s existing `attrs` parameter (`client.ts:853`, already used at `client.ts:1289`) — e.g. `{ 'aria-label': 'provider for ' + violin.name }`. Do this at the four card call sites, not inside `picker()`, which does not know the violin. |
| 6.2 | Assign-task picker (`client.ts:1274-1290`) | Must say which violin the task will be assigned **to**. | **BROKEN** — it passes only `{ 'data-pviolin-assign': violin.id }` (`client.ts:1289`); its implicit label from `field()` is `"…"`, and its visible first option is `assign a task…` (`ASSIGN_TASK`, `client.ts:323`). Accessible name names neither violin nor action. Fix: add `'aria-label': \`assign a task to \${violin.name}\``. |
| 6.3 | Unassigned chip picker (`client.ts:1526`) | Name must say which task is being moved **and** what the control does. | **PARTIALLY MET** — `'aria-label': 'assign ${task} to a violin'` names the task (verified `client.ts:1526`) but not the act's effect (`it then leaves general`/`general` is not stated). Acceptable; optional improvement, not a defect. |
| 6.4 | Selection remove button (`client.ts:1191-1200`) | "remove" alone names nothing; must name violin and selection. | **BROKEN** — its only content is `'×'` (`client.ts:1199`) and it carries **no** `aria-label` (verified: `client.ts:1191-1200` has `key`, `type`, `data-pviolin-remove-selection`, `onClick`, and its child text). Its accessible name is literally `"×"`. Fix: `'aria-label': \`remove model \${index + 1} (\${selection.provider}/\${selection.model}) from \${violin.name}\``. |
| 6.5 | Task chip unassign button (`client.ts:1253-1264`) | Must name task and violin. | **MET** — `client.ts:1259`. This is the pattern 6.1, 6.2 and 6.4 should copy. |
| 6.6 | Name input (`client.ts:1130-1140`) | Must be labelled. | **MET** — wrapped by `field(…, 'name', …)` (`client.ts:1126-1141`), label text `name`. Improvement: no violin is named, but the field is *inside* the card it edits and is the first stop, so the context is unambiguous. Optional. |
| 6.7 | New-group input (`client.ts:1419-1431`) | Must be labelled. | **BROKEN (moderate)** — it is a bare `<input>` in `div.addRow` (`client.ts:1416`) with only a `placeholder` (`client.ts:1424`) and **no** `<label>` and **no** `aria-label`. A placeholder is not an accessible name substitute once the field has content. Fix: add `'aria-label': 'name the new group'`. |
| 6.8 | Card header toggle (`client.ts:1319`) | Must name its violin. | **MET** — its name includes the violin name span (`client.ts:1340`); see 2.5 for the chevron cleanup. |
| 6.9 | Toolbar buttons (`client.ts:1389`, `1400`, confirm `1432`) | Must have an accessible name. | **MET** — visible text `Refresh models`, `Add group`, `Add` respectively. Note the shell `Tooltip` wrapper (`hover()`, `client.ts:779-791`) must not be relied on for the name; it is not part of the button's name. |
| 6.10 | Icons/decoration generally | Nothing decorative may be announced. | **BROKEN** — the chevron `⌄` (`client.ts:1362`) and the `?` mark (`client.ts:809`) are announced; see 2.6 and 3.2. |

---

## 7. Structural semantics

| # | Element | Requirement | Current state |
|---|---|---|---|
| 7.1 | Band containers (`client.ts:1475-1479`, `1493-1495`) | Violin cards are a list. | **MET** — `React.createElement('ul', { 'data-pfleet-band': … })` with `li` cards (`client.ts:1310`). A screen reader announces "list, N items". |
| 7.2 | Tasks row inside a card (`client.ts:1227`) | Task chips are a **set of items**, and the row is currently a `<div>` with `display: flex` containing `<span>`s. | **BROKEN (structural)** — verified `client.ts:1227-1268`: a `<div style=STYLE.chips>` holds a `tasks:` `<span>` and one `<span>` per task (`client.ts:1238`). `<li>` outside a list is invalid HTML, so they cannot simply be changed to `<li>`; the correct fix is `role="list"` on the wrapper `<div>` (`client.ts:1229`) and `role="listitem"` on each chip `<span>` (`client.ts:1240`), **or** change the wrapper to `<ul>` and the chips to `<li>` and adjust `STYLE.chips`/`STYLE.chip` accordingly. The same applies to the unassigned band, which already uses `ul`/`li` (`client.ts:1493`, `1501`) and is therefore **MET**. |
| 7.3 | `tasks:` label `<span>` (`client.ts:1230`) | A visual label with no programmatic association. | **BROKEN (low)** — harmless as decoration; if the wrapper becomes `role="list"` with `aria-label`, this span should become `aria-hidden`. |
| 7.4 | Band headings (`client.ts:1474`, `1492`) | Headings must be real heading elements in order. | **MET** — `<h3>` for each band under the page's `<h2>` (`client.ts:1380`). Note the sequence is h2 → h3 with no h1; acceptable inside a settings section owned by the shell. |

---

## 8. Summary for the implementing unit

- **Already met (do not redo):** 0.1–0.9, 1.1 (order), 1.3–1.7, 2.1–2.3, 3.1, 3.3, 4.1, 5.3 (content), 6.5, 6.6, 6.8, 6.9, 7.1, 7.4 — **24 requirement lines**.
- **Broken (work to do):** 1.2 (decision), 2.4, 2.5, 2.6, 3.2, 3.4, 4.2, 5.1, 5.2, 5.4, 6.1, 6.2, 6.4, 6.7, 6.10, 7.2, 7.3 — **17 lines**, of which 2.4, 5.1/5.2/5.4, 6.1, 6.2 and 6.4 are the ones that actually block a keyboard or screen-reader user.
- **Highest value first:** 5.1+5.2 (a refused write is currently silent — the single worst defect on the page), then 6.1/6.2/6.4 (nine identical "provider" pickers), then 2.4 (`aria-controls`), then 4.2 (focus ring).
- **Cheapest correctness win:** the `attrs` parameter of `picker()` (`client.ts:853`) is already threaded to the DOM (`client.ts:862`); every missing picker label in 6.1/6.2 is a one-line addition at the call site. No new helper is required.
- **The static probe** `page-keyboard.probe.mjs` guards the one property that must stay true: no `onClick`/`onKeyDown`/`onChange` may ever land on a `<div>`/`<span>`. Run it as part of the implementing unit's gate.
