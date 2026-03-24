import assert from "node:assert/strict";
import test from "node:test";
import { resolveDirectBedrockDownloadUrl } from "../src/bedrock-downloads.js";
import {
    resolveMinecraftArtifactStatus,
    resolveMinecraftVersionStatus,
} from "../src/minecraft-version.js";
import { createEmptyResponse, createJsonResponse } from "./helpers.js";

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

test("resolveMinecraftVersionStatus reports an outdated stable target when a newer stable version exists", async (t) => {
    const fetchImplementation = createMockFetch({
        [`GET ${DOWNLOAD_LINKS_URL}`]: createJsonResponse(
            createDownloadLinksPayload(),
        ),
        [`HEAD ${resolveDirectBedrockDownloadUrl("stable", "win", "1.26.0.2")}`]:
            createEmptyResponse(200),
    });

    const status = await resolveMinecraftVersionStatus(
        "stable",
        "1.26.0.2",
        undefined,
        fetchImplementation,
    );
    assert.equal(status.latestVersion, "1.26.3.1");
    assert.equal(status.outdated, true);
    assert.equal(status.artifactAvailable, true);
    assert.equal(status.looksLikeChannelMismatch, false);
});

test("resolveMinecraftVersionStatus detects when a configured version belongs to the opposite channel", async () => {
    const fetchImplementation = createMockFetch({
        [`GET ${DOWNLOAD_LINKS_URL}`]: createJsonResponse(
            createDownloadLinksPayload(),
        ),
        [`HEAD ${resolveDirectBedrockDownloadUrl("stable", "win", "1.26.20.20")}`]:
            createEmptyResponse(404),
        [`HEAD ${resolveDirectBedrockDownloadUrl("preview", "win", "1.26.20.20")}`]:
            createEmptyResponse(200),
    });

    const status = await resolveMinecraftVersionStatus(
        "stable",
        "1.26.20.20",
        undefined,
        fetchImplementation,
    );
    assert.equal(status.latestVersion, "1.26.3.1");
    assert.equal(status.artifactAvailable, false);
    assert.equal(status.looksLikeChannelMismatch, true);
    assert.equal(status.oppositeChannelArtifactAvailable, true);
});

test("resolveMinecraftArtifactStatus probes artifact availability before any latest-version lookup", async () => {
    const fetchImplementation = createMockFetch({
        [`HEAD ${resolveDirectBedrockDownloadUrl("stable", "win", "1.26.20.20")}`]:
            createEmptyResponse(404),
        [`HEAD ${resolveDirectBedrockDownloadUrl("preview", "win", "1.26.20.20")}`]:
            createEmptyResponse(200),
    });

    const status = await resolveMinecraftArtifactStatus(
        "stable",
        "1.26.20.20",
        undefined,
        fetchImplementation,
    );

    assert.equal(status.artifactAvailable, false);
    assert.equal(status.looksLikeChannelMismatch, true);
    assert.equal(status.oppositeChannel, "preview");
    assert.equal(status.oppositeChannelArtifactAvailable, true);
});

test("resolveMinecraftVersionStatus reuses provided artifact status without reprobeing the artifact URL", async () => {
    const fetchImplementation = createMockFetch({
        [`GET ${DOWNLOAD_LINKS_URL}`]: createJsonResponse(
            createDownloadLinksPayload(),
        ),
    });

    const status = await resolveMinecraftVersionStatus(
        "stable",
        "1.26.0.2",
        undefined,
        fetchImplementation,
        {
            artifactAvailable: false,
            oppositeChannel: "preview",
            oppositeChannelArtifactAvailable: true,
            looksLikeChannelMismatch: true,
        },
    );

    assert.equal(status.latestVersion, "1.26.3.1");
    assert.equal(status.outdated, true);
    assert.equal(status.artifactAvailable, false);
    assert.equal(status.looksLikeChannelMismatch, true);
    assert.equal(status.oppositeChannel, "preview");
    assert.equal(status.oppositeChannelArtifactAvailable, true);
});
