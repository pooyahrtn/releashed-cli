// Capture provenance is authored before a run can authenticate or spend.  It is deliberately
// just metadata: it never becomes explorer history or a route hint.
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function assertRunId(id, option = "--continues") {
    if (typeof id !== "string" || !RUN_ID.test(id) || id === "." || id === "..")
        throw new Error(`${option} must name a safe run id`);
    return id;
}
export function preconditionRunIds(precondition) {
    if (precondition === null || precondition === undefined)
        return [];
    if (typeof precondition !== "string" || !precondition.trim())
        throw new Error("--precondition must be non-empty plain English");
    const ids = [];
    for (const match of precondition.matchAll(/\brun\s+(\S+)/gi)) {
        const id = match[1].replace(/[.,;:!?]+$/, "");
        ids.push(assertRunId(id, "a precondition run reference"));
    }
    return [...new Set(ids)];
}
async function hasRecord(path, root, kind) {
    try {
        // Both the root and the final target are canonicalized. A safe id alone is not enough when a
        // malicious or stale `map.json` symlink can point outside the declared artifact roots.
        const [actual, allowedRoot] = await Promise.all([
            realpath(path),
            realpath(root),
        ]);
        const within = relative(allowedRoot, actual);
        if (within === "" ||
            within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
            isAbsolute(within))
            return false;
        if (!(await stat(actual)).isFile())
            return false;
        const record = JSON.parse(await readFile(actual, "utf8"));
        if (!record || typeof record !== "object" || Array.isArray(record))
            return false;
        if (kind === "raw")
            return "status" in record && typeof record.status === "string";
        return (("run_id" in record && typeof record.run_id === "string") ||
            ("schema_version" in record && typeof record.schema_version === "number"));
    }
    catch {
        return false;
    }
}
export async function validateRunReference(id, { runsRoot, mapsRoot }) {
    assertRunId(id);
    const raw = join(resolve(runsRoot), id, "target-session-1", "explorer-result.json");
    const packaged = join(resolve(mapsRoot), id, "map.json");
    if (!(await hasRecord(raw, runsRoot, "raw")) &&
        !(await hasRecord(packaged, mapsRoot, "map")))
        throw new Error(`run ${id} was not found in ${resolve(runsRoot)} or ${resolve(mapsRoot)}`);
    return id;
}
export async function validateCaptureMetadata({ goal = null, policy = null, continues = null, precondition = null, identityLabel = null, runsRoot, mapsRoot, }) {
    if ((policy || continues || precondition || identityLabel) && !goal)
        throw new Error("--policy, --continues, --precondition, and --identity-label need --goal");
    if (identityLabel !== null &&
        (typeof identityLabel !== "string" ||
            !identityLabel.trim() ||
            identityLabel.length > 128))
        throw new Error("--identity-label must be a short, non-empty opaque label");
    if (precondition !== null &&
        precondition !== undefined &&
        (typeof precondition !== "string" || !precondition.trim()))
        throw new Error("--precondition must be non-empty plain English");
    if (!goal)
        return { continues: null, precondition: null, identityLabel: null };
    const references = [continues, ...preconditionRunIds(precondition)].filter((id) => Boolean(id));
    await Promise.all(references.map((id) => validateRunReference(id, { runsRoot, mapsRoot })));
    return { continues, precondition, identityLabel };
}
