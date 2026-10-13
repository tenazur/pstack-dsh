/**
 * Which fields this bundle needs and the payload does not have.
 *
 * Exists because of a real blank page: the previous client bundle asked the host for one shape,
 * the host answered with another, the first render read a missing array, threw, and React
 * unmounted the tree. Nothing caught it, so the tab went blank rather than showing a sentence.
 * A version skew between a cached client bundle and a rebuilt host is the expected cause here,
 * because this plugin is a `link:` in a live profile.
 */
const REQUIRED_VIEW_FIELDS = [
    'groupsPath',
    'overlayPath',
    'origin',
    'repairs',
    'groups',
    'problems',
    'catalog',
    'taskKeys',
    'panelRoles',
    'unassigned',
    'modelSelection',
];
/** True for a JSON object that is not an array and not null. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** The shape problems in a payload, empty when this bundle can read it. */
function payloadProblems(body) {
    if (!isRecord(body))
        return ['the response is not a JSON object'];
    const problems = [];
    for (const field of REQUIRED_VIEW_FIELDS) {
        if (!(field in body))
            problems.push(`missing "${field}"`);
    }
    for (const field of ['repairs', 'problems', 'taskKeys', 'panelRoles', 'unassigned']) {
        if (field in body && !Array.isArray(body[field]))
            problems.push(`"${field}" is not an array`);
    }
    const groups = body['groups'];
    if (groups !== undefined) {
        if (!isRecord(groups))
            problems.push('"groups" is not an object');
        else if (!Array.isArray(groups['violins']))
            problems.push('"groups.violins" is not an array');
        else
            for (const problem of groupProblems(groups['violins']))
                problems.push(problem);
    }
    const catalog = body['catalog'];
    if (catalog !== undefined && (!isRecord(catalog) || !Array.isArray(catalog['routes']))) {
        problems.push('"catalog.routes" is not an array');
    }
    return problems;
}
/**
 * The problems inside `groups` that would make the render lie or throw.
 *
 * A violin this page cannot place in a band takes its tasks off a page that promises every task
 * key appears exactly once, and a missing `selections`/`tasks` array would throw in the first
 * render and blank the tab. The host's parser writes neither, so this is a version-skew guard
 * rather than a validator — which is why every sentence below names the offender.
 */
function groupProblems(groups) {
    if (!Array.isArray(groups))
        return [];
    const problems = [];
    for (const [index, violin] of groups.entries()) {
        const where = `groups.violins[${String(index)}]`;
        if (!isRecord(violin)) {
            problems.push(`${where} is not an object`);
            continue;
        }
        const id = violin['id'];
        const named = typeof id === 'string' && id.length > 0 ? `${where} ("${id}")` : where;
        if (typeof id !== 'string' || id.length === 0)
            problems.push(`${where} has no "id"`);
        const origin = violin['origin'];
        if (origin !== 'predefined' && origin !== 'comparison' && origin !== 'custom') {
            problems.push(`${named} has origin ${JSON.stringify(origin)}; this page renders predefined, comparison and custom`);
        }
        if (!Array.isArray(violin['selections']))
            problems.push(`${named} "selections" is not an array`);
        if (!Array.isArray(violin['tasks']))
            problems.push(`${named} "tasks" is not an array`);
    }
    return problems;
}
/**
 * The sentence a payload this bundle cannot read earns.
 *
 * It names the field rather than describing a JSON error, and it names the likely cause, because
 * a wrong-shape payload here is nearly always a cached client bundle against a rebuilt host.
 */
function unreadableSentence(problems) {
    return (`this page cannot read the host's response (${problems.join('; ')}). ` +
        'If the plugin was just rebuilt, the browser is still running the previous client bundle: ' +
        'reload the page with the cache bypassed (Ctrl/Cmd+Shift+R).');
}
/** The host's own refusal, with its per-problem sentences on their own lines. */
function refusalSentence(body, status, statusText) {
    const failure = isRecord(body) ? body : {};
    const error = typeof failure.error === 'string' && failure.error.length > 0
        ? failure.error
        : `${String(status)} ${statusText}`;
    const problems = Array.isArray(failure.problems) ? failure.problems : [];
    return problems.length === 0 ? error : `${error}\n${problems.join('\n')}`;
}
/** The settings section id, order and label this page registers. */
const SECTION = { name: 'settings.section', id: 'pstack', order: 40 };
/** The one host route this page talks to. */
const FLEET_ROUTE = '/api/pstack/fleet';
/** The three bands, in the order the file states them and the page renders them. */
const ORIGIN_BANDS = [
    { origin: 'predefined', heading: 'Predefined' },
    { origin: 'comparison', heading: 'Comparison' },
    { origin: 'custom', heading: 'Custom' },
];
/** What an empty effort select means: the adapter materialises the route's own default. */
const EFFORT_NOT_SET = '';
/** What the task selects show before anything is chosen. */
const ASSIGN_TASK = 'assign a task…';
const ASSIGN_VIOLIN = 'assign to…';
/**
 * Shared inline styles. Inline rather than a stylesheet because a client bundle ships no CSS and
 * the shell already exposes the two custom properties used here.
 */
const STYLE = {
    page: {
        maxWidth: 760,
        minWidth: 0,
        // The page is a column of cards; every level below it needs to be allowed to shrink below its
        // content, or the longest model description sets the width of the whole page.
        display: 'flex',
        flexDirection: 'column',
        padding: '4px 2px 24px',
        fontSize: 13,
        lineHeight: 1.45,
    },
    titleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    title: { margin: '0 0 6px', fontSize: 18 },
    toolbar: { display: 'flex', gap: 6, marginBottom: 6 },
    addRow: { display: 'flex', gap: 6, marginBottom: 8 },
    note: {
        fontSize: 12,
        padding: '6px 8px',
        marginBottom: 10,
        borderRadius: 4,
        whiteSpace: 'pre-wrap',
        background: 'var(--dsw-alias-bg-layer-2, #8080801a)',
    },
    /**
     * The live region with nothing to announce: the zero it paints is the whole point.
     *
     * The status `<div>` is mounted on every render so that a refusal is announced rather than
     * inserted (`STYLE.note`/`STYLE.error` above are what it wears once it has a sentence). An empty
     * element with the note's padding would still push the page down by 24px, so this variant keeps
     * the box at zero height until there is text — the DOM contract stays, the layout does not move.
     */
    silent: {
        padding: 0,
        margin: 0,
    },
    error: {
        fontSize: 12,
        padding: '6px 8px',
        marginBottom: 10,
        borderRadius: 4,
        whiteSpace: 'pre-wrap',
        color: 'var(--dsw-alias-state-error-primary, #e5534b)',
        background: 'var(--dsw-alias-bg-layer-2, #8080801a)',
    },
    bandHeading: { fontSize: 13, margin: '10px 0 4px', opacity: 0.8, textTransform: 'uppercase', letterSpacing: 0.4 },
    band: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
    // The card, band for band, is the shell's own PluginCard (`dsh-client-ui-settings-plugins`):
    // a hairline border that brightens on hover, the open card on the *darker* layer (`bg-layer-2`,
    // not `-3`), a header that is a full-width button with 14px/16px padding, and a body separated by
    // a hairline that stops short of the card's edges. Matching it is what makes this page look like a
    // settings page rather than a form that happens to live in one.
    card: {
        border: '0.5px solid var(--dsw-alias-border-l4, #80808040)',
        background: 'var(--dsw-alias-bg-layer-3, transparent)',
        borderRadius: 16,
        transition: 'border-color .16s, background .16s',
    },
    cardOpen: {
        background: 'var(--dsw-alias-bg-layer-2, #80808012)',
        borderColor: 'var(--dsw-alias-label-dimmed, #80808080)',
    },
    // The header and body metrics are the plugin market's own, copied rule for rule from
    // `dsh-client-ui-settings-plugins` `.PluginCard`: a full-width button at 14px/16px, the name at
    // 15px/600 over a 13px tertiary line with 4px between them, a chevron that rotates, a body that
    // starts on a hairline inset 16px and ends 8px later. Nothing caps a height: the header's own two
    // lines are the "standard height", and an open card grows by its content and reserves nothing.
    cardHeader: {
        appearance: 'none',
        width: '100%',
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        background: 'transparent',
        border: 0,
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
    },
    cardHeadText: { display: 'flex', flexDirection: 'column', flex: 1, gap: 4, minWidth: 0, maxWidth: '100%' },
    cardName: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 15,
        fontWeight: 600,
        lineHeight: 1.4,
    },
    cardSummary: {
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: 13,
        lineHeight: 1.5,
        // One line, clipped, because the header is the standard height: `planning`'s route carries the
        // adapter's whole sentence and would otherwise make its card taller than its neighbours. The
        // header's own hover shows the route in full, so the clip hides nothing.
        //
        // `width: 100%` inside a `minWidth: 0` column is what makes the clip real: with `nowrap` in a
        // flex column that its own content can widen, `overflow: hidden` has no smaller box to clip
        // against and the line measured 920px in a 720px window.
        // `overflow` and `text-overflow` do not apply to an inline box: the route line has to be a block
        // for the ellipsis to exist at all, which is why it measured 920px however its ancestors were
        // constrained.
        display: 'block',
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    chevron: {
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        flex: 'none',
        transition: 'transform .16s',
    },
    badge: {
        flex: 'none',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        border: '0.5px solid var(--dsw-alias-border-l3, #80808040)',
        borderRadius: 999,
        padding: '0 6px',
        whiteSpace: 'nowrap',
    },
    body: {
        borderTop: '0.5px solid var(--dsw-alias-border-l2, #80808030)',
        margin: '0 16px',
        paddingBottom: 8,
        // `minWidth: 0` at every level: a flex item's automatic minimum size is its content, so one long
        // model description was widening the body, then the card, then the page — which is what pushed
        // the controls past the card's edge rather than the controls being too wide themselves.
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
    },
    bodyRow: { paddingTop: 12, minWidth: 0 },
    rows: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0, maxWidth: '100%' },
    field: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        minWidth: 0,
        maxWidth: '100%',
        // `flex-basis: 0` with `flex-grow: 1` is what makes two fields share the row instead of each
        // claiming its content width; the old `1 1 200px` basis let a wide control set the floor.
        flex: '1 1 0',
    },
    fieldLabel: { opacity: 0.75, minWidth: 52, flex: 'none' },
    // The control styles below use the Host's own alias tokens, not the `--dsh-*` fallbacks this
    // page started with: those tokens do not exist in the shell, so `color: inherit` on a `<select>`
    // left the popup list painting the platform's white — the one control whose text is drawn by the
    // browser rather than by us. `--dsw-alias-*` is the live vocabulary
    // (`dsh-client-ui-settings-models/lib/client.js` uses exactly these for its own inputs and
    // selects), and an `option` repeats the colours because a native dropdown inherits neither.
    picker: {
        // A native `<select>` sizes itself to its widest `<option>` and `min-width: 0` does not stop it:
        // the box has to be given a width that does not depend on content. `width: 100%` inside a field
        // that is itself allowed to shrink does that, and the label clips with the whole text on hover.
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
        textOverflow: 'ellipsis',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        border: '0.5px solid var(--dsw-alias-border-l4, #80808040)',
        borderRadius: 8,
        padding: '3px 6px',
    },
    option: {
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
    },
    input: {
        flex: 1,
        minWidth: 0,
        maxWidth: '100%',
        fontFamily: 'inherit',
        fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        border: '0.5px solid var(--dsw-alias-border-l4, #80808040)',
        borderRadius: 8,
        padding: '3px 6px',
    },
    chips: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0 },
    chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        border: '0.5px solid var(--dsw-alias-border-l4, #80808040)',
        borderRadius: 999,
        padding: '1px 4px 1px 8px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        // A chip never grows and never shrinks: it is a label with a control on its end, and a flex row
        // that lets it shrink is what pushed the label out of the box in the first place.
        flex: 'none',
        maxWidth: '100%',
    },
    chipLabel: { flex: 'none', whiteSpace: 'nowrap' },
    chipButton: {
        appearance: 'none',
        border: 0,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1,
        padding: '0 2px',
        flex: 'none',
    },
    unassignedChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        border: '0.5px dashed var(--dsw-alias-border-l3, #80808040)',
        borderRadius: 999,
        padding: '1px 2px 1px 8px',
        flex: 'none',
        maxWidth: '100%',
    },
    // The control that moves a chip keeps the chip's own height so the row stays one line tall.
    chipPicker: {
        appearance: 'none',
        border: 0,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        font: 'inherit',
        cursor: 'pointer',
        padding: '0 2px',
        minWidth: 0,
        flex: 'none',
    },
    aside: { opacity: 0.75, fontSize: 12 },
    // The wrapper the hover puts around its child fills its parent and no more. `display: contents`
    // was the first attempt and it was wrong: inside the header's flex column it removes the wrapper
    // from the box tree, so the line inside is measured against the column rather than a parent and the
    // clip has nothing to clip to — measured at 920px by the layout gate.
    hoverHost: { display: 'block', minWidth: 0, maxWidth: '100%' },
};
/**
 * A violin id for a name a person typed: lowercased, every run of non-alphanumerics one hyphen.
 *
 * The id is also the model name in the overlay, so it has to be stable and readable. The host
 * numbers a colliding id on write (`withViolin`), so this slug is the proposal, not the verdict.
 */
function slugifyViolinId(name) {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug.length === 0 ? 'violin' : slug;
}
/** The groups document with one violin's selections replaced. */
function withSelections(file, id, selections) {
    return {
        version: 1,
        violins: file.violins.map((violin) => (violin.id === id ? { ...violin, selections } : violin)),
    };
}
/** The groups document with one violin's label replaced. The id stays: the overlay hangs off it. */
function withViolinName(file, id, name) {
    return {
        version: 1,
        violins: file.violins.map((violin) => (violin.id === id ? { ...violin, name } : violin)),
    };
}
/** The groups document with a task moved into a violin, out of whichever one held it. */
function withTask(file, task, id) {
    return {
        version: 1,
        violins: file.violins.map((violin) => {
            const without = violin.tasks.filter((entry) => entry !== task);
            return violin.id === id ? { ...violin, tasks: [...without, task] } : { ...violin, tasks: without };
        }),
    };
}
/** The groups document with a task in no violin, so it runs on `general`. */
function withoutTask(file, task) {
    return {
        version: 1,
        violins: file.violins.map((violin) => violin.tasks.includes(task) ? { ...violin, tasks: violin.tasks.filter((entry) => entry !== task) } : violin),
    };
}
/** The groups document without one violin. Its tasks fall back to `general` on the next render. */
function withoutViolin(file, id) {
    return { version: 1, violins: file.violins.filter((violin) => violin.id !== id) };
}
/** One selection with a different effort, or with the adapter's default when `effort` is absent. */
function withEffort(selection, effort) {
    return {
        provider: selection.provider,
        model: selection.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        ...(selection.description === undefined ? {} : { description: selection.description }),
    };
}
/**
 * One selection moved onto another route of the same or another provider.
 *
 * The effort survives only when the new route advertises it. Dropping it is the honest outcome:
 * the alternative is either a document the host refuses or an effort chosen on the person's
 * behalf, and this page does neither.
 */
function reselectRoute(selection, provider, model, route) {
    const kept = selection.reasoningEffort !== undefined && route !== undefined && route.efforts.includes(selection.reasoningEffort)
        ? selection.reasoningEffort
        : undefined;
    return {
        provider,
        model,
        ...(kept === undefined ? {} : { reasoningEffort: kept }),
        ...(selection.description === undefined ? {} : { description: selection.description }),
    };
}
/**
 * A selection to start a new row from: this violin's own first, then `general`'s, then the
 * catalog's first route. Copied rather than composed, so a new row can only ever hold a route the
 * payload already contained; the catalog case carries no effort, because the adapter default is
 * the one answer this page may not guess at.
 */
function copiedSelection(violin, file, payload) {
    const own = violin?.selections[0];
    if (own !== undefined)
        return { ...own };
    const general = file.violins.find((entry) => entry.id === 'general')?.selections[0];
    if (general !== undefined)
        return { ...general };
    const route = payload.catalog.routes[0];
    return route === undefined ? undefined : { provider: route.provider, model: route.model };
}
/** One band's violins, in the order the file lists them. */
function bandViolins(file, origin) {
    return file.violins.filter((violin) => violin.origin === origin);
}
/**
 * Every violin in the order the page shows them: band by band, the file's order inside each.
 *
 * The last band's picker offers violins, and a picker whose order disagreed with the cards above
 * it would make the reader translate between two lists for no reason.
 */
function displayOrder(file) {
    return ORIGIN_BANDS.flatMap((band) => bandViolins(file, band.origin));
}
/**
 * The one line a card's header carries: what this violin resolves to.
 *
 * `off` is printed like any other effort, because it is one — an effort the route advertises, not
 * the absence of an effort. A violin with no selection says what its tasks do instead, which is
 * inherit the parent's route.
 */
/** True for the four violins whose id is a task key rather than a place tasks are put. */
function isComparisonViolin(violin) {
    return violin.origin === 'comparison';
}
/**
 * What one violin's header says under its name.
 *
 * The last clause is the one that matters for a comparison violin, and it differs per violin on
 * purpose: three of the panel roles fan out one child per named model, while
 * `arena-cross-judge-pool` is a **pool** — arena picks a single entry from it, preferring a family
 * other than the parent's. Labelling all four "one child per model" would be a lie about the pool.
 */
function violinSummary(violin) {
    const selections = violin.selections;
    const only = selections[0];
    if (selections.length === 0) {
        return isComparisonViolin(violin)
            ? 'no model selected — this task inherits the parent'
            : 'no model selected — tasks here inherit the parent';
    }
    if (only === undefined)
        return 'no model selected';
    // A description the file carries is shown after the route: it is the one line of prose this format
    // holds, and with the page no longer editing it the header is where it can still be read.
    const note = only.description === undefined ? '' : ` — ${only.description}`;
    if (selections.length === 1) {
        const effort = only.reasoningEffort === undefined ? '' : ` · ${only.reasoningEffort}`;
        return `${only.provider}/${only.model}${effort}${note}`;
    }
    const routes = selections.map((selection) => `${selection.provider}/${selection.model}`).join(' · ');
    const how = violin.id === 'arena-cross-judge-pool'
        ? 'one is picked per run'
        : `one child per model (${String(selections.length)} wide)`;
    return `${String(selections.length)} models — ${routes} — ${how}`;
}
/**
 * The sentences the status line carries when the payload has something to say.
 *
 * They are the host's own, verbatim: a repair, a rejected file's parse error, and each problem the
 * live catalog found. Summarising them into "3 problems" would hide the one thing the reader
 * needs — which violin, task or route is the offender.
 */
function statusNotes(payload) {
    const notes = [];
    if (payload.repairs.length > 0) {
        notes.push(`the groups file needed repairs while loading: ${payload.repairs.join('; ')}`);
    }
    if (payload.groupsError !== null)
        notes.push(payload.groupsError);
    for (const problem of payload.problems)
        notes.push(problem);
    if (payload.modelSelection.present && payload.modelSelection.enabled === true) {
        notes.push('the stock subagent tool picks its own models; pstack_spawn does not — it routes each role from this file.');
    }
    return notes;
}
/** A labelled control, so the page's pickers read as sentences rather than bare selects. */
function field(React, key, label, control) {
    return React.createElement('label', { key, style: STYLE.field }, React.createElement('span', { style: STYLE.fieldLabel }, label), control);
}
/**
 * One piece of chrome the page explains on hover, in the shell's own bubble.
 *
 * Used for the `?` beside a task key and for the two toolbar buttons: their names are short and
 * their meaning is not, and a wall of standing prose beside each control is exactly the shape the
 * human asked to be rid of. A missing primitive degrades to the bare child — never to a broken
 * render — so the page still works if a future shell stops seeding one.
 * @param Tooltip - the shell's primitive, or `undefined` when it was not provided.
 */
function hover(React, Tooltip, key, label, child) {
    if (Tooltip === undefined)
        return React.createElement('span', { key }, child);
    // The child is re-wrapped in a box this page controls, because the shell's Tooltip puts a bare
    // `<span>` around it: an inline box with no width discipline takes its child's intrinsic width and
    // becomes the floor for the row, the card and the page — measured at 920px by
    // `scripts/check-page-layout.mjs` before this existed. `display: contents` takes the wrapper out of
    // layout altogether, so the control sits exactly where it would without a hover.
    return React.createElement(Tooltip, { key, label, side: 'top', delayMs: 120 }, React.createElement('span', { style: STYLE.hoverHost }, child));
}
/**
 * What each task key is for, in one line, for the hover.
 *
 * These are the ported skills' own descriptions, said short: `plugin/skills/**` is the authority
 * and this table is a summary of it, never a second definition. A key with no row falls back to
 * "a pstack task key" rather than inventing a purpose.
 */
const TASK_HELP = {
    feature: 'builds a feature end to end (the feature playbook)',
    refactoring: 'restructures code without changing behaviour',
    'bug-fix': 'reproduces a defect, fixes the cause, proves it',
    'perf-issue': 'finds and removes a measured performance problem',
    hillclimb: 'grinds a hard problem upward in small verified steps',
    'judgment-and-prose': 'the hardest reasoning and the writing that carries it',
    'hardest-tasks': 'the tasks nothing cheaper should be trusted with',
    'how-explorer': 'reads the code to explain how a subsystem works',
    'how-explainer': 'turns that reading into one explanation a person can follow',
    'why-investigators': 'digs through history and artifacts for why a choice was made',
    'why-synthesizer': 'merges those findings into one cited account',
    'reflect-tooling': 'reviews the session for tooling and skill gaps',
    'reflect-judgment': 'reviews the session for judgement and process gaps',
    'swarm-workers': 'one worker in a wide parallel sweep',
    'arena-runners': 'one candidate in an arena; the same task, run several times',
    'arena-cross-judge-pool': 'judges other candidates; prefers a different model family',
    'architect-runners': 'one design candidate when a shape is being chosen',
    'interrogate-reviewers': 'one adversarial reviewer over a change',
    'independent-verifier': 'a second opinion that does not write the diff it checks',
    'poteto-agent': 'an ad-hoc helper that reads poteto-mode in full',
    'comment-sicko': 'a read-only reviewer that hunts noise in comments',
};
/**
 * The accessible name of one picker inside a violin card: `provider for working`.
 *
 * Nine cards render the same three pickers, and the `<label>` wrapper (`field()` above) can only say
 * `provider` — so without this a screen-reader user tabbing the page hears "provider, combobox" nine
 * times and cannot tell which violin they are on. `picker()`'s `attrs` parameter is already threaded
 * onto the `<select>` (this file §picker), so this is one attribute per call site and no new
 * helper. The violin's **name** is used, not its id, because the name is what the card header says.
 */
function pickerName(label, violin) {
    return `${label} for ${violin.name}`;
}
/** A `<select>` whose every option the caller read from the payload; `attrs` carries its test id. */
function picker(React, Tooltip, key, value, options, onChange, attrs = {}) {
    const control = React.createElement('select', {
        key,
        value,
        onChange: (event) => onChange(event.target.value),
        style: STYLE.picker,
        ...attrs,
    }, ...options.map((option) => React.createElement('option', { key: option.value, value: option.value, style: STYLE.option }, option.label)));
    // The hover: the current value first, then every other option with its own sentence. Long labels
    // are the reason the control is capped (`STYLE.picker` clips), so the hover is where the whole
    // text lives — for the unselected models too, which a native dropdown cannot do per row.
    const chosen = options.find((option) => option.value === value);
    const described = options.filter((option) => option.hint !== undefined);
    const lines = [
        ...(chosen === undefined ? [] : [`selected: ${chosen.label}`]),
        ...described.map((option) => `${option.value === value ? '▸' : '·'} ${option.hint ?? option.label}`),
    ];
    if (lines.length === 0)
        return control;
    return hover(React, Tooltip, `${key}-options`, lines.join('\n'), control);
}
/** A free-text control that reports every keystroke and commits on blur or Enter. */
function textInput(React, key, value, onChange, onCommit, attrs = {}) {
    return React.createElement('input', {
        key,
        type: 'text',
        value,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
        onBlur: () => onCommit(),
        onKeyDown: (event) => {
            if (event.key === 'Enter')
                onCommit();
        },
        style: STYLE.input,
        ...attrs,
    });
}
/**
 * The section body. The shell hands a section owner only `close`, which this page has no use for;
 * the `Tooltip` is the page's own business, read from the primitives module the shell seeds.
 */
function PstackFleetPage(React, Tooltip) {
    const viewState = React.useState(null);
    const view = viewState[0];
    const setView = viewState[1];
    const groupsState = React.useState(null);
    const groups = groupsState[0];
    const setGroups = groupsState[1];
    /** The host's refusal, or the reason this page could not read an answer. Null when quiet. */
    const statusState = React.useState(null);
    const status = statusState[0];
    const setStatus = statusState[1];
    /** The violins whose body is open, by id. Collapsed is the default: ten bodies is a wall. */
    const openState = React.useState([]);
    const open = openState[0];
    const setOpen = openState[1];
    /**
     * Uncommitted text, by field key. A name or a note is only a document edit on blur or Enter, so
     * what the person is typing has to live somewhere that is not the document being PUT.
     */
    const draftState = React.useState({});
    const drafts = draftState[0];
    const setDrafts = draftState[1];
    const addingState = React.useState(false);
    const adding = addingState[0];
    const setAdding = addingState[1];
    const newNameState = React.useState('');
    const newName = newNameState[0];
    const setNewName = newNameState[1];
    const setDraft = (key, value) => setDrafts((previous) => ({ ...previous, [key]: value }));
    const clearDraft = (key) => setDrafts((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
    });
    /**
     * Mount a payload: the view — catalog, task keys, panel roles — and the document it carried.
     *
     * Reached only with a body that passed {@link payloadProblems}, from both `load` and `put`. That
     * order is the point: a payload this bundle cannot read must never become a mounted view, because
     * the first render would read a missing array, throw, and React would unmount the tree — leaving
     * the tab blank, which tells the user nothing and looks like the plugin is dead.
     */
    const applyView = (next) => {
        setView(next);
        setGroups(next.groups);
    };
    const load = (refresh) => {
        void fetch(refresh ? `${FLEET_ROUTE}?refresh=1` : FLEET_ROUTE, { headers: { accept: 'application/json' } })
            .then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) {
                setStatus(refusalSentence(body, response.status, response.statusText));
                return;
            }
            const problems = payloadProblems(body);
            if (problems.length > 0) {
                console.warn('dsh-pstack client: unreadable /api/pstack/fleet payload', {
                    problems,
                    receivedKeys: isRecord(body) ? Object.keys(body).sort() : [],
                });
                setStatus(unreadableSentence(problems));
                return;
            }
            applyView(body);
            setStatus(null);
        })
            .catch((failure) => setStatus(failure instanceof Error ? failure.message : String(failure)));
    };
    React.useEffect(() => {
        load(false);
    }, []);
    /**
     * Write the document, at once and whole.
     *
     * The local document changes first, because the edit is what the person just made and a refused
     * write has to leave it on screen for them to fix. The response then replaces it: the host
     * numbers a colliding id, drops a task it moved, and normalises what it writes, so the file is
     * the truth and the local edit was only ever a proposal.
     */
    const put = (next) => {
        setGroups(next);
        setStatus(null);
        void fetch(FLEET_ROUTE, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(next),
        })
            .then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) {
                setStatus(refusalSentence(body, response.status, response.statusText));
                return;
            }
            const problems = payloadProblems(body);
            if (problems.length > 0) {
                console.warn('dsh-pstack client: unreadable /api/pstack/fleet write answer', { problems });
                setStatus(unreadableSentence(problems));
                return;
            }
            applyView(body);
        })
            .catch((failure) => setStatus(failure instanceof Error ? failure.message : String(failure)));
    };
    // -----------------------------------------------------------------------------------------
    // The edits. Each returns the next document; none of them derives the overlay.
    // -----------------------------------------------------------------------------------------
    const replaceSelection = (file, violin, index, next) => {
        const selections = violin.selections.map((selection, at) => (at === index ? next : selection));
        put(withSelections(file, violin.id, selections));
    };
    const removeSelection = (file, violin, index) => {
        put(withSelections(file, violin.id, violin.selections.filter((_selection, at) => at !== index)));
    };
    const addSelection = (file, violin, payload) => {
        const start = copiedSelection(violin, file, payload);
        if (start === undefined)
            return;
        put(withSelections(file, violin.id, [...violin.selections, start]));
    };
    const renameViolin = (file, violin, name) => {
        const trimmed = name.trim();
        // The host reads an empty name as the id, so writing one would silently disagree with what
        // the header shows. The page simply does not write it.
        if (trimmed.length === 0)
            return;
        put(withViolinName(file, violin.id, trimmed));
    };
    const addGroup = (file, payload) => {
        const name = newName.trim();
        if (name.length === 0)
            return;
        const start = copiedSelection(undefined, file, payload);
        const violin = {
            id: slugifyViolinId(name),
            name,
            origin: 'custom',
            selections: start === undefined ? [] : [start],
            tasks: [],
        };
        setAdding(false);
        setNewName('');
        put({ version: 1, violins: [...file.violins, violin] });
    };
    /** The providers the catalog enumerated, in first-seen order. */
    const providers = (payload) => {
        const seen = [];
        for (const route of payload.catalog.routes) {
            if (seen.some((option) => option.value === route.provider))
                continue;
            seen.push({ value: route.provider, label: route.provider });
        }
        return seen;
    };
    /**
     * That provider's routes, as the payload reports them and nothing else.
     *
     * A selection whose route the catalog no longer enumerates therefore gets an **empty** picker:
     * the alternative is offering the file's own slug back as if the catalog had it, which is the
     * one thing this page may not do. The status line carries the host's sentence about it.
     */
    const models = (payload, provider) => payload.catalog.routes
        .filter((route) => route.provider === provider)
        .map((route) => ({
        value: route.model,
        label: route.description === undefined ? route.model : `${route.model} — ${route.description}`,
        hint: route.description === undefined ? route.model : `${route.model}: ${route.description}`,
    }));
    /** `not set` plus exactly the efforts the selected route advertises. */
    const efforts = (payload, selection) => {
        const route = payload.catalog.routes.find((candidate) => candidate.provider === selection.provider && candidate.model === selection.model);
        return [
            {
                value: EFFORT_NOT_SET,
                label: 'not set (adapter default)',
                hint: `not set — the adapter uses its own default${route?.defaultEffort === undefined ? '' : ` (${route.defaultEffort})`}`,
            },
            ...(route?.efforts ?? []).map((effort) => ({
                value: effort,
                label: effort,
                hint: effort === 'off'
                    ? 'off — this is an effort, not an absence: the model runs without reasoning'
                    : `${effort} — reasoning effort, as this route's adapter advertises it`,
            })),
        ];
    };
    const card = (violin, file, payload) => {
        const isOpen = open.includes(violin.id);
        // The id of the region the header expands, and the target of the header's `aria-controls`. Built
        // in the card closure so the header and the body cannot be given two different ids.
        const bodyId = `pviolin-body-${violin.id}`;
        // A comparison violin *is* its task: `payload.panelRoles` is the host's own list of the keys whose
        // violin is the assignment rather than a place to put one. Those render no chips and no task
        // picker — a violin wearing its own name as a chip is what the human spotted.
        const comparison = payload.panelRoles.includes(violin.id);
        const body = [];
        const nameKey = `name:${violin.id}`;
        body.push(React.createElement('div', { key: 'name-row', style: STYLE.rows }, field(React, 'name', 'name', textInput(React, 'name', drafts[nameKey] ?? violin.name, (value) => setDraft(nameKey, value), () => {
            clearDraft(nameKey);
            renameViolin(file, violin, drafts[nameKey] ?? violin.name);
        }, { 'data-pviolin-name': violin.id }))));
        for (const [index, selection] of violin.selections.entries()) {
            body.push(React.createElement('div', { key: `selection-${String(index)}`, style: STYLE.rows }, field(React, 'provider', 'provider', picker(React, Tooltip, 'provider', selection.provider, providers(payload), (provider) => {
                const first = payload.catalog.routes.find((route) => route.provider === provider);
                if (first === undefined)
                    return;
                replaceSelection(file, violin, index, reselectRoute(selection, provider, first.model, first));
            }, { 'aria-label': pickerName('provider', violin) })), field(React, 'model', 'model', picker(React, Tooltip, 'model', selection.model, models(payload, selection.provider), (model) => {
                const route = payload.catalog.routes.find((candidate) => candidate.provider === selection.provider && candidate.model === model);
                replaceSelection(file, violin, index, reselectRoute(selection, selection.provider, model, route));
            }, { 'aria-label': pickerName('model', violin) })), field(React, 'effort', 'effort', picker(React, Tooltip, 'effort', selection.reasoningEffort ?? EFFORT_NOT_SET, efforts(payload, selection), (effort) => replaceSelection(file, violin, index, withEffort(selection, effort === EFFORT_NOT_SET ? undefined : effort)), { 'aria-label': pickerName('effort', violin) })), violin.selections.length > 1
                ? React.createElement('button', {
                    key: 'remove',
                    type: 'button',
                    'data-pviolin-remove-selection': `${violin.id}:${String(index)}`,
                    // The button's only content is `×`, so without this its accessible name is the
                    // character `×` — a name that says neither what it removes nor from where. Names
                    // follow the task chip's own unassign button (`take <task> out of <violin>`).
                    'aria-label': `remove model ${String(index + 1)} (${selection.provider}/${selection.model}) from ${violin.name}`,
                    onClick: () => removeSelection(file, violin, index),
                }, '×')
                : null));
        }
        // One selection is the plain-violin shape and needs no adder; several and none both do.
        if (violin.selections.length !== 1) {
            body.push(React.createElement('button', {
                key: 'add-selection',
                type: 'button',
                'data-pviolin-add-selection': violin.id,
                onClick: () => addSelection(file, violin, payload),
                style: { alignSelf: 'flex-start' },
            }, 'Add a model'));
        }
        if (!comparison) {
            // Tasks are a single-model violin's business. A comparison violin owns its task by bearing its
            // name, so it shows models only.
            body.push(React.createElement('div', {
                key: 'tasks',
                style: STYLE.chips,
                // The chips are a set of items, so the row says so (spec 7.2). `role="list"` on the
                // wrapper and `role="listitem"` on each chip, because `<li>` outside a list is invalid
                // HTML and the chips are `<span>`s to keep `STYLE.chips`'s flex row working.
                role: 'list',
                'aria-label': `tasks on ${violin.name}`,
            }, 
            // Decoration: the row's own name is the `aria-label` above, so the printed word must not
            // be announced a second time (spec 7.3).
            React.createElement('span', { key: 'label', 'aria-hidden': true, style: STYLE.aside }, 'tasks:'), violin.tasks.length === 0
                ? React.createElement('span', { key: 'none', style: STYLE.aside }, 'none yet')
                : null, ...violin.tasks.map((task) => 
            // Two elements, not three: the task key and the remove control, with the explanation on the
            // chip itself. A separate `?` spent the chip's width and squeezed the key out of the box —
            // the bug the first screenshot showed — and the chip is already the thing being explained.
            React.createElement('span', {
                key: `task-${task}`,
                'data-pviolin-task': task,
                // No `aria-label` here: this span is not interactive, and `aria-label` on a generic
                // element is ignored by some assistive tech (spec 3.4). Its visible text already
                // carries the task key, and the inner button carries the full sentence.
                role: 'listitem',
                style: STYLE.chip,
            }, hover(React, Tooltip, `task-help-${task}`, `${TASK_HELP[task] ?? 'a pstack task key'} — currently runs on ${violin.name}`, React.createElement('span', { 'data-pchip-label': task, style: STYLE.chipLabel }, task)), React.createElement('button', {
                key: 'unassign',
                type: 'button',
                'data-pviolin-unassign': task,
                'aria-label': `take ${task} out of ${violin.name}; it then runs on general`,
                onClick: () => put(withoutTask(file, task)),
                style: STYLE.chipButton,
            }, '×')))));
            body.push(
            // Every task this build knows is offered: one already in another violin is *moved* here, which
            // is the edit a person means when they pick it. The host enforces the one-violin rule; showing
            // only the free ones would hide the move.
            picker(React, Tooltip, 'assign', '', [
                { value: '', label: ASSIGN_TASK },
                ...payload.taskKeys.map((task) => ({
                    value: task,
                    label: violin.tasks.includes(task) ? `${task} (already here)` : task,
                })),
            ], (task) => {
                if (task !== '')
                    put(withTask(file, task, violin.id));
            }, 
            // The implicit label from `field()` is `…` and the first option is `assign a task…`, so
            // without this the control names neither the violin nor the act it performs.
            { 'data-pviolin-assign': violin.id, 'aria-label': `assign a task to ${violin.name}` }));
        }
        if (violin.origin === 'custom') {
            body.push(React.createElement('button', {
                key: 'delete',
                type: 'button',
                'data-pviolin-delete': violin.id,
                onClick: () => put(withoutViolin(file, violin.id)),
                style: { alignSelf: 'flex-start' },
            }, 'Delete group'));
        }
        return React.createElement('li', {
            key: violin.id,
            'data-pviolin': violin.id,
            'data-pviolin-origin': violin.origin,
            'data-pviolin-open': isOpen,
            style: isOpen ? { ...STYLE.card, ...STYLE.cardOpen } : STYLE.card,
        }, React.createElement('button', {
            key: 'header',
            type: 'button',
            'data-pviolin-header': violin.id,
            'aria-expanded': isOpen,
            // The region this header expands. It is rendered only while open, and an `aria-controls`
            // pointing at an absent id is the normal, permitted pattern for a disclosure — the id is
            // derived from the violin's own id here (`bodyId`), so the two cannot drift.
            'aria-controls': bodyId, // Functional update, so two headers toggled in one tick cannot clobber each other.
            onClick: () => setOpen((previous) => previous.includes(violin.id)
                ? previous.filter((id) => id !== violin.id)
                : [...previous, violin.id]),
            style: STYLE.cardHeader,
        }, 
        // Name over route, the plugin market's own header layout: two lines, always the same height,
        // with the route clipped to one line and shown in full on hover.
        React.createElement('span', { key: 'headText', style: STYLE.cardHeadText }, React.createElement('span', { key: 'name', style: STYLE.cardName }, violin.name), hover(React, Tooltip, `summary-${violin.id}`, violinSummary(violin), React.createElement('span', { key: 'summary', style: STYLE.cardSummary }, violinSummary(violin)))), React.createElement('span', { key: 'count', style: STYLE.badge }, comparison
            ? `${String(violin.selections.length)} model${violin.selections.length === 1 ? '' : 's'}`
            : violin.tasks.length === 1
                ? '1 task'
                : `${String(violin.tasks.length)} tasks`), React.createElement('span', {
            key: 'chevron',
            // Decoration. Its rotation *is* the visual state, and the state itself is already
            // carried by `aria-expanded` on this button — so announcing the `⌄` only adds a stray
            // glyph to the header's accessible name.
            'aria-hidden': true,
            style: isOpen ? { ...STYLE.chevron, transform: 'rotate(180deg)' } : STYLE.chevron,
        }, '⌄')), isOpen
            ? React.createElement('div', {
                key: 'body',
                // `aria-controls` on the header points here (2.4). The id must exist whenever the
                // header references it — a screen reader that follows the reference while the card is
                // collapsed would otherwise land nowhere.
                id: bodyId,
                style: STYLE.body,
            }, React.createElement('div', { key: 'bodyInner', style: STYLE.bodyRow }, ...body))
            : null);
    };
    const children = [];
    children.push(React.createElement('div', { key: 'title-row', style: STYLE.titleRow }, React.createElement('h2', { key: 'title', style: STYLE.title }, 'pstack fleet'), React.createElement('div', { key: 'toolbar', style: STYLE.toolbar }, hover(React, Tooltip, 'refresh', 'read the live route catalog again, so the pickers offer what this install can run right now', React.createElement('button', { type: 'button', 'data-pfleet-action': 'refresh', onClick: () => load(true) }, 'Refresh models')), hover(React, Tooltip, 'add-group', 'add a named group of model selections; tasks you assign to it run on those models', React.createElement('button', {
        type: 'button',
        'data-pfleet-action': 'add-group',
        onClick: () => setAdding((previous) => !previous),
    }, 'Add group')))));
    if (adding) {
        children.push(React.createElement('div', { key: 'add-row', style: STYLE.addRow }, React.createElement('input', {
            key: 'new-group',
            type: 'text',
            value: newName,
            spellCheck: false,
            placeholder: 'name the new group',
            // A placeholder is not an accessible name once the field has content; with none at all
            // this input announced as an unlabelled text box.
            'aria-label': 'name the new group',
            'data-pfleet-new-group': '1',
            onChange: (event) => setNewName(event.target.value),
            onKeyDown: (event) => {
                if (event.key === 'Enter' && view !== null && groups !== null)
                    addGroup(groups, view);
            },
            style: STYLE.input,
        }), React.createElement('button', {
            key: 'confirm',
            type: 'button',
            'data-pfleet-add-group': '1',
            onClick: () => {
                if (view !== null && groups !== null)
                    addGroup(groups, view);
            },
        }, 'Add')));
    }
    // The status line is the only place the page speaks about itself: a refusal, a repair, a rejected
    // file, a catalog problem, or the one preference this page reports and never writes.
    //
    // It is a **live region**, and that is why the container is mounted unconditionally while its text
    // is what appears and disappears. A region that is inserted into the document at the same moment
    // its text arrives is announced inconsistently — some screen readers miss it, because the node was
    // not there when they began watching the subtree — so a refused PUT would stay silent for exactly
    // the people who cannot see the sentence appear. Mounting it always costs an empty box with no
    // padding and no text, which paints nothing (verified by `scripts/check-page-layout.mjs`, which
    // measures the rendered box and not the element count).
    //
    // A refusal interrupts and a note does not: `role="alert"` implies `aria-live="assertive"`, and
    // `role="status"` implies `aria-live="polite"`. Both are stated explicitly as well as by role,
    // because the role→liveness mapping is the part of ARIA that implementations disagree about.
    const lines = [...(status === null ? [] : [status]), ...(view === null ? [] : statusNotes(view))];
    const refusal = status !== null;
    children.push(React.createElement('div', {
        key: 'status',
        'data-pfleet-status': '1',
        ...(refusal ? { 'data-pfleet-error': '1' } : {}),
        role: refusal ? 'alert' : 'status',
        'aria-live': refusal ? 'assertive' : 'polite',
        style: lines.length === 0 ? STYLE.silent : refusal ? STYLE.error : STYLE.note,
    }, lines.join('\n')));
    const file = groups;
    const payload = view;
    if (file !== null && payload !== null) {
        for (const band of ORIGIN_BANDS) {
            const violins = bandViolins(file, band.origin);
            if (violins.length === 0)
                continue;
            children.push(React.createElement('h3', { key: `heading-${band.origin}`, style: STYLE.bandHeading }, band.heading), React.createElement('ul', { key: `band-${band.origin}`, 'data-pfleet-band': band.origin, style: STYLE.band }, ...violins.map((violin) => card(violin, file, payload))));
        }
        // Derived here rather than read from `payload.unassigned`, because the local document is what
        // is on screen after a refused write: a task must never appear both as a chip and as an
        // unassigned row, and a task key must never be invisible. The rule is the payload's own.
        const assigned = new Set();
        for (const violin of file.violins)
            for (const task of violin.tasks)
                assigned.add(task);
        const unassigned = payload.taskKeys.filter((task) => !assigned.has(task));
        if (unassigned.length > 0) {
            children.push(React.createElement('h3', { key: 'heading-unassigned', style: STYLE.bandHeading }, 'Unassigned'), React.createElement('ul', { key: 'unassigned', 'data-pfleet-band': 'unassigned', style: STYLE.chips }, 
            // One chip per unassigned task, in the same shape and with the same hover as the chips
            // inside a violin: the explanation of what a task is should not depend on where the task
            // happens to sit. Each chip carries its own picker, so "put this one somewhere" is a
            // gesture on the thing being moved rather than on a row of controls beside it.
            ...unassigned.map((task) => React.createElement('li', { key: task, 'data-pfleet-unassigned': task, style: STYLE.unassignedChip }, hover(React, Tooltip, `unassigned-help-${task}`, `${TASK_HELP[task] ?? 'a pstack task key'} — unassigned, so it runs on general`, React.createElement('span', { 'data-pchip-label': task, style: STYLE.chipLabel }, task)), picker(React, Tooltip, 'to', ASSIGN_VIOLIN, [
                { value: ASSIGN_VIOLIN, label: '→' },
                ...displayOrder(file).map((violin) => ({
                    value: violin.id,
                    label: violin.name === violin.id ? violin.id : `${violin.name} (${violin.id})`,
                })),
            ], (id) => {
                if (id !== ASSIGN_VIOLIN)
                    put(withTask(file, task, id));
            }, { 'data-pfleet-assign': task, 'aria-label': `assign ${task} to a violin`, style: STYLE.chipPicker })))));
        }
    }
    return React.createElement('div', { 'data-pfleet-page': 'violins', style: STYLE.page }, ...children);
}
const loader = window.__ModuleLoader__;
if (loader === undefined) {
    throw new Error('dsh-pstack client: window.__ModuleLoader__ is missing; this bundle must be loaded by the DSH client module system');
}
loader.load({
    id: 'dsh-pstack',
    factory: (require) => {
        const React = require('react');
        // The shell seeds this module before any plugin bundle runs, so it is a require and never a
        // dependency of ours (see the file header). Absent — a shell that stopped seeding it — the page
        // renders without tooltips rather than failing to mount, which is what `hover` checks for.
        const primitives = (() => {
            try {
                return require('@deepseek-ai/dsh-client-ui-primitives');
            }
            catch {
                return {};
            }
        })();
        const Tooltip = primitives.Tooltip;
        /** The React element factory for one section render. */
        const render = () => PstackFleetPage(React, Tooltip);
        return {
            // `slots` alone is what this page needs: it registers one `settings.section` and renders
            // from `/api/pstack/fleet`, fetched over HTTP.
            //
            // It used to declare `settingsScope` too, inherited from the card-era shape, on the theory
            // that the Plugins tab would not dispatch a card without it. That service no longer exists
            // in the Harness (a whole-tree grep over `/usr/lib/node_modules/@deepseek-ai/dsh/` returns
            // nothing on 0.2.0-rc.2), so declaring it is not a harmless extra: Cordis holds the plugin
            // inactive waiting for a service nothing will ever provide, and the profile fails to boot
            // with "1 entry did not activate dsh-pstack: pending (waiting for service: settingsScope)".
            // The page body never referenced it — `fetch(FLEET_ROUTE, …)` is the only data path.
            inject: ['slots'],
            apply: (ctx) => {
                const slots = ctx.get('slots');
                if (slots === undefined)
                    return;
                slots.inject(SECTION.name, () => slots.register({ ...SECTION, label: () => 'pstack Fleet' }, render));
            },
        };
    },
});
