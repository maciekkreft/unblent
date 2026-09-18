import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openBooks } from "./store.js";
import changed from "./events/book.changed.json" with { type: "json" };
import deleted from "./events/book.deleted.json" with { type: "json" };
import refused from "./events/book.refused.json" with { type: "json" };
import opened from "./events/book.opened.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };
import chapter from "./queries/chapter.json" with { type: "json" };
import open from "./queries/open.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the IndexedDB store,
// the clock, the passkey-gated api, the session ask, and the object-URL revoke — and
// mounts it, so machine.js stays importable in Node. An import is an upload of the
// picked file's bytes (Decision 2); a position and a delete are small JSON writes; a
// chapter is a plain fetch the browser's HTTP cache answers on repeat.
const store = openBooks();

const api = {
  // Fetch the tab-local object URL for the picked bytes, PUT them, and always revoke
  // the URL (Decision 5). 200 carries the row; 422 is not-an-epub; 401 the session;
  // anything else, or a thrown fetch, is the server being unavailable.
  async upload(id, url) {
    try {
      const file = await (await fetch(url)).blob();
      const res = await fetch(`/api/books/${id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/epub+zip", Accept: "application/json" },
        body: file,
      });
      if (res.status === 401) return { error: "unauthorized" };
      if (res.status === 422) return { error: "unreadable" };
      if (!res.ok) return { error: "unavailable" };
      return { row: await res.json() };
    } catch {
      return { error: "unavailable" };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  async position(id, chapterIndex, block) {
    const res = await fetch(`/api/books/${id}/position`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ chapter: chapterIndex, block }),
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`books position ${res.status}`);
    return await res.json();
  },
  // A user title, last write wins and never refused (like a position): the server
  // keeps it beside the file's title and stamps a new version, replying the row.
  // An empty title clears it, restoring the file's. A 401 drops the session.
  async title(id, title) {
    const res = await fetch(`/api/books/${id}/title`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ title }),
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`books title ${res.status}`);
    return await res.json();
  },
  async remove(id) {
    const res = await fetch(`/api/books/${id}/deleted`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`books delete ${res.status}`);
    return await res.json();
  },
  // The open book, last write wins and never refused (like a position): the server
  // stamps its own time and replies { id, at }. A 401 drops the session.
  async opened(id) {
    const res = await fetch(`/api/books/${id}/opened`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`books opened ${res.status}`);
    return await res.json();
  },
  async pull(since) {
    const res = await fetch(`/api/books?since=${since}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`books pull ${res.status}`);
    return await res.json();
  },
  async chapter(id, contentVersion, index) {
    let res;
    try {
      res = await fetch(`/api/books/${id}/${contentVersion}/chapters/${index}`, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
      });
    } catch {
      return { error: "unavailable" };
    }
    if (res.status === 404) return { error: "not-found" };
    if (!res.ok) return { error: "unavailable" };
    return { html: await res.text() };
  },
};

const actor = mount(machine, {
  input: {
    store,
    now: () => Date.now(),
    api,
    ask: (target, name, payload) => ask(machine, target, name, payload),
    revoke: (url) => URL.revokeObjectURL(url),
  },
  events: { "book.changed": changed, "book.deleted": deleted, "book.refused": refused, "book.opened": opened },
  queries: { list, read, chapter, open },
});

// A tab regaining focus drains then pulls (an import or a position from another
// device arrives this way); a tab going hidden drains without a pull, so another
// device finds the latest place (5). Reading visibilityState is a read of the
// document, allowed to any component; the machine only receives the message.
document.addEventListener("visibilitychange", () =>
  actor.send({ type: "_sync", pull: document.visibilityState === "visible" }),
);
