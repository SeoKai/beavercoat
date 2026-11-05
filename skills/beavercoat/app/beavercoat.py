#!/usr/bin/env python3
"""beavercoat: edit HTML prototypes visually without touching the original files.

Usage:
    python3 beavercoat.py [folder] [--page PAGE] [--port PORT] [--no-open]
    python3 beavercoat.py [folder] --export viewer|zip [--page PAGE]
    python3 beavercoat.py [folder] --build

Edits live in <folder>/.design-edits/. Every save regenerates <folder>/결과/.
The server only listens on 127.0.0.1. Python standard library only.
"""
import argparse
import base64
import functools
import hashlib
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
RESERVED = {EDITS_DIR, RESULT_DIR, SHARE_DIR, BUNDLED_APP_DIR, ".git", ".claude", "node_modules", "__pycache__"}
SKIP_FILES = {".DS_Store", "Thumbs.db"}
APP_FILES = {"editor.html", "editor.js", "apply.js"}
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif", "avif", "svg"}
MAX_SAVE_BYTES = 20 * 1024 * 1024
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
HTML_EXTS = (".html", ".htm")
EMPTY_EDITS = {
    "version": 2, "targets": {}, "styles": {}, "meta": {}, "text": {}, "images": {},
    "inlineSvg": {}, "breakpoints": None,
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

    def walk_files(self):
        """Yield project-relative POSIX paths of source files, skipping generated folders."""
        for base, dirs, files in os.walk(self.root):
            dirs[:] = sorted(d for d in dirs if d not in RESERVED)
            rel_base = os.path.relpath(base, self.root)
            for name in sorted(files):
                if name in SKIP_FILES or name.endswith(".tmp"):
                    continue
                if rel_base == "." and name.lower().endswith(".zip"):
                    continue
                rel = name if rel_base == "." else os.path.join(rel_base, name)
                yield rel.replace(os.sep, "/")

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


def has_edits(edits):
    return any(edits.get(k) for k in ("styles", "text", "images", "inlineSvg"))


# ---------- HTML injection ----------

HEAD_RE = re.compile(r"<head\b[^>]*>", re.I)
HTML_RE = re.compile(r"<html\b[^>]*>", re.I)


def inject_head(html, snippet):
    """Insert snippet at the start of <head>, before anything else runs."""
    for pattern in (HEAD_RE, HTML_RE):
        match = pattern.search(html)
        if match:
            return html[:match.end()] + snippet + html[match.end():]
    return snippet + html


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
    for word in ("</script", "<script", "<!--", "<x-dc", "</x-dc"):
        code = code.replace(word, "\\x3c" + word[1:])
    return code


def apply_source():
    with open(os.path.join(APP_DIR, "apply.js"), encoding="utf-8") as f:
        return escape_inline_js(f.read())


def read_text(path):
    with open(path, "rb") as f:
        raw = f.read()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp949", errors="replace")


# ---------- generated output ----------

def build_results(project):
    """Regenerate 결과/: a copy of the project with saved edits applied."""
    out = project.path(RESULT_DIR)
    wanted = set()
    used_uploads = set()
    for rel in project.walk_files():
        dest = os.path.join(out, *rel.split("/"))
        wanted.add(os.path.normpath(dest))
        src = project.resolved_file(rel)
        if rel.lower().endswith(HTML_EXTS):
            edits = project.load_edits(rel)
            if has_edits(edits):
                depth = rel.count("/")
                asset_base = "../" * depth + "beavercoat-assets/"
                used_uploads.update(v[7:] for v in edits["images"].values() if v.startswith("upload:"))
                snippet = edits_snippet(edits, asset_base) + f"<script>{apply_source()}</script>"
                write_atomic(dest, inject_head(read_text(src), snippet).encode("utf-8"))
                continue
        copy_if_changed(src, dest)
    for name in used_uploads:
        src = project.upload_file(name)
        if os.path.isfile(src):
            dest = os.path.join(out, "beavercoat-assets", name)
            wanted.add(os.path.normpath(dest))
            copy_if_changed(src, dest)
    # Remove files whose source no longer exists so the folder never shows stale pages.
    for base, _, files in os.walk(out, topdown=False):
        for name in files:
            full = os.path.normpath(os.path.join(base, name))
            if full not in wanted:
                os.unlink(full)
        if base != out and not os.listdir(base):
            os.rmdir(base)
    return out


def copy_if_changed(src, dest):
    if os.path.exists(dest):
        s, d = os.stat(src), os.stat(dest)
        if s.st_size == d.st_size and s.st_mtime <= d.st_mtime:
            return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(src, dest)


EXTERNAL_RE = re.compile(r"^(?:[a-z][a-z0-9+.-]*:|//)", re.I)


def attr_re(name):
    return re.compile(r"""(\b%s\s*=\s*)(["'])(.*?)\2""" % name, re.I | re.S)


SRC_ATTR = attr_re("src")
HREF_ATTR = attr_re("href")
URL_FN = re.compile(r"""url\(\s*(["']?)(.*?)\1\s*\)""", re.I | re.S)
SCRIPT_RE = re.compile(r"<script\b([^>]*)>\s*</script\s*>", re.I | re.S)
ANY_SCRIPT_RE = re.compile(r"(<script\b[^>]*>.*?</script\s*>)", re.I | re.S)
LINK_RE = re.compile(r"<link\b[^>]*>", re.I | re.S)
IMG_RE = re.compile(r"<(?:img|source|video|audio)\b[^>]*>", re.I | re.S)
STYLE_ATTR = attr_re("style")
STYLE_BLOCK = re.compile(r"(<style\b[^>]*>)(.*?)(</style\s*>)", re.I | re.S)


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
        if not url or url.startswith("#") or url.lower().startswith("data:") or EXTERNAL_RE.match(url):
            return None
        clean = urllib.parse.unquote(url.split("#")[0].split("?")[0])
        rel = posixpath.normpath(posixpath.join(base if base is not None else self.base, clean)).lstrip("/")
        if self.project.safe_path(rel) is None:
            return None
        full = self.project.resolved_file(rel)
        return (rel, full) if os.path.isfile(full) else None

    def note_external(self, url, kind):
        if EXTERNAL_RE.match(url) and not url.lower().startswith("data:"):
            self.warnings.append(f"{kind}: {url}")

    def data_uri(self, full, rel=None):
        mime = mimetypes.guess_type(rel or full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            return f"data:{mime};base64,{base64.b64encode(f.read()).decode('ascii')}"

    def inline_css_urls(self, css, base):
        def replace(match):
            url = match.group(2)
            found = self.local(url, base)
            if found:
                return f'url("{self.data_uri(found[1], found[0])}")'
            if url.strip() and not url.startswith("#"):
                self.note_external(url, "CSS 파일")
            return match.group(0)
        return URL_FN.sub(replace, css)

    def run(self, html):
        def script(match):
            attrs = match.group(1)
            src = SRC_ATTR.search(attrs)
            if not src:
                return match.group(0)
            found = self.local(src.group(3))
            if not found:
                self.note_external(src.group(3), "스크립트")
                return match.group(0)
            code = escape_inline_js(read_text(found[1]))
            return f"<script{SRC_ATTR.sub('', attrs, count=1)}>{code}</script>"

        def link(match):
            tag = match.group(0)
            if not re.search(r"""rel\s*=\s*["']?stylesheet""", tag, re.I):
                return tag
            href = HREF_ATTR.search(tag)
            if not href:
                return tag
            found = self.local(href.group(3))
            if not found:
                self.note_external(href.group(3), "글꼴·스타일")
                return tag
            css = self.inline_css_urls(read_text(found[1]), posixpath.dirname(found[0]))
            return f"<style>{css}</style>"

        def media(match):
            tag = match.group(0)
            if re.search(r"\bsrcset\s*=", tag, re.I):
                self.warnings.append(f"srcset은 포함되지 않습니다: {tag[:80]}")

            def replace(m):
                found = self.local(m.group(3))
                if found:
                    return f'{m.group(1)}"{self.data_uri(found[1], found[0])}"'
                self.note_external(m.group(3), "이미지·미디어")
                if not m.group(3).strip().lower().startswith(("data:", "#")) and not EXTERNAL_RE.match(m.group(3)):
                    self.warnings.append(f"파일을 찾지 못했습니다: {m.group(3)}")
                return m.group(0)
            return SRC_ATTR.sub(replace, tag, count=1)

        def style_block(match):
            return match.group(1) + self.inline_css_urls(match.group(2), self.base) + match.group(3)

        def markup(part):
            part = LINK_RE.sub(link, part)
            part = IMG_RE.sub(media, part)
            part = STYLE_BLOCK.sub(style_block, part)
            return re.sub(
                r"""(<[a-z][^<>]*?\bstyle\s*=\s*)(["'])(.*?)\2""",
                lambda m: m.group(1) + m.group(2) + self.inline_css_urls_attr(m.group(3)) + m.group(2),
                part, flags=re.I | re.S,
            )

        # Script contents hold text like "<img" in strings, so only the markup between them is rewritten.
        pieces = ANY_SCRIPT_RE.split(html)
        for i, piece in enumerate(pieces):
            pieces[i] = SCRIPT_RE.sub(script, piece) if i % 2 else markup(piece)
        return "".join(pieces)

    def inline_css_urls_attr(self, value):
        def replace(match):
            found = self.local(match.group(2).replace("&quot;", ""))
            if found:
                return f"url({self.data_uri(found[1], found[0])})"
            return match.group(0)
        return URL_FN.sub(replace, value)


def build_viewer(project, page):
    """Create 공유/<page>-보기용.html. Returns (path, warnings)."""
    src = project.resolved_file(page)
    inliner = Inliner(project, page)
    html = inliner.run(read_text(src))
    edits = project.load_edits(page)
    if has_edits(edits):
        for key, value in list(edits["images"].items()):
            if value.startswith("upload:"):
                full = project.upload_file(value[7:])
                if os.path.isfile(full):
                    edits["images"][key] = inliner.data_uri(full)
                else:
                    inliner.warnings.append(f"넣은 이미지를 찾지 못했습니다: {value[7:]}")
        html = inject_head(html, edits_snippet(edits, "") + f"<script>{apply_source()}</script>")
    stem = re.sub(r"\.html?$", "", posixpath.basename(page), flags=re.I)
    out = project.path(SHARE_DIR, f"{stem}-보기용.html")
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
이 프로그램은 내 컴퓨터 안에서만 동작합니다.
"""


def build_zip(project):
    """Create 공유/<project>-편집용.zip with the editor bundled."""
    build_results(project)
    out = project.path(SHARE_DIR, f"{project.name}-편집용.zip")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    top = project.name

    def add_file(z, full, arc, mode=0o644):
        info = zipfile.ZipInfo.from_file(full, nfc(f"{top}/{arc}"))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100000 | mode) << 16
        with open(full, "rb") as f:
            z.writestr(info, f.read())

    def add_text(z, arc, text, mode=0o644):
        info = zipfile.ZipInfo(nfc(f"{top}/{arc}"), date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100000 | mode) << 16
        z.writestr(info, text.encode("utf-8"))

    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out), prefix=".bc-", suffix=".tmp")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in project.walk_files():
            add_file(z, project.path(*rel.split("/")), rel)
        for folder in (EDITS_DIR, RESULT_DIR):
            for base, _, files in os.walk(project.path(folder)):
                for name in sorted(files):
                    if name in SKIP_FILES or name.endswith(".tmp"):
                        continue
                    full = os.path.join(base, name)
                    add_file(z, full, os.path.relpath(full, project.root).replace(os.sep, "/"))
        add_file(z, os.path.join(APP_DIR, "beavercoat.py"), f"{BUNDLED_APP_DIR}/beavercoat.py")
        for name in sorted(APP_FILES):
            add_file(z, os.path.join(APP_DIR, name), f"{BUNDLED_APP_DIR}/{name}")
        for name, (text, mode) in launcher_files().items():
            add_text(z, name, text, mode)
        add_text(z, "사용법.txt", README_FOR_RECIPIENT)
    os.chmod(tmp, 0o644)
    os.replace(tmp, out)
    return out


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
            edits = self.project.load_edits(rel)
            snippet = edits_snippet(edits, f"/{EDITS_DIR}/uploads/") + '<script src="/__bc/apply.js"></script>'
            return self._send(200, inject_head(html, snippet).encode("utf-8"), "text/html; charset=utf-8")
        if rel.lower().endswith(".svg") and "bc-original" not in query:
            resolved = self.project.resolved_file(rel)
            if os.path.isfile(resolved):
                return self._serve_file(resolved, "image/svg+xml", sandbox=resolved != full)
        super().do_GET()

    def _app_get(self, name, query):
        if name in APP_FILES:
            types = {"html": "text/html", "js": "text/javascript"}
            return self._serve_file(os.path.join(APP_DIR, name), types[name.rsplit(".", 1)[1]] + "; charset=utf-8")
        if name == "state":
            pages = self.project.pages()
            page = query.get("page", [self.project.default_page()])[0]
            if page not in pages:
                return self._json(404, {"error": "page not found", "pages": pages})
            return self._json(200, {"project": self.project.name, "pages": pages, "page": page, "edits": self.project.load_edits(page)})
        return self.send_error(404, "Not found")

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if not self._post_ok():
            return self.send_error(403, "Forbidden")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.send_error(411, "Length required")
        limit = MAX_UPLOAD_BYTES if url.path == "/__bc/upload" else MAX_SAVE_BYTES
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
        except OSError as e:
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
        for rel, text in svgs.items():
            full = self.project.safe_path(rel)
            if full is None or not rel.lower().endswith(".svg") or not os.path.isfile(full):
                return self._json(400, {"error": f"unknown svg: {rel}"})
            rel = posixpath.normpath(rel).lstrip("/")
            if rel.split("/")[0] in RESERVED:
                return self._json(400, {"error": f"unknown svg: {rel}"})
            if text is not None:
                try:
                    root = ET.fromstring(text.encode("utf-8"))
                except (ET.ParseError, AttributeError):
                    return self._json(400, {"error": f"invalid svg: {rel}"})
                if not root.tag.endswith("svg"):
                    return self._json(400, {"error": f"invalid svg: {rel}"})
            planned.append((rel, text))
        write_atomic(self.project.edits_file(page), json.dumps(edits, ensure_ascii=False, indent=1).encode("utf-8"))
        for rel, text in planned:
            override = self.project.svg_override(rel)
            if text is None:
                if os.path.exists(override):
                    os.unlink(override)
            else:
                write_atomic(override, text.encode("utf-8"))
        build_results(self.project)
        self._json(200, {"ok": True, "results": RESULT_DIR})

    def _upload(self, body, query):
        ext = query.get("ext", [""])[0].lower()
        if ext not in IMAGE_EXTS:
            return self._json(400, {"error": "unsupported image type"})
        name = f"{hashlib.sha256(body).hexdigest()[:16]}.{ext}"
        write_atomic(self.project.upload_file(name), body)
        self._json(200, {"value": f"upload:{name}"})

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
            out, warnings = build_zip(self.project), []
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
    page = args.page or project.default_page()
    if page is None:
        sys.exit("이 폴더에서 HTML 파일을 찾지 못했습니다.")
    if page not in project.pages():
        sys.exit(f"페이지를 찾지 못했습니다: {page}")

    if args.build:
        print(build_results(project))
        return
    if args.export == "viewer":
        out, warnings = build_viewer(project, page)
        print(out)
        for w in warnings:
            print("주의:", w)
        return
    if args.export == "zip":
        print(build_zip(project))
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
