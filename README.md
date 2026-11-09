# 🦫 beavercoat

A Photoshop-style visual editor for HTML prototypes. Open a design-tool export or any HTML page, drag things around, then share the result. **Your original files are never changed**: edits sit on top, like a coat.

[한국어 안내](README.ko.md)

## What you can do

- **Move, resize and rotate** anything on the page. Shift-click to move and align several at once
- **Align** to the selection, the page or a key box. After selecting several, click one once more to make it the key box, which stays still
- **Edit text** in place, with size, weight, color, spacing and paragraph alignment (left, center, right)
- **Text boxes**: dragging a handle changes the width and the lines rewrap. If you shrink the height and text overflows, a red border and `+` show it
- **Draw gradients** by dragging, with handles to adjust them
- **Adjust** brightness, contrast, saturation, blur and shadows, like adjustment layers
- **Swap photos** by dropping a file onto an image or empty box, then crop
- **Edit SVGs shape by shape**: double-click to open, drag points and curve handles, draw with pen and shape tools
- **Tune by screen size**: change something for mobile only and leave desktop alone
- **Layers, undo history and before/after compare**
- **Share** as one HTML file that opens by double-click, or as a zip with the editor included

## Install

You need [Python 3](https://www.python.org/downloads/). There is nothing else to install. Chrome or Edge is recommended.

**With Claude Code**, as a plugin:

```
/plugin marketplace add SeoKai/beavercoat
/plugin install beavercoat@beavercoat
```

Then ask Claude "open this folder in beavercoat" or run `/beavercoat`.

**Without Claude**, clone the repository and run the app directly:

```bash
git clone https://github.com/SeoKai/beavercoat.git
python3 beavercoat/skills/beavercoat/app/beavercoat.py path/to/your/prototype
```

Try it on the included sample:

```bash
python3 skills/beavercoat/app/beavercoat.py samples/basic
```

## How files are kept

| Folder | What's in it |
|---|---|
| your files | Never modified |
| `.design-edits/` | Your saved edits |
| `결과/` | A copy with edits applied, rebuilt on every save |
| `공유/` | Files you exported to send |

If the project already has its own `결과/` or `공유/` folder, it is left alone and `결과-beavercoat/` or `공유-beavercoat/` is used instead. Hidden files such as `.env`, key files, and links pointing outside the project stay out of results and zips, and you are told which were left out.

## Sharing

- **보기용 내보내기 (view-only):** one HTML file. It opens by double-click with no server or Python. Web fonts and files hosted elsewhere still need internet, and the editor lists them when you export.
- **편집용 압축 (editable):** a zip with the editor inside. Recipients unzip it and double-click `편집기 열기`. They need Python 3 but not Claude.

## Fonts

Pick a font in the text tool (T). Fonts marked `↓` are fetched and applied with one click, then stay in `~/.beavercoat/fonts/` so other projects don't fetch them again. This is the only time the internet is used.

- **Listed fonts:** Pretendard, Noto Sans KR, Nanum Gothic, IBM Plex Sans KR, Noto Serif KR, Nanum Myeongjo, Inter, Roboto, Montserrat, Poppins and Playfair Display. All are OFL-licensed, pinned to a version, and checked by hash.
- **내 글꼴 올리기 (add your own):** ttf, otf, woff or woff2, for fonts such as Adobe's that can't be listed. Check that the license lets you share it.
- **Exports:** only the fonts a page actually uses go into results, view-only files and zips. A Korean font adds about 1–2 MB.
- **Coverage:** the listed Korean fonts hold the 2,350 common syllables. Other characters and some symbols may show in a different font.

## Re-exporting from your design tool

Replace the HTML whenever you like. Each edit finds its element again by id, then by its content and surroundings. If a match isn't certain, the edit is **not applied** and is listed so you can reconnect it with a click. A skipped edit is easy to spot, while one on the wrong element is not.

Matching can still fail or, rarely, go wrong on near-identical repeated elements, so look over the result after a re-export. Giving important elements an id in your design tool makes matching exact, if your tool keeps ids on export.

## Limits

- No pixel editing such as brushes or background removal. Use Photoshop, then drop the image in.
- Page elements can be hidden but not deleted or reordered. Shapes in an opened SVG can.
- Arc commands in SVG paths can't be edited point by point.
- For HTML prototypes only. Edits are not written into React, Vue or other source code.
- Text inside an SVG can't change font.
- An empty grid cell is the parent's background, not an element, so it can't be deleted. Select the parent and lower `가로 칸 수` (columns), or fill the cell.
- Changing `가로 칸 수` for all sizes overrides the page's own mobile layout. Set mobile separately.
- Alignment is saved as a position shift on the current screen. On a screen of a different width, a centered item can drift, so set each screen size separately.
- A text box with a fixed height can clip text on narrow screens.
- The server only listens on your own computer (127.0.0.1) and serves the project folder to your browser. Only the browser goes online, and only to fetch a listed font.

## Development

```bash
python3 -m unittest discover tests
```

Windows steps to verify by hand are in [docs/windows-checklist.md](docs/windows-checklist.md).
