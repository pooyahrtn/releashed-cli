// Writes a plain-English caption for every screen in a run, from the SCREENSHOT -- what the picture
// shows, in the words a person would use, so a reader recognises the screen at a glance.
//
// Why not the text on the screen: lifting a heading, a prompt, or a URL path off the accessibility
// tree gives titles that read random ("First: which exam are you working toward?", "/onboarding-
// coach") because they are fragments of a screen, not a name for it.
//
// A caption is a DESCRIPTION, never evidence. It is written to its own sidecar file, keyed by the
// observation hash of the state it describes; the run's observations.jsonl is never touched, so the
// evidence stays exactly what the browser reported. The renderer treats it the same way: a caption
// titles a card and is labelled as a description in the drawer, while what actually happened is
// only ever said by an arrow (see usableCaption in renderer/render-map.mjs, which also refuses a
// caption that tries to claim an effect).
//
// A small, cheap vision model does the captioning -- never the expensive reasoning model. One call
// per distinct screen, and results are cached by screenshot hash, so re-captioning a run costs
// nothing. See captionProvider below for which model, on whose key.
//
//   ANTHROPIC_API_KEY=... node scripts/caption-screens.mjs \
//     --trace runs/<run>/target-session-1/observations.jsonl \
//     --output artifacts/<run>-captions.json

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { retainedScreenshots } from "../renderer/render-map.mjs";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const GEMINI_MODEL = "gemini-3.6-flash";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1/";
// The cheapest Claude that can see a picture. Captioning is a naming job, not a reasoning job, and
// this is the model the price table in lib/scaffold.mjs already knows.
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const DEFAULT_CACHE = resolve(
  new URL("../.runtime/screen-caption-cache.json", import.meta.url).pathname,
);

// Which host writes the captions, and why in this order.
//
// Captioning is a cheap vision call that every host here does well enough, so the order is about
// whose key the user already has, not about which model is better:
//
//   1. CAPTION_BASE_URL + CAPTION_API_KEY -- named by hand, so it outranks anything we would pick,
//      and the key set beside that URL is the one that host receives. (It used to receive
//      GEMINI_API_KEY instead whenever that happened to be set: a Google key posted to a host the
//      user chose for something else.) The pair is all-or-nothing, as the CLI help has always said;
//      half of it is refused by name rather than silently completed from another variable.
//   2. GEMINI_API_KEY -- what this script defaulted to before Claude was an option. Ahead of the
//      Anthropic fallback so an environment that captions today captions identically tomorrow,
//      cache included.
//   3. ANTHROPIC_API_KEY -- the explorer's own key. `releashed map` cannot run without it, so this
//      is the branch that matters: one key, and the screens still get names.
//
// CAPTION_MODEL overrides the model on whichever host is chosen.
export function captionProvider(env = process.env) {
  const model = env.CAPTION_MODEL;
  if (env.CAPTION_BASE_URL || env.CAPTION_API_KEY) {
    if (!env.CAPTION_BASE_URL || !env.CAPTION_API_KEY)
      throw new Error(
        `CAPTION_BASE_URL and CAPTION_API_KEY must be set together: ${env.CAPTION_BASE_URL ? "CAPTION_API_KEY" : "CAPTION_BASE_URL"} is missing`,
      );
    return {
      kind: "openai-compatible",
      baseUrl: env.CAPTION_BASE_URL,
      apiKey: env.CAPTION_API_KEY,
      model: model ?? GEMINI_MODEL,
    };
  }
  if (env.GEMINI_API_KEY)
    return {
      kind: "openai-compatible",
      baseUrl: GEMINI_BASE_URL,
      apiKey: env.GEMINI_API_KEY,
      model: model ?? GEMINI_MODEL,
    };
  if (env.ANTHROPIC_API_KEY)
    return {
      kind: "anthropic",
      baseUrl: ANTHROPIC_BASE_URL,
      apiKey: env.ANTHROPIC_API_KEY,
      model: model ?? ANTHROPIC_MODEL,
    };
  throw new Error(
    "No key to caption screens with: set ANTHROPIC_API_KEY (the key `releashed map` already needs), or GEMINI_API_KEY, or CAPTION_BASE_URL + CAPTION_API_KEY for any OpenAI-compatible vision host",
  );
}

const PROMPT = [
  "You are labelling one screenshot of a web app so a reader can recognise the screen in a diagram.",
  "Write a short noun phrase, 3 to 8 words, sentence case, no full stop, naming what this screen is and what it is for.",
  "Describe only what is visible in this image. Never say what a button will do, what happened before, or what comes next.",
  "Do not use the app's name, a URL, or a page path. Do not quote a whole sentence off the screen.",
  "Some screens carry a promotional banner: bold ad copy pitching a feature or an upgrade, written to persuade a visitor rather than to describe the screen. If you see one, ignore it -- it is not what this screen is. Describe the actual tool, list, or form the page exists to show instead.",
  'Good: "Exam choice question", "Writing exercise with the answer typed in", "Word lookup sheet open over the lesson", "Speaking lesson intro with Start button", "Dashboards list with folders and search".',
  'Bad: "Your Data Deserves Better Than a Spreadsheet" -- that is an advertisement lifted from a banner, not a description of the screen behind it.',
  "Include the one detail that tells this screen apart from a near-identical one: the actual question asked, the option that is selected, the word or answer shown.",
  "Answer with one line containing nothing but the phrase itself: no label, no quotation marks, no word count, no alternatives, no commentary about your own answer.",
].join("\n");
// Bumped whenever PROMPT changes, so a cached caption is never served from an older instruction.
const PROMPT_VERSION = "v4";

// The model mostly answers with the phrase and nothing else, but sometimes labels it ("Noun phrase:
// ..."), quotes it, or works through the instructions out loud afterwards ("... -> 6 words. Sentence
// case? Yes."). The cache holds what the model actually said, so this can be improved without paying
// for the pictures again; anything that still reads as the model talking to itself is dropped, and
// that screen simply keeps the title the renderer reads off it.
//
// Deliberately generic rather than a growing list of exact phrases seen so far: a caption is
// self-talk whenever it is commentary ABOUT an answer (checking it, counting it, formatting it)
// rather than a description of a screen. Three shapes cover that, whatever words the model uses:
//   1. First-person/deliberative voice ("let's", "let me", "I'll", "checking", "verify") -- a
//      screen description is never written in the model's own voice.
//   2. A rule of THIS PROMPT being talked about (word count, capitalization, punctuation) -- a
//      real caption never mentions the rules it was asked to follow.
//   3. A checklist/answer-grading shape: a trailing colon, a PASS/FAIL/Yes/No verdict, a bullet or
//      numbered list marker, or a "-> N words" tally.
const SELF_TALK =
  /\b(?:let'?s|let me|i'll|i'd|i've|i should|i need|i will|we need|we should|make sure|wait|counting|check(?:ing)?\s+(?:the|that|this|my|our|its)\s+(?:answer|caption|constraints?|instructions?|rules?|phrase|count))\b/i;
const PROMPT_RULE_TALK =
  /\bsentence case\b|\bno full stop\b|\bword count\b|\bnoun phrase\b|\bcapital(?:ize|ization)?\b|\blowercase\b|\buppercase\b|\bproper noun\b|\bpunctuation\b/i;
const CHECKLIST_SHAPE =
  /:\s*$|:\s*(?:PASS|FAIL|Yes|No)\b|^\s*[*-]\s|^\s*\d+[.)]\s|\[\d\]|\(\d\)|-?>\s*\d+\s+words?\b|=\s*\d+\s+words?\b/im;

// Backstop for a model that ignores the "sentence case" instruction and echoes a page's own
// headline verbatim instead of describing it (see the PROMPT note above on promotional banners):
// a Title-Cased Every Word phrase is what a banner or an ad slogan looks like, never what this
// prompt asks for. Requires several capitalized words so a short proper noun ("QuickPizza
// dashboard") never trips it. This never invents a substitute -- it only stops a headline from
// being written to the sidecar; the caller's own fallback (usableCaption returning null) leaves
// the screen with the title the renderer already reads off it.
function looksLikeHeadline(text) {
  const words = text.split(/\s+/).filter((word) => /[A-Za-z]/.test(word));
  if (words.length < 5) return false;
  const capitalized = words.filter((word) => /^[A-Z]/.test(word));
  return capitalized.length / words.length >= 0.7;
}

export function cleanCaption(raw) {
  const body = String(raw ?? "");
  const candidates = [];
  const line = body
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  // The first line, with any label the model put in front of it and any commentary it added after
  // it removed. A phrase that quotes the screen ("Fill in the blank exercise for \"Geachte
  // mevrouw\"") keeps its quotes -- they are part of the description.
  if (line)
    candidates.push(
      line
        .replace(/^[A-Za-z][A-Za-z ]{0,22}:\s*/, "")
        .replace(/^["'\u201c\u2018]/, "")
        .split(/\s+\(\d+\s+words?\)|\s+->\s+/)[0],
    );
  // Only if that leaves nothing usable: a complete double-quoted phrase anywhere in the answer.
  const quoted = /"([^"]{12,90})"/.exec(body);
  if (quoted) candidates.push(quoted[1]);
  for (const candidate of candidates) {
    const cut = candidate.replace(/[.\s]+$/, "").trim();
    // Cutting the model's commentary off can leave the quote it had opened around its own answer.
    // Only an unbalanced one is stripped, so a phrase that legitimately quotes the screen keeps both.
    const text =
      /"$/.test(cut) && (cut.match(/"/g)?.length ?? 0) % 2 === 1 ? cut.slice(0, -1).trim() : cut;
    if (
      text.length >= 12 &&
      text.split(/\s+/).length >= 2 &&
      /^[A-Za-z\u2018\u201c'"]/.test(text) &&
      !SELF_TALK.test(text) &&
      !PROMPT_RULE_TALK.test(text) &&
      !CHECKLIST_SHAPE.test(text) &&
      !looksLikeHeadline(text)
    )
      return text;
  }
  return null;
}

function usage() {
  throw new Error(
    "Usage: node scripts/caption-screens.mjs --trace <observations.jsonl> --output <captions.json> [--cache <path>]",
  );
}

function parseArgs(argv) {
  const values = {};
  if (argv.length % 2 !== 0) usage();
  for (let index = 0; index < argv.length; index += 2) {
    if (!["--trace", "--output", "--cache"].includes(argv[index]) || values[argv[index]]) usage();
    values[argv[index]] = argv[index + 1];
  }
  if (!values["--trace"] || !values["--output"]) usage();
  return values;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// One screenshot in, one line of text out, on either wire shape. Both are plain fetch: the whole
// call is a prompt and a PNG, and the two request bodies below say exactly what goes over the wire
// -- an SDK for this would be a dependency to read instead of eight lines to read.
function captionRequest(provider, image) {
  if (provider.kind === "anthropic")
    return {
      url: new URL("messages", provider.baseUrl),
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: provider.model,
        temperature: 0,
        max_tokens: 600,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      },
      // Claude answers in content blocks, and a caption is the first text one.
      read: (body) => ({
        text: body.content?.find((block) => block?.type === "text")?.text,
        prompt: body.usage?.input_tokens ?? 0,
        completion: body.usage?.output_tokens ?? 0,
      }),
    };
  return {
    url: new URL("chat/completions", provider.baseUrl),
    headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
    body: {
      model: provider.model,
      temperature: 0,
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
          ],
        },
      ],
    },
    read: (body) => ({
      text: body.choices?.[0]?.message?.content,
      prompt: body.usage?.prompt_tokens ?? 0,
      completion: body.usage?.completion_tokens ?? 0,
    }),
  };
}

export async function captionOne(provider, bytes) {
  const request = captionRequest(provider, bytes.toString("base64"));
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  if (!response.ok)
    throw new Error(`Caption request failed (${provider.model}): ${response.status}`);
  const { text, prompt, completion } = request.read(await response.json());
  if (typeof text !== "string" || !text.trim()) throw new Error("Caption response was empty");
  return { raw: text.slice(0, 400), usage: { prompt, completion } };
}

export async function captionScreens({ tracePath, outputPath, cachePath = DEFAULT_CACHE }) {
  const provider = captionProvider();
  const events = (await readFile(tracePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const shots = retainedScreenshots(events);
  const cache = await readJson(cachePath, {});
  const captions = {};
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let failures = 0;
  for (const [hash, shot] of shots) {
    const key = `${provider.model}:${PROMPT_VERSION}:${shot.sha256}`;
    if (typeof cache[key] === "string") {
      const cached = cleanCaption(cache[key]);
      if (cached) captions[hash] = cached;
      continue;
    }
    const bytes = await readFile(resolve(dirname(tracePath), shot.path));
    try {
      const result = await captionOne(provider, bytes);
      calls += 1;
      promptTokens += result.usage.prompt;
      completionTokens += result.usage.completion;
      cache[key] = result.raw;
      const caption = cleanCaption(result.raw);
      if (caption) captions[hash] = caption;
      else failures += 1;
    } catch (error) {
      // A screen that cannot be captioned simply keeps the title the renderer reads off the screen.
      failures += 1;
      process.stderr.write(`caption failed for ${shot.path}: ${error.message}\n`);
    }
  }
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ schema_version: 1, model: provider.model, kind: "screen-descriptions", captions }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    screens: shots.size,
    captioned: Object.keys(captions).length,
    model_calls: calls,
    failures,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    output_path: resolve(outputPath),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  captionScreens({
    tracePath: resolve(options["--trace"]),
    outputPath: resolve(options["--output"]),
    cachePath: options["--cache"] ? resolve(options["--cache"]) : DEFAULT_CACHE,
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Captioning failed"}\n`);
      process.exitCode = 1;
    });
}
