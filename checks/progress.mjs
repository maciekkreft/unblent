// A push runs every test in both engines (11); a line per passing test buries the one that
// broke. This reporter prints one line per file, and a failure's reason right under its
// name, so a red run reads from the top. `--verbose` adds the spec reporter back.
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();

function where(file) {
  if (!file) return "?";
  const path = file.startsWith("file:") ? fileURLToPath(file) : file;
  return relative(ROOT, path) || path;
}

// Node wraps a test's own error in ERR_TEST_FAILURE; the cause is what the test threw.
function reason(error) {
  const cause = error?.cause ?? error;
  const message = String(cause?.message ?? cause ?? "failed").split("\n").filter((l) => l.trim()).slice(0, 6).join("\n  ");
  const frame = String(cause?.stack ?? "").split("\n")
    .find((line) => line.includes(ROOT) && !line.includes("node_modules") && !line.includes("/checks/"));
  return frame ? `  ${message}\n  ${frame.trim()}` : `  ${message}`;
}

export default async function* progress(source) {
  let file = null, ms = 0, count = 0, failed = false;
  function finish() {
    if (file === null) return "";
    const line = `${failed ? "FAIL" : "ok  "} ${where(file).padEnd(52)} ${(ms / 1000).toFixed(1).padStart(5)}s  (${count} tests)\n`;
    file = null; ms = 0; count = 0; failed = false;
    return line;
  }
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { data } = event;
    if (data.file !== file) {
      const line = finish();
      if (line) yield line;
      file = data.file;
    }
    if (data.nesting === 0) ms += data.details?.duration_ms ?? 0;
    if (data.details?.type !== "suite") count += 1;
    // A suite fails for its subtests, already named, or for a hook of its own, which is not.
    const own = data.details?.type !== "suite" || data.details?.error?.failureType !== "subtestsFailed";
    if (event.type === "test:fail" && own) {
      failed = true;
      yield `FAIL ${where(data.file)} "${data.name}"\n${reason(data.details?.error)}\n`;
    }
  }
  const line = finish();
  if (line) yield line;
}
