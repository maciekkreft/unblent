"""Words to sounds for the Kokoro voice (architecture.md 10): the phonemes Kokoro reads,
looked up in misaki's American dictionaries (data/us_gold.json and data/us_silver.json,
Apache-2.0, see data/NOTICE), with no espeak-ng, no PyTorch and no part-of-speech tagger.

How a dictionary entry becomes Kokoro's phonemes, the stress marks included, follows
misaki's own `en.Lexicon` (en.py at the pinned commit), cut down to what needs no tagger:
an entry that differs by part of speech takes its default, or its "None" form at the end
of a sentence. Numbers are written out in words by our own code. A word in neither
dictionary, with no known stem, is split at hyphens and apostrophes; a part still not
found is spelled letter by letter.

`tokens(text)` returns every word, number and punctuation mark of the text in order, each
with where it stands in the text and its phonemes, so the engine can tell when each word
is said. `phonemize(text)` joins them into the string Kokoro reads.
"""

import json
import re
import threading
import unicodedata
from dataclasses import dataclass
from pathlib import Path

_DATA = Path(__file__).parent / "data"

STRESSES = "ˌˈ"
PRIMARY = "ˈ"
SECONDARY = "ˌ"
VOWELS = frozenset("AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ")
CONSONANTS = frozenset("bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ")
PUNCTS = frozenset(';:,.!?—…"“”()')
NON_QUOTE_PUNCTS = frozenset(';:,.!?—…')
US_TAUS = frozenset("AIOWYiuæɑəɛɪɹʊʌ")
ORDINALS = ("st", "nd", "rd", "th")
SYMBOLS = {"%": "percent", "&": "and", "+": "plus", "@": "at"}

_lock = threading.Lock()
_golds: dict | None = None
_silvers: dict | None = None


def _grow(d: dict) -> dict:
    # misaki's grow_dictionary: a lower-case entry also answers its capitalised form, and
    # a capitalised one its lower-case form.
    extra = {}
    for k, v in d.items():
        if len(k) < 2:
            continue
        if k == k.lower():
            if k != k.capitalize():
                extra[k.capitalize()] = v
        elif k == k.lower().capitalize():
            extra[k.lower()] = v
    return {**extra, **d}


def _load() -> tuple[dict, dict]:
    global _golds, _silvers
    with _lock:
        if _golds is None:
            _golds = _grow(json.loads((_DATA / "us_gold.json").read_text(encoding="utf-8")))
            _silvers = _grow(json.loads((_DATA / "us_silver.json").read_text(encoding="utf-8")))
    return _golds, _silvers


def apply_stress(ps: str | None, stress) -> str | None:
    """misaki's apply_stress: a capitalised word is stressed, a word inside a number or a
    joined word is lightened."""

    def restress(ps):
        ips = list(enumerate(ps))
        stresses = {i: next(j for j, v in ips[i:] if v in VOWELS) for i, p in ips if p in STRESSES}
        for i, j in stresses.items():
            ips[i] = (j - 0.5, ips[i][1])
        return "".join(p for _, p in sorted(ips))

    if ps is None or stress is None:
        return ps
    if stress < -1:
        return ps.replace(PRIMARY, "").replace(SECONDARY, "")
    if stress == -1 or (stress in (0, -0.5) and PRIMARY in ps):
        return ps.replace(SECONDARY, "").replace(PRIMARY, SECONDARY)
    if stress in (0, 0.5, 1) and all(s not in ps for s in STRESSES):
        if all(v not in ps for v in VOWELS):
            return ps
        return restress(SECONDARY + ps)
    if stress >= 1 and PRIMARY not in ps and SECONDARY in ps:
        return ps.replace(SECONDARY, PRIMARY)
    if stress > 1 and all(s not in ps for s in STRESSES):
        if all(v not in ps for v in VOWELS):
            return ps
        return restress(PRIMARY + ps)
    return ps


# --- Lookup --------------------------------------------------------------------------


def _pick(ps, future_vowel):
    # Without a tagger an entry that differs by part of speech takes its default, or the
    # form misaki gives a word with nothing after it.
    if isinstance(ps, dict):
        if future_vowel is None and "None" in ps:
            return ps["None"]
        return ps.get("DEFAULT")
    return ps


def spell(word: str) -> str | None:
    """A word read letter by letter, as misaki reads an initialism: each letter's name,
    the last one stressed."""
    golds, _ = _load()
    letters = [golds.get(c.upper()) for c in word if c.isalpha()]
    letters = [p for p in letters if p]
    if not letters:
        return None
    ps = apply_stress("".join(letters), 0)
    if SECONDARY not in ps:
        return ps
    head, _, tail = ps.rpartition(SECONDARY)
    return f"{head}{PRIMARY}{tail}"


def _is_known(word: str) -> bool:
    golds, silvers = _load()
    if word in golds or word in silvers or word in SYMBOLS:
        return True
    if not word.isascii() or not word.replace("'", "").isalpha():
        return False
    if len(word) == 1:
        return True
    if word == word.upper() and word.lower() in golds:
        return True
    return word[1:] == word[1:].upper()


def _lookup(word: str, stress, future_vowel):
    golds, silvers = _load()
    initialism = False
    if word == word.upper() and word not in golds:
        word = word.lower()
        initialism = True
    ps = golds.get(word)
    if ps is None and not initialism:
        ps = silvers.get(word)
    ps = _pick(ps, future_vowel)
    if ps is None or (initialism and PRIMARY not in ps):
        return spell(word)
    return apply_stress(ps, stress)


def _s(stem):
    if not stem:
        return None
    if stem[-1] in "ptkfθ":
        return stem + "s"
    if stem[-1] in "szʃʒʧʤ":
        return stem + "ᵻz"
    return stem + "z"


def _stem_s(word, stress, fv):
    if len(word) < 3 or not word.endswith("s"):
        return None
    if not word.endswith("ss") and _is_known(word[:-1]):
        stem = word[:-1]
    elif (word.endswith("'s") or (len(word) > 4 and word.endswith("es") and not word.endswith("ies"))) and _is_known(word[:-2]):
        stem = word[:-2]
    elif len(word) > 4 and word.endswith("ies") and _is_known(word[:-3] + "y"):
        stem = word[:-3] + "y"
    else:
        return None
    return _s(_lookup(stem, stress, fv))


def _ed(stem):
    if not stem:
        return None
    if stem[-1] in "pkfθʃsʧ":
        return stem + "t"
    if stem[-1] == "d":
        return stem + "ᵻd"
    if stem[-1] != "t":
        return stem + "d"
    if len(stem) < 2:
        return stem + "ɪd"
    if stem[-2] in US_TAUS:
        return stem[:-1] + "ɾᵻd"
    return stem + "ᵻd"


def _stem_ed(word, stress, fv):
    if len(word) < 4 or not word.endswith("d"):
        return None
    if not word.endswith("dd") and _is_known(word[:-1]):
        stem = word[:-1]
    elif len(word) > 4 and word.endswith("ed") and not word.endswith("eed") and _is_known(word[:-2]):
        stem = word[:-2]
    else:
        return None
    return _ed(_lookup(stem, stress, fv))


def _ing(stem):
    if not stem:
        return None
    if len(stem) > 1 and stem[-1] == "t" and stem[-2] in US_TAUS:
        return stem[:-1] + "ɾɪŋ"
    return stem + "ɪŋ"


def _stem_ing(word, stress, fv):
    if len(word) < 5 or not word.endswith("ing"):
        return None
    if len(word) > 5 and _is_known(word[:-3]):
        stem = word[:-3]
    elif _is_known(word[:-3] + "e"):
        stem = word[:-3] + "e"
    elif len(word) > 5 and re.search(r"([bcdgklmnprstvxz])\1ing$|cking$", word) and _is_known(word[:-4]):
        stem = word[:-4]
    else:
        return None
    return _ing(_lookup(stem, stress, fv))


def _special(word: str, fv):
    # misaki's special cases that need no tagger, read as the common part of speech:
    # "a" and "the" as articles, "to" and "in" as prepositions, "I" as the pronoun.
    golds, _ = _load()
    if word in ("a", "A"):
        return "ɐ"
    if word in ("an", "An", "AN"):
        return "ɐn"
    if word == "I":
        return f"{SECONDARY}I"
    if word in ("to", "To", "TO"):
        return {None: golds["to"], False: "tə", True: "tʊ"}[fv]
    if word in ("in", "In", "IN"):
        return (PRIMARY if fv is None else "") + "ɪn"
    if word in ("the", "The", "THE"):
        return "ði" if fv is True else "ðə"
    if word in ("used", "Used", "USED"):
        return golds["used"]["DEFAULT"]
    return None


def _word(word: str, fv) -> str | None:
    """One word's phonemes from the dictionaries, or None when neither knows it."""
    golds, silvers = _load()
    ps = _special(word, fv)
    if ps is not None:
        return ps
    stress = None if word == word.lower() else (2 if word == word.upper() else 0.5)
    lower = word.lower()
    if (
        len(word) > 1
        and word != lower
        and word not in golds
        and word not in silvers
        and (word == word.upper() or word[1:] == word[1:].lower())
        and (lower in golds or lower in silvers or any(fn(lower, stress, fv) for fn in (_stem_s, _stem_ed, _stem_ing)))
    ):
        word = lower
    if _is_known(word):
        return _lookup(word, stress, fv)
    if word.endswith("s'") and _is_known(word[:-2] + "'s"):
        return _lookup(word[:-2] + "'s", stress, fv)
    if word.endswith("'") and _is_known(word[:-1]):
        return _lookup(word[:-1], stress, fv)
    for fn, s in ((_stem_s, stress), (_stem_ed, stress), (_stem_ing, 0.5 if stress is None else stress)):
        ps = fn(word, s, fv)
        if ps is not None:
            return ps
    return None


def word_phonemes(word: str, future_vowel=None) -> str:
    """A word as Kokoro reads it: from the dictionaries; else its parts split at hyphens
    and apostrophes; else spelled letter by letter."""
    word = _plain(word)
    ps = _word(word, future_vowel)
    if ps is not None:
        return ps
    if word.endswith("'s") and len(word) > 2:
        # An unknown name's possessive: the name as found, with the s of a plural.
        return _s(word_phonemes(word[:-2], future_vowel)) or ""
    parts = [p for p in re.split(r"[-']", word) if p]
    if len(parts) > 1:
        out = []
        for part in parts:
            if part.isdigit():
                out.append(number_phonemes(part))
            else:
                out.append(_word(part, future_vowel) or spell(part) or "")
        return " ".join(p for p in out if p)
    return spell(word) or ""


def _plain(word: str) -> str:
    # Curly apostrophes as straight ones, and accents dropped, since the dictionaries
    # hold plain letters only (café as cafe).
    word = word.replace("‘", "'").replace("’", "'")
    decomposed = unicodedata.normalize("NFKD", word)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


# --- Numbers -------------------------------------------------------------------------

_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_SCALES = [(10**12, "trillion"), (10**9, "billion"), (10**6, "million"), (1000, "thousand")]
_ORDINAL_WORDS = {
    "one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
    "nine": "ninth", "twelve": "twelfth",
}


def _below_thousand(n: int) -> list[str]:
    words = []
    if n >= 100:
        words += [_ONES[n // 100], "hundred"]
        n %= 100
    if n >= 20:
        words.append(_TENS[n // 10])
        n %= 10
        if n:
            words.append(_ONES[n])
    elif n or not words:
        words.append(_ONES[n])
    return words


def number_words(n: int) -> list[str]:
    """A whole number in English words, without "and": 1234 is one thousand two hundred
    thirty four."""
    if n == 0:
        return ["zero"]
    words = []
    if n < 0:
        words.append("minus")
        n = -n
    for scale, name in _SCALES:
        if n >= scale:
            words += number_words(n // scale) + [name]
            n %= scale
    if n:
        words += _below_thousand(n)
    return words


def ordinal_words(n: int) -> list[str]:
    words = number_words(n)
    last = words[-1]
    if last in _ORDINAL_WORDS:
        words[-1] = _ORDINAL_WORDS[last]
    elif last.endswith("y"):
        words[-1] = last[:-1] + "ieth"
    else:
        words[-1] = last + "th"
    return words


def year_words(n: int) -> list[str]:
    """A four-digit number read as a year, 1984 as nineteen eighty four, 1905 as nineteen
    oh five; a year of a round thousand, or from 2000 to 2009, is read as a number."""
    high, low = divmod(n, 100)
    if n % 1000 == 0 or 2000 <= n < 2010:
        return number_words(n)
    if low == 0:
        return number_words(high) + ["hundred"]
    if low < 10:
        return number_words(high) + ["oh"] + number_words(low)
    return number_words(high) + number_words(low)


def number_phonemes(text: str) -> str:
    """A number as written (1,000, 3.14, 1984, 21st, 1990s, -5) in Kokoro's phonemes."""
    golds, _ = _load()
    m = re.fullmatch(r"(-?)([\d,]*\d)(?:\.(\d+))?(st|nd|rd|th|s|'s)?", text)
    if not m:
        return " ".join(filter(None, (number_phonemes(d) for d in re.findall(r"\d+", text))))
    sign, whole, decimals, suffix = m.groups()
    digits = whole.replace(",", "")
    n = int(digits)
    if suffix in ORDINALS:
        words = ordinal_words(n)
    elif len(digits) == 4 and "," not in whole and not decimals and not sign:
        words = year_words(n)
    else:
        words = number_words(n)
    if decimals:
        words += ["point"] + [_ONES[int(d)] for d in decimals]
    if sign:
        words = ["minus"] + words
    out = []
    for w in words:
        ps = golds.get(w)
        out.append(apply_stress(ps, -2) if w == "point" else ps)
    ps = " ".join(p for p in out if p)
    if suffix in ("s", "'s"):
        # The 1990s: the last word takes an s, as a plural does.
        ps = _s(ps)
    return ps


# --- Text ----------------------------------------------------------------------------


@dataclass
class Token:
    start: int  # where it stands in the text, in characters
    end: int
    kind: str  # "word" (a word or a number) or "punct"
    phonemes: str
    space: bool  # whitespace stands between it and the token before


_TOKEN = re.compile(
    r"(?P<number>-?\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th|'s|s)?(?![\w]))"
    r"|(?P<word>[^\W\d_]+(?:['’\-][^\W\d_]+)*'?)"
    r"|(?P<dash>--+|[–—])"
    r"|(?P<punct>[;:,.!?…\"“”()])"
    r"|(?P<symbol>[%&+@])"
)


def tokens(text: str) -> list[Token]:
    """Every word, number and punctuation mark of the text, in order, with its phonemes.
    Read from the end back, as misaki does, because "the" and "to" sound different before
    a vowel."""
    found = []
    last = 0
    for m in _TOKEN.finditer(text):
        # Anything skipped between two tokens, such as a stray symbol, counts as a gap.
        found.append((m, m.start() > last))
        last = m.end()
    out: list[Token] = []
    future_vowel = None
    for m, space in reversed(found):
        kind = m.lastgroup
        raw = m.group()
        if kind == "number":
            ps, k = number_phonemes(raw), "word"
        elif kind == "word":
            ps, k = word_phonemes(raw, future_vowel), "word"
        elif kind == "symbol":
            ps, k = word_phonemes(SYMBOLS[raw], future_vowel), "word"
        elif kind == "dash":
            ps, k = "—", "punct"
        else:
            ps, k = ("…" if raw == "…" else raw), "punct"
        out.append(Token(m.start(), m.end(), k, ps, space))
        future_vowel = _future_vowel(future_vowel, ps)
    out.reverse()
    for t in out:
        # Kokoro v1.0 reads a flap as T and a glottal stop as t, as misaki gives it.
        t.phonemes = t.phonemes.replace("ɾ", "T").replace("ʔ", "t")
    return out


def _future_vowel(current, ps):
    for c in ps:
        if c in NON_QUOTE_PUNCTS:
            return None
        if c in VOWELS:
            return True
        if c in CONSONANTS:
            return False
    return current


def phonemize(text: str) -> str:
    out = ""
    for t in tokens(text):
        if not t.phonemes:
            continue
        if out and t.space:
            out += " "
        out += t.phonemes
    return out
