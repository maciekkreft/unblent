import { setup, fromPromise, assign } from "xstate";
import { mount, ask } from "bus";

// The composer (architecture.md 3.6): the second shared infrastructure after the
// bus, loaded once per page. It reads which implementation the user chose for each
// swappable role (settings.editors) and mounts that one in place of the page's
// default, re-swapping when the choice changes. It is not a component: it lives
// outside components/, and it is the one thing allowed to reach across a component
// boundary — only to import a role member's view.js by URL, to define it.

const machine = setup({
  actors: {
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  // A bus participant like any other: it asks settings: read for the starting
  // picture and follows settings.changed after (4.3, fourth rule). It emits
  // nothing and owns nothing; the swap is a side effect of its subscription.
  id: "composer",
  meta: { kind: "view", emits: [], asks: ["settings: read"] },
  context: ({ input }) => ({ ask: input.ask, editors: {} }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready",
          actions: assign({ editors: ({ event }) => (event.output.error ? {} : event.output.editors ?? {}) }),
        },
        onError: "ready",
      },
    },
    ready: {},
  },
  on: {
    "settings.changed": { actions: assign({ editors: ({ event }) => event.editors ?? {} }) },
  },
});

// The element filling a role is the page's default tag (whose localName equals the
// role) or a member the composer already swapped in (which carries data-role). A
// swap keeps data-role, so the same element is found again on the next reconcile.
function roleElement(role) {
  return document.querySelector(`${role}, [data-role="${role}"]`);
}

// The swap engine (3.6). Serialised: a settings.changed arriving mid-import runs
// after the current pass, always against the latest choice, so two rapid changes
// cannot cross. Idempotent: a role already filled by the chosen member is a no-op,
// so a page without an override renders its literal default and an empty map does
// nothing.
let running = null;
function reconcile(getEditors) {
  const pass = async () => {
    for (const [role, chosen] of Object.entries(getEditors() ?? {})) {
      const el = roleElement(role);
      if (!el || el.localName === chosen) continue;
      await import(`/static/components/${chosen}/view.js`);
      // The element may have moved or been swapped again while the import was in
      // flight; re-find it before replacing.
      const current = roleElement(role);
      if (!current || current.localName === chosen) continue;
      const next = document.createElement(chosen);
      for (const { name, value } of current.attributes) next.setAttribute(name, value);
      next.dataset.role = role;
      // The removed element's Lit disconnectedCallback unmounts its actor cleanly,
      // leaving nothing on the bus; the new one mounts on connect and takes its
      // place — in the dock, its slot, since dock-desk keys a view by role (12).
      current.replaceWith(next);
    }
  };
  running = (running ?? Promise.resolve()).then(pass, pass);
  return running;
}

const actor = mount(machine, { input: { ask: (t, n, p) => ask(machine, t, n, p) } });
actor.subscribe((snapshot) => reconcile(() => snapshot.context.editors));
