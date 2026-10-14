"""The one piece of code that knows what an epub is (Decision 1). At import it
produces this app's own format — a strict XHTML-subset fragment per chapter, a table
of contents as JSON, and images as files — and never opens the epub again. The output
is deliberately small and safe: the book's own CSS and scripts are dropped, so a
chapter renders in the app's type and tokens (Decision 3), and only a whitelist of
elements and attributes survives (step 4 below). Stdlib only (Decision 8): zipfile
for the container, ElementTree for the container/OPF/NCX XML, and html.parser for the
XHTML bodies, which tolerates the entities and minor malformations real books carry.
A served chapter is a piece of the book's reading order, cut where its contents begin
a chapter inside it (step 6b), because one file may hold the whole book.
"""

import posixpath
import re
import shutil
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET

# Step 4: what survives a chapter. Kept as elements; children recursed into.
_WHITELIST = {
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre",
    "code", "em", "strong", "i", "b", "a", "img", "figure", "figcaption", "table",
    "thead", "tbody", "tfoot", "tr", "th", "td", "br", "hr", "sup", "sub",
}
# The top-level blocks: the position anchor (Decision 4) is an index into these.
_BLOCK = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "dl", "blockquote", "pre", "figure", "table", "hr"}
_HEADING = {"h1", "h2", "h3", "h4", "h5", "h6"}
# Removed with their content (scripts, styles, embedded media); everything else not in
# the whitelist (div, section, span, …) is unwrapped: its children are kept, its tag dropped.
_REMOVE = {"script", "style", "svg", "math", "video", "audio", "iframe", "object", "head", "title"}
# SVG shapes that carry their own art: an SVG holding any of these is genuine vector
# drawing we cannot render, so it is dropped whole. An SVG whose only content is
# <image> (the common cover shape) is unwrapped into <img> instead (_svg_images).
_SVG_DRAW = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "use"}
# Serialised as HTML5: no self-closing slash, no end tag.
_VOID = {"br", "hr", "img"}
# The only attributes kept, per tag (step 4); links gain data-chapter/data-block on resolution.
_ATTRS = {"img": {"src", "alt"}, "a": {"href"}, "th": {"colspan", "rowspan"}, "td": {"colspan", "rowspan"}}

_IMAGE_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/svg+xml": ".svg", "image/webp": ".webp"}
_XHTML = {"application/xhtml+xml", "text/html"}


def _local(tag: str) -> str:
    """The local name of a possibly-namespaced ElementTree tag."""
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else tag


# --- A tiny DOM from html.parser -------------------------------------------------


class _El:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag, attrs=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []  # each is _El or str


class _TreeBuilder(HTMLParser):
    """Builds an _El tree, resolving entities to text (convert_charrefs). Void tags
    never open a scope, so an unclosed <img> or <br> cannot swallow the rest."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _El("#root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        el = _El(tag.lower(), dict(attrs))
        self.stack[-1].children.append(el)
        if tag.lower() not in _VOID:
            self.stack.append(el)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(_El(tag.lower(), dict(attrs)))

    def handle_endtag(self, tag):
        t = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == t:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def _parse_html(text: str) -> _El:
    builder = _TreeBuilder()
    builder.feed(text)
    return builder.root


def _find(el: _El, tag: str):
    if isinstance(el, _El):
        if el.tag == tag:
            return el
        for child in el.children:
            found = _find(child, tag)
            if found is not None:
                return found
    return None


# --- Chapter conversion (step 4, 5) ----------------------------------------------


def _text_of(node) -> str:
    if isinstance(node, str):
        return node
    return "".join(_text_of(c) for c in node.get("children", []))


def _ids_of(nodes) -> set:
    out = set()
    for node in nodes:
        if isinstance(node, dict):
            out |= node.get("ids", set())
    return out


def _has_content(nodes) -> bool:
    return any(isinstance(n, dict) or (isinstance(n, str) and n.strip()) for n in nodes)


def _convert(el, links: list, heads: dict | None = None):
    """Return a list of output nodes for one input element, applying the whitelist.
    A removed element yields nothing; an unwrapped one yields its children, carrying
    its id onto the first so a fragment anchor is not lost."""
    if isinstance(el, str):
        return [el]
    tag = el.tag
    if tag == "p" and heads:
        tag = _styled_heading(el, heads) or tag
    if tag == "svg":
        return _svg_images(el)
    if tag in _REMOVE:
        return []
    child_nodes = _flow(el, links, heads)
    eid = el.attrs.get("id")
    if tag in _WHITELIST:
        kept = {k: v for k, v in el.attrs.items() if k in _ATTRS.get(tag, set())}
        extra_ids = set()
        if tag in _HEADING:
            anchor = _sole_anchor(child_nodes)
            if anchor is not None:
                links[:] = [entry for entry in links if entry[0] is not anchor]
                extra_ids = anchor["ids"]  # a fragment target on the dropped anchor is kept
                child_nodes = anchor["children"]
        ids = _ids_of(child_nodes) | extra_ids
        if eid:
            ids.add(eid)
        node = {"tag": tag, "attrs": kept, "children": child_nodes, "ids": ids}
        if tag == "a":
            links.append((node, el.attrs.get("href")))
        return [node]
    # Unwrapped: keep the children, drop the tag; preserve its id on the first child.
    if eid:
        for node in child_nodes:
            if isinstance(node, dict):
                node.setdefault("ids", set()).add(eid)
                break
    return child_nodes


def _flow(el, links, heads: dict | None = None) -> list:
    nodes = []
    for child in el.children:
        nodes.extend(_convert(child, links, heads))
    return nodes


# A publisher often sets a heading as <p class="ah"> and makes it big in its own CSS,
# which the import drops; reading that CSS keeps the heading a heading.
_RULE = re.compile(r"([^{}]+)\{([^{}]*)\}")
_CLASS_SELECTOR = re.compile(r"^(?:p)?\.([A-Za-z0-9_-]+)$")
_HEADING_TEXT_MAX = 200


def _font_scale(value: str) -> float | None:
    m = re.fullmatch(r"([\d.]+)(rem|em|%)", value.strip())
    if not m:
        return None
    number = float(m.group(1))
    return number / 100 if m.group(2) == "%" else number


def _heading_levels(css_texts) -> dict:
    """Paragraph class -> heading level 1-3, from the stylesheets: 2x body or larger is
    h1, 1.5x h2, 1.2x and bold h3. Later declarations of a class override earlier ones."""
    declared = {}
    for css in css_texts:
        css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        for selectors, body in _RULE.findall(css):
            props = {}
            for part in body.split(";"):
                name, _, value = part.partition(":")
                props[name.strip().lower()] = value.strip().lower()
            for selector in selectors.split(","):
                m = _CLASS_SELECTOR.match(selector.strip())
                if m:
                    declared.setdefault(m.group(1), {}).update(props)
    levels = {}
    for name, props in declared.items():
        scale = _font_scale(props.get("font-size", ""))
        bold = props.get("font-weight", "") in ("bold", "600", "700", "800", "900")
        if scale is None:
            continue
        if scale >= 2:
            levels[name] = 1
        elif scale >= 1.5:
            levels[name] = 2
        elif scale >= 1.2 and bold:
            levels[name] = 3
    return levels


def _el_text(el) -> str:
    return el if isinstance(el, str) else "".join(_el_text(c) for c in el.children)


def _styled_heading(el, heads: dict) -> str | None:
    """"h<level>" when a short paragraph carries a class the stylesheet makes a heading."""
    for name in el.attrs.get("class", "").split():
        if name in heads and len(_el_text(el)) <= _HEADING_TEXT_MAX:
            return f"h{heads[name]}"
    return None


def _sole_anchor(children):
    """The single <a> that is a heading's whole content (whitespace aside), else None.
    A publisher often wraps a chapter title in a link back to the contents; that title
    is a heading, not a navigation signifier, so it is unwrapped to plain text (a link
    within running text — a footnote, a cross-reference — is left alone)."""
    anchor = None
    for node in children:
        if isinstance(node, str):
            if node.strip():
                return None
        elif isinstance(node, dict) and node["tag"] == "a":
            if anchor is not None:
                return None
            anchor = node
        else:
            return None
    return anchor


def _only_image(children):
    """The single <img> a paragraph holds with nothing else but whitespace, else None.
    A paragraph that is just a picture — a cover, a full-page plate — is a figure, not a
    line of running text: the reader sizes an image in running text to a glyph's height
    (a book's inline emoji), so a lone image left in a <p> would show as a speck."""
    image = None
    for node in children:
        if isinstance(node, str):
            if node.strip():
                return None
        elif isinstance(node, dict) and node["tag"] == "img":
            if image is not None:
                return None
            image = node
        else:
            return None
    return image


def _blocks_of(body, links, heads: dict | None = None):
    """The body's top-level blocks (step 4): consecutive inline nodes are wrapped in a
    <p>, empty paragraphs dropped, a paragraph that is only an image made a <figure>.
    Returns (blocks, idmap) where idmap maps every fragment id to the index of the block
    it ends up in (step 5)."""
    raw = _flow(body, links, heads)
    blocks = []
    buf = []

    def flush():
        if _has_content(buf):
            image = _only_image(buf)
            if image is not None:
                blocks.append({"tag": "figure", "attrs": {}, "children": [image], "ids": _ids_of(buf)})
            else:
                blocks.append({"tag": "p", "attrs": {}, "children": buf[:], "ids": _ids_of(buf)})
        buf.clear()

    for node in raw:
        if isinstance(node, dict) and node["tag"] in _BLOCK:
            flush()
            if node["tag"] == "p" and not _has_content(node["children"]):
                continue
            if node["tag"] == "p" and _only_image(node["children"]) is not None:
                node = {"tag": "figure", "attrs": node["attrs"], "children": [_only_image(node["children"])], "ids": node.get("ids", set())}
            blocks.append(node)
        else:
            buf.append(node)
    flush()

    idmap = {}
    for index, block in enumerate(blocks):
        for anchor in block.get("ids", ()):  # first wins, so a chapter start beats a later use
            idmap.setdefault(anchor, index)
    return blocks, idmap


def _escape_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_attr(value: str) -> str:
    return _escape_text(value).replace('"', "&quot;")


def _serialize(nodes) -> str:
    out = []
    for node in nodes:
        if isinstance(node, str):
            out.append(_escape_text(node))
            continue
        attrs = "".join(f' {k}="{_escape_attr(str(v))}"' for k, v in node["attrs"].items())
        tag = node["tag"]
        if tag in _VOID:
            out.append(f"<{tag}{attrs}>")
        else:
            out.append(f"<{tag}{attrs}>{_serialize(node['children'])}</{tag}>")
    return "".join(out)


# --- The importer ----------------------------------------------------------------


def _is_external(href: str) -> bool:
    return "://" in href or href.startswith(("mailto:", "tel:", "//"))


def _svg_images(el) -> list:
    """An <svg> that only wraps <image> elements (Calibre's cover shape, and full-page
    illustrations) becomes one <img> per image, so a picture a book draws through SVG
    still renders under Decision 3 (HTML only). An SVG with any real vector art is
    dropped whole, as before, because we cannot render it."""
    images = []
    for node in _iter_el(el):
        if node is el:
            continue
        if node.tag == "image":
            images.append(node)
        elif node.tag in _SVG_DRAW:
            return []
    out = []
    for node in images:
        href = node.attrs.get("xlink:href") or node.attrs.get("href")
        if href:
            out.append({"tag": "img", "attrs": {"src": href, "alt": ""}, "children": [], "ids": set()})
    return out


def _first_heading(blocks) -> str:
    for block in blocks:
        if block["tag"] in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            text = _text_of(block).strip()
            if text:
                return text
    return ""


_GENERIC_SECTION = {"frontmatter", "bodymatter", "backmatter", "cover", "titlepage", "chapter"}


def _section_title(body) -> str:
    """A book often names a piece with no heading of its own on its wrapping element:
    <section title="4. A Character"> around a full-page illustration. The first such
    title is a truer name than an invented one (step 7). A structural bucket
    ("Frontmatter") is not a name, though, so it is skipped for the piece's own text."""
    for el in _iter_el(body):
        title = el.attrs.get("title", "").strip() if isinstance(el, _El) else ""
        if title and title.lower() not in _GENERIC_SECTION:
            return title
    return ""


def _lead_line(blocks) -> str:
    """The first block's text, when it is a short paragraph and not the whole piece:
    a front-matter page ("Ebook Instructions", "This book is dedicated to:") names
    itself in its opening line (step 7)."""
    if len(blocks) < 2 or blocks[0]["tag"] != "p":
        return ""
    text = _text_of(blocks[0]).strip()
    return text if 0 < len(text) <= 80 else ""


def import_book(source_path: Path, book_dir: Path, book_id: str, content_version: int = 1) -> dict:
    """Import the epub at source_path into book_dir (chapters/ and images/), and
    return the row fields that ride the bus (Decision 2): title, author, cover URL,
    chapter titles and the table of contents. Raises on anything that is not a
    readable epub; the router turns that into a 422 (unreadable)."""
    image_prefix = f"/api/books/{book_id}/{content_version}/images/"
    chapters_dir = book_dir / "chapters"
    images_dir = book_dir / "images"
    for directory in (chapters_dir, images_dir):
        directory.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(source_path) as zf:
        names = set(zf.namelist())
        if "META-INF/container.xml" not in names:
            raise ValueError("no META-INF/container.xml")
        container = ET.fromstring(zf.read("META-INF/container.xml"))
        rootfile = next(el for el in container.iter() if _local(el.tag) == "rootfile")
        opf_path = rootfile.attrib["full-path"]
        opf_dir = posixpath.dirname(opf_path)
        opf = ET.fromstring(zf.read(opf_path))

        def resolve(base_dir: str, href: str) -> str:
            return posixpath.normpath(posixpath.join(base_dir, href))

        # Metadata (step 1).
        title, author, meta_cover = Path(source_path).stem, "", None
        authors = []
        for el in opf.iter():
            name = _local(el.tag)
            if name == "title" and el.text and not authors and title == Path(source_path).stem:
                title = el.text.strip() or title
            elif name == "creator" and el.text:
                authors.append(el.text.strip())
            elif name == "meta" and el.attrib.get("name") == "cover":
                meta_cover = el.attrib.get("content")
        if authors:
            author = ", ".join(a for a in authors if a)

        # Manifest (step 1): id -> (href, media-type, properties).
        manifest = {}
        for el in opf.iter():
            if _local(el.tag) == "item":
                manifest[el.attrib["id"]] = (
                    el.attrib["href"],
                    el.attrib.get("media-type", ""),
                    el.attrib.get("properties", ""),
                )

        # Images (step 3): copy every image item, keeping a zip-path -> new-name map.
        img_map = {}
        counter = 0
        for href, media, _props in manifest.values():
            if media.startswith("image/"):
                zippath = resolve(opf_dir, href)
                if zippath not in names:
                    continue
                ext = _IMAGE_EXT.get(media) or posixpath.splitext(href)[1] or ".img"
                name = f"{counter}{ext}"
                counter += 1
                (images_dir / name).write_bytes(zf.read(zippath))
                img_map[zippath] = name

        # Cover (step 2): the meta cover id, else a manifest item marked cover-image.
        cover_url = None
        cover_id = meta_cover
        if cover_id is None:
            for item_id, (_href, _media, props) in manifest.items():
                if "cover-image" in props.split():
                    cover_id = item_id
                    break
        if cover_id and cover_id in manifest:
            zippath = resolve(opf_dir, manifest[cover_id][0])
            if zippath in img_map:
                cover_url = image_prefix + img_map[zippath]

        # Spine (step 1): every XHTML item, in order.
        spine = []
        for el in opf.iter():
            if _local(el.tag) == "itemref":
                idref = el.attrib.get("idref")
                if idref in manifest and manifest[idref][1] in _XHTML:
                    spine.append(idref)
        if not spine:
            raise ValueError("empty spine")

        chapter_paths = [resolve(opf_dir, manifest[idref][0]) for idref in spine]

        heads = _heading_levels(
            zf.read(resolve(opf_dir, href)).decode("utf-8", "replace")
            for href, media, _props in manifest.values()
            if media == "text/css" and resolve(opf_dir, href) in names
        )

        # Convert each chapter (step 4, 5), deferring link resolution until every
        # chapter's idmap exists (a link may point forward into a later chapter). The
        # source's own name for a piece (a <section title=…>) is kept for step 7.
        raw_blocks = []
        chapter_links = []  # per source piece: (base_dir, list of (node, href))
        raw_idmaps = []
        section_titles = []
        for path in chapter_paths:
            root = _parse_html(zf.read(path).decode("utf-8", "replace"))
            body = _find(root, "body") or root
            links = []
            blocks, idmap = _blocks_of(body, links, heads)
            base_dir = posixpath.dirname(path)
            _rewrite_images(blocks, base_dir, resolve, img_map, image_prefix)
            raw_blocks.append(blocks)
            chapter_links.append((base_dir, links))
            raw_idmaps.append(idmap)
            section_titles.append(_section_title(body))

        # Drop a piece that holds nothing after conversion — a spacer, or a picture that
        # did not resolve — because a blank page is not one to turn through (5, C). Every
        # source piece still maps to a served chapter: a surviving one to its own new
        # index, a dropped one to the next survivor (the previous, if it was last), so a
        # link or TOC entry aimed at a dropped piece follows it to a real page.
        kept = [n for n in range(len(spine)) if raw_blocks[n]]
        if not kept:
            raise ValueError("empty spine")
        pos = {old: i for i, old in enumerate(kept)}
        served_of = {}
        nxt = None
        for old in reversed(range(len(spine))):
            if old in pos:
                nxt = pos[old]
            served_of[old] = nxt if nxt is not None else len(kept) - 1

        chapter_blocks = [raw_blocks[old] for old in kept]
        idmaps = [raw_idmaps[old] for old in kept]
        spine_index = {chapter_paths[old]: served_of[old] for old in range(len(spine))}

        # Table of contents (step 6): the nav document, else toc.ncx, else one entry per
        # chapter. Read before the cut (step 6b), in the coordinates of the pieces.
        toc = _read_nav(zf, manifest, opf_dir, resolve, spine_index, idmaps, names)
        if toc is None:
            toc = _read_ncx(zf, opf, manifest, opf_dir, resolve, spine_index, idmaps, names)
        toc = toc or []

        # Step 6b: a publisher may put several chapters, or the whole book, in one file.
        # A piece is cut where its contents' shallowest entries begin, so each chapter
        # the contents name is a chapter to open and turn through; deeper entries stay
        # sections inside it. Every place found so far is mapped through `where`.
        chapter_blocks, origin, where = _split(chapter_blocks, _cuts(toc, len(chapter_blocks)))

        # Resolve internal links to data-chapter/data-block (step 4); external links keep
        # their URL; unresolved internal links become inert (#). Targets are served
        # indices, so a link into a dropped piece lands on the piece that replaced it.
        for old, (base_dir, links) in enumerate(chapter_links):
            for node, href in links:
                if not href:
                    node["attrs"].pop("href", None)
                    continue
                if _is_external(href):
                    continue
                path, _, frag = href.partition("#")
                target = served_of[old] if path == "" else spine_index.get(resolve(base_dir, path))
                node["attrs"]["href"] = "#"
                if target is None:
                    continue
                chapter, block = where(target, idmaps[target].get(frag, 0) if frag else 0)
                node["attrs"]["data-chapter"] = str(chapter)
                if frag:
                    node["attrs"]["data-block"] = str(block)

        # Entries collapsing onto one served (chapter, block) after the drop are
        # deduplicated, first kept, so the outline does not gain twin rows.
        _relocate(toc, where)
        toc = _dedupe(toc, set())

        # Chapter titles (step 7): the first that truly names the piece — a TOC entry at
        # its start, its own first heading, the title on its wrapping <section>, its
        # short opening line, else the entry it sits under (the rule the contents marks
        # by, 4.3) — never an invented "Chapter N".
        toc_titles = {}
        for entry in _flatten(toc):
            if entry["block"] == 0:
                toc_titles.setdefault(entry["chapter"], entry["title"])
        titles = []
        inherited = ""
        for n in range(len(chapter_blocks)):
            if n in toc_titles:
                inherited = toc_titles[n]
            piece, first = origin[n]
            titles.append(
                toc_titles.get(n)
                or _first_heading(chapter_blocks[n])
                or (section_titles[kept[piece]] if first else "")
                or _lead_line(chapter_blocks[n])
                or inherited
            )

        if not toc:
            toc = [{"title": titles[n], "chapter": n, "block": 0, "children": []} for n in range(len(chapter_blocks))]

        # Write the fragments (step 8): the fragment only, no html/body wrapper.
        for n, blocks in enumerate(chapter_blocks):
            (chapters_dir / f"{n}.html").write_text(_serialize(blocks), encoding="utf-8")

    return {
        "title": title,
        "author": author,
        "cover": cover_url,
        "chapters": [{"title": t} for t in titles],
        "toc": toc,
    }


def _rewrite_images(nodes, base_dir, resolve, img_map, image_prefix):
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if node["tag"] == "img" and node["attrs"].get("src"):
            zippath = resolve(base_dir, node["attrs"]["src"])
            if zippath in img_map:
                node["attrs"]["src"] = image_prefix + img_map[zippath]
            else:
                node["attrs"].pop("src", None)
        _rewrite_images(node["children"], base_dir, resolve, img_map, image_prefix)


def _cuts(toc, count):
    """Per piece, the blocks it is cut at (step 6b): the blocks past 0 of the
    shallowest contents entries pointing into it. A deeper entry is a section of the
    chapter it sits in, not a chapter, so it never cuts."""
    found = {}  # piece -> (depth, set of blocks)

    def walk(entries, depth):
        for entry in entries:
            piece = entry["chapter"]
            have = found.get(piece)
            if have is None or depth < have[0]:
                found[piece] = (depth, {entry["block"]})
            elif depth == have[0]:
                have[1].add(entry["block"])
            walk(entry.get("children", []), depth + 1)

    walk(toc, 0)
    return [sorted(b for b in found.get(n, (0, set()))[1] if b > 0) for n in range(count)]


def _split(pieces, cuts):
    """Cut each piece at its cuts (step 6b). Returns the chapters' blocks, each
    chapter's origin (its piece, and whether it is the piece's first
    slice), and where(piece, block), the (chapter, block) a piece's block lands on."""
    chapters, origin, starts = [], [], []
    for piece, blocks in enumerate(pieces):
        bounds = [0] + cuts[piece] + [len(blocks)]
        starts.append((len(chapters), bounds[:-1]))
        for i in range(len(bounds) - 1):
            lo, hi = bounds[i], bounds[i + 1]
            chapters.append(blocks[lo:hi])
            origin.append((piece, i == 0))

    def where(piece, block):
        first, begins = starts[piece]
        i = max(k for k, lo in enumerate(begins) if lo <= block)
        return first + i, block - begins[i]

    return chapters, origin, where


def _relocate(entries, where):
    for entry in entries:
        entry["chapter"], entry["block"] = where(entry["chapter"], entry["block"])
        _relocate(entry.get("children", []), where)


def _flatten(entries):
    for entry in entries:
        yield entry
        yield from _flatten(entry.get("children", []))


def _dedupe(entries, seen):
    """Drop entries whose served (chapter, block) a preceding entry already claimed —
    a collision the empty-piece drop can create — keeping the first in reading order and
    splicing a dropped entry's unseen children up in its place, as a heading-only branch
    is spliced (see _nav_list)."""
    out = []
    for entry in entries:
        key = (entry["chapter"], entry["block"])
        if key in seen:
            out.extend(_dedupe(entry.get("children", []), seen))
            continue
        seen.add(key)
        entry["children"] = _dedupe(entry.get("children", []), seen)
        out.append(entry)
    return out


def _entry(title, href, base_dir, resolve, spine_index, idmaps):
    """One resolved TOC entry, or None when its href is not a spine chapter."""
    path, _, frag = href.partition("#")
    target = spine_index.get(resolve(base_dir, path))
    if target is None:
        return None
    block = idmaps[target].get(frag, 0) if frag else 0
    return {"title": title.strip(), "chapter": target, "block": block, "children": []}


def _read_nav(zf, manifest, opf_dir, resolve, spine_index, idmaps, names):
    nav_href = next((href for href, _m, props in manifest.values() if "nav" in props.split()), None)
    if nav_href is None:
        return None
    nav_path = resolve(opf_dir, nav_href)
    if nav_path not in names:
        return None
    root = _parse_html(zf.read(nav_path).decode("utf-8", "replace"))
    nav = next((el for el in _iter_el(root) if el.tag == "nav" and el.attrs.get("epub:type") == "toc"), None)
    if nav is None:
        nav = _find(root, "nav")
    if nav is None:
        return None
    ol = _find(nav, "ol")
    base_dir = posixpath.dirname(nav_path)
    entries = _nav_list(ol, base_dir, resolve, spine_index, idmaps) if ol is not None else []
    return entries or None


def _nav_list(ol, base_dir, resolve, spine_index, idmaps):
    entries = []
    for li in ol.children:
        if not isinstance(li, _El) or li.tag != "li":
            continue
        a = _find(li, "a")
        href = a.attrs.get("href") if a is not None else None
        entry = _entry(_text_of_el(a), href, base_dir, resolve, spine_index, idmaps) if href else None
        child_ol = next((c for c in li.children if isinstance(c, _El) and c.tag == "ol"), None)
        children = _nav_list(child_ol, base_dir, resolve, spine_index, idmaps) if child_ol is not None else []
        if entry is not None:
            entry["children"] = children
            entries.append(entry)
        else:
            entries.extend(children)  # a heading-only branch: keep its resolvable children
    return entries


def _read_ncx(zf, opf, manifest, opf_dir, resolve, spine_index, idmaps, names):
    ncx_href = next((href for href, media, _p in manifest.values() if media == "application/x-dtbncx+xml"), None)
    if ncx_href is None:
        return None
    ncx_path = resolve(opf_dir, ncx_href)
    if ncx_path not in names:
        return None
    ncx = ET.fromstring(zf.read(ncx_path))
    nav_map = next((el for el in ncx.iter() if _local(el.tag) == "navMap"), None)
    if nav_map is None:
        return None
    base_dir = posixpath.dirname(ncx_path)
    return _ncx_points(nav_map, base_dir, resolve, spine_index, idmaps) or None


def _ncx_points(parent, base_dir, resolve, spine_index, idmaps):
    entries = []
    for point in parent:
        if _local(point.tag) != "navPoint":
            continue
        label = next((el for el in point.iter() if _local(el.tag) == "text"), None)
        content = next((el for el in point.iter() if _local(el.tag) == "content"), None)
        title = (label.text or "") if label is not None else ""
        href = content.attrib.get("src") if content is not None else None
        entry = _entry(title, href, base_dir, resolve, spine_index, idmaps) if href else None
        children = _ncx_points(point, base_dir, resolve, spine_index, idmaps)
        if entry is not None:
            entry["children"] = children
            entries.append(entry)
        else:
            entries.extend(children)
    return entries


def _iter_el(el):
    if isinstance(el, _El):
        yield el
        for child in el.children:
            yield from _iter_el(child)


def _text_of_el(el) -> str:
    if el is None:
        return ""
    return "".join(c if isinstance(c, str) else _text_of_el(c) for c in el.children)


def purge(book_dir: Path) -> None:
    """Delete a book's directory (Decision 6): one rmtree, images and chapters gone."""
    shutil.rmtree(book_dir, ignore_errors=True)


# Kept importable without side effects; the router owns writing source.epub and the row.
__all__ = ["import_book", "purge"]
