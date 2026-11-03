import { mount } from "bus";
import { machine } from "./machine.js";
import changed from "./events/updates.changed.json" with { type: "json" };
import recorded from "./events/step.recorded.json" with { type: "json" };
import settled from "./events/step.settled.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): the one place this component touches the network, and only
// to reach its own server module (section 3). The switch belongs to this Mac, not to
// the account, so a connected Mac's relay must keep the request on the Mac (3.4).
const headers = { Accept: "application/json", "X-Unblent-Local": "1" };
// The website answers { here: false }: there is no Mac app to offer test versions to.
const answer = (res) =>
  res.ok ? res.json().then((body) => (typeof body?.test === "boolean" ? body : Promise.reject(new Error("not-here")))) : Promise.reject(new Error(String(res.status)));

const load = () => fetch("/api/updates", { credentials: "same-origin", headers }).then(answer);

const save = (test) =>
  fetch("/api/updates", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ test }),
  }).then(answer);

mount(machine, {
  input: { load, save },
  events: { "updates.changed": changed, "step.recorded": recorded, "step.settled": settled },
  queries: { read },
});
