// Real on-screen detection for one accessibility node, shared by every producer (the raw-CDP
// broker and the Playwright-based vision runner) so "on screen" means the same thing everywhere.
//
// Two things can make a node's text NOT what a person actually sees right now, and a plain
// bounding-box check only catches one of them:
//   * scrolled off -- this chat-style app keeps old turns mounted, so a question from four
//     screens ago is still in the tree, just above the current scroll position.
//   * covered by an overlay -- a modal (e.g. a vocabulary pop-up) sits on top of the exercise
//     behind it; the background text still has a valid on-page position, it just isn't what's
//     drawn on top.
// A single check answers both: is the CENTER of this node's own box the thing the browser would
// actually hit if a person tapped there right now? `elementFromPoint` performs real hit-testing
// (paint order, stacking context, clipping), which a bounding-box-vs-viewport comparison alone
// cannot -- an occluded element's box can be entirely inside the viewport while every point in it
// hit-tests to the overlay sitting on top of it.
const VISIBILITY_CHECK = `function() {
  const rect = this.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) return false;
  const cx = Math.min(Math.max((rect.left + rect.right) / 2, 0), vw - 1);
  const cy = Math.min(Math.max((rect.top + rect.bottom) / 2, 0), vh - 1);
  let hit = document.elementFromPoint(cx, cy);
  while (hit) {
    if (hit === this || this.contains(hit) || hit.contains(this)) return true;
    hit = hit.parentElement;
  }
  return false;
}`;
// `send(method, params)` is a bare CDP command sender -- either wrapper's `.send` already has
// this shape, so neither producer needs its own copy of this logic (the two used to hand-roll
// near-identical AX-tree-to-line code independently, which is exactly the kind of divergence that
// has already cost a round here).
export async function isNodeOnScreen(send, backendNodeId) {
    if (!backendNodeId)
        return false;
    let objectId;
    try {
        const resolved = (await send("DOM.resolveNode", { backendNodeId }));
        objectId = resolved?.object?.objectId;
        if (!objectId)
            return false;
        const result = (await send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: VISIBILITY_CHECK,
            returnByValue: true,
        }));
        return result?.result?.value === true;
    }
    catch {
        // No box model (display:none, detached, unlaid-out) -- not on screen.
        return false;
    }
    finally {
        if (objectId)
            await send("Runtime.releaseObject", { objectId }).catch(() => { });
    }
}
