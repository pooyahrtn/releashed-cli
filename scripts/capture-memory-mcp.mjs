#!/usr/bin/env node
// Memory MCP: a read-only lookup (find_capture) plus one explicit bounded write
// (remember_flow). The lookup never opens a browser, logs in, or captures.
import { relative } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { findMemory, formatNotes, formatRememberResult, rememberFlow, findNotes, } from "../lib/product-notebook.mjs";
import { sealedFile } from "../lib/capture-selection.mjs";
import { imageReferencedResult, } from "../lib/image-references.mjs";
export const TOOLS = [
    {
        name: "find_capture",
        description: "Find sealed screenshots previously captured for this product. Defaults to seven-day reuse. Returns claimed goal originals plus verified matching_observations (intermediate frames whose own sealed text matches a differently worded query) for inspection; freshness alone is not verified coverage. Stale evidence remains listed as history. This tool never opens a browser, logs in, or starts a capture.",
        inputSchema: {
            type: "object",
            properties: {
                max_age_days: {
                    type: "number",
                    minimum: 0,
                    maximum: 36500,
                    description: "Reuse window; defaults to store policy or seven days. Does not delete historical evidence.",
                },
                fresh: {
                    type: "boolean",
                    description: "Explicit fresh request: all saved evidence is historical; no capture is started by lookup.",
                },
                url: { type: "string", description: "the deployed product URL" },
                goal: {
                    type: "string",
                    description: "the requested destination in plain English",
                },
            },
            required: ["url", "goal"],
            additionalProperties: false,
        },
    },
    {
        name: "remember_flow",
        description: "Remember one evidence-backed flow note for this product. Every claim must cite retained selected originals (run_id plus a lookup-returned screenshot path); the server binds and revalidates each citation. Expected_revision 0 creates, higher revisions update; stale revisions fail. Never captures, logs in, or certifies truth.",
        inputSchema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "the deployed product URL (origin only is used)",
                },
                expected_revision: {
                    type: "integer",
                    minimum: 0,
                    description: "0 to create a new note, otherwise the revision a fresh read returned",
                },
                note: {
                    type: "object",
                    description: "the proposed note (at least one claim or retirement): flow_id, title and author_context are required. author_context is the required evidence-only declaration naming the retained originals inspected (source/owner-derived context is rejected); it is stored verbatim and labelled unverified. claims: [{ id, text, conditions? (default unknown), state? (current|uncertain), references: [{ run_id, screenshot_path }] (1-8, lookup-returned paths only; the server binds digests, event, side, date and url), supersedes? + reason? (a correction needs a new id, the current/uncertain target id to retire, and a reason) }]. retire: [{ id, reason }] retires without new claims. The server owns revision, modified_at, origin and all bound reference fields.",
                    properties: {
                        flow_id: {
                            type: "string",
                            description: "lowercase letters, digits and dashes, 1-64 chars",
                        },
                        title: {
                            type: "string",
                            description: "non-empty, at most 200 chars",
                        },
                        author_context: {
                            type: "string",
                            description: "required evidence-only declaration naming the retained originals inspected, at most 500 chars",
                        },
                        claims: {
                            type: "array",
                            maxItems: 20,
                            items: {
                                type: "object",
                                properties: {
                                    id: {
                                        type: "string",
                                        description: "lowercase letters, digits and dashes, 1-64 chars",
                                    },
                                    text: {
                                        type: "string",
                                        description: "generalized product behavior, at most 2000 chars",
                                    },
                                    conditions: {
                                        type: "string",
                                        description: "nonidentifying conditions, at most 2000 chars; unknown where not established",
                                    },
                                    state: {
                                        type: "string",
                                        enum: ["current", "uncertain"],
                                        description: "current by default; retired only via supersedes/retire",
                                    },
                                    references: {
                                        type: "array",
                                        minItems: 1,
                                        maxItems: 8,
                                        items: {
                                            type: "object",
                                            properties: {
                                                run_id: { type: "string" },
                                                screenshot_path: {
                                                    type: "string",
                                                    description: "a lookup-returned goal_screenshots path",
                                                },
                                            },
                                            required: ["run_id", "screenshot_path"],
                                            additionalProperties: false,
                                        },
                                    },
                                    supersedes: {
                                        type: "string",
                                        description: "the existing current/uncertain claim to retire; needs reason and a new claim id",
                                    },
                                    reason: {
                                        type: "string",
                                        description: "required when superseding, at most 1000 chars",
                                    },
                                },
                                required: ["id", "text", "references"],
                                additionalProperties: false,
                            },
                        },
                        retire: {
                            type: "array",
                            maxItems: 20,
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    reason: { type: "string", description: "at most 1000 chars" },
                                },
                                required: ["id", "reason"],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ["flow_id", "title", "author_context"],
                    additionalProperties: false,
                },
            },
            required: ["url", "expected_revision", "note"],
            additionalProperties: false,
        },
    },
    {
        name: "find_notes",
        description: "Consult this product's remembered flow notes for one explicit customer evidence question. Returns a compact active-claim view under product_notes: retired claims excluded, fully retired notes omitted, no capture candidates, no raw cited urls. Each supporting reference keeps the dated absolute original path plus immutable run, manifest/image digest, event and side bindings for inspection. Similar claims are never merged; integrity only means the bytes still match the seal. Full history remains through find_capture. Read-only: no browser, no sign-in, no model call.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "the deployed product URL" },
                goal: {
                    type: "string",
                    description: "the customer evidence question the notes should answer (required; makes the consultation purpose-specific)",
                },
            },
            required: ["url", "goal"],
            additionalProperties: false,
        },
    },
];
async function attachVerified(candidatePath, screenshotPath, screenshotSha256, content, images) {
    const path = relative(candidatePath, screenshotPath);
    const bytes = await sealedFile(candidatePath, { files: [{ path, sha256: screenshotSha256 }] }, path);
    if (bytes) {
        images.push({
            screenshot_path: screenshotPath,
            screenshot_sha256: screenshotSha256,
        });
        content.push({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: "image/png",
        });
        return true;
    }
    content.push({
        type: "text",
        text: `Image unavailable or changed after lookup: ${screenshotPath}`,
    });
    return false;
}
// Best fresh matching observations globally across returned candidates: most query
// terms first, then newest capture, then path for determinism. At most three.
// Exported for tests; response() is the only production caller.
export function selectObservationAttachments(result) {
    const observations = result.candidates.flatMap((item) => item.matching_observations
        .filter((observation) => observation.freshness.reusable)
        .map((observation) => ({
        run_id: item.run_id,
        candidate_path: item.candidate_path,
        observation,
    })));
    observations.sort((a, b) => b.observation.matched_terms - a.observation.matched_terms ||
        String(b.observation.captured_at ?? "").localeCompare(String(a.observation.captured_at ?? "")) ||
        (a.observation.screenshot_path < b.observation.screenshot_path
            ? -1
            : a.observation.screenshot_path > b.observation.screenshot_path
                ? 1
                : 0));
    return observations.slice(0, 3);
}
async function attachClaimedGoals(result, content, images) {
    for (const item of result.candidates
        .filter((candidate) => candidate.status === "claimed_candidate" &&
        candidate.freshness.reusable)
        .slice(0, 3)) {
        for (const shot of item.goal_screenshots) {
            content.push({
                type: "text",
                text: JSON.stringify({ run_id: item.run_id, ...shot }),
            });
            await attachVerified(item.candidate_path, shot.screenshot_path, shot.screenshot_sha256, content, images);
        }
    }
}
export async function buildFindCaptureResponse(result) {
    const content = [];
    const images = [];
    content.push({
        type: "text",
        text: `Product notes (separately labelled, never candidate promotion):\n${formatNotes(result.product_notes)}`,
    });
    // An exact reusable claim keeps the original goal delivery byte-for-byte: the
    // caller asked for exactly that screen and it is verified fresh. Otherwise the
    // old attachments would be unrelated goal images, so prefer the best fresh
    // matching observations instead and fall back to goal attachments only when none
    // attach. Matching images are content to inspect, not claims the goal completed.
    if (result.candidates.some((candidate) => candidate.exact_goal &&
        candidate.status === "claimed_candidate" &&
        candidate.freshness.reusable)) {
        await attachClaimedGoals(result, content, images);
    }
    else {
        let attached = 0;
        for (const { run_id, candidate_path, observation, } of selectObservationAttachments(result)) {
            const { freshness, ...inspectable } = observation;
            const attachment = [];
            if (await attachVerified(candidate_path, observation.screenshot_path, observation.screenshot_sha256, attachment, images)) {
                content.push({
                    type: "text",
                    text: JSON.stringify({
                        run_id,
                        ...inspectable,
                        reusable: freshness.reusable,
                    }),
                });
                attached += 1;
            }
            content.push(...attachment);
        }
        if (attached > 0) {
            content.push({
                type: "text",
                text: "Matching images above are verified intermediate frames to inspect for visible content. They do not claim the original goal completed, do not change stop, selection or candidate status, and cannot support a notebook note.",
            });
        }
        else {
            await attachClaimedGoals(result, content, images);
        }
    }
    content.unshift({
        type: "text",
        text: imageReferencedResult(result, images),
    });
    return { content };
}
async function response(result) {
    return buildFindCaptureResponse(result);
}
export async function serveCaptureMemory({ mapsRoot }) {
    const server = new Server({ name: "releashed-capture-memory", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === "find_capture") {
            const { url, goal, max_age_days, fresh } = request.params.arguments ?? {};
            if (typeof url !== "string" || typeof goal !== "string")
                throw new Error("find_capture needs url and goal");
            if (max_age_days !== undefined && typeof max_age_days !== "number")
                throw new Error("max_age_days must be a number");
            if (fresh !== undefined && typeof fresh !== "boolean")
                throw new Error("fresh must be boolean");
            return response(await findMemory({
                mapsRoot,
                url,
                query: goal,
                maxAgeDays: max_age_days,
                fresh,
            }));
        }
        if (request.params.name === "remember_flow") {
            const { url, expected_revision, note } = request.params.arguments ?? {};
            if (typeof url !== "string")
                throw new Error("remember_flow needs url");
            if (!Number.isInteger(expected_revision) ||
                expected_revision < 0)
                throw new Error("remember_flow needs expected_revision 0 or higher");
            if (!note || typeof note !== "object")
                throw new Error("remember_flow needs a note object");
            const result = await rememberFlow({
                mapsRoot,
                url,
                expected_revision: expected_revision,
                note,
            });
            const content = [
                { type: "text", text: formatRememberResult(result) },
                { type: "text", text: JSON.stringify(result, null, 2) },
            ];
            return { content };
        }
        if (request.params.name === "find_notes") {
            const { url, goal } = request.params.arguments ?? {};
            if (typeof url !== "string" || typeof goal !== "string")
                throw new Error("find_notes needs url and goal");
            const result = await findNotes({ mapsRoot, url, query: goal });
            // One JSON text block: it already carries product_notes, guidance,
            // errors and scope. No repeated prose payload.
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        throw new Error(`unknown tool ${request.params.name}`);
    });
    await server.connect(new StdioServerTransport());
}
if (import.meta.url === `file://${process.argv[1]}`) {
    const mapsRoot = process.argv[2];
    if (!mapsRoot) {
        console.error("usage: node scripts/capture-memory-mcp.mjs <maps-dir>");
        process.exit(2);
    }
    await serveCaptureMemory({ mapsRoot });
}
