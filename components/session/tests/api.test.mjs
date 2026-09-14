import { test } from "node:test";
import assert from "node:assert/strict";

// The server module is the far end of the same component (section 3), tested from
// here against the live check server, which runs with RP_ID=localhost and
// MAX_USERS=1 on a throwaway UNBLENT_DATA (checks/check.py). The ceremonies
// themselves need a browser authenticator and are covered in page.test.mjs
// (Chromium only); this covers the round trips that need no credential.
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// WebAuthn refuses an IP as the RP id (3.4), so the ceremonies read the Origin,
// which must be localhost to match RP_ID; the server checks the header, not the URL.
const ORIGIN = `http://localhost:${new URL(BASE_URL).port}`;
const post = (path, headers = {}) =>
  fetch(`${BASE_URL}/api/session${path}`, { method: "POST", headers });

test("GET /me is anonymous with no cookie and reports whether registration is open", async () => {
  const res = await fetch(`${BASE_URL}/api/session/me`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.userId, null);
  assert.equal(typeof body.registrationOpen, "boolean");
});

test("register/begin honours the capacity rule: options while a slot is free, else 403", async () => {
  // The ceremony test fills the single MAX_USERS=1 slot in the same process, so
  // which branch runs depends on test order; the capacity rule holds either way.
  const open = (await (await fetch(`${BASE_URL}/api/session/me`)).json()).registrationOpen;
  const res = await post("/register/begin", { Origin: ORIGIN });
  assert.equal(res.status, open ? 200 : 403);
  if (open) {
    assert.match(res.headers.get("set-cookie") || "", /unblent_challenge=/);
    const options = await res.json();
    assert.equal(options.rp.id, "localhost");
    assert.ok(options.challenge, "options carry a challenge");
    assert.ok(options.user.id, "options carry a user handle");
  }
});

test("register/begin refuses an Origin whose host is not the RP id", async () => {
  const res = await post("/register/begin", { Origin: "http://evil.example" });
  assert.equal(res.status, 400);
});

test("register/finish with no challenge in progress is a 400", async () => {
  const res = await fetch(`${BASE_URL}/api/session/register/finish`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 400);
});

test("login/begin issues options, and logout is a 200 even with no session", async () => {
  assert.equal((await post("/login/begin", { Origin: ORIGIN })).status, 200);
  assert.equal((await post("/logout")).status, 200);
});
