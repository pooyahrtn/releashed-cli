const PREFIX = '{"releashed_image_references":';
export function imageReferencedResult(result, images) {
    const header = JSON.stringify({ releashed_image_references: { version: 1, images } });
    return `${header.slice(0, -1)},\n${JSON.stringify(result, null, 2).slice(1)}`;
}
/** Undefined means no header. A present but damaged header throws. */
export function readImageReferences(output) {
    if (typeof output !== "string" || !output.startsWith(PREFIX))
        return undefined;
    const newline = output.indexOf("\n");
    if (newline < 0 || output[newline - 1] !== ",")
        throw new Error("incomplete image references");
    return JSON.parse(`${output.slice(0, newline - 1)}}`).releashed_image_references;
}
