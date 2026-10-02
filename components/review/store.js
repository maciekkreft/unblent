// The store (3.2): review's private persistence in localStorage, one global key under
// the component's own name (11.2), so the stem page and the app page share one text.
// Both calls are wrapped so a browser that refuses storage (private mode) reads null
// and drops the write, rather than throwing.
export function openStore(name) {
  return {
    read() {
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        localStorage.setItem(name, value);
      } catch {
        // No persistence available; the review lives only for this page.
      }
    },
  };
}
