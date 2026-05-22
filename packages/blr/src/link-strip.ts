import ts from "typescript";

const BEBE_MODULE = "@blurengine/bebe";
const STRIPPED_EVENT_RESULT = {
    ok: false,
    reason: "unavailable",
};

type LinkImportBindings = {
    links: Set<string>;
    namespaces: Set<string>;
};

type UnsupportedLinkUsage = {
    method?: string;
    line: number;
    column: number;
};

function formatUnsupportedLinkUsageMessage(
    filePath: string,
    usage: UnsupportedLinkUsage,
): string {
    const method = usage.method ? `.${usage.method}` : "";
    return [
        `Cannot strip Bebe Link usage from the offline bundle at ${filePath}:${usage.line}:${usage.column}.`,
        `Keep Link usage as direct Link.* calls, especially Link.event(...), Link.snapshot(...), and Link.on(...), so blr can erase unsupported Link code from offline builds.`,
        `Do not assign, destructure, pass around, or dynamically access Link${method}; blr cannot safely erase that from offline builds.`,
    ].join(" ");
}

function isBebeImport(node: ts.ImportDeclaration): boolean {
    return (
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === BEBE_MODULE
    );
}

function collectLinkImportBindings(
    sourceFile: ts.SourceFile,
): LinkImportBindings {
    const bindings: LinkImportBindings = {
        links: new Set<string>(),
        namespaces: new Set<string>(),
    };

    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !isBebeImport(statement)) {
            continue;
        }

        const namedBindings = statement.importClause?.namedBindings;
        if (!namedBindings) {
            continue;
        }

        if (ts.isNamespaceImport(namedBindings)) {
            bindings.namespaces.add(namedBindings.name.text);
            continue;
        }

        for (const specifier of namedBindings.elements) {
            const importedName =
                specifier.propertyName?.text ?? specifier.name.text;
            if (importedName === "Link") {
                bindings.links.add(specifier.name.text);
            }
        }
    }

    return bindings;
}

function createUnavailableEventResult(): ts.ObjectLiteralExpression {
    return ts.factory.createObjectLiteralExpression(
        [
            ts.factory.createPropertyAssignment("ok", ts.factory.createFalse()),
            ts.factory.createPropertyAssignment(
                "reason",
                ts.factory.createStringLiteral(STRIPPED_EVENT_RESULT.reason),
            ),
        ],
        false,
    );
}

function createUnavailableStatus(): ts.ObjectLiteralExpression {
    return ts.factory.createObjectLiteralExpression(
        [
            ts.factory.createPropertyAssignment(
                "available",
                ts.factory.createFalse(),
            ),
            ts.factory.createPropertyAssignment(
                "capabilities",
                ts.factory.createArrayLiteralExpression([]),
            ),
            ts.factory.createPropertyAssignment(
                "reason",
                ts.factory.createStringLiteral(STRIPPED_EVENT_RESULT.reason),
            ),
        ],
        false,
    );
}

function createNoopUnsubscribe(): ts.ArrowFunction {
    return ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        ts.factory.createBlock([], false),
    );
}

function isImportedLinkExpression(
    expression: ts.Expression,
    bindings: LinkImportBindings,
): boolean {
    if (ts.isIdentifier(expression)) {
        return bindings.links.has(expression.text);
    }

    return (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "Link" &&
        ts.isIdentifier(expression.expression) &&
        bindings.namespaces.has(expression.expression.text)
    );
}

function getLinkMethodName(
    expression: ts.Expression,
    bindings: LinkImportBindings,
): string | undefined {
    if (!ts.isPropertyAccessExpression(expression)) {
        return undefined;
    }

    if (!isImportedLinkExpression(expression.expression, bindings)) {
        return undefined;
    }

    return expression.name.text;
}

function isLinkMethodAccess(
    expression: ts.Expression,
    bindings: LinkImportBindings,
): expression is ts.PropertyAccessExpression {
    return Boolean(getLinkMethodName(expression, bindings));
}

function getLinkCallMethodName(
    expression: ts.Expression,
    bindings: LinkImportBindings,
): string | undefined {
    if (!ts.isCallExpression(expression)) {
        return undefined;
    }

    return getLinkMethodName(expression.expression, bindings);
}

function getRemovableLinkStatementMethodName(
    expression: ts.Expression,
    bindings: LinkImportBindings,
): string | undefined {
    if (ts.isAwaitExpression(expression)) {
        return getRemovableLinkStatementMethodName(
            expression.expression,
            bindings,
        );
    }

    if (ts.isVoidExpression(expression)) {
        return getRemovableLinkStatementMethodName(
            expression.expression,
            bindings,
        );
    }

    const methodName = getLinkCallMethodName(expression, bindings);
    return methodName === "event" ||
        methodName === "snapshot" ||
        methodName === "on"
        ? methodName
        : undefined;
}

function createReplacementForLinkCall(
    methodName: string | undefined,
): ts.Expression | undefined {
    switch (methodName) {
        case "event":
            return createUnavailableEventResult();
        case "snapshot":
            return ts.factory.createVoidExpression(
                ts.factory.createNumericLiteral(0),
            );
        case "on":
            return createNoopUnsubscribe();
        case "isAvailable":
            return ts.factory.createFalse();
        case "capabilities":
            return ts.factory.createArrayLiteralExpression([]);
        case "status":
            return createUnavailableStatus();
        default:
            return undefined;
    }
}

function updateBebeImportDeclaration(
    node: ts.ImportDeclaration,
): ts.ImportDeclaration | undefined {
    if (!isBebeImport(node)) {
        return node;
    }

    const importClause = node.importClause;
    const namedBindings = importClause?.namedBindings;
    if (!importClause || !namedBindings || !ts.isNamedImports(namedBindings)) {
        return node;
    }

    const nextSpecifiers = namedBindings.elements.filter((specifier) => {
        const importedName =
            specifier.propertyName?.text ?? specifier.name.text;
        return importedName !== "Link";
    });

    if (nextSpecifiers.length === namedBindings.elements.length) {
        return node;
    }

    if (nextSpecifiers.length === 0 && !importClause.name) {
        return undefined;
    }

    return ts.factory.updateImportDeclaration(
        node,
        node.modifiers,
        ts.factory.updateImportClause(
            importClause,
            importClause.isTypeOnly,
            importClause.name,
            nextSpecifiers.length > 0
                ? ts.factory.updateNamedImports(namedBindings, nextSpecifiers)
                : undefined,
        ),
        node.moduleSpecifier,
        node.attributes,
    );
}

function createTransformer(
    sourceFile: ts.SourceFile,
    bindings: LinkImportBindings,
    unsupported: UnsupportedLinkUsage[],
): ts.TransformerFactory<ts.SourceFile> {
    return (context) => {
        const recordUnsupportedUsage = (
            node: ts.Node,
            method?: string,
        ): void => {
            const position = sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
            );
            unsupported.push({
                method,
                line: position.line + 1,
                column: position.character + 1,
            });
        };

        const visit: ts.Visitor = (node) => {
            if (ts.isImportDeclaration(node)) {
                return updateBebeImportDeclaration(node);
            }

            if (
                ts.isExpressionStatement(node) &&
                getRemovableLinkStatementMethodName(node.expression, bindings)
            ) {
                return undefined;
            }

            if (ts.isAwaitExpression(node)) {
                const replacement = createReplacementForLinkCall(
                    getLinkCallMethodName(node.expression, bindings),
                );
                if (replacement) {
                    return replacement;
                }
            }

            if (ts.isCallExpression(node)) {
                const replacement = createReplacementForLinkCall(
                    getLinkCallMethodName(node, bindings),
                );
                if (replacement) {
                    return replacement;
                }
            }

            if (
                ts.isPropertyAccessExpression(node) &&
                isLinkMethodAccess(node, bindings)
            ) {
                recordUnsupportedUsage(node, node.name.text);
                return node;
            }

            if (
                ts.isExpression(node) &&
                isImportedLinkExpression(node, bindings)
            ) {
                recordUnsupportedUsage(node);
                return node;
            }

            return ts.visitEachChild(node, visit, context);
        };

        return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
    };
}

function getScriptKind(filePath: string): ts.ScriptKind {
    if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) {
        return ts.ScriptKind.TSX;
    }
    if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
        return ts.ScriptKind.JS;
    }
    if (filePath.endsWith(".cjs")) {
        return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
}

export function stripOfflineBebeLink(
    sourceText: string,
    filePath: string,
): string {
    const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(filePath),
    );
    const bindings = collectLinkImportBindings(sourceFile);
    if (bindings.links.size === 0 && bindings.namespaces.size === 0) {
        return sourceText;
    }

    const unsupported: UnsupportedLinkUsage[] = [];
    const result = ts.transform(sourceFile, [
        createTransformer(sourceFile, bindings, unsupported),
    ]);
    try {
        const transformed = result.transformed[0];
        const firstUnsupportedUsage = unsupported[0];
        if (firstUnsupportedUsage) {
            throw new Error(
                formatUnsupportedLinkUsageMessage(
                    filePath,
                    firstUnsupportedUsage,
                ),
            );
        }
        return ts.createPrinter().printFile(transformed);
    } finally {
        result.dispose();
    }
}
