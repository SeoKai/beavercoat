#!/usr/bin/env python3
"""beavercoat: edit HTML prototypes visually without touching the original files.

Usage:
    python3 beavercoat.py [folder] [--page PAGE] [--port PORT] [--no-open]
    python3 beavercoat.py [folder] --export viewer|zip [--page PAGE]
    python3 beavercoat.py [folder] --build

Edits live in <folder>/.design-edits/. Every save regenerates <folder>/결과/
(or 결과-beavercoat/ if the folder already holds a 결과/ of its own).
The server only listens on 127.0.0.1. Python standard library only.
"""
import argparse
import base64
import filecmp
import functools
import hashlib
import html as html_lib
import http.server
import json
import mimetypes
import os
import posixpath
import re
import shutil
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import webbrowser
import xml.etree.ElementTree as ET
import zipfile

APP_DIR = os.path.dirname(os.path.abspath(__file__))
EDITS_DIR = ".design-edits"
RESULT_DIR = "결과"
SHARE_DIR = "공유"
BUNDLED_APP_DIR = ".beavercoat"
OUTPUT_MARKER = ".beavercoat-output"
ALT_OUTPUT_SUFFIX = "-beavercoat"
# Tool folders, skipped anywhere without mention. Generated output folders are only skipped at the top.
TOOL_DIRS = {EDITS_DIR, BUNDLED_APP_DIR, ".git", ".claude", "node_modules", "__pycache__"}
PRIVATE_EXTS = (".pem", ".key", ".p12", ".pfx")
PRIVATE_NAMES = {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"}
SKIP_FILES = {".DS_Store", "Thumbs.db"}
APP_FILES = {"editor.html", "editor.js", "apply.js", "fonts.json"}
FONT_STORE_ENV = "BEAVERCOAT_FONT_DIR"
FONT_FORMATS = {"woff2": "woff2", "woff": "woff", "ttf": "truetype", "otf": "opentype"}
FONT_MAGIC = {b"wOF2": "woff2", b"wOFF": "woff", b"OTTO": "otf", b"\x00\x01\x00\x00": "ttf", b"true": "ttf"}
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif", "avif", "svg"}
MAX_SAVE_BYTES = 20 * 1024 * 1024
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
HTML_EXTS = (".html", ".htm")
EMPTY_EDITS = {
    "version": 2, "targets": {}, "styles": {}, "meta": {}, "text": {}, "images": {},
    "inlineSvg": {}, "fonts": {}, "breakpoints": None,
}


# ---------- paths and storage ----------

def nfc(text):
    return unicodedata.normalize("NFC", text)


def write_atomic(path, data):
    """Write through a temp file so a failed save never corrupts the old file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".bc-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except OSError:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


class Project:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.name = nfc(os.path.basename(self.root.rstrip(os.sep))) or "project"

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def safe_path(self, rel):
        """Resolve a project-relative path, or return None if it escapes the project."""
        rel = posixpath.normpath(str(rel).replace("\\", "/")).lstrip("/")
        if rel.startswith("..") or "\0" in rel:
            return None
        full = os.path.realpath(self.path(*rel.split("/")))
        root = os.path.realpath(self.root)
        return full if full == root or full.startswith(root + os.sep) else None

    # --- generated folders ---
    def _is_marked(self, name):
        return os.path.isfile(self.path(name, OUTPUT_MARKER))

    def output_name(self, name):
        """The folder to generate into. A folder this tool didn't create is the user's and is left alone."""
        alt = name + ALT_OUTPUT_SUFFIX
        if self._is_marked(alt):
            return alt
        if self._is_marked(name):
            return name
        main = self.path(name)
        if os.path.islink(main) or os.path.isfile(main):
            return alt
        if os.path.isdir(main) and any(n not in SKIP_FILES for n in os.listdir(main)):
            return alt
        return name

    def generated_tops(self):
        return {nfc(self.output_name(RESULT_DIR)), nfc(self.output_name(SHARE_DIR))}

    def read_manifest(self, name):
        """Files this tool wrote into a generated folder. The list may come from a received zip, so check it."""
        try:
            with open(self.path(name, OUTPUT_MARKER), encoding="utf-8") as f:
                listed = json.load(f).get("files", [])
        except (OSError, ValueError, AttributeError):
            return []
        safe = []
        for rel in listed if isinstance(listed, list) else []:
            if not isinstance(rel, str) or "\\" in rel or "\0" in rel:
                continue
            norm = posixpath.normpath(rel)
            if norm != rel or rel.startswith(("/", "../")) or rel in (".", "..", OUTPUT_MARKER) or re.match(r"^[A-Za-z]:", rel):
                continue
            safe.append(rel)
        return safe

    def write_manifest(self, name, files):
        data = json.dumps({"files": sorted(files)}, ensure_ascii=False, indent=0).encode("utf-8")
        write_atomic(self.path(name, OUTPUT_MARKER), data)

    def share_dir(self):
        name = self.output_name(SHARE_DIR)
        if not self._is_marked(name):
            self.write_manifest(name, [])
        return self.path(name)

    # --- source files ---
    def scan(self):
        """Return (source files as project-relative POSIX paths, messages about files left out)."""
        files, skipped = [], []
        generated = self.generated_tops()
        root_real = os.path.realpath(self.root)
        for base, dirs, names in os.walk(self.root):
            rel_base = os.path.relpath(base, self.root).replace(os.sep, "/")
            rel_base = "" if rel_base == "." else rel_base + "/"
            kept = []
            for d in sorted(dirs):
                if nfc(d) in TOOL_DIRS or (not rel_base and nfc(d) in generated):
                    continue
                if os.path.islink(os.path.join(base, d)):
                    skipped.append(f"{rel_base}{d}: 폴더 링크라서 포함하지 않았습니다")
                elif d.startswith("."):
                    skipped.append(f"{rel_base}{d}/: 숨김 폴더라서 포함하지 않았습니다")
                else:
                    kept.append(d)
            dirs[:] = kept
            for name in sorted(names):
                if name in SKIP_FILES or name.endswith(".tmp"):
                    continue
                rel = rel_base + name
                full = os.path.join(base, name)
                if not rel_base and self._is_bundle_file(name, full):
                    continue
                if not rel_base and name.lower().endswith(".zip"):
                    skipped.append(f"{rel}: 압축 파일이라 포함하지 않았습니다")
                    continue
                if os.path.islink(full):
                    target = os.path.realpath(full)
                    if not os.path.exists(target):
                        skipped.append(f"{rel}: 끊어진 링크라서 포함하지 않았습니다")
                        continue
                    if not target.startswith(root_real + os.sep):
                        skipped.append(f"{rel}: 프로젝트 밖을 가리키는 링크라서 포함하지 않았습니다")
                        continue
                if name.startswith(".") or name in PRIVATE_NAMES or name.lower().endswith(PRIVATE_EXTS):
                    skipped.append(f"{rel}: 숨김 파일이거나 비밀 정보가 담길 수 있어 포함하지 않았습니다")
                    continue
                files.append(rel)
        return files, skipped

    @staticmethod
    def _is_bundle_file(name, full):
        """Launchers and the guide a received zip came with. They are added back to any new zip."""
        name = nfc(name)
        if name in launcher_files():
            return True
        if name != RECIPIENT_GUIDE:
            return False
        try:
            with open(full, "rb") as f:
                return f.read() == README_FOR_RECIPIENT.encode("utf-8")
        except OSError:
            return False

    def walk_files(self):
        return self.scan()[0]

    def pages(self):
        return [p for p in self.walk_files() if p.lower().endswith(HTML_EXTS)]

    def default_page(self):
        pages = self.pages()
        if not pages:
            return None
        for name in ("index.html", "index.htm"):
            if name in pages:
                return name
        top = [p for p in pages if "/" not in p]
        return (top or pages)[0]

    # --- edits ---
    def edits_file(self, page):
        return self.path(EDITS_DIR, "pages", *(page + ".json").split("/"))

    def load_edits(self, page):
        try:
            with open(self.edits_file(page), encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return json.loads(json.dumps(EMPTY_EDITS))
        problem = not isinstance(data, dict)
        if not problem:
            problem = any(not isinstance(data.get(k, {}), dict) for k in ("targets", "styles", "meta", "text", "images", "inlineSvg", "fonts"))
        if not problem:
            problem = any(not isinstance(v, str) for v in data.get("images", {}).values())
        if problem:
            raise ValueError("unexpected contents in edits file")
        return {**json.loads(json.dumps(EMPTY_EDITS)), **data}

    def svg_override(self, rel):
        return self.path(EDITS_DIR, "svg", *rel.split("/"))

    def resolved_file(self, rel):
        """The file to use for rel: an edited SVG if one exists, otherwise the original."""
        if rel.lower().endswith(".svg"):
            override = self.svg_override(rel)
            if os.path.isfile(override):
                return override
        return self.path(*rel.split("/"))

    def upload_file(self, name):
        return self.path(EDITS_DIR, "uploads", os.path.basename(name))


# ---------- fonts ----------

def font_store():
    """Fonts kept on this computer, so other projects don't have to get them again."""
    return os.environ.get(FONT_STORE_ENV) or os.path.join(os.path.expanduser("~"), ".beavercoat", "fonts")


def font_catalog():
    try:
        with open(os.path.join(APP_DIR, "fonts.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def catalog_font(font_id):
    return next((font for font in font_catalog() if font["id"] == font_id), None)


def catalog_file(font, entry):
    return os.path.join(font_store(), font["id"], os.path.basename(entry["url"]))


def custom_fonts():
    try:
        with open(os.path.join(font_store(), "custom.json"), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def font_list():
    """What the editor shows: the catalog with what's already here, then fonts the user added."""
    listed = []
    for font in font_catalog():
        installed = all(
            os.path.isfile(catalog_file(font, e)) and os.path.getsize(catalog_file(font, e)) == e["size"]
            for e in font["files"]
        )
        listed.append({
            "id": font["id"], "family": font["family"], "group": font["group"], "installed": installed,
            "size": sum(e["size"] for e in font["files"]), "urls": [e["url"] for e in font["files"]],
        })
    for font_id, font in sorted(custom_fonts().items(), key=lambda item: item[1].get("family", "")):
        listed.append({"id": font_id, "family": font.get("family", ""), "group": "내 글꼴", "installed": True, "size": 0, "urls": []})
    return listed


def font_family_name(file_name):
    """A name usable in CSS, from the name of a file someone added."""
    stem = os.path.splitext(os.path.basename(nfc(file_name).replace("\\", "/")))[0]
    return re.sub(r'[\x00-\x1f"\\<>{};]', "", stem).strip()[:60] or "내 글꼴"


def add_custom_font(file_name, body):
    """Keep a font someone added. Returns its id, or None if the file isn't a font."""
    ext = FONT_MAGIC.get(body[:4])
    if not ext:
        return None
    digest = hashlib.sha256(body).hexdigest()[:16]
    write_atomic(os.path.join(font_store(), "custom", f"{digest}.{ext}"), body)
    fonts = custom_fonts()
    font_id = f"custom-{digest}"
    if font_id not in fonts:
        # Two files named alike (a regular and a bold, say) both stay, under names of their own.
        taken = {v.get("family") for v in fonts.values()}
        base = family = font_family_name(file_name)
        n = 2
        while family in taken:
            family = f"{base} {n}"
            n += 1
        fonts[font_id] = {"family": family, "file": f"{digest}.{ext}"}
    write_atomic(os.path.join(font_store(), "custom.json"), json.dumps(fonts, ensure_ascii=False, indent=1).encode("utf-8"))
    return font_id


def project_font_file(project, body, ext):
    """Copy a font in with the project's uploads. Named by its contents, like images."""
    name = f"{hashlib.sha256(body).hexdigest()[:16]}.{ext}"
    if not os.path.isfile(project.upload_file(name)):
        write_atomic(project.upload_file(name), body)
    return f"upload:{name}"


def use_font(project, font_id):
    """Put a font into the project. Returns what the page needs, or None if it isn't available here."""
    font = catalog_font(font_id)
    if font:
        faces = []
        for entry in font["files"]:
            try:
                with open(catalog_file(font, entry), "rb") as f:
                    body = f.read()
            except OSError:
                return None
            if hashlib.sha256(body).hexdigest() != entry["sha256"]:
                os.unlink(catalog_file(font, entry))
                return None
            faces.append({"src": project_font_file(project, body, "woff2"), "format": "woff2", "weight": entry["weight"], "range": entry["range"]})
        return {"family": font["family"], "fallback": font["fallback"], "faces": faces}
    custom = custom_fonts().get(font_id)
    if not custom:
        return None
    file = os.path.basename(str(custom.get("file", "")))
    ext = file.rsplit(".", 1)[-1]
    if ext not in FONT_FORMATS:
        return None
    try:
        with open(os.path.join(font_store(), "custom", file), "rb") as f:
            body = f.read()
    except OSError:
        return None
    return {
        "family": custom["family"], "fallback": "sans-serif",
        "faces": [{"src": project_font_file(project, body, ext), "format": FONT_FORMATS[ext], "weight": "", "range": ""}],
    }


def font_values(edits):
    """Every font-family an edit sets."""
    values = []
    styles = edits.get("styles")
    for scopes in (styles.values() if isinstance(styles, dict) else []):
        for props in (scopes.values() if isinstance(scopes, dict) else []):
            value = props.get("font-family") if isinstance(props, dict) else None
            if isinstance(value, str):
                values.append(value)
    return values


def fonts_in_use(edits):
    """The fonts this page's edits use. A font tried and then changed back doesn't go along."""
    fonts = edits.get("fonts")
    values = font_values(edits)
    if not isinstance(fonts, dict):
        return {}
    used = {name.strip().strip("'\"").strip() for value in values for name in value.split(",")}
    return {family: faces for family, faces in fonts.items() if family in used}


def font_faces(edits):
    fonts = edits.get("fonts")
    for faces in (fonts.values() if isinstance(fonts, dict) else []):
        for face in (faces if isinstance(faces, list) else []):
            if isinstance(face, dict) and isinstance(face.get("src"), str):
                yield face


def font_uploads(edits):
    return {face["src"][7:] for face in font_faces(edits) if face["src"].startswith("upload:")}


def has_edits(edits):
    return any(edits.get(k) for k in ("styles", "text", "images", "inlineSvg"))


# ---------- HTML injection ----------

HEAD_RE = re.compile(r"<head\b[^>]*>", re.I)
HTML_RE = re.compile(r"<html\b[^>]*>", re.I)
DOCTYPE_RE = re.compile(r"\s*(?:<\?xml[^>]*\?>\s*)?<!doctype\b[^>]*>", re.I)
NON_MARKUP_RE = re.compile(r"<!--.*?(?:-->|\Z)|<(script|style|template|textarea|title)\b.*?</\1\s*>", re.I | re.S)
CHARSET_META_RE = re.compile(r"<meta\b[^>]*?\bcharset\s*=[^>]*>", re.I)


def masked(html):
    """Same-length copy of html with comments and raw-text elements blanked, so searches only see real tags."""
    return NON_MARKUP_RE.sub(lambda m: " " * len(m.group(0)), html)


def inject_head(html, snippet):
    """Insert snippet at the start of <head>, before anything else runs, and after any doctype."""
    plain = masked(html)
    match = HEAD_RE.search(plain) or HTML_RE.search(plain) or DOCTYPE_RE.match(plain)
    at = match.end() if match else 0
    return html[:at] + snippet + html[at:]


def page_with_snippet(html, snippet):
    """Prepare a page to be written as UTF-8.

    Browsers only look for the charset in the first 1024 bytes, so it goes before the snippet,
    and any older declaration is removed because the bytes written are always UTF-8.
    """
    plain = masked(html)
    for match in reversed(list(CHARSET_META_RE.finditer(plain))):
        html = html[:match.start()] + html[match.end():]
    return inject_head(html, '<meta charset="utf-8">' + snippet)


def script_json(value):
    """JSON safe to embed inside a <script> element."""
    return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c")


def edits_snippet(edits, asset_base):
    return f"<script>window.__BC_EDITS__={script_json(edits)};window.__BC_ASSET_BASE__={script_json(asset_base)};</script>"


def escape_inline_js(code):
    """Make JavaScript safe to place inside a page.

    `</script` would end the element, and `<!--` with `<script` makes the HTML parser swallow
    the rest of the page. Design-tool runtimes also search the page source for their `<x-dc>`
    block, so that text must not appear in inlined code. `\\x3c` keeps the same meaning in
    strings and regexes. Only exact words are replaced, because a broader pattern would break
    comparisons such as `a<b`.
    """
    return re.sub(r"<(?=/?script|!--|/?x-dc)", lambda _: "\\x3c", code, flags=re.I)


def apply_source():
    with open(os.path.join(APP_DIR, "apply.js"), encoding="utf-8") as f:
        return escape_inline_js(f.read())


# Browsers read these labels as the wider encodings on the right.
CODEC_ALIASES = {
    "euc-kr": "cp949", "euckr": "cp949", "ks_c_5601-1987": "cp949", "korean": "cp949",
    "shift_jis": "cp932", "shift-jis": "cp932", "sjis": "cp932", "x-sjis": "cp932",
    "iso-8859-1": "cp1252", "latin1": "cp1252", "latin-1": "cp1252", "ascii": "cp1252", "us-ascii": "cp1252",
    "gb2312": "gbk",
}
META_CHARSET_BYTES = re.compile(rb"""<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([a-zA-Z0-9_.:-]+)""", re.I)


def read_text(path):
    with open(path, "rb") as f:
        raw = f.read()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    match = META_CHARSET_BYTES.search(raw[:4096])
    if match:
        label = match.group(1).decode("ascii").lower()
        try:
            return raw.decode(CODEC_ALIASES.get(label, label), errors="replace")
        except LookupError:
            pass
    return raw.decode("cp949", errors="replace")


# ---------- generated output ----------

def build_results(project):
    """Regenerate the result folder: a copy of the project with saved edits applied.

    Returns (folder, messages). One unreadable file is reported and doesn't stop the rest.
    Only files this tool wrote earlier are ever deleted.
    """
    name = project.output_name(RESULT_DIR)
    out = project.path(name)
    files, skipped = project.scan()
    wanted = set(files)
    pages = {}
    uploads = set()
    for rel in files:
        if rel.lower().endswith(HTML_EXTS):
            try:
                edits = project.load_edits(rel)
            except ValueError:
                skipped.append(f"{rel}: 저장된 편집 파일이 손상되어 수정 없이 복사했습니다")
                continue
            if has_edits(edits):
                pages[rel] = edits
                uploads.update(v[7:] for v in edits["images"].values() if v.startswith("upload:"))
                uploads.update(font_uploads(edits))
    for upload in uploads:
        if os.path.isfile(project.upload_file(upload)):
            wanted.add(f"beavercoat-assets/{os.path.basename(upload)}")

    for rel in set(project.read_manifest(name)) - wanted:
        remove_generated(out, rel)
    project.write_manifest(name, wanted)

    for rel in files:
        dest = os.path.join(out, *rel.split("/"))
        src = project.resolved_file(rel)
        try:
            if rel in pages:
                asset_base = "../" * rel.count("/") + "beavercoat-assets/"
                snippet = edits_snippet(pages[rel], asset_base) + f"<script>{apply_source()}</script>"
                write_atomic(dest, page_with_snippet(read_text(src), snippet).encode("utf-8"))
            else:
                copy_if_changed(src, dest)
        except OSError:
            skipped.append(f"{rel}: 파일을 읽거나 쓰지 못해 건너뛰었습니다")
    for upload in uploads:
        src = project.upload_file(upload)
        if os.path.isfile(src):
            try:
                copy_if_changed(src, os.path.join(out, "beavercoat-assets", os.path.basename(upload)))
            except OSError:
                skipped.append(f"{upload}: 넣은 이미지를 복사하지 못했습니다")
    return out, sorted(set(skipped))


def remove_generated(out, rel):
    """Delete one file this tool generated, then any folders left empty by that."""
    full = os.path.join(out, *rel.split("/"))
    try:
        if os.path.isfile(full) or os.path.islink(full):
            os.unlink(full)
        parent = os.path.dirname(full)
        while os.path.normpath(parent) != os.path.normpath(out) and not os.listdir(parent):
            os.rmdir(parent)
            parent = os.path.dirname(parent)
    except OSError:
        pass  # A folder holding something else, or already gone. Both are fine to leave.


def copy_if_changed(src, dest):
    st = os.stat(src)
    if os.path.isfile(dest):
        d = os.stat(dest)
        # Equal times mean this exact file was copied before. Otherwise only the contents can tell.
        if st.st_size == d.st_size and (st.st_mtime_ns == d.st_mtime_ns or filecmp.cmp(src, dest, shallow=False)):
            return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=".bc-", suffix=".tmp")
    os.close(fd)
    try:
        shutil.copyfile(src, tmp)
        os.chmod(tmp, 0o644)
        os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        os.replace(tmp, dest)
    except OSError:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


mimetypes.add_type("image/avif", ".avif")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("font/otf", ".otf")

EXTERNAL_RE = re.compile(r"^(?:[a-z][a-z0-9+.-]*:|//)", re.I)
WEB_URL_RE = re.compile(r"^(?:https?:)?//", re.I)
ATTR_BODY = r"""(?:[^>"']|"[^"]*"|'[^']*')*"""
TOKEN_RE = re.compile(
    r"<!--.*?(?:-->|\Z)"
    rf"|<script\b(?P<script_attrs>{ATTR_BODY})>(?P<script_body>.*?)</script\s*>"
    rf"|<style\b(?P<style_attrs>{ATTR_BODY})>(?P<style_body>.*?)</style\s*>"
    rf"|<(?P<tag>[a-zA-Z][^\s/>]*)(?P<attrs>{ATTR_BODY})>",
    re.I | re.S,
)
ATTR_ITEM = re.compile(r"""([^\s=/"'>]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?""")
URL_FN = re.compile(r"""url\(\s*(["']?)(.*?)\1\s*\)""", re.I | re.S)
CSS_IMPORT = re.compile(r"""@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);""", re.I)
SRCSET_ITEM = re.compile(r"""\s*(\S*[^\s,])(?:,|\s+([^,]*)(?:,|$)|$)""")
JS_IMPORT = re.compile(r"""(?:^|[;\s])(?:import\b\s*(?:[\w${*][^;'"]*from\s*)?\(?\s*["']|export\b[^;'"]*from\s*["'])""")
SRC_TAGS = {"img", "source", "video", "audio", "track", "embed", "input"}


def attrs_of(text):
    """Attribute values by lowercase name, with entities decoded."""
    found = {}
    for m in ATTR_ITEM.finditer(text):
        raw = m.group(3) or ""
        if raw[:1] in ("'", '"'):
            raw = raw[1:-1]
        found.setdefault(m.group(1).lower(), html_lib.unescape(raw))
    return found


def rewrite_attrs(text, fn):
    """Call fn(name, value) for each attribute. Return a string to replace the value, or False to drop it."""
    def replace(m):
        raw = m.group(3) or ""
        if raw[:1] in ("'", '"'):
            raw = raw[1:-1]
        new = fn(m.group(1).lower(), html_lib.unescape(raw))
        if new is None:
            return m.group(0)
        return "" if new is False else f'{m.group(1)}="{attr_escape(new)}"'
    return ATTR_ITEM.sub(replace, text)


def attr_escape(value):
    return value.replace("&", "&amp;").replace('"', "&quot;")


class Inliner:
    """Turns a page into a single HTML file that opens without a server."""

    def __init__(self, project, page):
        self.project = project
        self.page = page
        self.base = posixpath.dirname(page)
        self.warnings = []

    def local(self, url, base=None):
        """Return (project-relative path, full path) for a local URL, or None."""
        url = url.strip()
        if not url or url.startswith("#") or EXTERNAL_RE.match(url):
            return None
        clean = urllib.parse.unquote(url.split("#")[0].split("?")[0])
        rel = posixpath.normpath(posixpath.join(base if base is not None else self.base, clean)).lstrip("/")
        if self.project.safe_path(rel) is None:
            return None
        full = self.project.resolved_file(rel)
        return (rel, full) if os.path.isfile(full) else None

    def report(self, url, kind):
        """Warn about a URL that could not be included: on the web, or missing from the project."""
        url = url.strip()
        if WEB_URL_RE.match(url):
            self.warnings.append(f"{kind}: {url}")
        elif url and not url.startswith("#") and not EXTERNAL_RE.match(url):
            self.warnings.append(f"파일을 찾지 못했습니다: {url}")

    def data_uri(self, full, rel=None):
        mime = mimetypes.guess_type(rel or full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            return f"data:{mime};base64,{base64.b64encode(f.read()).decode('ascii')}"

    def inline_file(self, url, kind="이미지·미디어"):
        """The data URI for a local file, or None after warning."""
        found = self.local(url)
        if found:
            return self.data_uri(found[1], found[0])
        self.report(url, kind)
        return None

    def inline_css(self, css, base, seen=()):
        """Fold @import files in and turn url() references into data URIs. Paths resolve from each file's folder."""
        def imported(match):
            url, media = match.group(2), match.group(3).strip()
            found = self.local(url, base)
            if not found:
                self.report(url, "글꼴·스타일")
                return match.group(0)
            if found[0] in seen:
                return ""
            inner = self.inline_css(read_text(found[1]), posixpath.dirname(found[0]), (*seen, found[0]))
            return f"@media {media} {{\n{inner}\n}}" if media else inner

        def url_fn(match):
            url = match.group(2)
            found = self.local(url, base)
            if found:
                return f'url("{self.data_uri(found[1], found[0])}")'
            self.report(url, "CSS 파일")
            return match.group(0)

        css = URL_FN.sub(url_fn, CSS_IMPORT.sub(imported, css))
        return re.sub(r"</style", r"<\\/style", css, flags=re.I)

    def inline_style_attr(self, value):
        def replace(match):
            found = self.local(match.group(2))
            return f"url({self.data_uri(found[1], found[0])})" if found else match.group(0)
        return URL_FN.sub(replace, value)

    def inline_srcset(self, value):
        parts = []
        for m in SRCSET_ITEM.finditer(value):
            uri = self.inline_file(m.group(1))
            descriptor = (m.group(2) or "").strip()
            parts.append((uri or m.group(1)) + (" " + descriptor if descriptor else ""))
        return ", ".join(parts)

    def script(self, match):
        attrs, whole = match.group("script_attrs"), match.group(0)
        found_attrs = attrs_of(attrs)
        src = found_attrs.get("src")
        if src is None:
            return whole
        found = self.local(src)
        if not found:
            self.report(src, "스크립트")
            return whole
        code = read_text(found[1])
        kept = rewrite_attrs(attrs, lambda name, _: False if name in ("src", "integrity", "crossorigin") else None).rstrip()
        if found_attrs.get("type", "").strip().lower() == "module":
            if JS_IMPORT.search(code):
                self.warnings.append(f"이 모듈이 불러오는 다른 파일은 포함되지 않습니다: {src}")
        elif "defer" in found_attrs or "async" in found_attrs:
            # Inline scripts ignore these, so the code stays in src to keep its run order.
            return f'<script{kept} src="{self.data_uri(found[1], "x.js").replace("text/plain", "text/javascript")}"></script>'
        return f"<script{kept}>{escape_inline_js(code)}</script>"

    def link(self, attrs, whole):
        values = attrs_of(attrs)
        rel_words = values.get("rel", "").lower().split()
        href = values.get("href")
        if href is None:
            return whole
        if "stylesheet" in rel_words:
            found = self.local(href)
            if not found:
                self.report(href, "글꼴·스타일")
                return whole
            css = self.inline_css(read_text(found[1]), posixpath.dirname(found[0]), (found[0],))
            kept = "".join(f' {n}="{attr_escape(values[n])}"' for n in ("media", "id", "title") if n in values)
            return f"<style{kept}>{css}</style>"
        if {"icon", "apple-touch-icon"} & set(rel_words):
            uri = self.inline_file(href)
            if uri:
                return f"<link{rewrite_attrs(attrs, lambda n, _: uri if n == 'href' else None)}>"
        return whole

    def tag(self, name, attrs, whole):
        if name == "link":
            return self.link(attrs, whole)
        closing = "/" if attrs.rstrip().endswith("/") else ""
        body = attrs.rstrip()[:-1] if closing else attrs
        original_src = []

        def rewrite(attr, value):
            if attr == "style":
                return self.inline_style_attr(value)
            if attr == "src" and name in SRC_TAGS:
                uri = self.inline_file(value)
                if uri and name == "img":
                    original_src.append(value)
                return uri
            if attr in ("srcset", "imagesrcset") and name in SRC_TAGS:
                return self.inline_srcset(value)
            if attr == "poster" and name == "video":
                return self.inline_file(value)
            if attr == "data" and name == "object":
                return self.inline_file(value)
            if attr in ("href", "xlink:href") and name == "image":
                return self.inline_file(value)
            if attr in ("href", "xlink:href") and name == "use" and self.local(value):
                self.warnings.append(f"다른 SVG 파일의 도형은 포함되지 않습니다: {value}")
            if attr == "src" and name == "iframe" and self.local(value):
                self.warnings.append(f"프레임 안의 페이지는 포함되지 않습니다: {value}")
            return None

        new = rewrite_attrs(body, rewrite)
        if original_src:
            # Lets a saved edit recognise this image by its file name after src becomes data.
            new = new.rstrip() + f' data-bc-src="{attr_escape(original_src[0])}"'
        return f"<{whole[1:len(name) + 1]}{new}{closing}>"

    def run(self, html):
        def replace(match):
            if match.group("tag"):
                return self.tag(match.group("tag").lower(), match.group("attrs"), match.group(0))
            if match.group("script_attrs") is not None:
                return self.script(match)
            if match.group("style_attrs") is not None:
                css = self.inline_css(match.group("style_body"), self.base, (self.page,))
                return f"<style{match.group('style_attrs')}>{css}</style>"
            return match.group(0)
        return TOKEN_RE.sub(replace, html)


def build_viewer(project, page):
    """Create <share>/<page>-보기용.html. Returns (path, warnings)."""
    src = project.resolved_file(page)
    inliner = Inliner(project, page)
    html = inliner.run(read_text(src))
    edits = project.load_edits(page)
    snippet = ""
    if has_edits(edits):
        for key, value in list(edits["images"].items()):
            if value.startswith("upload:"):
                full = project.upload_file(value[7:])
                if os.path.isfile(full):
                    edits["images"][key] = inliner.data_uri(full)
                else:
                    inliner.warnings.append(f"넣은 이미지를 찾지 못했습니다: {value[7:]}")
        for face in font_faces(edits):
            if face["src"].startswith("upload:"):
                full = project.upload_file(face["src"][7:])
                if os.path.isfile(full):
                    face["src"] = inliner.data_uri(full)
                else:
                    inliner.warnings.append(f"넣은 글꼴을 찾지 못했습니다: {face['src'][7:]}")
        snippet = edits_snippet(edits, "") + f"<script>{apply_source()}</script>"
    html = page_with_snippet(html, snippet)
    # Folder names stay in the file name, or a/index.html and b/index.html would overwrite each other.
    stem = re.sub(r"\.html?$", "", page.replace("/", "-"), flags=re.I)
    out = os.path.join(project.share_dir(), f"{stem}-보기용.html")
    write_atomic(out, html.encode("utf-8"))
    return out, sorted(set(inliner.warnings))


def launcher_files():
    mac = (
        '#!/bin/bash\ncd "$(dirname "$0")" || exit 1\n'
        'if command -v python3 >/dev/null 2>&1; then\n'
        '  python3 .beavercoat/beavercoat.py .\nelse\n'
        '  echo "Python 3이 필요합니다. https://www.python.org/downloads/ 에서 설치한 뒤 다시 실행해 주세요."\n'
        '  read -r -p "Enter를 누르면 닫힙니다."\nfi\n'
    )
    win = (
        "@echo off\r\nchcp 65001 >nul\r\ncd /d \"%~dp0\"\r\n"
        "py -3 --version >nul 2>&1 && (py -3 .beavercoat\\beavercoat.py . & goto :end)\r\n"
        "python --version >nul 2>&1 && (python .beavercoat\\beavercoat.py . & goto :end)\r\n"
        "echo Python 3이 필요합니다. https://www.python.org/downloads/ 에서 설치한 뒤 다시 실행해 주세요.\r\n"
        ":end\r\npause\r\n"
    )
    return {"편집기 열기.command": (mac, 0o755), "편집기 열기.bat": (win, 0o644)}


RECIPIENT_GUIDE = "사용법.txt"
README_FOR_RECIPIENT = """HTML 프로토타입과 편집기 beavercoat

[여는 방법]
Mac:     "편집기 열기.command"를 더블클릭합니다.
         보안 경고가 나오면 파일을 Control-클릭한 뒤 "열기"를 고릅니다.
Windows: "편집기 열기.bat"을 더블클릭합니다.
Python 3이 필요합니다. 없다면 https://www.python.org/downloads/ 에서 설치해 주세요.
브라우저에 편집기가 열립니다. 끝낼 때는 실행 창을 닫으면 됩니다.

[폴더 안내]
결과/          수정이 반영된 페이지
.design-edits/ 저장된 편집 내용 (Mac에서는 숨김 폴더로 보입니다)

수정한 뒤에는 "저장"을 누르고 폴더 전체를 다시 압축해 보내 주세요.
이 프로그램은 내 컴퓨터 안에서만 동작합니다. 글꼴을 받을 때만 인터넷을 사용합니다.
"""


def zip_time(full):
    """A file's date in the range the zip format can store."""
    stamp = time.localtime(os.stat(full).st_mtime)[:6]
    if stamp[0] < 1980:
        return (1980, 1, 1, 0, 0, 0)
    return (2107, 12, 31, 23, 59, 58) if stamp[0] > 2107 else stamp


def zip_fonts(project, sources):
    """Font files some page uses. None means a page couldn't be read, so nothing should be left out."""
    used = set()
    for rel in sources:
        if rel.lower().endswith(HTML_EXTS):
            try:
                used |= font_uploads(project.load_edits(rel))
            except ValueError:
                return None
    return used


def build_zip(project):
    """Create <share>/<project>-편집용.zip with the editor bundled. Returns (path, messages)."""
    results, skipped = build_results(project)
    result_name = os.path.basename(results)
    out = os.path.join(project.share_dir(), f"{project.name}-편집용.zip")
    top = project.name

    def add_file(z, full, arc, mode=0o644):
        info = zipfile.ZipInfo(nfc(f"{top}/{arc}"), date_time=zip_time(full))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100000 | mode) << 16
        with open(full, "rb") as f:
            z.writestr(info, f.read())

    def add_text(z, arc, text, mode=0o644):
        info = zipfile.ZipInfo(nfc(f"{top}/{arc}"), date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100000 | mode) << 16
        z.writestr(info, text.encode("utf-8"))

    def add_project_file(z, full, arc):
        try:
            add_file(z, full, arc)
        except OSError:
            skipped.append(f"{arc}: 파일을 읽지 못해 압축에 넣지 않았습니다")

    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out), prefix=".bc-", suffix=".tmp")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            sources = project.walk_files()
            for rel in sources:
                add_project_file(z, project.path(*rel.split("/")), rel)
            fonts_kept = zip_fonts(project, sources)
            uploads_dir = project.path(EDITS_DIR, "uploads")
            for base, _, files in os.walk(project.path(EDITS_DIR)):
                for name in sorted(files):
                    full = os.path.join(base, name)
                    if name in SKIP_FILES or name.endswith(".tmp") or os.path.islink(full):
                        continue
                    if fonts_kept is not None and base == uploads_dir and name.rsplit(".", 1)[-1] in FONT_FORMATS and name not in fonts_kept:
                        continue
                    add_project_file(z, full, os.path.relpath(full, project.root).replace(os.sep, "/"))
            # Only what this tool generated: anything else someone put in that folder stays private.
            for rel in [*project.read_manifest(result_name), OUTPUT_MARKER]:
                full = os.path.join(results, *rel.split("/"))
                if os.path.isfile(full):
                    add_project_file(z, full, f"{result_name}/{rel}")
            add_file(z, os.path.join(APP_DIR, "beavercoat.py"), f"{BUNDLED_APP_DIR}/beavercoat.py")
            for name in sorted(APP_FILES):
                add_file(z, os.path.join(APP_DIR, name), f"{BUNDLED_APP_DIR}/{name}")
            for name, (text, mode) in launcher_files().items():
                add_text(z, name, text, mode)
            if RECIPIENT_GUIDE not in {nfc(rel) for rel in sources}:
                add_text(z, RECIPIENT_GUIDE, README_FOR_RECIPIENT)
        os.chmod(tmp, 0o644)
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return out, sorted(set(skipped))


# ---------- HTTP ----------

class Handler(http.server.SimpleHTTPRequestHandler):
    project = None

    def log_message(self, *args):
        pass

    def end_headers(self):
        # Replaced files must show up on the next refresh.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _host_ok(self):
        port = self.server.server_address[1]
        return self.headers.get("Host", "") in {f"127.0.0.1:{port}", f"localhost:{port}"}

    def _post_ok(self):
        host = self.headers.get("Host", "")
        # Other websites can't reach these endpoints: they fail the Origin and header checks.
        return (
            self._host_ok()
            and self.headers.get("Origin") == f"http://{host}"
            and self.headers.get("X-Beavercoat") == "1"
        )

    def _send(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, payload):
        self._send(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _serve_file(self, full, content_type=None, sandbox=False):
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type or mimetypes.guess_type(full)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        if sandbox:
            self.send_header("Content-Security-Policy", "sandbox")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return self.send_error(403, "Forbidden host")
        url = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(url.path)
        query = urllib.parse.parse_qs(url.query)
        if path.startswith("/__bc/"):
            return self._app_get(path[6:], query)
        rel = path.lstrip("/")
        if rel == "":
            page = self.project.default_page()
            self.send_response(302)
            self.send_header("Location", "/__bc/editor.html" + (f"?page={urllib.parse.quote(page)}" if page else ""))
            self.end_headers()
            return
        if self.project.safe_path(rel) is None:
            return self.send_error(403, "Forbidden path")
        parts = rel.split("/")
        full = self.project.path(*parts)
        if parts[0] == EDITS_DIR:
            if os.path.isfile(full):
                return self._serve_file(full, sandbox=True)
            return self.send_error(404, "Not found")
        if rel.lower().endswith(HTML_EXTS) and os.path.isfile(full):
            html = read_text(full)
            try:
                edits = self.project.load_edits(rel)
            except ValueError:
                edits = EMPTY_EDITS  # The editor reports the damaged file. The page still opens.
            snippet = edits_snippet(edits, f"/{EDITS_DIR}/uploads/") + '<script src="/__bc/apply.js"></script>'
            return self._send(200, page_with_snippet(html, snippet).encode("utf-8"), "text/html; charset=utf-8")
        if rel.lower().endswith(".svg") and "bc-original" not in query:
            resolved = self.project.resolved_file(rel)
            if os.path.isfile(resolved):
                return self._serve_file(resolved, "image/svg+xml", sandbox=resolved != full)
        super().do_GET()

    def _app_get(self, name, query):
        if name in APP_FILES:
            types = {"html": "text/html", "js": "text/javascript", "json": "application/json"}
            return self._serve_file(os.path.join(APP_DIR, name), types[name.rsplit(".", 1)[1]] + "; charset=utf-8")
        if name == "fonts":
            return self._json(200, {"fonts": font_list()})
        if name == "state":
            pages = self.project.pages()
            page = query.get("page", [self.project.default_page()])[0]
            if page not in pages:
                return self._json(404, {"error": "page not found", "pages": pages})
            try:
                edits = self.project.load_edits(page)
            except ValueError:
                file = os.path.relpath(self.project.edits_file(page), self.project.root).replace(os.sep, "/")
                return self._json(409, {"error": "damaged edits", "file": file, "pages": pages, "page": page})
            return self._json(200, {"project": self.project.name, "pages": pages, "page": page, "edits": edits})
        return self.send_error(404, "Not found")

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if not self._post_ok():
            return self.send_error(403, "Forbidden")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.send_error(411, "Length required")
        limit = MAX_UPLOAD_BYTES if url.path in ("/__bc/upload", "/__bc/font-file", "/__bc/font-upload") else MAX_SAVE_BYTES
        if length <= 0 or length > limit:
            return self.send_error(413, "Too large")
        body = self.rfile.read(length)
        try:
            if url.path == "/__bc/save":
                return self._save(body)
            if url.path == "/__bc/upload":
                return self._upload(body, urllib.parse.parse_qs(url.query))
            if url.path == "/__bc/export":
                return self._export(body)
            if url.path == "/__bc/font-file":
                return self._font_file(body, urllib.parse.parse_qs(url.query))
            if url.path == "/__bc/font-upload":
                return self._font_upload(body, urllib.parse.parse_qs(url.query))
            if url.path == "/__bc/font-use":
                return self._font_use(body)
        except (OSError, ValueError) as e:
            return self._json(500, {"error": str(e)})
        return self.send_error(404, "Not found")

    def _save(self, body):
        try:
            payload = json.loads(body)
            page, edits, svgs = payload["page"], payload["edits"], payload.get("svgs", {})
            if not isinstance(edits, dict) or not isinstance(svgs, dict):
                raise TypeError
        except (ValueError, KeyError, TypeError):
            return self._json(400, {"error": "invalid payload"})
        if page not in self.project.pages():
            return self._json(400, {"error": "unknown page"})
        # Validate every file before writing any, so a save is all-or-nothing.
        planned = []
        sources = set(self.project.walk_files())
        for rel, text in svgs.items():
            full = self.project.safe_path(rel)
            if full is None or not rel.lower().endswith(".svg") or not os.path.isfile(full):
                return self._json(400, {"error": f"unknown svg: {rel}"})
            rel = posixpath.normpath(rel).lstrip("/")
            if rel not in sources:
                return self._json(400, {"error": f"unknown svg: {rel}"})
            if text is not None:
                try:
                    root = ET.fromstring(text.encode("utf-8"))
                except (ET.ParseError, AttributeError):
                    return self._json(400, {"error": f"invalid svg: {rel}"})
                if not root.tag.endswith("svg"):
                    return self._json(400, {"error": f"invalid svg: {rel}"})
            planned.append((rel, text))
        edits["fonts"] = fonts_in_use(edits)
        write_atomic(self.project.edits_file(page), json.dumps(edits, ensure_ascii=False, indent=1).encode("utf-8"))
        for rel, text in planned:
            override = self.project.svg_override(rel)
            if text is None:
                if os.path.exists(override):
                    os.unlink(override)
            else:
                write_atomic(override, text.encode("utf-8"))
        out, skipped = build_results(self.project)
        self._json(200, {"ok": True, "results": os.path.basename(out), "skipped": skipped})

    def _upload(self, body, query):
        ext = query.get("ext", [""])[0].lower()
        if ext not in IMAGE_EXTS:
            return self._json(400, {"error": "unsupported image type"})
        name = f"{hashlib.sha256(body).hexdigest()[:16]}.{ext}"
        write_atomic(self.project.upload_file(name), body)
        self._json(200, {"value": f"upload:{name}"})

    def _font_file(self, body, query):
        """Keep one file of a listed font. The browser fetched it; the hash decides if it's the right one."""
        font = catalog_font(query.get("id", [""])[0])
        try:
            index = int(query.get("index", [""])[0])
            if index < 0:
                raise IndexError(index)
            entry = font["files"][index]
        except (TypeError, ValueError, IndexError):
            return self._json(400, {"error": "unknown font file"})
        if hashlib.sha256(body).hexdigest() != entry["sha256"]:
            return self._json(400, {"error": "font file does not match"})
        write_atomic(catalog_file(font, entry), body)
        self._json(200, {"ok": True})

    def _font_upload(self, body, query):
        font_id = add_custom_font(query.get("name", [""])[0], body)
        if not font_id:
            return self._json(400, {"error": "not a font"})
        self._json(200, {"id": font_id})

    def _font_use(self, body):
        try:
            font_id = json.loads(body)["id"]
        except (ValueError, KeyError, TypeError):
            return self._json(400, {"error": "invalid payload"})
        font = use_font(self.project, font_id)
        if not font:
            return self._json(404, {"error": "font not available"})
        self._json(200, font)

    def _export(self, body):
        try:
            payload = json.loads(body)
            kind = payload["kind"]
        except (ValueError, KeyError, TypeError):
            return self._json(400, {"error": "invalid payload"})
        if kind == "viewer":
            page = payload.get("page")
            if page not in self.project.pages():
                return self._json(400, {"error": "unknown page"})
            out, warnings = build_viewer(self.project, page)
        elif kind == "zip":
            out, warnings = build_zip(self.project)
        else:
            return self._json(400, {"error": "unknown export"})
        self._json(200, {"path": os.path.relpath(out, self.project.root).replace(os.sep, "/"), "warnings": warnings})


def start_server(project, port_arg):
    handler = functools.partial(type("BoundHandler", (Handler,), {"project": project}), directory=project.root)
    ports = [port_arg] if port_arg else range(8765, 8800)
    for port in ports:
        try:
            return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler), port
        except OSError:
            continue
    sys.exit("사용할 수 있는 포트를 찾지 못했습니다. --port로 다른 번호를 지정해 주세요.")


def page_argument(project, given):
    """A project-relative page path from what was typed: ./x.html, .\\x.html or a full path."""
    if os.path.isabs(given):
        inside = os.path.relpath(os.path.realpath(given), os.path.realpath(project.root))
        given = inside if not inside.startswith("..") else given
    return posixpath.normpath(given.replace("\\", "/"))


def main():
    parser = argparse.ArgumentParser(description="Edit HTML prototypes without touching the originals.")
    parser.add_argument("folder", nargs="?", default=".")
    parser.add_argument("--page", help="HTML file to open, relative to the folder")
    parser.add_argument("--port", type=int)
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    parser.add_argument("--build", action="store_true", help="regenerate 결과/ and exit")
    parser.add_argument("--export", choices=["viewer", "zip"], help="create a shareable file and exit")
    args = parser.parse_args()

    if not os.path.isdir(args.folder):
        sys.exit(f"폴더를 찾지 못했습니다: {args.folder}")
    project = Project(args.folder)
    page = page_argument(project, args.page) if args.page else project.default_page()
    if page is None:
        sys.exit("이 폴더에서 HTML 파일을 찾지 못했습니다.")
    if page not in project.pages():
        sys.exit(f"페이지를 찾지 못했습니다: {page}")

    if args.build:
        out, skipped = build_results(project)
        print(out)
        for message in skipped:
            print("주의:", message)
        return
    if args.export == "viewer":
        try:
            out, warnings = build_viewer(project, page)
        except ValueError:
            sys.exit(f"저장된 편집 파일이 손상되었습니다: {os.path.relpath(project.edits_file(page), project.root)}")
        print(out)
        for w in warnings:
            print("주의:", w)
        return
    if args.export == "zip":
        out, skipped = build_zip(project)
        print(out)
        for message in skipped:
            print("주의:", message)
        return

    server, port = start_server(project, args.port)
    url = f"http://127.0.0.1:{port}/__bc/editor.html?page={urllib.parse.quote(page)}"
    print(f"beavercoat 편집기: {url}", flush=True)
    print("끝내려면 Ctrl+C를 누르거나 이 창을 닫으세요.", flush=True)
    if not args.no_open:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
