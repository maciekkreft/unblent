import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockTexts } from "../machine.js";

// books: place numbers a chapter's blocks without a browser (blockTexts), and a reading
// place is numbered by the reader, which counts the elements the browser builds from the
// chapter's HTML (book-reader `#blockTexts`). The two must agree, block for block, on a
// real book: the importer splits it on the server (`_blocks_of`) and the browser parses
// what it wrote.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES } = await import(process.env.UNBLENT_KIT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BOOK = join(ROOT, "mac/books/meditations.epub");

// The importer run on the book, its own blocks read as it serialises each chapter: every
// block's text is the text of everything inside it, as the reader joins it.
const SPLIT = `
import json, sys
sys.path.insert(0, sys.argv[3])
import importer
blocks, depth, real = [], [0], importer._serialize
def text(n):
    return n if isinstance(n, str) else "".join(text(c) for c in n.get("children", []))
def spy(nodes):
    if depth[0] == 0:
        blocks.append([text(n) for n in nodes])
    depth[0] += 1
    try:
        return real(nodes)
    finally:
        depth[0] -= 1
importer._serialize = spy
importer.import_book(importer.Path(sys.argv[1]), importer.Path(sys.argv[2]), "01ARZ3NDEKTSV4RRFFQ69G5FAV")
chapters = sorted(importer.Path(sys.argv[2], "chapters").glob("*.html"), key=lambda p: int(p.stem))
print(json.dumps({"blocks": blocks, "html": [p.read_text(encoding="utf-8") for p in chapters]}))
`;

function imported() {
  const dir = mkdtempSync(join(tmpdir(), "books-blocks-"));
  try {
    const out = execFileSync(`${ROOT}.venv/bin/python`, ["-c", SPLIT, BOOK, dir, join(ROOT, "components/books/server")], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const engine of ENGINES) {
  // Browser: rendering and layout — the reader's blocks are the elements the browser builds from a chapter's HTML.
  test(`a real book's blocks are numbered the same by place, the server and the reader in ${engine.name}`, async () => {
    const { blocks, html } = imported();
    assert.ok(html.length > 3, "the book has chapters");
    assert.equal(blocks.length, html.length, "one serialised list of blocks per chapter");
    const browser = await engine.launch();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // The reader's own way (book-reader view.js): a contextual fragment, its element
      // children the blocks, each block's text its text nodes joined.
      const read = await page.evaluate((chapters) =>
        chapters.map((h) => {
          const strip = document.createElement("div");
          strip.append(document.createRange().createContextualFragment(h));
          return [...strip.children].map((el) => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let t = "";
            for (let n = walker.nextNode(); n; n = walker.nextNode()) t += n.data;
            return t;
          });
        }),
      html);
      let total = 0;
      html.forEach((h, n) => {
        const mine = blockTexts(h);
        assert.deepEqual(mine, blocks[n], `chapter ${n}: place and the server split it alike`);
        assert.deepEqual(read[n], mine, `chapter ${n}: place and the reader number it alike`);
        total += mine.length;
      });
      assert.ok(total > 100, `the book has many blocks (${total})`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
