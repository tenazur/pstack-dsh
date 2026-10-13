/** Model-facing tool name. */
export declare const PSTACK_STATUS_TOOL = "pstack_status";
/** One text block, the only content shape this tool returns. */
interface TextContentBlock {
    readonly type: 'text';
    readonly text: string;
}
/** The slice of `ToolRunContext` this tool reads. */
export interface ToolRunContext {
    readonly signal?: AbortSignal | undefined;
}
/** The canonical value `execute` returns; `output.schema` describes exactly this shape. */
interface PstackStatus {
    readonly plugin: string;
    readonly bootMarker: string;
    readonly overlayPath: string;
    readonly overlayPresent: boolean;
    readonly overlayRoles: readonly string[];
    readonly groupsPath: string;
    readonly groupsViolins: readonly string[];
    readonly skillsDirectory: string;
    readonly skillNames: readonly string[];
    readonly notes: readonly string[];
}
/** Structural stand-in for `ToolDefinition` (`dsh-tools/lib/types/index.d.ts:106`). */
export interface ToolDefinitionLike {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly output: {
        readonly schema: Readonly<Record<string, unknown>>;
        render(args: unknown, value: unknown): TextContentBlock[];
    };
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}
interface PstackStatusToolOptions {
    /** Boot marker literal, owned by the plugin entry so the two cannot drift. */
    readonly bootMarker: string;
    /** Overlay file the plugin resolves at boot (`defaultOverlayPath()`). */
    readonly overlayPath: string;
    /**
     * Fleet groups file the plugin resolves at boot (`defaultGroupsPath()`), the file the violin page
     * edits. Optional so a caller that reports on the overlay alone can configure none: the report then
     * carries an empty path, claims no file is present, and raises no note about one nobody named.
     */
    readonly groupsPath?: string | undefined;
    /** Directory scanned for bundled skills. */
    readonly skillsDir: string;
    /** Plugin name reported in the value. */
    readonly pluginName: string;
}
/**
 * Build the report value. Pure reads; safe to call from a Host session.
 * @param options - paths and the boot marker to report.
 * @param exec - tool run context, used only to honour cancellation.
 * @returns the status value declared by {@link STATUS_VALUE_SCHEMA}.
 */
export declare function describePstackStatus(options: PstackStatusToolOptions, exec?: ToolRunContext): Promise<PstackStatus>;
/**
 * Create the registry-ready tool definition.
 * @param options - paths and the boot marker to report.
 * @returns a definition for `ctx.tools.register`, validated by the registry at registration.
 */
export declare function createPstackStatusTool(options: PstackStatusToolOptions): ToolDefinitionLike;
export {};
