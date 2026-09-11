// Resolves the page's bare specifiers the way the browser does (architecture.md 10),
// so an actor can be imported in Node without a bundler.
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const IMPORTS = JSON.parse(readFileSync(new URL("vendor/vendor.json", ROOT), "utf8")).importmap.imports;

export async function resolve(specifier, context, next) {
  const target = IMPORTS[specifier];
  if (!target) return next(specifier, context);
  return { url: new URL(target.replace(/^\/static\//, ""), ROOT).href, shortCircuit: true };
}
