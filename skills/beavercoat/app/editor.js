// beavercoat editor. Opens a project page in an iframe; edits are saved beside the page, never into it.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const frame = $("frame"), overlay = $("overlay"), canvasEl = $("canvas");
  const ctx = overlay.getContext("2d");

  const TOOLS = [
    { id: "move", icon: "➤", name: "이동·변형", key: "v", hint: "클릭: 선택 · 선택한 요소 끌기: 이동 · 손잡이: 크기·회전 (Shift: 비율·각도 고정) · 더블클릭: 글자 수정, SVG 펼치기" },
    { id: "direct", icon: "⌖", name: "점 편집", key: "a", hint: "펼친 SVG의 경로를 클릭한 뒤 점과 곡선 손잡이를 끌어 모양을 바꿉니다. Delete: 선택한 점 삭제" },
    { id: "text", icon: "T", name: "글자", key: "t", hint: "글자를 클릭해 바로 수정합니다. 바깥을 클릭하면 적용, Esc는 취소" },
    { id: "gradient", icon: "◐", name: "그라데이션", key: "g", hint: "요소 위에서 시작점부터 끝점까지 끌어 그라데이션을 넣습니다. 손잡이로 다시 조절할 수 있습니다" },
    { id: "pen", icon: "✒", name: "펜", key: "p", hint: "펼친 SVG 안에서 클릭: 직선 · 끌기: 곡선 · 첫 점 클릭: 닫기 · Enter: 끝내기 · Esc: 취소" },
    { id: "rect", icon: "▭", name: "사각형", key: "u", hint: "펼친 SVG 안에서 끌어 사각형을 그립니다" },
    { id: "ellipse", icon: "◯", name: "타원", key: "e", hint: "펼친 SVG 안에서 끌어 타원을 그립니다" },
    { id: "line", icon: "╱", name: "직선", key: "l", hint: "펼친 SVG 안에서 끌어 직선을 그립니다" },
    { id: "hand", icon: "✋", name: "손", key: "h", hint: "끌어서 화면을 옮깁니다. 스페이스를 누르고 있어도 됩니다" },
  ];
  const DEVICES = { desktop: 1440, tablet: 768, mobile: 375 };
  const SCOPES = ["base", "tablet", "mobile"];
  const COMPILED = ["translate", "rotate", "scale", "filter", "background-image", "mask-image", "-webkit-mask-image", "clip-path", "display"];
  const MOVABLE_INLINE = new Set(["IMG", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "OBJECT", "EMBED", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "METER", "PROGRESS"]);
  const SKIP_LAYER = new Set(["STYLE", "SCRIPT", "BR", "LINK", "META", "TITLE", "NOSCRIPT", "TEMPLATE", "HELMET", "title", "defs", "linearGradient", "radialGradient", "stop", "desc", "metadata", "style", "clipPath", "mask"]);
  const SHAPE_NAMES = { path: "경로", circle: "원", ellipse: "타원", rect: "사각형", line: "직선", text: "글자", g: "그룹", polygon: "다각형", polyline: "꺾은선", use: "복제 도형", image: "이미지" };
  const BLEND = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];
  const ADJUST = [
    ["brightness", "밝기", 0, 200, 100, "%"], ["contrast", "대비", 0, 200, 100, "%"], ["saturate", "채도", 0, 200, 100, "%"],
    ["hue-rotate", "색조", -180, 180, 0, "deg"], ["blur", "흐림", 0, 40, 0, "px"], ["grayscale", "흑백", 0, 100, 0, "%"],
    ["sepia", "세피아", 0, 100, 0, "%"], ["invert", "반전", 0, 100, 0, "%"],
  ];
  const LABELS = { tx: "위치", ty: "위치", rot: "회전", sx: "크기", sy: "크기", adj: "보정", shadow: "그림자", grad: "그라데이션", crop: "자르기", opacity: "불투명도", "mix-blend-mode": "혼합 모드", "background-color": "배경색", "border-radius": "모서리", "border-width": "테두리", "border-style": "테두리", "border-color": "테두리색", padding: "여백", "font-size": "글자 크기", "font-weight": "굵기", color: "글자색", "letter-spacing": "자간", "line-height": "행간", "text-align": "정렬", visibility: "보이기" };

  let win = null, doc = null, bc = null;
  let E = emptyEdits();
  const S = {
    page: null, project: "", pages: [], tool: "move", zoom: 1, device: "desktop", onlyHere: false, panX: 0,
    sel: null, key: null, hover: null, hits: [], drag: null, pen: null, anchor: null,
    history: [], idx: -1, savedIdx: -1, lastLabel: null, lastTime: 0, lastGroup: null, groupCounter: 0,
    paint: "fill", expanded: new WeakSet(), spaceHand: false, comparing: false, editing: null,
    uploadTarget: null, ready: false, relinking: null, svgs: [], importRoot: null, targetLog: {},
  };

  function emptyEdits() {
    return { version: 2, targets: {}, styles: {}, meta: {}, text: {}, images: {}, inlineSvg: {}, breakpoints: null };
  }
  const round = (n, d = 2) => Number(Number(n).toFixed(d));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const isSvgChild = (el) => !!(el && el.ownerSVGElement);
  const isSvgRoot = (el) => !!(el && el.tagName && el.tagName.toLowerCase() === "svg" && !el.ownerSVGElement);
  const isOpen = (el) => isSvgRoot(el) && el.hasAttribute("data-bc-open");
  const svgRecord = (root) => S.svgs.find((r) => r.root === root);

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children) if (c != null) el.append(c);
    return el;
  }

  function say(text, isError) {
    const m = $("msg");
    m.textContent = text;
    m.classList.toggle("err", !!isError);
    clearTimeout(say.t);
    if (!isError) say.t = setTimeout(() => (m.textContent = ""), 5000);
  }

  // ---------- names ----------
  function nameOf(el) {
    if (isSvgRoot(el)) return "SVG" + (isOpen(el) ? " (펼침)" : "");
    if (isSvgChild(el)) {
      const base = el.getAttribute("data-name") || SHAPE_NAMES[el.tagName] || el.tagName;
      return el.tagName === "text" ? `${base}: ${el.textContent.trim().slice(0, 10)}` : base;
    }
    if (el.tagName === "IMG") return "이미지: " + (el.alt || (el.getAttribute("src") || "").split("/").pop().split("?")[0]).slice(0, 18);
    const text = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 20);
    const names = { HEADER: "상단 메뉴", FOOTER: "하단 영역", SECTION: "섹션", MAIN: "본문", NAV: "메뉴", H1: "제목", H2: "제목", H3: "소제목", H4: "소제목", P: "글", A: "링크", BUTTON: "버튼", UL: "목록", OL: "목록", LI: "항목", FIGURE: "그림 영역", DETAILS: "접기 영역", SPAN: "글" };
    return (names[el.tagName] || "묶음") + (text ? ": " + text : "");
  }

  const kids = (el) => {
    if (isSvgRoot(el) && !isOpen(el)) return [];
    return [...el.children].filter((c) => !SKIP_LAYER.has(c.tagName));
  };

  // The text as written. innerText alone would give "WORD" for "word" shown with text-transform.
  function plainText(el) {
    const value = el.style.getPropertyValue("text-transform");
    const priority = el.style.getPropertyPriority("text-transform");
    el.style.setProperty("text-transform", "none", "important");
    const text = el.innerText.replace(/\n$/, "");
    if (value) el.style.setProperty("text-transform", value, priority);
    else el.style.removeProperty("text-transform");
    if (el.getAttribute("style") === "") el.removeAttribute("style");
    return text;
  }

  function isTextLeaf(el) {
    if (!el || isSvgChild(el) || isSvgRoot(el) || el.tagName === "IMG") return false;
    if (![...el.childNodes].every((n) => n.nodeType === 3 || n.nodeName === "BR")) return false;
    return !!el.textContent.trim();
  }

  // ---------- targets ----------
  function ensureTarget(el) {
    const existing = el.getAttribute("data-bc-t");
    if (existing && E.targets[existing]) return existing;
    let tid = existing;
    while (!tid || E.targets[tid]) tid = "t" + Math.random().toString(36).slice(2, 8);
    // What an element looked like first is kept for good: undo and saving may drop it from E,
    // and the element has possibly been edited by the time it is needed again.
    if (!S.targetLog[tid]) S.targetLog[tid] = { selector: bc.selectorFor(el), fp: bc.fingerprint(el) };
    E.targets[tid] = clone(S.targetLog[tid]);
    bc.bind(tid, el);
    return tid;
  }

  const usedTarget = (tid) => E.styles[tid] || E.meta[tid] || E.text[tid] || E.images[tid] || E.inlineSvg[tid];

  // Every edit must keep its target, or it would be lost on reload with no trace.
  function restoreMissingTargets() {
    for (const list of [E.styles, E.meta, E.text, E.images, E.inlineSvg]) {
      for (const tid of Object.keys(list)) {
        if (!E.targets[tid] && S.targetLog[tid]) E.targets[tid] = clone(S.targetLog[tid]);
      }
    }
  }

  function pruneTargets() {
    for (const tid of Object.keys(E.targets)) {
      if (!usedTarget(tid)) delete E.targets[tid];
    }
  }

  const elementOf = (key) => (key ? bc.elementOf(key) : null);

  // ---------- responsive scopes ----------
  const writeScope = () => (S.onlyHere && S.device !== "desktop" ? S.device : "base");
  const viewScopes = () => (S.device === "mobile" ? SCOPES : S.device === "tablet" ? ["base", "tablet"] : ["base"]);

  function mergedMeta(key, scopes) {
    const out = {};
    for (const scope of scopes) {
      const m = E.meta[key] && E.meta[key][scope];
      if (!m) continue;
      for (const [k, v] of Object.entries(m)) {
        if (v === null) delete out[k];
        else out[k] = v;
      }
    }
    return out;
  }
  const effective = (key) => mergedMeta(key, viewScopes());

  // Where a change belongs. A value this screen has its own version of would hide a change made
  // to the shared value, so that version is what gets changed, and the larger screens stay as they are.
  function scopeFor(store, names) {
    const scope = writeScope();
    if (scope !== "base") return scope;
    for (const s of viewScopes().slice().reverse()) {
      if (s !== "base" && store && store[s] && names.some((n) => n in store[s])) {
        say("이 화면에 따로 정한 값이 있어 그 값을 바꿨습니다. 큰 화면은 그대로입니다.");
        return s;
      }
    }
    return "base";
  }
  const PAIRED = { tx: "ty", ty: "tx", sx: "sy", sy: "sx" };

  // Edits a working copy of the visible values, then stores only what changed in the scope it belongs to.
  function withMeta(key, fn) {
    const eff = effective(key);
    const work = clone(eff);
    fn(work);
    const m = E.meta[key] || (E.meta[key] = {});
    for (const k of new Set([...Object.keys(eff), ...Object.keys(work)])) {
      if (same(eff[k], work[k])) continue;
      const scope = scopeFor(m, PAIRED[k] ? [k, PAIRED[k]] : [k]);
      const target = m[scope] || (m[scope] = {});
      if (work[k] === undefined) {
        if (scope === "base") delete target[k];
        else target[k] = null;
      } else {
        target[k] = work[k];
      }
    }
    for (const scope of SCOPES) if (m[scope] && !Object.keys(m[scope]).length) delete m[scope];
    if (!Object.keys(m).length) delete E.meta[key];
  }

  function setStyle(key, prop, value) {
    const scope = scopeFor(E.styles[key], [prop]);
    const all = E.styles[key] || (E.styles[key] = {});
    const st = all[scope] || (all[scope] = {});
    if (value == null || value === "") delete st[prop];
    else st[prop] = value;
    if (!Object.keys(st).length) delete all[scope];
    if (!Object.keys(all).length) delete E.styles[key];
  }

  function metaCss(m) {
    const css = {};
    if (m.tx || m.ty) css.translate = `${round(m.tx || 0)}px ${round(m.ty || 0)}px`;
    if (m.rot) css.rotate = `${round(m.rot)}deg`;
    if ((m.sx != null && m.sx !== 1) || (m.sy != null && m.sy !== 1)) css.scale = `${round(m.sx ?? 1, 4)} ${round(m.sy ?? 1, 4)}`;
    const filters = [];
    for (const [name, , , , def, unit] of ADJUST) {
      const v = m.adj && m.adj[name];
      if (v != null && v !== def) filters.push(`${name}(${v}${unit})`);
    }
    if (m.shadow && m.shadow.on) {
      const [r, g, b] = hexToRgb(m.shadow.c);
      filters.push(`drop-shadow(${m.shadow.x}px ${m.shadow.y}px ${m.shadow.b}px rgba(${r}, ${g}, ${b}, ${m.shadow.a}))`);
    }
    if (filters.length) css.filter = filters.join(" ");
    if (m.grad && m.grad.css) {
      if (m.grad.mode === "mask") {
        css["-webkit-mask-image"] = m.grad.css;
        css["mask-image"] = m.grad.css;
      } else {
        css["background-image"] = m.grad.css;
      }
    }
    if (m.crop && (m.crop.t || m.crop.r || m.crop.b || m.crop.l)) {
      css["clip-path"] = `inset(${m.crop.t || 0}% ${m.crop.r || 0}% ${m.crop.b || 0}% ${m.crop.l || 0}%)`;
    }
    return css;
  }

  // Writes each scope's CSS as the difference from the larger screen above it.
  function compile(key) {
    const all = E.styles[key] || {};
    // Inline elements ignore moves and turns until they become inline-block.
    const el = bc.elementOf(key);
    const inline = SCOPES.some((s) => all[s] && all[s].display)
      || (el && !isSvgRoot(el) && !MOVABLE_INLINE.has(el.tagName) && win.getComputedStyle(el).display === "inline");
    let parentCss = {};
    SCOPES.forEach((scope, i) => {
      const css = metaCss(mergedMeta(key, SCOPES.slice(0, i + 1)));
      if (inline && (css.translate || css.rotate || css.scale)) css.display = "inline-block";
      const st = all[scope] || {};
      for (const k of COMPILED) delete st[k];
      for (const [k, v] of Object.entries(css)) if (parentCss[k] !== v) st[k] = v;
      for (const k of Object.keys(parentCss)) if (!(k in css)) st[k] = k === "display" ? "inline" : "none";
      if (Object.keys(st).length) all[scope] = st;
      else delete all[scope];
      parentCss = css;
    });
    if (Object.keys(all).length) E.styles[key] = all;
    else delete E.styles[key];
  }

  function exceptionLabels(key) {
    const labels = new Set();
    for (const scope of ["tablet", "mobile"]) {
      for (const k of Object.keys((E.meta[key] && E.meta[key][scope]) || {})) labels.add(LABELS[k] || k);
      for (const k of Object.keys((E.styles[key] && E.styles[key][scope]) || {})) {
        if (!COMPILED.includes(k)) labels.add(LABELS[k] || k);
      }
    }
    return [...labels];
  }

  function clearExceptions(key) {
    for (const scope of ["tablet", "mobile"]) {
      if (E.meta[key]) delete E.meta[key][scope];
      if (E.styles[key]) delete E.styles[key][scope];
    }
    if (E.meta[key] && !Object.keys(E.meta[key]).length) delete E.meta[key];
    if (E.styles[key] && !Object.keys(E.styles[key]).length) delete E.styles[key];
    compile(key);
  }

  // ---------- history ----------
  const openInlineSvgs = () => new Set(S.svgs.filter((r) => r.kind === "inline").map((r) => r.ref));
  const applyEdits = () => { if (bc) bc.apply(S.comparing ? {} : E, { leaveSvg: openInlineSvgs() }); };

  const svgSnapshot = () => S.svgs.map((r) => ({ ref: r.ref, inner: r.root.innerHTML, viewBox: r.root.getAttribute("viewBox"), attrs: clone(r.rootAttrs) }));
  const snapshot = () => ({ edits: JSON.stringify(E), svgs: svgSnapshot() });

  function restoreSvgs(list) {
    for (const rec of S.svgs) {
      const st = list.find((s) => s.ref === rec.ref);
      const inner = st ? st.inner : rec.baseline;
      if (rec.root.innerHTML !== inner) rec.root.innerHTML = inner;
      const vb = st ? st.viewBox : rec.baselineViewBox;
      if (vb) rec.root.setAttribute("viewBox", vb);
      if (st && st.attrs) rec.rootAttrs = clone(st.attrs);
    }
  }

  // Every change goes through here. Repeated changes of one action become one history entry.
  function mutate(label, fn, opts = {}) {
    fn();
    if (S.key && opts.compile !== false && !isSvgChild(S.sel)) compile(S.key);
    applyEdits();
    const now = Date.now();
    const group = opts.group || null;
    const coalesce = group ? S.lastGroup === group : S.lastLabel === label && S.lastSel === S.sel && now - S.lastTime < 700 && !S.lastGroup;
    if (coalesce && S.idx > 0) {
      S.history[S.idx] = { label, ...snapshot() };
      if (S.savedIdx === S.idx) S.savedIdx = -1;
    } else {
      S.history.length = S.idx + 1;
      if (S.savedIdx > S.idx) S.savedIdx = -1;
      S.history.push({ label, ...snapshot() });
      if (S.history.length > 150) {
        S.history.shift();
        S.savedIdx--;
      }
      S.idx = S.history.length - 1;
    }
    S.lastLabel = label;
    S.lastSel = S.sel;
    S.lastTime = now;
    S.lastGroup = group;
    renderHistory();
    renderTop();
  }

  function restore(i) {
    if (i < 0 || i >= S.history.length) return;
    S.idx = i;
    const st = S.history[i];
    const before = E.targets;
    const openRoot = isSvgChild(S.sel) ? rootSvgOf(S.sel) : null;
    E = JSON.parse(st.edits);
    // A target that points elsewhere now was relinked: let go of the old element so it finds its place again.
    for (const [tid, target] of Object.entries(E.targets)) {
      if (before[tid] && !same(before[tid], target)) bc.unbind(tid);
      S.targetLog[tid] = target;
    }
    restoreSvgs(st.svgs);
    applyEdits();
    S.lastLabel = null;
    S.lastGroup = null;
    S.anchor = null;
    if (openRoot) {
      S.sel = doc.getElementById(S.selChildId);
      // The shape itself was undone, so the SVG holding it stays selected.
      if (!S.sel) {
        renderAll();
        select(openRoot);
        return;
      }
    } else if (S.key) {
      S.sel = elementOf(S.key);
    }
    if (!S.sel) S.key = null;
    renderAll();
  }

  const isDirty = () => S.idx !== S.savedIdx || !!(S.editing && plainText(S.editing.el) !== S.editing.before);

  // ---------- saving ----------
  function serializeFileSvg(rec) {
    const c = doc.createElementNS(SVGNS, "svg");
    for (const [k, v] of Object.entries(rec.rootAttrs)) c.setAttribute(k, v);
    const vb = rec.root.getAttribute("viewBox");
    if (vb) c.setAttribute("viewBox", vb);
    c.setAttribute("xmlns", SVGNS);
    c.innerHTML = rec.root.innerHTML;
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(c)}\n`;
  }

  function collectSvgChanges() {
    const files = {};
    for (const rec of S.svgs) {
      const inner = rec.root.innerHTML;
      const dropped = rec.resetInner != null && rec.resetInner === inner;
      const changed = inner !== rec.baseline || rec.root.getAttribute("viewBox") !== rec.baselineViewBox;
      if (rec.kind === "file") {
        if (dropped) files[rec.ref] = null;
        else if (changed) files[rec.ref] = serializeFileSvg(rec);
      } else if (dropped) {
        delete E.inlineSvg[rec.ref];
      } else if (changed) {
        E.inlineSvg[rec.ref] = inner;
      }
    }
    return files;
  }

  async function save() {
    if (!S.ready) return false;
    endTextEdit(true);
    finishPen();
    say("저장 중…");
    const files = collectSvgChanges();
    restoreMissingTargets();
    pruneTargets();
    try {
      const res = await fetch("/__bc/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beavercoat": "1" },
        body: JSON.stringify({ page: S.page, edits: E, svgs: files }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const result = await res.json();
      for (const rec of S.svgs) {
        rec.baseline = rec.root.innerHTML;
        rec.baselineViewBox = rec.root.getAttribute("viewBox");
      }
      refreshSvgImages(Object.keys(files));
      S.history[S.idx] = { ...S.history[S.idx], ...snapshot() };
      S.savedIdx = S.idx;
      renderTop();
      const skipped = result.skipped || [];
      if (skipped.length) {
        console.warn("beavercoat: 결과에서 빠진 파일", skipped);
        say(`저장했습니다. ${skipped.length}개 파일은 ${result.results} 폴더에 넣지 못했습니다: ${skipped[0]}${skipped.length > 1 ? " 외" : ""}`, true);
      } else {
        say(`저장했습니다. 수정된 페이지는 ${result.results} 폴더에 있습니다.`);
      }
      return true;
    } catch (e) {
      say("저장하지 못했습니다. 편집기 서버가 실행 중인지 확인해 주세요.", true);
      return false;
    }
  }

  function refreshSvgImages(paths) {
    if (!paths.length) return;
    doc.querySelectorAll("img").forEach((img) => {
      const rel = fileSvgPath(img);
      if (rel && paths.includes(rel)) img.src = img.getAttribute("src").split("?")[0] + "?v=" + Date.now();
    });
  }

  async function uploadAndPlace(file, target) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    say("이미지 올리는 중…");
    try {
      const res = await fetch(`/__bc/upload?ext=${encodeURIComponent(ext)}`, { method: "POST", headers: { "X-Beavercoat": "1" }, body: file });
      if (!res.ok) throw new Error(String(res.status));
      const { value } = await res.json();
      const key = ensureTarget(target);
      mutate("이미지 넣기", () => { E.images[key] = value; }, { compile: false });
      select(target);
      say("이미지를 넣었습니다. 저장을 눌러야 파일에 기록됩니다.");
    } catch (e) {
      say("이미지를 넣지 못했습니다. JPG, PNG, WebP, GIF, AVIF, SVG 파일인지 확인해 주세요.", true);
    }
  }

  async function exportFile(kind) {
    if (!(await save())) return;
    say("만드는 중…");
    try {
      const res = await fetch("/__bc/export", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beavercoat": "1" },
        body: JSON.stringify({ kind, page: S.page }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const out = await res.json();
      say("");
      const d = $("dialog");
      const warnings = out.warnings || [];
      d.replaceChildren(...[
        h("h3", {}, kind === "viewer" ? "보기용 HTML을 만들었습니다" : "편집용 압축을 만들었습니다"),
        h("p", {}, "프로젝트 폴더 안 ", h("code", {}, out.path), " 에 있습니다."),
        kind === "viewer" ? h("p", { class: "hint" }, "더블클릭으로 열리며, 서버나 Python이 필요 없습니다.") : h("p", { class: "hint" }, "받는 분은 압축을 풀고 ‘편집기 열기’를 더블클릭하면 됩니다. Python 3이 필요합니다."),
        warnings.length ? h("div", { class: "warn" }, "확인이 필요한 항목:", h("ul", {}, ...warnings.map((w) => h("li", {}, w)))) : null,
        h("div", { class: "btns" }, h("button", { class: "primary", onclick: () => d.close() }, "확인")),
      ].filter(Boolean));
      d.showModal();
    } catch (e) {
      say("만들지 못했습니다.", true);
    }
  }

  // ---------- coordinates ----------
  function frameOrigin() {
    const f = frame.getBoundingClientRect(), c = overlay.getBoundingClientRect();
    return { x: f.left - c.left, y: f.top - c.top };
  }
  function toCanvas(x, y) {
    const o = frameOrigin();
    return { x: o.x + x * S.zoom, y: o.y + y * S.zoom };
  }
  function toFrame(cx, cy) {
    const o = frameOrigin();
    return { x: (cx - o.x) / S.zoom, y: (cy - o.y) / S.zoom };
  }
  function eventPoint(e) {
    const c = overlay.getBoundingClientRect();
    return { x: e.clientX - c.left, y: e.clientY - c.top };
  }
  function localToCanvas(el, x, y) {
    const m = el.getScreenCTM();
    return toCanvas(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f);
  }
  function canvasToLocal(el, cx, cy) {
    const p = toFrame(cx, cy);
    const m = el.getScreenCTM().inverse();
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }

  const deviceWidth = () => {
    const bp = E.breakpoints || { tablet: 1024, mobile: 767 };
    if (S.device === "mobile") return Math.min(DEVICES.mobile, bp.mobile);
    if (S.device === "tablet") {
      // The tablet preview must sit above the mobile limit, or mobile rules would apply to it too.
      const width = Math.min(DEVICES.tablet, bp.tablet);
      return width > bp.mobile ? width : Math.min(bp.tablet, bp.mobile + 128);
    }
    return Math.max(DEVICES.desktop, bp.tablet + 1);
  };

  function layoutFrame() {
    const w = canvasEl.clientWidth, hgt = canvasEl.clientHeight, dw = deviceWidth();
    const dpr = devicePixelRatio || 1;
    if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(hgt * dpr)) {
      overlay.width = Math.round(w * dpr);
      overlay.height = Math.round(hgt * dpr);
    }
    frame.style.width = dw + "px";
    frame.style.height = hgt / S.zoom + "px";
    frame.style.transform = `translate(${(w - dw * S.zoom) / 2 + S.panX}px, 0) scale(${S.zoom})`;
    $("zoomLabel").textContent = Math.round(S.zoom * 100) + "%";
  }
  function fitZoom() {
    S.zoom = clamp(round((canvasEl.clientWidth - 24) / deviceWidth(), 3), 0.1, 1);
    S.panX = 0;
    S.manualZoom = false;
    layoutFrame();
  }
  function setZoom(z) {
    S.zoom = clamp(round(z, 3), 0.1, 4);
    S.manualZoom = true;
    layoutFrame();
  }

  // ---------- selection ----------
  function select(el) {
    S.sel = el;
    S.anchor = null;
    S.key = el && !isSvgChild(el) ? ensureTarget(el) : null;
    S.selChildId = el && isSvgChild(el) ? el.id : null;
    if (el) {
      let p = el.parentElement;
      while (p && p !== doc.body) {
        S.expanded.add(p);
        p = p.parentElement;
      }
    }
    renderProps();
    renderLayers();
    $("info").textContent = el ? nameOf(el) : "";
  }

  function pick(x, y) {
    if (!doc) return null;
    let el = doc.elementFromPoint(x, y);
    if (!el || el === doc.body || el === doc.documentElement) return null;
    if (el.closest && el.closest("x-dc") === el) return null;
    if (isOpen(el)) {
      // Thin lines are hard to hit, so look around the pointer inside an opened SVG.
      for (const [dx, dy] of [[4, 0], [-4, 0], [0, 4], [0, -4], [3, 3], [-3, -3], [3, -3], [-3, 3]]) {
        const near = doc.elementFromPoint(x + dx, y + dy);
        if (isSvgChild(near) && near.ownerSVGElement === el) return near;
      }
      return el;
    }
    if (isSvgChild(el)) {
      const root = rootSvgOf(el);
      if (!isOpen(root)) return root;
    }
    return el;
  }

  function rootSvgOf(el) {
    let root = el;
    while (root && root.ownerSVGElement) root = root.ownerSVGElement;
    return root;
  }

  // ---------- SVG expansion ----------
  function fileSvgPath(img) {
    if (!img || img.tagName !== "IMG") return null;
    const src = img.getAttribute("src");
    if (!src) return null;
    let url;
    try { url = new URL(src, doc.baseURI); } catch (e) { return null; }
    if (url.origin !== location.origin) return null;
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    return /\.svg$/i.test(path) ? path : null;
  }

  function ensureIds(root) {
    let n = 0;
    root.querySelectorAll("*").forEach((el) => {
      if (!el.id && !["title", "defs", "stop", "desc", "style", "metadata"].includes(el.tagName)) {
        do { el.id = `shape-${++n}`; } while (doc.querySelectorAll("#" + CSS.escape(el.id)).length > 1);
      }
    });
  }

  async function expandSvg(el) {
    if (isOpen(el)) return el;
    const key = ensureTarget(el);
    if (E.images[key]) { say("교체한 이미지는 펼칠 수 없습니다.", true); return null; }
    let rec;
    if (isSvgRoot(el)) {
      // A saved version may already be showing, so ask for the page's own contents.
      const original = bc.originalSvg(key) ?? el.innerHTML;
      el.setAttribute("data-bc-open", "");
      ensureIds(el);
      rec = { kind: "inline", ref: key, root: el, origInner: original };
    } else {
      const path = fileSvgPath(el);
      if (!path) return null;
      if (S.svgs.some((r) => r.ref === path)) {
        say("같은 SVG 파일을 이미 펼쳤습니다. 저장하면 이 파일을 쓰는 다른 곳에도 반영됩니다.");
        return null;
      }
      const res = await fetch("/" + path.split("/").map(encodeURIComponent).join("/"), { cache: "no-store" });
      if (!res.ok) { say("SVG 파일을 읽지 못했습니다.", true); return null; }
      const parsed = new DOMParser().parseFromString(await res.text(), "image/svg+xml");
      if (parsed.querySelector("parsererror") || parsed.documentElement.tagName.toLowerCase() !== "svg") {
        say("이 SVG 파일은 문법 오류가 있어 펼칠 수 없습니다.", true);
        return null;
      }
      const source = parsed.documentElement;
      const rootAttrs = {};
      for (const a of source.attributes) if (a.name !== "viewBox") rootAttrs[a.name] = a.value;
      scopeSvgClasses(source, path);
      const root = doc.importNode(source, true);
      for (const a of ["style", "class", "id", "alt"]) {
        if (el.hasAttribute(a) && a !== "alt") root.setAttribute(a, el.getAttribute(a));
        else if (a !== "alt" && a !== "id" && a !== "class" && a !== "style") root.removeAttribute(a);
      }
      if (!root.hasAttribute("viewBox") && source.getAttribute("width")) {
        root.setAttribute("viewBox", `0 0 ${parseFloat(source.getAttribute("width"))} ${parseFloat(source.getAttribute("height"))}`);
      }
      const box = el.getBoundingClientRect();
      if (!root.getAttribute("style")) root.setAttribute("style", `display:inline-block;width:${box.width}px;height:${box.height}px`);
      root.setAttribute("data-bc-open", "");
      el.replaceWith(root);
      bc.bind(key, root);
      ensureIds(root);
      rec = { kind: "file", ref: path, root, rootAttrs, img: el };
    }
    rec.baseline = rec.root.innerHTML;
    rec.baselineViewBox = rec.root.getAttribute("viewBox");
    S.svgs.push(rec);
    S.history[S.idx] = { ...S.history[S.idx], svgs: svgSnapshot() };
    S.expanded.add(rec.root);
    select(rec.root);
    say("SVG를 펼쳤습니다. 도형을 클릭하거나 레이어에서 고르세요.");
    return rec.root;
  }

  async function originalSvgFile(rec) {
    const res = await fetch("/" + rec.ref.split("/").map(encodeURIComponent).join("/") + "?bc-original=1", { cache: "no-store" });
    const source = new DOMParser().parseFromString(await res.text(), "image/svg+xml").documentElement;
    scopeSvgClasses(source, rec.ref);
    return { inner: source.innerHTML, viewBox: source.getAttribute("viewBox") };
  }

  async function resetSvg(root) {
    const rec = svgRecord(root);
    if (!rec) return;
    let inner = rec.origInner, viewBox = root.getAttribute("viewBox");
    if (rec.kind === "file") {
      const original = await originalSvgFile(rec);
      inner = original.inner;
      viewBox = original.viewBox || viewBox;
    }
    mutate("SVG 원본으로", () => {
      if (rec.kind === "inline") delete E.inlineSvg[rec.ref];
      root.innerHTML = inner;
      if (viewBox) root.setAttribute("viewBox", viewBox);
      ensureIds(root);
      rec.resetInner = root.innerHTML;
    }, { compile: false });
    select(root);
  }

  // A file SVG's <style> becomes part of the page once opened. Illustrator names classes .cls-1 in
  // every file, so each file's classes get a prefix of their own and can't affect one another.
  function scopeSvgClasses(root, ref) {
    const styles = [...root.querySelectorAll("style")];
    if (!styles.length) return;
    let hash = 0;
    for (const ch of ref) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    const prefix = `bc${hash.toString(36)}-`;
    const names = new Set();
    for (const style of styles) {
      style.textContent = style.textContent.replace(/([^{}]+)\{/g, (rule, selector) => {
        if (/^\s*@/.test(selector)) return rule;
        return selector.replace(/\.(-?[A-Za-z_][\w-]*)/g, (whole, name) => {
          if (name.startsWith(prefix)) return whole;
          names.add(name);
          return `.${prefix}${name}`;
        }) + "{";
      });
    }
    for (const el of root.querySelectorAll("[class]")) {
      el.setAttribute("class", el.getAttribute("class").split(/\s+/).map((c) => (names.has(c) ? prefix + c : c)).join(" "));
    }
  }

  const PAINT_PROPS = new Set(["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-dasharray", "opacity"]);

  // A CSS rule beats an attribute, so where one is in the way the value also goes in the style.
  function setSvgProp(el, name, value) {
    if (value == null) {
      el.removeAttribute(name);
      if (PAINT_PROPS.has(name)) el.style.removeProperty(name);
    } else {
      el.setAttribute(name, value);
      if (PAINT_PROPS.has(name)) {
        const cs = win.getComputedStyle(el);
        const withAttribute = cs.getPropertyValue(name);
        el.style.setProperty(name, String(value));
        if (cs.getPropertyValue(name) === withAttribute) el.style.removeProperty(name);
      }
    }
    if (el.getAttribute("style") === "") el.removeAttribute("style");
  }

  async function importSvg(root, file) {
    const rec = svgRecord(root);
    if (!rec) return;
    const parsed = new DOMParser().parseFromString(await file.text(), "image/svg+xml");
    const source = parsed.documentElement;
    if (parsed.querySelector("parsererror") || source.tagName.toLowerCase() !== "svg") {
      say("올바른 SVG 파일이 아닙니다.", true);
      return;
    }
    const vb = source.getAttribute("viewBox") || (source.getAttribute("width") ? `0 0 ${parseFloat(source.getAttribute("width"))} ${parseFloat(source.getAttribute("height"))}` : null);
    scopeSvgClasses(source, String(rec.ref));
    mutate("SVG 가져오기", () => {
      if (rec.kind === "inline" && vb && vb !== root.getAttribute("viewBox")) {
        // Inline edits store only the inside, so a different canvas size stays in a nested SVG.
        const nested = doc.createElementNS(SVGNS, "svg");
        nested.setAttribute("viewBox", vb);
        nested.setAttribute("width", "100%");
        nested.setAttribute("height", "100%");
        nested.innerHTML = source.innerHTML;
        root.replaceChildren(nested);
      } else {
        root.innerHTML = source.innerHTML;
        if (vb) root.setAttribute("viewBox", vb);
        if (rec.kind === "file") {
          for (const a of source.attributes) if (a.name !== "viewBox") rec.rootAttrs[a.name] = a.value;
        }
      }
      ensureIds(root);
    }, { compile: false });
    select(root);
    say("SVG를 가져왔습니다.");
  }

  function newId(prefix) {
    let id;
    do { id = `${prefix}-${Math.random().toString(36).slice(2, 7)}`; } while (doc.getElementById(id));
    return id;
  }

  function matrixOf(el) {
    const list = el.transform && el.transform.baseVal;
    if (!list || !list.numberOfItems) return new DOMMatrix();
    const c = list.consolidate().matrix;
    return new DOMMatrix([c.a, c.b, c.c, c.d, c.e, c.f]);
  }
  function setMatrix(el, m) {
    el.setAttribute("transform", `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map((v) => round(v, 4)).join(" ")})`);
  }
  const parentInverse = (el) => el.parentNode.getScreenCTM().inverse();
  function moveSvg(el, m0, dx, dy) {
    const p = parentInverse(el);
    setMatrix(el, new DOMMatrix().translate(p.a * dx + p.c * dy, p.b * dx + p.d * dy).multiply(m0));
  }

  // ---------- paths ----------
  function parsePath(d) {
    const tokens = String(d).match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
    const segs = [];
    let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0, lastCtrl = null, lastCmd = null;
    const num = () => parseFloat(tokens[i++]);
    while (i < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
      if (!cmd) return null;
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      const P = () => { const x = num(), y = num(); return rel ? [cx + x, cy + y] : [x, y]; };
      if (C === "M") {
        const p = P();
        segs.push({ c: "M", p: [p] });
        [cx, cy] = p; [sx, sy] = p;
        cmd = rel ? "l" : "L";
      } else if (C === "L") {
        const p = P();
        segs.push({ c: "L", p: [p] });
        [cx, cy] = p;
      } else if (C === "H") {
        const v = num(); cx = rel ? cx + v : v;
        segs.push({ c: "L", p: [[cx, cy]] });
      } else if (C === "V") {
        const v = num(); cy = rel ? cy + v : v;
        segs.push({ c: "L", p: [[cx, cy]] });
      } else if (C === "C") {
        const a = P(), b = P(), p = P();
        segs.push({ c: "C", p: [a, b, p] });
        lastCtrl = b; [cx, cy] = p;
      } else if (C === "S") {
        const a = lastCtrl && "CS".includes(lastCmd) ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy];
        const b = P(), p = P();
        segs.push({ c: "C", p: [a, b, p] });
        lastCtrl = b; [cx, cy] = p;
      } else if (C === "Q") {
        const a = P(), p = P();
        segs.push({ c: "Q", p: [a, p] });
        lastCtrl = a; [cx, cy] = p;
      } else if (C === "T") {
        const a = lastCtrl && "QT".includes(lastCmd) ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy];
        const p = P();
        segs.push({ c: "Q", p: [a, p] });
        lastCtrl = a; [cx, cy] = p;
      } else if (C === "Z") {
        segs.push({ c: "Z", p: [] });
        cx = sx; cy = sy;
        cmd = null;
      } else {
        return null; // Arcs (A) can't be edited point by point.
      }
      lastCmd = C;
    }
    if (segs.some((s) => s.p.some((pt) => pt.some((v) => !Number.isFinite(v))))) return null;
    return segs;
  }
  const pathToD = (segs) => segs.map((s) => s.c + (s.p.length ? " " + s.p.map((p) => `${round(p[0])} ${round(p[1])}`).join(" ") : "")).join(" ");

  // ---------- gradients ----------
  function hexToRgb(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(value) {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
    const [r, g, b] = m[1].split(/[ ,/]+/).map(Number);
    return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  }
  function boxSize(el) {
    const r = el.getBoundingClientRect();
    return { W: el.offsetWidth || r.width || 1, H: el.offsetHeight || r.height || 1 };
  }

  function refreshGradient(g, el) {
    const { W, H } = boxSize(el);
    const x1 = g.start.x * W, y1 = g.start.y * H, x2 = g.end.x * W, y2 = g.end.y * H;
    let dx = x2 - x1, dy = y2 - y1;
    if (dx === 0 && dy === 0) dx = 1;
    const angle = Math.atan2(dx, -dy);
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const L = Math.abs(W * sin) + Math.abs(H * cos);
    const pos = (x, y) => (0.5 + ((x - W / 2) * sin - (y - H / 2) * cos) / L) * 100;
    const p0 = pos(x1, y1), p1 = pos(x2, y2);
    const stops = [...g.stops].sort((a, b) => a.p - b.p).map((s) => {
      const [r, gg, b] = g.mode === "mask" ? [0, 0, 0] : hexToRgb(s.c);
      return `rgba(${r}, ${gg}, ${b}, ${round(s.a)}) ${round(p0 + ((p1 - p0) * s.p) / 100)}%`;
    });
    g.deg = round(((angle * 180) / Math.PI + 360) % 360, 1);
    g.p0 = p0; g.p1 = p1; g.w = W; g.h = H;
    g.css = `linear-gradient(${g.deg}deg, ${stops.join(", ")})`;
  }

  // If the element's size changed, keep the visible gradient and move only the handles.
  function displayEnds(g, el) {
    const { W, H } = boxSize(el);
    if (g.deg == null || (Math.abs(g.w - W) < 0.5 && Math.abs(g.h - H) < 0.5)) return { start: g.start, end: g.end };
    const angle = (g.deg * Math.PI) / 180, sin = Math.sin(angle), cos = Math.cos(angle);
    const L = Math.abs(W * sin) + Math.abs(H * cos);
    const point = (p) => {
      const t = (p / 100 - 0.5) * L;
      return { x: (W / 2 + sin * t) / W, y: (H / 2 - cos * t) / H };
    };
    return { start: point(g.p0), end: point(g.p1) };
  }

  function svgGradDef(el, paint) {
    const m = (el.getAttribute(paint) || "").match(/url\(["']?#([^)"']+)["']?\)/);
    if (!m) return null;
    const def = rootSvgOf(el).querySelector("#" + CSS.escape(m[1]));
    return def && def.tagName === "linearGradient" ? def : null;
  }
  function svgDefs(root) {
    let d = root.querySelector(":scope > defs");
    if (!d) {
      d = doc.createElementNS(SVGNS, "defs");
      root.prepend(d);
    }
    return d;
  }
  function writeSvgStops(def, stops) {
    def.replaceChildren();
    [...stops].sort((a, b) => a.p - b.p).forEach((s) => {
      const st = doc.createElementNS(SVGNS, "stop");
      st.setAttribute("offset", round(s.p / 100, 4));
      st.setAttribute("stop-color", s.c);
      if (s.a !== 1) st.setAttribute("stop-opacity", round(s.a));
      def.append(st);
    });
  }
  function readSvgStops(def) {
    return [...def.querySelectorAll("stop")].map((s) => ({
      c: rgbToHex(s.getAttribute("stop-color") || "#000000"),
      a: Number(s.getAttribute("stop-opacity") ?? 1),
      p: round(parseFloat(s.getAttribute("offset") || 0) * (String(s.getAttribute("offset")).includes("%") ? 1 : 100)),
    }));
  }
  function setSvgGradEnds(def, p1, p2) {
    def.setAttribute("x1", round(p1.x)); def.setAttribute("y1", round(p1.y));
    def.setAttribute("x2", round(p2.x)); def.setAttribute("y2", round(p2.y));
  }
  function createSvgGrad(el, paint, p1, p2) {
    const def = doc.createElementNS(SVGNS, "linearGradient");
    def.id = newId("gradient");
    def.setAttribute("gradientUnits", "userSpaceOnUse");
    setSvgGradEnds(def, p1, p2);
    writeSvgStops(def, [{ c: "#C98A4B", a: 1, p: 0 }, { c: "#F4E3CF", a: 1, p: 100 }]);
    svgDefs(rootSvgOf(el)).append(def);
    setSvgProp(el, paint, `url(#${def.id})`);
    return def;
  }
  function defaultGrad(el) {
    return el.tagName === "IMG" || isSvgRoot(el)
      ? { mode: "mask", start: { x: 0.5, y: 0.55 }, end: { x: 0.5, y: 1 }, stops: [{ c: "#000000", a: 1, p: 0 }, { c: "#000000", a: 0, p: 100 }] }
      : { mode: "background", start: { x: 0.15, y: 0.5 }, end: { x: 0.85, y: 0.5 }, stops: [{ c: "#17120C", a: 1, p: 0 }, { c: "#C98A4B", a: 1, p: 100 }] };
  }

  function gradEnds(el) {
    if (isSvgChild(el)) {
      const def = svgGradDef(el, S.paint);
      if (!def) return null;
      const n = (a) => parseFloat(def.getAttribute(a) || 0);
      return { a: localToCanvas(el, n("x1"), n("y1")), b: localToCanvas(el, n("x2"), n("y2")) };
    }
    const g = effective(S.key).grad;
    if (!g) return null;
    const r = el.getBoundingClientRect();
    const ends = displayEnds(g, el);
    return {
      a: toCanvas(r.left + ends.start.x * r.width, r.top + ends.start.y * r.height),
      b: toCanvas(r.left + ends.end.x * r.width, r.top + ends.end.y * r.height),
    };
  }

  function setGradEnd(el, which, cx, cy) {
    if (isSvgChild(el)) {
      const def = svgGradDef(el, S.paint);
      const p = canvasToLocal(el, cx, cy);
      def.setAttribute(which === "start" ? "x1" : "x2", round(p.x));
      def.setAttribute(which === "start" ? "y1" : "y2", round(p.y));
      return;
    }
    withMeta(S.key, (m) => {
      const g = m.grad;
      const r = el.getBoundingClientRect();
      const ends = displayEnds(g, el);
      g.start = ends.start;
      g.end = ends.end;
      const f = toFrame(cx, cy);
      g[which] = { x: round((f.x - r.left) / r.width, 4), y: round((f.y - r.top) / r.height, 4) };
      refreshGradient(g, el);
    });
  }

  // ---------- drawing ----------
  function drawHandle(p, kind, extra = {}, style = {}) {
    const r = style.r || 5;
    ctx.beginPath();
    if (style.round) ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    else ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
    ctx.fillStyle = style.fill || "#fff";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = style.stroke || "#1668DC";
    ctx.stroke();
    S.hits.push({ x: p.x, y: p.y, r: r + 4, kind, ...extra });
  }

  function drawRect(r, color, dash) {
    const a = toCanvas(r.left, r.top);
    ctx.setLineDash(dash || []);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.strokeRect(a.x, a.y, r.width * S.zoom, r.height * S.zoom);
    ctx.setLineDash([]);
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!S.ready) return;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    S.hits = [];
    if (S.comparing || S.editing) return;
    if (S.sel && !S.sel.isConnected) {
      S.sel = isSvgChild(S.sel) ? doc.getElementById(S.selChildId) : elementOf(S.key);
      if (!S.sel) { S.key = null; renderProps(); }
    }
    if (S.hover && S.hover !== S.sel && S.hover.isConnected) drawRect(S.hover.getBoundingClientRect(), "#4C9BFF", [4, 3]);
    const el = S.sel;
    if (el) {
      const r = el.getBoundingClientRect();
      drawRect(r, "#4C9BFF");
      if (S.tool === "move") drawTransformHandles(r);
      if (S.tool === "gradient") drawGradientHandles(el);
      if (S.tool === "direct" && el.tagName === "path") drawPathHandles(el);
    }
    if (S.pen) drawPathHandles(S.pen.el, true);
  }

  function drawTransformHandles(r) {
    const points = {
      nw: [r.left, r.top], n: [r.left + r.width / 2, r.top], ne: [r.right, r.top], e: [r.right, r.top + r.height / 2],
      se: [r.right, r.bottom], s: [r.left + r.width / 2, r.bottom], sw: [r.left, r.bottom], w: [r.left, r.top + r.height / 2],
    };
    const top = toCanvas(points.n[0], points.n[1]);
    const rot = { x: top.x, y: top.y - 24 };
    ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rot.x, rot.y);
    ctx.strokeStyle = "#4C9BFF"; ctx.lineWidth = 1.5; ctx.stroke();
    for (const [kind, [x, y]] of Object.entries(points)) drawHandle(toCanvas(x, y), kind, {}, { r: 4 });
    drawHandle(rot, "rot", {}, { r: 5, round: true });
  }

  function drawGradientHandles(el) {
    const ends = gradEnds(el);
    if (!ends) return;
    ctx.beginPath(); ctx.moveTo(ends.a.x, ends.a.y); ctx.lineTo(ends.b.x, ends.b.y);
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.65)"; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    drawHandle(ends.a, "g-start", {}, { r: 7, round: true });
    drawHandle(ends.b, "g-end", {}, { r: 7, round: true, fill: "#4C9BFF", stroke: "#fff" });
  }

  function drawPathHandles(el, noHits) {
    const segs = parsePath(el.getAttribute("d"));
    if (!segs) return;
    const toC = (p) => localToCanvas(el, p[0], p[1]);
    let prev = null;
    segs.forEach((s, si) => {
      if (s.c === "C" || s.c === "Q") {
        const anchor = s.p[s.p.length - 1];
        s.p.slice(0, -1).forEach((c, pi) => {
          const from = s.c === "C" ? (pi === 0 ? prev : anchor) : prev;
          const a = toC(from), b = toC(c);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.lineWidth = 1; ctx.strokeStyle = "#4C9BFF"; ctx.stroke();
          if (s.c === "Q") {
            const c2 = toC(anchor);
            ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(c2.x, c2.y); ctx.stroke();
          }
          if (!noHits) drawHandle(b, "ctrl", { seg: si, pt: pi }, { r: 4, round: true, fill: "#4C9BFF", stroke: "#fff" });
        });
      }
      if (s.p.length) prev = s.p[s.p.length - 1];
    });
    segs.forEach((s, si) => {
      if (!s.p.length) return;
      const p = s.p[s.p.length - 1];
      const on = S.anchor && S.anchor.seg === si;
      if (noHits) drawHandle(toC(p), "pen-anchor", { seg: si }, { r: 4, fill: on ? "#4C9BFF" : "#fff" });
      else drawHandle(toC(p), "anchor", { seg: si, pt: s.p.length - 1 }, { r: 4.5, fill: on ? "#4C9BFF" : "#fff" });
    });
  }

  const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", rot: "grab", "g-start": "grab", "g-end": "grab", anchor: "move", ctrl: "move" };

  function hitAt(p) {
    let best = null, bestD = Infinity;
    for (const hit of S.hits) {
      const d = Math.hypot(hit.x - p.x, hit.y - p.y);
      if (d <= hit.r && d < bestD) { best = hit; bestD = d; }
    }
    return best;
  }
  const currentTool = () => (S.spaceHand ? "hand" : S.tool);

  // On a small element the handles would cover it entirely, so inside it always means moving.
  function insideSmallSelection(p) {
    if (!S.sel || !S.sel.getBoundingClientRect) return false;
    const r = S.sel.getBoundingClientRect();
    const a = toCanvas(r.left, r.top), b = toCanvas(r.right, r.bottom);
    if (b.x - a.x >= 40 && b.y - a.y >= 40) return false;
    return p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y;
  }
  const hitFor = (p, tool) => (tool === "move" && insideSmallSelection(p) ? null : hitAt(p));

  // ---------- pointer ----------
  function onPointerMove(e) {
    const p = eventPoint(e);
    if (S.drag) { S.drag.move(p, e); return; }
    const tool = currentTool();
    const hit = hitFor(p, tool);
    if (tool === "hand") overlay.style.cursor = "grab";
    else if (hit) overlay.style.cursor = CURSORS[hit.kind] || "pointer";
    else if (["pen", "rect", "ellipse", "line", "gradient"].includes(tool)) overlay.style.cursor = "crosshair";
    else if (tool === "text") overlay.style.cursor = "text";
    else overlay.style.cursor = "default";
    if (tool === "hand" || ["pen", "rect", "ellipse", "line"].includes(tool)) { S.hover = null; return; }
    const f = toFrame(p.x, p.y);
    S.hover = pick(f.x, f.y);
  }

  function beginDrag(e, move, end) {
    const group = ++S.groupCounter;
    S.drag = { move: (p, ev) => move(p, ev, group), end };
    overlay.setPointerCapture(e.pointerId);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    overlay.focus();
    const p = eventPoint(e);
    const f = toFrame(p.x, p.y);
    if (S.relinking) { finishRelink(pick(f.x, f.y)); return; }
    const hit = hitFor(p, currentTool());
    switch (currentTool()) {
      case "hand": return startPan(e, p);
      case "move": return downMove(e, p, f, hit);
      case "direct": return downDirect(e, p, f, hit);
      case "text": return downText(f);
      case "gradient": return downGradient(e, p, f, hit);
      case "pen": return downPen(e, p, f);
      case "rect": case "ellipse": case "line": return downShape(e, p, f);
    }
  }

  function startPan(e, p) {
    const panX = S.panX, y0 = win.scrollY;
    beginDrag(e, (q) => {
      S.panX = panX + q.x - p.x;
      win.scrollTo({ top: y0 - (q.y - p.y) / S.zoom, behavior: "instant" });
      layoutFrame();
    });
  }

  function downMove(e, p, f, hit) {
    if (hit && CURSORS[hit.kind] && !["anchor", "ctrl", "g-start", "g-end"].includes(hit.kind)) return startTransform(e, p, hit.kind);
    const target = pick(f.x, f.y);
    if (!S.sel || !target) { select(target); return; }
    if (S.sel === target) { startMove(e, p); return; }
    // Pressing inside the selection: a drag moves the selection, a plain click selects what's inside.
    if (S.sel.contains(target)) { startMove(e, p, target); return; }
    select(target);
  }

  function startMove(e, p, clickTarget) {
    const el = S.sel, k = S.key, svg = isSvgChild(el);
    const m0 = svg ? matrixOf(el) : null;
    const eff = svg ? {} : effective(k);
    const tx0 = eff.tx || 0, ty0 = eff.ty || 0;
    let moved = false;
    beginDrag(e, (q, ev, group) => {
      let dx = (q.x - p.x) / S.zoom, dy = (q.y - p.y) / S.zoom;
      if (!moved && Math.hypot(dx, dy) < 3 / S.zoom) return;
      moved = true;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      mutate("이동", () => {
        if (svg) moveSvg(el, m0, dx, dy);
        else withMeta(k, (m) => { m.tx = round(tx0 + dx); m.ty = round(ty0 + dy); });
      }, { group, compile: !svg });
    }, () => {
      if (moved) renderProps();
      else if (clickTarget) select(clickTarget);
    });
  }

  function startTransform(e, p, kind) {
    const el = S.sel, k = S.key, svg = isSvgChild(el);
    const r0 = el.getBoundingClientRect();
    const m0 = svg ? matrixOf(el) : null;
    const mt = svg ? {} : effective(k);
    const base = { tx: mt.tx || 0, ty: mt.ty || 0, rot: mt.rot || 0, sx: mt.sx ?? 1, sy: mt.sy ?? 1 };
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    const c0 = toCanvas(cx, cy);
    const a0 = Math.atan2(p.y - c0.y, p.x - c0.x);

    beginDrag(e, (q, ev, group) => {
      if (kind === "rot") {
        let deg = ((Math.atan2(q.y - c0.y, q.x - c0.x) - a0) * 180) / Math.PI;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        mutate("회전", () => {
          if (svg) {
            const P = parentInverse(el);
            const px = P.a * cx + P.c * cy + P.e, py = P.b * cx + P.d * cy + P.f;
            setMatrix(el, new DOMMatrix().translate(px, py).rotate(deg).translate(-px, -py).multiply(m0));
          } else {
            withMeta(k, (m) => { m.rot = round(base.rot + deg); });
          }
        }, { group });
        return;
      }
      const dx = (q.x - p.x) / S.zoom, dy = (q.y - p.y) / S.zoom;
      const E_ = kind.includes("e"), W_ = kind.includes("w"), N_ = kind.includes("n"), S_ = kind.includes("s");
      let dW = E_ ? dx : W_ ? -dx : 0, dH = S_ ? dy : N_ ? -dy : 0;
      let rx = Math.max(0.02, (r0.width + dW) / (r0.width || 1));
      let ry = Math.max(0.02, (r0.height + dH) / (r0.height || 1));
      if (ev.shiftKey) {
        const u = (E_ || W_) && (N_ || S_) ? Math.max(rx, ry) : (E_ || W_) ? rx : ry;
        rx = ry = u;
      }
      dW = r0.width * (rx - 1); dH = r0.height * (ry - 1);
      mutate("크기 변경", () => {
        if (svg) {
          const ax = E_ ? r0.left : W_ ? r0.right : cx;
          const ay = S_ ? r0.top : N_ ? r0.bottom : cy;
          const P = parentInverse(el);
          const px = P.a * ax + P.c * ay + P.e, py = P.b * ax + P.d * ay + P.f;
          setMatrix(el, new DOMMatrix().translate(px, py).scale(rx, ry).translate(-px, -py).multiply(m0));
        } else {
          withMeta(k, (m) => {
            m.sx = round(base.sx * rx, 4);
            m.sy = round(base.sy * ry, 4);
            m.tx = round(base.tx + (E_ ? dW / 2 : W_ ? -dW / 2 : 0));
            m.ty = round(base.ty + (S_ ? dH / 2 : N_ ? -dH / 2 : 0));
          });
        }
      }, { group });
    }, () => renderProps());
  }

  function downDirect(e, p, f, hit) {
    if (hit && (hit.kind === "anchor" || hit.kind === "ctrl")) {
      const el = S.sel;
      const start = parsePath(el.getAttribute("d"));
      if (hit.kind === "anchor") S.anchor = { seg: hit.seg };
      const p0 = canvasToLocal(el, p.x, p.y);
      beginDrag(e, (q, ev, group) => {
        const lp = canvasToLocal(el, q.x, q.y);
        const dx = lp.x - p0.x, dy = lp.y - p0.y;
        const segs = clone(start);
        const s = segs[hit.seg];
        const orig = start[hit.seg].p[hit.pt];
        s.p[hit.pt] = [orig[0] + dx, orig[1] + dy];
        if (hit.kind === "anchor") {
          // Moving a point carries the attached cubic curve handles with it.
          if (s.c === "C") s.p[1] = [start[hit.seg].p[1][0] + dx, start[hit.seg].p[1][1] + dy];
          const next = segs[hit.seg + 1];
          if (next && next.c === "C") next.p[0] = [start[hit.seg + 1].p[0][0] + dx, start[hit.seg + 1].p[0][1] + dy];
        }
        mutate("점 편집", () => el.setAttribute("d", pathToD(segs)), { group, compile: false });
      });
      return;
    }
    const target = pick(f.x, f.y);
    select(target);
    if (!target) return;
    if (!isSvgChild(target)) say("점 편집은 펼친 SVG의 경로에 쓰입니다. 먼저 SVG를 더블클릭해 펼쳐 주세요.");
    else if (target.tagName !== "path") say("이 도형은 오른쪽 속성의 숫자로 모양을 바꿀 수 있습니다.");
    else if (!parsePath(target.getAttribute("d"))) say("이 경로에는 점 편집을 지원하지 않는 곡선(호)이 있습니다.", true);
  }

  function deleteAnchor() {
    const el = S.sel;
    if (!S.anchor || !el || el.tagName !== "path") return false;
    const segs = parsePath(el.getAttribute("d"));
    if (!segs) return false;
    if (segs.filter((s) => s.p.length).length <= 2) { say("점이 2개뿐이라 더 지울 수 없습니다.", true); return true; }
    const i = S.anchor.seg;
    if (segs[i].c === "M" && segs[i + 1] && segs[i + 1].p.length) {
      const next = segs[i + 1];
      segs.splice(i, 2, { c: "M", p: [next.p[next.p.length - 1]] });
    } else {
      segs.splice(i, 1);
    }
    S.anchor = null;
    mutate("점 삭제", () => el.setAttribute("d", pathToD(segs)), { compile: false });
    return true;
  }

  function downText(f) {
    const target = pick(f.x, f.y);
    if (!target) return;
    select(target);
    if (isTextLeaf(target)) { startTextEdit(target); return; }
    if (target.tagName === "text") say("SVG 글자는 오른쪽 속성의 내용 칸에서 바꿀 수 있습니다.");
    else say("글자만 있는 요소를 클릭해 주세요.");
  }

  function downGradient(e, p, f, hit) {
    if (hit && (hit.kind === "g-start" || hit.kind === "g-end")) {
      const which = hit.kind === "g-start" ? "start" : "end";
      beginDrag(e, (q, ev, group) => {
        let x = q.x, y = q.y;
        if (ev.shiftKey) [x, y] = snapFrom(which === "start" ? "end" : "start", x, y);
        mutate("그라데이션 조절", () => setGradEnd(S.sel, which, x, y), { group, compile: !isSvgChild(S.sel) });
      }, () => renderProps());
      return;
    }
    const target = pick(f.x, f.y);
    if (!target) return;
    if (target !== S.sel) select(target);
    if (isSvgChild(target) && target.tagName === "g") { say("그룹은 안쪽 도형을 하나씩 선택해 주세요."); return; }
    const k = S.key;
    let started = false;
    beginDrag(e, (q, ev, group) => {
      if (!started && Math.hypot(q.x - p.x, q.y - p.y) < 4) return;
      let x = q.x, y = q.y;
      if (ev.shiftKey) {
        const a = Math.round(Math.atan2(y - p.y, x - p.x) / (Math.PI / 12)) * (Math.PI / 12);
        const dist = Math.hypot(x - p.x, y - p.y);
        x = p.x + Math.cos(a) * dist; y = p.y + Math.sin(a) * dist;
      }
      mutate("그라데이션", () => {
        if (!started) {
          started = true;
          if (isSvgChild(target)) {
            const a = canvasToLocal(target, p.x, p.y);
            if (!svgGradDef(target, S.paint)) createSvgGrad(target, S.paint, a, a);
            else setGradEnd(target, "start", p.x, p.y);
          } else {
            withMeta(k, (m) => { if (!m.grad) { m.grad = defaultGrad(target); refreshGradient(m.grad, target); } });
            setGradEnd(target, "start", p.x, p.y);
          }
        }
        setGradEnd(target, "end", x, y);
      }, { group, compile: !isSvgChild(target) });
    }, () => renderProps());
  }

  function snapFrom(other, x, y) {
    const ends = gradEnds(S.sel);
    const o = other === "start" ? ends.a : ends.b;
    const a = Math.round(Math.atan2(y - o.y, x - o.x) / (Math.PI / 12)) * (Math.PI / 12);
    const dist = Math.hypot(x - o.x, y - o.y);
    return [o.x + Math.cos(a) * dist, o.y + Math.sin(a) * dist];
  }

  function openRootAt(f) {
    const el = doc.elementFromPoint(f.x, f.y);
    if (!el) return null;
    const root = isSvgRoot(el) ? el : isSvgChild(el) ? rootSvgOf(el) : null;
    if (root && isOpen(root)) return root;
    say(root || (el.tagName === "IMG" && fileSvgPath(el)) ? "먼저 SVG를 더블클릭해 펼쳐 주세요." : "도형은 펼친 SVG 안에서 그릴 수 있습니다.", true);
    return null;
  }

  function addShape(root, tag, attrs) {
    const el = doc.createElementNS(SVGNS, tag);
    el.id = newId(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    root.append(el);
    return el;
  }

  function downShape(e, p, f) {
    const root = openRootAt(f);
    if (!root) return;
    const a = canvasToLocal(root, p.x, p.y);
    const tool = S.tool;
    const paint = { fill: tool === "line" ? "none" : "#C98A4B", stroke: tool === "line" ? "#C98A4B" : "none", "stroke-width": 2.5 };
    const el = tool === "rect" ? addShape(root, "rect", { x: a.x, y: a.y, width: 0, height: 0, ...paint })
      : tool === "ellipse" ? addShape(root, "ellipse", { cx: a.x, cy: a.y, rx: 0, ry: 0, ...paint })
      : addShape(root, "line", { x1: a.x, y1: a.y, x2: a.x, y2: a.y, "stroke-linecap": "round", ...paint });
    const label = { rect: "사각형 그리기", ellipse: "타원 그리기", line: "직선 그리기" }[tool];
    let drew = false;
    beginDrag(e, (q, ev, group) => {
      drew = true;
      const b = canvasToLocal(root, q.x, q.y);
      let w = b.x - a.x, hh = b.y - a.y;
      if (ev.shiftKey && tool !== "line") {
        const u = Math.max(Math.abs(w), Math.abs(hh));
        w = Math.sign(w || 1) * u; hh = Math.sign(hh || 1) * u;
      }
      mutate(label, () => {
        if (tool === "rect") {
          el.setAttribute("x", round(Math.min(a.x, a.x + w))); el.setAttribute("y", round(Math.min(a.y, a.y + hh)));
          el.setAttribute("width", round(Math.abs(w))); el.setAttribute("height", round(Math.abs(hh)));
        } else if (tool === "ellipse") {
          el.setAttribute("cx", round(a.x + w / 2)); el.setAttribute("cy", round(a.y + hh / 2));
          el.setAttribute("rx", round(Math.abs(w) / 2)); el.setAttribute("ry", round(Math.abs(hh) / 2));
        } else {
          el.setAttribute("x2", round(b.x)); el.setAttribute("y2", round(b.y));
        }
      }, { group, compile: false });
    }, () => {
      const box = el.getBBox();
      if (!drew || (box.width < 1 && box.height < 1)) {
        el.remove();
        if (drew) restore(Math.max(0, S.idx - 1));
        return;
      }
      setTool("move");
      select(el);
    });
  }

  function downPen(e, p, f) {
    const root = S.pen ? S.pen.root : openRootAt(f);
    if (!root) return;
    const a = canvasToLocal(root, p.x, p.y);
    const pt = [a.x, a.y];
    if (!S.pen) {
      const el = addShape(root, "path", { fill: "none", stroke: "#C98A4B", "stroke-width": 2.5, "stroke-linecap": "round", d: `M ${round(pt[0])} ${round(pt[1])}` });
      S.pen = { el, root, segs: [{ c: "M", p: [pt] }], out: null };
    } else {
      const first = S.pen.segs[0].p[0];
      const fc = localToCanvas(root, first[0], first[1]);
      if (S.pen.segs.length > 2 && Math.hypot(fc.x - p.x, fc.y - p.y) < 9) {
        S.pen.segs.push({ c: "Z", p: [] });
        S.pen.el.setAttribute("d", pathToD(S.pen.segs));
        finishPen();
        return;
      }
      S.pen.segs.push({ c: "L", p: [pt] });
      S.pen.el.setAttribute("d", pathToD(S.pen.segs));
    }
    const pen = S.pen;
    const index = pen.segs.length - 1;
    const prevOut = pen.out;
    const prevAnchor = index > 0 ? pen.segs[index - 1].p[pen.segs[index - 1].p.length - 1] : null;
    pen.out = null;
    beginDrag(e, (q) => {
      const b = canvasToLocal(root, q.x, q.y);
      if (Math.hypot(b.x - pt[0], b.y - pt[1]) < 2) return;
      pen.out = [b.x, b.y];
      if (index > 0) {
        pen.segs[index] = { c: "C", p: [prevOut || prevAnchor, [2 * pt[0] - b.x, 2 * pt[1] - b.y], pt] };
        pen.el.setAttribute("d", pathToD(pen.segs));
      }
    });
  }

  function finishPen(cancel) {
    if (!S.pen) return;
    const { el, segs } = S.pen;
    S.pen = null;
    if (cancel || segs.filter((s) => s.p.length).length < 2) { el.remove(); return; }
    mutate("펜으로 그리기", () => {}, { compile: false });
    setTool("move");
    select(el);
  }

  // ---------- text editing ----------
  function startTextEdit(el) {
    endTextEdit(true);
    select(el);
    S.editing = { el, key: S.key, html: el.innerHTML, before: plainText(el) };
    el.contentEditable = "plaintext-only";
    overlay.classList.add("passthrough");
    el.focus();
    const range = doc.createRange();
    range.selectNodeContents(el);
    const sel = win.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.addEventListener("blur", onEditBlur);
    el.addEventListener("keydown", onEditKey);
    el.addEventListener("input", onEditInput);
  }
  function onEditBlur() { endTextEdit(true); }
  function onEditInput() { renderTop(); }
  function onEditKey(e) {
    // Keys pressed in the page don't reach the editor's own handler, so saving is caught here too.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); endTextEdit(false); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); endTextEdit(true); }
  }
  function endTextEdit(commit) {
    const st = S.editing;
    if (!st) return;
    S.editing = null;
    const { el, key } = st;
    el.removeEventListener("blur", onEditBlur);
    el.removeEventListener("keydown", onEditKey);
    el.removeEventListener("input", onEditInput);
    el.removeAttribute("contenteditable");
    overlay.classList.remove("passthrough");
    const after = plainText(el);
    el.innerHTML = st.html; // Restore first so "reset" can return to the original later.
    if (commit && after !== st.before) {
      mutate("글자 수정", () => { E.text[key] = after.split("\n"); }, { compile: false });
      renderProps();
    }
    overlay.focus();
  }

  // ---------- relinking ----------
  function describeTarget(tid) {
    const t = E.targets[tid];
    const fp = t ? t.fp : {};
    const what = [];
    if (E.styles[tid] || E.meta[tid]) what.push("스타일");
    if (E.text[tid]) what.push("글자");
    if (E.images[tid]) what.push("이미지");
    if (E.inlineSvg[tid]) what.push("SVG");
    const label = fp.text ? `“${fp.text.slice(0, 30)}”` : fp.src ? fp.src : fp.cls ? `.${fp.cls.split(" ")[0]}` : "";
    return `${fp.tag || "요소"} ${label} — ${what.join(", ") || "편집"}`;
  }

  const realOrphans = () => bc.orphans().filter((tid) => E.targets[tid]);

  function startRelink(tid) {
    S.relinking = tid;
    $("relinkText").textContent = `연결할 요소를 클릭하세요: ${describeTarget(tid)}`;
    $("relinkBar").classList.add("show");
  }
  function cancelRelink() {
    S.relinking = null;
    $("relinkBar").classList.remove("show");
  }
  function finishRelink(el) {
    const tid = S.relinking;
    if (!el || isSvgChild(el)) { say("페이지 요소를 클릭해 주세요.", true); return; }
    const owner = el.getAttribute("data-bc-t");
    if (owner && owner !== tid && E.targets[owner]) { say("이 요소에는 이미 다른 편집이 있습니다. 다른 요소를 골라 주세요.", true); return; }
    cancelRelink();
    mutate("다시 연결", () => {
      S.targetLog[tid] = { selector: bc.selectorFor(el), fp: bc.fingerprint(el) };
      E.targets[tid] = clone(S.targetLog[tid]);
      bc.bind(tid, el);
    }, { compile: false });
    select(el);
  }
  function dropOrphan(tid) {
    mutate("끊긴 편집 삭제", () => {
      delete E.targets[tid]; delete E.styles[tid]; delete E.meta[tid];
      delete E.text[tid]; delete E.images[tid]; delete E.inlineSvg[tid];
    }, { compile: false });
    renderProps();
  }

  // ---------- properties ----------
  const group = (title, ...children) => h("div", { class: "group" }, h("h3", {}, title), ...children);
  const field = (label, ...ctl) => h("label", { class: "field" }, h("span", {}, label), h("span", { class: "ctl" }, ...ctl));

  function slider(label, min, max, step, value, onInput, suffix = "") {
    const out = h("span", { class: "val" }, String(value) + suffix);
    const input = h("input", {
      type: "range", min, max, step, value,
      oninput: (e) => { const v = Number(e.target.value); out.textContent = v + suffix; onInput(v); },
    });
    return field(label, input, out);
  }
  function number(label, value, onInput, opts = {}) {
    const input = h("input", {
      type: "number", value, step: opts.step ?? 1,
      oninput: (e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (Number.isFinite(v)) onInput(v); },
    });
    if (opts.min != null) input.min = opts.min;
    return field(label, input);
  }
  function colorField(label, value, onInput, onClear) {
    const input = h("input", { type: "color", value, oninput: (e) => onInput(e.target.value) });
    input.setAttribute("list", "palette");
    const items = [input];
    if (window.EyeDropper) {
      items.push(h("button", {
        title: "스포이드: 화면에서 색 가져오기",
        onclick: async (e) => {
          e.preventDefault();
          try {
            const { sRGBHex } = await new window.EyeDropper().open();
            input.value = sRGBHex;
            onInput(sRGBHex);
          } catch (err) { /* cancelled */ }
        },
      }, "스포이드"));
    }
    if (onClear) items.push(h("button", { onclick: (e) => { e.preventDefault(); onClear(); renderProps(); } }, "없음"));
    return field(label, ...items);
  }
  const selectField = (label, options, value, onInput) => field(label, h("select", { onchange: (e) => onInput(e.target.value) },
    ...options.map(([v, t]) => h("option", { value: v, selected: v === value }, t))));

  function renderProps() {
    const box = $("props");
    box.replaceChildren();
    const el = S.sel;
    if (!el) {
      renderIntro(box);
      return;
    }
    const parent = el.parentElement && el.parentElement !== doc.body && el.parentElement.tagName !== "X-DC" ? el.parentElement : null;
    box.append(group(nameOf(el), h("div", { class: "btns" },
      parent ? h("button", { onclick: () => select(parent) }, "바깥 요소로") : null,
      !isSvgChild(el) ? h("button", { onclick: resetSelected }, "이 요소 초기화") : null)));
    if (!isSvgChild(el)) renderScopeNotice(box, el);
    if (isSvgChild(el)) renderSvgProps(box, el);
    else renderHtmlProps(box, el);
  }

  function renderIntro(box) {
    const orphanIds = realOrphans();
    if (orphanIds.length) {
      const g = group(`다시 연결할 편집 ${orphanIds.length}개`,
        h("p", { class: "hint" }, "페이지가 바뀌어 대상을 확실히 찾지 못한 편집입니다. 잘못 붙지 않도록 적용을 멈춰 두었습니다."));
      for (const tid of orphanIds) {
        g.append(h("div", { class: "orphan" }, describeTarget(tid), h("div", { class: "btns" },
          h("button", { onclick: () => startRelink(tid) }, "다시 연결"),
          h("button", { onclick: () => dropOrphan(tid) }, "삭제"))));
      }
      box.append(g);
    }
    box.append(group("시작하기",
      h("p", { class: "hint" }, "페이지에서 요소를 클릭하거나 아래 레이어에서 고르세요."),
      h("p", { class: "hint" }, "사진 파일은 이미지나 빈 칸 위로 끌어다 놓으면 들어갑니다."),
      h("p", { class: "hint" }, "SVG는 더블클릭하면 도형을 하나씩 고칠 수 있습니다.")));
    const bp = E.breakpoints || { tablet: 1024, mobile: 767 };
    const setBp = (name, v) => mutate("화면 경계", () => { E.breakpoints = { ...bp, ...(E.breakpoints || {}), [name]: Math.max(1, v) }; }, { compile: false });
    box.append(group("화면 크기 경계",
      h("p", { class: "hint" }, "‘이 화면에만 적용’한 수정이 적용되는 최대 폭입니다. 페이지에서 자동으로 찾았습니다."),
      h("div", { class: "pair" },
        number("태블릿", bp.tablet, (v) => setBp("tablet", v), { min: 1 }),
        number("모바일", bp.mobile, (v) => setBp("mobile", v), { min: 1 }))));
  }

  function renderScopeNotice(box, el) {
    const key = S.key;
    if (writeScope() !== "base") {
      box.append(h("div", { class: "group" }, h("div", { class: "warn" }, `${S.device === "mobile" ? "모바일" : "태블릿 이하"}에만 적용 중입니다. 큰 화면은 그대로입니다. 글자·이미지·SVG 수정은 모든 화면에 적용됩니다.`)));
    }
    const labels = exceptionLabels(key);
    if (labels.length) {
      box.append(h("div", { class: "group" }, h("div", { class: "warn" }, `화면 크기별로 다른 값: ${labels.join(", ")}`,
        h("div", { class: "btns" }, h("button", {
          onclick: () => { mutate("공통값으로", () => clearExceptions(key), { compile: false }); renderProps(); },
        }, "공통값으로 되돌리기")))));
    }
  }

  function resetSelected() {
    const k = S.key, el = S.sel;
    const rec = svgRecord(el);
    mutate("요소 초기화", () => {
      delete E.styles[k]; delete E.meta[k]; delete E.text[k]; delete E.images[k];
    }, { compile: false });
    if (rec) resetSvg(el);
    renderProps();
    renderLayers();
  }

  // A plain box with no child elements can hold an image, as can any image.
  function imageSlot(el) {
    if (!el || isSvgChild(el) || isSvgRoot(el)) return null;
    if (el.tagName === "IMG") return el.hasAttribute("data-bc-image") ? el.parentElement : el;
    if (!el.children.length && ["DIV", "FIGURE", "SECTION", "ASIDE", "ARTICLE"].includes(el.tagName)) return el;
    return null;
  }

  function renderHtmlProps(box, el) {
    const k = S.key;
    const m = effective(k);
    const cs = win.getComputedStyle(el);
    const mut = (label, fn) => mutate(label, fn);
    const mm = (label, fn) => mutate(label, () => withMeta(k, fn));

    if (isSvgRoot(el) || fileSvgPath(el)) box.append(svgGroup(el));

    box.append(group("변형",
      h("div", { class: "pair" },
        number("X", m.tx || 0, (v) => mm("이동", (w) => { w.tx = v; })),
        number("Y", m.ty || 0, (v) => mm("이동", (w) => { w.ty = v; }))),
      h("div", { class: "pair" },
        number("가로 %", round((m.sx ?? 1) * 100, 1), (v) => mm("크기 변경", (w) => { w.sx = Math.max(1, v) / 100; })),
        number("세로 %", round((m.sy ?? 1) * 100, 1), (v) => mm("크기 변경", (w) => { w.sy = Math.max(1, v) / 100; }))),
      slider("회전", -180, 180, 1, round(m.rot || 0), (v) => mm("회전", (w) => { w.rot = v; }), "°")));

    box.append(group("모양",
      slider("불투명도", 0, 100, 1, Math.round(Number(cs.opacity) * 100), (v) => mut("불투명도", () => setStyle(k, "opacity", v === 100 && writeScope() === "base" ? null : String(v / 100))), "%"),
      selectField("혼합 모드", BLEND.map((b) => [b, b === "normal" ? "기본" : b]), cs.mixBlendMode || "normal", (v) => mut("혼합 모드", () => setStyle(k, "mix-blend-mode", v))),
      colorField("배경색", rgbToHex(cs.backgroundColor), (v) => mut("배경색", () => setStyle(k, "background-color", v)), () => mut("배경색", () => setStyle(k, "background-color", "transparent"))),
      slider("모서리", 0, 120, 1, parseFloat(cs.borderTopLeftRadius) || 0, (v) => mut("모서리", () => setStyle(k, "border-radius", v + "px")), "px"),
      slider("테두리", 0, 20, 1, parseFloat(cs.borderTopWidth) || 0, (v) => mut("테두리", () => {
        setStyle(k, "border-width", v + "px");
        setStyle(k, "border-style", v ? "solid" : "none");
      }), "px"),
      colorField("테두리색", rgbToHex(cs.borderTopColor), (v) => mut("테두리색", () => setStyle(k, "border-color", v))),
      slider("안쪽 여백", 0, 160, 1, parseFloat(cs.paddingTop) || 0, (v) => mut("안쪽 여백", () => setStyle(k, "padding", v + "px")), "px")));

    if (el.tagName !== "IMG" && !isSvgRoot(el) && (el.innerText || "").trim()) box.append(textGroup(el, k, cs));
    const slot = imageSlot(el);
    if (slot) box.append(imageGroup(el, slot, k, m));
    box.append(adjustGroup(k, m));
    box.append(gradientGroup(el, k, m));
  }

  function svgGroup(el) {
    const g = group("SVG");
    if (!isOpen(el)) {
      g.append(h("p", { class: "hint" }, "펼치면 안쪽 도형을 하나씩 고칠 수 있습니다. 더블클릭해도 됩니다."),
        h("div", { class: "btns" }, h("button", { class: "primary", onclick: () => expandSvg(el) }, "도형 펼치기")));
    } else {
      g.append(h("p", { class: "hint" }, "도형을 클릭하거나 아래 레이어에서 고르세요. 일러스트레이터에서 고친 파일은 가져오기로 넣습니다."),
        h("div", { class: "btns" },
          h("button", { onclick: () => { S.importRoot = el; $("svgFile").click(); } }, "SVG 가져오기"),
          h("button", { onclick: () => resetSvg(el) }, "SVG 원본으로")));
    }
    return g;
  }

  function textGroup(el, k, cs) {
    const mut = (label, fn) => mutate(label, fn);
    const g = group("글자");
    if (isTextLeaf(el)) {
      g.append(h("textarea", {
        rows: 2, value: plainText(el),
        onchange: (e) => {
          mutate("글자 수정", () => { E.text[k] = e.target.value.split("\n"); }, { compile: false });
          $("info").textContent = nameOf(el);
        },
      }));
    }
    g.append(
      slider("크기", 8, 120, 1, Math.round(parseFloat(cs.fontSize)), (v) => mut("글자 크기", () => setStyle(k, "font-size", v + "px")), "px"),
      selectField("굵기", [["300", "얇게"], ["400", "보통"], ["500", "중간"], ["600", "굵게"], ["700", "아주 굵게"]], String(clamp(Math.round((Number(cs.fontWeight) || 400) / 100) * 100, 300, 700)), (v) => mut("글자 굵기", () => setStyle(k, "font-weight", v))),
      colorField("글자색", rgbToHex(cs.color), (v) => mut("글자색", () => setStyle(k, "color", v))),
      slider("자간", -5, 20, 0.1, round(parseFloat(cs.letterSpacing) || 0, 1), (v) => mut("자간", () => setStyle(k, "letter-spacing", v + "px")), "px"),
      slider("행간", 0.8, 3, 0.05, round(parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) || 1.5), (v) => mut("행간", () => setStyle(k, "line-height", String(v)))),
      selectField("정렬", [["left", "왼쪽"], ["center", "가운데"], ["right", "오른쪽"]], ["center", "right"].includes(cs.textAlign) ? cs.textAlign : "left", (v) => mut("정렬", () => setStyle(k, "text-align", v))));
    return g;
  }

  function imageGroup(el, slot, k, m) {
    const crop = m.crop || {};
    const mm = (fn) => mutate("자르기", () => withMeta(k, (w) => { w.crop = w.crop || {}; fn(w.crop); }));
    return group("이미지",
      h("div", { class: "btns" }, h("button", { onclick: () => { S.uploadTarget = slot; $("file").click(); } }, el.tagName === "IMG" ? "이미지 교체" : "이미지 넣기")),
      el.tagName === "IMG" ? h("div", {},
        slider("위 자르기", 0, 95, 1, crop.t || 0, (v) => mm((c) => { c.t = v; }), "%"),
        slider("아래 자르기", 0, 95, 1, crop.b || 0, (v) => mm((c) => { c.b = v; }), "%"),
        slider("왼쪽 자르기", 0, 95, 1, crop.l || 0, (v) => mm((c) => { c.l = v; }), "%"),
        slider("오른쪽 자르기", 0, 95, 1, crop.r || 0, (v) => mm((c) => { c.r = v; }), "%")) : null);
  }

  function adjustGroup(k, m) {
    const g = group("보정·필터");
    const adj = m.adj || {};
    for (const [name, label, min, max, def, unit] of ADJUST) {
      g.append(slider(label, min, max, 1, adj[name] ?? def, (v) => mutate(label, () => withMeta(k, (w) => {
        w.adj = w.adj || {}; w.adj[name] = v;
      })), unit === "deg" ? "°" : unit));
    }
    const sh = m.shadow || { on: false, x: 0, y: 8, b: 20, c: "#000000", a: 0.4 };
    const ch = (fn) => mutate("그림자", () => withMeta(k, (w) => { w.shadow = w.shadow || { ...sh }; fn(w.shadow); }));
    g.append(
      h("label", { class: "field" }, h("span", {}, "그림자"), h("span", { class: "ctl" },
        h("input", { type: "checkbox", checked: !!sh.on, onchange: (e) => ch((s) => { s.on = e.target.checked; }) }))),
      slider("X", -60, 60, 1, sh.x, (v) => ch((s) => { s.x = v; }), "px"),
      slider("Y", -60, 60, 1, sh.y, (v) => ch((s) => { s.y = v; }), "px"),
      slider("번짐", 0, 80, 1, sh.b, (v) => ch((s) => { s.b = v; }), "px"),
      colorField("색", sh.c, (v) => ch((s) => { s.c = v; })),
      slider("진하기", 0, 100, 1, Math.round(sh.a * 100), (v) => ch((s) => { s.a = v / 100; }), "%"));
    return g;
  }

  function stopControls(g, getStops, commit, showColor, compile) {
    const stops = getStops();
    const change = (label, fn) => mutate(label, () => commit(fn), { compile });
    stops.forEach((s, i) => {
      const row = h("div", { class: "stop" },
        showColor ? colorField("색", s.c, (v) => change("그라데이션 색", (list) => { list[i].c = v; })) : null,
        slider("불투명도", 0, 100, 1, Math.round(s.a * 100), (v) => change("그라데이션 불투명도", (list) => { list[i].a = v / 100; }), "%"),
        slider("위치", 0, 100, 1, s.p, (v) => change("그라데이션 위치", (list) => { list[i].p = v; }), "%"));
      if (stops.length > 2) {
        row.append(h("div", { class: "btns" }, h("button", {
          onclick: () => { change("색 지점 삭제", (list) => { list.splice(i, 1); }); renderProps(); },
        }, "이 지점 삭제")));
      }
      g.append(row);
    });
    g.append(h("div", { class: "btns" }, h("button", {
      onclick: () => {
        change("색 지점 추가", (list) => {
          const last = [...list].sort((a, b) => a.p - b.p).pop();
          list.push({ c: last.c, a: last.a, p: 50 });
        });
        renderProps();
      },
    }, "+ 색 지점 추가")));
  }

  function gradientGroup(el, k, m) {
    const g = group("그라데이션");
    const grad = m.grad;
    if (!grad) {
      g.append(h("div", { class: "btns" }, h("button", {
        onclick: () => {
          mutate("그라데이션 추가", () => withMeta(k, (w) => { w.grad = defaultGrad(el); refreshGradient(w.grad, el); }));
          setTool("gradient");
          renderProps();
        },
      }, "그라데이션 추가")),
      h("p", { class: "hint" }, "그라데이션 도구(G)로 요소 위를 끌어도 됩니다."));
      return g;
    }
    const setMode = (mode) => {
      mutate("그라데이션 방식", () => withMeta(k, (w) => {
        w.grad.mode = mode;
        if (mode === "mask" && w.grad.stops.every((s) => s.a === 1)) [...w.grad.stops].sort((a, b) => a.p - b.p).pop().a = 0;
        refreshGradient(w.grad, el);
      }));
      renderProps();
    };
    g.append(
      h("div", { class: "btns" },
        h("button", { class: grad.mode === "background" ? "on" : "", onclick: () => setMode("background") }, "배경 칠하기"),
        h("button", { class: grad.mode === "mask" ? "on" : "", onclick: () => setMode("mask") }, "서서히 사라지기")),
      h("p", { class: "hint" }, `각도 ${grad.deg ?? 0}° · 그라데이션 도구(G)를 고르면 화면에 손잡이가 나타납니다.`));
    stopControls(g, () => effective(k).grad.stops, (fn) => withMeta(k, (w) => { fn(w.grad.stops); refreshGradient(w.grad, el); }), grad.mode !== "mask");
    g.append(h("div", { class: "btns" }, h("button", {
      onclick: () => { mutate("그라데이션 삭제", () => withMeta(k, (w) => { delete w.grad; })); renderProps(); },
    }, "그라데이션 삭제")));
    return g;
  }

  function renderSvgProps(box, el) {
    const tag = el.tagName;
    const attr = (n, d = "") => el.getAttribute(n) ?? d;
    const cs = win.getComputedStyle(el);
    const set = (n, v) => setSvgProp(el, n, v);
    const mut = (label, fn) => mutate(label, fn, { compile: false });

    const m = matrixOf(el);
    box.append(group("변형",
      h("div", { class: "pair" },
        number("X 이동", round(m.e), (v) => mut("이동", () => { const c = matrixOf(el); c.e = v; setMatrix(el, c); })),
        number("Y 이동", round(m.f), (v) => mut("이동", () => { const c = matrixOf(el); c.f = v; setMatrix(el, c); }))),
      h("p", { class: "hint" }, "이동·변형 도구(V)의 손잡이로 크기와 회전을 바꿀 수 있습니다."),
      h("div", { class: "btns" },
        h("button", { onclick: () => reorder(el, 1) }, "앞으로"),
        h("button", { onclick: () => reorder(el, -1) }, "뒤로"),
        h("button", { onclick: () => duplicate(el) }, "복제"),
        h("button", { onclick: () => removeSvg(el) }, "삭제"))));

    const geo = { circle: [["cx", "중심 X"], ["cy", "중심 Y"], ["r", "반지름"]], ellipse: [["cx", "중심 X"], ["cy", "중심 Y"], ["rx", "가로 반경"], ["ry", "세로 반경"]], rect: [["x", "X"], ["y", "Y"], ["width", "가로"], ["height", "세로"], ["rx", "모서리"]], line: [["x1", "X1"], ["y1", "Y1"], ["x2", "X2"], ["y2", "Y2"]], text: [["x", "X"], ["y", "Y"], ["font-size", "글자 크기"]] }[tag];
    if (geo) {
      box.append(group("모양", ...geo.map(([n, label]) => number(label, round(parseFloat(attr(n, cs.getPropertyValue(n))) || 0), (v) => mut(label, () => set(n, v))))));
    }
    if (tag === "path") {
      const editable = !!parsePath(attr("d"));
      box.append(group("경로",
        h("p", { class: "hint" }, editable ? "점 편집 도구(A)로 점과 곡선 손잡이를 끌 수 있습니다." : "이 경로에는 점 편집을 지원하지 않는 곡선(호)이 있습니다."),
        editable ? h("div", { class: "btns" }, h("button", { onclick: () => setTool("direct") }, "점 편집 시작")) : null));
    }
    if (tag === "text") {
      box.append(group("글자 내용", h("input", {
        type: "text", value: el.textContent,
        oninput: (e) => { mut("글자 내용", () => { el.textContent = e.target.value; }); $("info").textContent = nameOf(el); },
      })));
    }

    const paintGroup = group("칠과 선");
    const paintField = (paint, label) => {
      const value = attr(paint) || cs.getPropertyValue(paint);
      if (svgGradDef(el, paint)) return field(label, h("span", {}, "그라데이션"), h("button", { onclick: (e) => { e.preventDefault(); mut(label, () => set(paint, "none")); renderProps(); } }, "없음"));
      return colorField(label, value === "none" ? "#000000" : rgbToHex(value), (v) => mut(label, () => set(paint, v)), () => mut(label, () => set(paint, "none")));
    };
    paintGroup.append(paintField("fill", "칠"), paintField("stroke", "선"));
    paintGroup.append(
      slider("선 굵기", 0, 30, 0.5, round(parseFloat(attr("stroke-width", cs.strokeWidth)) || 0, 1), (v) => mut("선 굵기", () => set("stroke-width", v)), "px"),
      selectField("선 끝", [["butt", "평평"], ["round", "둥글게"], ["square", "사각"]], attr("stroke-linecap", cs.strokeLinecap), (v) => mut("선 끝", () => set("stroke-linecap", v))),
      field("점선", h("input", { type: "text", value: attr("stroke-dasharray") === "none" ? "" : attr("stroke-dasharray"), placeholder: "예: 5 7", oninput: (e) => mut("점선", () => set("stroke-dasharray", e.target.value.trim() || null)) })),
      slider("불투명도", 0, 100, 1, Math.round(Number(attr("opacity", 1)) * 100), (v) => mut("불투명도", () => set("opacity", v === 100 ? null : v / 100)), "%"));
    box.append(paintGroup);

    if (tag !== "g") {
      const g = group("그라데이션",
        h("div", { class: "btns" },
          h("button", { class: S.paint === "fill" ? "on" : "", onclick: () => { S.paint = "fill"; renderProps(); } }, "칠"),
          h("button", { class: S.paint === "stroke" ? "on" : "", onclick: () => { S.paint = "stroke"; renderProps(); } }, "선")));
      const def = svgGradDef(el, S.paint);
      if (def) {
        stopControls(g, () => readSvgStops(def), (fn) => { const list = readSvgStops(def); fn(list); writeSvgStops(def, list); }, true, false);
      } else {
        g.append(h("div", { class: "btns" }, h("button", {
          onclick: () => {
            const b = el.getBBox();
            mut("그라데이션 추가", () => createSvgGrad(el, S.paint, { x: b.x, y: b.y + b.height / 2 }, { x: b.x + b.width, y: b.y + b.height / 2 }));
            setTool("gradient");
            renderProps();
          },
        }, "그라데이션 추가")));
      }
      box.append(g);
    }
  }

  function reorder(el, dir) {
    const sib = dir > 0 ? el.nextElementSibling : el.previousElementSibling;
    if (!sib || SKIP_LAYER.has(sib.tagName)) { say("더 옮길 수 없습니다."); return; }
    mutate(dir > 0 ? "앞으로 보내기" : "뒤로 보내기", () => {
      if (dir > 0) sib.after(el); else sib.before(el);
    }, { compile: false });
    renderLayers();
  }
  function duplicate(el) {
    const copy = el.cloneNode(true);
    copy.id = newId(el.tagName);
    copy.querySelectorAll("[id]").forEach((c) => { c.id = newId(c.tagName); });
    el.after(copy);
    mutate("복제", () => setMatrix(copy, new DOMMatrix().translate(12, 12).multiply(matrixOf(el))), { compile: false });
    select(copy);
  }
  function removeSvg(el) {
    const root = rootSvgOf(el);
    mutate("도형 삭제", () => el.remove(), { compile: false });
    select(root);
  }

  // ---------- layers, history, tools ----------
  function layerRoots() {
    const page = doc.body.querySelector(":scope > x-dc");
    return kids(page || doc.body).flatMap((el) => (el.children.length === 1 && el.classList.contains("page") ? [el] : [el]));
  }

  function renderLayers() {
    const box = $("layers");
    if (box.hidden || !doc) return;
    box.replaceChildren();
    const walk = (el, depth) => {
      const children = kids(el);
      const open = S.expanded.has(el);
      const row = h("div", { class: "layer" + (el === S.sel ? " sel" : "") });
      row.style.paddingLeft = depth * 12 + "px";
      const tid = el.getAttribute("data-bc-t");
      const hidden = isSvgChild(el) ? el.getAttribute("display") === "none" : win.getComputedStyle(el).visibility === "hidden";
      row.append(
        h("span", {
          class: "eye" + (hidden ? " off" : ""), title: "보이기/숨기기",
          onclick: (e) => { e.stopPropagation(); toggleVisible(el, hidden); },
        }, "◉"),
        h("span", {
          class: "arrow",
          onclick: (e) => { e.stopPropagation(); if (open) S.expanded.delete(el); else S.expanded.add(el); renderLayers(); },
        }, children.length ? (open ? "▾" : "▸") : ""),
        h("span", { class: "name", title: nameOf(el) }, nameOf(el) + (tid && exceptionLabels(tid).length ? " ·" : "")));
      row.addEventListener("click", () => select(el));
      box.append(row);
      if (el === S.sel) requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
      if (open) children.forEach((c) => walk(c, depth + 1));
    };
    layerRoots().forEach((c) => walk(c, 0));
  }

  function toggleVisible(el, hidden) {
    const key = isSvgChild(el) ? null : ensureTarget(el);
    mutate(hidden ? "보이기" : "숨기기", () => {
      if (isSvgChild(el)) {
        if (hidden) el.removeAttribute("display"); else el.setAttribute("display", "none");
      } else {
        setStyle(key, "visibility", hidden ? (writeScope() === "base" ? null : "visible") : "hidden");
      }
    }, { compile: false });
    renderLayers();
  }

  function renderHistory() {
    const box = $("history");
    if (box.hidden) return;
    box.replaceChildren();
    S.history.forEach((st, i) => {
      box.append(h("div", {
        class: "hist" + (i === S.idx ? " cur" : "") + (i > S.idx ? " future" : ""),
        onclick: () => restore(i),
      }, st.label));
    });
    const cur = box.querySelector(".cur");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function renderTop() {
    $("undo").disabled = S.idx <= 0;
    $("redo").disabled = S.idx >= S.history.length - 1;
    $("save").textContent = isDirty() ? "저장 •" : "저장";
    $("onlyHereLabel").hidden = S.device === "desktop";
    $("onlyHere").checked = S.onlyHere;
    $("onlyHereText").textContent = S.device === "mobile" ? "모바일에만 적용" : "태블릿 이하에만 적용";
  }

  function renderTools() {
    $("tools").replaceChildren(...TOOLS.map((t) => h("button", {
      class: t.id === S.tool ? "on" : "",
      title: `${t.name} (${t.key.toUpperCase()})`,
      onclick: () => setTool(t.id),
    }, t.icon)));
    $("hint").textContent = TOOLS.find((t) => t.id === S.tool).hint;
  }

  function setTool(id) {
    if (S.tool === "pen" && id !== "pen") finishPen();
    endTextEdit(true);
    S.tool = id;
    S.anchor = null;
    renderTools();
  }

  function renderAll() {
    renderTools(); renderTop(); renderProps(); renderLayers(); renderHistory();
  }

  // ---------- wiring ----------
  function bindUI() {
    overlay.addEventListener("pointermove", onPointerMove);
    overlay.addEventListener("pointerdown", onPointerDown);
    const up = () => {
      if (!S.drag) return;
      const { end } = S.drag;
      S.drag = null;
      S.lastGroup = null;
      S.lastLabel = null;
      if (end) end();
    };
    overlay.addEventListener("pointerup", up);
    overlay.addEventListener("pointercancel", up);
    overlay.addEventListener("pointerleave", () => { if (!S.drag) S.hover = null; });
    // Focus is managed by hand: the default would pull focus off text being edited.
    overlay.addEventListener("mousedown", (e) => e.preventDefault());
    overlay.addEventListener("dblclick", (e) => {
      if (S.pen) { finishPen(); return; }
      if (currentTool() !== "move") return;
      const p = eventPoint(e);
      const f = toFrame(p.x, p.y);
      const target = pick(f.x, f.y);
      if (isTextLeaf(target)) startTextEdit(target);
      else if ((isSvgRoot(target) && !isOpen(target)) || fileSvgPath(target)) expandSvg(target);
    });
    overlay.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
      else win.scrollBy({ left: 0, top: e.deltaY / S.zoom, behavior: "instant" });
    }, { passive: false });

    $("save").onclick = save;
    $("undo").onclick = () => restore(S.idx - 1);
    $("redo").onclick = () => restore(S.idx + 1);
    $("page").onchange = (e) => {
      if (isDirty() && !confirm("저장하지 않은 수정이 있습니다. 그래도 다른 페이지로 이동할까요?")) {
        e.target.value = S.page;
        return;
      }
      S.savedIdx = S.idx; // The user already chose to leave.
      location.search = "?page=" + encodeURIComponent(e.target.value);
    };
    $("device").onchange = (e) => {
      S.device = e.target.value;
      if (S.device === "desktop") S.onlyHere = false;
      fitZoom();
      renderTop();
      setTimeout(renderProps, 50);
    };
    $("onlyHere").onchange = (e) => { S.onlyHere = e.target.checked; renderProps(); };
    $("zoomIn").onclick = () => setZoom(S.zoom * 1.25);
    $("zoomOut").onclick = () => setZoom(S.zoom / 1.25);
    $("zoomLabel").onclick = fitZoom;
    $("preview").onclick = () => window.open("/" + S.page.split("/").map(encodeURIComponent).join("/"), "_blank");
    $("exportViewer").onclick = () => exportFile("viewer");
    $("exportZip").onclick = () => exportFile("zip");
    $("relinkCancel").onclick = cancelRelink;
    const cmp = $("compare");
    const compareOn = (on) => {
      if (S.comparing === on) return;
      S.comparing = on;
      cmp.classList.toggle("on", on);
      applyEdits();
      compareSvgs(on);
    };
    cmp.addEventListener("pointerdown", () => compareOn(true));
    window.addEventListener("pointerup", () => compareOn(false));
    $("resetAll").onclick = resetAll;
    $("file").onchange = (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file && S.uploadTarget) uploadAndPlace(file, S.uploadTarget);
    };
    $("svgFile").onchange = (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file && S.importRoot) importSvg(S.importRoot, file);
    };
    const tabs = (layers) => {
      $("tabLayers").classList.toggle("on", layers);
      $("tabHistory").classList.toggle("on", !layers);
      $("layers").hidden = !layers;
      $("history").hidden = layers;
      if (layers) renderLayers(); else renderHistory();
    };
    $("tabLayers").onclick = () => tabs(true);
    $("tabHistory").onclick = () => tabs(false);

    canvasEl.addEventListener("dragover", (e) => { e.preventDefault(); $("dropHint").classList.add("show"); });
    canvasEl.addEventListener("dragleave", (e) => { if (e.target === canvasEl || e.target === overlay) $("dropHint").classList.remove("show"); });
    canvasEl.addEventListener("drop", (e) => {
      e.preventDefault();
      $("dropHint").classList.remove("show");
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const p = eventPoint(e);
      const f = toFrame(p.x, p.y);
      const slot = imageSlot(pick(f.x, f.y));
      if (!slot) { say("이미지나 빈 칸 위에 놓아 주세요.", true); return; }
      uploadAndPlace(file, slot);
    });

    // Keep the page in view when the window changes, unless the user chose a zoom level.
    window.addEventListener("resize", () => { if (S.manualZoom) layoutFrame(); else fitZoom(); });
    window.addEventListener("beforeunload", (e) => { if (isDirty()) e.preventDefault(); });
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", (e) => { if (e.code === "Space") S.spaceHand = false; });
  }

  async function compareSvgs(on) {
    doc.querySelectorAll("img").forEach((img) => {
      const rel = fileSvgPath(img);
      if (!rel) return;
      const base = img.getAttribute("src").split("?")[0];
      img.setAttribute("src", on ? base + "?bc-original=1" : base);
    });
    for (const rec of S.svgs) {
      if (!on) {
        const st = S.history[S.idx].svgs.find((s) => s.ref === rec.ref);
        rec.root.innerHTML = st ? st.inner : rec.baseline;
        continue;
      }
      if (rec.origInner == null) rec.origInner = (await originalSvgFile(rec)).inner;
      if (S.comparing) rec.root.innerHTML = rec.origInner;
    }
  }

  function onKey(e) {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = ["input", "textarea", "select"].includes(tag);
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === "s") { e.preventDefault(); save(); return; }
    if (typing || S.editing) return;
    if (mod && key === "z") { e.preventDefault(); restore(S.idx + (e.shiftKey ? 1 : -1)); return; }
    if (mod && (key === "=" || key === "+")) { e.preventDefault(); setZoom(S.zoom * 1.25); return; }
    if (mod && key === "-") { e.preventDefault(); setZoom(S.zoom / 1.25); return; }
    if (mod && key === "0") { e.preventDefault(); fitZoom(); return; }
    if (mod && key === "d") {
      e.preventDefault();
      if (isSvgChild(S.sel)) duplicate(S.sel);
      return;
    }
    if (mod) return;
    if (e.code === "Space") { e.preventDefault(); S.spaceHand = true; return; }
    const tool = TOOLS.find((t) => t.key === key);
    if (tool) { setTool(tool.id); return; }
    if (e.key === "Enter" && S.pen) { finishPen(); return; }
    if (e.key === "Escape") {
      if (S.relinking) cancelRelink();
      else if (S.pen) finishPen(true);
      else select(null);
      return;
    }
    if (!S.sel) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (S.tool === "direct" && deleteAnchor()) return;
      if (isSvgChild(S.sel)) removeSvg(S.sel);
      else {
        toggleVisible(S.sel, false);
        say("페이지 요소는 삭제 대신 숨깁니다. 레이어의 눈 아이콘으로 되살릴 수 있습니다.");
      }
      return;
    }
    if (e.key === "[" && isSvgChild(S.sel)) return reorder(S.sel, -1);
    if (e.key === "]" && isSvgChild(S.sel)) return reorder(S.sel, 1);
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[key];
    if (arrows) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const el = S.sel, k = S.key;
      mutate("이동", () => {
        if (isSvgChild(el)) moveSvg(el, matrixOf(el), arrows[0] * step, arrows[1] * step);
        else withMeta(k, (m) => { m.tx = (m.tx || 0) + arrows[0] * step; m.ty = (m.ty || 0) + arrows[1] * step; });
      }, { compile: !isSvgChild(el) });
      renderProps();
    }
  }

  async function resetAll() {
    if (!confirm("이 페이지의 모든 편집을 처음 상태로 되돌릴까요? 저장 전까지는 되돌리기로 복구할 수 있습니다.")) return;
    const originals = [];
    for (const rec of S.svgs) {
      if (rec.kind === "file") {
        const original = await originalSvgFile(rec);
        originals.push({ rec, inner: original.inner, vb: original.viewBox });
      }
    }
    const bp = E.breakpoints;
    mutate("전체 초기화", () => {
      E = emptyEdits();
      E.breakpoints = bp;
      for (const rec of S.svgs) {
        const o = originals.find((x) => x.rec === rec);
        if (o) { rec.root.innerHTML = o.inner; if (o.vb) rec.root.setAttribute("viewBox", o.vb); }
        else if (rec.kind === "inline") rec.root.innerHTML = rec.origInner;
        ensureIds(rec.root);
        rec.resetInner = rec.root.innerHTML;
      }
    }, { compile: false });
    select(null);
    renderAll();
  }

  // ---------- start ----------
  function detectBreakpoints() {
    const widths = [];
    for (const sheet of doc.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const rule of rules) {
        if (rule.media) {
          const m = rule.media.mediaText.match(/max-width:\s*(\d+)(?:\.\d+)?px/);
          if (m) widths.push(Number(m[1]));
        }
      }
    }
    const mobile = widths.filter((w) => w >= 400 && w <= 820).sort((a, b) => b - a)[0] || 767;
    const tablet = widths.filter((w) => w > mobile && w <= 1200).sort((a, b) => b - a)[0] || 1024;
    return { tablet, mobile };
  }

  async function waitForPage() {
    for (let i = 0; i < 400; i++) {
      win = frame.contentWindow;
      doc = frame.contentDocument;
      if (doc && doc.readyState === "complete" && win.__beavercoat && win.__beavercoat.pageReady()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  async function start() {
    bindUI();
    renderTools();
    const params = new URLSearchParams(location.search);
    let state;
    const res = await fetch("/__bc/state" + (params.get("page") ? "?page=" + encodeURIComponent(params.get("page")) : ""), { cache: "no-store" });
    state = await res.json();
    if (res.status === 409) {
      // Nothing is opened for editing, because saving would replace the damaged file.
      say(`저장된 편집 파일이 손상되어 열 수 없습니다. 파일을 고치거나 지운 뒤 다시 열어 주세요: ${state.file}`, true);
      return;
    }
    if (!res.ok || !state.page) {
      say(state.pages && state.pages.length ? "페이지를 찾지 못했습니다. 목록에서 골라 주세요." : "이 폴더에서 HTML 파일을 찾지 못했습니다.", true);
      if (!state.pages || !state.pages.length) return;
      state.page = state.pages[0];
      location.search = "?page=" + encodeURIComponent(state.page);
      return;
    }
    S.page = state.page;
    S.project = state.project;
    S.pages = state.pages;
    document.title = `${state.project} — beavercoat`;
    $("page").replaceChildren(...state.pages.map((p) => h("option", { value: p, selected: p === state.page }, p)));
    $("page").hidden = state.pages.length < 2;
    frame.src = "/" + state.page.split("/").map(encodeURIComponent).join("/");
    fitZoom();
    requestAnimationFrame(tick);
    if (!(await waitForPage())) { say("페이지를 불러오지 못했습니다.", true); return; }
    win.__bcEditorActive = true;
    bc = win.__beavercoat;
    // Let runtime-rendered pages settle before reading them.
    await new Promise((r) => setTimeout(r, 150));
    doc.addEventListener("click", (e) => e.preventDefault(), true);
    E = { ...emptyEdits(), ...clone(state.edits) };
    bc.apply(E);
    S.targetLog = clone(E.targets);
    if (!E.breakpoints) E.breakpoints = detectBreakpoints();
    fitZoom();
    S.history = [{ label: "시작", ...snapshot() }];
    S.idx = 0;
    S.savedIdx = 0;
    S.ready = true;
    const first = layerRoots()[0];
    if (first) S.expanded.add(first);
    renderAll();
    const lost = realOrphans();
    if (lost.length) say(`${lost.length}개 편집을 다시 연결해야 합니다. 오른쪽 목록을 확인해 주세요.`, true);
  }

  start();
})();
