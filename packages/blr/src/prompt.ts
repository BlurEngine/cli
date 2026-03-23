import prompts, { type PromptObject, type PromptType } from "prompts";

const PROMPT_CANCELLED = "BLR_PROMPT_CANCELLED";

export class PromptCancelledError extends Error {
    constructor() {
        super(PROMPT_CANCELLED);
        this.name = "PromptCancelledError";
    }
}

export function isPromptCancelledError(
    error: unknown,
): error is PromptCancelledError {
    return (
        error instanceof PromptCancelledError ||
        (error instanceof Error && error.name === "PromptCancelledError")
    );
}

export async function runPrompt<T extends string>(
    questions: PromptObject<T> | Array<PromptObject<T>>,
): Promise<Record<T, PromptType>> {
    return prompts(questions as any, {
        onCancel: () => {
            throw new PromptCancelledError();
        },
    }) as Promise<Record<T, PromptType>>;
}
