// The one place that knows the text shape of a retained accessibility line: "eN [role] name" for
// something on screen right now, "eN [role offscreen] name" for something the full accessibility
// tree still contains (stale chat history, content behind a modal) but a person cannot currently
// see. Both producers (the raw-CDP broker and the Playwright vision runner) format with this, and
// the renderer parses with this -- previously each producer hand-rolled its own near-identical
// "eN [role] name" builder and the renderer its own regexes, and that divergence is exactly what
// cost a round on this file before.
//
// Old traces have no visibility marker at all. `parseAxLine` treats an absent marker as on-screen,
// so every already-captured run keeps behaving exactly as it did before this file existed.
export function formatAxLine(ref: string, role: string, name: string, { onScreen = true }: { onScreen?: boolean } = {}): string {
  const bracket = onScreen ? role : `${role} offscreen`;
  return `${ref} [${bracket}] ${name}`;
}

const LINE = /^(e\d+)\s+\[([^\]]+)\]\s*(.*)$/;

export type AxLine = {
  ref: string;
  role: string;
  onScreen: boolean;
  text: string;
};

export function parseAxLine(line: string): AxLine | null {
  const match = LINE.exec(line);
  if (!match) return null;
  const [, ref, bracket, text] = match;
  const offscreen = bracket.endsWith(" offscreen");
  const role = offscreen ? bracket.slice(0, -" offscreen".length) : bracket;
  return { ref, role, onScreen: !offscreen, text: text.trim() };
}
