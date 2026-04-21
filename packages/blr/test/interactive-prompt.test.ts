import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
    createInteractivePrompt,
    type InteractiveAutocompleteChoice,
    type InteractiveAutocompleteQuestion,
} from "../src/interactive-prompt.js";
import { PromptAbortedError, PromptExitedError } from "../src/prompt.js";

class FakePromptInput extends PassThrough {
    isTTY = true;

    isRaw = false;

    setRawMode(value: boolean): void {
        this.isRaw = value;
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

function emitData(input: FakePromptInput, value: string, delay = 10): void {
    setTimeout(() => {
        input.emit("data", Buffer.from(value, "binary"));
    }, delay);
}

test("createInteractivePrompt keeps autocomplete working after escape and reopen", async () => {
    const input = new FakePromptInput();
    const output = new FakePromptOutput();
    const prompt = createInteractivePrompt({
        stdin: input as any,
        stdout: output as any,
    });

    const question: InteractiveAutocompleteQuestion<"choice", string> = {
        type: "autocomplete",
        name: "choice",
        message: "Pick a field",
        choices: [
            { title: "[..] Back to compound", value: "__back__" },
            { title: "alpha (byte) 1", value: "alpha" },
            { title: "beta (byte) 1", value: "beta" },
            { title: "gamma (byte) 1", value: "gamma" },
        ],
        suggest: async (
            _input: string,
            choices: InteractiveAutocompleteChoice<string>[],
        ) => choices,
        limit: 10,
    };

    const firstPrompt = prompt(question);
    emitData(input, "\x1b");
    await assert.rejects(
        () => firstPrompt,
        (error: unknown) => error instanceof PromptExitedError,
    );

    const secondPrompt = prompt(question);
    emitData(input, "\x1b[B\r");
    await assert.doesNotReject(async () => {
        const result = await secondPrompt;
        assert.deepEqual(result, {
            choice: "alpha",
        });
    });

    prompt.close?.();
    assert.equal(input.isRaw, false);
});

test("createInteractivePrompt handles split arrow escape sequences without treating them as exit", async () => {
    const input = new FakePromptInput();
    const output = new FakePromptOutput();
    const prompt = createInteractivePrompt({
        stdin: input as any,
        stdout: output as any,
    });

    const activePrompt = prompt({
        type: "autocomplete",
        name: "choice",
        message: "Pick a field",
        choices: [
            { title: "alpha (byte) 1", value: "alpha" },
            { title: "beta (byte) 1", value: "beta" },
            { title: "gamma (byte) 1", value: "gamma" },
        ],
        suggest: async (
            _input: string,
            choices: InteractiveAutocompleteChoice<string>[],
        ) => choices,
    });

    emitData(input, "\x1b[", 10);
    emitData(input, "B\r", 12);
    await assert.doesNotReject(async () => {
        const result = await activePrompt;
        assert.deepEqual(result, {
            choice: "beta",
        });
    });

    prompt.close?.();
});

test("createInteractivePrompt uses escape to exit text prompts without poisoning the session", async () => {
    const input = new FakePromptInput();
    const output = new FakePromptOutput();
    const prompt = createInteractivePrompt({
        stdin: input as any,
        stdout: output as any,
    });

    const textPrompt = prompt({
        type: "text",
        name: "fieldName",
        message: "Field name",
        initial: "BiomeOverride",
    });
    emitData(input, "\x1b");
    await assert.rejects(
        () => textPrompt,
        (error: unknown) => error instanceof PromptExitedError,
    );

    const autocompletePrompt = prompt({
        type: "autocomplete",
        name: "choice",
        message: "Pick a field",
        choices: [
            { title: "one", value: "one" },
            { title: "two", value: "two" },
        ],
        suggest: async (
            _input: string,
            choices: InteractiveAutocompleteChoice<string>[],
        ) => choices,
    });
    emitData(input, "\x1b[B\r");
    await assert.doesNotReject(async () => {
        const result = await autocompletePrompt;
        assert.deepEqual(result, {
            choice: "two",
        });
    });

    prompt.close?.();
});

test("createInteractivePrompt preserves ctrl+c as abort", async () => {
    const input = new FakePromptInput();
    const output = new FakePromptOutput();
    const prompt = createInteractivePrompt({
        stdin: input as any,
        stdout: output as any,
    });

    const activePrompt = prompt({
        type: "autocomplete",
        name: "choice",
        message: "Pick a field",
        choices: [{ title: "one", value: "one" }],
        suggest: async (
            _input: string,
            choices: InteractiveAutocompleteChoice<string>[],
        ) => choices,
    });
    emitData(input, "\x03");
    await assert.rejects(
        () => activePrompt,
        (error: unknown) => error instanceof PromptAbortedError,
    );

    prompt.close?.();
});
