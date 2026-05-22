import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

export type LinkServerOptions = {
    host: string;
    port: number;
    dashboardEnabled?: boolean;
    onEvent?: LinkServerEventHandler;
};

export type LinkServerEvent = {
    kind: string;
    data?: unknown;
    meta?: {
        id?: string;
        retention?: LinkServerEventRetention;
        retentionKey?: string;
        source?: string;
        t?: number;
        [key: string]: unknown;
    };
};

type LinkServerEventRetention = "append" | "latest";

export type LinkServerEventHandlerContext = {
    readonly key: string;
    readonly ns: string;
};

export type LinkServerEventHandler = (
    event: LinkServerEvent,
    context: LinkServerEventHandlerContext,
) => void | Promise<void>;

type LinkServerStreamSummary = {
    key: string;
    count: number;
    latestCount?: number;
    latest?: number;
};

type LinkServerRequestSummary = {
    client: string;
    key: string;
    count: number;
    latest: number;
};

type StreamListener = (events: LinkServerEvent[]) => void;

type AppendLinkEventsResult = {
    events: LinkServerEvent[];
    latest: LinkServerEvent[];
};

const LINK_PROTOCOL_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_LATEST_EVENTS = 250;
const MAX_STREAM_EVENTS = 500;
const MAX_REQUEST_SUMMARIES = 100;
const LATEST_TEXT_ROUTE_PATTERN =
    /^\/api\/link\/streams\/([^/]+)\/([^/]+)\/latest\/(.+)\.txt$/u;
const STREAM_ROUTE_PATTERN =
    /^\/api\/link\/streams\/([^/]+)\/([^/]+)\/(events|latest)$/u;
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bebe Link Dashboard</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0e1116;
  --panel: #171c24;
  --panel-strong: #202734;
  --text: #eef2f7;
  --muted: #a7b0be;
  --line: #2a3342;
  --accent: #69d9b4;
  --warn: #f0c36d;
  --danger: #ff8a8a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, input, textarea {
  font: inherit;
}
button {
  border: 1px solid var(--line);
  background: var(--panel-strong);
  color: var(--text);
  border-radius: 6px;
  min-height: 36px;
  padding: 0 12px;
  cursor: pointer;
}
button:hover { border-color: var(--accent); }
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--line);
}
h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
}
main {
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
  gap: 1px;
  min-height: calc(100vh - 77px);
  background: var(--line);
}
section {
  background: var(--bg);
  padding: 20px;
}
h2 {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--muted);
  text-transform: uppercase;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}
.tab {
  min-height: 34px;
}
.tab.active {
  border-color: var(--accent);
  color: var(--accent);
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--warn);
}
.dot.live { background: var(--accent); }
.stream-list {
  display: grid;
  gap: 8px;
}
.stream,
.request {
  width: 100%;
  text-align: left;
  display: grid;
  gap: 4px;
  padding: 10px;
}
.stream.active {
  border-color: var(--accent);
}
.stream-name,
.request-name {
  font-weight: 700;
}
.stream-meta,
.request-meta {
  color: var(--muted);
  font-size: 13px;
}
.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
  gap: 20px;
}
.events {
  display: grid;
  gap: 10px;
}
.event {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  padding: 12px;
}
.event-title {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-weight: 700;
}
.event-meta {
  color: var(--muted);
  font-size: 12px;
  margin-top: 4px;
}
.metrics {
  display: grid;
  gap: 1px;
  overflow: visible;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--line);
}
.metric {
  position: relative;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 82px 96px 112px;
  gap: 10px;
  align-items: center;
  min-height: 38px;
  padding: 7px 10px;
  background: var(--panel);
}
.metric:nth-child(even) {
  background: #141922;
}
.metric:hover,
.metric:focus-within {
  background: var(--panel-strong);
}
.metric-name {
  font-weight: 700;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.metric-labels {
  color: var(--muted);
  font-size: 12px;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.metric-kind {
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.metric-value {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  color: var(--accent);
  font-size: 13px;
  text-align: right;
}
.metric-graph {
  display: flex;
  justify-content: flex-end;
}
.metric-sparkline {
  width: 108px;
  height: 24px;
  color: var(--accent);
  opacity: 0.9;
}
.metric-tooltip {
  position: absolute;
  top: calc(100% - 2px);
  right: 10px;
  z-index: 10;
  width: max-content;
  max-width: min(520px, calc(100vw - 48px));
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #0b0d12;
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  box-shadow: 0 12px 30px rgb(0 0 0 / 35%);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-4px);
  transition: opacity 120ms ease, transform 120ms ease;
}
.metric:hover .metric-tooltip,
.metric:focus-within .metric-tooltip {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}
pre {
  margin: 8px 0 0;
  overflow: auto;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
}
form {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
label {
  display: grid;
  gap: 5px;
  color: var(--muted);
  font-size: 13px;
}
input, textarea {
  width: 100%;
  border: 1px solid var(--line);
  background: #0b0d12;
  color: var(--text);
  border-radius: 6px;
  padding: 9px 10px;
}
textarea {
  min-height: 140px;
  resize: vertical;
}
.message {
  color: var(--muted);
}
.message.error {
  color: var(--danger);
}
@media (max-width: 860px) {
  header, main, .workspace {
    display: block;
  }
  main {
    min-height: 0;
  }
  section {
    border-bottom: 1px solid var(--line);
  }
  .metric {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .metric-labels,
  .metric-graph {
    grid-column: 1 / -1;
  }
  .metric-value {
    text-align: right;
  }
}
</style>
</head>
<body>
<header>
  <h1>Bebe Link Dashboard</h1>
  <div class="status"><span id="status-dot" class="dot"></span><span id="status-text">Connecting</span></div>
</header>
<main>
  <section>
    <h2>Streams</h2>
    <div id="streams" class="stream-list"></div>
    <h2 style="margin-top:20px">Requests</h2>
    <div id="requests" class="stream-list"></div>
  </section>
  <section class="workspace">
    <div>
      <div class="tabs" role="tablist" aria-label="Stream views">
        <button type="button" class="tab active" data-view="events">Events</button>
        <button type="button" class="tab" data-view="latest">Latest</button>
        <button type="button" class="tab" data-view="metrics">Metrics</button>
      </div>
      <h2 id="event-heading">Events</h2>
      <div id="events" class="events"></div>
    </div>
    <form id="post-form">
      <h2>Send Event</h2>
      <label>Namespace<input id="post-ns" value="bridge" autocomplete="off"></label>
      <label>Key<input id="post-key" value="default" autocomplete="off"></label>
      <label>Kind<input id="post-kind" value="project.message" autocomplete="off"></label>
      <label>Data JSON<textarea id="post-data">{"message":"Hello from the dashboard"}</textarea></label>
      <button type="submit">Send</button>
      <div id="post-message" class="message"></div>
    </form>
  </section>
</main>
<script>
const streamsEl = document.getElementById("streams");
const requestsEl = document.getElementById("requests");
const eventsEl = document.getElementById("events");
const headingEl = document.getElementById("event-heading");
const statusDotEl = document.getElementById("status-dot");
const statusTextEl = document.getElementById("status-text");
const formEl = document.getElementById("post-form");
const messageEl = document.getElementById("post-message");
const tabEls = Array.from(document.querySelectorAll("[data-view]"));
const state = {
  selected: { ns: "bds", key: "default" },
  streams: [],
  requests: [],
  view: "events",
  metricHistory: new Map(),
  metricHistoryLimit: 60
};

function splitStreamKey(value) {
  const index = value.indexOf("/");
  if (index === -1) return { ns: value, key: "default" };
  return { ns: value.slice(0, index), key: value.slice(index + 1) };
}

function eventAge(timestamp) {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return seconds + "s ago";
  return Math.round(seconds / 60) + "m ago";
}

function setStatus(live, text) {
  statusDotEl.classList.toggle("live", live);
  statusTextEl.textContent = text;
}

function setView(view) {
  state.view = view;
  for (const tab of tabEls) {
    tab.classList.toggle("active", tab.dataset.view === view);
  }
  void loadCurrentView();
}

function selectedStreamLabel() {
  return state.selected.ns + "/" + state.selected.key;
}

function renderStreams() {
  streamsEl.replaceChildren();
  const streams = state.streams.length > 0 ? state.streams : [{ key: "bds/default", count: 0 }];
  for (const stream of streams) {
    const target = splitStreamKey(stream.key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stream";
    if (state.selected.ns === target.ns && state.selected.key === target.key) {
      button.classList.add("active");
    }
    button.innerHTML = '<span class="stream-name"></span><span class="stream-meta"></span>';
    button.querySelector(".stream-name").textContent = stream.key;
    const latestCount = stream.latestCount ? " - " + String(stream.latestCount) + " latest" : "";
    button.querySelector(".stream-meta").textContent =
      String(stream.count ?? 0) + " events" + latestCount + " - " + eventAge(stream.latest);
    button.addEventListener("click", () => {
      state.selected = target;
      renderStreams();
      void loadCurrentView();
    });
    streamsEl.append(button);
  }
}

function renderRequests() {
  requestsEl.replaceChildren();
  const requests = state.requests.length > 0 ? state.requests : [{ key: "No requests yet", count: 0 }];
  for (const request of requests) {
    const row = document.createElement("div");
    row.className = "request";
    row.innerHTML = '<span class="request-name"></span><span class="request-meta"></span>';
    row.querySelector(".request-name").textContent = request.key;
    row.querySelector(".request-meta").textContent =
      String(request.count ?? 0) + " calls - " + eventAge(request.latest) + " - " + (request.client ?? "unknown");
    requestsEl.append(row);
  }
}

function renderEventPayload(event) {
  const data = event.data;
  if (
    data &&
    typeof data === "object" &&
    typeof data.text === "string" &&
    typeof data.contentType === "string" &&
    data.contentType.startsWith("text/plain")
  ) {
    return data.text;
  }
  return JSON.stringify(data ?? event, null, 2);
}

function renderEvents(events, title, emptyText) {
  headingEl.textContent = title;
  eventsEl.className = "events";
  eventsEl.replaceChildren();
  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "message";
    empty.textContent = emptyText;
    eventsEl.append(empty);
    return;
  }
  for (const event of events.slice().reverse()) {
    const row = document.createElement("article");
    row.className = "event";
    row.innerHTML = '<div class="event-title"><span></span><time></time></div><div class="event-meta"></div><pre></pre>';
    row.querySelector("span").textContent = event.kind;
    const meta = event.meta ?? {};
    row.querySelector("time").textContent = new Date(meta.t).toLocaleTimeString();
    row.querySelector(".event-meta").textContent = (meta.source ?? "unknown") + " - " + (meta.id ?? "no id");
    row.querySelector("pre").textContent = renderEventPayload(event);
    eventsEl.append(row);
  }
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/link/status", {
      headers: { "x-bebe-client": "dashboard" }
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Link status failed");
    state.streams = payload.streams ?? [];
    state.requests = payload.diagnostics?.requests ?? [];
    setStatus(true, "Live");
    renderStreams();
    renderRequests();
  } catch (error) {
    setStatus(false, error instanceof Error ? error.message : String(error));
  }
}

async function loadEvents() {
  const path = "/api/link/streams/" + encodeURIComponent(state.selected.ns) + "/" + encodeURIComponent(state.selected.key) + "/events?since=0";
  const response = await fetch(path, {
    headers: { "x-bebe-client": "dashboard" }
  });
  const payload = await response.json();
  renderEvents(payload.events ?? [], selectedStreamLabel() + " events", "No events yet.");
}

async function loadLatest() {
  const path = "/api/link/streams/" + encodeURIComponent(state.selected.ns) + "/" + encodeURIComponent(state.selected.key) + "/latest?since=0";
  const response = await fetch(path, {
    headers: { "x-bebe-client": "dashboard" }
  });
  const payload = await response.json();
  renderEvents(payload.events ?? [], selectedStreamLabel() + " latest", "No latest values yet.");
}

function parsePrometheusLabels(input) {
  const labels = {};
  if (!input) return labels;
  const parts = [];
  let part = "";
  let quoted = false;
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      part += character;
      escaped = false;
      continue;
    }
    if (character === "\\\\") {
      part += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      part += character;
      continue;
    }
    if (character === "," && !quoted) {
      parts.push(part);
      part = "";
      continue;
    }
    part += character;
  }
  if (part) parts.push(part);
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim().replace(/^"|"$/g, "").replace(/\\\\(["\\\\n])/g, "$1");
    if (key) labels[key] = value;
  }
  return labels;
}

function metricKey(metric) {
  const labels = Object.entries(metric.labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + JSON.stringify(value))
    .join(",");
  return metric.name + "{" + labels + "}";
}

function metadataNameForSample(name, help, types) {
  if (help.has(name) || types.has(name)) return name;
  for (const suffix of ["_bucket", "_sum", "_count"]) {
    if (!name.endsWith(suffix)) continue;
    const base = name.slice(0, -suffix.length);
    if (help.has(base) || types.has(base)) return base;
  }
  return name;
}

function parsePrometheusText(text) {
  const metrics = [];
  const help = new Map();
  const types = new Map();
  for (const line of text.split(/\\r?\\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      const helpMatch = /^#\\s+HELP\\s+(\\w+)\\s+(.+)$/u.exec(trimmed);
      if (helpMatch) {
        help.set(helpMatch[1], helpMatch[2]);
        continue;
      }
      const typeMatch = /^#\\s+TYPE\\s+(\\w+)\\s+(\\w+)$/u.exec(trimmed);
      if (typeMatch) {
        types.set(typeMatch[1], typeMatch[2]);
      }
      continue;
    }
    const match = /^(\\w+)(?:\\{([^}]*)\\})?\\s+(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?|[+-]?Inf|NaN)$/iu.exec(trimmed);
    if (!match) continue;
    const name = match[1];
    const labels = parsePrometheusLabels(match[2] ?? "");
    const metadataName = metadataNameForSample(name, help, types);
    const metric = {
      name,
      labels,
      value: match[3],
      help: help.get(metadataName) ?? "",
      type: types.get(metadataName) ?? "sample"
    };
    metrics.push({
      ...metric,
      key: metricKey(metric)
    });
  }
  return metrics;
}

function labelsToText(labels) {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + value)
    .join(", ");
}

function numericMetricValue(metric) {
  const value = Number(metric.value.replace(/^\\+/u, ""));
  return Number.isFinite(value) ? value : undefined;
}

function metricHistoryKey(metric) {
  return selectedStreamLabel() + "::" + metric.key;
}

function recordMetricHistory(metrics) {
  const now = Date.now();
  for (const metric of metrics) {
    const value = numericMetricValue(metric);
    if (value === undefined) continue;
    const key = metricHistoryKey(metric);
    const points = state.metricHistory.get(key) ?? [];
    const latest = points.at(-1);
    if (!latest || latest.value !== value || now - latest.t > 2500) {
      points.push({ t: now, value });
      while (points.length > state.metricHistoryLimit) points.shift();
      state.metricHistory.set(key, points);
    }
  }
  while (state.metricHistory.size > 1000) {
    const oldestKey = state.metricHistory.keys().next().value;
    if (typeof oldestKey !== "string") return;
    state.metricHistory.delete(oldestKey);
  }
}

function renderSparkline(points) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "metric-sparkline");
  svg.setAttribute("viewBox", "0 0 108 24");
  svg.setAttribute("aria-hidden", "true");
  if (points.length === 0) return svg;
  if (points.length === 1) {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", "54");
    dot.setAttribute("cy", "12");
    dot.setAttribute("r", "2.5");
    dot.setAttribute("fill", "currentColor");
    svg.append(dot);
    return svg;
  }

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  const coordinates = points
    .map((point, index) => {
      const x = points.length === 1 ? 54 : (index / (points.length - 1)) * 104 + 2;
      const y = 21 - ((point.value - min) / range) * 18;
      return x.toFixed(2) + "," + y.toFixed(2);
    })
    .join(" ");
  line.setAttribute("points", coordinates);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.append(line);
  return svg;
}

function metricTooltipText(metric) {
  const labels = labelsToText(metric.labels);
  return [
    metric.help || "No description.",
    "Type: " + metric.type,
    labels ? "Labels: " + labels : "Labels: none",
    "Sample: " + metric.name
  ].join("\\n");
}

function renderMetrics(metrics, rawText) {
  headingEl.textContent = selectedStreamLabel() + " metrics";
  eventsEl.className = "metrics";
  eventsEl.replaceChildren();
  recordMetricHistory(metrics);
  if (metrics.length === 0) {
    const empty = document.createElement("div");
    empty.className = "message";
    empty.textContent = rawText ? "No metric samples found." : "No metrics snapshot yet.";
    eventsEl.append(empty);
    return;
  }
  for (const metric of metrics) {
    const row = document.createElement("article");
    row.className = "metric";
    row.tabIndex = 0;
    row.innerHTML = '<div class="metric-primary"><div class="metric-name"></div><div class="metric-labels"></div></div><div class="metric-kind"></div><div class="metric-value"></div><div class="metric-graph"></div><div class="metric-tooltip"></div>';
    row.querySelector(".metric-name").textContent = metric.name;
    row.querySelector(".metric-labels").textContent = labelsToText(metric.labels);
    row.querySelector(".metric-kind").textContent = metric.type;
    row.querySelector(".metric-value").textContent = metric.value;
    const tooltip = metricTooltipText(metric);
    row.title = tooltip;
    row.querySelector(".metric-tooltip").textContent = tooltip;
    row.querySelector(".metric-graph").append(renderSparkline(state.metricHistory.get(metricHistoryKey(metric)) ?? []));
    eventsEl.append(row);
  }
}

async function loadMetrics() {
  const path = "/api/link/streams/" + encodeURIComponent(state.selected.ns) + "/" + encodeURIComponent(state.selected.key) + "/latest/bebe.metrics.snapshot.txt";
  const response = await fetch(path, {
    headers: { "x-bebe-client": "dashboard" }
  });
  if (response.status === 404) {
    renderMetrics([], "");
    return;
  }
  const text = await response.text();
  if (!response.ok) throw new Error(text || "Metrics request failed");
  renderMetrics(parsePrometheusText(text), text);
}

async function loadCurrentView() {
  if (state.view === "latest") {
    await loadLatest();
    return;
  }
  if (state.view === "metrics") {
    await loadMetrics();
    return;
  }
  await loadEvents();
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  messageEl.classList.remove("error");
  messageEl.textContent = "Sending";
  try {
    const ns = document.getElementById("post-ns").value.trim();
    const key = document.getElementById("post-key").value.trim();
    const kind = document.getElementById("post-kind").value.trim();
    const dataText = document.getElementById("post-data").value.trim();
    const data = dataText.length > 0 ? JSON.parse(dataText) : undefined;
    const response = await fetch("/api/link/streams/" + encodeURIComponent(ns) + "/" + encodeURIComponent(key) + "/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bebe-client": "dashboard" },
      body: JSON.stringify({ events: [{ kind, data, meta: { source: "dashboard" } }] })
    });
    if (!response.ok) throw new Error(await response.text());
    messageEl.textContent = "Sent";
    await refreshStatus();
    if (state.selected.ns === ns && state.selected.key === key) {
      await loadCurrentView();
    }
  } catch (error) {
    messageEl.classList.add("error");
    messageEl.textContent = error instanceof Error ? error.message : String(error);
  }
});

for (const tab of tabEls) {
  tab.addEventListener("click", () => {
    setView(tab.dataset.view || "events");
  });
}

void refreshStatus().then(loadCurrentView);
setInterval(() => {
  void refreshStatus().then(loadCurrentView);
}, 1500);
</script>
</body>
</html>
`;

function toStreamKey(ns: string, key: string): string {
    return `${ns}\u0000${key}`;
}

function decodeSegment(segment: string): string | undefined {
    try {
        const decoded = decodeURIComponent(segment);
        return decoded.length > 0 ? decoded : undefined;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeUuid7Timestamp(bytes: Uint8Array, timestamp: number): void {
    let value = Math.max(0, Math.min(Math.floor(timestamp), 0xffffffffffff));
    for (let index = 5; index >= 0; index -= 1) {
        bytes[index] = value & 0xff;
        value = Math.floor(value / 256);
    }
}

function createUuid7Base64(timestamp: number): string {
    const bytes = randomBytes(16);
    writeUuid7Timestamp(bytes, timestamp);
    bytes[6] = 0x70 | (bytes[6] & 0x0f);
    bytes[8] = 0x80 | (bytes[8] & 0x3f);
    return bytes.toString("base64");
}

function normalizeEventMeta(
    value: unknown,
): NonNullable<LinkServerEvent["meta"]> {
    const meta = isRecord(value) ? value : value === undefined ? {} : { value };
    return {
        ...meta,
        id: typeof meta.id === "string" ? meta.id : undefined,
        retention:
            meta.retention === "latest" || meta.retention === "append"
                ? meta.retention
                : undefined,
        retentionKey:
            typeof meta.retentionKey === "string" &&
            meta.retentionKey.length > 0
                ? meta.retentionKey
                : undefined,
        source: typeof meta.source === "string" ? meta.source : undefined,
        t:
            typeof meta.t === "number" && Number.isFinite(meta.t)
                ? meta.t
                : undefined,
    };
}

function normalizeEventInput(value: unknown): LinkServerEvent | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const kind = value.kind;
    if (typeof kind !== "string" || kind.length === 0) {
        return undefined;
    }

    const event: LinkServerEvent = {
        kind,
        meta: normalizeEventMeta(value.meta),
    };
    if ("data" in value) {
        event.data = value.data;
    }
    return event;
}

function normalizeEventPayload(payload: unknown): LinkServerEvent[] {
    const values = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.events)
          ? payload.events
          : [];
    return values
        .map((value) => normalizeEventInput(value))
        .filter((event): event is LinkServerEvent => Boolean(event));
}

function readRequestBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        let rejected = false;
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            if (rejected) {
                return;
            }

            body += chunk;
            if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
                rejected = true;
                reject(new Error("Request body too large."));
                request.destroy();
            }
        });
        request.on("end", () => {
            if (!rejected) {
                resolve(body);
            }
        });
        request.on("error", reject);
    });
}

function requestUrlBase(request: IncomingMessage): string {
    const host = request.headers.host;
    return `http://${typeof host === "string" && host.length > 0 ? host : "127.0.0.1"}`;
}

function requestClient(request: IncomingMessage): string {
    const taggedClient = request.headers["x-bebe-client"];
    if (typeof taggedClient === "string" && taggedClient.length > 0) {
        return taggedClient;
    }

    const userAgent = request.headers["user-agent"];
    if (typeof userAgent !== "string" || userAgent.length === 0) {
        return "unknown";
    }
    if (userAgent.includes("Mozilla/")) {
        return "browser";
    }
    return userAgent.split(/\s+/u).at(0) ?? "unknown";
}

function latestEventKey(event: LinkServerEvent): string {
    return `${event.kind}\u0000${event.meta?.retentionKey ?? ""}`;
}

function isTextEventData(
    value: unknown,
): value is { contentType: string; text: string } {
    return (
        isRecord(value) &&
        typeof value.contentType === "string" &&
        value.contentType.startsWith("text/") &&
        typeof value.text === "string"
    );
}

class LinkStreamStore {
    readonly #ids = new Map<string, Set<string>>();
    readonly #latest = new Map<string, Map<string, LinkServerEvent>>();
    readonly #listeners = new Map<string, Set<StreamListener>>();
    readonly #streams = new Map<string, LinkServerEvent[]>();
    #lastTimestamp = 0;

    append(
        ns: string,
        key: string,
        inputEvents: LinkServerEvent[],
    ): AppendLinkEventsResult {
        if (inputEvents.length === 0) {
            return { events: [], latest: [] };
        }

        const streamKey = toStreamKey(ns, key);
        const stream = this.#streams.get(streamKey) ?? [];
        const ids = this.#ids.get(streamKey) ?? new Set<string>();
        const events: LinkServerEvent[] = [];
        const latestEvents = new Map<string, LinkServerEvent>();

        for (const event of inputEvents) {
            const meta = event.meta ?? {};
            const retention = meta.retention === "latest" ? "latest" : "append";
            const providedId =
                typeof meta.id === "string" && meta.id.length > 0
                    ? meta.id
                    : undefined;
            if (retention === "append" && providedId && ids.has(providedId)) {
                continue;
            }

            const timestamp = Math.max(
                typeof meta.t === "number" && Number.isFinite(meta.t)
                    ? meta.t
                    : Date.now(),
                this.#lastTimestamp + 1,
            );
            this.#lastTimestamp = timestamp;
            const id = providedId ?? createUuid7Base64(timestamp);
            if (retention === "append" && ids.has(id)) {
                continue;
            }

            const source =
                typeof meta.source === "string" && meta.source.length > 0
                    ? meta.source
                    : ns;
            const stored: LinkServerEvent = {
                ...event,
                meta: {
                    ...meta,
                    id,
                    ...(retention === "latest" ? { retention } : {}),
                    source,
                    t: timestamp,
                },
            };
            if (stored.meta?.retention === "latest") {
                const latest = this.#latest.get(streamKey) ?? new Map();
                const latestKey = latestEventKey(stored);
                if (latest.has(latestKey)) {
                    latest.delete(latestKey);
                }
                latest.set(latestKey, stored);
                while (latest.size > MAX_LATEST_EVENTS) {
                    const oldestKey = latest.keys().next().value;
                    if (typeof oldestKey !== "string") {
                        break;
                    }
                    latest.delete(oldestKey);
                }
                this.#latest.set(streamKey, latest);
                latestEvents.set(latestKey, stored);
                continue;
            }

            ids.add(id);
            events.push(stored);
        }

        stream.push(...events);
        if (stream.length > MAX_STREAM_EVENTS) {
            const recentEvents = stream.slice(-MAX_STREAM_EVENTS);
            this.#streams.set(streamKey, recentEvents);
            this.#ids.set(
                streamKey,
                new Set(
                    recentEvents
                        .map((event) => event.meta?.id)
                        .filter(
                            (id): id is string =>
                                typeof id === "string" && id.length > 0,
                        ),
                ),
            );
        } else {
            this.#streams.set(streamKey, stream);
            this.#ids.set(streamKey, ids);
        }
        for (const listener of this.#listeners.get(streamKey) ?? []) {
            listener(events);
        }
        return {
            events,
            latest: Array.from(latestEvents.values()),
        };
    }

    list(ns: string, key: string, since: number): LinkServerEvent[] {
        const stream = this.#streams.get(toStreamKey(ns, key)) ?? [];
        return stream.filter((event) => (event.meta?.t ?? 0) > since);
    }

    latest(ns: string, key: string, since = 0): LinkServerEvent[] {
        const events = Array.from(
            this.#latest.get(toStreamKey(ns, key))?.values() ?? [],
        );
        return events
            .filter((event) => (event.meta?.t ?? 0) > since)
            .sort((a, b) => (a.meta?.t ?? 0) - (b.meta?.t ?? 0));
    }

    latestText(
        ns: string,
        key: string,
        kind: string,
    ): LinkServerEvent | undefined {
        return this.latest(ns, key).find(
            (event) => event.kind === kind && isTextEventData(event.data),
        );
    }

    subscribe(ns: string, key: string, listener: StreamListener): () => void {
        const streamKey = toStreamKey(ns, key);
        const listeners = this.#listeners.get(streamKey) ?? new Set();
        listeners.add(listener);
        this.#listeners.set(streamKey, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
                this.#listeners.delete(streamKey);
            }
        };
    }

    summaries(): LinkServerStreamSummary[] {
        const streamKeys = new Set([
            ...this.#streams.keys(),
            ...this.#latest.keys(),
        ]);
        return Array.from(streamKeys).map((key) => {
            const events = this.#streams.get(key) ?? [];
            const latestEvents = Array.from(
                this.#latest.get(key)?.values() ?? [],
            );
            const latestTimestamp = Math.max(
                events.at(-1)?.meta?.t ?? 0,
                ...latestEvents.map((event) => event.meta?.t ?? 0),
            );
            return {
                key: key.replace("\u0000", "/"),
                count: events.length,
                latestCount:
                    latestEvents.length > 0 ? latestEvents.length : undefined,
                latest: latestTimestamp > 0 ? latestTimestamp : undefined,
            };
        });
    }
}

class LinkRequestStore {
    readonly #requests = new Map<
        string,
        {
            client: string;
            count: number;
            latest: number;
        }
    >();

    record(method: string | undefined, pathname: string, client: string): void {
        const normalizedMethod =
            typeof method === "string" && method.length > 0
                ? method.toUpperCase()
                : "GET";
        const key = `${client}\u0000${normalizedMethod} ${pathname}`;
        const current = this.#requests.get(key);
        if (current) {
            this.#requests.delete(key);
        }
        this.#requests.set(key, {
            client,
            count: (current?.count ?? 0) + 1,
            latest: Date.now(),
        });
        this.#trim();
    }

    summaries(): LinkServerRequestSummary[] {
        return Array.from(this.#requests.entries())
            .map(([rawKey, request]) => ({
                key: rawKey.split("\u0000").at(1) ?? rawKey,
                client: request.client,
                count: request.count,
                latest: request.latest,
            }))
            .sort((a, b) => b.latest - a.latest || a.key.localeCompare(b.key));
    }

    #trim(): void {
        while (this.#requests.size > MAX_REQUEST_SUMMARIES) {
            const oldestKey = this.#requests.keys().next().value;
            if (typeof oldestKey !== "string") {
                return;
            }
            this.#requests.delete(oldestKey);
        }
    }
}

export class LinkServer {
    readonly #host: string;
    readonly #port: number;
    readonly #dashboardEnabled: boolean;
    readonly #onEvent?: LinkServerEventHandler;
    readonly #requests = new LinkRequestStore();
    readonly #store = new LinkStreamStore();
    #server: Server | undefined;
    #url: string | undefined;

    constructor(options: LinkServerOptions) {
        this.#host = options.host;
        this.#port = options.port;
        this.#dashboardEnabled = options.dashboardEnabled ?? true;
        this.#onEvent = options.onEvent;
    }

    get url(): string {
        if (!this.#url) {
            throw new Error("Link server has not started.");
        }
        return this.#url;
    }

    async start(): Promise<void> {
        if (this.#server) {
            return;
        }

        const server = createServer((request, response) => {
            void this.#handleRequest(request, response);
        });
        this.#server = server;

        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                server.off("error", onError);
                server.off("listening", onListening);
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            const onListening = () => {
                cleanup();
                resolve();
            };

            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(this.#port, this.#host);
        }).catch((error: unknown) => {
            this.#server = undefined;
            throw error;
        });

        const address = server.address() as AddressInfo | null;
        const port = address?.port ?? this.#port;
        this.#url = `http://${this.#host}:${port}`;
    }

    async stop(): Promise<void> {
        const server = this.#server;
        if (!server) {
            return;
        }

        this.#server = undefined;
        this.#url = undefined;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    async #handleRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        try {
            this.#writeCommonHeaders(response);
            if (request.method === "OPTIONS") {
                response.writeHead(204);
                response.end();
                return;
            }

            const url = new URL(request.url ?? "/", requestUrlBase(request));
            this.#requests.record(
                request.method,
                url.pathname,
                requestClient(request),
            );
            if (this.#shouldServeDashboard(request, url)) {
                this.#writeDashboard(response, request.method === "HEAD");
                return;
            }

            if (url.pathname === "/api/link/status") {
                this.#writeJson(response, 200, {
                    ok: true,
                    protocol: {
                        version: LINK_PROTOCOL_VERSION,
                    },
                    diagnostics: {
                        requests: this.#requests.summaries(),
                    },
                    streams: this.#store.summaries(),
                });
                return;
            }

            const latestTextMatch = LATEST_TEXT_ROUTE_PATTERN.exec(
                url.pathname,
            );
            if (latestTextMatch) {
                const ns = decodeSegment(latestTextMatch[1]);
                const key = decodeSegment(latestTextMatch[2]);
                const kind = decodeURIComponent(latestTextMatch[3] ?? "");
                if (!ns || !key || !kind) {
                    this.#writeJson(response, 400, {
                        ok: false,
                        error: "invalid latest text target",
                    });
                    return;
                }

                this.#writeLatestText(response, ns, key, kind);
                return;
            }

            const streamMatch = STREAM_ROUTE_PATTERN.exec(url.pathname);
            if (!streamMatch) {
                this.#writeJson(response, 404, {
                    ok: false,
                    error: "not found",
                });
                return;
            }

            const ns = decodeSegment(streamMatch[1]);
            const key = decodeSegment(streamMatch[2]);
            const route = streamMatch[3] ?? "events";
            if (!ns || !key) {
                this.#writeJson(response, 400, {
                    ok: false,
                    error: "invalid stream target",
                });
                return;
            }

            if (request.method === "GET") {
                await this.#handleStreamGet(
                    request,
                    response,
                    url,
                    ns,
                    key,
                    route,
                );
                return;
            }

            if (request.method === "POST" && route === "events") {
                await this.#handleStreamPost(request, response, ns, key);
                return;
            }

            this.#writeJson(response, 405, {
                ok: false,
                error: "method not allowed",
            });
        } catch (error) {
            if (response.writableEnded) {
                return;
            }

            this.#writeJson(response, 500, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    #shouldServeDashboard(request: IncomingMessage, url: URL): boolean {
        return (
            this.#dashboardEnabled &&
            (request.method === "GET" || request.method === "HEAD") &&
            (url.pathname === "/" || url.pathname === "/dashboard")
        );
    }

    #writeDashboard(response: ServerResponse, headOnly: boolean): void {
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
        });
        response.end(headOnly ? undefined : DASHBOARD_HTML);
    }

    async #handleStreamGet(
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        ns: string,
        key: string,
        route: string,
    ): Promise<void> {
        const since = Number(url.searchParams.get("since") ?? "0") || 0;
        if (route === "latest") {
            this.#writeJson(response, 200, {
                events: this.#store.latest(ns, key, since),
            });
            return;
        }

        const events = this.#store.list(ns, key, since);
        if (request.headers.accept?.includes("text/event-stream")) {
            this.#writeEventStream(response, ns, key, events);
            return;
        }

        this.#writeJson(response, 200, {
            events,
        });
    }

    async #handleStreamPost(
        request: IncomingMessage,
        response: ServerResponse,
        ns: string,
        key: string,
    ): Promise<void> {
        const body = await readRequestBody(request);
        const payload = body.length > 0 ? JSON.parse(body) : [];
        const stored = this.#store.append(
            ns,
            key,
            normalizeEventPayload(payload),
        );
        await this.#dispatchAcceptedEvents(ns, key, [
            ...stored.events,
            ...stored.latest,
        ]);
        this.#writeJson(response, 200, {
            ok: true,
            events: stored.events,
            latest: stored.latest,
        });
    }

    async #dispatchAcceptedEvents(
        ns: string,
        key: string,
        events: readonly LinkServerEvent[],
    ): Promise<void> {
        if (!this.#onEvent || events.length === 0) {
            return;
        }

        const context = { key, ns };
        for (const event of events) {
            await this.#onEvent(event, context);
        }
    }

    #writeCommonHeaders(response: ServerResponse): void {
        response.setHeader("access-control-allow-origin", "*");
        response.setHeader(
            "access-control-allow-methods",
            "GET, POST, OPTIONS",
        );
        response.setHeader(
            "access-control-allow-headers",
            "content-type, authorization, x-bebe-client",
        );
    }

    #writeEventStream(
        response: ServerResponse,
        ns: string,
        key: string,
        initialEvents: LinkServerEvent[],
    ): void {
        response.writeHead(200, {
            "cache-control": "no-cache",
            connection: "keep-alive",
            "content-type": "text/event-stream",
        });

        const writeEvents = (events: LinkServerEvent[]) => {
            for (const event of events) {
                response.write(`event: link\n`);
                response.write(`data: ${JSON.stringify(event)}\n\n`);
            }
        };
        writeEvents(initialEvents);
        const unsubscribe = this.#store.subscribe(ns, key, writeEvents);
        response.on("close", unsubscribe);
    }

    #writeLatestText(
        response: ServerResponse,
        ns: string,
        key: string,
        kind: string,
    ): void {
        const event = this.#store.latestText(ns, key, kind);
        if (!event || !isTextEventData(event.data)) {
            this.#writeJson(response, 404, {
                ok: false,
                error: "latest text event not found",
            });
            return;
        }

        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": event.data.contentType,
        });
        response.end(event.data.text);
    }

    #writeJson(
        response: ServerResponse,
        status: number,
        payload: unknown,
    ): void {
        response.writeHead(status, {
            "content-type": "application/json",
        });
        response.end(JSON.stringify(payload));
    }
}
