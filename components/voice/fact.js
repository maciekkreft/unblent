import { mount } from "bus";
import { machine } from "./machine.js";
import changed from "./events/voice.changed.json" with { type: "json" };
import recorded from "./events/step.recorded.json" with { type: "json" };
import settled from "./events/step.settled.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };
import speak from "./queries/speak.json" with { type: "json" };

// The browser entry (3.2): the one place this component touches the network, and only
// to reach its own server module (section 3). A connected Mac reads aloud with Kokoro on
// the Mac itself, so every request is kept on the Mac by its relay (3.4).
const headers = { Accept: "application/json", "X-Unblent-Local": "1" };
const answer = (res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status))));

const request = (path, method, body) =>
  fetch(`/api/voice${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(answer);

mount(machine, {
  input: {
    load: () => request("", "GET"),
    save: (patch) => request("", "PUT", patch),
    speak: (text) => request("/speak", "POST", { text }),
    moveKey: (body) => request("/key/step", "PUT", body),
    forgetKey: (step) => request("/key/forget", "PUT", { step }),
  },
  events: { "voice.changed": changed, "step.recorded": recorded, "step.settled": settled },
  queries: { read, speak },
});
