// The store (3.2): pins' private persistence in localStorage, under the component's own
// name (11.2, one owner per fact). Wrapped like settings' store, so a browser that
// refuses storage (private mode) reads null and drops the write rather than throwing.
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
        // No persistence available; the pins live only for this page.
      }
    },
  };
}
