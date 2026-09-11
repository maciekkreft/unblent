import { mount } from "bus";
import { machine } from "./machine.js";

// The browser entry (3.2): the one place this component touches the network,
// and only to reach its own server module (section 3).
const load = () =>
  fetch("/api/catalog").then((res) =>
    res.ok ? res.json() : Promise.reject(new Error(String(res.status))),
  );

mount(machine, { input: { load } });
