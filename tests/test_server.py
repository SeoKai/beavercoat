"""Server and export tests. Standard library only: python3 -m unittest discover tests"""
import base64
import http.client
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import unicodedata
import unittest
import zipfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "skills", "beavercoat", "app", "beavercoat.py")
spec = importlib.util.spec_from_file_location("beavercoat", APP)
bc = importlib.util.module_from_spec(spec)
sys.modules["beavercoat"] = bc
spec.loader.exec_module(bc)

SVG_EDIT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><circle r="1"/></svg>'
EDITS = {
    "version": 2,
    "targets": {"t1": {"selector": "h1", "fp": {"tag": "h1", "text": "천천히"}}},
    "styles": {"t1": {"base": {"color": "red"}}},
    "meta": {}, "text": {"t1": ["</script><x-dc>"]}, "images": {}, "inlineSvg": {}, "breakpoints": None,
}


class ProjectCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.root = os.path.join(self.dir, "내 시안")
        shutil.copytree(os.path.join(ROOT, "samples", "basic"), self.root)
        self.project = bc.Project(self.root)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def read(self, *parts):
        return Path(self.root, *parts).read_text(encoding="utf-8")


class ServerTest(ProjectCase):
    def setUp(self):
        super().setUp()
        self.server, self.port = bc.start_server(self.project, 0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.host = self.origin[7:]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def request(self, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1])
        all_headers = {"Host": host or self.host, **(headers or {})}
        conn.request(method, path, body=body, headers=all_headers)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, data

    def post(self, path, payload, raw=False):
        body = payload if raw else json.dumps(payload).encode("utf-8")
        return self.request("POST", path, body, {"Origin": self.origin, "X-Beavercoat": "1"})

    def test_page_gets_edits_but_file_is_untouched(self):
        before = self.read("index.html")
        status, _ = self.post("/__bc/save", {"page": "index.html", "edits": EDITS, "svgs": {}})
        self.assertEqual(status, 200)
        status, served = self.request("GET", "/index.html")
        self.assertEqual(status, 200)
        self.assertIn(b"__BC_EDITS__", served)
        self.assertEqual(self.read("index.html"), before)

    def test_save_writes_results_and_svg_override(self):
        status, _ = self.post("/__bc/save", {"page": "index.html", "edits": EDITS, "svgs": {"assets/mark.svg": SVG_EDIT}})
        self.assertEqual(status, 200)
        self.assertIn("__BC_EDITS__", self.read("결과", "index.html"))
        self.assertNotIn("__BC_EDITS__", self.read("결과", "about.html"))
        self.assertEqual(self.read("결과", "assets", "mark.svg"), SVG_EDIT)
        self.assertNotEqual(self.read("assets", "mark.svg"), SVG_EDIT)
        _, edited = self.request("GET", "/assets/mark.svg")
        self.assertEqual(edited.decode(), SVG_EDIT)
        _, original = self.request("GET", "/assets/mark.svg?bc-original=1")
        self.assertNotEqual(original.decode(), SVG_EDIT)

    def test_removing_svg_override_restores_original_in_results(self):
        self.post("/__bc/save", {"page": "index.html", "edits": EDITS, "svgs": {"assets/mark.svg": SVG_EDIT}})
        self.post("/__bc/save", {"page": "index.html", "edits": EDITS, "svgs": {"assets/mark.svg": None}})
        self.assertEqual(self.read("결과", "assets", "mark.svg"), self.read("assets", "mark.svg"))

    def test_invalid_svg_rejected_and_nothing_written(self):
        status, _ = self.post("/__bc/save", {"page": "index.html", "edits": EDITS, "svgs": {"assets/mark.svg": "<svg><oops"}})
        self.assertEqual(status, 400)
        self.assertFalse(os.path.exists(os.path.join(self.root, ".design-edits", "pages", "index.html.json")))

    def test_save_cannot_escape_project(self):
        for rel in ("../evil.svg", "/etc/evil.svg", "결과/assets/mark.svg", "assets/nope.svg"):
            status, _ = self.post("/__bc/save", {"page": "index.html", "edits": EDITS, "svgs": {rel: SVG_EDIT}})
            self.assertEqual(status, 400, rel)
        status, _ = self.post("/__bc/save", {"page": "../x.html", "edits": EDITS, "svgs": {}})
        self.assertEqual(status, 400)

    def test_upload_accepts_images_only(self):
        status, data = self.post("/__bc/upload?ext=png", b"fake", raw=True)
        self.assertEqual(status, 200)
        name = json.loads(data)["value"][7:]
        self.assertTrue(os.path.isfile(os.path.join(self.root, ".design-edits", "uploads", name)))
        status, _ = self.post("/__bc/upload?ext=html", b"<script>", raw=True)
        self.assertEqual(status, 400)
        status, _ = self.post("/__bc/upload?ext=../../x", b"x", raw=True)
        self.assertEqual(status, 400)

    def test_other_sites_are_refused(self):
        body = json.dumps({"page": "index.html", "edits": EDITS, "svgs": {}}).encode()
        for headers in (
            {"Origin": "https://evil.example", "X-Beavercoat": "1"},
            {"Origin": self.origin},
            {"X-Beavercoat": "1"},
        ):
            status, _ = self.request("POST", "/__bc/save", body, headers)
            self.assertEqual(status, 403)
        status, _ = self.request("GET", "/index.html", host="evil.example")
        self.assertEqual(status, 403)

    def test_path_traversal_refused(self):
        status, _ = self.request("GET", "/../../../../etc/passwd")
        self.assertEqual(status, 403)

    def test_state_lists_pages_without_generated_copies(self):
        self.post("/__bc/save", {"page": "index.html", "edits": EDITS, "svgs": {}})
        _, data = self.request("GET", "/__bc/state")
        self.assertEqual(sorted(json.loads(data)["pages"]), ["about.html", "index.html"])


class ExportTest(ProjectCase):
    def test_viewer_inlines_local_files(self):
        out, warnings = bc.build_viewer(self.project, "index.html")
        html = Path(out).read_text(encoding="utf-8")
        self.assertNotIn('href="./style.css"', html)
        self.assertNotIn(' src="./assets/mark.svg"', html)
        self.assertIn("data:image/svg+xml;base64,", html)
        self.assertIn("data:image/png;base64,", html)
        self.assertEqual(warnings, [])

    def test_viewer_reports_external_files(self):
        path = os.path.join(self.root, "index.html")
        html = Path(path).read_text(encoding="utf-8").replace("</head>", '<link rel="stylesheet" href="https://fonts.example/x.css"></head>')
        Path(path).write_text(html, encoding="utf-8")
        _, warnings = bc.build_viewer(self.project, "index.html")
        self.assertTrue(any("fonts.example" in w for w in warnings))

    def test_inline_js_cannot_break_out_of_script(self):
        for bad in ("</script>", "<!-- <script>", "has no <x-dc> block", "</x-dc>"):
            escaped = bc.escape_inline_js(bad)
            for word in ("</script", "<script", "<!--", "<x-dc", "</x-dc"):
                self.assertNotIn(word, escaped)
        self.assertEqual(bc.escape_inline_js("a<b && c<d"), "a<b && c<d")
        self.assertNotIn("<", bc.script_json(["</script><x-dc>"]))

    def test_code_in_scripts_is_not_rewritten_as_markup(self):
        path = os.path.join(self.root, "index.html")
        code = """<script>var s='<img src="./assets/mark.svg">';</script>"""
        html = Path(path).read_text(encoding="utf-8").replace("</head>", code + "</head>")
        Path(path).write_text(html, encoding="utf-8")
        out, _ = bc.build_viewer(self.project, "index.html")
        self.assertIn("""var s='<img src="./assets/mark.svg">'""", Path(out).read_text(encoding="utf-8"))

    def test_zip_is_self_contained_with_korean_names(self):
        out, _ = bc.build_zip(self.project)
        with zipfile.ZipFile(out) as z:
            names = z.namelist()
            self.assertIsNone(z.testzip())
            info = {i.filename: i for i in z.infolist()}
        top = "내 시안/"
        for name in (".beavercoat/beavercoat.py", ".beavercoat/editor.js", ".beavercoat/apply.js", "index.html", "사용법.txt", "편집기 열기.bat", "편집기 열기.command", "결과/index.html"):
            self.assertIn(top + name, names)
        self.assertFalse(any("공유/" in n for n in names))
        self.assertEqual((info[top + "편집기 열기.command"].external_attr >> 16) & 0o777, 0o755)

    def test_generated_folders_are_not_treated_as_source(self):
        bc.build_results(self.project)
        bc.build_results(self.project)
        self.assertFalse(os.path.exists(os.path.join(self.root, "결과", "결과")))
        self.assertEqual(sorted(self.project.pages()), ["about.html", "index.html"])

    def test_removed_source_file_disappears_from_results(self):
        bc.build_results(self.project)
        os.remove(os.path.join(self.root, "about.html"))
        bc.build_results(self.project)
        self.assertFalse(os.path.exists(os.path.join(self.root, "결과", "about.html")))


class OutputFolderTest(ProjectCase):
    def write(self, rel, data=b"x"):
        full = os.path.join(self.root, *rel.split("/"))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        Path(full).write_bytes(data)
        return full

    def test_users_own_result_folder_is_never_deleted(self):
        mine = self.write("결과/내 메모.txt", b"keep")
        out, _ = bc.build_results(self.project)
        self.assertEqual(Path(mine).read_bytes(), b"keep")
        self.assertEqual(os.path.basename(out), "결과-beavercoat")
        self.assertTrue(os.path.isfile(os.path.join(out, "index.html")))
        # The user's folder is ordinary project content, and the choice stays stable.
        self.assertTrue(os.path.isfile(os.path.join(out, "결과", "내 메모.txt")))
        out2, _ = bc.build_results(self.project)
        self.assertEqual(out, out2)
        self.assertFalse(os.path.exists(os.path.join(out, "결과-beavercoat")))

    def test_files_added_to_generated_folder_are_kept(self):
        out, _ = bc.build_results(self.project)
        added = os.path.join(out, "내가 넣은 파일.txt")
        Path(added).write_text("keep", encoding="utf-8")
        bc.build_results(self.project)
        self.assertTrue(os.path.isfile(added))

    def test_tampered_manifest_cannot_delete_outside(self):
        out, _ = bc.build_results(self.project)
        victim = os.path.join(self.dir, "victim.txt")
        Path(victim).write_text("keep", encoding="utf-8")
        Path(out, bc.OUTPUT_MARKER).write_text(json.dumps({"files": ["../../victim.txt", "/etc/nope"]}), encoding="utf-8")
        bc.build_results(self.project)
        self.assertTrue(os.path.isfile(victim))

    def test_svg_reset_restores_result_even_with_same_size_and_older_time(self):
        original = Path(self.root, "assets", "mark.svg").read_bytes()
        same_size = original.replace(b"#C98A4B", b"#000000")
        override = self.project.svg_override("assets/mark.svg")
        os.makedirs(os.path.dirname(override))
        Path(override).write_bytes(same_size)
        bc.build_results(self.project)
        os.unlink(override)
        os.utime(os.path.join(self.root, "assets", "mark.svg"), (1000000000, 1000000000))
        bc.build_results(self.project)
        self.assertEqual(Path(self.root, "결과", "assets", "mark.svg").read_bytes(), original)

    def test_reserved_names_only_apply_at_the_top(self):
        self.write("assets/공유/icon.png")
        self.write("docs/결과/report.html", b"<p>r</p>")
        bc.build_results(self.project)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "결과", "assets", "공유", "icon.png")))
        self.assertTrue(os.path.isfile(os.path.join(self.root, "결과", "docs", "결과", "report.html")))
        self.assertIn("docs/결과/report.html", self.project.pages())

    def test_decomposed_folder_name_is_still_generated(self):
        # A zip unpacked on a Mac can leave the folder name in decomposed form.
        decomposed = unicodedata.normalize("NFD", "결과")
        os.mkdir(os.path.join(self.root, decomposed))
        bc.build_results(self.project)
        bc.build_results(self.project)
        nested = [d for d, _, _ in os.walk(self.root) if unicodedata.normalize("NFC", d).count("결과") > 1]
        self.assertEqual(nested, [])

    @unittest.skipUnless(os.name == "posix", "needs symlinks and file modes")
    def test_one_bad_file_does_not_stop_the_build(self):
        os.symlink("/nonexistent/file.png", os.path.join(self.root, "broken.png"))
        unreadable = self.write("secret.bin")
        os.chmod(unreadable, 0)
        try:
            out, skipped = bc.build_results(self.project)
            self.assertTrue(os.path.isfile(os.path.join(out, "index.html")))
            self.assertTrue(any("broken.png" in s for s in skipped))
            if os.geteuid() != 0:
                self.assertTrue(any("secret.bin" in s for s in skipped))
        finally:
            os.chmod(unreadable, 0o644)

    @unittest.skipUnless(os.name == "posix", "needs symlinks and file modes")
    def test_read_only_source_can_be_rebuilt_after_change(self):
        path = self.write("asset.txt", b"one")
        os.chmod(path, 0o444)
        bc.build_results(self.project)
        os.chmod(path, 0o644)
        Path(path).write_bytes(b"two")
        os.chmod(path, 0o444)
        _, skipped = bc.build_results(self.project)
        self.assertEqual(skipped, [])
        self.assertEqual(Path(self.root, "결과", "asset.txt").read_bytes(), b"two")

    def test_file_becoming_folder_and_back(self):
        path = self.write("thing", b"file")
        bc.build_results(self.project)
        os.unlink(path)
        self.write("thing/inner.txt", b"in")
        _, skipped = bc.build_results(self.project)
        self.assertEqual(skipped, [])
        self.assertTrue(os.path.isfile(os.path.join(self.root, "결과", "thing", "inner.txt")))
        shutil.rmtree(path)
        self.write("thing", b"file")
        _, skipped = bc.build_results(self.project)
        self.assertEqual(skipped, [])
        self.assertTrue(os.path.isfile(os.path.join(self.root, "결과", "thing")))

    def test_old_file_dates_can_be_zipped_and_no_temp_left(self):
        path = self.write("old.txt")
        os.utime(path, (0, 0))
        out, _ = bc.build_zip(self.project)
        with zipfile.ZipFile(out) as z:
            self.assertIn("내 시안/old.txt", z.namelist())
        share = os.path.dirname(out)
        self.assertEqual([n for n in os.listdir(share) if n.endswith(".tmp")], [])

    @unittest.skipUnless(os.name == "posix", "needs symlinks and file modes")
    def test_private_and_outside_files_stay_out(self):
        outside = os.path.join(self.dir, "outside.txt")
        Path(outside).write_text("OUTSIDE-VALUE", encoding="utf-8")
        os.symlink(outside, os.path.join(self.root, "link.txt"))
        os.symlink(self.dir, os.path.join(self.root, "linked-folder"))
        self.write(".env", b"ENV-VALUE")
        self.write(".vscode/settings.json", b"{}")
        self.write("keys/server.pem", b"PEM-VALUE")
        Path(self.root, "inside.txt").write_text("ok", encoding="utf-8")
        os.symlink(os.path.join(self.root, "inside.txt"), os.path.join(self.root, "inner-link.txt"))
        out, skipped = bc.build_zip(self.project)
        with zipfile.ZipFile(out) as z:
            names = z.namelist()
            blob = b"".join(z.read(n) for n in names)
        for bad in (".env", "link.txt", "linked-folder", ".vscode", "server.pem"):
            self.assertFalse(any(bad in n.replace("inner-link.txt", "") for n in names), bad)
            self.assertTrue(any(bad in s for s in skipped), bad)
        for value in (b"ENV-VALUE", b"PEM-VALUE", b"OUTSIDE-VALUE"):
            self.assertNotIn(value, blob)
        self.assertIn("내 시안/inner-link.txt", names)

    def test_files_added_to_generated_folder_are_not_zipped(self):
        out, _ = bc.build_results(self.project)
        Path(out, "private-note.txt").write_text("x", encoding="utf-8")
        zip_path, _ = bc.build_zip(self.project)
        with zipfile.ZipFile(zip_path) as z:
            self.assertFalse(any("private-note" in n for n in z.namelist()))
            self.assertIn("내 시안/결과/" + bc.OUTPUT_MARKER, z.namelist())


class PageEncodingAndHeadTest(ProjectCase):
    def write_page(self, data, name="enc.html"):
        Path(self.root, name).write_bytes(data)
        return name

    def save_edits(self, page):
        path = self.project.edits_file(page)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Path(path).write_text(json.dumps(EDITS), encoding="utf-8")

    def test_euc_kr_page_is_correct_in_results_and_viewer(self):
        page = self.write_page('<!doctype html><html><head><meta charset="euc-kr"><title>제목</title></head><body><h1>천천히</h1></body></html>'.encode("euc-kr"))
        self.save_edits(page)
        bc.build_results(self.project)
        out, _ = bc.build_viewer(self.project, page)
        for html in (Path(self.root, "결과", page).read_bytes(), Path(out).read_bytes()):
            head = html[:1024].lower()
            self.assertIn(b'<meta charset="utf-8">', head)
            self.assertNotIn(b"euc-kr", html.lower().split(b"__bc_edits__")[0])
            self.assertIn("천천히", html.decode("utf-8"))

    def test_declared_encodings_are_respected(self):
        for meta, text, enc in (
            ('<meta charset="shift_jis">', "ゆっくり", "shift_jis"),
            ('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">', "café", "latin-1"),
        ):
            path = os.path.join(self.root, "x.html")
            Path(path).write_bytes(f"<html><head>{meta}</head><body>{text}</body></html>".encode(enc))
            self.assertIn(text, bc.read_text(path))

    def test_undeclared_korean_page_still_reads(self):
        path = os.path.join(self.root, "x.html")
        Path(path).write_bytes("<p>천천히</p>".encode("cp949"))
        self.assertIn("천천히", bc.read_text(path))

    def test_big_edits_do_not_push_charset_out_of_range(self):
        html = bc.page_with_snippet("<!doctype html><html><head><title>t</title></head></html>", "<script>" + "x" * 5000 + "</script>")
        self.assertIn('<meta charset="utf-8">', html[:200])

    def test_injection_ignores_head_in_comment_and_keeps_doctype_first(self):
        result = bc.inject_head("<!doctype html><!-- <head> --><html><head><title>t</title></head></html>", "<S>")
        self.assertIn("<!-- <head> -->", result)
        self.assertIn("<head><S><title>", result)
        result = bc.inject_head("<!-- note --><!doctype html><p>x</p>", "<S>")
        self.assertLess(result.lower().index("<!doctype"), result.index("<S>"))
        result = bc.inject_head("<!doctype html><html lang=ko><body>x</body></html>", "<S>")
        self.assertIn("<html lang=ko><S><body>", result)
        result = bc.inject_head("<!doctype html>\n<script>var a='<head>'</script><p>x</p>", "<S>")
        self.assertLess(result.index("<S>"), result.index("<script>"))
        self.assertEqual(bc.inject_head("<p>x</p>", "<S>"), "<S><p>x</p>")
        self.assertIn("<header>", bc.inject_head("<header>a</header>", "<S>"))


class ViewerInliningTest(ProjectCase):
    PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMK/gAAAABJRU5ErkJggg==")

    def setUp(self):
        super().setUp()
        for rel, data in {
            "a.png": self.PNG, "b.png": self.PNG, "c.png": self.PNG,
            "css/main.css": b'@import "parts/one.css";\n@import url(parts/two.css) screen and (min-width: 9px);\nbody{background:url(../a.png)}',
            "css/parts/one.css": b".one{background:url(../../b.png)}",
            "css/parts/two.css": b'.two{color:red}\n@import "../main.css";',
            "print.css": b".p{color:blue}",
            "late.js": b"window.late=1",
            "mod.js": b"import x from './other.js'; window.mod=x",
        }.items():
            full = os.path.join(self.root, *rel.split("/"))
            os.makedirs(os.path.dirname(full), exist_ok=True)
            Path(full).write_bytes(data)

    def viewer(self, body):
        Path(self.root, "t.html").write_text(f"<!doctype html><html><head><meta charset=utf-8></head><body>{body}</body></html>", encoding="utf-8")
        out, warnings = bc.build_viewer(self.project, "t.html")
        return Path(out).read_text(encoding="utf-8"), warnings

    def test_srcset_and_sizes(self):
        html, warnings = self.viewer('<img src="a.png" srcset="a.png 1x, b.png 2x"><picture><source srcset="c.png 800w, b.png 400w"><img src=a.png></picture>')
        self.assertNotRegex(re.sub(r'data-bc-src="[^"]*"', "", html), r"""["' ]\.?/?[abc]\.png""")
        self.assertEqual(warnings, [])

    def test_unquoted_attributes_and_lookalikes(self):
        html, _ = self.viewer('<img src=a.png data-src="b.png" alt="x > y"><div data-style="url(c.png)"></div><link rel=stylesheet href=print.css media=print>')
        self.assertIn('data-src="b.png"', html)
        self.assertIn('data-style="url(c.png)"', html)
        self.assertIn('alt="x > y"', html)
        self.assertRegex(html, r'<img src="data:image/png')
        self.assertIn('<style media="print">.p{color:blue}</style>', html)

    def test_greater_than_inside_attribute_before_src(self):
        html, _ = self.viewer('<img alt="a>b" src="a.png">')
        self.assertIn('alt="a>b" src="data:image/png', html)

    def test_css_imports_are_flattened_with_media_and_no_cycle(self):
        html, _ = self.viewer('<link rel="stylesheet" href="css/main.css">')
        self.assertIn(".one{background:url(\"data:image/png", html)
        self.assertIn("@media screen and (min-width: 9px)", html)
        self.assertIn(".two{color:red}", html)
        self.assertNotIn("@import", html.split("</style>")[0].split("@media")[0])

    def test_deferred_and_module_scripts(self):
        html, warnings = self.viewer('<script defer src="late.js"></script><script type="module" src="mod.js"></script>')
        self.assertRegex(html, r'<script defer src="data:text/javascript;base64,')
        self.assertIn('<script type="module">import x', html)
        self.assertTrue(any("mod.js" in w for w in warnings))

    def test_other_media_attributes(self):
        html, warnings = self.viewer('<video poster="a.png"></video><input type="image" src="b.png"><svg><image href="c.png"/><image xlink:href="a.png"/></svg>')
        self.assertNotRegex(html, r"""=["'][abc]\.png""")
        self.assertEqual(warnings, [])

    def test_inlined_image_remembers_its_name(self):
        html, _ = self.viewer('<img src="./assets/../a.png?v=2">')
        self.assertIn('data-bc-src="./assets/../a.png?v=2"', html)

    def test_comments_are_left_alone(self):
        html, warnings = self.viewer('<!-- <img src="missing.png"> -->')
        self.assertIn('<img src="missing.png">', html)
        self.assertEqual(warnings, [])

    def test_missing_files_warn(self):
        _, warnings = self.viewer('<img src="nope.png"><link rel="stylesheet" href="nope.css"><script src="nope.js"></script>')
        for name in ("nope.png", "nope.css", "nope.js"):
            self.assertTrue(any(name in w for w in warnings), name)


if __name__ == "__main__":
    unittest.main()
