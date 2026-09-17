"""The one piece of code that knows what an epub is (Decision 1). At import it
produces this app's own format — a strict XHTML-subset fragment per chapter, a table
of contents as JSON, and images as files — and never opens the epub again. The output
is deliberately small and safe: the book's own CSS and scripts are dropped, so a
chapter renders in the app's type and tokens (Decision 3), and only a whitelist of
elements and attributes survives (step 4 below). Stdlib only (Decision 8): zipfile
for the container, ElementTree for the container/OPF/NCX XML, and html.parser for the
XHTML bodies, which tolerates the entities and minor malformations real books carry.
"""

import posixpath
import shutil
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET

# Step 4: what survives a chapter. Kept as elements; children recursed into.
_WHITELIST = {
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "pre",
    "code", "em", "strong", "i", "b", "a", "img", "figure", "figcaption", "table",
    "thead", "tbody", "tfoot", "tr", "th", "td", "br", "hr", "sup", "sub",
}
# The top-level blocks: the position anchor (Decision 4) is an index into these.
_BLOCK = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "blockquote", "pre", "figure", "table", "hr"}
# Removed with their content (scripts, styles, embedded media); everything else not in
# the whitelist (div, section, span, …) is unwrapped: its children are kept, its tag dropped.
_REMOVE = {"script", "style", "svg", "math", "video", "audio", "iframe", "object", "head", "title"}
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


def _convert(el, links: list):
    """Return a list of output nodes for one input element, applying the whitelist.
    A removed element yields nothing; an unwrapped one yields its children, carrying
    its id onto the first so a fragment anchor is not lost."""
    if isinstance(el, str):
        return [el]
    tag = el.tag
    if tag in _REMOVE:
        return []
    child_nodes = _flow(el, links)
    eid = el.attrs.get("id")
    if tag in _WHITELIST:
        kept = {k: v for k, v in el.attrs.items() if k in _ATTRS.get(tag, set())}
        ids = _ids_of(child_nodes)
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


def _flow(el, links) -> list:
    nodes = []
    for child in el.children:
        nodes.extend(_convert(child, links))
    return nodes


def _blocks_of(body, links):
    """The body's top-level blocks (step 4): consecutive inline nodes are wrapped in a
    <p>, empty paragraphs dropped. Returns (blocks, idmap) where idmap maps every
    fragment id to the index of the block it ends up in (step 5)."""
    raw = _flow(body, links)
    blocks = []
    buf = []

    def flush():
        if _has_content(buf):
            blocks.append({"tag": "p", "attrs": {}, "children": buf[:], "ids": _ids_of(buf)})
        buf.clear()

    for node in raw:
        if isinstance(node, dict) and node["tag"] in _BLOCK:
            flush()
            if node["tag"] == "p" and not _has_content(node["children"]):
                continue
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


def _first_heading(blocks) -> str:
    for block in blocks:
        if block["tag"] in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            text = _text_of(block).strip()
            if text:
                return text
    return ""


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
        spine_index = {path: n for n, path in enumerate(chapter_paths)}

        # Convert each chapter (step 4, 5), deferring link resolution until every
        # chapter's idmap exists (a link may point forward into a later chapter).
        chapter_blocks = []
        chapter_links = []  # per chapter: list of (node, href)
        idmaps = []
        for path in chapter_paths:
            root = _parse_html(zf.read(path).decode("utf-8", "replace"))
            body = _find(root, "body") or root
            links = []
            blocks, idmap = _blocks_of(body, links)
            chapter_blocks.append(blocks)
            chapter_links.append((posixpath.dirname(path), links))
            idmaps.append(idmap)

        # Resolve internal links to data-chapter/data-block (step 4); external links
        # keep their URL; unresolved internal links become inert (#).
        for n, (base_dir, links) in enumerate(chapter_links):
            for node, href in links:
                if not href:
                    node["attrs"].pop("href", None)
                    continue
                if _is_external(href):
                    continue
                path, _, frag = href.partition("#")
                target = n if path == "" else spine_index.get(resolve(base_dir, path))
                node["attrs"]["href"] = "#"
                if target is None:
                    continue
                node["attrs"]["data-chapter"] = str(target)
                if frag:
                    node["attrs"]["data-block"] = str(idmaps[target].get(frag, 0))

        # Rewrite image sources to the served URL (step 4).
        for n, path in enumerate(chapter_paths):
            base_dir = posixpath.dirname(path)
            _rewrite_images(chapter_blocks[n], base_dir, resolve, img_map, image_prefix)

        # Table of contents (step 6): the nav document, else toc.ncx, else one entry
        # per chapter.
        toc = _read_nav(zf, manifest, opf_dir, resolve, spine_index, idmaps, names)
        if toc is None:
            toc = _read_ncx(zf, opf, manifest, opf_dir, resolve, spine_index, idmaps, names)

        # Chapter titles (step 7): a TOC entry at (n, 0), else the first heading, else
        # a fallback. Compute before falling back to one-entry-per-chapter, so a real
        # TOC names the chapters.
        toc_titles = {}
        for entry in _flatten(toc or []):
            if entry["block"] == 0:
                toc_titles.setdefault(entry["chapter"], entry["title"])
        titles = []
        for n in range(len(spine)):
            titles.append(toc_titles.get(n) or _first_heading(chapter_blocks[n]) or f"Chapter {n + 1}")

        if not toc:
            toc = [{"title": titles[n], "chapter": n, "block": 0, "children": []} for n in range(len(spine))]

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


def _flatten(entries):
    for entry in entries:
        yield entry
        yield from _flatten(entry.get("children", []))


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
