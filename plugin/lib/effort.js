/**
 * Per-role reasoning effort, applied on the `agent/request` waterfall.
 *
 * Mechanism: **confirmed by execution** on this machine, not by source reading — reproduced
 * across five headless runs by an independent verification pass, and reproduced by
 * `tests/effort.spec.ts` here. The load-bearing facts:
 *
 * - The waterfall is `'agent/request'(this: Scoped<Agent>, payload: { agent, turn, step, signal },
 *   next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>`
 *   (`dsh-agent/lib/types/runtime-types.d.ts:336-341`), dispatched from exactly one place,
 *   `prepareRequest()` (`dsh-agent-loop/lib/index.js:1143-1147`).
 * - The seed config is built *before* dispatch, from
 *   `this.options.reasoningEffort ?? persistedReasoningEffort`
 *   (`dsh-agent-loop/lib/index.js:1135-1142`). So writing to the agent's options inside a
 *   listener is too late; the only thing that works is **returning a replaced config**.
 * - An in-process child is driven by the same loop class and does reach this listener, because
 *   an **untagged** listener is global (`dsh-scope/README.md`, "Use this package").
 * - The replacement is durable: the loop logs the changed config as the child's
 *   `request/header` and builds the frozen request from it
 *   (`dsh-agent-loop/lib/index.js:1211-1217`).
 *
 * ## Why `await next()` comes first, and how much that is actually worth
 *
 * The override must be applied **outermost**: take what the waterfall produced, spread it, and
 * set `reasoningEffort` on the copy. Run 5 of the verifier's matrix confirms the ordering rule
 * itself — an outer `max` beat an inner `low` in the persisted header
 * (`cordis/lib/index.js:311`, "listeners run outermost-first").
 *
 * The original *reason* given for this rule was wrong and this file does not repeat it. On the
 * headless surface an inner, agent-scoped listener's change also survived, because
 * `installModelSelection` is installed **only on the primary agent's ctx**
 * (`dsh-headless/lib/index.js:141-146`) and the headless spawn provider installs none on the
 * child. **So outermost is defensive, not mandatory on headless.** The Web/API plane *does*
 * install a selection per agent (`dsh-api-session-controller/lib/index.js:306`) and was **not**
 * tested; that is the surface where an inner listener could lose. Write it outermost, and know
 * that on headless the safety margin is unexercised.
 *
 * ## Two independent channels, and why both exist
 *
 * `src/tools/spawn.ts` also passes `reasoningEffort` in `SubagentStartRequest.agentOptions`,
 * which the in-process provider merges over the parent's options at child creation
 * (`dsh-subagent/lib/index.js:468-484`). That channel is race-free: it is set before the child's
 * first request exists.
 *
 * This listener is the second channel. It is the only one that also applies to a child somebody
 * else created — a `subagent_fork`, or a child the model spawned through the stock tool — once
 * that child's id is known to {@link RoleAssignmentStore}. It is also what makes the effort
 * **auditable as an override** rather than as creation-time inheritance: the child's persisted
 * `request/header` records what this listener returned.
 *
 * ## Never send an effort the route does not advertise
 *
 * `resolveModelInfo(provider, model).reasoning.efforts` is the authority
 * (`dsh-llm/lib/index.js:2043-2049`; `LlmModelReasoningInfo.efforts`
 * `dsh-llm/lib/types/types.d.ts:304-312`). On this machine that is `["off","low","high","max"]`
 * with `defaultEffort: "high"`. An unadvertised id does not degrade quietly — the DeepSeek
 * adapter fails the request with `UNSUPPORTED_REASONING_EFFORT`
 * (`dsh-llm-deepseek/lib/index.js:26-29`) — so the guard below refuses rather than passes
 * through. `src/roles/catalog.ts` refuses at resolution time; this is the second gate, because
 * a listener that trusts its store can outlive the resolution that filled it.
 */
/** The waterfall event name. A constant so a test and the wiring cannot drift. */
export const EFFORT_WATERFALL_EVENT = 'agent/request';
/**
 * An in-memory child-id -> role/effort map.
 *
 * Deliberately not shared module state: `plugin/src/index.ts` creates exactly one and hands the
 * same instance to the spawn tool and the listener. Two instances would be a silent no-op.
 */
export function createRoleAssignments() {
    const entries = new Map();
    return {
        set: (childId, assignment) => void entries.set(childId, assignment),
        get: (childId) => entries.get(childId),
        delete: (childId) => void entries.delete(childId),
        size: () => entries.size,
    };
}
/**
 * Read an agent's delegation depth, treating absence as top-level zero — the same rule
 * `delegationDepthOf` applies (`dsh-subagent/lib/types/depth.d.ts`, doc comment). A depth that
 * is not a non-negative safe integer is treated as top-level rather than guessed at: applying a
 * role's effort to the parent's own request would silently re-route the human's session.
 *
 * @param agent - the payload's agent, if any.
 * @returns the depth as a non-negative integer, or `0`.
 */
export function readDelegationDepth(agent) {
    const depth = agent?.options?.subagentDepth;
    if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0)
        return 0;
    return depth;
}
/** Read a string property off an untrusted object without throwing. */
function readString(value, key) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const found = value[key];
    return typeof found === 'string' ? found : undefined;
}
/** True when the adapter advertises this effort on this exact route. */
function advertises(efforts, effort) {
    return efforts === undefined ? true : efforts.includes(effort);
}
/**
 * Build the `agent/request` listener that applies a child's role effort.
 *
 * The body is ordered on purpose and the order is asserted by `tests/effort.spec.ts`:
 *
 * 1. `await next()` — the chain composes the seed config, and only then is there a config to
 *    replace. A listener that writes to `payload.agent.options` first does nothing at all,
 *    because the seed was already built from those options before dispatch.
 * 2. Classify: only a child (`subagentDepth > 0`) is touched. The primary agent's request is
 *    returned untouched — never reassigned, never spread.
 * 3. Look the child up. A child this plugin did not spawn has no role, so it is returned as-is.
 * 4. Second gate: refuse an effort the route does not advertise.
 * 5. Return a **copy** with one field replaced, preserving every other field the chain set.
 *
 * @param options - assignment store, optional advertised-effort lookup, optional logger.
 * @returns a listener for `ctx.on('agent/request', …)`.
 */
export function createEffortListener(options) {
    const { assignments, advertisedEfforts, logger } = options;
    return async (payload, next) => {
        // Outermost. See the module comment: defensive rather than mandatory on headless.
        const config = await next();
        const agent = payload.agent;
        const depth = readDelegationDepth(agent);
        if (depth <= 0)
            return config;
        const childId = agent?.id;
        if (typeof childId !== 'string' || childId.length === 0)
            return config;
        const assignment = assignments.get(childId);
        if (assignment === undefined)
            return config;
        const efforts = await advertisedEfforts?.(config, payload.signal);
        if (!advertises(efforts, assignment.effort)) {
            logger?.warn?.(`pstack: role "${assignment.role}" asks for reasoning effort "${assignment.effort}", which route ` +
                `${readString(config, 'provider') ?? '?'}/${readString(config, 'model') ?? '?'} does not advertise ` +
                `(${(efforts ?? []).join(', ')}); leaving this child's effort unchanged`);
            return config;
        }
        if (readString(config, 'reasoningEffort') === assignment.effort)
            return config;
        logger?.info?.(`pstack: child ${childId} runs role "${assignment.role}" at reasoning effort "${assignment.effort}"`);
        return { ...config, reasoningEffort: assignment.effort };
    };
}
