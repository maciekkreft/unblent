import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The server module (3.4) against a throwaway data folder of its own, in one python
// process, because the edition is chosen by the environment. Every voice spoken is the
// test voice, so nothing is downloaded and no key is spent. The download is pointed at
// an address where nothing listens.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function run(script, data, extra = {}) {
  const prelude = `
import base64, io, json, os, time, wave
from fastapi import FastAPI
from fastapi.testclient import TestClient
from server.user import SESSION_COOKIE, session_token
import components.voice.server.router as voice

app = FastAPI()
app.include_router(voice.router, prefix="/api/voice")
client = TestClient(app)

def call(method, path="", body=None):
    r = client.request(method, "/api/voice" + path, json=body)
    return [r.status_code, r.json() if r.content else None]

def seconds(answer):
    w = wave.open(io.BytesIO(base64.b64decode(answer["audio"])))
    return round(w.getnframes() / w.getframerate(), 3)

out = {}
`;
  return JSON.parse(
    execFileSync(`${ROOT}.venv/bin/python`, ["-c", prelude + script + "\nprint(json.dumps(out))"], {
      cwd: ROOT,
      env: { ...process.env, SESSION_SECRET: "test", UNBLENT_DATA: data, UNBLENT_LOCAL_USER: "", UNBLENT_VOICE_URL: "http://127.0.0.1:9", ...extra },
    }),
  );
}

function withData(fn) {
  const data = mkdtempSync(join(tmpdir(), "voice-server-"));
  try {
    fn(data);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

const SIZE = 325532387 + 28214398;

test("a Mac keeps its voice in voice.json, answers not-downloaded, and reads with the test voice", () =>
  withData((data) => {
    const out = run(
      `
out["fresh"] = call("GET")
out["notDownloaded"] = call("POST", "/speak", {"text": "Begin the morning."})
out["pick"] = call("PUT", "", {"voice": "test"})
said = call("POST", "/speak", {"text": "Begin the morning."})
out["said"] = [said[0], said[1]["mime"], said[1]["words"], seconds(said[1])]
out["bad"] = [call("PUT", "", b)[0] for b in ({"voice": "Ashley"}, {"key": "k"}, {}, {"download": "now"}, [])]
out["badSpeak"] = [call("POST", "/speak", b)[0] for b in ({"text": ""}, {"text": "  "}, {}, {"text": 1}, {"text": "a", "x": 1})]
out["keyStep"] = call("PUT", "/key/step", {"step": "01K7APDT000000000000000001", "restore": "before", "expect": "after"})[0]
`,
      data,
      { UNBLENT_LOCAL_USER: "0123abcd" },
    );
    const voices = out.fresh[1].voices;
    assert.deepEqual(out.fresh, [200, { here: "mac", kokoro: { state: "missing", done: 0, size: SIZE }, voice: "af_heart", voices }]);
    assert.deepEqual(voices.map((v) => v.label), ["Heart", "Bella", "Michael", "Emma", "George", "Test voice"]);
    assert.deepEqual(out.notDownloaded, [200, { error: "not-downloaded" }]);
    assert.equal(out.pick[1].voice, "test");
    assert.deepEqual(JSON.parse(readFileSync(join(data, "voice.json"), "utf8")), { voice: "test" }, "the file of this Mac");
    const [status, mime, words, seconds] = out.said;
    assert.equal(status, 200);
    assert.equal(mime, "audio/wav");
    assert.deepEqual(words.map((w) => [w.from, w.to]), [[0, 5], [6, 9], [10, 17]]);
    assert.ok(words.every((w, i) => w.start < w.end && (i === 0 || w.start >= words[i - 1].end)), JSON.stringify(words));
    assert.ok(words.at(-1).end <= seconds && seconds > 0.2, `${seconds}`);
    assert.deepEqual(out.bad, [400, 400, 400, 400, 400]);
    assert.deepEqual(out.badSpeak, [400, 400, 400, 400, 400]);
    assert.equal(out.keyStep, 404, "a Mac keeps no key");
  }));

test("a download that cannot reach its files keeps nothing, and Cancel stops one", () =>
  withData((data) => {
    const out = run(
      `
out["start"] = call("PUT", "", {"download": "start"})[1]["kokoro"]["state"]
for _ in range(200):
    if call("GET")[1]["kokoro"]["state"] != "downloading":
        break
    time.sleep(0.01)
out["after"] = call("GET")[1]["kokoro"]
call("PUT", "", {"download": "start"})
out["cancel"] = call("PUT", "", {"download": "cancel"})[1]["kokoro"]
time.sleep(0.1)
`,
      data,
      { UNBLENT_LOCAL_USER: "0123abcd" },
    );
    assert.equal(out.start, "downloading");
    assert.deepEqual(out.after, { state: "missing", done: 0, size: SIZE });
    assert.deepEqual(out.cancel, { state: "missing", done: 0, size: SIZE });
    assert.deepEqual(readdirSync(join(data, "voice")), [], "no partial file is left");
  }));

test("the website keeps the voice and the encrypted key per account; a key change is undone from the server's copy", () =>
  withData((data) => {
    const out = run(
      `
out["anonymous"] = [call("GET"), call("POST", "/speak", {"text": "Hi."}), call("PUT", "", {"voice": "Dennis"})[0]]
client.cookies.set(SESSION_COOKIE, session_token("u1"))
out["fresh"] = call("GET")
out["noKey"] = call("POST", "/speak", {"text": "Hi."})
step = "01K7APDT000000000000000001"
out["add"] = call("PUT", "", {"key": "sekrit-key", "step": step})[1]["inworld"]
out["db"] = "sekrit-key" in open(os.path.join(os.environ["UNBLENT_DATA"], "u1", "voice.db"), "rb").read().decode("latin-1")
out["undo"] = call("PUT", "/key/step", {"step": step, "restore": "before", "expect": "after"})[1]["inworld"]
out["undoAgain"] = call("PUT", "/key/step", {"step": step, "restore": "before", "expect": "after"})
out["redo"] = call("PUT", "/key/step", {"step": step, "restore": "after", "expect": "before"})[1]["inworld"]
out["forget"] = call("PUT", "/key/forget", {"step": step})
out["gone"] = call("PUT", "/key/step", {"step": step, "restore": "before", "expect": "after"})
out["voice"] = call("PUT", "", {"voice": "test"})[1]["voice"]
out["said"] = call("POST", "/speak", {"text": "Hi there."})[1]["mime"]
out["bad"] = [call("PUT", "", b)[0] for b in ({"voice": "af_heart"}, {"download": "start"}, {"step": step}, {"key": 3})]
client.cookies.set(SESSION_COOKIE, session_token("u2"))
out["other"] = call("GET")[1]
`,
      data,
    );
    assert.deepEqual(out.anonymous, [[200, { error: "signed-out" }], [200, { error: "signed-out" }], 401]);
    const voices = out.fresh[1].voices;
    assert.deepEqual(out.fresh, [200, { here: "web", inworld: { keySet: false }, voice: "Ashley", voices }]);
    assert.deepEqual(voices.map((v) => v.id), ["Ashley", "Dennis", "Olivia", "Timothy", "test"]);
    assert.deepEqual(out.noKey, [200, { error: "no-key" }]);
    assert.deepEqual(out.add, { keySet: true });
    assert.equal(out.db, false, "the key is stored encrypted");
    assert.deepEqual(out.undo, { keySet: false });
    assert.deepEqual(out.undoAgain, [200, { error: "changed" }], "the key is no longer as the step left it");
    assert.deepEqual(out.redo, { keySet: true });
    assert.deepEqual(out.forget, [200, { ok: true }]);
    assert.deepEqual(out.gone, [200, { error: "changed" }], "a forgotten step keeps nothing");
    assert.equal(out.voice, "test");
    assert.equal(out.said, "audio/wav");
    assert.deepEqual(out.bad, [400, 400, 400, 400]);
    assert.deepEqual(out.other, { here: "web", inworld: { keySet: false }, voice: "Ashley", voices }, "another account sees none of it");
  }));

test("Inworld is asked with the account's key and its word timestamps place the words", () =>
  withData((data) => {
    const out = run(
      `
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from components.voice.server import inworld_adapter
asked = []
class Stand(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        asked.append([self.headers["Authorization"], body["voiceId"], body["timestampType"], body["text"]])
        if self.headers["Authorization"] == "Basic bad":
            self.send_response(401); self.end_headers(); return
        reply = {"audioContent": base64.b64encode(b"ID3").decode(), "timestampInfo": {"wordAlignment": {
            "words": ["Hello,", "world!"], "wordStartTimeSeconds": [0, 0.5], "wordEndTimeSeconds": [0.4, 1.0]}}}
        data = json.dumps(reply).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass
stand = HTTPServer(("127.0.0.1", 0), Stand)
threading.Thread(target=stand.serve_forever, daemon=True).start()
inworld_adapter._URL = f"http://127.0.0.1:{stand.server_port}"
client.cookies.set(SESSION_COOKIE, session_token("u1"))
call("PUT", "", {"key": "good", "voice": "Dennis"})
out["said"] = call("POST", "/speak", {"text": "Hello, world!"})[1]
call("PUT", "", {"key": "bad"})
out["refused"] = call("POST", "/speak", {"text": "Hello, world!"})[1]
out["asked"] = asked
stand.shutdown()
`,
      data,
    );
    assert.deepEqual(out.said, {
      mime: "audio/mpeg",
      audio: "SUQz",
      words: [{ from: 0, to: 5, start: 0, end: 0.4 }, { from: 7, to: 12, start: 0.5, end: 1 }],
    });
    assert.deepEqual(out.refused, { error: "no-key" }, "a key Inworld refuses reads as no key");
    assert.deepEqual(out.asked[0], ["Basic good", "Dennis", "WORD", "Hello, world!"]);
  }));
