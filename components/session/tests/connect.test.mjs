import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Connecting a Mac (3.4): connect codes, device sign-ins and Can sync, over HTTP. A
// code needs a passkey account, which only a WebAuthn ceremony can make, and the
// check's shared server admits one (MAX_USERS=1) that its ceremony test needs free. So
// this file runs a web-edition server of its own on a throwaway data directory and
// writes its accounts through session's own registry module, the way a ceremony would.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SECRET = "connect-test-secret";
const data = mkdtempSync(join(tmpdir(), "unblent-test-connect-"));
let server;
let base;

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// One interpreter for every account, in order: the first is the admin (3.4).
const accounts = (...ids) =>
  execFileSync(
    join(ROOT, ".venv/bin/python"),
    [
      "-c",
      "import sys; from components.session.server import registry\n" +
        "for i in sys.argv[1:]: registry.create_user(id=i, handle=bytes.fromhex(i), label='Unblent', " +
        "details={'country': '', 'city': '', 'browser': '', 'system': '', 'device': 'desk'})",
      ...ids,
    ],
    { cwd: ROOT, env: { ...process.env, UNBLENT_DATA: data } },
  );

const cookie = (payload) => `unblent_session=${payload}.${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
const call = (method, path, { cookie: held, body } = {}) =>
  fetch(`${base}/api/session${path}`, {
    method,
    headers: { "content-type": "application/json", ...(held ? { Cookie: held } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// The Mac's half of PKCE (RFC 7636): a random verifier and its S256 challenge.
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const ADMIN = "a".repeat(32);
const OTHER = "b".repeat(32);
const admin = cookie(`${ADMIN}|admin`);
const other = cookie(OTHER);
const allow = (user, allowed) => call("PUT", `/people/${user}/sync`, { cookie: admin, body: { allowed } });
const codeFor = async (held) => {
  const { verifier, challenge } = pkce();
  const res = await call("POST", "/connect/code", { cookie: held, body: { challenge } });
  return { res, verifier, code: res.ok ? (await res.json()).code : null };
};

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, UNBLENT_DATA: data, SESSION_SECRET: SECRET, RP_ID: "localhost", MAX_USERS: "5" };
  delete env.UNBLENT_LOCAL_USER;
  server = spawn(
    join(ROOT, ".venv/bin/uvicorn"),
    ["server.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"],
    { cwd: ROOT, env, stdio: ["ignore", "ignore", "inherit"] },
  );
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/api/session/me`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  accounts(ADMIN, OTHER);
}, { timeout: 20000 });

after(async () => {
  server?.kill();
  await new Promise((r) => (server && server.exitCode === null ? server.once("exit", r) : r()));
  rmSync(data, { recursive: true, force: true });
});

test("Can sync is off by default, and only the admin turns it on or off for a passkey account", async () => {
  const people = await (await call("GET", "/people", { cookie: admin })).json();
  assert.deepEqual(people.people.map((p) => [p.userId, p.sync]), [[ADMIN, false], [OTHER, false]]);
  assert.equal((await call("PUT", `/people/${OTHER}/sync`, { cookie: other, body: { allowed: true } })).status, 403);
  assert.equal((await call("PUT", `/people/${OTHER}/sync`, { body: { allowed: true } })).status, 403);
  assert.equal((await allow("nobody", true)).status, 404);
  assert.equal((await allow(OTHER, "yes")).status, 400);
  const guest = await (await call("POST", "/guest")).json();
  assert.equal((await allow(guest.userId, true)).status, 404, "a guest never gets Can sync");

  const on = await allow(OTHER, true);
  assert.equal(on.status, 200);
  const listed = (await on.json()).people;
  assert.equal(listed.find((p) => p.userId === OTHER).sync, true);
  assert.equal(listed.find((p) => p.userId === guest.userId).sync, undefined, "a guest row carries no sync");
  assert.equal((await allow(OTHER, false)).status, 200);
  assert.equal((await (await call("GET", "/connect", { cookie: other })).json()).allowed, false);
});

test("with Can sync off there is no code; a guest and nobody get none either", async () => {
  await allow(ADMIN, false);
  const { res } = await codeFor(admin);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "sync-off" });
  assert.equal((await codeFor(null)).res.status, 401);
  const guestRes = await call("POST", "/guest");
  const guestCookie = (guestRes.headers.get("set-cookie") || "").split(";")[0];
  assert.equal((await codeFor(guestCookie)).res.status, 403);
  assert.equal((await call("POST", "/connect/code", { cookie: admin, body: { challenge: "short" } })).status, 400);
});

test("a code and its verifier give a device sign-in once; a wrong verifier, a reuse and an expired code give none", async () => {
  await allow(ADMIN, true);
  assert.equal((await (await call("GET", "/connect", { cookie: admin })).json()).allowed, true);

  const first = await codeFor(admin);
  assert.equal(first.res.status, 200);
  const res = await call("POST", "/connect/token", { body: { code: first.code, verifier: first.verifier } });
  assert.equal(res.status, 200);
  const signed = await res.json();
  assert.deepEqual([signed.userId, signed.name], [ADMIN, "Admin"]);
  assert.match(signed.token, new RegExp(`^${ADMIN}\\|admin\\|device:[0-9a-f]+\\.[0-9a-f]{64}$`));
  const me = await (await call("GET", "/me", { cookie: `unblent_session=${signed.token}` })).json();
  assert.equal(me.userId, ADMIN);

  const again = await call("POST", "/connect/token", { body: { code: first.code, verifier: first.verifier } });
  assert.equal(again.status, 400, "a code is good once");

  const wrong = await codeFor(admin);
  const bad = await call("POST", "/connect/token", { body: { code: wrong.code, verifier: pkce().verifier } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid-code" });
  const late = await call("POST", "/connect/token", { body: { code: wrong.code, verifier: wrong.verifier } });
  assert.equal(late.status, 400, "a wrong try uses the code up");

  const old = await codeFor(admin);
  execFileSync(
    join(ROOT, ".venv/bin/python"),
    ["-c", "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute('UPDATE connect_codes SET expires_at = 0'); c.commit()", join(data, "session.db")],
  );
  const expired = await call("POST", "/connect/token", { body: { code: old.code, verifier: old.verifier } });
  assert.equal(expired.status, 400, "a code lives two minutes");
  assert.equal((await call("POST", "/connect/token", { body: { code: "nope", verifier: old.verifier } })).status, 400);
});

test("a device sign-in is refused as signed out while its account's Can sync is off, and works again when it is on", async () => {
  await allow(OTHER, true);
  const { code, verifier } = await codeFor(other);
  const { token } = await (await call("POST", "/connect/token", { body: { code, verifier } })).json();
  const device = `unblent_session=${token}`;
  const notes = () => fetch(`${base}/api/notes?since=0`, { headers: { Cookie: device } });
  assert.equal((await notes()).status, 200);

  await allow(OTHER, false);
  assert.equal((await notes()).status, 401);
  const me = await call("GET", "/me", { cookie: device });
  assert.equal((await me.json()).userId, null);
  assert.equal(me.headers.get("set-cookie"), null, "the Mac keeps its sign-in for when sync is back");
  // The account's own browser is not a device sign-in, so it stays signed in.
  assert.equal((await (await call("GET", "/me", { cookie: other })).json()).userId, OTHER);

  await allow(OTHER, true);
  assert.equal((await notes()).status, 200);
});
