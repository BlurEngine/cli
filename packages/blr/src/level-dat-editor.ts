import * as prismarineNbt from "prismarine-nbt";
import {
    filterInteractiveChoices,
    type InteractiveAutocompleteChoice,
    type InteractiveAutocompleteQuestion,
    type InteractivePrompt,
    type InteractivePromptQuestion,
} from "./interactive-prompt.js";
import { isPromptExitedError } from "./prompt.js";

type NbtTag = prismarineNbt.Tags[prismarineNbt.TagType];
type NbtScalarTag =
    | prismarineNbt.Byte
    | prismarineNbt.Short
    | prismarineNbt.Int
    | prismarineNbt.Long
    | prismarineNbt.Float
    | prismarineNbt.Double
    | prismarineNbt.String;
type NbtScalarTagType = NbtScalarTag["type"];
type AddableNbtTagType = NbtScalarTagType | "compound";

export type LevelDatInteractiveEditResult = {
    saved: boolean;
    changed: boolean;
    changedPaths: string[];
};

type LevelDatEditorChoice =
    | { kind: "save" }
    | { kind: "discard" }
    | { kind: "add" }
    | { kind: "remove" }
    | { kind: "up" }
    | { kind: "field"; fieldName: string };

type SearchablePromptChoice<TValue> = InteractiveAutocompleteChoice<TValue> & {
    searchText: string;
};

type LevelDatEditorChoiceOption = SearchablePromptChoice<LevelDatEditorChoice>;
type LevelDatFieldChoiceOption = SearchablePromptChoice<string>;
type LevelDatTagTypeChoiceOption = SearchablePromptChoice<
    AddableNbtTagType | typeof BACK_CHOICE_VALUE
>;

const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;
const BACK_CHOICE_VALUE = "__blr_back__";
const DEFAULT_AUTOCOMPLETE_LIMIT = 15;
const ADDABLE_TAG_TYPE_CHOICES: Array<{
    title: string;
    value: AddableNbtTagType;
    description: string;
}> = [
    {
        title: "Byte",
        value: "byte",
        description: "8-bit signed integer. Common for 0/1 world flags.",
    },
    {
        title: "Short",
        value: "short",
        description: "16-bit signed integer.",
    },
    {
        title: "Int",
        value: "int",
        description: "32-bit signed integer. Common for most world settings.",
    },
    {
        title: "Long",
        value: "long",
        description: "64-bit signed integer. Good for ticks, time, and seeds.",
    },
    {
        title: "Float",
        value: "float",
        description: "32-bit floating-point number.",
    },
    {
        title: "Double",
        value: "double",
        description: "64-bit floating-point number.",
    },
    {
        title: "String",
        value: "string",
        description: "Text value.",
    },
    {
        title: "Compound",
        value: "compound",
        description: "Nested object containing more named fields.",
    },
];

function isCompoundTag(tag: NbtTag | undefined): tag is prismarineNbt.Compound {
    return tag?.type === "compound";
}

function isScalarTag(tag: NbtTag | undefined): tag is NbtScalarTag {
    if (!tag) {
        return false;
    }

    return (
        tag.type === "byte" ||
        tag.type === "short" ||
        tag.type === "int" ||
        tag.type === "long" ||
        tag.type === "float" ||
        tag.type === "double" ||
        tag.type === "string"
    );
}

function listDefinedCompoundEntries(
    compound: prismarineNbt.Compound,
): Array<[string, NbtTag]> {
    return Object.entries(compound.value)
        .filter(
            (entry): entry is [string, NbtTag] =>
                typeof entry[1] !== "undefined",
        )
        .sort((left, right) => left[0].localeCompare(right[0]));
}

function hasDefinedCompoundField(
    compound: prismarineNbt.Compound,
    fieldName: string,
): boolean {
    return typeof compound.value[fieldName] !== "undefined";
}

function resolveCompoundAtPath(
    root: prismarineNbt.NBT,
    pathSegments: string[],
): prismarineNbt.Compound {
    let current: prismarineNbt.Compound = root;
    for (const segment of pathSegments) {
        const next = current.value[segment];
        if (!isCompoundTag(next)) {
            throw new Error(
                `Cannot resolve level.dat editor path "${pathSegments.join(".")}".`,
            );
        }
        current = next;
    }
    return current;
}

function formatPathLabel(pathSegments: string[]): string {
    return pathSegments.length > 0 ? pathSegments.join(".") : "<root>";
}

function formatFieldPathLabel(
    pathSegments: string[],
    fieldName: string,
): string {
    return [...pathSegments, fieldName].join(".");
}

function truncatePreview(value: string, maxLength = 80): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
}

function longPartsToBigInt(value: [number, number]): bigint {
    const high = BigInt(value[0]);
    const low = BigInt(value[1] >>> 0);
    return (high << 32n) + low;
}

function bigIntToLongParts(value: bigint): [number, number] {
    if (value < MIN_INT64 || value > MAX_INT64) {
        throw new Error(
            `Expected a signed 64-bit integer between ${MIN_INT64} and ${MAX_INT64}, received "${value}".`,
        );
    }

    const high = Number(BigInt.asIntN(32, value >> 32n));
    const low = Number(BigInt.asIntN(32, value));
    return [high, low];
}

function formatScalarPreview(tag: NbtScalarTag): string {
    switch (tag.type) {
        case "string":
            return truncatePreview(JSON.stringify(tag.value));
        case "long":
            return longPartsToBigInt(tag.value).toString();
        default:
            return String(tag.value);
    }
}

function formatTagPreview(tag: NbtTag): string {
    if (isScalarTag(tag)) {
        return formatScalarPreview(tag);
    }

    switch (tag.type) {
        case "compound":
            return `${listDefinedCompoundEntries(tag).length} field(s)`;
        case "list":
            return truncatePreview(
                `${tag.value.type}[${tag.value.value.length}] ${JSON.stringify(
                    prismarineNbt.simplify(tag),
                )}`,
            );
        case "byteArray":
        case "shortArray":
        case "intArray":
        case "longArray":
            return truncatePreview(JSON.stringify(tag.value));
        default:
            return truncatePreview(JSON.stringify(prismarineNbt.simplify(tag)));
    }
}

function formatTagChoiceTitle(fieldName: string, tag: NbtTag): string {
    return `${fieldName} (${tag.type}) ${formatTagPreview(tag)}`;
}

function formatActionChoiceTitle(
    choice: "save" | "exit" | "discard" | "add" | "remove" | "up",
    changedCount?: number,
): string {
    switch (choice) {
        case "save":
            return `[save] Save ${changedCount ?? 0} change(s) and exit`;
        case "exit":
            return "[x] Exit editor";
        case "discard":
            return "[!] Discard unsaved changes and exit";
        case "add":
            return "[+] Add a field to this compound";
        case "remove":
            return "[-] Remove a field from this compound";
        case "up":
            return "[..] Go to parent compound";
    }
}

async function tryPrompt<TQuestion extends InteractivePromptQuestion<any, any>>(
    prompt: InteractivePrompt,
    question: TQuestion,
): Promise<Record<TQuestion["name"], unknown> | undefined> {
    try {
        return await prompt(question);
    } catch (error) {
        if (isPromptExitedError(error)) {
            return undefined;
        }
        throw error;
    }
}

async function promptValue<
    TValue,
    TQuestion extends InteractivePromptQuestion<any, any> =
        InteractivePromptQuestion<any, any>,
>(prompt: InteractivePrompt, question: TQuestion): Promise<TValue | undefined> {
    const result = await tryPrompt(prompt, question);
    if (!result) {
        return undefined;
    }
    return result[question.name as TQuestion["name"]] as TValue | undefined;
}

async function promptAutocompleteValue<TValue>(
    prompt: InteractivePrompt,
    question: Omit<
        InteractiveAutocompleteQuestion<string, TValue>,
        "type" | "suggest" | "limit"
    >,
): Promise<TValue | undefined> {
    return promptValue<TValue>(prompt, {
        ...question,
        type: "autocomplete",
        suggest: filterInteractiveChoices,
        limit: DEFAULT_AUTOCOMPLETE_LIMIT,
    });
}

function buildSearchText(...parts: Array<string | number | undefined>): string {
    return parts
        .flatMap((part) => {
            const value = String(part ?? "").trim();
            return value.length > 0 ? [value] : [];
        })
        .join(" ")
        .toLowerCase();
}

function createSearchableChoice<TValue>(input: {
    title: string;
    value: TValue;
    description?: string;
    searchText: Array<string | number | undefined>;
}): SearchablePromptChoice<TValue> {
    return {
        title: input.title,
        value: input.value,
        description: input.description,
        searchText: buildSearchText(...input.searchText),
    };
}

function hasLevelDatChanged(
    originalData: prismarineNbt.NBT,
    currentData: prismarineNbt.NBT,
): boolean {
    const originalPayload = prismarineNbt.writeUncompressed(
        originalData,
        "little",
    );
    const currentPayload = prismarineNbt.writeUncompressed(
        currentData,
        "little",
    );
    return !originalPayload.equals(currentPayload);
}

function createEditResult(input: {
    saved: boolean;
    changed: boolean;
    changedPaths: Set<string>;
}): LevelDatInteractiveEditResult {
    return {
        saved: input.saved,
        changed: input.changed,
        changedPaths: input.changed
            ? Array.from(input.changedPaths).sort()
            : [],
    };
}

function createEditorChoices(
    compound: prismarineNbt.Compound,
    pathSegments: string[],
    dirty: boolean,
    changedCount: number,
): LevelDatEditorChoiceOption[] {
    const entries = listDefinedCompoundEntries(compound);
    const choices: LevelDatEditorChoiceOption[] = [];

    choices.push(
        createSearchableChoice({
            title: dirty
                ? formatActionChoiceTitle("save", changedCount)
                : formatActionChoiceTitle("exit"),
            value: { kind: "save" },
            searchText: ["save", "exit", "done"],
        }),
    );

    if (dirty) {
        choices.push(
            createSearchableChoice({
                title: formatActionChoiceTitle("discard"),
                value: { kind: "discard" },
                searchText: ["discard", "cancel", "exit"],
            }),
        );
    }

    choices.push(
        createSearchableChoice({
            title: formatActionChoiceTitle("add"),
            value: { kind: "add" },
            searchText: ["add", "new", "create", "field", "compound"],
        }),
    );

    if (entries.length > 0) {
        choices.push(
            createSearchableChoice({
                title: formatActionChoiceTitle("remove"),
                value: { kind: "remove" },
                searchText: ["remove", "delete", "field", "compound"],
            }),
        );
    }

    if (pathSegments.length > 0) {
        choices.push(
            createSearchableChoice({
                title: formatActionChoiceTitle("up"),
                value: { kind: "up" },
                searchText: ["up", "parent", "back"],
            }),
        );
    }

    for (const [fieldName, tag] of entries) {
        choices.push(
            createSearchableChoice({
                title: formatTagChoiceTitle(fieldName, tag),
                value: { kind: "field", fieldName },
                searchText: [fieldName, tag.type, formatTagPreview(tag)],
            }),
        );
    }

    return choices;
}

function parseIntegerInput(
    raw: string,
    label: string,
    minimum: number,
    maximum: number,
): number {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
        throw new Error(
            `Expected ${label} to be an integer, received "${raw}".`,
        );
    }

    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(
            `Expected ${label} between ${minimum} and ${maximum}, received "${raw}".`,
        );
    }

    return value;
}

function parseFiniteNumberInput(raw: string, label: string): number {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error(
            `Expected ${label} to be a number, received an empty value.`,
        );
    }

    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
        throw new Error(
            `Expected ${label} to be a finite number, received "${raw}".`,
        );
    }

    return value;
}

function parseLongInput(raw: string): [number, number] {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
        throw new Error(`Expected a signed 64-bit integer, received "${raw}".`);
    }

    return bigIntToLongParts(BigInt(trimmed));
}

function parseScalarInputForType(
    tagType: NbtScalarTagType,
    raw: string,
): NbtScalarTag["value"] {
    switch (tagType) {
        case "byte":
            return parseIntegerInput(raw, "byte", -128, 127);
        case "short":
            return parseIntegerInput(raw, "short", -32768, 32767);
        case "int":
            return parseIntegerInput(raw, "int", -2147483648, 2147483647);
        case "long":
            return parseLongInput(raw);
        case "float":
            return parseFiniteNumberInput(raw, "float");
        case "double":
            return parseFiniteNumberInput(raw, "double");
        case "string":
            return raw;
    }
}

function parseScalarInput(
    tag: NbtScalarTag,
    raw: string,
): NbtScalarTag["value"] {
    return parseScalarInputForType(tag.type, raw);
}

function formatScalarInitialValue(tag: NbtScalarTag): string {
    switch (tag.type) {
        case "long":
            return longPartsToBigInt(tag.value).toString();
        default:
            return String(tag.value);
    }
}

function defaultScalarInitialValue(tagType: NbtScalarTagType): string {
    if (tagType === "string") {
        return "";
    }

    return "0";
}

function createScalarTag(
    tagType: NbtScalarTagType,
    value: NbtScalarTag["value"],
): NbtScalarTag {
    switch (tagType) {
        case "byte":
            return {
                type: "byte",
                value: value as prismarineNbt.Byte["value"],
            };
        case "short":
            return {
                type: "short",
                value: value as prismarineNbt.Short["value"],
            };
        case "int":
            return {
                type: "int",
                value: value as prismarineNbt.Int["value"],
            };
        case "long":
            return {
                type: "long",
                value: value as prismarineNbt.Long["value"],
            };
        case "float":
            return {
                type: "float",
                value: value as prismarineNbt.Float["value"],
            };
        case "double":
            return {
                type: "double",
                value: value as prismarineNbt.Double["value"],
            };
        case "string":
            return {
                type: "string",
                value: value as prismarineNbt.String["value"],
            };
    }
}

function setScalarTagValue(
    tag: NbtScalarTag,
    value: NbtScalarTag["value"],
): void {
    switch (tag.type) {
        case "byte":
        case "short":
        case "int":
        case "float":
        case "double":
        case "string":
            tag.value = value as typeof tag.value;
            return;
        case "long":
            tag.value = value as prismarineNbt.Long["value"];
    }
}

function normalizeFieldName(value: string): string {
    return value.trim();
}

async function confirmDiscardChanges(
    prompt: InteractivePrompt,
): Promise<boolean> {
    const discard = await promptValue<boolean>(prompt, {
        type: "confirm",
        name: "discard",
        message: "Discard unsaved level.dat changes?",
        initial: false,
    });
    return discard === true;
}

async function editScalarTagValue(
    prompt: InteractivePrompt,
    pathLabel: string,
    tag: NbtScalarTag,
): Promise<boolean> {
    if (tag.type === "byte" && (tag.value === 0 || tag.value === 1)) {
        const nextToggleValue = await promptValue<boolean>(prompt, {
            type: "toggle",
            name: "value",
            message: `Set ${pathLabel} (${tag.type})`,
            initial: tag.value === 1,
            active: "1",
            inactive: "0",
        });
        if (typeof nextToggleValue === "undefined") {
            return false;
        }
        const nextValue = nextToggleValue ? 1 : 0;
        if (nextValue === tag.value) {
            return false;
        }
        tag.value = nextValue;
        return true;
    }

    const nextRawValue = await promptValue<string>(prompt, {
        type: "text",
        name: "value",
        message: `New value for ${pathLabel} (${tag.type})`,
        initial: formatScalarInitialValue(tag),
        validate: (value: string) => {
            try {
                parseScalarInput(tag, value);
                return true;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        },
    });
    if (typeof nextRawValue === "undefined") {
        return false;
    }

    const nextValue = parseScalarInput(tag, nextRawValue);
    const previousValue = JSON.stringify(tag.value);
    const nextValueKey = JSON.stringify(nextValue);
    if (previousValue === nextValueKey) {
        return false;
    }

    setScalarTagValue(tag, nextValue);
    return true;
}

async function promptForNewFieldName(
    prompt: InteractivePrompt,
    compound: prismarineNbt.Compound,
    pathSegments: string[],
    tagType: AddableNbtTagType,
): Promise<string | undefined> {
    const pathLabel = formatPathLabel(pathSegments);
    const fieldName = await promptValue<string>(prompt, {
        type: "text",
        name: "fieldName",
        message: `Name for the new ${tagType} field in ${pathLabel}`,
        validate: (value: string) => {
            const fieldName = normalizeFieldName(value);
            if (!fieldName) {
                return "Field name cannot be empty.";
            }
            if (hasDefinedCompoundField(compound, fieldName)) {
                return `"${fieldName}" already exists in ${pathLabel}.`;
            }
            return true;
        },
    });
    if (typeof fieldName === "undefined") {
        return undefined;
    }
    const normalizedFieldName = normalizeFieldName(fieldName);
    return normalizedFieldName.length > 0 ? normalizedFieldName : undefined;
}

async function promptForAddableTagType(
    prompt: InteractivePrompt,
    pathSegments: string[],
): Promise<AddableNbtTagType | undefined> {
    const pathLabel = formatPathLabel(pathSegments);
    const choices: LevelDatTagTypeChoiceOption[] = [
        createSearchableChoice({
            title: "[..] Back to compound",
            value: BACK_CHOICE_VALUE,
            description: "Return to the current compound without adding.",
            searchText: ["..", "back", "cancel", "return", "compound"],
        }),
        ...ADDABLE_TAG_TYPE_CHOICES.map((choice) =>
            createSearchableChoice({
                title: choice.title,
                value: choice.value,
                description: choice.description,
                searchText: [choice.title, choice.value, choice.description],
            }),
        ),
    ];
    const tagType = await promptAutocompleteValue<
        AddableNbtTagType | typeof BACK_CHOICE_VALUE
    >(prompt, {
        name: "tagType",
        message: `Add a field to ${pathLabel}`,
        choices,
    });
    if (!tagType || tagType === BACK_CHOICE_VALUE) {
        return undefined;
    }
    return tagType;
}

async function promptForNewScalarTag(
    prompt: InteractivePrompt,
    fieldPathLabel: string,
    tagType: NbtScalarTagType,
): Promise<NbtScalarTag | undefined> {
    const rawValue = await promptValue<string>(prompt, {
        type: "text",
        name: "value",
        message: `Initial value for ${fieldPathLabel} (${tagType})`,
        initial: defaultScalarInitialValue(tagType),
        validate: (value: string) => {
            try {
                parseScalarInputForType(tagType, value);
                return true;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        },
    });
    if (typeof rawValue === "undefined") {
        return undefined;
    }
    const value = parseScalarInputForType(tagType, rawValue);
    return createScalarTag(tagType, value);
}

async function addFieldToCompound(
    prompt: InteractivePrompt,
    compound: prismarineNbt.Compound,
    pathSegments: string[],
): Promise<{ fieldPathLabel: string; tag: NbtTag } | undefined> {
    while (true) {
        const tagType = await promptForAddableTagType(prompt, pathSegments);
        if (!tagType) {
            return undefined;
        }

        while (true) {
            const fieldName = await promptForNewFieldName(
                prompt,
                compound,
                pathSegments,
                tagType,
            );
            if (!fieldName) {
                break;
            }

            const fieldPathLabel = formatFieldPathLabel(
                pathSegments,
                fieldName,
            );
            const tag: NbtTag | undefined =
                tagType === "compound"
                    ? {
                          type: "compound",
                          value: {},
                      }
                    : await promptForNewScalarTag(
                          prompt,
                          fieldPathLabel,
                          tagType,
                      );
            if (!tag) {
                continue;
            }

            compound.value[fieldName] = tag;
            return {
                fieldPathLabel,
                tag,
            };
        }
    }
}

async function removeFieldFromCompound(
    prompt: InteractivePrompt,
    compound: prismarineNbt.Compound,
    pathSegments: string[],
): Promise<{ fieldPathLabel: string; removedTag: NbtTag } | undefined> {
    while (true) {
        const entries = listDefinedCompoundEntries(compound);
        if (entries.length === 0) {
            return undefined;
        }

        const currentPathLabel = formatPathLabel(pathSegments);
        const choices: LevelDatFieldChoiceOption[] = [
            createSearchableChoice({
                title: "[..] Back to compound",
                value: BACK_CHOICE_VALUE,
                searchText: ["..", "back", "cancel", "return", "compound"],
            }),
            ...entries.map(([fieldName, tag]) =>
                createSearchableChoice({
                    title: formatTagChoiceTitle(fieldName, tag),
                    value: fieldName,
                    searchText: [fieldName, tag.type, formatTagPreview(tag)],
                }),
            ),
        ];
        const selectedFieldName = await promptAutocompleteValue<string>(
            prompt,
            {
                name: "fieldName",
                message: `Remove which field from ${currentPathLabel}?`,
                choices,
            },
        );
        if (typeof selectedFieldName === "undefined") {
            return undefined;
        }

        const fieldName = normalizeFieldName(selectedFieldName);
        if (!fieldName || fieldName === BACK_CHOICE_VALUE) {
            return undefined;
        }

        const removedTag = compound.value[fieldName];
        if (!removedTag) {
            continue;
        }

        const fieldPathLabel = formatFieldPathLabel(pathSegments, fieldName);
        const confirmed = await promptValue<boolean>(prompt, {
            type: "confirm",
            name: "remove",
            message: `Remove ${fieldPathLabel} (${removedTag.type})?`,
            initial: false,
        });
        if (confirmed !== true) {
            continue;
        }

        delete compound.value[fieldName];
        return {
            fieldPathLabel,
            removedTag,
        };
    }
}

export async function editBedrockLevelDatInteractively(input: {
    worldName: string;
    levelDat: {
        data: prismarineNbt.NBT;
    };
    prompt: InteractivePrompt;
}): Promise<LevelDatInteractiveEditResult> {
    const originalData = structuredClone(input.levelDat.data);
    const pathSegments: string[] = [];
    const changedPaths = new Set<string>();

    while (true) {
        const dirty = hasLevelDatChanged(originalData, input.levelDat.data);
        const currentCompound = resolveCompoundAtPath(
            input.levelDat.data,
            pathSegments,
        );
        const currentPathLabel = formatPathLabel(pathSegments);
        const choices = createEditorChoices(
            currentCompound,
            pathSegments,
            dirty,
            changedPaths.size,
        );

        const choice = await promptAutocompleteValue<LevelDatEditorChoice>(
            input.prompt,
            {
                name: "choice",
                message: `Edit level.dat for "${input.worldName}" at ${currentPathLabel}`,
                choices,
            },
        );
        if (typeof choice === "undefined") {
            if (pathSegments.length > 0) {
                pathSegments.pop();
                continue;
            }

            if (dirty && !(await confirmDiscardChanges(input.prompt))) {
                continue;
            }

            return createEditResult({
                saved: false,
                changed: dirty,
                changedPaths,
            });
        }

        if (choice.kind === "save") {
            return createEditResult({
                saved: true,
                changed: hasLevelDatChanged(originalData, input.levelDat.data),
                changedPaths,
            });
        }

        if (choice.kind === "discard") {
            if (dirty && !(await confirmDiscardChanges(input.prompt))) {
                continue;
            }
            return createEditResult({
                saved: false,
                changed: dirty,
                changedPaths,
            });
        }

        if (choice.kind === "add") {
            const added = await addFieldToCompound(
                input.prompt,
                currentCompound,
                pathSegments,
            );
            if (!added) {
                continue;
            }

            changedPaths.add(added.fieldPathLabel);
            console.log(
                `[world] Added ${added.fieldPathLabel} (${added.tag.type}).`,
            );
            continue;
        }

        if (choice.kind === "remove") {
            const removed = await removeFieldFromCompound(
                input.prompt,
                currentCompound,
                pathSegments,
            );
            if (!removed) {
                continue;
            }

            changedPaths.add(removed.fieldPathLabel);
            console.log(`[world] Removed ${removed.fieldPathLabel}.`);
            continue;
        }

        if (choice.kind === "up") {
            pathSegments.pop();
            continue;
        }

        const tag = currentCompound.value[choice.fieldName];
        if (!tag) {
            continue;
        }

        if (isCompoundTag(tag)) {
            pathSegments.push(choice.fieldName);
            continue;
        }

        const fieldPathLabel = formatFieldPathLabel(
            pathSegments,
            choice.fieldName,
        );
        if (!isScalarTag(tag)) {
            console.log(
                `[world] ${fieldPathLabel} is a ${tag.type} tag. Editing list and array tags is not available yet.`,
            );
            continue;
        }

        const updated = await editScalarTagValue(
            input.prompt,
            fieldPathLabel,
            tag,
        );
        if (!updated) {
            continue;
        }

        changedPaths.add(fieldPathLabel);
        console.log(
            `[world] Updated ${fieldPathLabel} -> ${formatScalarPreview(tag)}.`,
        );
    }
}
