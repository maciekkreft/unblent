// The store (3.2): dock's private persistence, one localStorage key. The machine
// stays a pure definition by receiving read/write through input. Both are wrapped
// so a browser that refuses storage (private mode) reads null and drops the write,
// rather than throwing.
//
// The key is the component's own name (11.2, one owner per fact), scoped by the page
// the desk lives on, so an app desk and the /workshop/design/dock stem keep separate layouts
// rather than clobbering each other. The scope is a plain string the fact reads from
// location; it is still only dock's own storage.
export function openStore(name, scope = "") {
  const key = scope ? `${name}:${scope}` : name;
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
        // No persistence available; the layout lives only for this page.
      }
    },
  };
}
