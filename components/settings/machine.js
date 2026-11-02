import { setup, assign, emit, enqueueActions } from "xstate";
import { ulid } from "ulid";

// A local-only fact component (3.1): headless owner of the user's page
// preferences — the order and visibility of pages in the navigation, whether the
// viewport switch and the layout switch are shown, whether the desk layout is
// being arranged, whether editors take Vim keys, and whether the open note and chat
// stay when the stage changes. It keeps two independent
// copies (§12), one per profile (product and workshop), and reports the active one
// through settings: read and settings.changed; a view takes its starting picture by
// query (4.3) and follows settings.changed after. The stores arrive through `input`,
// so the machine is a pure definition importable in Node.

// Each profile has its own defaults: the workshop is the full development surface,
// the product hides the switches and does not arrange (§12, plan step 6).
const DEFAULT = { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: false, keepOpen: false, editors: {} };
const PRODUCT_DEFAULT = { nav: [], viewportSwitchHidden: true, layoutSwitchHidden: true, arranging: false, vimKeys: false, keepOpen: false, editors: {} };

// Stored editor choices naming a component that no longer exists, by role and
// component, with whether that choice meant "I want Vim" (12): such a choice is dropped
// and, if it meant Vim, turns vimKeys on in its place. Once dropped it is gone from what
// is next saved, so this happens once per device and profile.
const RETIRED = {
  "note-editor": { "note-editor-cm6": true, "note-editor": false },
  "highlight-notes": { "highlight-notes-vim": true, "highlight-notes": false },
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
    keepOpen: v.keepOpen === true,
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
  a.keepOpen === b.keepOpen &&
  sameEditors(a.editors, b.editors);

// The active copy, and the news about it: every emit and reply carries the copy
// plus the profile it belongs to (§12).
const active = (context) => context.copies[context.profile];
const changed = emit(({ context }) => ({ type: "settings.changed", ...active(context), profile: context.profile }));

// --- Steps (12, Undo) -------------------------------------------------------------------

const FIELDS = ["nav", "viewportSwitchHidden", "layoutSwitchHidden", "arranging", "vimKeys", "keepOpen", "editors"];
const sameField = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What a step is about, as people read it after "Undo:".
const LABELS = {
  vimKeys: (v) => `switch Vim keys ${v ? "on" : "off"}`,
  keepOpen: (v) => `${v ? "keep" : "stop keeping"} the open note and chat`,
  viewportSwitchHidden: (v) => `${v ? "hide" : "show"} the viewport switch`,
  layoutSwitchHidden: (v) => `${v ? "hide" : "show"} the layout switch`,
  arranging: (v) => `${v ? "start" : "stop"} arranging the desk`,
  nav: () => "change the page list",
  editors: () => "choose an editor",
};
const labelOf = (fields, after) => (fields.length === 1 ? LABELS[fields[0]](after[fields[0]]) : "change the settings");

// `prior` is the step that wrote the copy before this one, so an Undo leaves the copy as
// that step left it and the step before can be undone next; a copy no step of this
// browser wrote is left stamped with a mark of the step undone.
const priorOf = (step) => (typeof step === "string" ? { prior: step } : {});
const priorStamp = (p, step) => p.prior ?? `^${step}`;

// The copy and the step that last wrote it, as this browser holds them now: read again
// from storage when it can be, so a step another tab took is seen (12, Undo).
function held(context, profile) {
  const stored = context.load?.[profile]?.();
  if (typeof stored !== "string") return { copy: context.copies[profile], stamp: context.stamps[profile] };
  return { copy: parse(stored, context.copies[profile]), stamp: context.stampLoad?.[profile]?.() ?? undefined };
}

function write(context, enqueue, profile, copy, stamp) {
  context.copies = { ...context.copies, [profile]: copy };
  context.stamps = { ...context.stamps, [profile]: stamp };
  enqueue.assign({ copies: context.copies, stamps: context.stamps });
  enqueue(() => context.save[profile](JSON.stringify(copy)));
  enqueue(() => context.stampSave?.[profile]?.(stamp));
  if (profile === context.profile) enqueue.emit({ type: "settings.changed", ...copy, profile });
}

// One change in Settings is one step, on the copy of the profile it was made in (12).
function applyEdit(context, event, enqueue) {
  const before = active(context);
  const after = clean(event);
  if (same(after, before)) return;
  const fields = FIELDS.filter((f) => !sameField(before[f], after[f]));
  const profile = context.profile;
  const prior = held(context, profile).stamp;
  const id = context.mint();
  write(context, enqueue, profile, after, id);
  const pick = (copy) => Object.fromEntries(fields.map((f) => [f, copy[f]]));
  enqueue.emit({
    type: "step.recorded",
    id,
    owner: "settings",
    label: labelOf(fields, after),
    undo: { kind: "settings", profile, fields: pick(before), ...priorOf(prior) },
    redo: { kind: "settings", profile, fields: pick(after), ...priorOf(prior) },
  });
}

// An Undo or Redo of one of this fact's steps, applied only while the copy is as the step
// left it: last written in this browser by that step. Arranging on or off from the layout
// switch keeps the stamp, since it is no step; anything else written since refuses it.
function applyStep(context, event, enqueue) {
  if (event.owner !== "settings") return;
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "settings", outcome, ...(reason ? { reason } : {}) });
  const p = event.payload ?? {};
  if (p.kind !== "settings" || !(p.profile in context.copies) || !p.fields || typeof p.fields !== "object") return settle("refused", "changed");
  const undoing = event.type === "step.undone";
  const { copy, stamp } = held(context, p.profile);
  if (stamp !== (undoing ? event.id : priorStamp(p, event.id))) return settle("refused", "changed");
  const fields = Object.fromEntries(Object.entries(p.fields).filter(([f]) => FIELDS.includes(f)));
  write(context, enqueue, p.profile, clean({ ...copy, ...fields }), undoing ? priorStamp(p, event.id) : event.id);
  settle("applied");
}

export const machine = setup({}).createMachine({
  id: "settings",
  meta: {
    description:
      "Owns this device's preferences: the order and visibility of pages in the navigation, " +
      "whether the viewport and layout switches are shown, whether the desk is being arranged, " +
      "whether editors use Vim keys, whether the open note and chat stay open when the stage " +
      "changes (off at first, so they follow the stage), and which profile is active. It keeps one copy per " +
      "profile, `product` and `workshop`; the product hides the switches and does not arrange. " +
      "Hiding the layout switch also turns arranging off. These follow the device, not the " +
      "account. Each change made in Settings is a step Undo and Redo reverse (section 12), on " +
      "the copy of the profile it was made in; arranging on or off from the layout switch and " +
      "the profile switch are not. A step is refused when that copy was written since by " +
      "anything else, here or in another tab.",
    kind: "fact",
    shape: "local-only",
    emits: ["settings.changed", "step.recorded", "step.settled"],
    owns: "the user's page preferences, one copy per profile (product and workshop): the order and visibility of pages in the navigation, whether the viewport switch and the layout switch are shown, whether the desk layout is being arranged, whether editors take Vim keys, and whether the open note and chat are kept when the stage changes; it reports the active profile's copy",
    steps: {
      "settings.edited": "step",
      "layout.switched": "navigation",
      "profile.switched": "identity",
    },
  },
  context: ({ input }) => ({
    onProduct: input.product,
    profile: activeProfile(input.product, input.stored.profile),
    copies: {
      workshop: parse(input.stored.workshop, DEFAULT),
      product: parse(input.stored.product, PRODUCT_DEFAULT),
    },
    save: input.save,
    // The step that last wrote each copy in this browser (12, Undo), kept beside it.
    stamps: { workshop: input.stamps?.workshop ?? undefined, product: input.stamps?.product ?? undefined },
    stampLoad: input.stampLoad,
    stampSave: input.stampSave,
    load: input.load,
    mint: input.mint ?? ulid,
  }),
  on: {
    // The gesture from settings-sheet, consumed as an event (4.3): the sheet emits
    // the whole settings, the fact never merges. It lands in the active copy only,
    // so a choice in one profile never leaks into the other (§12). Guarded so a
    // repeat writes, saves and announces nothing.
    "settings.edited": {
      actions: enqueueActions(({ context, event, enqueue }) => applyEdit(context, event, enqueue)),
    },
    "step.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
    "step.redone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
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
