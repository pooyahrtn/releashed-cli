#!/usr/bin/env node
// Serves ONE packaged candidate map to a coding agent over MCP (stdio), read-only.
//
//   node scripts/map-mcp.mjs artifacts/<candidate-dir>
//
// Three tools and nothing else: list_screens, get_screen, list_transitions. This is the W1-7
// benchmark's third condition -- the agent gets the map instead of a browser -- not the
// observe/act/record server option D sketches in docs/ARCHITECTURE-OPTIONS.md.
//
// The map is read from the candidate's own map.html, which already embeds the rendered graph as
// `const model = {...}` (nodes with title/caption/url/imageData, edges with the action label). That
// is the artifact we ship, so serving it verbatim means the agent sees exactly what a human reader
// of the map sees; nothing here re-derives titles or re-reads the trace.
//
// get_screen declares no output schema on purpose: Claude Code renders an MCP image as base64 text
// when a tool declares one (anthropics/claude-code#31208).

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const MARKER = "const model = ";
const MAX_WIDTH = 1280;

export async function loadMap(candidateDir) {
  // map.json is the documented schema (docs/map-schema.md) and is what a candidate carries from
  // now on: it cites screenshots by path instead of embedding them, so nothing has to be parsed
  // out of a rendered page. A candidate packaged before map.json existed still works -- fall
  // through to reading the model the renderer embedded in map.html.
  try {
    const map = JSON.parse(await readFile(join(candidateDir, "map.json"), "utf8"));
    const short = (hash) => String(hash).slice(0, 8);
    return {
      screens: map.screens.map((screen) => ({
        id: short(screen.id),
        title: screen.title,
        url: screen.url ?? null,
        flow: screen.flow ?? null,
        imageData: null,
        screenshotPath: screen.screenshot ? join(candidateDir, screen.screenshot) : null,
      })),
      transitions: map.transitions.map((edge) => ({ from: short(edge.from), to: short(edge.to), action: edge.action })),
      findings: map.findings ?? [],
    };
  } catch {
    /* no map.json (an older candidate), or it does not parse -- read the rendered map instead */
  }
  const html = await readFile(join(candidateDir, "map.html"), "utf8");
  const start = html.indexOf(MARKER);
  if (start < 0) throw new Error(`no rendered map in ${candidateDir}/map.html`);
  const body = html.slice(start + MARKER.length, html.indexOf("\n", start)).replace(/;\s*$/, "");
  const model = JSON.parse(body);
  const id = (hash) => hash.slice(0, 8);
  const screens = model.nodes.map((node) => ({
    id: id(node.id),
    title: node.caption || node.title,
    url: node.url ?? null,
    flow: node.groupTitle ?? null,
    imageData: node.imageData ?? null,
  }));
  const transitions = model.edges.map((edge) => ({
    from: id(edge.from),
    to: id(edge.to),
    action: edge.label,
  }));
  return { screens, transitions, findings: [] };
}

// Search by what a person would say, not by id: every word of the query that appears in a screen's
// caption, URL or flow scores it. Deliberately dumb -- a map is at most a few hundred screens, and
// a stemmer would be a dependency to save a scroll.
export function findScreens({ screens, transitions }, query, limit = 5) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return [];
  return screens
    .map((screen) => {
      const haystack = `${screen.title ?? ""} ${screen.url ?? ""} ${screen.flow ?? ""}`.toLowerCase();
      const score = terms.filter((term) => haystack.includes(term)).length;
      return { screen, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ screen, score }) => ({
      id: screen.id,
      title: screen.title,
      url: screen.url,
      flow: screen.flow,
      matched_terms: score,
      outgoing_transitions: transitions.filter((edge) => edge.from === screen.id).length,
    }));
}

// The local neighbourhood: how you get here, and where you can go from here.
export function screenEdges(map, wanted) {
  const screen = findScreen(map, wanted);
  if (!screen) return null;
  const title = (id) => map.screens.find((item) => item.id === id)?.title ?? id;
  return {
    id: screen.id,
    title: screen.title,
    incoming: map.transitions.filter((edge) => edge.to === screen.id).map((edge) => ({ from: edge.from, from_title: title(edge.from), action: edge.action })),
    outgoing: map.transitions.filter((edge) => edge.from === screen.id).map((edge) => ({ to: edge.to, to_title: title(edge.to), action: edge.action })),
  };
}

export function screenSummaries({ screens, transitions }) {
  return screens.map(({ id, title, url, flow }) => ({
    id,
    title,
    url,
    flow,
    outgoing_transitions: transitions.filter((t) => t.from === id).length,
  }));
}

export function findScreen({ screens }, wanted) {
  const key = String(wanted ?? "").trim();
  return screens.find((screen) => screen.id === key || key.startsWith(screen.id)) ?? null;
}

export function transitionsFrom({ transitions }, wanted) {
  if (wanted == null || wanted === "") return transitions;
  const key = String(wanted).slice(0, 8);
  return transitions.filter((t) => t.from === key);
}

function pngWidth(bytes) {
  return bytes.length > 24 && bytes.readUInt32BE(12) === 0x49484452 ? bytes.readUInt32BE(16) : 0;
}

// ponytail: `sips` is macOS-only, and the only reason it is here is desktop captures at 1440px.
// Anything captured at a phone viewport (390px) never reaches it. If this ever has to run on
// Linux, swap in a real image library; a failed resize serves the full-size picture rather than
// nothing, which costs tokens but never breaks a run.
async function fitWidth(bytes) {
  if (pngWidth(bytes) <= MAX_WIDTH) return bytes;
  const dir = await mkdtemp(join(tmpdir(), "map-mcp-"));
  try {
    await writeFile(join(dir, "in.png"), bytes);
    await promisify(execFile)("sips", [
      "--resampleWidth",
      String(MAX_WIDTH),
      join(dir, "in.png"),
      "--out",
      join(dir, "out.png"),
    ]);
    return await readFile(join(dir, "out.png"));
  } catch {
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TOOLS = [
  {
    name: "list_screens",
    description:
      "List every screen in the map of this product: id, what the screen is, its URL, the flow it belongs to, and how many transitions leave it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_screen",
    description: "Get one screen: what it is, its URL, and a screenshot of it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "screen id from list_screens" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "find_screen",
    description:
      "Find a screen by what a user would call it -- \"the checkout page\", \"where you pick a plan\". Returns the best matching screens, most likely first.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "what you are looking for, in plain words" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "screen_edges",
    description: "The neighbourhood of one screen: every observed way in, and every observed way out, with the action on each.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "screen id from list_screens or find_screen" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_transitions",
    description:
      "List the observed transitions between screens: the action taken and the screen it led to. Pass a screen id for the ones leaving that screen, or nothing for all of them.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "screen id; omit for all transitions" } },
      additionalProperties: false,
    },
  },
];

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

export async function handleCall(map, name, args = {}) {
  if (name === "list_screens") return text(screenSummaries(map));
  if (name === "list_transitions") return text(transitionsFrom(map, args.id));
  if (name === "find_screen") return text(findScreens(map, args.query));
  if (name === "screen_edges") {
    const edges = screenEdges(map, args.id);
    return edges ? text(edges) : { isError: true, content: [{ type: "text", text: `no screen ${args.id}` }] };
  }
  if (name === "get_screen") {
    const screen = findScreen(map, args.id);
    if (!screen) return { isError: true, content: [{ type: "text", text: `no screen ${args.id}` }] };
    const { id, title, url, flow, imageData, screenshotPath } = screen;
    const content = [{ type: "text", text: JSON.stringify({ id, title, url, flow }, null, 2) }];
    if (imageData) {
      const [, mimeType, base64] = /^data:([^;]+);base64,(.*)$/.exec(imageData) ?? [];
      const bytes = await fitWidth(Buffer.from(base64, "base64"));
      content.push({ type: "image", data: bytes.toString("base64"), mimeType });
    } else if (screenshotPath) {
      // A candidate is sealed read-only, so a missing screenshot means somebody edited it: serve
      // the screen's text rather than failing the whole call.
      try {
        const bytes = await fitWidth(await readFile(screenshotPath));
        content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
      } catch {
        content.push({ type: "text", text: "no screenshot retained for this screen" });
      }
    }
    return { content };
  }
  throw new Error(`unknown tool ${name}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const candidateDir = process.argv[2];
  if (!candidateDir) {
    console.error("usage: node scripts/map-mcp.mjs <candidate-dir>");
    process.exit(2);
  }
  const map = await loadMap(candidateDir);
  const server = new Server({ name: "flow-map", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    handleCall(map, request.params.name, request.params.arguments ?? {}),
  );
  await server.connect(new StdioServerTransport());
}
