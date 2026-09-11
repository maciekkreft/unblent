import { mount } from "bus";
import { machine } from "./machine.js";
import list from "./queries/list.json" with { type: "json" };
import contracts from "./queries/contracts.json" with { type: "json" };

// The browser entry (3.2): the one place this component touches the network, and
// only to reach its own server module (section 3). Each query has its own loader.
const load = (path) => () =>
  fetch(path).then((res) =>
    res.ok ? res.json() : Promise.reject(new Error(String(res.status))),
  );

mount(machine, {
  input: { list: load("/api/catalog"), contracts: load("/api/catalog/contracts") },
  queries: { list, contracts },
});
