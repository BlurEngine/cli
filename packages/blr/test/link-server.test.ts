import assert from "node:assert/strict";
import test from "node:test";
import { LinkServer } from "../src/link-server.js";

function decodeUuid7Base64Id(id: string): Uint8Array {
    return new Uint8Array(Buffer.from(id, "base64"));
}

function readUuid7Timestamp(bytes: Uint8Array): number {
    let timestamp = 0n;
    for (let index = 0; index < 6; index += 1) {
        timestamp = (timestamp << 8n) | BigInt(bytes[index]);
    }
    return Number(timestamp);
}

function assertUuid7Base64Id(id: unknown, timestamp: number): void {
    assert.equal(typeof id, "string");
    const value = id as string;
    assert.match(value, /^[A-Za-z0-9+/]{22}==$/u);
    const bytes = decodeUuid7Base64Id(value);
    assert.equal(bytes.length, 16);
    assert.equal(bytes[6] & 0xf0, 0x70);
    assert.equal(bytes[8] & 0xc0, 0x80);
    assert.equal(readUuid7Timestamp(bytes), timestamp);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
    assert.equal(response.ok, true);
    return (await response.json()) as T;
}

test("LinkServer stores and reads stream events by timestamp", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    const postResponse = await fetch(
        `${server.url}/api/link/streams/bds/default/events`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify([
                {
                    kind: "WorldState",
                    data: {
                        players: 1,
                    },
                },
            ]),
        },
    );
    const posted = await readJsonResponse<{
        events: Array<{
            kind: string;
            meta: { id: string; source: string; t: number };
        }>;
    }>(postResponse);

    assert.equal(posted.events.length, 1);
    assert.equal(typeof posted.events[0].meta.id, "string");
    assert.equal(posted.events[0].kind, "WorldState");
    assert.equal(posted.events[0].meta.source, "bds");
    assert.equal(typeof posted.events[0].meta.t, "number");
    assertUuid7Base64Id(posted.events[0].meta.id, posted.events[0].meta.t);

    const firstRead = await readJsonResponse<{
        events: Array<{
            kind: string;
            meta: { id: string; source: string; t: number };
        }>;
    }>(
        await fetch(
            `${server.url}/api/link/streams/bds/default/events?since=0`,
        ),
    );
    assert.equal(firstRead.events.length, 1);

    const secondRead = await readJsonResponse<{ events: unknown[] }>(
        await fetch(
            `${server.url}/api/link/streams/bds/default/events?since=${posted.events[0].meta.t}`,
        ),
    );
    assert.equal(secondRead.events.length, 0);
});

test("LinkServer accepts dashboard-to-BDS inbound events on another stream", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    const postResponse = await fetch(
        `${server.url}/api/link/streams/bridge/default/events`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                events: [
                    {
                        kind: "project.message",
                        data: {
                            message: "Hello from the dashboard",
                        },
                    },
                ],
            }),
        },
    );
    await readJsonResponse(postResponse);

    const inbound = await readJsonResponse<{
        events: Array<{
            kind: string;
            data?: { message?: string };
            meta: { id: string; source: string; t: number };
        }>;
    }>(
        await fetch(
            `${server.url}/api/link/streams/bridge/default/events?since=0`,
        ),
    );
    assert.deepEqual(inbound.events, [
        {
            kind: "project.message",
            data: {
                message: "Hello from the dashboard",
            },
            meta: {
                id: inbound.events[0].meta.id,
                source: "bridge",
                t: inbound.events[0].meta.t,
            },
        },
    ]);
});

test("LinkServer dispatches accepted stream events to server handlers", async (t) => {
    const handled: Array<{
        key: string;
        kind: string;
        ns: string;
        source?: string;
    }> = [];
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
        onEvent(event, context) {
            handled.push({
                key: context.key,
                kind: event.kind,
                ns: context.ns,
                source: event.meta?.source,
            });
        },
    });
    await server.start();
    t.after(() => server.stop());

    await readJsonResponse(
        await fetch(`${server.url}/api/link/streams/bds/default/events`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                events: [
                    {
                        kind: "project.message",
                        data: {
                            text: "hello from the stream",
                        },
                    },
                ],
            }),
        }),
    );

    assert.deepEqual(handled, [
        {
            key: "default",
            kind: "project.message",
            ns: "bds",
            source: "bds",
        },
    ]);
});

test("LinkServer stores a stable event envelope and ignores duplicate ids per stream", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    const postResponse = await fetch(
        `${server.url}/api/link/streams/bds/default/events`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                events: [
                    {
                        kind: "WorldState",
                        data: { players: 1 },
                        meta: {
                            id: "event-1",
                            source: "bds",
                            t: 100,
                        },
                    },
                    {
                        kind: "WorldState",
                        data: { players: 2 },
                        meta: {
                            id: "event-1",
                            source: "bds",
                            t: 101,
                        },
                    },
                ],
            }),
        },
    );
    const posted = await readJsonResponse<{
        events: Array<{
            kind: string;
            data?: { players?: number };
            meta: { id: string; source: string; t: number };
        }>;
    }>(postResponse);

    assert.deepEqual(posted.events, [
        {
            kind: "WorldState",
            data: { players: 1 },
            meta: {
                id: "event-1",
                source: "bds",
                t: 100,
            },
        },
    ]);

    const stored = await readJsonResponse<{
        events: Array<{ meta: { id: string } }>;
    }>(
        await fetch(
            `${server.url}/api/link/streams/bds/default/events?since=0`,
        ),
    );
    assert.deepEqual(
        stored.events.map((event) => event.meta.id),
        ["event-1"],
    );
});

test("LinkServer keeps latest-retained events out of the default event stream", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    const postResponse = await fetch(
        `${server.url}/api/link/streams/bds/default/events`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                events: [
                    {
                        kind: "world.debug",
                        data: { players: 1 },
                        meta: {
                            id: "latest-1",
                            retention: "latest",
                            retentionKey: "overworld",
                            t: 100,
                        },
                    },
                    {
                        kind: "world.debug",
                        data: { players: 2 },
                        meta: {
                            id: "latest-2",
                            retention: "latest",
                            retentionKey: "overworld",
                            t: 101,
                        },
                    },
                    {
                        kind: "quest.started",
                        data: { id: "intro" },
                        meta: {
                            id: "event-1",
                            t: 102,
                        },
                    },
                ],
            }),
        },
    );
    const posted = await readJsonResponse<{
        events: Array<{ kind: string }>;
        latest: Array<{ kind: string; data?: { players?: number } }>;
    }>(postResponse);

    assert.deepEqual(
        posted.events.map((event) => event.kind),
        ["quest.started"],
    );
    assert.deepEqual(posted.latest, [
        {
            kind: "world.debug",
            data: { players: 2 },
            meta: {
                id: "latest-2",
                retention: "latest",
                retentionKey: "overworld",
                source: "bds",
                t: 101,
            },
        },
    ]);

    const stream = await readJsonResponse<{
        events: Array<{ kind: string }>;
    }>(
        await fetch(
            `${server.url}/api/link/streams/bds/default/events?since=0`,
        ),
    );
    assert.deepEqual(
        stream.events.map((event) => event.kind),
        ["quest.started"],
    );

    const latest = await readJsonResponse<{
        events: Array<{ kind: string; data?: { players?: number } }>;
    }>(await fetch(`${server.url}/api/link/streams/bds/default/latest`));
    assert.deepEqual(latest.events, [
        {
            kind: "world.debug",
            data: { players: 2 },
            meta: {
                id: "latest-2",
                retention: "latest",
                retentionKey: "overworld",
                source: "bds",
                t: 101,
            },
        },
    ]);
});

test("LinkServer serves latest-retained text event data as plain text", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    await readJsonResponse(
        await fetch(`${server.url}/api/link/streams/bds/default/events`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                events: [
                    {
                        kind: "bebe.metrics.snapshot",
                        data: {
                            contentType:
                                "text/plain; version=0.0.4; charset=utf-8",
                            text: "# TYPE bebe_link_queue_size gauge\nbebe_link_queue_size 1\n",
                        },
                        meta: {
                            id: "metrics-1",
                            retention: "latest",
                            retentionKey: "bebe.metrics",
                            t: 100,
                        },
                    },
                ],
            }),
        }),
    );

    const response = await fetch(
        `${server.url}/api/link/streams/bds/default/latest/bebe.metrics.snapshot.txt`,
    );

    assert.equal(response.status, 200);
    assert.equal(
        response.headers.get("content-type"),
        "text/plain; version=0.0.4; charset=utf-8",
    );
    assert.equal(
        await response.text(),
        "# TYPE bebe_link_queue_size gauge\nbebe_link_queue_size 1\n",
    );
});

test("LinkServer keeps only the most recent stream events", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    const events = Array.from({ length: 505 }, (_, index) => ({
        kind: "WorldState",
        data: { index },
        meta: {
            id: `event-${index}`,
            t: index + 1,
        },
    }));

    await readJsonResponse(
        await fetch(`${server.url}/api/link/streams/bds/default/events`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({ events }),
        }),
    );

    const stored = await readJsonResponse<{
        events: Array<{ meta: { id: string }; data?: { index?: number } }>;
    }>(
        await fetch(
            `${server.url}/api/link/streams/bds/default/events?since=0`,
        ),
    );

    assert.equal(stored.events.length, 500);
    assert.equal(stored.events[0].meta.id, "event-5");
    assert.equal(stored.events.at(-1)?.meta.id, "event-504");
});

test("LinkServer reports protocol metadata in status", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    const status = await readJsonResponse<{
        ok: boolean;
        protocol?: { version?: number };
    }>(await fetch(`${server.url}/api/link/status`));

    assert.equal(status.ok, true);
    assert.deepEqual(status.protocol, {
        version: 1,
    });
});

test("LinkServer reports request diagnostics in status", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    await fetch(
        `${server.url}/api/link/streams/bridge/default/events?since=0`,
        {
            headers: {
                "x-bebe-client": "bds",
            },
        },
    );
    await fetch(`${server.url}/api/link/streams/bds/default/events`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bebe-client": "bds",
        },
        body: JSON.stringify({
            events: [{ kind: "bebe.link.ready" }],
        }),
    });

    const status = await readJsonResponse<{
        diagnostics?: {
            requests?: Array<{
                client: string;
                key: string;
                count: number;
                latest: number;
            }>;
        };
    }>(await fetch(`${server.url}/api/link/status`));

    const requests = status.diagnostics?.requests ?? [];
    assert.deepEqual(
        requests
            .map((request) => [request.client, request.key, request.count])
            .sort(
                (a, b) =>
                    String(a[0]).localeCompare(String(b[0])) ||
                    String(a[1]).localeCompare(String(b[1])),
            ),
        [
            ["bds", "GET /api/link/streams/bridge/default/events", 1],
            ["bds", "POST /api/link/streams/bds/default/events", 1],
            ["node", "GET /api/link/status", 1],
        ],
    );
    for (const request of requests) {
        assert.equal(typeof request.latest, "number");
    }
});

test("LinkServer keeps request diagnostics bounded to recent routes", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    for (let index = 0; index < 105; index += 1) {
        await fetch(`${server.url}/missing-${index}`, {
            headers: {
                "x-bebe-client": "dashboard",
            },
        });
    }

    const status = await readJsonResponse<{
        diagnostics?: {
            requests?: Array<{
                key: string;
            }>;
        };
    }>(await fetch(`${server.url}/api/link/status`));

    const keys = (status.diagnostics?.requests ?? []).map(
        (request) => request.key,
    );
    assert.equal(keys.length, 100);
    assert.equal(keys.includes("GET /missing-0"), false);
    assert.equal(keys.includes("GET /missing-5"), false);
    assert.equal(keys.includes("GET /missing-104"), true);
});

test("LinkServer serves the dashboard shell by default", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();
    t.after(() => server.stop());

    const response = await fetch(`${server.url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/u);
    const dashboardHtml = await response.text();
    assert.match(dashboardHtml, /Bebe Link Dashboard/u);
    assert.match(dashboardHtml, /value="bridge"/u);
    assert.match(dashboardHtml, /value="project\.message"/u);
    assert.match(dashboardHtml, /data-view="latest"/u);
    assert.match(dashboardHtml, /data-view="metrics"/u);
    assert.match(dashboardHtml, /function loadLatest/u);
    assert.match(dashboardHtml, /function loadMetrics/u);
    assert.match(dashboardHtml, /function parsePrometheusText/u);
    assert.match(dashboardHtml, /function recordMetricHistory/u);
    assert.match(dashboardHtml, /function renderSparkline/u);
    assert.match(dashboardHtml, /metric\.help/u);
    assert.match(dashboardHtml, /metric\.type/u);
    assert.match(dashboardHtml, /\/latest\/bebe\.metrics\.snapshot\.txt/u);
    assert.match(dashboardHtml, /function renderEventPayload/u);
    assert.match(dashboardHtml, /contentType\.startsWith\("text\/plain"/u);
});

test("LinkServer can disable the dashboard while keeping the API", async (t) => {
    const server = new LinkServer({
        host: "127.0.0.1",
        port: 0,
        dashboardEnabled: false,
    });
    await server.start();
    t.after(() => server.stop());

    assert.equal((await fetch(`${server.url}/`)).status, 404);

    const status = await readJsonResponse<{ ok: boolean }>(
        await fetch(`${server.url}/api/link/status`),
    );
    assert.equal(status.ok, true);
});
