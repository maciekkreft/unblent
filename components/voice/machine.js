import { setup, enqueueActions } from "xstate";
import { ulid } from "ulid";

// A remote-only fact component (3.1): the picture lives on this component's own server
// module, and every request reaches it through `input`, so the machine is a pure
// definition importable in Node. Nothing is kept in the browser but the last picture the
// server answered, so a change can be told from a repeat.

const isPicture = (value) => (value?.here === "mac" || value?.here === "web") && typeof value.voice === "string" && Array.isArray(value.voices);
const errorOf = (value) => (typeof value?.error === "string" ? value.error : "unavailable");
const downloading = (picture) => picture?.kokoro?.state === "downloading";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A key never enters a step (7.7): the server keeps the key from before and the key
// after under the step's id, so the step says only which of the two to bring back and
// which it expects to find.
const KEY_UNDO = { kind: "key", restore: "before", expect: "after" };
const KEY_REDO = { kind: "key", restore: "after", expect: "before" };

const voiceName = (picture, id) => picture?.voices?.find((v) => v.id === id)?.label ?? id;

// What the server answered, handed back as an internal message, so every decision is
// made in the mailbox (3.2).
function call(self, run, then) {
  Promise.resolve()
    .then(run)
    .then(
      (reply) => self.send({ type: "_answered", reply, ...then }),
      () => self.send({ type: "_answered", reply: null, ...then }),
    );
}

export const machine = setup({
  actions: {
    // The step's Undo or Redo (12, Undo): a voice is put back only while it is the one
    // the step left; a key is checked by the server, which alone holds it.
    applyStep: enqueueActions(({ context, event, enqueue, self }) => {
      const p = event.payload ?? {};
      const refuse = () => enqueue.emit({ type: "step.settled", id: event.id, owner: "voice", outcome: "refused", reason: "changed" });
      if (p.kind === "voice" && typeof p.voice === "string" && context.picture?.voice === p.expect) {
        enqueue(() => call(self, () => context.save({ voice: p.voice }), { settle: event.id }));
      } else if (p.kind === "key" && context.picture?.here === "web") {
        enqueue(() => call(self, () => context.moveKey({ step: event.id, restore: p.restore, expect: p.expect }), { settle: event.id }));
      } else refuse();
    }),
  },
}).createMachine({
  id: "voice",
  meta: {
    description:
      "Owns reading aloud: the voice picked, whether the Kokoro voice is downloaded on this " +
      "Mac, the account's Inworld key, and turning a paragraph into speech. On a Mac, " +
      "connected or not, it reads with the Kokoro voice on the Mac itself: Settings " +
      "downloads the voice once (about 354 MB, checked by its size and its sha256 before " +
      "it counts as ready) and then it works offline and costs nothing; Cancel stops the " +
      "download and keeps nothing; the voice picked is kept on this Mac. Words become " +
      "sounds through misaki's pronunciation dictionaries, numbers are written out in " +
      "words, and a word in neither is split at its hyphens and apostrophes or else " +
      "spelled letter by letter. On the website it reads with Inworld on the account's own " +
      "Inworld key, kept encrypted on the server and never sent back; the voice picked is " +
      "kept with the account. `voice: read` answers the picture and voice.changed announces " +
      "each change of it, every second while a download runs; `voice: speak` answers a " +
      "paragraph's audio with when each word is said, so the reader can light up the " +
      "spoken word, or an error (no-key, not-downloaded, unavailable). A voice picked and " +
      "a key added, replaced or removed in Settings (voice.edited) are each a step Undo " +
      "and Redo reverse, refused when it was changed since; a key change shows the short " +
      "notice with Undo, and the key is never part of the step: the server keeps the key " +
      "from before and after under the step's id and erases both once the step leaves the " +
      "undo list. Starting or cancelling the download is not a step. A test voice answers " +
      "with short silence and needs no key and no download, for tests; it is offered only " +
      "in the workshop profile.",
    kind: "fact",
    shape: "remote-only",
    owns: "reading aloud",
    emits: ["voice.changed", "step.recorded", "step.settled"],
  },
  context: ({ input }) => ({
    load: input.load,
    save: input.save,
    speak: input.speak,
    moveKey: input.moveKey,
    forgetKey: input.forgetKey,
    mint: input.mint ?? ulid,
    later: input.later ?? ((fn, ms) => setTimeout(fn, ms)),
    every: input.every ?? 1000,
    // The last picture the server answered; null until one came.
    picture: null,
    // Whether a poll of the download is waiting or under way, so only one ever is.
    polling: false,
  }),
  on: {
    // Each read asks the server again, so a picture changed in another tab is found.
    "read?": {
      actions: ({ context, event, self }) => {
        Promise.resolve()
          .then(() => context.load())
          .then(
            (reply) => {
              if (!isPicture(reply)) return event.reply({ error: errorOf(reply) });
              self.send({ type: "_answered", reply, quiet: true });
              event.reply(reply);
            },
            () => event.reply({ error: "unavailable" }),
          );
      },
    },
    "speak?": {
      actions: ({ context, event }) => {
        Promise.resolve()
          .then(() => context.speak(event.payload.text))
          .then(
            (reply) =>
              event.reply(
                typeof reply?.mime === "string" && typeof reply.audio === "string" && Array.isArray(reply.words)
                  ? { mime: reply.mime, audio: reply.audio, words: reply.words }
                  : { error: errorOf(reply) },
              ),
            () => event.reply({ error: "unavailable" }),
          );
      },
    },
    // A gesture in Settings: a voice picked, a key saved or removed, or the download
    // started or cancelled. Each part is sent on its own, so each records its own step.
    "voice.edited": {
      actions: enqueueActions(({ context, event, enqueue, self }) => {
        const was = context.picture;
        if (typeof event.voice === "string" && event.voice !== was?.voice) {
          const record = was ? { was: was.voice, voice: event.voice } : null;
          enqueue(() => call(self, () => context.save({ voice: event.voice }), { record }));
        }
        if (typeof event.key === "string" && was?.here !== "mac") {
          const set = was?.inworld?.keySet === true;
          if (event.key !== "" || set) {
            const key = { id: context.mint(), kind: event.key === "" ? "remove" : set ? "replace" : "add" };
            enqueue(() => call(self, () => context.save({ key: event.key, step: key.id }), { key }));
          }
        }
        if (event.download === "start" || event.download === "cancel")
          enqueue(() => call(self, () => context.save({ download: event.download }), {}));
      }),
    },
    // A change of account changes the picture on the website (3.4): it is read again
    // and announced.
    "session.changed": {
      guard: ({ event }) => !event.leaving,
      actions: ({ context, self }) => call(self, () => context.load(), { session: true }),
    },
    "step.undone": { guard: ({ event }) => event.owner === "voice", actions: "applyStep" },
    "step.redone": { guard: ({ event }) => event.owner === "voice", actions: "applyStep" },
    // The key step left the undo list: the server erases the keys it kept (7.7).
    "step.dropped": {
      guard: ({ context, event }) => event.owner === "voice" && event.payload?.kind === "key" && context.picture?.here === "web",
      actions: ({ context, event }) => Promise.resolve().then(() => context.forgetKey(event.id)).catch(() => {}),
    },
    _poll: {
      actions: ({ context, self }) => call(self, () => context.load(), { poll: true }),
    },
    _answered: {
      actions: enqueueActions(({ context, event, enqueue, self }) => {
        const reply = event.reply;
        if (!isPicture(reply)) {
          // No answer to an Undo leaves the step where it was: `undo` says so itself.
          if (event.settle) {
            if (reply?.error === "changed")
              enqueue.emit({ type: "step.settled", id: event.settle, owner: "voice", outcome: "refused", reason: "changed" });
          } else if (event.poll) {
            // A poll that found no server tries again while the download was running.
            if (downloading(context.picture)) enqueue(() => context.later(() => self.send({ type: "_poll" }), context.every));
            else enqueue.assign({ polling: false });
          } else if (event.session) enqueue.assign({ picture: null });
          // Nothing changed; saying so again lets a view put its control back.
          else if (!event.quiet && context.picture) enqueue.emit({ type: "voice.changed", ...context.picture });
          return;
        }
        const r = event.record;
        if (r && reply.voice === r.voice)
          enqueue.emit({
            type: "step.recorded",
            id: context.mint(),
            owner: "voice",
            label: `choose the voice ${voiceName(reply, r.voice)}`,
            undo: { kind: "voice", voice: r.was, expect: r.voice },
            redo: { kind: "voice", voice: r.voice, expect: r.was },
          });
        if (event.key)
          enqueue.emit({
            type: "step.recorded",
            id: event.key.id,
            owner: "voice",
            label: `${event.key.kind} the Inworld key`,
            notice: true,
            undo: KEY_UNDO,
            redo: KEY_REDO,
          });
        if (event.settle) enqueue.emit({ type: "step.settled", id: event.settle, owner: "voice", outcome: "applied" });
        // A read's answer is the starting picture of the one who asked; it is announced
        // only when it differs from what was known, so no one else hears a read.
        // A poll is announced when the download moved on; a gesture's answer always, so a
        // view puts its control where the server left it.
        const differs = !same(context.picture, reply);
        const announce = event.quiet ? differs && context.picture !== null : event.poll ? differs : true;
        if (announce) enqueue.emit({ type: "voice.changed", ...reply });
        enqueue.assign({ picture: reply });
        // One poll at a time is waiting while the download runs (`polling`): a poll's
        // answer sets the next one, and any other answer starts one only if none waits.
        if (downloading(reply) && (event.poll || !context.polling)) {
          enqueue.assign({ polling: true });
          enqueue(() => context.later(() => self.send({ type: "_poll" }), context.every));
        } else if (event.poll) enqueue.assign({ polling: false });
      }),
    },
  },
});
