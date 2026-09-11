import { mount } from "bus";
import { machine } from "./machine.js";
import list from "./queries/list.json" with { type: "json" };

// The browser entry (3.2): the one place this component touches the network,
// and only to reach its own server module (section 3).
const load = () =>
  fetch("/api/pages").then((res) =>
    res.ok ? res.json() : Promise.reject(new Error(String(res.status))),
  );

mount(machine, { input: { load }, queries: { list } });
