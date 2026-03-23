import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveDirectBedrockDownloadUrl } from "../src/bedrock-downloads.js";
import { collectSystemDoctorReport, collectSystemInfo } from "../src/system.js";
import {
    createJsonResponse,
    createEmptyResponse,
    createTempDirectory,
    runBuiltCli,
} from "./helpers.js";

const DOWNLOAD_LINKS_URL =
    "https://net-secondary.web.minecraft-services.net/api/v1.0/download/links";

function createDownloadLinksPayload() {
    return {
        result: {
            links: [
                {
                    downloadType: "serverBedrockWindows",
                    downloadUrl:
                        "https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.3.1.zip",
                },
                {
                    downloadType: "serverBedrockLinux",
                    downloadUrl:
                        "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.3.1.zip",
                },
                {
                    downloadType: "serverBedrockPreviewWindows",
                    downloadUrl:
                        "https://www.minecraft.net/bedrockdedicatedserver/bin-win-preview/bedrock-server-1.26.20.20.zip",
                },
                {
                    downloadType: "serverBedrockPreviewLinux",
                    downloadUrl:
                        "https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.20.20.zip",
                },
            ],
        },
    };
}

function createMockFetch(responses: Record<string, Response>): typeof fetch {
    return (async (input, init) => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
        const method = init?.method ?? "GET";
        const key = `${method} ${url}`;
        const response = responses[key];
        if (!response) {
            throw new Error(`Unexpected fetch: ${key}`);
        }
        return response;
    }) as typeof fetch;
}

test("built cli system info reports non-project context safely", async (t) => {
    const workspace = await createTempDirectory(t, "blr-system-");
    const result = runBuiltCli(
        ["system", "info", "--format", "json"],
        workspace,
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const info = JSON.parse(result.stdout) as {
        cli: { packageName: string };
        project: { detected: boolean };
    };

    assert.equal(info.cli.packageName, "@blurengine/cli");
    assert.equal(info.project.detected, false);
});

test("collectSystemDoctorReport reports a healthy scaffold with warnings instead of hard failure", async (t) => {
    const workspace = await createTempDirectory(t, "blr-system-");
    const createResult = runBuiltCli(
        [
            "create",
            "system-project",
            "--namespace",
            "bc_df",
            "--package-manager",
            "npm",
            "--behavior-pack",
            "true",
            "--resource-pack",
            "true",
            "--scripts",
            "false",
            "--yes",
            "--no-install",
        ],
        workspace,
    );
    assert.equal(
        createResult.status,
        0,
        createResult.stderr || createResult.stdout,
    );

    const projectRoot = path.join(workspace, "system-project");
    const fetchImplementation = createMockFetch({
        [`GET ${DOWNLOAD_LINKS_URL}`]: createJsonResponse(
            createDownloadLinksPayload(),
        ),
        [`HEAD ${resolveDirectBedrockDownloadUrl("stable", "win", "1.26.0.2")}`]:
            createEmptyResponse(200),
    });

    const info = await collectSystemInfo(projectRoot);
    assert.equal(info.project.detected, true);
    assert.equal(info.project.valid, true);
    assert.equal(info.project.minecraft?.channel, "stable");

    const report = await collectSystemDoctorReport(projectRoot, {
        fetchImplementation,
    });
    assert.equal(report.ok, true);
    assert.ok(
        report.checks.some(
            (check) =>
                check.id === "project.version" && check.status === "pass",
        ),
    );
    assert.ok(
        report.checks.some(
            (check) => check.id === "world.source" && check.status === "warn",
        ),
    );
});
