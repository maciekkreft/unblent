import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

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

// A guest is one registry row plus the cookie (3.4). Each request below carries its
// own cookie by hand, so the tests share nothing but the throwaway registry.
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
const me = async (cookie) =>
  (await fetch(`${BASE_URL}/api/session/me`, { headers: cookie ? { Cookie: cookie } : {} })).json();

test("POST /guest makes a numbered guest with a cookie, outside MAX_USERS", async () => {
  const before = (await me()).registrationOpen;
  const res = await post("/guest", {
    "cf-ipcountry": "PL",
    "cf-ipcity": "KrakÃ³w",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.guest, true);
  assert.equal(body.admin, false);
  assert.match(body.name, /^Guest \d+$/);
  const cookie = cookieOf(res);
  assert.match(cookie, /^unblent_session=/);
  const again = await me(cookie);
  assert.equal(again.userId, body.userId);
  assert.equal(again.name, body.name);
  // Guests never close registration (3.4).
  assert.equal((await me()).registrationOpen, before);

  // A browser that already holds an account keeps it: no second guest.
  const second = await fetch(`${BASE_URL}/api/session/guest`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal((await second.json()).userId, body.userId);
  assert.equal(second.headers.get("set-cookie"), null);

  // Guests are numbered in the order they arrive.
  const next = await (await post("/guest")).json();
  assert.equal(next.name, `Guest ${Number(body.name.split(" ")[1]) + 1}`);
});

test("GET /people is refused to anyone but the admin (12)", async () => {
  assert.equal((await fetch(`${BASE_URL}/api/session/people`)).status, 403);
  const cookie = cookieOf(await post("/guest"));
  assert.equal((await fetch(`${BASE_URL}/api/session/people`, { headers: { Cookie: cookie } })).status, 403);
});

// View as and Back to you (12). The admin's cookie is forged the way session's server
// module sets it, so no passkey ceremony is needed; the guest is a real registry row.
const forged = (payload) => {
  const secret = process.env.SESSION_SECRET;
  assert.ok(secret, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory");
  return `unblent_session=${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
};
const postJson = (path, cookie, body) =>
  fetch(`${BASE_URL}/api/session${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("only the admin may view as a guest, and Back to you returns without a passkey (12)", async () => {
  const adminId = `admin-${Date.now()}`;
  const admin = forged(`${adminId}|admin`);
  const guestRes = await post("/guest");
  const guest = await guestRes.json();
  const guestCookie = cookieOf(guestRes);

  // Nobody but the admin, and nobody who is not in the registry.
  assert.equal((await postJson("/viewas", guestCookie, { user: guest.userId })).status, 403);
  assert.equal((await postJson("/viewas", null, { user: guest.userId })).status, 403);
  assert.equal((await postJson("/viewas", admin, { user: "nobody" })).status, 404);

  const viewing = await postJson("/viewas", admin, { user: guest.userId });
  assert.equal(viewing.status, 200);
  const picture = await viewing.json();
  assert.equal(picture.userId, guest.userId);
  assert.equal(picture.viewingAs, guest.name);
  assert.equal(picture.admin, false);
  const viewCookie = cookieOf(viewing);
  assert.match(viewCookie, new RegExp(`^unblent_session=${guest.userId}\\|guest\\|by:${adminId}\\.`));

  // While viewing, the browser is the guest: no Administration, no second View as, and
  // the guest's last visit is not the admin's.
  const seenBefore = (await me(guestCookie)).userId;
  assert.equal(seenBefore, guest.userId);
  const asGuest = await me(viewCookie);
  assert.deepEqual([asGuest.userId, asGuest.viewingAs, asGuest.admin], [guest.userId, guest.name, false]);
  assert.equal((await fetch(`${BASE_URL}/api/session/people`, { headers: { Cookie: viewCookie } })).status, 403);
  assert.equal((await postJson("/viewas", viewCookie, { user: guest.userId })).status, 403);

  // Back to you only while viewing as someone.
  assert.equal((await postJson("/back", admin)).status, 403);
  const back = await postJson("/back", viewCookie);
  assert.equal(back.status, 200);
  const own = await back.json();
  assert.deepEqual([own.userId, own.admin, own.viewingAs], [adminId, true, undefined]);
  assert.match(cookieOf(back), new RegExp(`^unblent_session=${adminId}\\|admin\\.`));
});
