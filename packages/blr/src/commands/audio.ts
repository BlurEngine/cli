import { readFile } from "node:fs/promises";
import path from "node:path";
import {
    convertProjectMidiToBaudWithDiagnostics,
    type BebeMidiToBaudDiagnostic,
    type BebeMidiToBaudPolicyOptions,
    type BebeMidiToBaudProfile,
} from "../bebe-tooling.js";
import { loadBlurConfig } from "../config.js";
import { writeText } from "../fs.js";

export type AudioConvertCommandOptions = {
    readonly cue?: string;
    readonly lowBassGap?: number;
    readonly lowBassPitch?: number;
    readonly maxPressure?: number;
    readonly maxSimultaneous?: number;
    readonly out?: string;
    readonly profile?: string;
    readonly sound?: string;
    readonly tempo?: number;
};

const DEFAULT_AUDIO_DIRECTORY = "audio";
const BAUD_EXTENSION = ".baud";
const MIDI_EXTENSIONS = new Set([".mid", ".midi"]);
const CUE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;

export async function runAudioConvertCommand(
    inputPath: string,
    options: AudioConvertCommandOptions,
): Promise<void> {
    const { projectRoot } = await loadBlurConfig(process.cwd());
    const inputAbsolutePath = path.resolve(process.cwd(), inputPath);
    assertMidiInputPath(inputAbsolutePath);
    const cueId = normalizeCueId(
        options.cue ?? path.basename(inputPath, path.extname(inputPath)),
    );
    const tempo = normalizeOptionalPositiveInteger(
        options.tempo,
        "audio convert tempo",
    );
    const profile = normalizeOptionalProfile(options.profile);
    const policy = normalizeAudioConvertPolicy(options);
    const outputRelativePath = normalizeAudioOutputPath(
        options.out ??
            path.posix.join(
                DEFAULT_AUDIO_DIRECTORY,
                `${cueIdToFileStem(cueId)}${BAUD_EXTENSION}`,
            ),
    );
    const outputAbsolutePath = path.resolve(projectRoot, outputRelativePath);
    const data = await readFile(inputAbsolutePath);
    const conversion = await convertProjectMidiToBaudWithDiagnostics(
        projectRoot,
        data,
        {
            cueId,
            ...(policy === undefined ? {} : { policy }),
            ...(profile === undefined ? {} : { profile }),
            ...(options.sound ? { soundId: options.sound } : {}),
            ...(tempo === undefined ? {} : { tempo }),
        },
    );

    await writeText(outputAbsolutePath, conversion.baud);
    console.log(
        `[audio] Converted ${formatProjectRelative(
            projectRoot,
            inputAbsolutePath,
        )} -> ${outputRelativePath}.`,
    );
    reportDroppedMidiParts(conversion.diagnostics);
    reportOptimizedPlayback(conversion.diagnostics);
}

function assertMidiInputPath(inputPath: string): void {
    if (!MIDI_EXTENSIONS.has(path.extname(inputPath).toLowerCase())) {
        throw new Error(
            "audio convert input must use the .mid or .midi extension.",
        );
    }
}

function normalizeCueId(input: string): string {
    const cueId = input.trim();
    if (!CUE_ID_PATTERN.test(cueId)) {
        throw new Error(`audio convert cue id "${input}" is not valid.`);
    }

    return cueId;
}

function cueIdToFileStem(cueId: string): string {
    return cueId.replace(/[^a-z0-9._-]+/gi, "-");
}

function normalizeOptionalPositiveInteger(
    input: number | undefined,
    label: string,
): number | undefined {
    if (input === undefined) {
        return undefined;
    }
    if (!Number.isInteger(input) || input <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }

    return input;
}

function normalizeOptionalPositiveNumber(
    input: number | undefined,
    label: string,
): number | undefined {
    if (input === undefined) {
        return undefined;
    }
    if (!Number.isFinite(input) || input <= 0) {
        throw new Error(`${label} must be a positive number.`);
    }

    return input;
}

function normalizeOptionalProfile(
    input: string | undefined,
): BebeMidiToBaudProfile | undefined {
    if (input === undefined) {
        return undefined;
    }
    if (input === "compact" || input === "minecraft" || input === "raw") {
        return input;
    }

    throw new Error(
        'audio convert profile must be "minecraft", "compact", or "raw".',
    );
}

function normalizeAudioConvertPolicy(
    options: AudioConvertCommandOptions,
): BebeMidiToBaudPolicyOptions | undefined {
    const policy = {
        lowBassMinimumPitch: normalizeOptionalPositiveInteger(
            options.lowBassPitch,
            "audio convert low bass pitch",
        ),
        lowBassMinimumTickGap: normalizeOptionalPositiveNumber(
            options.lowBassGap,
            "audio convert low bass gap",
        ),
        maxSimultaneousNotes: normalizeOptionalPositiveNumber(
            options.maxSimultaneous,
            "audio convert max simultaneous",
        ),
        maxWeightedPressure: normalizeOptionalPositiveNumber(
            options.maxPressure,
            "audio convert max pressure",
        ),
    };
    const entries = Object.entries(policy).filter(
        (entry): entry is [keyof BebeMidiToBaudPolicyOptions, number] =>
            entry[1] !== undefined,
    );

    return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function normalizeAudioOutputPath(input: string): string {
    const outputPath = normalizeProjectRelativePath(
        input,
        "audio convert output",
    );
    if (
        outputPath !== DEFAULT_AUDIO_DIRECTORY &&
        !outputPath.startsWith(`${DEFAULT_AUDIO_DIRECTORY}/`)
    ) {
        throw new Error("audio convert output must be under audio/.");
    }
    if (path.posix.extname(outputPath) !== BAUD_EXTENSION) {
        throw new Error("audio convert output must use the .baud extension.");
    }

    return outputPath;
}

function normalizeProjectRelativePath(input: string, label: string): string {
    const normalized = path.posix.normalize(input.trim().replace(/\\/g, "/"));
    if (
        normalized.length === 0 ||
        normalized === "." ||
        path.posix.isAbsolute(normalized) ||
        normalized === ".." ||
        normalized.startsWith("../")
    ) {
        throw new Error(`${label} must be a project-relative path.`);
    }

    return normalized;
}

function formatProjectRelative(
    projectRoot: string,
    targetPath: string,
): string {
    const relativePath = path
        .relative(projectRoot, targetPath)
        .replace(/\\/g, "/");
    return relativePath.startsWith("..") ? targetPath : relativePath;
}

function reportDroppedMidiParts(
    diagnostics: readonly BebeMidiToBaudDiagnostic[],
): void {
    const dropped = diagnostics.filter(isDroppedMidiPart);
    if (dropped.length === 0) {
        return;
    }

    console.warn("[audio] Dropped unsupported MIDI parts:");
    for (const diagnostic of dropped) {
        console.warn(
            `[audio]   ${formatDroppedMidiPart(
                diagnostic,
            )}: ${diagnostic.noteCount} ${pluralize(
                diagnostic.noteCount,
                "note",
            )}`,
        );
    }
}

function reportOptimizedPlayback(
    diagnostics: readonly BebeMidiToBaudDiagnostic[],
): void {
    const optimized = diagnostics.filter(isOptimizedPlayback);
    if (optimized.length === 0) {
        return;
    }

    console.log("[audio] Optimized MIDI playback:");
    for (const diagnostic of optimized) {
        console.log(
            `[audio]   ${diagnostic.profile} ${formatOptimizedPlaybackReason(
                diagnostic.reason,
            )}: ${diagnostic.noteCount} ${pluralize(
                diagnostic.noteCount,
                "note",
            )}`,
        );
    }
}

function isDroppedMidiPart(
    diagnostic: BebeMidiToBaudDiagnostic,
): diagnostic is Extract<
    BebeMidiToBaudDiagnostic,
    { readonly kind: "droppedPart" }
> {
    return diagnostic.kind === "droppedPart";
}

function isOptimizedPlayback(
    diagnostic: BebeMidiToBaudDiagnostic,
): diagnostic is Extract<
    BebeMidiToBaudDiagnostic,
    { readonly kind: "optimizedPlayback" }
> {
    return diagnostic.kind === "optimizedPlayback";
}

function formatDroppedMidiPart(
    diagnostic: Extract<
        BebeMidiToBaudDiagnostic,
        { readonly kind: "droppedPart" }
    >,
): string {
    const partName =
        diagnostic.programName ??
        (diagnostic.program === undefined
            ? diagnostic.reason
            : `Program ${diagnostic.program}`);
    return `ch${diagnostic.midiChannel} ${partName}`;
}

function formatOptimizedPlaybackReason(
    reason: Extract<
        BebeMidiToBaudDiagnostic,
        { readonly kind: "optimizedPlayback" }
    >["reason"],
): string {
    switch (reason) {
        case "duplicateNote":
            return "duplicate-note";
        case "lowBassDensity":
            return "low-bass-density";
        case "pressureBudget":
            return "pressure-budget";
        case "simultaneousBudget":
            return "simultaneous-budget";
    }
}

function pluralize(count: number, singular: string): string {
    return count === 1 ? singular : `${singular}s`;
}
