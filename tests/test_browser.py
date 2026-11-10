"""Runs saved edits in real headless Chrome. Skipped when Chrome isn't installed."""
import html as html_lib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "skills", "beavercoat", "app", "beavercoat.py")
# Tests read Korean folder names unless they switch language themselves.
os.environ["BEAVERCOAT_LANG"] = "ko"
spec = importlib.util.spec_from_file_location("beavercoat_b", APP)
bc = importlib.util.module_from_spec(spec)
sys.modules["beavercoat_b"] = bc
spec.loader.exec_module(bc)

CHROME = next((p for p in (
    os.environ.get("CHROME"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome"), shutil.which("chromium"), shutil.which("chrome"),
) if p and os.path.exists(p)), None)

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db00000000049454e44ae426082")


@unittest.skipUnless(CHROME, "Chrome not found")
class BrowserCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.root = os.path.join(self.dir, "site")
        os.mkdir(self.root)
        self.profile = os.path.join(self.dir, "profile")
        self.project = bc.Project(self.root)
        self.server, _ = bc.start_server(self.project, 0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def dom(self, url):
        """The page after scripts ran. A page that hangs fails here through the timeout."""
        out = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-first-run", f"--user-data-dir={self.profile}",
             "--virtual-time-budget=1500", "--dump-dom", url],
            capture_output=True, timeout=30, check=True,
        )
        return out.stdout.decode("utf-8")

    def page(self, html, name="p.html"):
        Path(self.root, name).write_text(html, encoding="utf-8")

    def capture(self, html, selector):
        """What the editor would remember about an element, read from the page as it stands."""
        script = (
            "<script>addEventListener('load',()=>{const el=document.querySelector(%s);"
            "document.documentElement.setAttribute('data-out',JSON.stringify({selector:__beavercoat.selectorFor(el),fp:__beavercoat.fingerprint(el)}))})</script>"
            % json.dumps(selector)
        )
        self.page(html.replace("</body>", script + "</body>"), "capture.html")
        found = re.search(r'data-out="([^"]*)"', self.dom(self.base + "capture.html"))
        os.unlink(os.path.join(self.root, "capture.html"))
        return json.loads(html_lib.unescape(found.group(1)))

    def edit(self, target, page="p.html", **fields):
        edits = {**bc.EMPTY_EDITS, "targets": {"t1": target}, **fields}
        path = self.project.edits_file(page)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Path(path).write_text(json.dumps(edits), encoding="utf-8")

    def bound(self, dom):
        """Text of the element the edit attached to, or None."""
        found = re.search(r'<(\w+)[^>]*data-bc-t="t1"[^>]*>(.*?)</\1>', dom, re.S)
        return found.group(2) if found else None


CARDS = """<!doctype html><html><head><title>t</title></head><body><main>
<div class="card"><h3>라테</h3><a class="btn">자세히</a></div>
<div class="card"><h3>드립</h3><a class="btn">자세히</a></div>
<div class="card"><h3>콜드브루</h3><a class="btn">자세히</a></div>
</main></body></html>"""
RED = {"t1": {"base": {"color": "red"}}}


class StopsHangingTest(BrowserCase):
    def assert_finishes(self, html, selector, lines):
        target = self.capture(html, selector)
        self.edit(target, text={"t1": lines})
        # An edit that can't be found keeps the page waiting, which is what used to turn this into a hang.
        edits = json.loads(Path(self.project.edits_file("p.html")).read_text(encoding="utf-8"))
        edits["targets"]["lost"] = {"selector": "#nope", "fp": {"tag": "section", "text": "없는 글자"}}
        edits["styles"]["lost"] = {"base": {"color": "red"}}
        Path(self.project.edits_file("p.html")).write_text(json.dumps(edits), encoding="utf-8")
        self.page(html)
        return self.dom(self.base + "p.html")

    def test_trailing_space(self):
        dom = self.assert_finishes("<!doctype html><html><body><p>글자</p><script>1</script><i>끝</i></body></html>", "p", ["끝에 공백 "])
        self.assertIn("끝에 공백 ", dom)

    def test_uppercase_transform(self):
        html = "<!doctype html><html><body><style>p{text-transform:uppercase}</style><p>word</p><script>1</script></body></html>"
        self.assertIn(">changed<", self.assert_finishes(html, "p", ["changed"]))

    def test_hidden_multiline(self):
        html = '<!doctype html><html><body><p style="display:none">a</p><script>1</script></body></html>'
        self.assertIn("줄1<br>줄2", self.assert_finishes(html, "p", ["줄1", "줄2"]))


class RepeatedElementTest(BrowserCase):
    def setUpCards(self, selector, changed):
        target = self.capture(CARDS, selector)
        self.edit(target, styles=RED)
        self.page(changed)
        return self.dom(self.base + "p.html")

    def test_unchanged_page_finds_the_same_copy(self):
        dom = self.setUpCards(".card:nth-child(2) .btn", CARDS)
        self.assertRegex(dom, r'드립</h3><a class="btn" data-bc-t="t1"')

    def test_deleted_card_leaves_edit_unattached(self):
        changed = CARDS.replace('<div class="card"><h3>라테</h3><a class="btn">자세히</a></div>\n', "")
        self.assertIsNone(self.bound(self.setUpCards(".card:nth-child(1) .btn", changed)))

    def test_only_copy_left_is_not_assumed(self):
        two = CARDS.replace('<div class="card"><h3>콜드브루</h3><a class="btn">자세히</a></div>\n', "")
        target = self.capture(two, ".card:nth-child(1) .btn")
        self.edit(target, styles=RED)
        self.page(two.replace('<div class="card"><h3>라테</h3><a class="btn">자세히</a></div>\n', ""))
        self.assertIsNone(self.bound(self.dom(self.base + "p.html")))

    def test_card_above_deleted_still_finds_its_own(self):
        changed = CARDS.replace('<div class="card"><h3>라테</h3><a class="btn">자세히</a></div>\n', "")
        self.assertRegex(self.setUpCards(".card:nth-child(2) .btn", changed), r'드립</h3><a class="btn" data-bc-t="t1"')

    def test_swapped_cards_follow_their_title(self):
        changed = CARDS.replace("라테", "@").replace("드립", "라테").replace("@", "드립")
        self.assertRegex(self.setUpCards(".card:nth-child(2) .btn", changed), r'드립</h3><a class="btn" data-bc-t="t1"')

    def test_copy_arriving_later_in_the_page_is_not_mixed_up(self):
        Path(self.root, "slow.js").write_text("window.x=1", encoding="utf-8")
        html = '<!doctype html><html><body><div><a class="b">자세히</a><script src="slow.js"></script><a class="b">자세히</a></div></body></html>'
        self.edit(self.capture(html, "a:last-of-type"), styles=RED)
        # capture() adds one script to the body, so the page keeps the same number of children.
        self.page(html.replace("</body>", "<script></script></body>"))
        self.assertRegex(self.dom(self.base + "p.html"), r'<script src="slow.js"></script><a class="b" data-bc-t="t1"')

    def test_unique_text_still_moves_with_the_element(self):
        html = '<!doctype html><html><body><div><p>고유한 글</p></div><div>옆</div></body></html>'
        target = self.capture(html, "p")
        self.edit(target, styles=RED)
        self.page('<!doctype html><html><body><section><div>새 내용</div><p>고유한 글</p></section></body></html>')
        self.assertEqual(self.bound(self.dom(self.base + "p.html")), "고유한 글")


class StylePriorityTest(BrowserCase):
    def test_edit_beats_important_rule_with_an_id(self):
        html = '<!doctype html><html><head><style>#x{color:blue!important}</style></head><body><p id="x">글</p></body></html>'
        self.edit(self.capture(html, "p"), styles=RED)
        self.page(html.replace("</body>", "<script>addEventListener('load',()=>{document.title=getComputedStyle(document.getElementById('x')).color})</script></body>"))
        self.assertIn("<title>rgb(255, 0, 0)</title>", self.dom(self.base + "p.html"))

    def test_unusual_tag_name_does_not_throw(self):
        html = '<!doctype html><html><body><o:p>글자</o:p><p>다른 글</p></body></html>'
        self.page(html)
        self.edit({"selector": "p", "fp": {"tag": "o:p", "text": "글자", "cls": "", "path": "o:p"}}, styles=RED)
        self.assertIn('data-bc-t="t1">글자<', self.dom(self.base + "p.html"))


class ImageTest(BrowserCase):
    def setUp(self):
        super().setUp()
        for name in ("a.png", "b.png", "new.png"):
            Path(self.root, name).write_bytes(PNG)

    def test_srcset_and_picture_stop_winning(self):
        html = '<!doctype html><html><body><picture><source srcset="b.png"><img src="a.png" srcset="b.png 2x"></picture></body></html>'
        self.page(html)
        self.edit(self.capture(html, "img"), images={"t1": "new.png"})
        self.page(html)
        dom = self.dom(self.base + "p.html")
        self.assertIn('src="new.png"', dom)
        self.assertNotIn("srcset", dom)

    def test_viewer_keeps_image_edit(self):
        html = '<!doctype html><html><body><div><img src="a.png"></div><div><h1 id=x>제목</h1></div></body></html>'
        target = self.capture(html, "img")
        # A different neighbor would refuse a same-spot match, so only the file name can find it.
        self.edit(target, images={"t1": "data:image/png;base64,TkVX"})
        self.page(html.replace("<div><h1", "<div><span>추가</span></div><div><h1"))
        out, _ = bc.build_viewer(self.project, "p.html")
        self.assertRegex(self.dom(Path(out).as_uri()), r'<img src="data:image/png;base64,TkVX"')


class ResultFileTest(BrowserCase):
    def test_euc_kr_result_opens_correctly_from_disk(self):
        Path(self.root, "p.html").write_bytes('<!doctype html><html><head><meta charset="euc-kr"></head><body><h1>천천히</h1></body></html>'.encode("euc-kr"))
        self.edit({"selector": "h1", "fp": {"tag": "h1", "text": "천천히", "path": "h1", "cls": ""}}, styles=RED)
        out, _ = bc.build_results(self.project)
        self.assertIn('data-bc-t="t1">천천히<', self.dom(Path(out, "p.html").as_uri()))

    def test_page_without_head_keeps_standards_mode(self):
        self.page("<!doctype html><p>글</p>")
        self.edit({"selector": "p", "fp": {"tag": "p", "text": "글", "path": "p", "cls": ""}}, styles=RED)
        out, _ = bc.build_results(self.project)
        Path(out, "check.html").write_text(Path(out, "p.html").read_text(encoding="utf-8") + "<script>document.title=document.compatMode</script>", encoding="utf-8")
        self.assertIn("<title>CSS1Compat</title>", self.dom(Path(out, "check.html").as_uri()))


class FontFaceTest(BrowserCase):
    def font_status(self, fonts):
        """What the page's fonts look like after apply.js ran."""
        self.page('<!doctype html><html><head></head><body><h1>글</h1><script>document.addEventListener("DOMContentLoaded",()=>{'
                  'document.title=[...document.fonts].map(f=>f.family).join("|")||"none"})</script></body></html>')
        self.edit({"selector": "h1", "fp": {"tag": "h1", "text": "글", "path": "h1", "cls": ""}},
                  styles={"t1": {"base": {"font-family": '"Good", serif'}}}, fonts=fonts)
        return self.dom(self.base + "p.html")

    def test_font_face_is_added_for_a_valid_font(self):
        dom = self.font_status({"Good": [{"src": "upload:a1.woff2", "format": "woff2", "weight": "400", "range": ""}]})
        self.assertIn('font-family: "Good"', dom)
        self.assertIn("/a1.woff2", dom)

    def test_font_rules_stay_apart_from_edit_rules(self):
        dom = self.font_status({"Good": [{"src": "upload:a1.woff2", "format": "woff2", "weight": "400", "range": ""}]})
        edits_css = re.search(r"<style data-bc-styles[^>]*>(.*?)</style>", dom, re.S).group(1)
        self.assertNotIn("@font-face", edits_css)

    def test_received_file_cannot_add_rules_through_font_fields(self):
        dom = self.font_status({
            'x"}body{display:none}': [{"src": "upload:a.woff2", "format": "woff2"}],
            "Bad": [
                {"src": 'upload:a"){}body{display:none}', "format": "woff2"},
                {"src": "https://evil.test/track.woff2", "format": "woff2"},
                {"src": "upload:ok.woff2", "format": "woff2\"){}body{display:none}"},
                {"src": "upload:ok.woff2", "format": "woff2", "weight": "400;}body{display:none}", "range": "U+0;}body{display:none}"},
            ],
        })
        css = re.search(r"<style data-bc-fonts[^>]*>(.*?)</style>", dom, re.S).group(1)
        self.assertNotIn("display:none", css)
        self.assertNotIn("evil.test", css)
        self.assertEqual(css.count("@font-face"), 1)


if __name__ == "__main__":
    unittest.main()
