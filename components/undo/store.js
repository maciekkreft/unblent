import { openStore } from "store";

// The store (3.2): the steps in IndexedDB through the store interface, one record per
// account under the component's own name (11.2, one owner per fact). Every tab of the
// browser opens the same database, which is how the steps are shared between them.
export function openUndo() {
  const db = openStore("undo", { lists: "account" });
  return {
    read: (account) => db.get("lists", account),
    write: (account, lists) => db.put("lists", { account, undo: lists.undo, redo: lists.redo }),
  };
}
