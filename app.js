/* PDF Organizer — thumbnails by pdf.js (Mozilla, Apache-2.0), saving by pdf-lib (MIT). Everything runs in this tab. */
import * as pdfjsLib from "./lib/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";

const { $, $$, h } = S3;
const { PDFDocument, degrees } = PDFLib;
const st = { name: "", base: "", doc: null, js: null, items: [], orig: [], sel: new Set(), undo: [], redo: [], anchor: null, drag: null, nextId: 1 };

// ---------- model (pure functions over the page list) ----------
function initial(doc) {
  return doc.getPages().map((p, i) => {
    const srot = ((p.getRotation().angle % 360) + 360) % 360, s = p.getSize(), side = srot % 180 !== 0;
    return { id: i + 1, src: i, rot: 0, srot, w: side ? s.height : s.width, h: side ? s.width : s.height };
  });
}
const clone = items => items.map(x => Object.assign({}, x));
function rotate(items, ids, delta) { return items.map(x => ids.has(x.id) ? Object.assign({}, x, { rot: (((x.rot + delta) % 360) + 360) % 360 }) : Object.assign({}, x)); }
function remove(items, ids) { return items.filter(x => !ids.has(x.id)).map(x => Object.assign({}, x)); }
function moveBy(items, ids, dir) {
  const a = clone(items), idx = a.map((x, i) => ids.has(x.id) ? i : -1).filter(i => i >= 0);
  if (!idx.length || (dir < 0 && idx[0] === 0) || (dir > 0 && idx[idx.length - 1] === a.length - 1)) return a;
  (dir < 0 ? idx : idx.reverse()).forEach(i => { const t = a[i]; a[i] = a[i + dir]; a[i + dir] = t; });
  return a;
}
function moveTo(items, id, dest) {
  const a = clone(items), from = a.findIndex(x => x.id === id);
  if (from < 0) return a;
  const [it] = a.splice(from, 1); a.splice(dest > from ? dest - 1 : dest, 0, it);
  return a;
}
function insertBlank(items, afterId, newId) {
  const a = clone(items), at = afterId == null ? a.length - 1 : a.findIndex(x => x.id === afterId), ref = a[at] || a[0] || { w: 595.28, h: 841.89, rot: 0 };
  const flip = ref.rot % 180 !== 0; // match how the neighbour looks on screen
  a.splice(at + 1, 0, { id: newId, src: null, rot: 0, srot: 0, w: flip ? ref.h : ref.w, h: flip ? ref.w : ref.h });
  return a;
}
async function saveDoc(src, items) {
  const out = await PDFDocument.create();
  const wanted = items.filter(x => x.src !== null).map(x => x.src), copied = await out.copyPages(src, wanted);
  let k = 0;
  items.forEach(x => {
    if (x.src === null) { const p = out.addPage([x.w, x.h]); if (x.rot) p.setRotation(degrees(x.rot)); }
    else { const p = copied[k++]; p.setRotation(degrees((x.srot + x.rot) % 360)); out.addPage(p); }
  });
  out.setProducer("S3eidat Tools PDF Organizer");
  return out.save();
}
async function loadLib(bytes) {
  try { return await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { throw new Error(/encrypted/i.test(e && e.message) ? "This PDF is password-protected or encrypted. Remove the protection first." : "This file couldn't be read as a PDF."); }
}
function openJs(bytes) { return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise; }

// ---------- thumbnails: each source page rendered once, then copied (rotated) into tiles ----------
const cache = new Map(), waiting = new Map(); let queue = [], busy = false, gen = 0;
function want(src, canvas, rot) {
  if (cache.has(src)) { paintThumb(canvas, cache.get(src), rot); return; }
  if (!waiting.has(src)) { waiting.set(src, []); queue.push(src); }
  waiting.get(src).push([canvas, rot]);
  pump();
}
function pump() {
  if (busy || !queue.length || !st.js) return;
  busy = true; const src = queue.shift(), g = gen;
  st.js.getPage(src + 1).then(page => {
    const v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: 280 / Math.max(v1.width, v1.height) });
    const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    return page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise.then(() => c);
  }).then(c => {
    if (g !== gen) return;
    cache.set(src, c);
    (waiting.get(src) || []).forEach(([cv, rot]) => { if (cv.isConnected) paintThumb(cv, c, rot); });
    waiting.delete(src);
  }).catch(() => waiting.delete(src)).finally(() => { busy = false; pump(); });
}
function paintThumb(cv, img, rot) {
  const side = rot % 180 !== 0, w = img.width, hh = img.height;
  cv.width = side ? hh : w; cv.height = side ? w : hh;
  const x = cv.getContext("2d");
  x.translate(cv.width / 2, cv.height / 2); x.rotate(rot * Math.PI / 180); x.drawImage(img, -w / 2, -hh / 2);
  cv.classList.remove("loading");
}
function paintBlank(cv, it) {
  const side = it.rot % 180 !== 0, w = side ? it.h : it.w, hh = side ? it.w : it.h, k = 200 / Math.max(w, hh);
  cv.width = Math.round(w * k); cv.height = Math.round(hh * k);
  const x = cv.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, cv.width, cv.height);
  x.fillStyle = "#9aa3ad"; x.font = "600 22px Inter, sans-serif"; x.textAlign = "center"; x.fillText("Blank", cv.width / 2, cv.height / 2 + 8);
}

// ---------- UI ----------
function commit(items) {
  st.undo.push(st.items); if (st.undo.length > 200) st.undo.shift();
  st.redo = []; st.items = items;
  const ids = new Set(items.map(x => x.id)); st.sel.forEach(id => { if (!ids.has(id)) st.sel.delete(id); });
  draw();
}
function draw() {
  const grid = $("#grid"), focusId = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.id;
  grid.innerHTML = "";
  st.items.forEach((it, i) => {
    const cv = h("canvas", { "class": "loading", width: 90, height: 120 });
    const tile = h("div", { "class": "po-tile" + (st.sel.has(it.id) ? " sel" : ""), draggable: "true", tabindex: "0", role: "option", "aria-selected": String(st.sel.has(it.id)), "data-id": it.id, "aria-label": "Page " + (i + 1) + (it.src === null ? ", blank" : ", original page " + (it.src + 1)) + (it.rot ? ", rotated " + it.rot + "°" : "") }, [
      h("div", { "class": "po-thumb" }, [cv]),
      h("div", { "class": "po-cap" }, [h("b", { text: String(i + 1) }), h("span", { "class": "faint", text: it.src === null ? "blank" : it.src !== i ? "was " + (it.src + 1) : "" }), it.rot ? h("span", { "class": "chip po-rot", text: it.rot === 90 ? "⟳ 90°" : it.rot === 270 ? "⟲ 90°" : "180°" }) : null]),
      h("div", { "class": "po-acts" }, [
        h("button", { "class": "btn icon small", type: "button", "data-act": "l", title: "Rotate left", "aria-label": "Rotate page " + (i + 1) + " left" }, ["⟲"]),
        h("button", { "class": "btn icon small", type: "button", "data-act": "r", title: "Rotate right", "aria-label": "Rotate page " + (i + 1) + " right" }, ["⟳"]),
        h("button", { "class": "btn icon small danger", type: "button", "data-act": "x", title: "Delete", "aria-label": "Delete page " + (i + 1) }, ["✕"])
      ])
    ]);
    grid.appendChild(tile);
    if (it.src === null) paintBlank(cv, it); else want(it.src, cv, it.rot);
  });
  if (!st.items.length) grid.appendChild(h("div", { "class": "empty" }, [h("b", { text: "No pages left" }), "Undo, reset, or add a blank page."]));
  if (focusId) { const t = grid.querySelector('[data-id="' + focusId + '"]'); if (t) t.focus({ preventScroll: true }); }
  status();
}
function status() {
  const n = st.items.length, rot = st.items.filter(x => x.rot).length, blank = st.items.filter(x => x.src === null).length;
  const removed = st.orig.length - st.items.filter(x => x.src !== null).length, moved = st.items.some((x, i) => x.src !== null && x.src !== i);
  const bits = [n + " page" + (n === 1 ? "" : "s")];
  if (moved) bits.push("reordered"); if (rot) bits.push(rot + " rotated"); if (removed) bits.push(removed + " deleted"); if (blank) bits.push(blank + " blank");
  $("#summary").textContent = bits.join(" · ");
  $("#summary").className = "chip" + (bits.length > 1 ? " accent" : "");
  const any = st.sel.size > 0;
  $("#rotLlbl").textContent = any ? "Rotate left" : "All left";
  $("#rotRlbl").textContent = any ? "Rotate right" : "All right";
  ["#del", "#mvL", "#mvR"].forEach(s => { $(s).disabled = !any; });
  $("#undo").disabled = !st.undo.length; $("#redo").disabled = !st.redo.length;
  $("#save").disabled = !n;
}
function target() { return st.sel.size ? new Set(st.sel) : new Set(st.items.map(x => x.id)); }
function undo() { if (!st.undo.length) return; st.redo.push(st.items); st.items = st.undo.pop(); draw(); }
function redo() { if (!st.redo.length) return; st.undo.push(st.items); st.items = st.redo.pop(); draw(); }
function lastSelected() { let last = null; st.items.forEach(x => { if (st.sel.has(x.id)) last = x.id; }); return last; }

$("#rotL").addEventListener("click", () => commit(rotate(st.items, target(), -90)));
$("#rotR").addEventListener("click", () => commit(rotate(st.items, target(), 90)));
$("#del").addEventListener("click", () => { if (st.sel.size) commit(remove(st.items, st.sel)); });
$("#mvL").addEventListener("click", () => commit(moveBy(st.items, st.sel, -1)));
$("#mvR").addEventListener("click", () => commit(moveBy(st.items, st.sel, 1)));
$("#blank").addEventListener("click", () => { const id = st.nextId++; commit(insertBlank(st.items, lastSelected(), id)); st.sel = new Set([id]); draw(); });
$("#undo").addEventListener("click", undo);
$("#redo").addEventListener("click", redo);
$("#reset").addEventListener("click", () => { st.sel.clear(); commit(clone(st.orig)); });

const grid = $("#grid");
grid.addEventListener("click", e => {
  const tile = e.target.closest(".po-tile"); if (!tile) return;
  const id = +tile.dataset.id, act = e.target.closest("[data-act]");
  if (act) {
    const one = new Set([id]), a = act.dataset.act;
    commit(a === "x" ? remove(st.items, one) : rotate(st.items, one, a === "l" ? -90 : 90));
    return;
  }
  if (e.shiftKey && st.anchor != null) {
    const ids = st.items.map(x => x.id), a = ids.indexOf(st.anchor), b = ids.indexOf(id);
    if (a >= 0) { if (!(e.ctrlKey || e.metaKey)) st.sel.clear(); ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => st.sel.add(x)); }
  } else if (e.ctrlKey || e.metaKey) { st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id); st.anchor = id; }
  else { const only = st.sel.size === 1 && st.sel.has(id); st.sel.clear(); if (!only) st.sel.add(id); st.anchor = id; }
  draw();
});
grid.addEventListener("keydown", e => {
  const tile = e.target.closest(".po-tile"); if (!tile || e.target.closest("button")) return;
  const id = +tile.dataset.id, idx = st.items.findIndex(x => x.id === id);
  if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault(); const ids = st.sel.has(id) ? st.sel : new Set([id]); commit(moveBy(st.items, ids, e.key === "ArrowLeft" ? -1 : 1)); return;
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const t = grid.children[idx + (e.key === "ArrowLeft" ? -1 : 1)]; if (t) t.focus(); return; }
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); commit(remove(st.items, st.sel.size ? st.sel : new Set([id]))); return; }
  if (e.key === "r" || e.key === "R") { commit(rotate(st.items, st.sel.size ? st.sel : new Set([id]), e.shiftKey ? -90 : 90)); return; }
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); tile.click(); }
});
document.addEventListener("keydown", e => {
  if ($("#work").hidden || /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ""))) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
});

// drag to reorder
grid.addEventListener("dragstart", e => { const t = e.target.closest && e.target.closest(".po-tile"); if (!t) return; st.drag = +t.dataset.id; t.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", t.dataset.id); } catch (x) { /* ignore */ } });
grid.addEventListener("dragover", e => {
  if (st.drag == null) return; e.preventDefault();
  $$(".po-tile", grid).forEach(x => x.classList.remove("ins-l", "ins-r"));
  const t = e.target.closest(".po-tile"); if (!t) return;
  const r = t.getBoundingClientRect(); t.classList.add(e.clientX < r.left + r.width / 2 ? "ins-l" : "ins-r");
});
grid.addEventListener("drop", e => {
  if (st.drag == null) return; e.preventDefault(); e.stopPropagation();
  const t = e.target.closest(".po-tile"), id = st.drag; st.drag = null;
  if (!t) { draw(); return; }
  const r = t.getBoundingClientRect(), idx = st.items.findIndex(x => x.id === +t.dataset.id);
  commit(moveTo(st.items, id, idx + (e.clientX >= r.left + r.width / 2 ? 1 : 0)));
});
grid.addEventListener("dragend", () => { st.drag = null; $$(".po-tile", grid).forEach(x => x.classList.remove("dragging", "ins-l", "ins-r")); });

async function openFile(file) {
  try {
    const bytes = new Uint8Array(await S3.readFile(file)), doc = await loadLib(bytes);
    let js = null; try { js = await openJs(bytes); } catch (e) { js = null; }
    if (st.js) st.js.destroy();
    gen++; cache.clear(); waiting.clear(); queue = []; busy = false;
    const items = initial(doc);
    Object.assign(st, { name: file.name, base: file.name.replace(/\.pdf$/i, "") || "document", doc, js, items, orig: clone(items), sel: new Set(), undo: [], redo: [], anchor: null, nextId: items.length + 1 });
    $("#fname").textContent = st.name;
    $("#fmeta").textContent = items.length + " page" + (items.length > 1 ? "s" : "") + " · " + S3.fmtBytes(file.size);
    $("#drop").hidden = true; $("#work").hidden = false;
    if (!js) S3.toast("Previews aren't available for this file, but editing works.", "error");
    draw();
  } catch (e) { S3.toast(e.message, "error"); }
}
const fileInput = S3.drop($("#drop"), files => openFile(files[0]), { accept: ".pdf,application/pdf", multiple: false });
$("#change").addEventListener("click", () => fileInput.click());
window.addEventListener("beforeunload", e => { if (st.undo.length) { e.preventDefault(); e.returnValue = ""; } });

$("#save").addEventListener("click", async () => {
  if (!st.items.length) return;
  const b = $("#save"); b.disabled = true;
  try {
    const bytes = await saveDoc(st.doc, st.items);
    S3.download(new Blob([bytes], { type: "application/pdf" }), st.base + "-organized.pdf");
    st.undo = []; st.redo = []; status(); // saved: nothing pending, so no leave-page warning
    S3.toast("Saved " + st.items.length + " pages"); S3.done();
  } catch (e) { S3.toast("Save failed: " + (e && e.message || e), "error"); }
  b.disabled = false;
});

// ---------- sample + self-test ----------
async function samplePdf(n) {
  const d = await PDFDocument.create(), font = await d.embedFont(PDFLib.StandardFonts.HelveticaBold), { rgb } = PDFLib;
  const pal = [rgb(0.05, 0.62, 0.6), rgb(0.4, 0.31, 0.78), rgb(0.89, 0.38, 0.29), rgb(0.95, 0.66, 0.2), rgb(0.2, 0.5, 0.85)];
  for (let i = 1; i <= n; i++) {
    const land = i === 4, p = d.addPage(land ? [841.89, 595.28] : [595.28, 841.89]), W = p.getWidth(), H = p.getHeight();
    p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) });
    p.drawRectangle({ x: 40, y: H - 200, width: W - 80, height: 150, color: pal[(i - 1) % pal.length] });
    p.drawText(String(i), { x: 64, y: H - 160, size: 90, font, color: rgb(1, 1, 1) });
    for (let l = 0; l < 10; l++) p.drawRectangle({ x: 40, y: H - 260 - l * 40, width: W - 120 - ((l * 37) % 90), height: 14, color: rgb(0.86, 0.88, 0.91) });
  }
  if (n >= 6) d.getPage(5).setRotation(degrees(90)); // one scanned-sideways page to fix
  return d.save();
}
window.S3_DEMO = async () => {
  await openFile(new File([await samplePdf(10)], "Scans.pdf", { type: "application/pdf" }));
  const six = st.items[5].id; commit(rotate(st.items, new Set([six]), -90));
  commit(moveTo(st.items, st.items[7].id, 1));
  st.sel = new Set([st.items[3].id]); draw();
  await new Promise(r => setTimeout(r, 900));
};
window.S3_SELFTEST = async () => {
  const d = await PDFDocument.create(); [100, 200, 300].forEach(w => d.addPage([w, 400]));
  const bytes = await d.save(), src = await loadLib(bytes);
  let items = initial(src);
  items = moveTo(items, 3, 0);                       // [3,1,2]
  items = rotate(items, new Set([3]), 90);           // page 3 rotated
  items = remove(items, new Set([2]));               // [3,1]
  items = insertBlank(items, 3, 99);                 // [3,blank,1]
  const mv = moveBy(initial(src), new Set([1]), 1).map(x => x.src).join(); // [1,0,2]
  const out = await PDFDocument.load(await saveDoc(src, items));
  const w = out.getPages().map(p => Math.round(p.getWidth())).join(), r = out.getPages().map(p => p.getRotation().angle).join();
  // the blank copies how page 3 looks on screen (rotated 90 -> 400 wide)
  const js = await openJs(bytes), pg = await js.getPage(1);
  return w === "300,400,100" && r === "90,0,0" && mv === "1,0,2" && items.map(x => x.src).join() === "2,,0" && pg.getViewport({ scale: 1 }).width === 100;
};
