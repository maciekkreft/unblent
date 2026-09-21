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

// The stream in flight, and whether the page is going away. An answer still arriving
// when the page is discarded is not kept (decision 4): as the page leaves we abort the
// request and mark it leaving, so its read error is not turned into a saved failure —
// after a reload the chat ends with the question, for Continue to resume. A genuine
// network drop on a page that stays still surfaces as a failed turn (12).
let active = null;
let leaving = false;
// beforeunload and pagehide mean the page is genuinely going away (a reload, a close),
// not merely backgrounded — a tab switch must not abort an answer, which keeps streaming
// while the tab is hidden. pageshow restores the flag if the page comes back from the
// back/forward cache.
addEventListener("beforeunload", () => {
  leaving = true;
  active?.abort();
});
addEventListener("pagehide", () => {
  leaving = true;
  active?.abort();
});
addEventListener("pageshow", () => {
  leaving = false;
});

// POST the request and read the NDJSON answer piece by piece (section 10). The returned
// cancel aborts the fetch, which closes the server stream so spending stops (12); an
// abort is silent, because the machine has already announced the stop. A read or network
// failure on a page that stays surfaces as a failed end on the turn (12).
const stream = (request, onPiece) => {
  const controller = new AbortController();
  active = controller;
  // The machine runs the returned cancel on cleanup, which happens both on a real Stop
  // and when the answer ends on its own. Abort only while the stream is genuinely in
  // flight, so a natural end does not cancel an already-finished request (a Stop still
  // aborts mid-stream, which closes the server stream so spending stops, 12).
  let live = true;
  // Once an `end` piece is out, the answer is over: the machine reacts to it by stopping
  // this stream, which runs the cancel below; marking it not live first makes that cancel
  // a no-op, so a finished answer never cancels its own request.
  const emit = (piece) => {
    if (piece.type === "end") live = false;
    onPiece(piece);
  };
  const fail = () => emit({ type: "end", status: "failed", error: "unavailable" });
  (async () => {
    try {
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
        if (!controller.signal.aborted && !leaving) fail();
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
          if (line) emit(JSON.parse(line));
        }
        if (final && buffer.trim()) emit(JSON.parse(buffer.trim()));
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
        if (!controller.signal.aborted && !leaving) fail();
      }
    } finally {
      live = false;
      if (active === controller) active = null;
    }
  })();
  return () => {
    if (live) controller.abort();
  };
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
