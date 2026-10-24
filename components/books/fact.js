import { mount, ask } from "bus";
import { machine, JOURNAL } from "./machine.js";
import { openBooks } from "./store.js";
import changed from "./events/book.changed.json" with { type: "json" };
import deleted from "./events/book.deleted.json" with { type: "json" };
import refused from "./events/book.refused.json" with { type: "json" };
import opened from "./events/book.opened.json" with { type: "json" };
import rejected from "./events/session.rejected.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };
import chapter from "./queries/chapter.json" with { type: "json" };
import open from "./queries/open.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the IndexedDB store,
// the clock, the passkey-gated api, the asks (the session, and the journal it presents
// as a book), and the object-URL revoke — and mounts it, so machine.js stays importable
// in Node. An import is an upload of the
// picked file's bytes (Decision 2); a position and a delete are small JSON writes; a
// chapter is a plain fetch the browser's HTTP cache answers on repeat.

// On a try page (8) the Journal is always the open book, and opening a book there is
// not kept: the try page reads the stored open book as the Journal, newer than any
// pull, and never writes it, so this browser's own open book is left as it was.
const cache = openBooks();
const store = location.pathname.startsWith("/try/")
  ? {
      ...cache,
      metaGet: (key) => (key === "open" ? Promise.resolve({ id: JOURNAL, at: Infinity }) : cache.metaGet(key)),
      metaPut: (key, value) => (key === "open" ? Promise.resolve() : cache.metaPut(key, value)),
    }
  : cache;

// keepalive lets a small write finish when the page goes away, so a reload or a closed
// tab neither cancels a save on its way nor makes the browser report it as a failed
// request. Each such body is a few bytes, far under the browser's 64 KiB keepalive cap;
// an upload is large and keeps an ordinary fetch.
const api = {
  // Fetch the tab-local object URL for the picked bytes, PUT them, and always revoke
  // the URL, since the file lives only on the server. 200 carries the row; 422 is not-an-epub; 401 the session;
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
  // Adds a book of this browser's copy to the account the browser joined (12, keep): its
  // file is read from where the row says (3.4), the Mac's own server past the relay
  // (X-Unblent-Local) after a Connect, or the account with the kept device sign-in
  // (X-Unblent-Remote) after a Disconnect, and uploaded as an import; then its place and
  // the user's title are sent. A file that is not there (404) or that is not an epub (422)
  // cannot be added; a 401 is the session; anything else throws, so the machine retries
  // it at the next sync, as offline.
  async adopt(row) {
    const side = row.from === "remote" ? { "X-Unblent-Remote": "1" } : { "X-Unblent-Local": "1" };
    const local = await fetch(`/api/books/${row.book}/source`, {
      credentials: "same-origin",
      headers: { ...side, Accept: "application/epub+zip" },
    });
    if (local.status === 404) return { error: "unreadable" };
    if (!local.ok) throw new Error(`books source ${local.status}`);
    const res = await fetch(`/api/books/${row.book}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/epub+zip", Accept: "application/json" },
      body: await local.blob(),
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (res.status === 422) return { error: "unreadable" };
    if (!res.ok) throw new Error(`books adopt ${res.status}`);
    let book = await res.json();
    const { chapter = 0, block = 0 } = row.position ?? {};
    if (chapter !== 0 || block !== 0) {
      const placed = await api.position(row.book, chapter, block);
      if (placed.error) return placed;
      book = placed;
    }
    if (row.title) {
      const titled = await api.title(row.book, row.title);
      if (titled.error) return titled;
      book = titled;
    }
    return { row: book };
  },
  async position(id, chapterIndex, block) {
    const res = await fetch(`/api/books/${id}/position`, {
      method: "PUT",
      credentials: "same-origin",
      keepalive: true,
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
      keepalive: true,
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
      keepalive: true,
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
      keepalive: true,
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
    // A 401 is the session, not the server (like every other call): the machine ends
    // the session on it, rather than the reader mislabelling it "unavailable" (12).
    if (res.status === 401) return { error: "unauthorized" };
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
  events: { "book.changed": changed, "book.deleted": deleted, "book.refused": refused, "book.opened": opened, "session.rejected": rejected },
  queries: { list, read, chapter, open },
});

// A tab regaining focus drains then pulls (an import or a position from another
// device arrives this way); a tab going hidden drains without a pull, so another
// device finds the latest place (5). Reading visibilityState is a read of the
// document, allowed to any component; the machine only receives the message.
document.addEventListener("visibilitychange", () =>
  actor.send({ type: "_sync", pull: document.visibilityState === "visible" }),
);
