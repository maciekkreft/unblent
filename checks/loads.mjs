// Where a browser test's time goes (11): the check ends its browser phase with one line
// splitting launches, page loads and the rest, so a slow suite is understood before it is
// optimised. Pure over timestamps, so checks/tests can exercise it without a browser.
// checks/browsers.mjs feeds it and checks/durations.mjs reads it, through one global.
export const TALLY = Symbol.for("unblent.loads");

export function createTally() {
  const launches = [];
  // A finished test's record, by test name: both engines reuse a name and node reports
  // tests in completion order, so a FIFO per name hands each record to the right row.
  const done = new Map();
  let current = null;
  // A navigation start per page, until its load: a test may hold two tabs.
  const pending = new Map();
  return {
    launched(engine, ms) {
      launches.push({ engine, ms });
    },
    begin() {
      current = { loads: [], load_ms: 0 };
      pending.clear();
    },
    navigated(page, url, at) {
      pending.set(page, { url, start: at });
    },
    loaded(page, url, at) {
      const start = pending.get(page);
      if (!current || !start) return;
      const ms = at - start.start;
      current.loads.push({ url, ms });
      current.load_ms += ms;
      pending.delete(page);
    },
    end(name) {
      if (!current) return;
      if (!done.has(name)) done.set(name, []);
      done.get(name).push(current);
      current = null;
      pending.clear();
    },
    take(name) {
      return done.get(name)?.shift();
    },
    summary() {
      return { launches: launches.length, launch_ms: launches.reduce((sum, l) => sum + l.ms, 0) };
    },
  };
}
