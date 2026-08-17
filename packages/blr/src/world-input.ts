export type ResolvedWorldInput = {
    readonly kind: "authored" | "processed";
    readonly worldName: string;
    /** Absolute directory containing a complete Bedrock world. */
    readonly directory: string;
    /** Stable lineage identity recorded when this input seeds a runtime. */
    readonly seedIdentity: string;
};
