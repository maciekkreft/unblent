// The store (3.2): Redline's private persistence in localStorage, one global key under
// the component's own name (11.2), so the stem page and the app page share one text.
// Both calls are wrapped so a browser that refuses storage (private mode) reads null
// and drops the write, rather than throwing.

// A browser may still hold its text under "review", this tool's former name; read moves
// it here once, so a rename loses nothing. Temporary, removed once every browser has moved.
const FORMER = "review";

export function openStore(name) {
  return {
    read() {
      try {
        const value = localStorage.getItem(name);
        if (value !== null) return value;
        const former = localStorage.getItem(FORMER);
        if (former === null) return null;
        localStorage.setItem(name, former);
        localStorage.removeItem(FORMER);
        return former;
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        localStorage.setItem(name, value);
      } catch {
        // No persistence available; the redline lives only for this page.
      }
    },
  };
}
