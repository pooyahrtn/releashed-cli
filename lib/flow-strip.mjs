// One picture of a run: every screen it went through, in order, read left to right.
//
// A map is a graph and it draws like one; a capture aimed at a goal is a line, and the thing a
// person wants to paste into a message is the line. So this is deliberately not a second renderer:
// it reads the map.json the packager already sealed (docs/map-schema.md), lays its screens out in
// one row, and takes a picture of that row with the Chromium we already ship. No image library.
//
// Only directed runs get one. A free walk's map.json is fifty screens of a graph, and a fifty-wide
// strip of it is not a flow -- so nothing here is reachable from a run without a --goal, and a
// no-goal run's output is untouched.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * The strip as a page. Pure: one <figure> per screen, in the order given.
 *
 * @param {{title: string|null, url: string|null, dataUri: string|null}[]} screens - in walk order
 * @param {{heading: string, subheading?: string|null}} labels
 */
export function stripHtml(screens, { heading, subheading = null } = {}) {
  const figures = screens
    .map(
      (screen, index) =>
        `<figure><div class="shot">${
          screen.dataUri ? `<img src="${screen.dataUri}" alt="">` : '<div class="missing">no screenshot retained</div>'
        }</div><figcaption><b>${index + 1}. ${esc(screen.title)}</b>${
          screen.url ? `<span>${esc(screen.url)}</span>` : ""
        }</figcaption></figure>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111;width:max-content}
h1{margin:0 0 2px;font-size:16px}
p.sub{margin:0 0 18px;color:#555;font-size:12px;max-width:900px}
.row{display:grid;grid-template-columns:repeat(10,320px);align-items:start;gap:24px}
figure{margin:0;width:320px;flex:0 0 auto}
.shot{height:200px;border:1px solid #ddd;border-radius:6px;overflow:hidden;background:#fafafa;display:flex;align-items:flex-start;justify-content:center}
.shot img{width:100%;display:block}
.missing{color:#999;font-size:12px;padding:16px}
figcaption{margin-top:8px;display:flex;flex-direction:column;gap:2px}
figcaption b{font-weight:600}
figcaption span{color:#777;font-size:11px;word-break:break-all}
</style><h1>${esc(heading)}</h1>${subheading ? `<p class="sub">${esc(subheading)}</p>` : ""}<div class="row">${figures}</div>`;
}

/**
 * Read a packaged candidate's map.json and write the strip beside it as one PNG.
 * Returns the path written.
 */
export async function renderStrip({ candidateDir, outputPath, heading, subheading = null, browser = null }) {
  const map = JSON.parse(await readFile(join(candidateDir, "map.json"), "utf8"));
  const screens = await Promise.all(
    map.screens.map(async (screen) => ({
      title: screen.title,
      url: screen.url,
      dataUri: screen.screenshot
        ? `data:image/png;base64,${(await readFile(join(candidateDir, screen.screenshot))).toString("base64")}`
        : null,
    })),
  );
  const html = stripHtml(screens, { heading, subheading });
  const { chromium } = browser ? { chromium: browser } : await import("playwright");
  const instance = await chromium.launch({ headless: true });
  try {
    // A short viewport with `width:max-content` on the body: fullPage grows to the finite ten-card
    // grid, then down for later rows, rather than making one ever-wider chain.
    const page = await (await instance.newContext({ viewport: { width: 1200, height: 200 } })).newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: outputPath, fullPage: true });
  } finally {
    await instance.close().catch(() => {});
  }
  return outputPath;
}
