"""Words to sounds for the Kokoro voice (architecture.md 10): the phonemes Kokoro reads,
looked up in misaki's American dictionaries (data/us_gold.json and data/us_silver.json,
Apache-2.0, see data/NOTICE), with no espeak-ng, no PyTorch and no part-of-speech tagger.

How a dictionary entry becomes Kokoro's phonemes, the stress marks included, follows
misaki's own `en.Lexicon` (en.py at the pinned commit), cut down to what needs no tagger:
an entry that differs by part of speech takes its default, or its "None" form at the end
of a sentence. Numbers are written out in words by our own code. A word in neither
dictionary, with no known stem or ending, is split at hyphens and apostrophes; a part
still not found is cut into two known words if it can be, and otherwise sounded out by our
own letters-to-sounds rules (`sound_out`), which write the dictionaries' notation and read
a name as English reads Latin and Greek names. Only an all-capital word and a word with no
vowel letter are spelled letter by letter. A word in another script, such as Greek, is
silent: its token stays in the text with no phonemes, and the engine gives it no time.

`tokens(text)` returns every word, number and punctuation mark of the text in order, each
with where it stands in the text and its phonemes, so the engine can tell when each word
is said. `phonemize(text)` joins them into the string Kokoro reads.
"""

import json
import re
import threading
import unicodedata
from dataclasses import dataclass, field
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


def _stem_y(word, stress, fv):
    # wearied from weary, wearier from weary.
    if len(word) < 5 or word[-3:] not in ("ied", "ier") or not _is_known(word[:-3] + "y"):
        return None
    stem = _lookup(word[:-3] + "y", stress, fv)
    if not stem:
        return None
    return _ed(stem) if word.endswith("d") else stem + "əɹ"


def _flapped(stem, ending):
    # The dictionaries flap a t before these endings: greatest is ɡɹˈAɾᵻst.
    if len(stem) > 1 and stem[-1] == "t" and stem[-2] in US_TAUS:
        return stem[:-1] + "ɾ" + ending
    return stem + ending


def _archaic_stem(word):
    # hopest is hope and not hop, so a stem with its e goes first, and a stem in the gold
    # dictionary before one that only the silver dictionary holds, because silver holds
    # many surnames (Beare beside bear).
    golds, _ = _load()
    base = word[:-3]
    found = [base + "e", base]
    if len(base) > 2 and base[-1] == base[-2]:
        found.append(base[:-1])
    if base.endswith("i"):
        found.append(base[:-1] + "y")
    found = [w for w in found if len(w) > 1]
    return next((w for w in found if w in golds), next((w for w in found if _is_known(w)), None))


def _stem_archaic(word, stress, fv):
    # The old second and third person of a known verb: thinkest, seest, loveth, shouldst.
    if len(word) >= 5 and word[-3:] in ("est", "eth"):
        stem = _archaic_stem(word)
        if stem:
            return _flapped(_lookup(stem, stress, fv) or "", "ᵻst" if word.endswith("t") else "əθ")
    if len(word) >= 5 and re.search(r"[dtln]st$", word) and _is_known(word[:-2]):
        return (_lookup(word[:-2], stress, fv) or "") + "st"
    return None


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
        and (lower in golds or lower in silvers or any(fn(lower, stress, fv) for fn in (_stem_s, _stem_ed, _stem_ing, _stem_y, _stem_archaic)))
    ):
        word = lower
    if _is_known(word):
        return _lookup(word, stress, fv)
    if word.endswith("s'") and _is_known(word[:-2] + "'s"):
        return _lookup(word[:-2] + "'s", stress, fv)
    if word.endswith("'") and _is_known(word[:-1]):
        return _lookup(word[:-1], stress, fv)
    for fn, s in (
        (_stem_s, stress),
        (_stem_ed, stress),
        (_stem_ing, 0.5 if stress is None else stress),
        (_stem_y, stress),
        (_stem_archaic, stress),
    ):
        ps = fn(word, s, fv)
        if ps is not None:
            return ps
    return None


def word_phonemes(word: str, future_vowel=None) -> str:
    """A word as Kokoro reads it: from the dictionaries; else its parts split at hyphens
    and apostrophes; else what `_unknown` makes of it."""
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
                out.append(_word(part, future_vowel) or _unknown(part, future_vowel))
        return " ".join(p for p in out if p)
    return _unknown(parts[0], future_vowel) if parts else ""


def _unknown(word: str, fv) -> str:
    """A word no dictionary or ending explains. Silent in another script, because English
    letter names and rules say nothing true about it. Spelled when all capitals (NASA) or
    when no vowel letter gives it a syllable. Otherwise two known words, or sounded out."""
    letters = _latin(word)
    if letters is None:
        return ""
    if not re.search(r"[aeiouy]", letters) or (len(word) > 1 and word == word.upper()):
        return spell(word) or ""
    return _compound(word, fv) or sound_out(word)


def _compound(word: str, fv) -> str | None:
    # A written-together word, homebred as home and bred. A capitalized word needs longer
    # parts, because a Latin name falls into short English words by chance (Mar and cus).
    golds, _ = _load()
    low = word.lower()
    least = 3 if word == low else 4
    if low.startswith("un") and len(low) - 2 >= least:
        rest = _word(low[2:], fv)
        if rest:
            return "ʌn" + rest
    for cut in range(len(low) - least, least - 1, -1):
        if low[:cut] in golds:
            head, tail = _word(low[:cut], fv), _word(low[cut:], fv)
            if head and tail:
                return apply_stress(head, 2) + apply_stress(tail, -1)
    return None


def _plain(word: str) -> str:
    # Curly apostrophes as straight ones, and accents dropped, since the dictionaries
    # hold plain letters only (café as cafe).
    word = word.replace("‘", "'").replace("’", "'")
    decomposed = unicodedata.normalize("NFKD", word)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


# --- Letters to sounds ----------------------------------------------------------------

_LATIN_LETTERS = {"æ": "ae", "œ": "oe", "ø": "o", "ß": "ss"}
_VOWEL_LETTERS = frozenset("aeiouy")
_VOICED = frozenset("bdɡvmnlɹŋðʒ")
_STOP_LETTERS = ("b", "c", "d", "f", "g", "p", "t", "ch", "ph", "th")
# Consonants before which an unstressed u keeps its y sound: Æsculapius is ˌɛskjəlˈApiəs.
_U_GLIDES = frozenset("kpbɡmf")
# Latin's long penults, which a spelling cannot show: Antoninus, Epictetus, Severus. Without
# one a light penult sends the stress back a syllable, as in Rusticus.
_LONG_PENULT = re.compile(r"(?:an|in|at|et|en|ut|on|er)(?:us|um|a|as)$|ed(?:es)$")
_CLASSICAL_END = re.compile(r"(?:us|um|a|ae|es|on|as|is|os|ax|ix|i|o)$")
_LONG = {"a": "A", "e": "i", "i": "I", "y": "I", "o": "O", "u": "u"}
_SHORT = {"a": "æ", "e": "ɛ", "i": "ɪ", "y": "ɪ", "o": "ɑ", "u": "ʌ"}
_BEFORE_R = {"a": "ɑ", "e": "ɜ", "i": "ɜ", "y": "ɜ", "o": "ɔ", "u": "ɜ"}
_REDUCED = {"a": "ə", "e": "ə", "i": "ɪ", "y": "ɪ", "o": "ə", "u": "ə"}
_FINAL = {"a": "ə", "e": "i", "i": "I", "y": "i", "o": "O", "u": "u"}
_TEAMS = {"ae": "i", "oe": "i", "au": "ɔ", "eu": "ju", "ai": "A", "ay": "A", "ei": "A", "ey": "A",
          "oa": "O", "ou": "W", "oi": "Y", "oy": "Y", "aw": "ɔ", "ew": "ju", "ee": "i"}


def _latin(word: str) -> str | None:
    """The word's letters as plain lower-case a to z, or None when any is outside them."""
    low = "".join(_LATIN_LETTERS.get(c, c) for c in word.lower())
    return low if re.fullmatch(r"[a-z]+", low) else None


@dataclass
class _Vowel:
    letters: str  # one vowel letter, or a team such as ae
    sound: str = ""  # a team's sound
    after: list = field(default_factory=list)  # the consonants up to the next vowel


@dataclass
class _Consonant:
    letters: str
    sound: str
    double: bool = False  # written twice, or x: it closes the syllable before it


def _team(low: str, i: int) -> _Vowel | None:
    rest = low[i:]
    two = rest[:2]
    after = rest[2:3]
    if rest.startswith(("eigh", "aigh")):
        return _Vowel(rest[:4], "A")
    if rest.startswith(("augh", "ough")):
        return _Vowel(rest[:4], "ɔ")
    if rest.startswith("igh"):
        return _Vowel(rest[:3], "I")
    if two == "oo":
        return _Vowel(two, "ʊ" if after == "k" else "u")
    if two == "ow":
        return _Vowel(two, "O" if not rest[2:] else "W")
    if two == "ey" and not rest[2:]:
        return _Vowel(two, "i")
    if two == "ai" and after and after in _VOWEL_LETTERS:
        return _Vowel(two, "I")
    # Not a team before an e (Theaetetus, written with æ) or last in a word (Panthea).
    if two == "ea" and rest[2:] and after != "e":
        return _Vowel(two, "i")
    if two in ("ie", "ue") and not rest[2:]:
        return _Vowel(two, "i" if two == "ie" else "u")
    # A final -aus and -eus are two syllables: Archelaus, Orpheus.
    if (two == "au" and i > 1 and rest == "aus") or (two == "eu" and i > 0 and rest == "eus"):
        return None
    if two in _TEAMS:
        return _Vowel(two, _TEAMS[two])
    return None


def _consonant(low: str, i: int, classical: bool) -> _Consonant:
    rest = low[i:]
    c = low[i]
    after = rest[1:2]
    first = i == 0
    if rest.startswith("tch"):
        return _Consonant("tch", "ʧ")
    if rest == "tz":
        return _Consonant("tz", "ts")
    if rest[:2] == "sc" and rest[2:3] and rest[2:3] in "eiy":
        return _Consonant("sc", "s")
    if rest.startswith("sch"):
        return _Consonant("sch", "sk" if rest[3:4] == "o" else "ʃ")
    if rest.startswith("cch"):
        return _Consonant("cch", "k", True)
    if rest.startswith("tth"):
        return _Consonant("tth", "θ", True)
    if rest.startswith("qu"):
        return _Consonant("qu", "k" if rest == "que" else "kw")
    if c == "c" and after == "h":
        hard = classical or rest[2:3] not in _VOWEL_LETTERS
        return _Consonant("ch", "k" if hard else "ʧ")
    # -tia, -tius, -cius and -tion, but not at the start of a word and not after an s (Philistion).
    if c in "tc" and after == "i" and rest[2:3] and rest[2:3] in _VOWEL_LETTERS:
        if any(v in low[:i] for v in _VOWEL_LETTERS) and not (c == "t" and low[i - 1] == "s"):
            return _Consonant(rest[:2], "ʃ")
    for pair, sound in (("ph", "f"), ("th", "θ"), ("sh", "ʃ"), ("ck", "k"), ("rh", "ɹ"), ("wh", "w"), ("dg", "ʤ")):
        if rest.startswith(pair):
            return _Consonant(pair, sound)
    if c == "g" and after == "h":
        return _Consonant("gh", "ɡ" if first else "")
    if first and rest[:2] in ("gn", "kn", "wr", "ps", "pt"):
        return _Consonant(rest[:2], {"gn": "n", "kn": "n", "wr": "ɹ", "ps": "s", "pt": "t"}[rest[:2]])
    if rest == "mb":
        return _Consonant("mb", "m")
    if c == "n" and after == "g":
        if rest[2:3] and rest[2:3] in "eiy":
            return _Consonant("ng", "nʤ", True)
        return _Consonant("ng", "ŋɡ" if rest[2:3] and rest[2:3] in _VOWEL_LETTERS else "ŋ", True)
    if c == "n" and after and after in "kcqx":
        return _Consonant("n", "ŋ")
    if c == after:
        soft = rest[2:3] and rest[2:3] in "eiy"
        return _Consonant(c + c, {"c": "ks" if soft else "k", "g": "ɡ", "r": "ɹ"}.get(c, c), True)
    if c == "c":
        return _Consonant("c", "s" if after and after in "eiy" else "k")
    if c == "g":
        return _Consonant("g", "ʤ" if after and after in "eiy" else "ɡ")
    if c == "x":
        return _Consonant("x", "z" if first else "ks", not first)
    return _Consonant(c, {"j": "ʤ", "r": "ɹ", "y": "j"}.get(c, c))


def _parse(low: str, classical: bool) -> tuple[list[_Consonant], list[_Vowel]]:
    """The consonants before the first vowel, then each vowel with the consonants after it."""
    onset: list[_Consonant] = []
    vowels: list[_Vowel] = []
    i = 0
    while i < len(low):
        c = low[i]
        vowel = c in "aeiou" or (c == "y" and not (i == 0 and low[1:2] and low[1:2] in _VOWEL_LETTERS))
        if vowel:
            found = _team(low, i) or _Vowel(c)
            vowels.append(found)
            i += len(found.letters)
            continue
        unit = _consonant(low, i, classical)
        (vowels[-1].after if vowels else onset).append(unit)
        i += len(unit.letters)
    return onset, vowels


def _closed(vowel: _Vowel, last: bool) -> bool:
    """Whether the consonants after this vowel close its syllable. Two consonants do,
    unless they are a stop and an l or r, which begin the next syllable together (Heraclitus)."""
    after = vowel.after
    if not after:
        return False
    if last:
        return True
    if len(after) == 1:
        return after[0].double
    return not (len(after) == 2 and after[0].letters in _STOP_LETTERS and after[1].letters in ("l", "r"))


def _stress_at(vowels: list[_Vowel], low: str) -> int:
    n = len(vowels)
    if n < 3:
        return 0
    penult = vowels[-2]
    heavy = (
        len(penult.letters) > 1
        or _closed(penult, False)
        or bool(penult.after and penult.after[0].sound == "ʃ")
        or bool(_LONG_PENULT.search(low))
    )
    return n - 2 if heavy else n - 3


def _lax(vowels: list[_Vowel], k: int, secondary: bool) -> bool:
    # A stress three or more syllables from the end shortens its vowel (Seneca, Socrates),
    # but only an i before an i or e that opens a syllable of its own (Helvidius, and not
    # Aurelius or Demetrius). A secondary stress is short too (Heraclitus).
    if secondary:
        return True
    if k <= len(vowels) - 3:
        following = vowels[k + 1]
        return vowels[k].letters in "iy" or bool(following.after) or following.letters not in ("i", "e", "y")
    return False


def _stressed(vowels: list[_Vowel], k: int, secondary: bool, magic: bool) -> str:
    vowel = vowels[k]
    letter, after = vowel.letters, vowel.after
    last = k == len(vowels) - 1
    if after and after[0].letters == "r" and (last or len(after) > 1):
        return _BEFORE_R[letter]
    if not after and last:
        return "ɑ" if letter == "a" else _LONG[letter]
    hiatus = not after
    # Only an i keeps short before a sh sound: Domitia, but Horatius.
    short_before_sh = letter in "iy" and after and after[0].sound == "ʃ"
    closed = _closed(vowel, last)
    long = (magic and last) or hiatus or (not closed and not short_before_sh and (letter == "u" or not _lax(vowels, k, secondary)))
    if len(after) == 1 and after[0].letters == "r" and not last:
        if letter in "aou":
            return {"a": "ɛ", "o": "ɔ", "u": "ʊ"}[letter]
        if letter == "e":
            return "ɪ" if long else "ɛ"
    return _LONG[letter] if long else _SHORT[letter]


def _unstressed(vowels: list[_Vowel], k: int, magic: bool) -> str:
    vowel = vowels[k]
    letter, after = vowel.letters, vowel.after
    last = k == len(vowels) - 1
    if last and not after:
        return _FINAL[letter]
    if not after:
        if letter in "iy":
            return "I" if k == 0 else "i"
        return {"a": "ə", "e": "i", "o": "O", "u": "u"}[letter]
    if last and magic:
        return _LONG[letter]
    if after[0].letters == "r" and (last or len(after) > 1):
        return "ə" if last else _BEFORE_R[letter]
    if last:
        tail = after[0].letters
        if letter == "o" and tail == "n":
            # -ion is reduced (Dion, Phocion), and any other -on is not (Xenophon).
            before = vowels[k - 1].after if k else []
            return "ə" if k and (not before or before[-1].sound == "ʃ") else "ɑ"
        if letter == "o" and tail == "s":
            return "ɑ"
        if tail == "x":
            return _SHORT[letter]
    if k == 0 and _closed(vowel, last):
        return _SHORT[letter]
    return _REDUCED[letter]


def _team_sound(vowel: _Vowel, stressed: bool, last: bool) -> str:
    if vowel.letters in ("ae", "oe") and not last:
        if _closed(vowel, False):
            return "ɛ"
        return "i" if stressed else "ɪ"
    return vowel.sound


def _sound_of(vowels: list[_Vowel], k: int, at: int, second: int | None, magic: bool, before: str) -> str:
    """One vowel's sound with its stress mark, by where it stands. How a Latin name's vowels
    fall follows the gold dictionary: Titus tˈIɾəs, Seneca sˈɛnəkə, Julius ʤˈuliəs,
    Heraclitus hˌɛɹəklˈIɾəs, Xenophon zˈɛnəfˌɑn."""
    vowel = vowels[k]
    stressed = k in (at, second)
    last = k == len(vowels) - 1
    if len(vowel.letters) > 1:
        sound = _team_sound(vowel, stressed, last)
    elif stressed:
        sound = _stressed(vowels, k, k == second and not last, magic)
        if sound == "u" and (before in _U_GLIDES or not before):
            sound = "ju"
    else:
        sound = _unstressed(vowels, k, magic)
        if sound == "ə" and vowel.letters == "u" and not last and before in _U_GLIDES and not _closed(vowel, False):
            sound = "jə"
    mark = PRIMARY if k == at else SECONDARY if k == second else ""
    # The dictionaries put the mark right before the vowel, after a y sound: Europe is jˈʊɹəp.
    return "j" + mark + sound[1:] if sound[0] == "j" else mark + sound


def _s_sound(vowels: list[_Vowel], k: int, j: int, at: int) -> str:
    # An s between two vowels sounds as z before an unstressed one (Orosius, but Chrysippus),
    # and a final s after a voiced consonant does too (Jenkins).
    after = vowels[k].after
    if k < len(vowels) - 1:
        return "z" if len(after) == 1 and k + 1 != at else "s"
    if j == len(after) - 1 and j > 0 and after[j - 1].sound[-1:] in _VOICED:
        return "z"
    return "s"


def sound_out(word: str) -> str:
    """A word no dictionary knows, read from its spelling in the dictionaries' notation,
    with one primary stress."""
    low = _latin(word) or ""
    if not low:
        return ""
    capital = word[:1].isupper()
    has_vowel = bool(re.search(r"[aeiouy]", low[:-2]))
    if not capital and len(low) > 4 and has_vowel and re.search(r"[^aeiouy]e[ds]$", low):
        # An unknown verb's or noun's ending, read as on a known stem. A stem ending in one
        # vowel and one consonant takes back its silent e (blaked from blake).
        stem = low[:-2] + ("e" if re.search(r"[aeiouy][^aeiouyw]$", low[:-2]) else "")
        return (_ed if low.endswith("d") else _s)(sound_out(stem)) or ""
    tail = ""
    body = low
    if re.search(r"[aeiouy].*[^aeiouy]le$", low):
        body, tail = low[:-2], "ᵊl"
    elif re.search(r"[aeiouy].*[^aeiouyr]re$", low):
        body, tail = low[:-2], "əɹ"
    classical = (capital and bool(_CLASSICAL_END.search(low))) or low.endswith(("us", "um"))
    onset, vowels = _parse(body, classical)
    if not vowels:
        return spell(word) or ""
    magic = False
    if len(vowels) > 1 and not tail and vowels[-1].letters == "e" and not vowels[-1].after:
        # A final e is silent, and after one consonant it lengthens the vowel before it.
        vowels.pop()
        magic = len(vowels[-1].after) == 1 and not vowels[-1].after[0].double
    # A name's -es is a syllable with a long e: Socrates, Diogenes.
    name_es = capital and len(vowels) > 1 and low.endswith("es") and vowels[-1].letters == "e"
    at = _stress_at(vowels, low)
    second = at - 2 if at >= 2 else None
    if second is None and at <= len(vowels) - 3 and low.endswith("on") and vowels[-2].after and vowels[-2].after[-1].sound != "ʃ":
        second = len(vowels) - 1
    out = "".join(u.sound for u in onset)
    before = onset[-1].sound[-1:] if onset else ""
    for k, vowel in enumerate(vowels):
        last = k == len(vowels) - 1
        if last and name_es:
            out += "iz"
            break
        out += _sound_of(vowels, k, at, second, magic, before)
        for j, unit in enumerate(vowel.after):
            out += _s_sound(vowels, k, j, at) if unit.letters == "s" else unit.sound
        before = vowel.after[-1].sound[-1:] if vowel.after else ""
    # The dictionaries flap a t between a vowel and an unstressed one: Titus is tˈIɾəs.
    return re.sub(r"(?<=[AIOWYiuæɑəɛɪɹʊʌ])t(?=[AIOWYiuæɑəɛɪʊʌᵻ])", "ɾ", out + tail)


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
