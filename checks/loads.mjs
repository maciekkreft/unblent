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
  // One record per running test, innermost last: a journey (9) is a test whose steps are
  // tests, so its own page load and each step's reload land on the one that made them.
  const running = [];
  // A navigation start per page, until its load: a test may hold two tabs.
  const pending = new Map();
  return {
    launched(engine, ms) {
      launches.push({ engine, ms });
    },
    begin() {
      if (!running.length) pending.clear();
      running.push({ loads: [], load_ms: 0 });
    },
    navigated(page, url, at) {
      pending.set(page, { url, start: at });
    },
    loaded(page, url, at) {
      const start = pending.get(page);
      const current = running.at(-1);
      if (!current || !start) return;
      const ms = at - start.start;
      current.loads.push({ url, ms });
      current.load_ms += ms;
      pending.delete(page);
    },
    end(name) {
      const current = running.pop();
      if (!current) return;
      if (!done.has(name)) done.set(name, []);
      done.get(name).push(current);
      if (!running.length) pending.clear();
    },
    take(name) {
      return done.get(name)?.shift();
    },
    summary() {
      return { launches: launches.length, launch_ms: launches.reduce((sum, l) => sum + l.ms, 0) };
    },
  };
}
