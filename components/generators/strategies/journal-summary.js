// The journal-summary strategy (13): every day that can no longer be written and has
// text or choice points is ready, and the model reads the day and its choice points.
// A plain object imported only by this component's machine.js (11.1).

const str = (v) => (typeof v === "string" ? v : "");

const choicePoint = (c) => ({ id: c.id, day: c.day, situation: str(c.situation), thoughts: str(c.thoughts), away: str(c.away), towards: str(c.towards) });

// A day's source, or null when it has no text and no choice points. Choice points in the
// order they were made: their ids are ULIDs, whose text sorts by the time in them.
export function daySource(day, points) {
  const cps = points
    .filter((c) => c.day === day.day)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({ situation: c.situation, thoughts: c.thoughts, away: c.away, towards: c.towards }));
  if (day.text === "" && cps.length === 0) return null;
  return { day: day.day, text: day.text, choicePoints: cps };
}

export const journalSummary = {
  generator: "journal-summary",
  // `heard` and `touched` keep what the events said while the starting read was open, so
  // the read's older answer does not undo it.
  start: () => ({ days: [], open: null, points: new Map(), heard: false, touched: new Map(), shown: null }),
  follows: ["journal.changed", "choice-point.changed", "choice-point.deleted", "day.shown"],
  load: async (ask) => {
    const [journal, points] = await Promise.all([
      ask("journal", "read", {}).catch(() => null),
      ask("choice-points", "list", {}).catch(() => null),
    ]);
    return { journal, points };
  },
  loaded(seen, { journal, points }) {
    if (!seen.heard && Array.isArray(journal?.days)) {
      seen.days = journal.days.map((d) => ({ id: d.id, day: d.day, text: str(d.text), at: d.editedAt ?? 0 }));
      seen.open = journal.open ?? null;
    }
    const map = new Map((Array.isArray(points?.choicePoints) ? points.choicePoints : []).map((c) => [c.id, choicePoint(c)]));
    for (const [id, c] of seen.touched) c ? map.set(id, c) : map.delete(id);
    seen.points = map;
  },
  follow(seen, event) {
    if (event.type === "day.shown") seen.shown = event.day;
    else if (event.type === "journal.changed") {
      seen.days = event.days.map((d) => ({ id: d.id, day: d.day, text: str(d.text), at: d.editedAt ?? 0 }));
      seen.open = event.open ?? null;
      seen.heard = true;
    } else if (event.type === "choice-point.changed") {
      const c = choicePoint(event.choicePoint);
      seen.points.set(c.id, c);
      seen.touched.set(c.id, c);
    } else if (event.type === "choice-point.deleted") {
      seen.points.delete(event.id);
      seen.touched.set(event.id, null);
    }
  },
  // The days that can no longer be written (the open one is still being written).
  items(seen) {
    const points = [...seen.points.values()];
    const items = [];
    for (const d of seen.days) {
      if (d.id === seen.open) continue;
      const source = daySource(d, points);
      if (source) items.push({ item: d.day, at: d.at, source });
    }
    return items;
  },
  // Run writes the day shown on the stage, even while it can still be written.
  target(seen) {
    const d = seen.days.find((x) => x.day === seen.shown);
    const source = d && daySource(d, [...seen.points.values()]);
    return source ? { item: d.day, at: d.at, source } : null;
  },
  done: (result, source) => result?.source === source,
  input: ({ day, text, choicePoints }) =>
    `Journal entry for ${day}:\n${text}` +
    (choicePoints.length
      ? "\n\nChoice points:\n" +
        choicePoints
          .map((c) => `- Situation: ${c.situation}\n  Thoughts and feelings: ${c.thoughts}\n  Away: ${c.away}\n  Towards: ${c.towards}`)
          .join("\n")
      : ""),
};
