// Applies saved beavercoat edits to a page. Runs in the page itself, with or without the editor.
(function () {
  "use strict";
  const BP_DEFAULT = { tablet: 1024, mobile: 767 };
  const originals = { text: new Map(), images: new Map(), svg: new Map() };
  const resolved = new Map(); // target id -> element
  let orphans = [];
  let styleEl = null;

  const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const srcName = (el) => {
    // Exported viewers replace src with embedded data and keep the original name beside it.
    const v = el.getAttribute && (el.getAttribute("data-bc-src") || el.getAttribute("src"));
    return v ? v.split("#")[0].split("?")[0].split("/").pop() : "";
  };

  function classesOf(el) {
    const c = el.getAttribute("class");
    return c ? c.split(/\s+/).filter(Boolean).sort().join(" ") : "";
  }

  function pathOf(el) {
    const parts = [];
    let node = el;
    while (node && node.parentElement && node !== document.body) {
      parts.unshift(node.tagName.toLowerCase());
      node = node.parentElement;
    }
    return parts.join(">");
  }

  // Child counts along the way up. A different count means something was added or removed on the path.
  function structureOf(el) {
    const counts = [];
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      counts.push(node.children.length);
      node = node.parentElement;
    }
    return counts.join(",");
  }

  const neighborText = (el) => (el ? normalize(el.textContent).slice(0, 60) : "");

  // Text of the nearest ancestor that says more than the element itself: a repeated button's card.
  function contextOf(el) {
    const own = normalize(el.textContent);
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const text = normalize(node.textContent);
      if (text !== own) return text.slice(0, 200);
    }
    return "";
  }

  const contentOf = (el) => normalize(el.textContent).slice(0, 120);

  function sameContent(fp) {
    const matches = fp.src ? (el) => srcName(el) === fp.src : (el) => contentOf(el) === fp.text;
    return [...document.body.querySelectorAll(CSS.escape(fp.tag))].filter((el) => !el.closest("x-dc template") && matches(el));
  }

  // Runs fn with applied text and placed images taken back out, so what gets remembered
  // describes the original page, which is what the next load will find.
  function withOriginalContent(target, fn) {
    const undo = [];
    const revert = (saved) => {
      const el = saved.el;
      if (!el.isConnected || saved.html == null || (el !== target && el.contains(target))) return;
      if (el.innerHTML !== saved.html) {
        undo.push([el, el.innerHTML]);
        el.innerHTML = saved.html;
      }
    };
    originals.text.forEach(revert);
    originals.images.forEach((saved) => { if (saved.el.tagName !== "IMG") revert(saved); });
    try {
      return fn();
    } finally {
      undo.reverse().forEach(([el, html]) => { el.innerHTML = html; });
    }
  }

  // Details remembered about an element so it can be found again if the page is re-exported.
  function fingerprint(el) {
    return withOriginalContent(el, () => {
      const fp = {
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        cls: classesOf(el),
        text: el.tagName === "IMG" ? "" : contentOf(el),
        src: srcName(el),
        path: pathOf(el),
        kids: el.children.length,
        structure: structureOf(el),
        prev: neighborText(el.previousElementSibling),
        next: neighborText(el.nextElementSibling),
        ctx: contextOf(el),
      };
      fp.dup = fp.src || fp.text ? sameContent(fp).length : 0;
      return fp;
    });
  }

  function selectorFor(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.body && node.parentElement) {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        return parts.join(" > ");
      }
      const index = [...node.parentElement.children].indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
      node = node.parentElement;
    }
    return "body > " + parts.join(" > ");
  }

  function query(selector) {
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  // Accepts the same spot without matching content only when everything around it is unchanged.
  // A new element that slid into this position has different neighbors or counts, so it is refused.
  function sameSpot(el, fp) {
    if (el.tagName.toLowerCase() !== fp.tag || classesOf(el) !== fp.cls || pathOf(el) !== fp.path) return false;
    if (el.children.length !== fp.kids || structureOf(el) !== fp.structure) return false;
    const prev = neighborText(el.previousElementSibling), next = neighborText(el.nextElementSibling);
    if (prev !== fp.prev || next !== fp.next) return false;
    return true;
  }

  // Finds a target: its own id, then matching details. Ambiguous means not applied, never a guess.
  function resolveTarget(target) {
    const fp = target.fp;
    if (fp.id) {
      const byId = document.getElementById(fp.id);
      if (byId) return byId.tagName.toLowerCase() === fp.tag || fp.tag === "img" || byId.tagName.toLowerCase() === "svg" ? byId : null;
    }
    const atPath = query(target.selector);
    if (fp.src || fp.text) {
      const same = sameContent(fp);
      // Repeated content can't identify an element, even if only one copy is left now: the edited
      // one may be the copy that was removed. Only its surroundings can, and if they don't, nothing is applied.
      if (same.length > 1 || fp.dup > 1) {
        const hasContext = (el) => fp.ctx === undefined || contextOf(el) === fp.ctx;
        const exact = same.filter((el) => sameSpot(el, fp) && hasContext(el));
        if (atPath && exact.includes(atPath)) return atPath;
        if (exact.length) return exact.length === 1 ? exact[0] : null;
        if (!fp.ctx) return null;
        // Something else on the page changed, but this one's own card is still recognisable.
        const inContext = same.filter((el) => classesOf(el) === fp.cls && contextOf(el) === fp.ctx);
        return inContext.length === 1 ? inContext[0] : null;
      }
      if (same.length === 1) return same[0];
    }
    // No content to go by, or only the content changed: everything else must still line up.
    return atPath && sameSpot(atPath, fp) ? atPath : null;
  }

  function resolveAll(edits) {
    orphans = [];
    let waiting = false;
    const taken = new Map();
    for (const [tid, target] of Object.entries(edits.targets || {})) {
      const known = resolved.get(tid);
      if (known && known.isConnected) { taken.set(known, tid); continue; }
      const tagged = document.querySelector(`[data-bc-t="${tid}"]`);
      const el = tagged || resolveTarget(target);
      if (!el) { orphans.push(tid); waiting = true; continue; }
      // Two edits landing on one element means one of them guessed wrong: apply neither twice.
      if (taken.has(el)) { orphans.push(tid); continue; }
      taken.set(el, tid);
      resolved.set(tid, el);
      el.setAttribute("data-bc-t", tid);
    }
    return waiting;
  }

  function cssFrom(edits) {
    const bp = { ...BP_DEFAULT, ...(edits.breakpoints || {}) };
    const blocks = { base: [], tablet: [], mobile: [] };
    for (const [tid, scopes] of Object.entries(edits.styles || {})) {
      for (const scope of ["base", "tablet", "mobile"]) {
        const props = scopes[scope];
        if (!props) continue;
        const body = Object.entries(props).map(([k, v]) => `${k}: ${v} !important;`).join(" ");
        if (body) blocks[scope].push(`[data-bc-t="${tid}"] { ${body} }`);
      }
    }
    return [
      blocks.base.join("\n"),
      blocks.tablet.length ? `@media (max-width: ${bp.tablet}px) {\n${blocks.tablet.join("\n")}\n}` : "",
      blocks.mobile.length ? `@media (max-width: ${bp.mobile}px) {\n${blocks.mobile.join("\n")}\n}` : "",
    ].filter(Boolean).join("\n");
  }

  function setLines(el, lines) {
    el.replaceChildren();
    lines.forEach((line, i) => {
      if (i) el.append(document.createElement("br"));
      el.append(document.createTextNode(line));
    });
  }

  function imageUrl(value) {
    return value.startsWith("upload:") ? (window.__BC_ASSET_BASE__ || "") + value.slice(7) : value;
  }

  function applyText(edits) {
    const wanted = edits.text || {};
    for (const [tid, saved] of originals.text) {
      if (!(tid in wanted)) {
        saved.el.innerHTML = saved.html;
        originals.text.delete(tid);
      }
    }
    for (const [tid, lines] of Object.entries(wanted)) {
      const el = resolved.get(tid);
      if (!el) continue;
      let saved = originals.text.get(tid);
      if (!saved || saved.el !== el) {
        saved = { el, html: el.innerHTML, wanted: null, written: null };
        originals.text.set(tid, saved);
      }
      // Compare against what was written, never against rendered text: spaces and text-transform
      // can make those differ forever, and rewriting would trigger the mutation observer again.
      const text = lines.join("\n");
      if (saved.wanted === text && el.innerHTML === saved.written) continue;
      setLines(el, lines);
      saved.wanted = text;
      saved.written = el.innerHTML;
    }
  }

  function applyImages(edits) {
    const wanted = edits.images || {};
    for (const [tid, saved] of originals.images) {
      if (!(tid in wanted)) {
        if (saved.el.tagName === "IMG") {
          saved.el.setAttribute("src", saved.src);
          if (saved.srcset != null) saved.el.setAttribute("srcset", saved.srcset);
          saved.sources.forEach(([source, srcset]) => source.setAttribute("srcset", srcset));
        } else {
          saved.el.innerHTML = saved.html;
          if (saved.style == null) saved.el.removeAttribute("style");
          else saved.el.setAttribute("style", saved.style);
        }
        originals.images.delete(tid);
      }
    }
    for (const [tid, value] of Object.entries(wanted)) {
      const el = resolved.get(tid);
      if (!el) continue;
      const url = imageUrl(value);
      const saved = originals.images.get(tid);
      if (!saved || saved.el !== el) {
        const picture = el.tagName === "IMG" && el.parentElement && el.parentElement.tagName === "PICTURE" ? el.parentElement : null;
        const sources = picture ? [...picture.querySelectorAll(":scope > source[srcset]")] : [];
        originals.images.set(tid, {
          el, src: el.getAttribute("src"), html: el.innerHTML, style: el.getAttribute("style"),
          srcset: el.getAttribute("srcset"), sources: sources.map((s) => [s, s.getAttribute("srcset")]),
        });
      }
      if (el.tagName === "IMG") {
        // Browsers prefer srcset and <source> over src, so they must go for the new image to show.
        el.removeAttribute("srcset");
        originals.images.get(tid).sources.forEach(([source]) => source.removeAttribute("srcset"));
        if (el.getAttribute("src") !== url) el.setAttribute("src", url);
        continue;
      }
      // A placeholder box: its contents become the image.
      const current = el.querySelector(":scope > img[data-bc-image]");
      if (current) {
        if (current.getAttribute("src") !== url) current.setAttribute("src", url);
      } else {
        const img = document.createElement("img");
        img.setAttribute("data-bc-image", "");
        img.setAttribute("src", url);
        img.alt = "";
        img.style.cssText = "display:block;width:100%;height:auto";
        el.replaceChildren(img);
        el.style.cssText += ";display:block;padding:0;border:0;min-height:0;overflow:hidden";
      }
    }
  }

  // leaveAlone holds SVGs that are open in the editor, whose live contents are the truth.
  function applySvg(edits, leaveAlone) {
    const wanted = edits.inlineSvg || {};
    for (const [tid, saved] of originals.svg) {
      if (!(tid in wanted) && !leaveAlone.has(tid)) {
        saved.el.innerHTML = saved.html;
        originals.svg.delete(tid);
      }
    }
    for (const [tid, inner] of Object.entries(wanted)) {
      const el = resolved.get(tid);
      if (!el || leaveAlone.has(tid)) continue;
      let saved = originals.svg.get(tid);
      if (!saved || saved.el !== el) {
        saved = { el, html: el.innerHTML, wanted: null, written: null };
        originals.svg.set(tid, saved);
      }
      // innerHTML can read back differently from what was set, so remember what it became.
      if (saved.wanted === inner && el.innerHTML === saved.written) continue;
      el.innerHTML = inner;
      saved.wanted = inner;
      saved.written = el.innerHTML;
    }
  }

  // Some design-tool runtimes render later. Their template must not be touched first,
  // because it gets replaced when the page is drawn.
  function pageReady() {
    // Until the whole page is parsed, a copy of an element may still be coming,
    // so "only one like this" can't be trusted yet.
    if (!document.body || document.readyState === "loading") return false;
    if (document.querySelector("x-dc")) return !!document.querySelector("[data-dc-tpl]");
    return true;
  }

  function apply(edits, opts) {
    edits = edits || {};
    opts = opts || {};
    if (!styleEl || !styleEl.isConnected) {
      styleEl = document.createElement("style");
      styleEl.setAttribute("data-bc-styles", "");
      (document.head || document.documentElement).append(styleEl);
    }
    // Only write on change: this runs from a mutation observer, and a write would trigger it again.
    const css = cssFrom(edits);
    if (styleEl.textContent !== css) styleEl.textContent = css;
    if (!pageReady()) return true;
    const waiting = resolveAll(edits);
    applyImages(edits);
    applyText(edits);
    applySvg(edits, opts.leaveSvg || new Set());
    window.__BC_STATUS__ = { orphans };
    return waiting;
  }

  window.__beavercoat = {
    apply,
    fingerprint,
    selectorFor,
    pageReady,
    bind(tid, el) { resolved.set(tid, el); el.setAttribute("data-bc-t", tid); },
    unbind(tid) {
      const el = resolved.get(tid);
      if (el) el.removeAttribute("data-bc-t");
      resolved.delete(tid);
    },
    elementOf: (tid) => resolved.get(tid) || null,
    originalSvg: (tid) => (originals.svg.has(tid) ? originals.svg.get(tid).html : null),
    orphans: () => orphans.slice(),
  };

  const data = window.__BC_EDITS__ || {};
  apply(data);
  const hasTargets = Object.keys(data.targets || {}).length > 0;
  if (hasTargets) {
    let scheduled = false;
    const run = () => {
      scheduled = false;
      if (window.__bcEditorActive) return observer.disconnect();
      if (!apply(data)) observer.disconnect();
    };
    // Through a timer, not directly: the page keeps running even if something here ever keeps changing the page.
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(run, 0);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
    const stop = () => setTimeout(() => observer.disconnect(), 5000);
    if (document.readyState === "complete") stop();
    else addEventListener("load", stop);
  }
})();
