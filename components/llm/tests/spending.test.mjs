import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// What guests spend (7.7), run in one python process against a throwaway data
// directory. Jev is never reached: the adapter's send is replaced by a fake reply
// carrying the usage Jev reports, so nothing here spends money or reads a real key.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SCRIPT = `
import json, sys
from components.llm.server import jev_adapter, router, spending

out = {}
cost = lambda model, usage: round(spending.anthropic_cost(model, usage), 9)
out["prices"] = {
    "jev": round(spending.jev_cost(1_000_000_000), 9),
    "opus55": cost("claude-opus-5-5", {"input_tokens": 1_000_000, "output_tokens": 1_000_000}),
    "cache": cost("claude-opus-5-5", {"cache_read_input_tokens": 1_000_000, "cache_creation_input_tokens": 2_000_000,
                                      "cache_creation": {"ephemeral_5m_input_tokens": 1_000_000, "ephemeral_1h_input_tokens": 1_000_000}}),
    "dated": cost("claude-sonnet-4-5-20250929", {"input_tokens": 1_000_000}),
    "haikuLong": cost("claude-haiku-5-5", {"input_tokens": 200_000}),
    "unknown": cost("claude-next", {"input_tokens": 1_000_000}),
}

asked = []
def fake_send(key, payload):
    asked.append(key)
    return {"answers": {q: {"type": "noul", "noul": 0.25} for q in payload["questions"]}, "usage": {"input_tokens": 5_000_000}}, None, 3
jev_adapter.send = fake_send
Q = [{"id": "q", "instructions": "Is it kind?"}]

out["noKey"] = router._decide("g1", {"text": "hi"}, Q, guest=True)
out["freeNoKey"] = spending.free_use("g1")
spending.set_keys({"jev": "guest-jev-key"})
out["defaults"] = spending.summary()
out["first"] = router._decide("g1", {"text": "hi"}, Q, guest=True)
out["after"] = spending.free_use("g1")
spending.set_limits({"guest": 0.2})
out["usedUp"] = router._decide("g1", {"text": "hi"}, Q, guest=True)
spending.set_limits({"guest": 1, "providers": {"jev": 0.1}})
out["providerLimit"] = router._decide("g2", {"text": "hi"}, Q, guest=True)
spending.set_limits({"providers": {"jev": None}, "allGuests": 0.2})
out["allGuests"] = router._decide("g2", {"text": "hi"}, Q, guest=True)
out["summary"] = spending.summary()
out["keys"] = asked
out["invalid"] = [spending.valid_limits({"guest": -1}), spending.valid_limits({"other": 1}), spending.valid_keys({"openai": "x"})]
print(json.dumps(out))
`;

test("guests spend on the guest key at the published prices, within the limits", () => {
  const data = mkdtempSync(join(tmpdir(), "llm-spending-"));
  try {
    const out = JSON.parse(
      execFileSync(`${ROOT}.venv/bin/python`, ["-c", SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, UNBLENT_DATA: data, SESSION_SECRET: "spending-test-secret" },
      }),
    );
    assert.deepEqual(out.prices, {
      jev: 42, // $42 per billion tokens read
      opus55: 24, // $4 in + $20 out per million
      cache: 0.2 + 5 + 8, // read $0.20, 5-minute write $5, 1-hour write $8
      dated: 3, // a dated id finds its family
      haikuLong: 0.1, // over 100,000 tokens: $0.50 per million
      unknown: 10, // an unknown model at the highest price
    });

    assert.deepEqual(out.noKey, { error: "paused" }, "without a guest Jev key, guests are paused");
    assert.deepEqual(out.freeNoKey, { left: 1, blocked: false, paused: ["jev", "anthropic"] });
    assert.equal(out.defaults.guest, 1, "$1.00 per guest");
    assert.deepEqual(out.defaults.allGuests, { spent: 0, limit: 10 }, "$10.00 for all guests");
    assert.deepEqual(out.defaults.providers.map((p) => [p.id, p.limit, p.guestKeySet]), [["jev", null, true], ["anthropic", null, false]]);

    assert.equal(out.first.answers[0].p, 0.25);
    assert.equal(out.first.inputTokens, 5_000_000);
    // 5,000,000 tokens at $42 per billion is $0.21 of $1.00.
    assert.ok(Math.abs(out.after.left - 0.79) < 1e-9, `left ${out.after.left}`);
    assert.deepEqual(out.after.paused, ["anthropic"]);

    assert.deepEqual(out.usedUp, { error: "used-up" });
    assert.deepEqual(out.providerLimit, { error: "paused" }, "a provider's own limit pauses it for every guest");
    assert.deepEqual(out.allGuests, { error: "paused" }, "the limit for all guests pauses everyone");
    assert.deepEqual(out.keys, ["guest-jev-key"], "only the guest key is spent, and only once");
    assert.deepEqual(out.summary.guests, [{ userId: "g1", spent: 0.21, blocked: false }]);
    assert.ok(Math.abs(out.summary.providers[0].spent - 0.21) < 1e-9);
    assert.deepEqual(out.invalid, [null, null, null]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
