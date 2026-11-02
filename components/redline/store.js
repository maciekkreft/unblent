// The store (3.2): Redline's private persistence in localStorage, one global key under
// the component's own name (11.2), so the stem page and the app page share one text.
// Both calls are wrapped so a browser that refuses storage (private mode) reads null
// and drops the write, rather than throwing.

// A browser may still hold its text under "review", this tool's former name; read moves
// it here once, so a rename loses nothing. Temporary, removed once every browser has moved.
const FORMER = "review";

// A scope keeps a second key beside the text under the same name, `<name>:<scope>`, such as
// the step that last wrote it (12, Undo); only the text itself moves from the former name.
export function openStore(name, scope = "") {
  const key = scope ? name + ":" + scope : name;
  return {
    read() {
      try {
        const value = localStorage.getItem(key);
        if (value !== null || scope) return value;
        const former = localStorage.getItem(FORMER);
        if (former === null) return null;
        localStorage.setItem(key, former);
        localStorage.removeItem(FORMER);
        return former;
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // No persistence available; the redline lives only for this page.
      }
    },
  };
}
