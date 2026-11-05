---
name: beavercoat
description: Open an HTML prototype or design-tool export in a Photoshop-style visual editor without changing the original files, then create shareable copies. Use when someone wants to edit a mockup, HTML page or SVG visually, move or restyle elements, swap photos, add gradients, or send a prototype to someone. Also for "beavercoat", "시안 편집", "프로토타입 수정", "편집기로 열어 줘", "보기용으로 내보내 줘". Not for React, Vue or other application source code.
---

# beavercoat

A visual editor for HTML prototypes. Originals stay untouched:

- `.design-edits/`: saved edits, inside the project folder
- `결과/`: a copy with edits applied, rebuilt on every save
- `공유/`: files to send to someone

The app lives in `app/` beside this file. It needs Python 3 and nothing else.

## Open the editor

Run in the background, because it keeps serving until stopped. Use the folder the user means, or the current one:

```bash
python3 "<this skill's base directory>/app/beavercoat.py" "<project folder>"
```

Add `--page path/to/page.html` if the user names a page. The command prints the URL and opens the browser; the port is chosen automatically from 8765 upward. Tell the user the URL in case the browser didn't open. Add `--no-open` only when you will open the URL yourself.

If the folder has no HTML file, the command says so. Ask which folder they meant.

## Share

Use the buttons in the editor, or without opening it:

```bash
python3 "<base directory>/app/beavercoat.py" "<project folder>" --export viewer --page page.html
python3 "<base directory>/app/beavercoat.py" "<project folder>" --export zip
```

- `viewer` makes `공유/<page>-보기용.html`, one file that opens by double-click with no server or Python. Pass on any `주의:` lines it prints: those resources stay online or may be missing.
- `zip` makes `공유/<project>-편집용.zip` with the editor bundled. Recipients unzip it and double-click `편집기 열기`. They need Python 3 but not this skill.

Saved edits are what gets exported. Unsaved changes in an open editor are not, so ask the user to save first if an editor is open. The editor's own export buttons save automatically.

Don't send or upload these files anywhere yourself. Say where they are and let the user send them.

## After the page is re-exported

Replacing the HTML is safe: edits live apart from it. On the next load, each edit finds its element by id, then by its content and surroundings. An edit that can't be matched with confidence is not applied, and the editor lists it under "다시 연결할 편집" so the user can click the right element or delete the edit. Suggest checking the result by eye after a re-export, especially repeated cards.

## Limits to mention when relevant

- Pixel editing such as brushes and background removal belongs in Photoshop. Export there and drop the image into the editor.
- Page elements can be hidden but not deleted or reordered. Shapes inside an opened SVG can.
- Arc commands in SVG paths can't be edited point by point.
- Edits are not written into application source code. This tool is for HTML prototypes.
