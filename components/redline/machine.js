import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the text under review and the
// comments on it. redline-editor, where the user acts, emits the whole redline as
// redline.saved (4.3, fifth rule); this fact keeps it, saves it and announces it as
// redline.changed, and answers redline: read for the starting picture. The store
// arrives through `input`, so the machine is a pure definition importable in Node.

// Sanitise a candidate into the contract shape: the text as a string, and the
// comments that fit inside it, in reading order, none overlapping an earlier one. An
// empty text is no redline at all (null), whatever comments came with it.
export const normalise = (value) => {
  const text = typeof value?.text === "string" ? value.text : "";
  if (text === "") return null;
  const candidates = (Array.isArray(value.comments) ? value.comments : [])
    .filter(
      (c) =>
        c &&
        typeof c.id === "string" &&
        Number.isInteger(c.start) &&
        Number.isInteger(c.end) &&
        c.start >= 0 &&
        c.start < c.end &&
        c.end <= text.length &&
        typeof c.text === "string",
    )
    .sort((a, b) => a.start - b.start);
  const comments = [];
  for (const c of candidates) {
    if (comments.length && c.start < comments[comments.length - 1].end) continue;
    comments.push({ id: c.id, start: c.start, end: c.end, quote: text.slice(c.start, c.end), text: c.text });
  }
  return { text, comments };
};

// What the store held, or null for nothing, garbage, or an empty text.
export const parse = (stored) => {
  try {
    return normalise(JSON.parse(stored));
  } catch {
    return null;
  }
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const machine = setup({}).createMachine({
  id: "redline",
  meta: {
    description:
      "Owns the text under review and the comments on it, kept on this device. A comment is a " +
      "range of the source text; a comment that falls outside the text or overlaps an earlier " +
      "one is dropped, and an empty text means there is no redline.",
    kind: "fact",
    shape: "local-only",
    emits: ["redline.changed"],
    owns: "the text under review and the comments on it",
  },
  context: ({ input }) => ({ redline: parse(input.stored), save: input.save }),
  on: {
    // The gesture from redline-editor (4.3): the whole redline, never merged. Guarded so
    // a repeat saves and announces nothing.
    "redline.saved": {
      guard: ({ context, event }) => !same(normalise(event), context.redline),
      actions: [
        assign({ redline: ({ event }) => normalise(event) }),
        ({ context }) => context.save(context.redline ? JSON.stringify(context.redline) : ""),
        emit(({ context }) => ({ type: "redline.changed", redline: context.redline })),
      ],
    },
    "read?": {
      actions: ({ context, event }) => event.reply({ redline: context.redline }),
    },
  },
});
