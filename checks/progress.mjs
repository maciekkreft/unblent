// A push runs every test in both engines (11); a line per passing test buries the one that
// broke. This reporter prints one line per file, and a failure's reason right under its
// name, so a red run reads from the top. `--verbose` adds the spec reporter back.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();

function where(file) {
  if (!file) return "?";
  const path = file.startsWith("file:") ? fileURLToPath(file) : file;
  return relative(ROOT, path) || path;
}

// The code at file:line, so a reader sees what failed without opening the file.
const sources = new Map();
function code(file, line) {
  try {
    const path = file.startsWith("file:") ? fileURLToPath(file) : file;
    if (!sources.has(path)) sources.set(path, readFileSync(path, "utf8").split("\n"));
    const text = sources.get(path)[line - 1]?.trim();
    return text ? `${line} | ${text.length > 160 ? `${text.slice(0, 157)}...` : text}` : null;
  } catch {
    return null;
  }
}

// Node wraps a test's own error in ERR_TEST_FAILURE; the cause is what the test threw.
// The first of our frames can be a shared helper (a wait), so the test's own frame,
// the one node runs as TestContext, is printed under it when the two differ, then the
// test's code at that frame. A test stopped at its time limit has no frame of ours, so
// its declaration is named instead.
function reason(error, test) {
  const cause = error?.cause ?? error;
  const message = String(cause?.message ?? cause ?? "failed").split("\n").filter((l) => l.trim()).slice(0, 6).join("\n  ");
  const ours = String(cause?.stack ?? "").split("\n")
    .filter((line) => line.includes(ROOT) && !line.includes("node_modules") && !line.includes("/checks/"))
    .map((line) => line.trim());
  const frames = [...new Set([ours[0], ours.find((line) => line.includes("TestContext."))])].filter(Boolean);
  const lines = frames.map((frame) => frame.replace(`file://${ROOT}/`, "").replace(`${ROOT}/`, ""));
  const last = frames.at(-1)?.match(/\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?$/);
  if (last) lines.push(code(last[1], Number(last[2])));
  else if (test?.file && test.line) lines.push(`test at ${where(test.file)}:${test.line}`, code(test.file, test.line));
  return [message, ...lines.filter(Boolean)].map((line) => `  ${line}`).join("\n");
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
      yield `FAIL ${where(data.file)} "${data.name}"\n${reason(data.details?.error, data)}\n`;
    }
  }
  const line = finish();
  if (line) yield line;
}
