// The in-thread hooks (Node 22.15+) skip the loader worker that register() starts,
// which costs every Node process the check or a test starts about 0.2s (11).
import * as module from "node:module";
import { resolve } from "./importmap-loader.mjs";

if (module.registerHooks) module.registerHooks({ resolve });
else module.register("./importmap-loader.mjs", import.meta.url);
