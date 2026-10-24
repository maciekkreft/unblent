import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// A view component (3.1): the sheet that edits the user's page preferences. It owns
// no fact; the preferences belong to `settings`, reached by one query for the
// starting picture and settings.changed after (4.3, fourth rule), and the pages by
// `pages: list`. Once ready, every gesture computes the whole settings and emits
// settings.edited; nothing is assigned locally, settings.changed is the only
// assignment. `current` and the ask arrive through `input`, so the machine never
// touches `window` and imports in Node.

// The navigation as rows: listed paths first in nav order (keeping only pages that
// exist), then unlisted pages in pages order, shown. Each row carries its title.
// Duplicated in page-nav (task 4); components never import each other (11.2).
export const merge = (pages, nav) => {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const rows = [];
  const seen = new Set();
  for (const n of nav) {
    const p = byPath.get(n.path);
    if (p && !seen.has(n.path)) {
      seen.add(n.path);
      rows.push({ path: p.path, title: p.title, hidden: n.hidden });
    }
  }
  for (const p of pages) {
    if (!seen.has(p.path)) {
      seen.add(p.path);
      rows.push({ path: p.path, title: p.title, hidden: false });
    }
  }
  return rows;
};

// A full settings object with nav materialised from rows: reordering or hiding one
// page writes every page's position, so the order is stable whatever changes next.
const withNav = (settings, rows) => ({ ...settings, nav: rows.map((r) => ({ path: r.path, hidden: r.hidden })) });

const swap = (rows, i, j) => {
  const next = [...rows];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

const rowsOf = (context) => merge(context.pages, context.settings.nav);
const indexOf = (context, path) => rowsOf(context).findIndex((r) => r.path === path);

const edited = (settings) => ({ type: "settings.edited", ...settings });
// Remove on a key field begins the undo window; nothing is emitted until it ends.
const startRemoval = (field) =>
  enqueueActions(({ context, enqueue }) => {
    enqueue.assign({ removing: [...context.removing, field] });
    enqueue.raise({ type: "_removeElapsed", field }, { delay: context.undoMs, id: `remove:${field}` });
  });
// An account gesture (7.7): the changed field only, which `llm` saves and announces.
const llmEdited = (patch) => ({ type: "llm.edited", ...patch });
// A tool switch gesture (7.7): the flipped switch only, which `conversations` merges
// into the account's tool preferences and announces tools.changed.
const toolsEdited = (key, on) => ({ type: "tools.edited", tools: { [key]: on } });

// The tools the chat may offer the model (7.7): the queries whose owners marked them as
// tools, from `catalog: contracts`. Each is one switch: its key `"target: name"`, the
// person's label and the description. Sorted by key so the list is stable, matching the
// order `conversations` offers them in.
const toolsFrom = (contracts) => {
  const queries = (contracts && contracts.queries) || [];
  return queries
    .filter((q) => q.tool)
    .map((q) => ({ key: `${q.target}: ${q.name}`, label: q.tool.label, description: q.tool.description }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
};
const setHidden = (context, path, hidden) => {
  const rows = rowsOf(context).map((r) => (r.path === path ? { ...r, hidden } : r));
  return edited(withNav(context.settings, rows));
};

// --- Choice point checks ------------------------------------------------------------

// The four boxes of a choice point, in the order choice-point-cards shows them, with its
// labels, so Settings names a box the way the sheet does.
export const BOXES = [
  { field: "away", label: "Away · hooked" },
  { field: "towards", label: "Towards · unhooked" },
  { field: "situation", label: "Situation" },
  { field: "thoughts", label: "Thoughts & feelings" },
];
const NO_BOX = { evaluator: null, questions: [], also: [] };
const live = (items) => (Array.isArray(items) ? items : []).filter((x) => x && !x.removing);

// The answers a question can get: a pick question's options, or Yes and No; the value is
// what checks.edited carries for it (an option id, or yes / no).
export const answersOf = (q) =>
  q.kind === "pick"
    ? live(q.options).map((o) => ({ id: o.id, name: o.name }))
    : [
        { id: "yes", name: "Yes" },
        { id: "no", name: "No" },
      ];

// checks.edited still requires `expect` and `icons`; the evaluator holds both now, so a
// new setting writes neither and a stored one passes through untouched.
const unset = (id, show) => ({ id, show, expect: null, when: null, icons: {} });

// One box as Settings shows and edits it: a setting for every live question of its
// evaluator, in the evaluator's order. A question the box holds no setting for is not
// shown (checks.edited), so a question added to the evaluator later starts unticked.
export const boxView = (box, evaluator) => ({
  evaluator: box?.evaluator ?? null,
  questions: live(evaluator?.questions).map((q) => {
    const s = (box?.questions ?? []).find((x) => x.id === q.id);
    return s ? { ...s, icons: { ...s.icons } } : unset(q.id, false);
  }),
  also: (box?.also ?? []).map((a) => ({ evaluator: a.evaluator, questions: a.questions.map((q) => ({ ...q, icons: { ...q.icons } })) })),
});

// The further evaluator chosen under Also check with, as checks.edited carries it: a
// combined evaluator (Your values) with no question settings, since every question counts
// toward its one mark; any other with every question shown, since Settings offers one
// further evaluator per box and no per-question choice for it.
const alsoOf = (evaluator) =>
  evaluator ? [{ evaluator: evaluator.id, questions: evaluator.combined ? [] : live(evaluator.questions).map((q) => unset(q.id, true)) }] : [];
const withoutMain = (also, main) => also.filter((a) => a.evaluator !== main);

const evaluatorOf = (context, id) => (id ? context.evaluators.find((e) => e.id === id) : undefined);
const shownBox = (context, field) => {
  const b = context.checks?.[field] ?? NO_BOX;
  return boxView(b, evaluatorOf(context, b.evaluator));
};
const checksEdited = (field, b) => ({ type: "checks.edited", field, evaluator: b.evaluator, questions: b.questions, also: b.also ?? [] });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One question's setting changed: the whole box, as checks.edited carries it.
// Only Show and when it is shown are set here; the answer expected is the evaluator's.
const patched = (context, event) => {
  const b = shownBox(context, event.field);
  const { show, when } = event.patch ?? {};
  const patch = { ...(typeof show === "boolean" ? { show } : {}), ...(when !== undefined ? { when } : {}) };
  return { ...b, questions: b.questions.map((q) => (q.id === event.id ? { ...q, ...patch } : q)) };
};

// Choosing an evaluator for a box: every question shown; or, if this
// box had that evaluator earlier while the sheet was open, its settings then, so choosing
// the previous evaluator again undoes the switch in one step (forgiveness). The further
// evaluator stays across a switch; Not checked clears it with the rest, and choosing the
// earlier evaluator again brings it back with the other settings.
const chosen = (context, event) => {
  if (!event.evaluator) return { ...NO_BOX };
  const current = shownBox(context, event.field);
  const past = context.past[`${event.field} ${event.evaluator}`];
  const evaluator = evaluatorOf(context, event.evaluator);
  const b = past
    ? boxView(past, evaluator)
    : { evaluator: event.evaluator, questions: live(evaluator?.questions).map((q) => unset(q.id, true)), also: [] };
  return { ...b, also: withoutMain(current.evaluator ? current.also : b.also, event.evaluator) };
};

// Choosing the further evaluator of a box, or None (null) to drop it again.
const alsoChosen = (context, event) => ({ ...shownBox(context, event.field), also: alsoOf(evaluatorOf(context, event.evaluator)) });

const DEFAULT = { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: false, editors: {} };

const adopt = (event) => ({
  nav: event.nav.map((r) => ({ ...r })),
  viewportSwitchHidden: event.viewportSwitchHidden,
  layoutSwitchHidden: event.layoutSwitchHidden,
  arranging: event.arranging,
  vimKeys: event.vimKeys === true,
  editors: { ...(event.editors ?? {}) },
});

// The role a member fills, keyed by tag for the default and by data-role for a
// swapped-in member; the sheet only needs the members of a role to list them.
const membersByRole = (components) => {
  const roles = {};
  for (const c of components ?? []) {
    if (c.role) (roles[c.role] ??= []).push(c.name);
  }
  return roles;
};

export const machine = setup({
  actors: {
    pages: fromPromise(({ input }) => input.ask("pages", "list", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    catalog: fromPromise(({ input }) => input.ask("catalog", "list", {})),
    llm: fromPromise(({ input }) => input.ask("llm", "read", {})),
    contracts: fromPromise(({ input }) => input.ask("catalog", "contracts", {})),
    tools: fromPromise(({ input }) => input.ask("conversations", "tools", {})),
    checks: fromPromise(({ input }) => input.ask("choice-point-checks", "read", {})),
    evaluators: fromPromise(({ input }) => input.ask("evaluators", "list", {})),
  },
}).createMachine({
  id: "settings-sheet",
  meta: {
    description:
      "The Settings sheet, in two sections. This device holds the preferences `settings` keeps: " +
      "page order and visibility, the switches, and Vim keys. Your account holds the chat " +
      "settings `llm` keeps (provider, model, thinking effort, cache lifetime, the API key) and " +
      "which lookups the chat may use, which `conversations` keeps. Every change is saved at " +
      "once by the fact that owns it. Your account also holds the Jev key, which `llm` keeps. " +
      "Echo is offered as a provider only in the workshop profile. Your account also holds the " +
      "choice point checks, which `choice-point-checks` keeps, in a fold that starts closed: " +
      "for each box of a choice point, the evaluator whose questions Jev answers about each " +
      "line, and per question whether its answer is shown, when (always, or only when an " +
      "earlier question got a given answer); the answer expected and the icon a mark shows are " +
      "the evaluator's own, chosen in the evaluator. Every change saves the whole box at once and Jev checks the day on screen again. " +
      "Choosing an evaluator ticks all its questions; choosing a box's " +
      "earlier evaluator again while the sheet is open brings back its settings. While a box " +
      "has an evaluator, Also check with under its questions chooses one more evaluator, such " +
      "as Your values, whose questions Jev answers about the same lines in the same request; " +
      "it has no per-question settings, since every value of Your values counts toward its one " +
      "mark, and None takes it away again. It stays when the box's evaluator is switched, and " +
      "Not checked clears it with the rest. The part is " +
      "hidden on a page without `choice-point-checks`. The Vim keys list names the chat box " +
      "only on a page where `conversations` answers, so the Mac page never mentions it. Remove on the API key or the Jev key " +
      "waits out the undo window: the row reads Key removed with an Undo and a draining " +
      "bar, and the key is removed only when the window ends; leaving the page before then " +
      "keeps it. The last line of the sheet, on every page, reads \"Something not working, or an " +
      "idea? Send feedback\": the link opens the project's form chooser for a new issue in a new " +
      "tab, or in the Mac app in the user's browser, and fills nothing in.",
    kind: "view",
    emits: ["settings.edited", "llm.edited", "tools.edited", "checks.edited"],
    // `account` (7.7): with it the sheet shows the "Your account" section beside
    // "This device"; without it, the page-links sheet exactly as before.
    attributes: ["account"],
    asks: [
      "pages: list",
      "settings: read",
      "catalog: list",
      "llm: read",
      "catalog: contracts",
      "conversations: tools",
      "choice-point-checks: read",
      "evaluators: list",
    ],
  },
  // The active profile (§12), adopted from settings; a page without settings
  // stays in `workshop`, the full sheet, exactly as before profiles existed.
  // `account` is off unless the page set the attribute; `llm` is the account
  // picture (7.7), asked only when the account section is shown, null otherwise.
  context: ({ input }) => ({
    ask: input.ask,
    current: input.current,
    account: Boolean(input.account),
    pages: [],
    settings: { ...DEFAULT },
    roles: {},
    profile: "workshop",
    llm: null,
    // The tool switches (7.7), shown only in the account section: the list of tools from
    // `catalog: contracts` and which are on. A tool missing from `tools` is on; a tool set
    // false is off. `tools.changed` keeps the map current after the starting ask (4.3).
    toolList: [],
    tools: {},
    // Whether this page has a chat: `conversations` answered its tools ask. The Vim keys
    // list names the chat box only then, so it describes only what the page holds.
    chat: false,
    // The choice point checks: the four boxes' settings, or null when no fact answers
    // (the part is then hidden); every book's evaluators to choose from; and, per box and
    // evaluator, the settings a box had before its evaluator was switched this session.
    checks: null,
    evaluators: [],
    past: {},
    // A key removal waits out the undo window (12, forgiveness): `removing` names the
    // key fields ("key", "jevKey") in their window, `removed` those whose removal went out
    // and whose new llm picture has not come yet, so the row does not read Key saved in
    // between.
    undoMs: input.undoMs ?? 3000,
    removing: [],
    removed: [],
  }),
  initial: "loadingPages",
  states: {
    loadingPages: {
      invoke: {
        src: "pages",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "failed" },
          { target: "loadingSettings", actions: assign({ pages: ({ event }) => event.output.pages }) },
        ],
        onError: { target: "failed" },
      },
    },
    loadingSettings: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "failed" },
          {
            target: "loadingCatalog",
            actions: assign({
              settings: ({ event }) => adopt(event.output),
              profile: ({ event, context }) => event.output.profile ?? context.profile,
            }),
          },
        ],
        onError: { target: "failed" },
      },
    },
    // The catalog names the role members to offer in each swap select; it is
    // optional, so a page without it, or an offline catalog, leaves roles empty
    // and the sheet simply shows no swap selects.
    loadingCatalog: {
      invoke: {
        src: "catalog",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "afterCatalog" },
          { target: "afterCatalog", actions: assign({ roles: ({ event }) => membersByRole(event.output.components) }) },
        ],
        onError: { target: "afterCatalog" },
      },
    },
    // The account picture (7.7) is asked only when the page shows the account
    // section; every other page skips the ask and goes straight to ready.
    afterCatalog: {
      always: [
        { guard: ({ context }) => context.account, target: "loadingLlm" },
        { target: "ready" },
      ],
    },
    loadingLlm: {
      invoke: {
        src: "llm",
        input: ({ context }) => ({ ask: context.ask }),
        // A signed-out or no-answerer reply leaves `llm` null, so the account
        // section shows "Sign in to set up the chat." (7.7); llm.changed corrects
        // it after (4.3).
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "loadingContracts" },
          { target: "loadingContracts", actions: assign({ llm: ({ event }) => event.output }) },
        ],
        onError: { target: "loadingContracts" },
      },
    },
    // The tool switches (7.7): the list of tools from the contracts, then which are on
    // from the loop. Both are optional — an offline catalog or a signed-out account leaves
    // the list empty, and the account section simply shows no switches.
    loadingContracts: {
      invoke: {
        src: "contracts",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "loadingTools" },
          { target: "loadingTools", actions: assign({ toolList: ({ event }) => toolsFrom(event.output) }) },
        ],
        onError: { target: "loadingTools" },
      },
    },
    loadingTools: {
      invoke: {
        src: "tools",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "loadingChecks" },
          {
            target: "loadingChecks",
            actions: assign({ tools: ({ event }) => ({ ...event.output.tools }), chat: true }),
          },
        ],
        onError: { target: "loadingChecks" },
      },
    },
    // The choice point checks: optional like the tools. A page without the fact replies
    // no-answerer, `checks` stays null and the part is not shown.
    loadingChecks: {
      invoke: {
        src: "checks",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "ready" },
          { target: "loadingEvaluators", actions: assign({ checks: ({ event }) => event.output.settings }) },
        ],
        onError: { target: "ready" },
      },
    },
    loadingEvaluators: {
      invoke: {
        src: "evaluators",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "ready" },
          { target: "ready", actions: assign({ evaluators: ({ event }) => event.output.evaluators }) },
        ],
        onError: { target: "ready" },
      },
    },
    // Every gesture emits the whole settings; the sheet adopts it back through
    // settings.changed. Nothing is assigned locally here (4.3, fourth rule).
    ready: {
      on: {
        _up: {
          guard: ({ context, event }) => indexOf(context, event.path) > 0,
          actions: emit(({ context, event }) => {
            const i = indexOf(context, event.path);
            return edited(withNav(context.settings, swap(rowsOf(context), i, i - 1)));
          }),
        },
        _down: {
          guard: ({ context, event }) => {
            const rows = rowsOf(context);
            const i = rows.findIndex((r) => r.path === event.path);
            return i >= 0 && i < rows.length - 1;
          },
          actions: emit(({ context, event }) => {
            const i = indexOf(context, event.path);
            return edited(withNav(context.settings, swap(rowsOf(context), i, i + 1)));
          }),
        },
        // The current page keeps no hide control: the sheet is the way back.
        _hide: {
          guard: ({ context, event }) => event.path !== context.current && indexOf(context, event.path) >= 0,
          actions: emit(({ context, event }) => setHidden(context, event.path, true)),
        },
        _show: {
          guard: ({ context, event }) => indexOf(context, event.path) >= 0,
          actions: emit(({ context, event }) => setHidden(context, event.path, false)),
        },
        _toggleViewport: {
          actions: emit(({ context }) =>
            edited({ ...context.settings, viewportSwitchHidden: !context.settings.viewportSwitchHidden }),
          ),
        },
        _toggleLayout: {
          actions: emit(({ context }) =>
            edited({ ...context.settings, layoutSwitchHidden: !context.settings.layoutSwitchHidden }),
          ),
        },
        _toggleVim: {
          actions: emit(({ context }) => edited({ ...context.settings, vimKeys: !context.settings.vimKeys })),
        },
        // Choose the implementation for a swappable role (3.6, 7.3): the whole
        // settings with this role's choice set, like every other gesture here.
        _setEditor: {
          actions: emit(({ context, event }) =>
            edited({
              ...context.settings,
              editors: { ...context.settings.editors, [event.role]: event.component },
            }),
          ),
        },
        _reset: { actions: emit(() => edited({ ...DEFAULT })) },
        // Account gestures (7.7): each emits only the field it changed; `llm` saves
        // it and announces llm.changed, which the sheet adopts below (4.3). An empty
        // key removes the stored key.
        _setProvider: { actions: emit(({ event }) => llmEdited({ provider: event.provider })) },
        _setModel: { actions: emit(({ event }) => llmEdited({ model: event.model })) },
        _saveKey: { actions: emit(({ event }) => llmEdited({ key: event.key })) },
        _removeKey: { guard: ({ context }) => !context.removing.includes("key"), actions: startRemoval("key") },
        // The Jev key, the same two gestures as the provider's key, under its own field.
        _saveJevKey: { actions: emit(({ event }) => llmEdited({ jevKey: event.key })) },
        _removeJevKey: { guard: ({ context }) => !context.removing.includes("jevKey"), actions: startRemoval("jevKey") },
        _setEffort: { actions: emit(({ event }) => llmEdited({ effort: event.effort })) },
        _setTtl: { actions: emit(({ event }) => llmEdited({ ttl: event.ttl })) },
        // Flip one tool switch (7.7): emit the flipped switch only; `conversations` saves
        // it and announces tools.changed, adopted below (4.3). Reversible by flipping back.
        _toggleTool: { actions: emit(({ event }) => toolsEdited(event.key, event.on)) },
        // The choice point checks: each gesture emits the whole box, and only when it
        // differs, since every checks.edited is saved and may cost Jev requests; the sheet
        // adopts it back through checks.changed (4.3).
        _setChecker: {
          guard: ({ context, event }) => context.checks !== null && (context.checks[event.field]?.evaluator ?? null) !== (event.evaluator || null),
          actions: [
            assign({
              past: ({ context, event }) => {
                const b = context.checks[event.field];
                return b?.evaluator ? { ...context.past, [`${event.field} ${b.evaluator}`]: b } : context.past;
              },
            }),
            emit(({ context, event }) => checksEdited(event.field, chosen(context, event))),
          ],
        },
        _setAlso: {
          guard: ({ context, event }) => context.checks !== null && !same(alsoChosen(context, event), shownBox(context, event.field)),
          actions: emit(({ context, event }) => checksEdited(event.field, alsoChosen(context, event))),
        },
        _setQuestion: {
          guard: ({ context, event }) => context.checks !== null && !same(patched(context, event), shownBox(context, event.field)),
          actions: emit(({ context, event }) => checksEdited(event.field, patched(context, event))),
        },
      },
    },
    failed: {},
  },
  on: {
    _undoRemove: {
      guard: ({ context, event }) => context.removing.includes(event.field),
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.cancel(`remove:${event.field}`);
        enqueue.assign({ removing: context.removing.filter((f) => f !== event.field) });
      }),
    },
    // The window ended: now the empty key goes out, which removes it (llm.edited).
    _removeElapsed: {
      guard: ({ context, event }) => context.removing.includes(event.field),
      actions: [
        assign({
          removing: ({ context, event }) => context.removing.filter((f) => f !== event.field),
          removed: ({ context, event }) => [...context.removed, event.field],
        }),
        emit(({ event }) => llmEdited({ [event.field]: "" })),
      ],
    },
    "settings.changed": {
      actions: assign({
        settings: ({ event }) => adopt(event),
        profile: ({ event, context }) => event.profile ?? context.profile,
      }),
    },
    // The account picture, followed after the starting ask (4.3): a save, a sign-in
    // or a sign-out arrives here. Only the fields the reply carries, so type is
    // dropped by taking them by name.
    "llm.changed": {
      actions: assign({
        removed: [],
        llm: ({ event }) => ({
          signedIn: event.signedIn,
          provider: event.provider,
          providers: event.providers,
          model: event.model,
          models: event.models,
          effort: event.effort,
          efforts: event.efforts,
          ttl: event.ttl,
          ...(event.jev ? { jev: event.jev } : {}),
        }),
      }),
    },
    // The tool preferences, followed after the starting ask (4.3): a flip here or on
    // another device arrives as the whole map, adopted as the switch states.
    "tools.changed": {
      actions: assign({ tools: ({ event }) => ({ ...event.tools }) }),
    },
    // The choice point checks and the evaluators, followed after the starting asks (4.3).
    "checks.changed": {
      actions: assign({ checks: ({ event }) => event.settings }),
    },
    // Consumed only because it supersedes `choice-point-checks: read` (4.2); the sheet
    // shows no line's answers. XState drops a transition with no action, so it has an
    // empty one.
    "lines.checked": { actions: () => {} },
    "evaluator.changed": {
      actions: assign({
        evaluators: ({ context, event }) =>
          context.evaluators.some((e) => e.id === event.evaluator.id)
            ? context.evaluators.map((e) => (e.id === event.evaluator.id ? event.evaluator : e))
            : [...context.evaluators, event.evaluator],
      }),
    },
    "evaluator.deleted": {
      actions: assign({ evaluators: ({ context, event }) => context.evaluators.filter((e) => e.id !== event.id) }),
    },
  },
});
