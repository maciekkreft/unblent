// The value-suggestion strategy (13), shown to the user as Could be: a value of today's
// whose value line Jev has answered and found not to read as a way of acting (a red mark)
// is ready, and the model reads the value, its example and what the check found.
// A plain object imported only by this component's machine.js (11.1).

const str = (v) => (typeof v === "string" ? v : "");
const pad = (n) => String(n).padStart(2, "0");

// The device's local date, as the values sheet and the journal call today.
const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const valuesOf = (list) => (Array.isArray(list) ? list : []).map((v) => ({ id: v.id, name: str(v.name), meaning: str(v.meaning) }));
const checksOf = (list) => new Map((Array.isArray(list) ? list : []).map((v) => [v.id, Array.isArray(v.lines) ? v.lines : []]));

// The source of one value, keys in this fixed order, or null when its value line as
// written now is not answered with a red mark. A value line no longer red makes no item,
// so its old result stays kept but is not shown.
function valueSource(v, lines) {
  const line = lines?.find((l) => l.line === "value");
  if (!line || line.status !== "done" || line.text !== v.name || !Array.isArray(line.unexpected) || line.unexpected.length === 0) return null;
  return { value: v.name, example: v.meaning, reads: line.unexpected.join(", ") };
}

export const valueSuggestion = {
  generator: "value-suggestion",
  // `heardValues` and `heardChecks` keep what the events said while the starting reads
  // were open, so a read's older answer does not undo it. `now` is the clock, which a
  // test may replace.
  start: () => ({ values: [], checks: new Map(), day: null, heardValues: false, heardChecks: false, now: () => Date.now() }),
  // value-checks.changed supersedes the checks read (4.2); the values.checked that follows
  // a settings change says what it changed.
  follows: ["values.checked", "values.changed", "value-checks.changed"],
  load: async (ask) => {
    const day = dayOf(Date.now());
    const [checks, values] = await Promise.all([
      ask("value-checks", "read", { day }).catch(() => null),
      ask("values", "read", {}).catch(() => null),
    ]);
    return { day, checks, values };
  },
  loaded(seen, { day, checks, values }) {
    if (!seen.heardValues && Array.isArray(values?.values)) seen.values = valuesOf(values.values);
    if (!seen.heardChecks && Array.isArray(checks?.values)) {
      seen.checks = checksOf(checks.values);
      seen.day = day;
    }
  },
  follow(seen, event) {
    if (event.type === "values.changed") {
      seen.values = valuesOf(event.values);
      seen.heardValues = true;
    } else if (event.type === "values.checked" && event.day === dayOf(seen.now())) {
      seen.checks = checksOf(event.values);
      seen.day = event.day;
      seen.heardChecks = true;
    }
  },
  // Today's values with a red value line, in the client's order.
  items(seen) {
    if (seen.day !== dayOf(seen.now())) return [];
    const items = [];
    for (const v of seen.values) {
      const source = valueSource(v, seen.checks.get(v.id));
      if (source) items.push({ item: v.id, at: 0, source });
    }
    return items;
  },
  // Run suggests again for the first of them.
  target: (seen) => valueSuggestion.items(seen)[0] ?? null,
  done: (result, source) => result?.source === source,
  input: ({ value, example, reads }) => `Value: ${value}\nExample: ${example}\nReads as: ${reads}`,
};
