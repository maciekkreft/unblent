// The store (3.2): the last answer of the server, kept in localStorage under the
// component's own name (11.2), so a reload or an offline start hides the same features
// (3.1). Wrapped so a browser that refuses storage reads null and drops the write.
export function openStore(name) {
  return {
    read() {
      try {
        return JSON.parse(localStorage.getItem(name) ?? "null");
      } catch {
        return null;
      }
    },
    write(picture) {
      try {
        if (picture) localStorage.setItem(name, JSON.stringify(picture));
        else localStorage.removeItem(name);
      } catch {
        // No persistence available; the answer lives only for this page.
      }
    },
  };
}
