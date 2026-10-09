// The store (3.2): the projects' private persistence in localStorage, one global key
// under the component's own name (11.2), so every page that loads Judge shares one list.
// The value is the machine's { version, projects, current } envelope, kept as a string.
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
        // No persistence available; the projects live only for this page.
      }
    },
  };
}
