import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the user's page
// preferences — the order and visibility of pages in the navigation, whether the
// viewport switch and the layout switch are shown, whether the desk layout is
// being arranged, and whether editors take Vim keys. It keeps two independent copies (§12), one per profile
// (product and workshop), and reports the active one through settings: read and
// settings.changed; a view takes its starting picture by query (4.3) and follows
// settings.changed after. The stores arrive through `input`, so the machine is a
// pure definition importable in Node.

// Each profile has its own defaults: the workshop is the full development surface,
// the product hides the switches and does not arrange (§12, plan step 6).
const DEFAULT = { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: false, editors: {} };
const PRODUCT_DEFAULT = { nav: [], viewportSwitchHidden: true, layoutSwitchHidden: true, arranging: false, vimKeys: false, editors: {} };

// Stored editor choices naming a component that no longer exists, by role and
// component, with whether that choice meant "I want Vim" (12): such a choice is dropped
// and, if it meant Vim, turns vimKeys on in its place. Once dropped it is gone from what
// is next saved, so this happens once per device and profile.
const RETIRED = {
  "note-editor": { "note-editor-cm6": true, "note-editor": false },
};

// Sanitise any candidate into the contract shape (7.2): nav a list of
// { path: string, hidden: boolean } deduped by path (a page is listed once);
// editors a role -> component map keeping only string values, less a RETIRED
// choice; booleans coerced
// with === true. Then the invariant: a hidden switch means the desk is not
// arrangeable, so hiding the switch turns arranging off; arranging is on by
// default and unknown/old fields fall to that.
const clean = (value) => {
  const v = value && typeof value === "object" ? value : {};
  const nav = [];
  const seen = new Set();
  if (Array.isArray(v.nav)) {
    for (const row of v.nav) {
      const path = row?.path;
      if (typeof path === "string" && !seen.has(path)) {
        seen.add(path);
        nav.push({ path, hidden: row.hidden === true });
      }
    }
  }
  const editors = {};
  let wantsVim = false;
  if (v.editors && typeof v.editors === "object") {
    for (const [role, component] of Object.entries(v.editors)) {
      if (typeof component !== "string") continue;
      const retired = RETIRED[role]?.[component];
      if (retired === undefined) editors[role] = component;
      else wantsVim ||= retired;
    }
  }
  const layoutSwitchHidden = v.layoutSwitchHidden === true;
  return {
    nav,
    viewportSwitchHidden: v.viewportSwitchHidden === true,
    layoutSwitchHidden,
    arranging: v.arranging !== false && !layoutSwitchHidden,
    vimKeys: v.vimKeys === true || wantsVim,
    editors,
  };
};

const parse = (stored, fallback) => {
  if (stored == null) return { ...fallback };
  try {
    return clean(JSON.parse(stored));
  } catch {
    return { ...fallback };
  }
};

// Which copy is live: a workshop page is always workshop; the product page is
// product until the stored switch names workshop (plan step 4, §12).
const activeProfile = (onProduct, storedSwitch) => (onProduct && storedSwitch !== "workshop" ? "product" : "workshop");

const sameNav = (a, b) => a.length === b.length && a.every((r, i) => r.path === b[i].path && r.hidden === b[i].hidden);

// A shallow role -> component comparison: same keys, same chosen component.
const sameEditors = (a, b) => {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
};

const same = (a, b) =>
  sameNav(a.nav, b.nav) &&
  a.viewportSwitchHidden === b.viewportSwitchHidden &&
  a.layoutSwitchHidden === b.layoutSwitchHidden &&
  a.arranging === b.arranging &&
  a.vimKeys === b.vimKeys &&
  sameEditors(a.editors, b.editors);

// The active copy, and the news about it: every emit and reply carries the copy
// plus the profile it belongs to (§12).
const active = (context) => context.copies[context.profile];
const changed = emit(({ context }) => ({ type: "settings.changed", ...active(context), profile: context.profile }));

export const machine = setup({}).createMachine({
  id: "settings",
  meta: {
    kind: "fact",
    shape: "local-only",
    emits: ["settings.changed"],
    owns: "the user's page preferences, one copy per profile (product and workshop): the order and visibility of pages in the navigation, whether the viewport switch and the layout switch are shown, whether the desk layout is being arranged, and whether editors take Vim keys; it reports the active profile's copy",
  },
  context: ({ input }) => ({
    onProduct: input.product,
    profile: activeProfile(input.product, input.stored.profile),
    copies: {
      workshop: parse(input.stored.workshop, DEFAULT),
      product: parse(input.stored.product, PRODUCT_DEFAULT),
    },
    save: input.save,
  }),
  on: {
    // The gesture from settings-sheet, consumed as an event (4.3): the sheet emits
    // the whole settings, the fact never merges. It lands in the active copy only,
    // so a choice in one profile never leaks into the other (§12). Guarded so a
    // repeat writes, saves and announces nothing.
    "settings.edited": {
      guard: ({ context, event }) => !same(clean(event), active(context)),
      actions: [
        assign({ copies: ({ context, event }) => ({ ...context.copies, [context.profile]: clean(event) }) }),
        ({ context }) => context.save[context.profile](JSON.stringify(active(context))),
        changed,
      ],
    },
    // The gesture from layout-switch, on the active copy. Guarded out when the
    // switch is hidden (the desk is not arrangeable, so arranging cannot be turned
    // on) and on a no-op.
    "layout.switched": {
      guard: ({ context, event }) => !active(context).layoutSwitchHidden && event.arranging !== active(context).arranging,
      actions: [
        assign({
          copies: ({ context, event }) => ({
            ...context.copies,
            [context.profile]: clean({ ...active(context), arranging: event.arranging }),
          }),
        }),
        ({ context }) => context.save[context.profile](JSON.stringify(active(context))),
        changed,
      ],
    },
    // The gesture from profile-switch, the one door from the product (§12): only on
    // the product page, and only a real change. It activates the other copy and
    // remembers the switch; the activated copy rides out on settings.changed.
    "profile.switched": {
      guard: ({ context, event }) => context.onProduct && event.profile !== context.profile,
      actions: [
        assign({ profile: ({ event }) => event.profile }),
        ({ context }) => context.save.profile(context.profile),
        changed,
      ],
    },
    "read?": {
      actions: ({ context, event }) =>
        event.reply({ ...active(context), nav: active(context).nav.map((r) => ({ ...r })), profile: context.profile }),
    },
  },
});
