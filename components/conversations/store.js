// The store (3.2): conversations' only browser persistence — which chat is open,
// which is per device (5, 12). It is kept in localStorage under the component's own
// name (11.2, one owner per fact), wrapped so a browser that refuses storage (private
// mode) reads null and drops the write rather than throwing. A null id clears it,
// because "no chat open" is a real state the store must be able to hold. Beside it, under
// `<name>:steps`, the steps that last wrote each chat in this browser (12, Undo), so an
// Undo still applies after a reload.
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
    readSteps() {
      try {
        return JSON.parse(localStorage.getItem(`${key}:steps`) ?? "null");
      } catch {
        return null;
      }
    },
    writeSteps(value) {
      try {
        localStorage.setItem(`${key}:steps`, JSON.stringify(value));
      } catch {
        // No persistence available; an Undo after a reload is refused.
      }
    },
  };
}
