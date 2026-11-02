import { setup, enqueueActions } from "xstate";
import { ulid } from "ulid";

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

// --- Steps (12, Undo) -------------------------------------------------------------------

// The comment a save only types in, by id, or null when it does more: a comment newly
// made or a comment's words changed, over the same text and the same ranges.
function typedIn(before, after) {
  if (!before || !after || before.text !== after.text) return null;
  const was = new Map(before.comments.map((c) => [c.id, c]));
  const changed = after.comments.filter((c) => {
    const w = was.get(c.id);
    return !w || w.text !== c.text || w.start !== c.start || w.end !== c.end;
  });
  if (changed.length !== 1 || after.comments.length < before.comments.length) return null;
  const w = was.get(changed[0].id);
  if (w && (w.start !== changed[0].start || w.end !== changed[0].end)) return null;
  if (!w && after.comments.length !== before.comments.length + 1) return null;
  return changed[0];
}

const QUOTE_MAX = 40;
const quoted = (c) => {
  const q = c.quote.replace(/\s+/g, " ").trim();
  return q.length > QUOTE_MAX ? `${q.slice(0, QUOTE_MAX).trimEnd()}…` : q;
};

// What a step is about, as people read it after "Undo:".
function labelOf(before, after, comment) {
  if (!after) return "clear the text";
  if (!before || before.text !== after.text) return "paste a text";
  if (comment) return `comment on “${quoted(comment)}”`;
  if (after.comments.length < before.comments.length) return "remove a comment";
  return "change the comments";
}

// `prior` is the step that wrote the redline before this one, so an Undo leaves it as that
// step left it and the step before can be undone next; a redline no step of this browser
// wrote is left stamped with a mark of the step undone.
const priorOf = (step) => (typeof step === "string" ? { prior: step } : {});
const priorStamp = (p, step) => p.prior ?? `^${step}`;

// The redline and the step that last wrote it, as this browser holds them now: read again
// from storage when it can be, so a step another tab took is seen.
function held(context) {
  const stored = context.load?.();
  if (typeof stored !== "string") return { redline: context.redline, stamp: context.stamp };
  return { redline: parse(stored), stamp: context.stampLoad?.() ?? undefined };
}

function write(context, enqueue, redline, stamp) {
  context.redline = redline;
  context.stamp = stamp;
  enqueue.assign({ redline, stamp });
  enqueue(() => context.save(redline ? JSON.stringify(redline) : ""));
  enqueue(() => context.stampSave?.(stamp));
  enqueue.emit({ type: "redline.changed", redline });
}

// Every save is a step (12, Undo). Typing on in the one comment the open stretch last
// wrote joins it, the same id with its undo kept, until the editor says the user left the
// comment (`left`) or anything else changes.
function applySaved(context, event, enqueue) {
  const after = normalise(event);
  const before = context.redline;
  if (!same(after, before)) {
    const comment = typedIn(before, after);
    const open = context.stretch;
    const joins = open && comment && open.comment === comment.id && context.stamp === open.id;
    const step = joins ? open : { id: context.mint(), before, prior: held(context).stamp };
    write(context, enqueue, after, step.id);
    enqueue.emit({
      type: "step.recorded",
      id: step.id,
      owner: "redline",
      label: labelOf(step.before, after, comment),
      undo: { kind: "redline", redline: step.before, ...priorOf(step.prior) },
      redo: { kind: "redline", redline: after, ...priorOf(step.prior) },
    });
    context.stretch = comment ? { ...step, comment: comment.id } : null;
  }
  if (event.left === true) context.stretch = null;
  enqueue.assign({ stretch: context.stretch });
}

// An Undo or Redo, applied only while the redline was last written in this browser by
// that step; anything written since, here or in another tab, refuses it.
function applyStep(context, event, enqueue) {
  if (event.owner !== "redline") return;
  context.stretch = null;
  enqueue.assign({ stretch: null });
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "redline", outcome, ...(reason ? { reason } : {}) });
  const p = event.payload ?? {};
  if (p.kind !== "redline" || !("redline" in p)) return settle("refused", "changed");
  const undoing = event.type === "step.undone";
  if (held(context).stamp !== (undoing ? event.id : priorStamp(p, event.id))) return settle("refused", "changed");
  write(context, enqueue, normalise(p.redline), undoing ? priorStamp(p, event.id) : event.id);
  settle("applied");
}

export const machine = setup({}).createMachine({
  id: "redline",
  meta: {
    description:
      "Owns the text under review and the comments on it, kept on this device. A comment is a " +
      "range of the source text; a comment that falls outside the text or overlaps an earlier " +
      "one is dropped, and an empty text means there is no redline. Each paste, comment, removed " +
      "comment and clear is a step Undo and Redo reverse (section 12); typing on in one " +
      "comment stays one step until the user leaves it. A step is refused when the redline " +
      "was written since by anything else, here or in another tab.",
    kind: "fact",
    shape: "local-only",
    emits: ["redline.changed", "step.recorded", "step.settled"],
    owns: "the text under review and the comments on it",
    steps: { "redline.saved": "step" },
  },
  context: ({ input }) => ({
    redline: parse(input.stored),
    save: input.save,
    // The step that last wrote the redline in this browser (12, Undo), kept beside it, and
    // the stretch of typing in one comment still open: { id, before, prior, comment }.
    stamp: input.stamp ?? undefined,
    stretch: null,
    load: input.load,
    stampLoad: input.stampLoad,
    stampSave: input.stampSave,
    mint: input.mint ?? ulid,
  }),
  on: {
    // The gesture from redline-editor (4.3): the whole redline, never merged. Guarded so
    // a repeat saves and announces nothing.
    "redline.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySaved(context, event, enqueue)) },
    "step.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
    "step.redone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
    "read?": {
      actions: ({ context, event }) => event.reply({ redline: context.redline }),
    },
  },
});
