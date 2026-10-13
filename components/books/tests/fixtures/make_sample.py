"""Build the epub fixtures the api and page tests use, run once by hand and the
output (sample.epub, broken.epub, gaps.epub, onepiece.epub) committed. Never built at
check time, so a test never depends on this running. Stdlib only.

    python3 components/books/tests/fixtures/make_sample.py

sample.epub is a minimal EPUB 3 with a nav.xhtml two-level TOC (no toc.ncx), a 1x1
PNG cover and one figure image, and three chapters: one short (with a title-as-link
heading the importer unwraps to plain text), one long with an
<h2 id="mid"> the TOC points at, and one exercising a code listing with an
inline emoji image (the O'Reilly idiom: a 160px PNG in a <pre>), a definition list
whose dd holds an id another chapter links to, a figure, an <h3> section and a second
figure captioned with an <h6> (the O'Reilly idiom again), a table, a nested list, a
<div> to unwrap and a <script> to drop. broken.epub is a zip with no
META-INF/container.xml, so the importer rejects it (422, unreadable).
"""

import base64
import struct
import zipfile
import zlib
from pathlib import Path

HERE = Path(__file__).parent

PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)



def _png(size: int, rgb: bytes) -> bytes:
    """A solid-colour PNG of the given side, stdlib only: the emoji, big enough that
    a reader showing it at its file's size is caught."""
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    raw = b"".join(b"\x00" + rgb * size for _ in range(size))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


PNG_EMOJI = _png(160, b"\xff\xcc\x00")

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:sample-0001</dc:identifier>
    <dc:title>Sample Book</dc:title>
    <dc:creator>A. Writer</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="fig" href="images/fig.png" media-type="image/png"/>
    <item id="emoji" href="images/emoji.png" media-type="image/png"/>
    <item id="c0" href="ch0.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c0"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>
"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <ol>
        <li><a href="ch0.xhtml">Chapter One</a></li>
        <li><a href="ch1.xhtml">Chapter Two</a>
          <ol>
            <li><a href="ch1.xhtml#mid">The Middle</a></li>
          </ol>
        </li>
        <li><a href="ch2.xhtml">Chapter Three</a></li>
      </ol>
    </nav>
  </body>
</html>
"""

CH0 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>One</title></head>
  <body>
    <h1>Chapter One</h1>
    <h2><a href="ch2.xhtml">A LINKED HEADING</a></h2>
    <p>A short opening chapter, one page long. It links to
      <a href="ch2.xhtml">the third chapter</a>, to
      <a href="ch1.xhtml#mid">the middle</a>, and to
      <a href="ch2.xhtml#defterm">a definition</a>.</p>
  </body>
</html>
"""

# One paragraph, near the chapter's start, runs past a whole page, so a reader page
# can sit inside it with no block of its own beginning there. That is the case a
# block-only place cannot keep across a re-layout; it exercises the character offset.
_OUTRUNS = (
    '<p>A paragraph that outruns a page. '
    + " ".join(
        f"Sentence number {i} runs on so this single paragraph spills across more than "
        "one column of the reader, leaving a page with no block of its own to anchor."
        for i in range(40)
    )
    + "</p>"
)

_LONG = "\n".join(
    (f'<h2 id="mid">The Middle</h2>' if i == 30 else "")
    + f"<p>Paragraph number {i} of a long second chapter, repeated so the reader "
    "paginates it into several pages of columns for the tests to turn.</p>"
    for i in range(60)
)
CH1 = f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Two</title></head>
  <body>
    <h1>Chapter Two</h1>
    {_OUTRUNS}
    {_LONG}
  </body>
</html>
"""

CH2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Three</title></head>
  <body>
    <h1>Chapter Three</h1>
    <pre>'content': "I'm doing really well, thank you for asking! """ + "x" * 120 + """ <img class="emoji" width="160" height="160" src="images/emoji.png" alt="Smiling face emoji"/>
'finish_reason': 'stop'</pre>
    <dl>
      <dt>Alpha</dt>
      <dd><p>The <a id="defterm">first</a> letter, its id living deep inside a dd.</p></dd>
      <dt>Beta</dt>
      <dd><p>The second letter.</p></dd>
    </dl>
    <div class="wrapper">
      <p>A paragraph inside a div that the importer unwraps.</p>
      <figure>
        <img src="images/fig.png" alt="A small figure"/>
        <figcaption>A small figure.</figcaption>
      </figure>
      <table>
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody><tr><td>One</td><td>1</td></tr><tr><td>Two</td><td>2</td></tr></tbody>
      </table>
      <ul>
        <li>First
          <ul><li>Nested item</li></ul>
        </li>
        <li>Second</li>
      </ul>
    </div>
    <h3>A Section</h3>
    <figure>
      <img src="images/fig.png" alt="A heading-captioned figure"/>
      <h6>Figure 3-1. A heading caption (the O'Reilly idiom).</h6>
    </figure>
    <script>window.dropped = true;</script>
  </body>
</html>
"""


def build_sample(path: Path) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        # The mimetype entry is first and stored, per the EPUB OCF rule.
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", OPF)
        zf.writestr("OEBPS/nav.xhtml", NAV)
        zf.writestr("OEBPS/ch0.xhtml", CH0)
        zf.writestr("OEBPS/ch1.xhtml", CH1)
        zf.writestr("OEBPS/ch2.xhtml", CH2)
        zf.writestr("OEBPS/images/cover.png", PNG_1x1)
        zf.writestr("OEBPS/images/fig.png", PNG_1x1)
        zf.writestr("OEBPS/images/emoji.png", PNG_EMOJI)


def build_broken(path: Path) -> None:
    # A zip with no META-INF/container.xml: a valid archive, not a valid epub.
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("hello.txt", "not an epub")


# gaps.epub exercises the gap-tolerant import (A, B, C): a cover and an illustration
# drawn as an <svg><image> (rendered as <img>, C), front-matter and illustration pieces
# the nav does not list (named without inventing "Chapter N", B), and an empty spacer
# a link points at (dropped from the reading order, the link following to the next
# piece, C). Seven spine pieces, six survive.
GAPS_OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:gaps-0001</dc:identifier>
    <dc:title>Gappy Book</dc:title>
    <dc:creator>A. Writer</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="fig" href="images/fig.png" media-type="image/png"/>
    <item id="g0" href="ch0.xhtml" media-type="application/xhtml+xml"/>
    <item id="g1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="g2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="g3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="g4" href="ch4.xhtml" media-type="application/xhtml+xml"/>
    <item id="g5" href="ch5.xhtml" media-type="application/xhtml+xml"/>
    <item id="g6" href="ch6.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="g0"/>
    <itemref idref="g1"/>
    <itemref idref="g2"/>
    <itemref idref="g3"/>
    <itemref idref="g4"/>
    <itemref idref="g5"/>
    <itemref idref="g6"/>
  </spine>
</package>
"""

# The nav lists only the cover and the two real chapters; the illustration, the
# front-matter, the spacer and the trailing piece are all unlisted.
GAPS_NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <ol>
        <li><a href="ch0.xhtml">Cover</a></li>
        <li><a href="ch1.xhtml">Chapter A</a></li>
        <li><a href="ch5.xhtml">Chapter B</a></li>
      </ol>
    </nav>
  </body>
</html>
"""

# A cover drawn as an SVG wrapping one <image> (the Calibre shape): the importer must
# turn it into an <img>, or the first page is blank (C).
GAPS_CH0 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Cover</title></head>
  <body>
    <div>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 150">
        <image width="100" height="150" xlink:href="images/cover.png"/>
      </svg>
    </div>
  </body>
</html>
"""

# A real chapter, listed, that links to the spacer piece (ch3, dropped) and to a
# fragment of its own; the spacer link must follow to the piece that replaces it (C).
GAPS_CH1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>A</title></head>
  <body>
    <h1>Chapter A</h1>
    <p>Opening. It links to <a href="ch3.xhtml">the spacer</a> that carries no content.</p>
    <p id="mid">A later paragraph other pieces point at.</p>
  </body>
</html>
"""

# An unlisted full-page illustration, its only name the title on its <section>, its
# only content an SVG image (C gives it an <img>; B names it from the section).
GAPS_CH2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Plate</title></head>
  <body epub:type="bodymatter">
    <section title="Full-Page Plate">
      <div>
        <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 40">
          <image width="40" height="40" xlink:href="images/fig.png"/>
        </svg>
      </div>
    </section>
  </body>
</html>
"""

# An empty spacer: no content survives conversion, so it leaves the reading order (C).
GAPS_CH3 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Spacer</title></head>
  <body><div><span></span></div></body>
</html>
"""

# Unlisted front-matter named by its short opening line, not a heading (B, step 4).
GAPS_CH4 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Notes</title></head>
  <body>
    <p>Ebook Instructions</p>
    <p>Use your device's note-taking function wherever you see a bracketed prompt.</p>
  </body>
</html>
"""

GAPS_CH5 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>B</title></head>
  <body>
    <h1>Chapter B</h1>
    <p>A second real chapter, listed in the contents.</p>
  </body>
</html>
"""

# Unlisted, with neither a heading, a section title, nor a short opening line: it takes
# the name of the entry it sits under (B, step 5) — here Chapter B.
GAPS_CH6 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Tail</title></head>
  <body>
    <p>A long trailing paragraph with no name of its own, running well past eighty
      characters so it is not mistaken for a title, the kind of afterword a publisher
      leaves out of the table of contents entirely.</p>
  </body>
</html>
"""


def build_gaps(path: Path) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", GAPS_OPF)
        zf.writestr("OEBPS/nav.xhtml", GAPS_NAV)
        for n, body in enumerate((GAPS_CH0, GAPS_CH1, GAPS_CH2, GAPS_CH3, GAPS_CH4, GAPS_CH5, GAPS_CH6)):
            zf.writestr(f"OEBPS/ch{n}.xhtml", body)
        zf.writestr("OEBPS/images/cover.png", PNG_1x1)
        zf.writestr("OEBPS/images/fig.png", PNG_1x1)


# onepiece.epub is a whole book in one file (step 6b), the way some publishers ship it:
# a title page, a part heading and two chapters, and a nav whose top-level entries all
# point inside that one file, with a section nested under the second chapter. The
# importer cuts the file where each top-level entry begins; the section stays inside
# its chapter.
ONEPIECE_OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:onepiece-0001</dc:identifier>
    <dc:title>One Piece Book</dc:title>
    <dc:creator>A. Writer</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="text"/>
  </spine>
</package>
"""

ONEPIECE_NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <ol>
        <li><a href="text.xhtml#p1">Part One</a></li>
        <li><a href="text.xhtml#c1">Chapter One</a></li>
        <li><a href="text.xhtml#c2">Chapter Two</a>
          <ol><li><a href="text.xhtml#s">Section</a></li></ol>
        </li>
      </ol>
    </nav>
  </body>
</html>
"""

ONEPIECE_TEXT = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>One Piece Book</title></head>
  <body>
    <p>One Piece Book</p>
    <p>Copyright and the other small print a title page carries, long enough not to be a name.</p>
    <h1 id="p1">Part One</h1>
    <h2 id="c1">Chapter One</h2>
    <p>The first chapter, which points on to <a href="#c2">the second</a>.</p>
    <h2 id="c2">Chapter Two</h2>
    <p>The second chapter opens.</p>
    <h3 id="s">Section</h3>
    <p>A section inside the second chapter.</p>
  </body>
</html>
"""


def build_onepiece(path: Path) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", ONEPIECE_OPF)
        zf.writestr("OEBPS/nav.xhtml", ONEPIECE_NAV)
        zf.writestr("OEBPS/text.xhtml", ONEPIECE_TEXT)


if __name__ == "__main__":
    build_sample(HERE / "sample.epub")
    build_broken(HERE / "broken.epub")
    build_gaps(HERE / "gaps.epub")
    build_onepiece(HERE / "onepiece.epub")
    print("wrote sample.epub, broken.epub, gaps.epub and onepiece.epub")
