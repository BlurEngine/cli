import prompts, { type PromptObject, type PromptType } from "prompts";

const PROMPT_ABORTED = "BLR_PROMPT_ABORTED";
const PROMPT_EXITED = "BLR_PROMPT_EXITED";

type PromptExitKind = "aborted" | "exited";
type PromptLifecycleState = {
    aborted?: boolean;
    exited?: boolean;
};

export class PromptCancelledError extends Error {
    readonly kind: PromptExitKind;

    constructor(kind: PromptExitKind) {
        super(kind === "aborted" ? PROMPT_ABORTED : PROMPT_EXITED);
        this.name = "PromptCancelledError";
        this.kind = kind;
    }
}

export class PromptAbortedError extends PromptCancelledError {
    constructor() {
        super("aborted");
        this.name = "PromptAbortedError";
    }
}

export class PromptExitedError extends PromptCancelledError {
    constructor() {
        super("exited");
        this.name = "PromptExitedError";
    }
}

export function isPromptCancelledError(
    error: unknown,
): error is PromptCancelledError {
    return (
        error instanceof PromptCancelledError ||
        (error instanceof Error &&
            (error.name === "PromptCancelledError" ||
                error.name === "PromptAbortedError" ||
                error.name === "PromptExitedError" ||
                error.message === PROMPT_ABORTED ||
                error.message === PROMPT_EXITED))
    );
}

export function isPromptAbortedError(
    error: unknown,
): error is PromptCancelledError {
    return (
        error instanceof PromptAbortedError ||
        (error instanceof PromptCancelledError && error.kind === "aborted") ||
        (error instanceof Error &&
            (error.name === "PromptAbortedError" ||
                error.message === PROMPT_ABORTED))
    );
}

export function isPromptExitedError(
    error: unknown,
): error is PromptCancelledError {
    return (
        error instanceof PromptExitedError ||
        (error instanceof PromptCancelledError && error.kind === "exited") ||
        (error instanceof Error &&
            (error.name === "PromptExitedError" ||
                error.message === PROMPT_EXITED))
    );
}

function decoratePromptQuestion<T extends string>(
    question: PromptObject<T>,
    states: WeakMap<object, PromptLifecycleState>,
): PromptObject<T> {
    const originalOnState = (question as any).onState;
    const wrapped = {
        ...question,
        onState: (state: PromptLifecycleState) => {
            states.set(wrapped as object, state);
            if (typeof originalOnState === "function") {
                return originalOnState(state);
            }
            return undefined;
        },
    } satisfies PromptObject<T>;

    return wrapped;
}

export async function runPrompt<T extends string>(
    questions: PromptObject<T> | Array<PromptObject<T>>,
): Promise<Record<T, PromptType>> {
    const states = new WeakMap<object, PromptLifecycleState>();
    const decoratedQuestions = Array.isArray(questions)
        ? questions.map((question) => decoratePromptQuestion(question, states))
        : decoratePromptQuestion(questions, states);
    let promptExitKind: PromptExitKind | undefined;

    const answers = await prompts(decoratedQuestions as any, {
        onSubmit: (question) => {
            const state =
                question && typeof question === "object"
                    ? states.get(question as object)
                    : undefined;
            if (state?.exited) {
                promptExitKind = "exited";
                return true;
            }
            return false;
        },
        onCancel: (question) => {
            const state =
                question && typeof question === "object"
                    ? states.get(question as object)
                    : undefined;
            promptExitKind = state?.exited ? "exited" : "aborted";
            return true;
        },
    });

    if (promptExitKind === "exited") {
        throw new PromptExitedError();
    }

    if (promptExitKind === "aborted") {
        throw new PromptAbortedError();
    }

    return answers as Record<T, PromptType>;
}
