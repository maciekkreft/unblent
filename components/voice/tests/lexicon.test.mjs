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
  unknownHyphenName: "marcus-aurelius",
  unknownPossessive: "Rusticus’s",
  trailingApostrophe: "Marcus'",
  capitals: "ZORK",
  capitalsKnown: "NASA",
  noVowelLower: "hmmph",
  greek: "τὰ καὶ πρὸς",
  greekBetween: "good τὰ men",
  greekPossessive: "τὰ’s",
  names: "Rusticus Antoninus Marcus Aurelius Maximus Verus Fronto Severus Diognetus Cato Pompeius Caius Chrysippus Sertorius Brutus Rufus Demetrius Æsculapius",
  archaic: "shouldst seest sayest choosest wishest findest thinkest rememberest lovest mightest returnest stoppest triest",
  ordinary: "wearied wearier pacified homebred bloodspitting ebook",
};

// The expected sound of each name: the stressed vowel with its mark, the rest around it, the
// same way the gold dictionary writes Titus, Julius, Epictetus and Heraclitus.
const NAMES = {
  Rusticus: "ɹˈʌstɪkəs",
  Antoninus: "ˌæntənˈInəs",
  Marcus: "mˈɑɹkəs",
  Aurelius: "ɔɹˈiliəs",
  Maximus: "mˈæksɪməs",
  Verus: "vˈɪɹəs",
  Fronto: "fɹˈɑntO",
  Severus: "səvˈɪɹəs",
  Diognetus: "dˌIəɡnˈiTəs",
  Cato: "kˈATO",
  Pompeius: "pɑmpˈAəs",
  Caius: "kˈIəs",
  Chrysippus: "kɹɪsˈɪpəs",
  Sertorius: "sɜɹtˈɔɹiəs",
  Brutus: "bɹˈuTəs",
  Rufus: "ɹˈufəs",
  Demetrius: "dəmˈitɹiəs",
  Æsculapius: "ˌɛskjəlˈApiəs",
};

const out = JSON.parse(
  execFileSync(
    `${ROOT}.venv/bin/python`,
    [
      "-c",
      `
import json, sys
from components.voice.server import kokoro_engine, lexicon
cases = json.loads(sys.argv[1])
out = {k: lexicon.phonemize(v) for k, v in cases.items()}
out["tokens"] = [[t.start, t.end, t.kind] for t in lexicon.tokens(cases["morning"])]
out["each"] = {w: lexicon.phonemize(w) for k in ("names", "archaic", "ordinary") for w in cases[k].split()}
out["greekTokens"] = [[t.kind, t.phonemes, t.space] for t in lexicon.tokens(cases["greekBetween"])]
out["goldNames"] = {w: [lexicon.sound_out(w), lexicon._load()[0][w]] for w in ("Titus", "Xenophon", "Seneca", "Claudius")}
vocabulary = json.load(open("components/voice/server/data/kokoro_vocab.json", encoding="utf-8"))
out["outside"] = sorted({c for v in out["each"].values() for c in v if c not in vocabulary})
tokens = lexicon.tokens(cases["greekBetween"])
ids, spans = kokoro_engine._ids(tokens)
out["engine"] = {
    "pieces": [[t.phonemes for t in p] for p in kokoro_engine._pieces(tokens)],
    "plain": kokoro_engine._ids(lexicon.tokens("good men"))[0],
    "ids": ids,
    "spans": [[t.start, t.end] for t, _, _ in spans],
}
audio, words = kokoro_engine.speak(cases["greek"], "af_heart", None, None)
out["allGreek"] = [audio[:4].decode(), len(audio) > 44, words]
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

test("an unknown word is split at hyphens and apostrophes, and each part is sounded out", () => {
  assert.equal(out.hyphen, "wˈɛl nˈOn");
  assert.equal(out.unknownHyphen, "zˈɔɹk θˈɪŋ");
  assert.equal(out.unknownHyphenName, "mˈɑɹkəs ɔɹˈiliəs");
  assert.equal(out.unknownPossessive, "ɹˈʌstɪkəsᵻz");
  assert.equal(out.trailingApostrophe, "mˈɑɹkəs");
  assert.equal(out.accent, "kæfˈA");
});

test("only an all-capital unknown word and a word with no vowel letter are spelled", () => {
  assert.equal(out.spelled, "zˌiˌɛkskjˌuvˈi");
  assert.equal(out.possessive, "zˌiˌɛkskjˌuvˈiz");
  assert.equal(out.initialism, "ˌɛfbˌiˈI");
  assert.equal(out.capitals, "zˌiˌOˌɑɹkˈA");
  assert.equal(out.noVowelLower, "ˌAʧˌɛmˌɛmpˌiˈAʧ");
  assert.equal(out.capitalsKnown, "nˈæsə", "the dictionary reads NASA as a word");
});

test("a name is sounded out with one primary stress, on the syllable English stresses", () => {
  for (const [name, sound] of Object.entries(NAMES)) {
    assert.equal(out.each[name], sound, name);
    assert.equal(sound.split("ˈ").length, 2, name);
  }
});

test("the rules agree with the gold dictionary on names it holds", () => {
  assert.deepEqual(out.goldNames.Titus, ["tˈIɾəs", "tˈIɾəs"]);
  assert.deepEqual(out.goldNames.Xenophon, ["zˈɛnəfˌɑn", "zˈɛnəfˌɑn"]);
  assert.deepEqual(out.goldNames.Seneca, ["sˈɛnəkə", "sˈɛnəkə"]);
  assert.deepEqual(out.goldNames.Claudius, ["klˈɔdiəs", "klˈɔdiəs"]);
});

test("old verb forms and -ied, -ier come from the known stem", () => {
  assert.equal(out.each.thinkest, "θˈɪŋkᵻst");
  assert.equal(out.each.findest, "fˈIndᵻst");
  assert.equal(out.each.seest, "sˈiᵻst");
  assert.equal(out.each.sayest, "sˈAᵻst");
  assert.equal(out.each.lovest, "lˈʌvᵻst", "love, not lov");
  assert.equal(out.each.choosest, "ʧˈuzᵻst");
  assert.equal(out.each.wishest, "wˈɪʃᵻst");
  assert.equal(out.each.rememberest, "ɹəmˈɛmbəɹᵻst");
  assert.equal(out.each.returnest, "ɹətˈɜɹnᵻst");
  assert.equal(out.each.mightest, "mˌITᵻst");
  assert.equal(out.each.shouldst, "ʃˌʊdst");
  assert.equal(out.each.stoppest, "stˈɑpᵻst");
  assert.equal(out.each.triest, "tɹˈIᵻst");
  assert.equal(out.each.wearied, "wˈɪɹid");
  assert.equal(out.each.wearier, "wˈɪɹiəɹ");
  assert.equal(out.each.pacified, "pˈæsəfˌId");
});

test("a word written together is read as its two known words", () => {
  assert.equal(out.each.homebred, "hˈOmbɹˌɛd");
  assert.equal(out.each.bloodspitting, "blˈʌdspˌɪTɪŋ");
  assert.equal(out.each.ebook, "ˈibʊk");
});

test("every sound the rules write is in Kokoro's vocabulary", () => {
  assert.deepEqual(out.outside, []);
});

test("a word in Greek is silent, and takes no time and no sound in the engine", () => {
  assert.equal(out.greek, "");
  assert.equal(out.greekPossessive, "");
  assert.equal(out.greekBetween, "ɡˈʊd mˈɛn");
  assert.deepEqual(out.greekTokens[1], ["word", "", true], "its token stays, so the text keeps its places");
  assert.deepEqual(out.engine.ids, out.engine.plain, "the same sounds as without it, with one space");
  assert.deepEqual(out.engine.spans, [[0, 4], [8, 11]], "only the spoken words are timed");
  assert.deepEqual(out.engine.pieces, [["ɡˈʊd", "", "mˈɛn"]]);
  assert.deepEqual(out.allGreek, ["RIFF", true, []], "a paragraph all in Greek is a short silence, not an error");
});

test("every word and mark keeps where it stands in the text", () => {
  assert.deepEqual(out.tokens, [
    [0, 5, "word"], [6, 9, "word"], [10, 17, "word"], [18, 20, "word"],
    [21, 27, "word"], [28, 30, "word"], [31, 38, "word"], [38, 39, "punct"],
  ]);
});
