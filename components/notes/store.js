import { openStore } from "store";

// notes' private persistence (3.2), the IndexedDB cache behind the store interface.
// One database, its own name (11.2). Local-only for now (5): no outbox until
// replication arrives. The machine receives only the two operations it needs
// through input, so machine.js stays a pure definition importable in Node.
export function openNotes() {
  const db = openStore("notes", { notes: "id, updatedAt" });
  return {
    all: () => db.all("notes"),
    put: (note) => db.put("notes", note),
  };
}
