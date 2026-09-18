// The store (3.2): settings' private persistence in localStorage. The machine
// stays a pure definition by receiving read/write through input. Both are wrapped
// so a browser that refuses storage (private mode) reads null and drops the write,
// rather than throwing.
//
// The key is the component's own name (11.2, one owner per fact), scoped so the two
// profile copies and the stored switch (§12) live in separate keys: settings,
// settings:product, settings:profile. The scope is a plain string; it is still only
// settings' own storage. Global (not page-scoped): a page hidden in a profile is
// hidden everywhere in that profile.
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
        // No persistence available; the choice lives only for this page.
      }
    },
  };
}
