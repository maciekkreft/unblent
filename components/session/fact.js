import { mount } from "bus";
import { outboxesHoldRows } from "store";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/session.changed.json" with { type: "json" };
import refused from "./events/session.refused.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };
import peopleChanged from "./events/people.changed.json" with { type: "json" };
import guest from "./queries/guest.json" with { type: "json" };
import people from "./queries/people.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the localStorage
// cache and the passkey `api` — and mounts it, so machine.js stays importable in
// Node. WebAuthn passes binary as base64url in JSON but navigator.credentials
// wants ArrayBuffers, so these helpers translate at the edge.
const store = openStore("session");

const b64urlToBuf = (value) => {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
};

const bufToB64url = (buffer) => {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const creationOptions = (options) => {
  options.challenge = b64urlToBuf(options.challenge);
  options.user.id = b64urlToBuf(options.user.id);
  for (const cred of options.excludeCredentials ?? []) cred.id = b64urlToBuf(cred.id);
  return options;
};

const requestOptions = (options) => {
  options.challenge = b64urlToBuf(options.challenge);
  for (const cred of options.allowCredentials ?? []) cred.id = b64urlToBuf(cred.id);
  return options;
};

const serializeAttestation = (credential) => ({
  id: credential.id,
  rawId: bufToB64url(credential.rawId),
  type: credential.type,
  response: {
    clientDataJSON: bufToB64url(credential.response.clientDataJSON),
    attestationObject: bufToB64url(credential.response.attestationObject),
    transports: credential.response.getTransports ? credential.response.getTransports() : [],
  },
});

const serializeAssertion = (credential) => ({
  id: credential.id,
  rawId: bufToB64url(credential.rawId),
  type: credential.type,
  response: {
    clientDataJSON: bufToB64url(credential.response.clientDataJSON),
    authenticatorData: bufToB64url(credential.response.authenticatorData),
    signature: bufToB64url(credential.response.signature),
    userHandle: credential.response.userHandle ? bufToB64url(credential.response.userHandle) : null,
  },
});

const post = (path, body) =>
  fetch(`/api/session${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

// A cancelled ceremony surfaces as NotAllowedError; anything else that goes wrong
// is reported as unavailable, so a view never sees a raw exception (12).
const ceremonyError = (error) => (error?.name === "NotAllowedError" ? "cancelled" : "unavailable");

const api = {
  async me() {
    try {
      const res = await fetch("/api/session/me", { credentials: "same-origin", headers: { Accept: "application/json" } });
      return res.ok ? await res.json() : { error: "unavailable" };
    } catch {
      return { error: "unavailable" };
    }
  },
  async register() {
    try {
      const begin = await post("/register/begin");
      if (begin.status === 403) return { error: "registration-closed" };
      if (!begin.ok) return { error: "unavailable" };
      let credential;
      try {
        credential = await navigator.credentials.create({ publicKey: creationOptions(await begin.json()) });
      } catch (error) {
        return { error: ceremonyError(error) };
      }
      const finish = await post("/register/finish", serializeAttestation(credential));
      if (finish.status === 403) return { error: "registration-closed" };
      return finish.ok ? await finish.json() : { error: "unavailable" };
    } catch {
      return { error: "unavailable" };
    }
  },
  async login() {
    try {
      const begin = await post("/login/begin");
      if (!begin.ok) return { error: "unavailable" };
      let credential;
      try {
        credential = await navigator.credentials.get({ publicKey: requestOptions(await begin.json()) });
      } catch (error) {
        return { error: ceremonyError(error) };
      }
      const finish = await post("/login/finish", serializeAssertion(credential));
      if (finish.status === 401) return { error: "unknown-credential" };
      return finish.ok ? await finish.json() : { error: "unavailable" };
    } catch {
      return { error: "unavailable" };
    }
  },
  async guest() {
    try {
      const res = await post("/guest");
      return res.ok ? await res.json() : { error: "unavailable" };
    } catch {
      return { error: "unavailable" };
    }
  },
  async people() {
    try {
      const res = await fetch("/api/session/people", { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (res.status === 403) return { error: "not-admin" };
      return res.ok ? await res.json() : { error: "unavailable" };
    } catch {
      return { error: "unavailable" };
    }
  },
  // View as and Back to you (12): the server changes the cookie and answers with the
  // picture of the account the browser now holds.
  async viewAs(user) {
    try {
      const res = await post("/viewas", { user });
      return res.ok ? await res.json() : { error: "unavailable" };
    } catch {
      return { error: "unavailable" };
    }
  },
  async back() {
    try {
      const res = await post("/back");
      return res.ok ? await res.json() : { error: "unavailable" };
    } catch {
      return { error: "unavailable" };
    }
  },
  async logout() {
    try {
      const res = await post("/logout");
      return res.ok ? await res.json() : { error: "unavailable" };
    } catch {
      return { error: "unavailable" };
    }
  },
};

const actor = mount(machine, {
  // A try page is known by its address (8), read once: the page never changes it.
  input: {
    stored: store.read(),
    save: store.write,
    api,
    tryPage: location.pathname.startsWith("/try/"),
    // Changing who the browser belongs to (12): session only looks at whether an
    // outbox still holds a row (11.2), then opens the page that account would use: a
    // guest's try page, or the product.
    pending: () => outboxesHoldRows().catch(() => true),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    go: (picture) => location.assign(picture.guest ? "/try/evaluators" : "/"),
  },
  events: { "session.changed": changed, "session.refused": refused, "people.changed": peopleChanged },
  queries: { read, guest, people },
});

// On mount and whenever the tab regains focus, reconcile with the server (5): this
// is how a sign-in or sign-out on another device arrives, and how an owed sign-out
// is retried. Reading visibilityState is a read of the document, allowed to any
// component; the machine only ever receives the message, so it stays Node-importable.
const revalidate = () => actor.send({ type: "_revalidate" });
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && revalidate());
revalidate();
