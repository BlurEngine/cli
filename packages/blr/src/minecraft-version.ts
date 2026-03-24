import {
    compareDotVersions,
    fetchWithTimeout,
    type FetchImplementation,
    fetchBedrockDownloadLinks,
    resolveDirectBedrockDownloadUrl,
    resolveLatestBedrockVersionForChannel,
} from "./bedrock-downloads.js";
import type { DebugLogger } from "./debug.js";
import type { BdsPlatform, MinecraftChannel } from "./types.js";

const BEDROCK_ARTIFACT_PROBE_TIMEOUT_MS = 10_000;

export type MinecraftVersionStatus = {
    channel: MinecraftChannel;
    configuredVersion: string;
    latestVersion: string;
    outdated: boolean;
    artifactAvailable: boolean;
    oppositeChannel: MinecraftChannel;
    oppositeChannelArtifactAvailable: boolean;
    looksLikeChannelMismatch: boolean;
};

export type MinecraftArtifactStatus = {
    artifactAvailable: boolean;
    oppositeChannel: MinecraftChannel;
    oppositeChannelArtifactAvailable: boolean;
    looksLikeChannelMismatch: boolean;
};

function resolveOppositeChannel(channel: MinecraftChannel): MinecraftChannel {
    return channel === "preview" ? "stable" : "preview";
}

export async function probeBedrockArtifactAvailability(
    channel: MinecraftChannel,
    platform: BdsPlatform,
    version: string,
    debug?: DebugLogger,
    fetchImplementation: FetchImplementation = fetch,
): Promise<boolean> {
    const url = resolveDirectBedrockDownloadUrl(channel, platform, version);
    debug?.log("bedrock-downloads", "probing Bedrock artifact", {
        channel,
        platform,
        version,
        url,
    });

    let response = await fetchWithTimeout(
        url,
        {
            method: "HEAD",
            redirect: "follow",
        },
        BEDROCK_ARTIFACT_PROBE_TIMEOUT_MS,
        fetchImplementation,
    );

    if (!response.ok && (response.status === 403 || response.status === 405)) {
        response = await fetchWithTimeout(
            url,
            {
                method: "GET",
                redirect: "follow",
                headers: {
                    range: "bytes=0-0",
                },
            },
            BEDROCK_ARTIFACT_PROBE_TIMEOUT_MS,
            fetchImplementation,
        );
    }

    return response.ok;
}

export async function resolveMinecraftArtifactStatus(
    channel: MinecraftChannel,
    configuredVersion: string,
    debug?: DebugLogger,
    fetchImplementation: FetchImplementation = fetch,
): Promise<MinecraftArtifactStatus> {
    const artifactAvailable = await probeBedrockArtifactAvailability(
        channel,
        "win",
        configuredVersion,
        debug,
        fetchImplementation,
    );
    const oppositeChannel = resolveOppositeChannel(channel);
    const oppositeChannelArtifactAvailable = artifactAvailable
        ? false
        : await probeBedrockArtifactAvailability(
              oppositeChannel,
              "win",
              configuredVersion,
              debug,
              fetchImplementation,
          );

    return {
        artifactAvailable,
        oppositeChannel,
        oppositeChannelArtifactAvailable,
        looksLikeChannelMismatch:
            !artifactAvailable && oppositeChannelArtifactAvailable,
    };
}

export async function resolveMinecraftVersionStatus(
    channel: MinecraftChannel,
    configuredVersion: string,
    debug?: DebugLogger,
    fetchImplementation: FetchImplementation = fetch,
    artifactStatus?: MinecraftArtifactStatus,
): Promise<MinecraftVersionStatus> {
    const resolvedArtifactStatus =
        artifactStatus ??
        (await resolveMinecraftArtifactStatus(
            channel,
            configuredVersion,
            debug,
            fetchImplementation,
        ));
    const downloads = await fetchBedrockDownloadLinks(
        debug,
        fetchImplementation,
    );
    const latestVersion = resolveLatestBedrockVersionForChannel(
        downloads,
        channel,
    );

    return {
        channel,
        configuredVersion,
        latestVersion,
        outdated: compareDotVersions(configuredVersion, latestVersion) < 0,
        ...resolvedArtifactStatus,
    };
}
