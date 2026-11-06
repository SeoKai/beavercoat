# 🦫 beavercoat

A Photoshop-style visual editor for HTML prototypes. Open a design-tool export or any HTML page, drag things around, then share the result. **Your original files are never changed**: edits sit on top, like a coat.

[한국어 안내](README.ko.md)

## What you can do

- **Move, resize and rotate** anything on the page
- **Edit text** in place, with size, weight, color and spacing
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

## Re-exporting from your design tool

Replace the HTML whenever you like. Each edit finds its element again by id, then by its content and surroundings. If a match isn't certain, the edit is **not applied** and is listed so you can reconnect it with a click. A skipped edit is easy to spot, while one on the wrong element is not.

Matching can still fail or, rarely, go wrong on near-identical repeated elements, so look over the result after a re-export. Giving important elements an id in your design tool makes matching exact, if your tool keeps ids on export.

## Limits

- No pixel editing such as brushes or background removal. Use Photoshop, then drop the image in.
- Page elements can be hidden but not deleted or reordered. Shapes in an opened SVG can.
- Arc commands in SVG paths can't be edited point by point.
- For HTML prototypes only. Edits are not written into React, Vue or other source code.
- The server only listens on your own computer (127.0.0.1) and serves the project folder to your browser.

## Development

```bash
python3 -m unittest discover tests
```

Windows steps to verify by hand are in [docs/windows-checklist.md](docs/windows-checklist.md).
