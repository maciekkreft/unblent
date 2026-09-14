// The store (3.2): settings' private persistence, one localStorage key. The
// machine stays a pure definition by receiving read/write through input. Both are
// wrapped so a browser that refuses storage (private mode) reads null and drops
// the write, rather than throwing. One global key (not page-scoped): a page hidden
// on one page is hidden everywhere.
export function openStore(key) {
  return {
    read() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // No persistence available; the choice lives only for this page.
      }
    },
  };
}
