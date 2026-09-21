// The store (3.2): conversations' only browser persistence — which chat is open,
// which is per device (5, 12). It is kept in localStorage under the component's own
// name (11.2, one owner per fact), wrapped so a browser that refuses storage (private
// mode) reads null and drops the write rather than throwing. A null id clears it,
// because "no chat open" is a real state the store must be able to hold.
export function openStore(key = "conversations") {
  return {
    read() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(id) {
      try {
        if (id == null) localStorage.removeItem(key);
        else localStorage.setItem(key, id);
      } catch {
        // No persistence available; the choice lives only for this page.
      }
    },
  };
}
