import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { Choice } from "prompts";
import {
    PromptAbortedError,
    PromptExitedError,
    runPrompt,
} from "../src/prompt.js";

class FakePromptInput extends PassThrough {
    isTTY = true;

    rawMode = false;

    setRawMode(value: boolean): void {
        this.rawMode = value;
    }

    resume(): this {
        return this;
    }

    pause(): this {
        return this;
    }
}

class FakePromptOutput extends Writable {
    isTTY = true;

    columns = 120;

    _write(
        _chunk: string | Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        callback();
    }
}

function createAutocompleteQuestion() {
    const stdin = new FakePromptInput();
    const stdout = new FakePromptOutput();

    return {
        stdin,
        stdout,
        question: {
            type: "autocomplete" as const,
            name: "choice",
            message: "Pick a field",
            choices: [
                { title: "One", value: "one" },
                { title: "Two", value: "two" },
            ],
            suggest: async (_input: string, choices: Choice[]) => choices,
            instructions: false,
            stdin,
            stdout,
        },
    };
}

test("runPrompt treats escape in autocomplete as exit instead of submit", async () => {
    const { stdin, question } = createAutocompleteQuestion();

    const prompt = runPrompt(question);
    setTimeout(() => {
        stdin.emit("data", Buffer.from([0x1b]));
    }, 10);

    await assert.rejects(
        () => prompt,
        (error: unknown) => error instanceof PromptExitedError,
    );
});

test("runPrompt treats ctrl+c in autocomplete as abort", async () => {
    const { stdin, question } = createAutocompleteQuestion();

    const prompt = runPrompt(question);
    setTimeout(() => {
        stdin.emit("data", Buffer.from([0x03]));
    }, 10);

    await assert.rejects(
        () => prompt,
        (error: unknown) => error instanceof PromptAbortedError,
    );
});
