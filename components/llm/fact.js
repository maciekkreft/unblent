import { mount, ask } from "bus";
import { machine } from "./machine.js";
import changed from "./events/llm.changed.json" with { type: "json" };
import progressed from "./events/completion.progressed.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };
import complete from "./queries/complete.json" with { type: "json" };

// The browser entry (3.2): the one place this component touches the network, and
// only to reach its own server module (section 3). All fetch and streaming lives
// here, so machine.js stays importable in Node.

const json = { Accept: "application/json" };

// GET the account picture. The server omits `signedIn`; the machine adds it (it
// reads only when signed in). A failed read (offline, or a lapsed session's 401)
// rejects, so the machine shows the signed-out picture (12).
const readPicture = async () => {
  const res = await fetch("/api/llm", { credentials: "same-origin", headers: json });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};

// PUT a settings gesture and adopt the fresh picture (7.7). The patch may carry the
// key; it goes only to the server and never comes back.
const savePatch = async (patch) => {
  const res = await fetch("/api/llm", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...json },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};

// POST the request and read the NDJSON answer piece by piece (section 10). The
// returned cancel aborts the fetch, which closes the server stream so spending
// stops (12); an abort is silent, because the machine has already announced the
// stop. A read or network failure surfaces as a failed end on the turn (12).
const stream = (request, onPiece) => {
  const controller = new AbortController();
  const fail = () => onPiece({ type: "end", status: "failed", error: "unavailable" });
  (async () => {
    let res;
    try {
      res = await fetch("/api/llm/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) fail();
      return;
    }
    if (!res.ok || !res.body) return fail();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const drain = (final) => {
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onPiece(JSON.parse(line));
      }
      if (final && buffer.trim()) onPiece(JSON.parse(buffer.trim()));
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        drain(false);
      }
      drain(true);
    } catch {
      if (!controller.signal.aborted) fail();
    }
  })();
  return () => controller.abort();
};

mount(machine, {
  input: {
    session: () => ask(machine, "session", "read", {}),
    read: readPicture,
    save: savePatch,
    stream,
  },
  events: { "llm.changed": changed, "completion.progressed": progressed },
  queries: { read, complete },
});
