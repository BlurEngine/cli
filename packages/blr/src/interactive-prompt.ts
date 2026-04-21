import kleur from "kleur";
import { beep, cursor, erase } from "sisteransi";
import { PromptAbortedError, PromptExitedError } from "./prompt.js";

type PromptReadStream = NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (value: boolean) => void;
};

type PromptWriteStream = NodeJS.WriteStream & {
    columns?: number;
};

type PromptKeypress = {
    ctrl?: boolean;
    meta?: boolean;
    name?: string;
    shift?: boolean;
};

export type InteractiveAutocompleteChoice<TValue = unknown> = {
    title: string;
    value: TValue;
    description?: string;
    searchText?: string;
};

export type InteractiveAutocompleteQuestion<
    TName extends string = string,
    TValue = unknown,
> = {
    type: "autocomplete";
    name: TName;
    message: string;
    choices: InteractiveAutocompleteChoice<TValue>[];
    suggest?: (
        input: string,
        choices: InteractiveAutocompleteChoice<TValue>[],
    ) => Promise<InteractiveAutocompleteChoice<TValue>[]>;
    limit?: number;
    initial?: number | string;
    clearFirst?: boolean;
    noMatches?: string;
};

export type InteractiveTextQuestion<TName extends string = string> = {
    type: "text";
    name: TName;
    message: string;
    initial?: string;
    validate?: (value: string) => boolean | string | Promise<boolean | string>;
    error?: string;
};

export type InteractiveToggleQuestion<TName extends string = string> = {
    type: "toggle";
    name: TName;
    message: string;
    initial?: boolean;
    active?: string;
    inactive?: string;
};

export type InteractiveConfirmQuestion<TName extends string = string> = {
    type: "confirm";
    name: TName;
    message: string;
    initial?: boolean;
    yes?: string;
    no?: string;
    yesOption?: string;
    noOption?: string;
};

export type InteractivePromptQuestion<
    TName extends string = string,
    TValue = unknown,
> =
    | InteractiveAutocompleteQuestion<TName, TValue>
    | InteractiveTextQuestion<TName>
    | InteractiveToggleQuestion<TName>
    | InteractiveConfirmQuestion<TName>;

type PromptFrame = {
    hideCursor: boolean;
    visibleOutput: string;
    writtenOutput: string;
};

type ActivePromptState = {
    settle: (result: PromptSettlement) => void;
    handleKeypress: (input: string, key: PromptKeypress) => void;
};

type ParsedPromptInput =
    | {
          kind: "event";
          bytesConsumed: number;
          input: string;
          key: PromptKeypress;
      }
    | {
          kind: "pending";
          standaloneEscape?: boolean;
      };

type PromptSettlement =
    | {
          kind: "resolve";
          value: Record<string, unknown>;
          frame: PromptFrame;
      }
    | {
          kind: "reject";
          error: unknown;
          frame: PromptFrame;
      };

type SessionPromptResult = Promise<Record<string, unknown>>;

export type CreateInteractivePromptOptions = {
    stdin?: PromptReadStream;
    stdout?: PromptWriteStream;
};

export type InteractivePrompt = {
    <TQuestion extends InteractivePromptQuestion<any, any>>(
        questions: TQuestion,
    ): Promise<Record<TQuestion["name"], unknown>>;
    close?: () => void;
};

const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const EMPTY_BUFFER = Buffer.alloc(0);
const ESCAPE_SEQUENCE_TIMEOUT_MS = 10;
const FIGURES =
    process.platform === "win32"
        ? {
              arrowUp: "↑",
              arrowDown: "↓",
              tick: "√",
              cross: "×",
              ellipsis: "...",
              pointerSmall: "»",
              pointer: ">",
          }
        : {
              arrowUp: "↑",
              arrowDown: "↓",
              tick: "✔",
              cross: "✖",
              ellipsis: "…",
              pointerSmall: "›",
              pointer: "❯",
          };

function stripAnsi(value: string): string {
    return value.replace(ANSI_PATTERN, "");
}

function countOutputLines(value: string, columns: number): number {
    const lines = String(stripAnsi(value) || "").split(/\r?\n/);
    return lines
        .map((line) =>
            Math.max(1, Math.ceil(line.length / Math.max(columns, 1))),
        )
        .reduce((total, count) => total + count, 0);
}

function clearOutput(value: string, columns: number): string {
    if (!value) {
        return erase.line + cursor.to(0);
    }

    const rows = countOutputLines(value, columns);
    return erase.lines(rows);
}

function wrapText(
    value: string,
    input: {
        margin: number;
        width: number;
    },
): string {
    const margin = " ".repeat(Math.max(0, input.margin));
    return (value || "")
        .split(/\r?\n/g)
        .map((line) =>
            line
                .split(/\s+/g)
                .reduce(
                    (parts, word) => {
                        if (
                            word.length + margin.length >= input.width ||
                            parts[parts.length - 1].length + word.length + 1 <
                                input.width
                        ) {
                            parts[parts.length - 1] += ` ${word}`;
                        } else {
                            parts.push(`${margin}${word}`);
                        }
                        return parts;
                    },
                    [margin],
                )
                .join("\n"),
        )
        .join("\n");
}

export async function filterInteractiveChoices<
    T extends {
        title: string;
        searchText?: string;
    },
>(input: string, choices: readonly T[]): Promise<T[]> {
    const query = input.trim().toLowerCase();
    if (!query) {
        return [...choices];
    }

    return choices.filter((choice) => {
        return (
            choice.title.toLowerCase().includes(query) ||
            choice.searchText?.toLowerCase().includes(query) === true
        );
    });
}

function entriesToDisplay(
    selectedIndex: number,
    totalChoices: number,
    maxVisible: number,
): {
    startIndex: number;
    endIndex: number;
} {
    const visibleCount = maxVisible || totalChoices;
    let startIndex = Math.min(
        totalChoices - visibleCount,
        selectedIndex - Math.floor(visibleCount / 2),
    );
    if (startIndex < 0) {
        startIndex = 0;
    }

    return {
        startIndex,
        endIndex: Math.min(startIndex + visibleCount, totalChoices),
    };
}

function styleSymbol(input: {
    done?: boolean;
    aborted?: boolean;
    exited?: boolean;
}): string {
    if (input.aborted) {
        return kleur.red(FIGURES.cross);
    }
    if (input.exited) {
        return kleur.yellow(FIGURES.cross);
    }
    if (input.done) {
        return kleur.green(FIGURES.tick);
    }
    return kleur.cyan("?");
}

function styleDelimiter(completing = false): string {
    return kleur.gray(completing ? FIGURES.ellipsis : FIGURES.pointerSmall);
}

function isInteractivePromptQuestion(
    value: unknown,
): value is InteractivePromptQuestion<any, any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const type = (value as { type?: unknown }).type;
    return (
        type === "autocomplete" ||
        type === "text" ||
        type === "toggle" ||
        type === "confirm"
    );
}

function normalizeInputChunk(chunk: Buffer | string): Buffer {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    return Buffer.from(chunk, "binary");
}

function utf8CharLength(firstByte: number): number {
    if ((firstByte & 0b1000_0000) === 0) {
        return 1;
    }
    if ((firstByte & 0b1110_0000) === 0b1100_0000) {
        return 2;
    }
    if ((firstByte & 0b1111_0000) === 0b1110_0000) {
        return 3;
    }
    if ((firstByte & 0b1111_1000) === 0b1111_0000) {
        return 4;
    }
    return 1;
}

function promptSpecialKey(
    name: string,
    bytesConsumed: number,
): ParsedPromptInput {
    return {
        kind: "event",
        bytesConsumed,
        input: "",
        key: { name },
    };
}

function parseCsiSequence(buffer: Buffer): ParsedPromptInput {
    if (buffer.length < 3) {
        return {
            kind: "pending",
        };
    }

    for (let index = 2; index < buffer.length; index += 1) {
        const byte = buffer[index];
        if (byte < 0x40 || byte > 0x7e) {
            continue;
        }

        const finalByte = String.fromCharCode(byte);
        const sequence = buffer.subarray(2, index + 1).toString("ascii");
        switch (finalByte) {
            case "A":
                return promptSpecialKey("up", index + 1);
            case "B":
                return promptSpecialKey("down", index + 1);
            case "C":
                return promptSpecialKey("right", index + 1);
            case "D":
                return promptSpecialKey("left", index + 1);
            case "F":
                return promptSpecialKey("end", index + 1);
            case "H":
                return promptSpecialKey("home", index + 1);
            case "Z":
                return promptSpecialKey("tab", index + 1);
            case "~":
                switch (sequence) {
                    case "1~":
                    case "7~":
                        return promptSpecialKey("home", index + 1);
                    case "3~":
                        return promptSpecialKey("delete", index + 1);
                    case "4~":
                    case "8~":
                        return promptSpecialKey("end", index + 1);
                    case "5~":
                        return promptSpecialKey("pageup", index + 1);
                    case "6~":
                        return promptSpecialKey("pagedown", index + 1);
                    default:
                        return {
                            kind: "event",
                            bytesConsumed: index + 1,
                            input: "",
                            key: {},
                        };
                }
            default:
                return {
                    kind: "event",
                    bytesConsumed: index + 1,
                    input: "",
                    key: {},
                };
        }
    }

    return {
        kind: "pending",
    };
}

function parseEscapeSequence(buffer: Buffer): ParsedPromptInput {
    if (buffer.length === 1) {
        return {
            kind: "pending",
            standaloneEscape: true,
        };
    }

    const secondByte = buffer[1];
    if (secondByte === 0x5b) {
        return parseCsiSequence(buffer);
    }

    if (secondByte === 0x4f) {
        if (buffer.length < 3) {
            return {
                kind: "pending",
            };
        }

        switch (String.fromCharCode(buffer[2])) {
            case "A":
                return promptSpecialKey("up", 3);
            case "B":
                return promptSpecialKey("down", 3);
            case "C":
                return promptSpecialKey("right", 3);
            case "D":
                return promptSpecialKey("left", 3);
            case "F":
                return promptSpecialKey("end", 3);
            case "H":
                return promptSpecialKey("home", 3);
            default:
                return {
                    kind: "event",
                    bytesConsumed: 3,
                    input: "",
                    key: {},
                };
        }
    }

    const charLength = utf8CharLength(secondByte);
    if (buffer.length < 1 + charLength) {
        return {
            kind: "pending",
        };
    }

    const input = buffer.subarray(1, 1 + charLength).toString("utf8");
    return {
        kind: "event",
        bytesConsumed: 1 + charLength,
        input,
        key: {
            meta: true,
        },
    };
}

function parsePromptInput(buffer: Buffer): ParsedPromptInput {
    if (buffer.length === 0) {
        return {
            kind: "pending",
        };
    }

    const firstByte = buffer[0];
    switch (firstByte) {
        case 0x03:
            return {
                kind: "event",
                bytesConsumed: 1,
                input: "",
                key: {
                    ctrl: true,
                    name: "c",
                },
            };
        case 0x08:
        case 0x7f:
            return promptSpecialKey("backspace", 1);
        case 0x09:
            return promptSpecialKey("tab", 1);
        case 0x0d:
            if (buffer.length >= 2 && buffer[1] === 0x0a) {
                return {
                    kind: "event",
                    bytesConsumed: 2,
                    input: "\r",
                    key: { name: "return" },
                };
            }
            return {
                kind: "event",
                bytesConsumed: 1,
                input: "\r",
                key: { name: "return" },
            };
        case 0x0a:
            return {
                kind: "event",
                bytesConsumed: 1,
                input: "\n",
                key: { name: "enter" },
            };
        case 0x1b:
            return parseEscapeSequence(buffer);
    }

    if (firstByte < 0x20) {
        return {
            kind: "event",
            bytesConsumed: 1,
            input: "",
            key: {},
        };
    }

    const charLength = utf8CharLength(firstByte);
    if (buffer.length < charLength) {
        return {
            kind: "pending",
        };
    }

    return {
        kind: "event",
        bytesConsumed: charLength,
        input: buffer.subarray(0, charLength).toString("utf8"),
        key: {},
    };
}

class InteractivePromptSession {
    private readonly input: PromptReadStream;

    private readonly output: PromptWriteStream;

    private started = false;

    private closed = false;

    private activePrompt: ActivePromptState | undefined;

    private renderedOutput = "";

    private cursorHidden = false;

    private restoreRawMode = false;

    private pendingInput = EMPTY_BUFFER;

    private pendingEscapeTimer: NodeJS.Timeout | undefined;

    constructor(options: CreateInteractivePromptOptions = {}) {
        this.input = options.stdin ?? (process.stdin as PromptReadStream);
        this.output = options.stdout ?? (process.stdout as PromptWriteStream);
    }

    close(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.activePrompt = undefined;
        this.clearRenderedOutput();

        if (this.cursorHidden) {
            this.output.write(cursor.show);
            this.cursorHidden = false;
        }

        this.cancelPendingEscape();
        this.pendingInput = EMPTY_BUFFER;
        this.input.removeListener("data", this.handleData);
        if (this.input.isTTY && this.restoreRawMode) {
            this.input.setRawMode?.(false);
        }
        this.input.pause?.();
    }

    async prompt(questions: unknown): SessionPromptResult {
        if (!isInteractivePromptQuestion(questions)) {
            throw new Error(
                "Interactive prompt received an unsupported prompt question.",
            );
        }

        this.ensureStarted();

        switch (questions.type) {
            case "autocomplete":
                return this.runAutocompletePrompt(questions);
            case "text":
                return this.runTextPrompt(questions);
            case "toggle":
                return this.runTogglePrompt(questions);
            case "confirm":
                return this.runConfirmPrompt(questions);
        }
    }

    private ensureStarted(): void {
        if (this.started) {
            return;
        }

        this.input.resume?.();
        this.input.on("data", this.handleData);

        if (this.input.isTTY && !this.input.isRaw) {
            this.input.setRawMode?.(true);
            this.restoreRawMode = true;
        }

        this.started = true;
    }

    private readonly handleData = (chunk: Buffer | string): void => {
        this.cancelPendingEscape();

        const nextChunk = normalizeInputChunk(chunk);
        let buffer =
            this.pendingInput.length > 0
                ? Buffer.concat([this.pendingInput, nextChunk])
                : nextChunk;
        this.pendingInput = EMPTY_BUFFER;

        while (buffer.length > 0) {
            const parsed = parsePromptInput(buffer);
            if (parsed.kind === "pending") {
                this.pendingInput = Buffer.from(buffer);
                if (parsed.standaloneEscape) {
                    this.scheduleStandaloneEscape();
                }
                return;
            }

            buffer = buffer.subarray(parsed.bytesConsumed);
            this.activePrompt?.handleKeypress(parsed.input, parsed.key);
        }
    };

    private cancelPendingEscape(): void {
        if (!this.pendingEscapeTimer) {
            return;
        }

        clearTimeout(this.pendingEscapeTimer);
        this.pendingEscapeTimer = undefined;
    }

    private scheduleStandaloneEscape(): void {
        this.cancelPendingEscape();
        this.pendingEscapeTimer = setTimeout(() => {
            this.pendingEscapeTimer = undefined;
            if (
                this.pendingInput.length !== 1 ||
                this.pendingInput[0] !== 0x1b
            ) {
                return;
            }

            this.pendingInput = EMPTY_BUFFER;
            this.activePrompt?.handleKeypress("", { name: "escape" });
        }, ESCAPE_SEQUENCE_TIMEOUT_MS);
    }

    private columns(): number {
        return Math.max(20, this.output.columns ?? 80);
    }

    private clearRenderedOutput(): void {
        this.output.write(clearOutput(this.renderedOutput, this.columns()));
        this.renderedOutput = "";
    }

    private renderFrame(frame: PromptFrame): void {
        this.clearRenderedOutput();

        if (frame.hideCursor !== this.cursorHidden) {
            this.output.write(frame.hideCursor ? cursor.hide : cursor.show);
            this.cursorHidden = frame.hideCursor;
        }

        this.output.write(erase.line + cursor.to(0) + frame.writtenOutput);
        this.renderedOutput = frame.visibleOutput;
    }

    private commitFrame(frame: PromptFrame): void {
        this.renderFrame(frame);
        if (this.cursorHidden) {
            this.output.write(cursor.show);
            this.cursorHidden = false;
        }
        this.output.write("\n");
        this.renderedOutput = "";
    }

    private rejectWithAbort(
        settle: (result: PromptSettlement) => void,
        frame: PromptFrame,
    ): void {
        settle({
            kind: "reject",
            error: new PromptAbortedError(),
            frame,
        });
    }

    private rejectWithExit(
        settle: (result: PromptSettlement) => void,
        frame: PromptFrame,
    ): void {
        settle({
            kind: "reject",
            error: new PromptExitedError(),
            frame,
        });
    }

    private handleCancelKey(input: {
        key: PromptKeypress;
        settle: (result: PromptSettlement) => void;
        render: () => PromptFrame;
        markAborted: () => void;
        markExited: () => void;
    }): boolean {
        if (input.key.ctrl && input.key.name === "c") {
            input.markAborted();
            this.rejectWithAbort(input.settle, input.render());
            return true;
        }

        if (input.key.name === "escape") {
            input.markExited();
            this.rejectWithExit(input.settle, input.render());
            return true;
        }

        return false;
    }

    private createPromptPromise(
        initializer: (
            settle: (result: PromptSettlement) => void,
        ) => ActivePromptState,
    ): SessionPromptResult {
        return new Promise<Record<string, unknown>>((resolve, reject) => {
            let settled = false;
            const settle = (result: PromptSettlement) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.commitFrame(result.frame);
                this.activePrompt = undefined;

                if (result.kind === "resolve") {
                    resolve(result.value);
                    return;
                }

                reject(result.error);
            };

            this.activePrompt = initializer(settle);
        });
    }

    private runAutocompletePrompt(
        question: InteractiveAutocompleteQuestion,
    ): SessionPromptResult {
        return this.createPromptPromise((settle) => {
            const allChoices = Array.isArray(question.choices)
                ? question.choices
                : [];
            const suggest =
                question.suggest ??
                (async (
                    _input: string,
                    choices: InteractiveAutocompleteChoice[],
                ) => choices);
            const limit = Math.max(1, question.limit ?? 10);
            const noMatchesLabel = question.noMatches ?? "no matches found";
            let query = "";
            let suggestions = allChoices;
            let selectedIndex = this.resolveAutocompleteInitialIndex(question);
            let completing = false;
            let exited = false;
            let done = false;
            let aborted = false;
            let refreshToken = 0;

            const selectedChoice = () => suggestions[selectedIndex];

            const render = (): PromptFrame => {
                const headerValue =
                    done || exited || aborted
                        ? (selectedChoice()?.title ?? query)
                        : query;
                const header = [
                    styleSymbol({ done, exited, aborted }),
                    kleur.bold(question.message),
                    styleDelimiter(completing),
                    headerValue,
                ].join(" ");

                let visibleOutput = header;
                if (!done && !exited && !aborted) {
                    const renderedOptions =
                        suggestions.length > 0
                            ? this.renderAutocompleteOptions(
                                  suggestions,
                                  selectedIndex,
                                  limit,
                              )
                            : kleur.gray(noMatchesLabel);
                    visibleOutput += `\n${renderedOptions}`;
                }

                return {
                    hideCursor: true,
                    visibleOutput,
                    writtenOutput: visibleOutput,
                };
            };

            const refreshSuggestions = async (): Promise<void> => {
                const token = refreshToken + 1;
                refreshToken = token;
                completing = true;
                this.renderFrame(render());

                const nextSuggestions = await suggest(query, allChoices);
                if (token !== refreshToken || done || exited || aborted) {
                    return;
                }

                suggestions = Array.isArray(nextSuggestions)
                    ? nextSuggestions
                    : [];
                if (suggestions.length === 0) {
                    selectedIndex = 0;
                } else if (selectedIndex >= suggestions.length) {
                    selectedIndex = suggestions.length - 1;
                }

                completing = false;
                this.renderFrame(render());
            };

            const state: ActivePromptState = {
                settle,
                handleKeypress: (input, key) => {
                    if (
                        key.name === "escape" &&
                        question.clearFirst &&
                        query.length > 0
                    ) {
                        query = "";
                        void refreshSuggestions();
                        return;
                    }

                    if (
                        this.handleCancelKey({
                            key,
                            settle,
                            render,
                            markAborted: () => {
                                aborted = true;
                            },
                            markExited: () => {
                                exited = true;
                            },
                        })
                    ) {
                        return;
                    }

                    switch (key.name) {
                        case "return":
                        case "enter": {
                            const choice = selectedChoice();
                            if (!choice) {
                                this.output.write(beep);
                                return;
                            }
                            done = true;
                            settle({
                                kind: "resolve",
                                value: {
                                    [question.name]: choice.value,
                                },
                                frame: render(),
                            });
                            return;
                        }
                        case "up":
                            if (suggestions.length === 0) {
                                this.output.write(beep);
                                return;
                            }
                            selectedIndex =
                                selectedIndex === 0
                                    ? suggestions.length - 1
                                    : selectedIndex - 1;
                            this.renderFrame(render());
                            return;
                        case "down":
                        case "tab":
                            if (suggestions.length === 0) {
                                this.output.write(beep);
                                return;
                            }
                            selectedIndex =
                                selectedIndex === suggestions.length - 1
                                    ? 0
                                    : selectedIndex + 1;
                            this.renderFrame(render());
                            return;
                        case "pageup":
                            if (suggestions.length === 0) {
                                this.output.write(beep);
                                return;
                            }
                            selectedIndex = Math.max(0, selectedIndex - limit);
                            this.renderFrame(render());
                            return;
                        case "pagedown":
                            if (suggestions.length === 0) {
                                this.output.write(beep);
                                return;
                            }
                            selectedIndex = Math.min(
                                suggestions.length - 1,
                                selectedIndex + limit,
                            );
                            this.renderFrame(render());
                            return;
                        case "backspace":
                            if (query.length === 0) {
                                this.output.write(beep);
                                return;
                            }
                            query = query.slice(0, -1);
                            void refreshSuggestions();
                            return;
                    }

                    if (
                        input &&
                        !key.ctrl &&
                        !key.meta &&
                        !/\r|\n|\t/.test(input)
                    ) {
                        query += input;
                        void refreshSuggestions();
                    }
                },
            };

            this.renderFrame(render());
            void refreshSuggestions();
            return state;
        });
    }

    private resolveAutocompleteInitialIndex(
        question: InteractiveAutocompleteQuestion,
    ): number {
        if (typeof question.initial === "number") {
            return Math.max(
                0,
                Math.min(question.initial, question.choices.length - 1),
            );
        }

        if (typeof question.initial === "string") {
            const index = question.choices.findIndex(
                (choice) =>
                    choice.value === question.initial ||
                    choice.title === question.initial,
            );
            return index >= 0 ? index : 0;
        }

        return 0;
    }

    private renderAutocompleteOptions(
        choices: InteractiveAutocompleteChoice[],
        selectedIndex: number,
        limit: number,
    ): string {
        const { startIndex, endIndex } = entriesToDisplay(
            selectedIndex,
            choices.length,
            limit,
        );

        return choices
            .slice(startIndex, endIndex)
            .map((choice, offset) => {
                const actualIndex = startIndex + offset;
                const hovered = actualIndex === selectedIndex;
                const isStart = offset === 0 && startIndex > 0;
                const isEnd =
                    actualIndex === endIndex - 1 && endIndex < choices.length;
                return this.renderAutocompleteOption(
                    choice,
                    hovered,
                    isStart,
                    isEnd,
                );
            })
            .join("\n");
    }

    private renderAutocompleteOption(
        choice: InteractiveAutocompleteChoice,
        hovered: boolean,
        isStart: boolean,
        isEnd: boolean,
    ): string {
        let prefix = isStart
            ? FIGURES.arrowUp
            : isEnd
              ? FIGURES.arrowDown
              : " ";
        const title = hovered
            ? kleur.cyan().underline(choice.title)
            : choice.title;
        prefix = `${hovered ? kleur.cyan(FIGURES.pointer) : " "} ${prefix}`;

        let description = "";
        if (choice.description) {
            description = ` - ${choice.description}`;
            if (
                stripAnsi(prefix).length +
                    stripAnsi(title).length +
                    stripAnsi(description).length >=
                this.columns()
            ) {
                description =
                    "\n" +
                    wrapText(choice.description, {
                        margin: 3,
                        width: this.columns(),
                    });
            }
        }

        return `${prefix} ${title}${kleur.gray(description)}`;
    }

    private runTextPrompt(
        question: InteractiveTextQuestion,
    ): SessionPromptResult {
        return this.createPromptPromise((settle) => {
            const initialValue = question.initial ?? "";
            let value = "";
            let cursorIndex = 0;
            let errorMessage = "";
            let showError = false;
            let done = false;
            let exited = false;
            let aborted = false;
            let validationToken = 0;

            const renderValue = (): {
                display: string;
                placeholder: boolean;
            } => {
                if (!value && initialValue) {
                    return {
                        display: kleur.gray(initialValue),
                        placeholder: true,
                    };
                }

                return {
                    display: value,
                    placeholder: false,
                };
            };

            const render = (): PromptFrame => {
                const display = renderValue();
                const visibleValue = showError
                    ? kleur.red(display.display)
                    : display.display;
                const header = [
                    styleSymbol({ done, exited, aborted }),
                    kleur.bold(question.message),
                    styleDelimiter(false),
                    visibleValue,
                ].join(" ");

                let visibleOutput = header;
                let writtenOutput = header;
                if (showError && errorMessage) {
                    const wrappedError = errorMessage
                        .split("\n")
                        .reduce(
                            (text, line, index) =>
                                `${text}\n${
                                    index === 0 ? FIGURES.pointerSmall : " "
                                } ${kleur.red().italic(line)}`,
                            "",
                        );
                    visibleOutput += wrappedError;
                    writtenOutput +=
                        cursor.save + wrappedError + cursor.restore;
                }

                if (!done && !exited && !aborted) {
                    const displayLength = display.placeholder
                        ? 0
                        : stripAnsi(display.display).length;
                    const cursorOffset = displayLength - cursorIndex;
                    if (cursorOffset > 0) {
                        writtenOutput += cursor.move(-cursorOffset, 0);
                    }
                }

                return {
                    hideCursor: false,
                    visibleOutput,
                    writtenOutput,
                };
            };

            const validateValue = async (): Promise<string | undefined> => {
                if (!question.validate) {
                    return undefined;
                }

                const validation = await question.validate(
                    value || initialValue,
                );
                if (validation === true) {
                    return undefined;
                }
                if (typeof validation === "string") {
                    return validation;
                }
                return question.error ?? "Please enter a valid value";
            };

            const state: ActivePromptState = {
                settle,
                handleKeypress: (input, key) => {
                    if (
                        this.handleCancelKey({
                            key,
                            settle,
                            render,
                            markAborted: () => {
                                aborted = true;
                            },
                            markExited: () => {
                                exited = true;
                            },
                        })
                    ) {
                        return;
                    }

                    switch (key.name) {
                        case "return":
                        case "enter": {
                            const token = validationToken + 1;
                            validationToken = token;
                            void validateValue().then((nextError) => {
                                if (
                                    token !== validationToken ||
                                    done ||
                                    exited ||
                                    aborted
                                ) {
                                    return;
                                }

                                if (nextError) {
                                    errorMessage = nextError;
                                    showError = true;
                                    this.renderFrame(render());
                                    return;
                                }

                                done = true;
                                settle({
                                    kind: "resolve",
                                    value: {
                                        [question.name]: value || initialValue,
                                    },
                                    frame: render(),
                                });
                            });
                            return;
                        }
                        case "left":
                            if (cursorIndex <= 0) {
                                this.output.write(beep);
                                return;
                            }
                            cursorIndex -= 1;
                            this.renderFrame(render());
                            return;
                        case "right":
                            if (cursorIndex >= value.length) {
                                this.output.write(beep);
                                return;
                            }
                            cursorIndex += 1;
                            this.renderFrame(render());
                            return;
                        case "home":
                            cursorIndex = 0;
                            this.renderFrame(render());
                            return;
                        case "end":
                            cursorIndex = value.length;
                            this.renderFrame(render());
                            return;
                        case "backspace":
                            if (cursorIndex <= 0) {
                                this.output.write(beep);
                                return;
                            }
                            value =
                                value.slice(0, cursorIndex - 1) +
                                value.slice(cursorIndex);
                            cursorIndex -= 1;
                            showError = false;
                            this.renderFrame(render());
                            return;
                        case "delete":
                            if (cursorIndex >= value.length) {
                                this.output.write(beep);
                                return;
                            }
                            value =
                                value.slice(0, cursorIndex) +
                                value.slice(cursorIndex + 1);
                            showError = false;
                            this.renderFrame(render());
                            return;
                        case "tab":
                            if (!value && initialValue) {
                                value = initialValue;
                                cursorIndex = value.length;
                                showError = false;
                                this.renderFrame(render());
                                return;
                            }
                            this.output.write(beep);
                            return;
                    }

                    if (
                        input &&
                        !key.ctrl &&
                        !key.meta &&
                        !/\r|\n|\t/.test(input)
                    ) {
                        value =
                            value.slice(0, cursorIndex) +
                            input +
                            value.slice(cursorIndex);
                        cursorIndex += input.length;
                        showError = false;
                        this.renderFrame(render());
                    }
                },
            };

            this.renderFrame(render());
            return state;
        });
    }

    private runTogglePrompt(
        question: InteractiveToggleQuestion,
    ): SessionPromptResult {
        return this.createPromptPromise((settle) => {
            const activeLabel = question.active ?? "on";
            const inactiveLabel = question.inactive ?? "off";
            let value = Boolean(question.initial);
            let done = false;
            let exited = false;
            let aborted = false;

            const render = (): PromptFrame => {
                const visibleOutput = [
                    styleSymbol({ done, exited, aborted }),
                    kleur.bold(question.message),
                    styleDelimiter(done),
                    value
                        ? inactiveLabel
                        : kleur.cyan().underline(inactiveLabel),
                    kleur.gray("/"),
                    value ? kleur.cyan().underline(activeLabel) : activeLabel,
                ].join(" ");

                return {
                    hideCursor: true,
                    visibleOutput,
                    writtenOutput: visibleOutput,
                };
            };

            const state: ActivePromptState = {
                settle,
                handleKeypress: (input, key) => {
                    if (
                        this.handleCancelKey({
                            key,
                            settle,
                            render,
                            markAborted: () => {
                                aborted = true;
                            },
                            markExited: () => {
                                exited = true;
                            },
                        })
                    ) {
                        return;
                    }

                    switch (key.name) {
                        case "return":
                        case "enter":
                            done = true;
                            settle({
                                kind: "resolve",
                                value: {
                                    [question.name]: value,
                                },
                                frame: render(),
                            });
                            return;
                        case "left":
                        case "down":
                            value = false;
                            this.renderFrame(render());
                            return;
                        case "right":
                        case "up":
                            value = true;
                            this.renderFrame(render());
                            return;
                        case "tab":
                            value = !value;
                            this.renderFrame(render());
                            return;
                    }

                    if (input === " ") {
                        value = !value;
                        this.renderFrame(render());
                        return;
                    }
                    if (input === "1") {
                        value = true;
                        this.renderFrame(render());
                        return;
                    }
                    if (input === "0") {
                        value = false;
                        this.renderFrame(render());
                        return;
                    }
                },
            };

            this.renderFrame(render());
            return state;
        });
    }

    private runConfirmPrompt(
        question: InteractiveConfirmQuestion,
    ): SessionPromptResult {
        return this.createPromptPromise((settle) => {
            const yesLabel = question.yes ?? "yes";
            const noLabel = question.no ?? "no";
            const yesOption = question.yesOption ?? "(Y/n)";
            const noOption = question.noOption ?? "(y/N)";
            let value = Boolean(question.initial);
            let done = false;
            let exited = false;
            let aborted = false;

            const render = (): PromptFrame => {
                const visibleOutput = [
                    styleSymbol({ done, exited, aborted }),
                    kleur.bold(question.message),
                    styleDelimiter(done),
                    done
                        ? value
                            ? yesLabel
                            : noLabel
                        : kleur.gray(value ? yesOption : noOption),
                ].join(" ");

                return {
                    hideCursor: true,
                    visibleOutput,
                    writtenOutput: visibleOutput,
                };
            };

            const state: ActivePromptState = {
                settle,
                handleKeypress: (input, key) => {
                    if (
                        this.handleCancelKey({
                            key,
                            settle,
                            render,
                            markAborted: () => {
                                aborted = true;
                            },
                            markExited: () => {
                                exited = true;
                            },
                        })
                    ) {
                        return;
                    }

                    switch (key.name) {
                        case "return":
                        case "enter":
                            done = true;
                            settle({
                                kind: "resolve",
                                value: {
                                    [question.name]: value,
                                },
                                frame: render(),
                            });
                            return;
                    }

                    if (input.toLowerCase() === "y") {
                        value = true;
                        done = true;
                        settle({
                            kind: "resolve",
                            value: {
                                [question.name]: true,
                            },
                            frame: render(),
                        });
                        return;
                    }

                    if (input.toLowerCase() === "n") {
                        value = false;
                        done = true;
                        settle({
                            kind: "resolve",
                            value: {
                                [question.name]: false,
                            },
                            frame: render(),
                        });
                    }
                },
            };

            this.renderFrame(render());
            return state;
        });
    }
}

export function createInteractivePrompt(
    options: CreateInteractivePromptOptions = {},
): InteractivePrompt {
    const session = new InteractivePromptSession(options);
    const prompt = (async <
        TQuestion extends InteractivePromptQuestion<any, any>,
    >(
        questions: TQuestion,
    ): Promise<Record<TQuestion["name"], unknown>> =>
        (await session.prompt(questions)) as Record<
            TQuestion["name"],
            unknown
        >) as InteractivePrompt;
    prompt.close = () => {
        session.close();
    };
    return prompt;
}
