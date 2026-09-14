// The store (3.2): session's private cache, one localStorage key. The machine
// stays a pure definition by receiving read/write through input. Both are wrapped
// so a browser that refuses storage (private mode) reads null and drops the write
// rather than throwing. The cache is small — who is signed in, whether a slot is
// free, and a sign-out still owed (5) — the truth is the server the fact reaches.
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
        // No persistence available; the session lives only for this page.
      }
    },
  };
}
