/** Model-facing tool name. Snake_case, like `pstack_status` and DSH's own `run_code`. */
export const PSTACK_SPAWN_TOOL = 'pstack_spawn';
/**
 * Subagent provider name this tool starts children on.
 * `dsh-subagent-spawn-in-process` registers under `providerName` defaulting to `"spawn"`
 * (`dsh-subagent-spawn-in-process/lib/index.js:14`), and it advertises
 * `capabilities.agentOptions: true` (`:24-30`) — which is what makes this tool possible.
 */
export const SPAWN_PROVIDER_NAME = 'spawn';
/** Invalid model-generated arguments. Mirrors DSH's `ToolArgsError` (`dsh-tools/lib/index.js:828`). */
export class SpawnArgsError extends Error {
    violations;
    constructor(violations) {
        super(`invalid arguments: ${violations.join('; ')}`);
        this.name = 'SpawnArgsError';
        this.violations = violations;
    }
}
/**
 * The four model-facing parameters, as raw JSON Schema.
 *
 * `defineTool` compiles a per-property spec into exactly this shape
 * (`parameterSchemaSpecToJsonSchema`, `dsh-tools/lib/index.js:802`), and this package cannot
 * import `defineTool` (no DSH dependency), so the raw schema is written out. Because the
 * registry does **not** validate `parameters` the way it validates `output.schema`
 * (`dsh-tools/lib/index.js:2773`), the same contract is re-implemented in
 * {@link parseSpawnArgs} — re-implemented, not skipped:
 * `defineTool` wraps `execute` in `validateJsonSchemaValue` (`:846`-`:860`) and a raw
 * definition gets no such wrapper.
 */
export const PSTACK_SPAWN_PARAMETERS = {
    type: 'object',
    additionalProperties: false,
    properties: {
        role: {
            type: 'string',
            description: 'The pstack role to run this child as: a role key from the overlay (for example "architect"), ' +
                'or one of the spawn role values. Resolved against the live route catalog; a role with no ' +
                'usable mapping inherits the parent.',
        },
        prompt: {
            type: 'string',
            description: 'The complete, self-contained task for the child. It does not see this conversation.',
        },
        description: {
            type: 'string',
            description: 'A short (3-5 word) label for the child, shown in the transcript. Defaults to the role key.',
        },
        route_index: {
            type: 'integer',
            description: "For a panel role (one with a list of routes), which entry of that list to use. Omit for the " +
                "role's first entry. Ignored by a scalar role.",
        },
    },
    required: ['role', 'prompt'],
};
/**
 * The canonical value's schema, in the enforced subset.
 *
 * Every object declares `additionalProperties`, as `checkSchemaNode` requires for explicit
 * object nodes (`dsh-tools/lib/index.js:196-205`), and `required` names only declared
 * properties (`checkObjectSchemaTail` `:151-162`).
 */
export const SPAWN_VALUE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        role: { type: 'string', description: 'The role key this child was resolved for.' },
        inherited: { type: 'boolean', description: "True when the child inherited the parent's route." },
        reason: { type: 'string', description: 'The resolver\'s reason, verbatim (may start with "unavailable:").' },
        routeProvider: { type: 'string', description: "Provider sent to agentOptions; '' when inherited." },
        routeModel: { type: 'string', description: "Model sent to agentOptions; '' when inherited." },
        routeEffort: { type: 'string', description: "Reasoning effort sent to agentOptions; '' when none." },
        routeIndex: { type: 'integer', description: "The resolver's routeIndex, or -1." },
        requestedRouteIndex: { type: 'integer', description: 'The route_index argument, or -1.' },
        subagentProvider: { type: 'string', description: 'Provider name this tool started the child on.' },
        childId: { type: 'string', description: "The published child's id, or ''." },
        stopReason: { type: 'string', description: "The child's stop reason, or '' when it produced no result." },
        output: { type: 'string', description: "The child's final assistant text, joined." },
        diagnostic: { type: 'string', description: "Provider failure detail, or ''." },
    },
    required: [
        'role',
        'inherited',
        'reason',
        'routeProvider',
        'routeModel',
        'routeEffort',
        'routeIndex',
        'requestedRouteIndex',
        'subagentProvider',
        'childId',
        'stopReason',
        'output',
        'diagnostic',
    ],
};
/** True for a non-empty string. */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
/** True for a value JSON Schema calls an integer: a safe integer, not a float. */
function isInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value);
}
/**
 * Validate model-generated arguments against {@link PSTACK_SPAWN_PARAMETERS}.
 *
 * The four rules are the schema's: `role` and `prompt` are required non-empty strings,
 * `description` is an optional string, `route_index` is an optional non-negative integer, and
 * no other key is accepted (`additionalProperties: false`). Violations are path-qualified, the
 * way `validateJsonSchemaValue` reports them, so the model can act on the message.
 *
 * @param raw - arguments, however malformed.
 * @returns the validated arguments.
 * @throws SpawnArgsError naming every violation.
 */
export function parseSpawnArgs(raw) {
    const violations = [];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new SpawnArgsError(['arguments must be an object']);
    }
    const record = raw;
    const declared = new Set(['role', 'prompt', 'description', 'route_index']);
    for (const key of Object.keys(record)) {
        if (!declared.has(key))
            violations.push(`arguments.${key} is not a declared parameter`);
    }
    const role = record['role'];
    if (!isNonEmptyString(role))
        violations.push('arguments.role must be a non-empty string');
    const prompt = record['prompt'];
    if (!isNonEmptyString(prompt))
        violations.push('arguments.prompt must be a non-empty string');
    const description = record['description'];
    if (description !== undefined && typeof description !== 'string') {
        violations.push('arguments.description must be a string');
    }
    const routeIndex = record['route_index'];
    if (routeIndex !== undefined && (!isInteger(routeIndex) || routeIndex < 0)) {
        violations.push('arguments.route_index must be a non-negative integer');
    }
    if (violations.length > 0)
        throw new SpawnArgsError(violations);
    return {
        role: role,
        prompt: prompt,
        ...(typeof description === 'string' ? { description } : {}),
        ...(isInteger(routeIndex) ? { routeIndex } : {}),
    };
}
/**
 * Build the role-derived part of a `SubagentStartRequest`. Pure: no clock, no I/O, no Host.
 *
 * The whole mapping decision is here, which is what makes ACCEPTANCE 2 testable and what makes
 * "remove the mapping" a one-line edit that the test then fails on.
 *
 * @param resolved - the resolver's answer for the requested role.
 * @param args - validated tool arguments.
 * @returns `{ label, prompt }` plus `agentOptions` **only** when the role maps to a route.
 */
export function buildSpawnRequest(resolved, args) {
    const label = isNonEmptyString(args.description) ? args.description : resolved.role;
    const prompt = [{ type: 'text', text: args.prompt }];
    const route = resolved.inherit ? undefined : resolved.route;
    if (route === undefined)
        return { label, prompt };
    const agentOptions = { provider: route.provider, model: route.model };
    if (isNonEmptyString(route.reasoningEffort))
        agentOptions['reasoningEffort'] = route.reasoningEffort;
    return { label, prompt, agentOptions };
}
/** Turn the canonical outcome of a resolution into the flat canonical value. */
function outcomeFor(resolved, args, providerName) {
    const route = resolved.inherit ? undefined : resolved.route;
    return {
        role: resolved.role,
        inherited: resolved.inherit,
        reason: resolved.reason,
        routeProvider: route?.provider ?? '',
        routeModel: route?.model ?? '',
        routeEffort: route?.reasoningEffort ?? '',
        routeIndex: resolved.routeIndex ?? -1,
        requestedRouteIndex: args.routeIndex ?? -1,
        subagentProvider: providerName,
    };
}
/** Read a property off an unknown value without throwing on a hostile object. */
function readProperty(value, key) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    try {
        return value[key];
    }
    catch {
        return undefined;
    }
}
/** Flatten a child's content-block output to text. Never throws on odd shapes. */
function flattenOutput(value) {
    if (typeof value === 'string')
        return value;
    if (!Array.isArray(value))
        return '';
    const parts = [];
    for (const block of value) {
        const text = readProperty(block, 'text');
        if (typeof text === 'string')
            parts.push(text);
    }
    return parts.join('\n');
}
/**
 * Add the two fields a `SubagentStartRequest` needs from the run context and call the service.
 *
 * Kept separate from {@link buildSpawnRequest} so the mapping logic stays pure: this is the
 * only function here that touches the real service.
 */
async function startChild(subagents, providerName, parts, exec) {
    if (exec.agent === undefined) {
        throw new Error(`${PSTACK_SPAWN_TOOL}: no calling agent (exec.agent was undefined), so there is no parent to delegate from`);
    }
    const request = { ...parts, parent: exec.agent, signal: exec.signal };
    return await subagents.start(providerName, request);
}
/** Await a run's result and dispose it, reporting whatever the provider actually gave us. */
async function settleRun(run) {
    const childId = isNonEmptyString(readProperty(run, 'id')) ? readProperty(run, 'id') : '';
    const resultPromise = readProperty(run, 'result');
    let result;
    try {
        result = resultPromise instanceof Promise ? await resultPromise : resultPromise;
    }
    catch (error) {
        return { childId, stopReason: 'error', output: '', diagnostic: `child run rejected: ${String(error)}` };
    }
    finally {
        const dispose = readProperty(run, 'dispose');
        if (typeof dispose === 'function') {
            try {
                await dispose.call(run);
            }
            catch {
                // Disposal is best-effort here: the child has already settled and the caller's
                // result is what matters. A failed dispose must not erase an otherwise usable run.
            }
        }
    }
    return {
        childId,
        stopReason: isNonEmptyString(readProperty(result, 'stopReason')) ? readProperty(result, 'stopReason') : '',
        output: flattenOutput(readProperty(result, 'output')),
        diagnostic: isNonEmptyString(readProperty(result, 'diagnostic')) ? readProperty(result, 'diagnostic') : '',
    };
}
/**
 * Create the registry-ready `pstack_spawn` definition.
 *
 * `execute` is a thin wrapper: validate, resolve, build the request, start the child, report.
 * All the mapping logic lives in {@link buildSpawnRequest}, which is why this file can be
 * tested end to end with a fake service and no Host.
 *
 * @param options - resolver, subagent service, provider name, optional assignment sink.
 * @returns a definition for `ctx.tools.register`, validated by the registry at registration.
 */
export function createPstackSpawnTool(options) {
    const providerName = options.providerName ?? SPAWN_PROVIDER_NAME;
    return {
        name: PSTACK_SPAWN_TOOL,
        description: 'Delegate one task to a child agent running as a pstack role. The role is resolved against the ' +
            "live route catalog: a mapped role runs the child on that role's provider, model and reasoning " +
            'effort, while a role with no usable mapping inherits the parent\'s route. Prefer this over the ' +
            'stock subagent tool whenever the task has a pstack role, so the route is auditable from the ' +
            'transcript. The child does not see this conversation; the prompt must be self-contained.',
        parameters: PSTACK_SPAWN_PARAMETERS,
        output: {
            schema: SPAWN_VALUE_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async (rawArgs, exec) => {
            const args = parseSpawnArgs(rawArgs);
            const runContext = exec;
            exec.signal?.throwIfAborted();
            const resolved = await options.resolver.resolve(args.role, args.routeIndex);
            const parts = buildSpawnRequest(resolved, args);
            const outcome = outcomeFor(resolved, args, providerName);
            exec.signal?.throwIfAborted();
            const run = await startChild(options.subagents, providerName, parts, runContext);
            const settled = await settleRun(run);
            // Record the child's role/effort for the `agent/request` listener. Best-effort by
            // design: the effort also rides in `agentOptions` (the race-free channel), so a child
            // whose first request beats this line is still correct.
            if (options.assignments !== undefined && settled.childId.length > 0 && outcome.routeEffort.length > 0) {
                options.assignments.set(settled.childId, { role: resolved.role, effort: outcome.routeEffort });
            }
            return { ...outcome, ...settled };
        },
    };
}
