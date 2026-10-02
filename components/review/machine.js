import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the text under review and the
// comments on it. review-editor, where the user acts, emits the whole review as
// review.saved (4.3, fifth rule); this fact keeps it, saves it and announces it as
// review.changed, and answers review: read for the starting picture. The store
// arrives through `input`, so the machine is a pure definition importable in Node.

// Sanitise a candidate into the contract shape: the text as a string, and the
// comments that fit inside it, in reading order, none overlapping an earlier one. An
// empty text is no review at all (null), whatever comments came with it.
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
  id: "review",
  meta: {
    kind: "fact",
    shape: "local-only",
    emits: ["review.changed"],
    owns: "the text under review and the comments on it",
  },
  context: ({ input }) => ({ review: parse(input.stored), save: input.save }),
  on: {
    // The gesture from review-editor (4.3): the whole review, never merged. Guarded so
    // a repeat saves and announces nothing.
    "review.saved": {
      guard: ({ context, event }) => !same(normalise(event), context.review),
      actions: [
        assign({ review: ({ event }) => normalise(event) }),
        ({ context }) => context.save(context.review ? JSON.stringify(context.review) : ""),
        emit(({ context }) => ({ type: "review.changed", review: context.review })),
      ],
    },
    "read?": {
      actions: ({ context, event }) => event.reply({ review: context.review }),
    },
  },
});
