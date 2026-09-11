// Section 7.3: the manifest is read from the machine, never written by hand.
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
  out[file] = {
    id: config.id ?? null,
    meta: config.meta ?? null,
    handles: Object.keys(config.on ?? {}),
  };
}
process.stdout.write(JSON.stringify(out));
