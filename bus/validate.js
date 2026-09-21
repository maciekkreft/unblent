// The one wrapper around the JSON Schema validator (architecture.md 10). The draft is
// fixed here and nowhere else, so the bus and every future caller validate the same way
// against draft 2020-12. `compile` resolves a schema's references once and returns a
// checker, so a mounted validator does no setup per message — payload validation is on
// the bus's hot path (3.3).
import { Validator } from "@cfworker/json-schema";

// Returns a checker for one schema: `null` when the value matches, else a short
// "<location>: <keyword>" naming where and which rule failed. Short-circuit is on, so
// only the first error is built: a yes or no is all the hot path needs, and one error
// is enough to find a defect. The checker names the location and the failing keyword
// but never the value, so its result is safe to put in the trace or the console — a
// wrong number or a secret (7.2) is not carried along with the complaint about it.
export function compile(schema) {
  const validator = new Validator(schema, "2020-12", true);
  return (value) => {
    const { valid, errors } = validator.validate(value);
    if (valid) return null;
    const first = errors[0];
    return `${first.instanceLocation}: ${first.keyword}`;
  };
}
