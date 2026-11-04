import { setup } from "xstate";

// A remote-only fact component (3.1), planned (9, step 1): only its metadata and its
// contracts, so the components and contracts pages show it before it is built. The
// handlers below are named so the manifest reads what it answers and consumes; they
// do nothing yet.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "voice",
  meta: {
    description:
      "Owns reading aloud: the voice picked, whether the Kokoro voice is downloaded on this " +
      "Mac, the account's Inworld key, and turning a paragraph into speech. On a Mac, " +
      "connected or not, it reads with the Kokoro voice on the Mac itself: Settings " +
      "downloads the voice once (about 354 MB) and then it works offline and costs nothing; " +
      "the voice picked is kept on this Mac. On the website it reads with Inworld on the " +
      "account's own Inworld key, kept encrypted on the server and never sent back; the " +
      "voice picked is kept with the account. `voice: read` answers the picture and " +
      "voice.changed announces each change of it; `voice: speak` answers a paragraph's audio " +
      "with when each word is said, so the reader can light up the spoken word, or an error " +
      "(no key, not downloaded, unavailable). A change made in Settings (voice.edited) is a " +
      "step Undo and Redo reverse; a key change is undone without the key ever being part of " +
      "the step. A test voice answers with short silence and needs no key and no download, " +
      "for tests; it is offered only in the workshop profile.",
    kind: "fact",
    shape: "remote-only",
    owns: "reading aloud",
    emits: ["voice.changed", "step.recorded", "step.settled"],
  },
  on: {
    "read?": planned,
    "speak?": planned,
    "voice.edited": planned,
    "session.changed": planned,
    "step.undone": planned,
    "step.redone": planned,
    "step.dropped": planned,
  },
});
