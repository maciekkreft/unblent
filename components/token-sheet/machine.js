import { createMachine, assign } from "xstate";

// Order is render order.
const KNOWN_GROUPS = [
  "color",
  "font",
  "text",
  "leading",
  "weight",
  "space",
  "radius",
  "shadow",
  "border",
  "focus",
  "duration",
  "ease",
];

// An unknown family lands in `other`, so a newly added family is shown
// rather than silently dropped.
export function groupByPrefix(tokens) {
  const buckets = new Map(KNOWN_GROUPS.map((k) => [k, []]));
  buckets.set("other", []);
  for (const token of tokens) {
    const family = token.name.split("-")[2];
    const key = buckets.has(family) ? family : "other";
    buckets.get(key).push(token);
  }
  return [...buckets]
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => ({ name, tokens: items }));
}

// Section 7.3: consumes, accepts and answers are derived from the handlers;
// shape is metadata of fact components only.
export const machine = createMachine({
  id: "token-sheet",
  meta: { kind: "view", emits: [], attributes: [] },
  context: ({ input }) => ({ collect: input.collect, groups: groupByPrefix(input.collect()) }),
  on: {
    // Section 4.3, fourth rule: the starting picture comes from the stylesheet;
    // after that, re-read it whenever the scheme changes so values follow.
    "color-scheme.changed": {
      actions: assign({ groups: ({ context }) => groupByPrefix(context.collect()) }),
    },
  },
});
