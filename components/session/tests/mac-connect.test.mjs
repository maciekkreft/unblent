import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Connecting a Mac, the Mac's half (3.4): begin, finish, commit and disconnect on a
// local-edition server, against a real web-edition server as the account's side. Both
// are this file's own, each on a throwaway data directory: the web one holds a passkey
// account written through session's registry, as connect.test.mjs does.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SECRET = "mac-connect-web-secret";
const ADMIN = "c".repeat(32);
const LOCAL = "d".repeat(32);
const webData = mkdtempSync(join(tmpdir(), "unblent-test-macweb-"));
const macData = mkdtempSync(join(tmpdir(), "unblent-test-mac-"));
const servers = [];
let web;
let mac;
let macPort;

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const start = async (env) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const clean = { ...process.env, ...env };
  for (const key of ["UNBLENT_LOCAL_USER", "UNBLENT_REMOTE", "RP_ID"]) if (!(key in env)) delete clean[key];
  const server = spawn(
    join(ROOT, ".venv/bin/uvicorn"),
    ["server.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"],
    { cwd: ROOT, env: clean, stdio: ["ignore", "ignore", "inherit"] },
  );
  servers.push(server);
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/static/bus/bus.js`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return { base, port };
};

const adminCookie = () => {
  const payload = `${ADMIN}|admin`;
  return `unblent_session=${payload}.${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
};
const onWeb = (method, path, body) =>
  fetch(`${web}/api/session${path}`, {
    method,
    headers: { "content-type": "application/json", Cookie: adminCookie() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const onMac = (method, path, headers = {}) =>
  fetch(`${mac}/api/session${path}`, { method, headers: { Origin: mac, "Sec-Fetch-Site": "same-origin", ...headers } });
const me = async () => (await (await onMac("GET", "/me")).json());
const held = () => JSON.parse(readFileSync(join(macData, "remote.json"), "utf8"));

// begin, then what the web connect page does once the user presses Connect.
const begin = async () => {
  const res = await onMac("POST", "/connect/begin");
  assert.equal(res.status, 200);
  const page = new URL((await res.json()).url);
  assert.equal(page.origin + page.pathname, `${web}/workshop/apps/connect`);
  assert.equal(page.searchParams.get("port"), String(macPort));
  const code = await (await onWeb("POST", "/connect/code", { challenge: page.searchParams.get("challenge") })).json();
  return { state: page.searchParams.get("state"), code: code.code };
};
const finish = (query) => fetch(`${mac}/api/session/connect/finish?${new URLSearchParams(query)}`);

before(async () => {
  ({ base: web } = await start({ UNBLENT_DATA: webData, SESSION_SECRET: SECRET, RP_ID: "localhost", MAX_USERS: "5" }));
  execFileSync(
    join(ROOT, ".venv/bin/python"),
    [
      "-c",
      "import sys; from components.session.server import registry\n" +
        "registry.create_user(id=sys.argv[1], handle=bytes.fromhex(sys.argv[1]), label='Unblent', " +
        "details={'country': '', 'city': '', 'browser': '', 'system': '', 'device': 'desk'})",
      ADMIN,
    ],
    { cwd: ROOT, env: { ...process.env, UNBLENT_DATA: webData } },
  );
  assert.equal((await onWeb("PUT", `/people/${ADMIN}/sync`, { allowed: true })).status, 200);
  ({ base: mac, port: macPort } = await start({
    UNBLENT_DATA: macData,
    SESSION_SECRET: "mac-connect-local-secret",
    UNBLENT_LOCAL_USER: LOCAL,
    UNBLENT_REMOTE: web,
    UNBLENT_FIRST_BOOK: join(ROOT, "mac/books/meditations.epub"),
  }));
  // The local account's first visit makes its registry row; done here, outside a test's budget.
  await me();
}, { timeout: 30000 });

after(async () => {
  for (const server of servers) {
    server.kill();
    await new Promise((r) => (server.exitCode === null ? server.once("exit", r) : r()));
  }
  rmSync(webData, { recursive: true, force: true });
  rmSync(macData, { recursive: true, force: true });
});

test("begin, Safari's code, commit: the Mac is ready, then on, with the account's name; disconnect forgets it", async () => {
  assert.deepEqual([(await me()).connect, (await me()).remote], ["off", undefined]);
  const { state, code } = await begin();
  assert.equal((await me()).connect, "off", "waiting for Safari is still off");

  const done = await finish({ code, state });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Done\. Go back to Unblent\./);
  assert.equal(done.headers.get("cache-control"), "no-store");
  const ready = await me();
  assert.deepEqual([ready.userId, ready.connect, ready.remote], [LOCAL, "ready", "Admin"]);
  assert.equal(statSync(join(macData, "remote.json")).mode & 0o777, 0o600, "the device sign-in is the owner's alone");
  assert.equal(held().userId, ADMIN);
  assert.match(held().token, new RegExp(`^${ADMIN}\\|admin\\|device:`));
  const web_me = await (await fetch(`${web}/api/session/me`, { headers: { Cookie: `unblent_session=${held().token}` } })).json();
  assert.equal(web_me.userId, ADMIN, "the stored sign-in works on the account's side");

  assert.equal((await finish({ code, state })).status, 400, "the same visit cannot finish twice");
  const on = await onMac("POST", "/connect/commit");
  assert.deepEqual(await on.json(), { connect: "on", remote: "Admin" });
  // From now on /me goes through the relay (3.4): the Mac is the account.
  const connected = await me();
  assert.deepEqual([connected.userId, connected.connect, connected.remote], [ADMIN, "on", "Admin"]);
  assert.equal(statSync(join(macData, "remote.json")).mode & 0o777, 0o600);
  assert.equal((await onMac("POST", "/connect/begin")).status, 409, "a connected Mac disconnects first");

  assert.deepEqual(await (await onMac("POST", "/connect/disconnect")).json(), { connect: "off" });
  assert.equal(existsSync(join(macData, "remote.json")), false);
  assert.equal((await me()).connect, "off");
  assert.equal((await onMac("POST", "/connect/commit")).status, 409, "nothing to turn on");
});

test("Cancel in Safari leaves the Mac off and stops it waiting", async () => {
  const { state } = await begin();
  const res = await finish({ error: "cancelled", state });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Not connected\. Go back to Unblent\./);
  assert.equal(existsSync(join(macData, "remote.json")), false);
  assert.equal((await me()).connect, "off");
});

test("a finish with another state is refused and the Mac keeps waiting for its own", async () => {
  const { state, code } = await begin();
  assert.equal((await finish({ code, state: "not-the-one" })).status, 400);
  assert.equal((await finish({ error: "cancelled", state: "not-the-one" })).status, 400, "nor can another page cancel it");
  assert.equal(held().state, "pending");
  assert.equal((await finish({ code, state })).status, 200);
  assert.equal((await me()).connect, "ready");
  await onMac("POST", "/connect/disconnect");
});

test("with the account out of reach the code is kept for a reload; with Can sync off the Mac is told so", async () => {
  const { state, code } = await begin();
  const real = held();
  writeFileSync(join(macData, "remote.json"), JSON.stringify({ ...real, url: `http://127.0.0.1:${await freePort()}` }));
  const down = await finish({ code, state });
  assert.equal(down.status, 502);
  assert.match(await down.text(), /could not reach/);
  assert.equal(held().state, "pending");

  writeFileSync(join(macData, "remote.json"), JSON.stringify(real));
  await onWeb("PUT", `/people/${ADMIN}/sync`, { allowed: false });
  try {
    const off = await finish({ code, state });
    assert.equal(off.status, 403);
    assert.match(await off.text(), /Sync is not turned on for this account\./);
    assert.equal((await me()).connect, "off");
  } finally {
    await onWeb("PUT", `/people/${ADMIN}/sync`, { allowed: true });
  }
});

test("another site cannot begin, commit or disconnect; the web edition has none of these", async () => {
  for (const path of ["/connect/begin", "/connect/commit", "/connect/disconnect"]) {
    assert.equal((await onMac("POST", path, { "Sec-Fetch-Site": "cross-site" })).status, 403, path);
    assert.equal((await onMac("POST", path, { "Sec-Fetch-Site": "same-site" })).status, 403, path);
    assert.equal((await onMac("POST", path, { Origin: "https://evil.example" })).status, 403, path);
  }
  assert.equal(existsSync(join(macData, "remote.json")), false);
  for (const path of ["/connect/begin", "/connect/commit", "/connect/disconnect"]) {
    assert.equal((await fetch(`${web}/api/session${path}`, { method: "POST" })).status, 404, path);
  }
  assert.equal((await fetch(`${web}/api/session/connect/finish?state=x&code=y`)).status, 404);
  assert.equal((await (await fetch(`${web}/api/session/me`)).json()).connect, undefined);
});

test("/mac opens the connected Mac page while connected; disconnect also drops the disk copy of book files", async () => {
  const title = async () => (await (await fetch(`${mac}/mac`)).text()).match(/<title>(.*)<\/title>/)[1];
  assert.equal(await title(), "MacApp");
  const { state, code } = await begin();
  assert.equal((await finish({ code, state })).status, 200);
  assert.equal(await title(), "MacApp", "a sign-in waiting for the hand-over is not connected yet");
  assert.equal((await onMac("POST", "/connect/commit")).status, 200);
  assert.equal(await title(), "MacSync");
  const cache = join(macData, "remote-cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "chapter"), "the account's book");
  await onMac("POST", "/connect/disconnect");
  assert.equal(existsSync(cache), false, "nothing of the account stays on the Mac (5)");
  assert.equal(await title(), "MacApp");
});
