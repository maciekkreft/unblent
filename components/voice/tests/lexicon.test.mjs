import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Words to sounds (server/lexicon.py), in one python process: the dictionaries are read
// once, then every case is asked.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const cases = {
  morning: "Begin the morning by saying to thyself.",
  stems: "books walked reading",
  article: "the apple and the book",
  capital: "Begin",
  numbers: "1,234",
  year: "1984",
  oh: "1905",
  ordinal: "21st",
  decimal: "3.14",
  minus: "-5",
  decade: "1990s",
  hyphen: "well-known",
  unknownHyphen: "Zork-thing",
  spelled: "Zxqv",
  possessive: "Zxqv's",
  initialism: "FBI",
  accent: "café",
  curly: "don’t",
};

const out = JSON.parse(
  execFileSync(
    `${ROOT}.venv/bin/python`,
    [
      "-c",
      `
import json, sys
from components.voice.server import lexicon
cases = json.loads(sys.argv[1])
out = {k: lexicon.phonemize(v) for k, v in cases.items()}
out["tokens"] = [[t.start, t.end, t.kind] for t in lexicon.tokens(cases["morning"])]
print(json.dumps(out))
`,
      JSON.stringify(cases),
    ],
    { cwd: ROOT },
  ),
);

test("dictionary words take misaki's phonemes, with stems, articles and capitals", () => {
  assert.equal(out.morning, "bəɡˈɪn ðə mˈɔɹnɪŋ bI sˈAɪŋ tə ðˌIsˈɛlf.");
  assert.equal(out.stems, "bˈʊks wˈɔkt ɹˈidɪŋ");
  assert.equal(out.article, "ði ˈæpᵊl ænd ðə bˈʊk", "the before a vowel");
  assert.equal(out.capital, "bəɡˈɪn");
  assert.equal(out.curly, "dˈOnt");
});

test("numbers are read as words: thousands, years, ordinals, decimals, signs and decades", () => {
  assert.equal(out.numbers, "wˈʌn θˈWzᵊnd tˈu hˈʌndɹəd θˈɜɹTi fˈɔɹ");
  assert.equal(out.year, "nˌIntˈin ˈATi fˈɔɹ");
  assert.equal(out.oh, "nˌIntˈin ˈO fˈIv");
  assert.equal(out.ordinal, "twˈɛnti fˈɜɹst");
  assert.equal(out.decimal, "θɹˈi pYnt wˈʌn fˈɔɹ");
  assert.equal(out.minus, "mˈInəs fˈIv");
  assert.equal(out.decade, "nˌIntˈin nˈIndiz");
});

test("an unknown word is split at hyphens and apostrophes, else spelled letter by letter", () => {
  assert.equal(out.hyphen, "wˈɛl nˈOn");
  assert.ok(out.unknownHyphen.endsWith(" θˈɪŋ"), out.unknownHyphen);
  assert.equal(out.spelled, "zˌiˌɛkskjˌuvˈi");
  assert.equal(out.possessive, "zˌiˌɛkskjˌuvˈiz");
  assert.equal(out.initialism, "ˌɛfbˌiˈI");
  assert.equal(out.accent, "kæfˈA");
});

test("every word and mark keeps where it stands in the text", () => {
  assert.deepEqual(out.tokens, [
    [0, 5, "word"], [6, 9, "word"], [10, 17, "word"], [18, 20, "word"],
    [21, 27, "word"], [28, 30, "word"], [31, 38, "word"], [38, 39, "punct"],
  ]);
});
