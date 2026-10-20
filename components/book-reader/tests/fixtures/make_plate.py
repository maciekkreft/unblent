"""Build plate.epub, the book the picture viewer's page tests read, run once by hand and
the output committed. Never built at check time, so a test never depends on this
running. Stdlib only.

    python3 components/book-reader/tests/fixtures/make_plate.py

plate.epub is a minimal EPUB 3 with one chapter: two paragraphs, a figure whose
picture is four times wider than it is tall (a page printed sideways, as a book prints a
wide table), and more paragraphs after it. The picture is two colours, left and right,
so a turn shows.
"""

import struct
import zipfile
import zlib
from pathlib import Path

HERE = Path(__file__).parent


def _png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    row = b"\x00" + b"\x20\x40\x80" * (width // 2) + b"\xe0\xc0\x40" * (width - width // 2)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * height))
        + chunk(b"IEND", b"")
    )


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
    <dc:identifier id="bookid">urn:uuid:plate-0001</dc:identifier>
    <dc:title>Plate Book</dc:title>
    <dc:creator>A. Writer</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="plate" href="images/plate.png" media-type="image/png"/>
    <item id="c0" href="ch0.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c0"/>
  </spine>
</package>
"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <ol>
        <li><a href="ch0.xhtml">The Plate</a></li>
      </ol>
    </nav>
  </body>
</html>
"""

_PARAS = lambda start, n: "\n".join(  # noqa: E731
    f"<p>Paragraph number {i} of the plate chapter, around a picture printed on its side.</p>"
    for i in range(start, start + n)
)

CH0 = f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>The Plate</title></head>
  <body>
    <h1>The Plate</h1>
    {_PARAS(0, 2)}
    <figure>
      <img src="images/plate.png" alt="A wide plate"/>
      <figcaption>A wide plate.</figcaption>
    </figure>
    {_PARAS(2, 30)}
  </body>
</html>
"""


def main() -> None:
    with zipfile.ZipFile(HERE / "plate.epub", "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", OPF, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", NAV, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/ch0.xhtml", CH0, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/images/plate.png", _png(1600, 400), compress_type=zipfile.ZIP_DEFLATED)


if __name__ == "__main__":
    main()
