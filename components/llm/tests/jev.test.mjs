import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The Jev adapter's request and reply mapping are pure, so they are run in one python
// process on a reply Jev really sent (fixtures/jev-pick.json, recorded once, holding
// no key); nothing here reaches typesafe.ai.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const RECORDED = JSON.parse(readFileSync(`${HERE}fixtures/jev-pick.json`, "utf8"));

const SCRIPT = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("jev_adapter", "components/llm/server/jev_adapter.py")
jev_adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jev_adapter)
cases = json.load(sys.stdin)
print(json.dumps([
    {"body": jev_adapter.body(c["state"], c["questions"]), "parsed": jev_adapter.parse(c["reply"], c["questions"], 7)}
    for c in cases
]))
`;
const run = (cases) =>
  JSON.parse(execFileSync(`${ROOT}.venv/bin/python`, ["-c", SCRIPT], { cwd: ROOT, input: JSON.stringify(cases) }));

const PICK = {
  id: "kind",
  kind: "pick",
  instructions: "Is this a goal, a value, or neither?",
  options: [
    { id: "goal", name: "Goal", description: "Something you can achieve and then it is finished." },
    { id: "value", name: "Value", description: "An ongoing way of acting that is never finished." },
    { id: "other", name: "Other" },
  ],
};
const YESNO = { id: "q", instructions: "Is it a greeting?", yes: "It greets", no: "It does not" };
const STATE = { text: "To win the race." };

test("a pick question is sent as a choice and its recorded reply maps back to our ids", () => {
  const malformed = { ...RECORDED, answers: { kind: { ...RECORDED.answers.kind, choice: "Nothing" } } };
  const [real, broken, mixed] = run([
    { state: STATE, questions: [PICK], reply: RECORDED },
    { state: STATE, questions: [PICK], reply: malformed },
    {
      state: STATE,
      questions: [YESNO, PICK],
      reply: { answers: { q: { type: "noul", noul: 0.25 }, kind: RECORDED.answers.kind }, usage: { input_tokens: 9 } },
    },
  ]);
  assert.deepEqual(real.body, {
    state: STATE,
    model: "jev-latest",
    questions: {
      kind: {
        type: "choice",
        instructions: PICK.instructions,
        criteria: {
          Goal: "Something you can achieve and then it is finished.",
          Value: "An ongoing way of acting that is never finished.",
          Other: null,
        },
      },
    },
  });
  assert.deepEqual(real.parsed, {
    answers: [{
      id: "kind",
      p: 1,
      choice: "goal",
      probabilities: [{ id: "goal", p: 1 }, { id: "value", p: 0 }, { id: "other", p: 0 }],
      confidence: 1,
    }],
    inputTokens: RECORDED.usage.input_tokens,
    ms: 7,
  });
  assert.deepEqual(broken.parsed, { error: "unavailable" });
  assert.deepEqual(mixed.body.questions.q, { type: "noul", instructions: YESNO.instructions, criteria: { true: "It greets", false: "It does not" } });
  assert.deepEqual(mixed.parsed.answers[0], { id: "q", p: 0.25 });
  assert.equal(mixed.parsed.answers[1].choice, "goal");
});

// A stall is asked once more and a refusal is not, so urlopen is replaced in the same
// python process; nothing here reaches typesafe.ai.
const RETRY = `
import importlib.util, io, json, urllib.error, urllib.request
spec = importlib.util.spec_from_file_location("jev_adapter", "components/llm/server/jev_adapter.py")
jev_adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jev_adapter)
def run(script):
    calls = []
    def urlopen(request, timeout):
        calls.append(timeout)
        step = script[len(calls) - 1]
        if step == "stall":
            raise TimeoutError()
        if step == "refused":
            raise urllib.error.HTTPError(request.full_url, 429, "", {}, None)
        return io.BytesIO(b'{"answers": {}}')
    urllib.request.urlopen = urlopen
    reply, error, _ = jev_adapter.send("key", {})
    return {"reply": reply, "error": error, "calls": calls}
print(json.dumps([run(["stall", "ok"]), run(["stall", "stall"]), run(["refused"])]))
`;

test("a stalled request is retried once after 5 s; a refusal is not", () => {
  const [recovered, stalled, refused] = JSON.parse(execFileSync(`${ROOT}.venv/bin/python`, ["-c", RETRY], { cwd: ROOT }));
  assert.deepEqual(recovered, { reply: { answers: {} }, error: null, calls: [5, 5] });
  assert.deepEqual(stalled, { reply: null, error: "unavailable", calls: [5, 5] });
  assert.deepEqual(refused, { reply: null, error: "rate-limited", calls: [5] });
});
