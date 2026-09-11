import { register } from "node:module";
register("./importmap-loader.mjs", import.meta.url);
