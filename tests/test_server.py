"""Server and export tests. Standard library only: python3 -m unittest discover tests"""
import http.client
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
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
        self.assertNotIn('src="./assets/mark.svg"', html)
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
        out = bc.build_zip(self.project)
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


if __name__ == "__main__":
    unittest.main()
