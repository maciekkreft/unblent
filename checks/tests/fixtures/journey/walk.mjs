// A journey over a fake page, for checks/tests/journey.test.mjs: the state is a plain
// object the steps change, so the kit's journey() runs without a browser. FAULT names
// the step that leaves the page in the wrong state; OPENS counts the visits on stdout.
import { test } from "node:test";
import { journey } from "../../../kit.mjs";

const fault = process.env.FAULT ?? "";
let opens = 0;

test("a walk", ...journey({
  launch: async () => ({ close: async () => {} }),
  open: async () => {
    opens += 1;
    return { state: { row: 1 }, problems: [], close: async () => console.log(`OPENS ${opens}`) };
  },
  look: (visit) => ({ ...visit.state }),
}, [
  {
    name: "j moves down",
    run: async (v) => {
      v.state.row = fault === "j moves down" ? 1 : 2;
      await v.see((s) => (s.row === 2 ? null : `the keyboard is on row ${s.row}`), 200);
    },
  },
  {
    name: "a row far away",
    run: async (v) => {
      v.state.row = fault === "a row far away" ? 7 : 3;
    },
  },
  {
    name: "k from row 3",
    from: {
      state: "the keyboard on row 3",
      check: (s) => (s.row === 3 ? null : `the keyboard is on row ${s.row}`),
      reach: async (v) => {
        v.state.row = 3;
      },
    },
    run: async (v) => {
      v.state.row = 2;
      await v.see((s) => (s.row === 2 ? null : `the keyboard is on row ${s.row}`));
    },
  },
  {
    name: "a letter typed nothing",
    run: async (v) => {
      await v.see((s) => (s.row === 2 ? null : `the keyboard is on row ${s.row}`));
    },
  },
]));
