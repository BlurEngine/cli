import type { DebugLogger } from "./debug.js";
import type { BdsPlatform, MinecraftChannel } from "./types.js";

const BEDROCK_DOWNLOAD_LINKS_URL =
    "https://net-secondary.web.minecraft-services.net/api/v1.0/download/links";

export type FetchImplementation = typeof fetch;

type DownloadLink = {
    downloadType?: string;
    downloadUrl?: string;
};

type DownloadLinksResponse = {
    result?: {
        links?: DownloadLink[];
    };
};

export type BedrockDownloadLinks = {
    stableWindowsUrl: string;
    stableLinuxUrl: string;
    previewWindowsUrl?: string;
    previewLinuxUrl?: string;
    latestStableVersion: string;
    latestPreviewVersion?: string;
};

function requireDownloadUrl(
    links: DownloadLink[],
    downloadType: string,
): string {
    const value =
        links
            .find((link) => link.downloadType === downloadType)
            ?.downloadUrl?.trim() ?? "";
    if (!value) {
        throw new Error(
            `Minecraft download service did not return ${downloadType}.`,
        );
    }
    return value;
}

function extractBedrockVersion(downloadUrl: string): string | undefined {
    const match = /\/bedrock-server-([0-9.]+)\.zip$/i.exec(downloadUrl.trim());
    return match?.[1];
}

export function compareDotVersions(left: string, right: string): number {
    const leftParts = left.split(".").map((part) => Number(part.trim()));
    const rightParts = right.split(".").map((part) => Number(part.trim()));
    const length = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < length; index += 1) {
        const leftPart = leftParts[index] ?? 0;
        const rightPart = rightParts[index] ?? 0;
        if (leftPart > rightPart) return 1;
        if (leftPart < rightPart) return -1;
    }

    return 0;
}

export function resolveLatestBedrockVersionForChannel(
    links: BedrockDownloadLinks,
    channel: MinecraftChannel,
): string {
    if (channel === "preview") {
        if (!links.latestPreviewVersion) {
            throw new Error(
                "Minecraft download service did not return a latest preview Bedrock version.",
            );
        }
        return links.latestPreviewVersion;
    }
    return links.latestStableVersion;
}

export function resolveDirectBedrockDownloadUrl(
    channel: MinecraftChannel,
    platform: BdsPlatform,
    version: string,
): string {
    const previewSuffix = channel === "preview" ? "-preview" : "";
    return `https://www.minecraft.net/bedrockdedicatedserver/bin-${platform}${previewSuffix}/bedrock-server-${version}.zip`;
}

export async function fetchBedrockDownloadLinks(
    debug?: DebugLogger,
    fetchImplementation: FetchImplementation = fetch,
): Promise<BedrockDownloadLinks> {
    debug?.log("bedrock-downloads", "requesting Bedrock download links", {
        url: BEDROCK_DOWNLOAD_LINKS_URL,
    });

    const response = await fetchImplementation(BEDROCK_DOWNLOAD_LINKS_URL, {
        headers: {
            accept: "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(
            `Failed to read Bedrock download links from ${BEDROCK_DOWNLOAD_LINKS_URL} (${response.status}).`,
        );
    }

    const payload = (await response.json()) as DownloadLinksResponse;
    const links = Array.isArray(payload.result?.links)
        ? payload.result.links
        : [];
    const stableWindowsUrl = requireDownloadUrl(links, "serverBedrockWindows");
    const stableLinuxUrl = requireDownloadUrl(links, "serverBedrockLinux");
    const latestStableVersion = extractBedrockVersion(stableWindowsUrl);
    const latestLinuxVersion = extractBedrockVersion(stableLinuxUrl);

    if (!latestStableVersion || !latestLinuxVersion) {
        throw new Error(
            "Minecraft download service returned an unexpected Bedrock download URL.",
        );
    }

    if (latestStableVersion !== latestLinuxVersion) {
        throw new Error(
            `Minecraft download service returned mismatched Bedrock versions (${latestStableVersion} for Windows, ${latestLinuxVersion} for Linux).`,
        );
    }

    const previewWindowsUrl = links
        .find((link) => link.downloadType === "serverBedrockPreviewWindows")
        ?.downloadUrl?.trim();
    const previewLinuxUrl = links
        .find((link) => link.downloadType === "serverBedrockPreviewLinux")
        ?.downloadUrl?.trim();

    const result: BedrockDownloadLinks = {
        stableWindowsUrl,
        stableLinuxUrl,
        latestStableVersion,
    };

    if (previewWindowsUrl) {
        result.previewWindowsUrl = previewWindowsUrl;
    }

    if (previewLinuxUrl) {
        result.previewLinuxUrl = previewLinuxUrl;
    }

    if (previewWindowsUrl || previewLinuxUrl) {
        if (!previewWindowsUrl || !previewLinuxUrl) {
            throw new Error(
                "Minecraft download service returned an incomplete Bedrock preview download set.",
            );
        }

        const latestPreviewVersion = extractBedrockVersion(previewWindowsUrl);
        const latestPreviewLinuxVersion =
            extractBedrockVersion(previewLinuxUrl);

        if (!latestPreviewVersion || !latestPreviewLinuxVersion) {
            throw new Error(
                "Minecraft download service returned an unexpected Bedrock preview download URL.",
            );
        }

        if (latestPreviewVersion !== latestPreviewLinuxVersion) {
            throw new Error(
                `Minecraft download service returned mismatched Bedrock preview versions (${latestPreviewVersion} for Windows, ${latestPreviewLinuxVersion} for Linux).`,
            );
        }

        result.latestPreviewVersion = latestPreviewVersion;
    }

    debug?.log("bedrock-downloads", "resolved Bedrock download links", result);
    return result;
}
