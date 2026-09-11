// Section 7.3: the manifest is read from the machine, never written by hand.
// consumes, answers and accepts are derived from the message types the machine
// handles in any of its states, by the 7.2 convention: a dotted name is a consumed
// event, a name ending in `?` is an answered query, a leading `_` is internal and
// never routed, the rest are commands. XState's own lifecycle messages are not ours.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const out = {};
for (const file of process.argv.slice(2)) {
  const mod = await import(pathToFileURL(resolve(file)).href);
  const machine = mod.machine;
  if (!machine || typeof machine.config !== "object") {
    out[file] = { error: "no exported `machine`" };
    continue;
  }
  const config = machine.config;
  const handles = machine.events.filter((k) => !k.startsWith("xstate."));
  out[file] = {
    id: config.id ?? null,
    meta: config.meta ?? null,
    handles,
    consumes: handles.filter((k) => k.includes(".")),
    answers: handles.filter((k) => k.endsWith("?")).map((k) => k.slice(0, -1)),
    accepts: handles.filter((k) => !k.includes(".") && !k.endsWith("?") && !k.startsWith("_")),
  };
}
process.stdout.write(JSON.stringify(out));
