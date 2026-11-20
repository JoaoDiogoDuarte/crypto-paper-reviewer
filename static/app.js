// The reading editor.  The model is the text of each file; the page is
// rendered from it, and edits are committed back to text (commit()) before
// every structural change and every save.  A file is edited exactly when
// its committed text differs from the text read from disk.
'use strict';
// report script errors to the server log (visible in tests and in the terminal)
window.addEventListener('error', (e) => {
  try {
    const t = document.querySelector('meta[name=token]').content;
    fetch('/api/log', { method: 'POST', headers: { 'X-Token': t },
      body: `JSERROR ${e.message} at ${(e.filename || '').split('/').pop()}:${e.lineno}` });
  } catch (_) { /* nothing to do */ }
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const t = document.querySelector('meta[name=token]').content;
    fetch('/api/log', { method: 'POST', headers: { 'X-Token': t }, body: 'JSERROR ' + (e.reason && e.reason.stack || e.reason) });
  } catch (_) { /* nothing to do */ }
});
const L = window.LatexDoc;
const TOKEN = document.querySelector('meta[name=token]').content;
const $ = (s) => document.querySelector(s);
// motion only when the system allows it: a glide becomes a jump
const REDUCED_MOTION = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const SMOOTH = () => (REDUCED_MOTION.matches ? 'auto' : 'smooth');
// Every bar lives in one sticky block (#chrome), so nothing can show between
// them.  Its height, which wraps on narrow screens, is what scrolling must
// keep text clear of (--chrome-height: scroll-padding, the diff map).
function chromeBottom() { return Math.max(0, $('#chrome').getBoundingClientRect().bottom); }
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--chrome-height', Math.ceil($('#chrome').getBoundingClientRect().height) + 'px');
}).observe($('#chrome'));

// Something happened: say so briefly, out of the way (bottom right).
function toast(msg, kind = '') {
  const box = $('#toasts');
  if (!box || !msg) return;
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  box.append(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { t.classList.add('gone'); setTimeout(() => t.remove(), 400); }, kind === 'error' ? 6000 : 2600);
  toast.last = Date.now();
}
// Every button answers a press visibly, even when what it does is elsewhere.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button');
  if (!b || b.disabled) return;
  b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 450);
}, true);
// While a window (paper, history, keys, figure, help, open) is up, the paper
// behind it does not scroll; closing one says so unless it said more itself.
const MODALS = { paperbox: 'Paper', filesbox: 'Files', historybox: 'History', keysbox: 'Keys', figview: 'Figure', helpbox: 'Help', openbox: 'Open', newbox: 'New paper' };
function syncModal() {
  const open = Object.keys(MODALS).some((id) => { const e = document.getElementById(id); return e && !e.hidden; });
  document.documentElement.classList.toggle('modal-open', open);
}
// Keyboard focus follows the dialogs: into one when it opens (its first
// field, else its first button), kept inside it with Tab, and back where it
// was when it closes.
const FOCUSABLE = 'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const shown = (n) => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
function topDialog() {
  const open = [...Object.keys(MODALS), 'external', 'askbox', 'palette'].map((id) => document.getElementById(id)).filter((e) => e && !e.hidden);
  return open.length ? open[open.length - 1] : null;
}
const DIALOG_FOCUS = new Map();   // dialog -> what had the focus before it opened
function dialogOpened(box) {
  const before = document.activeElement;
  if (before && !box.contains(before)) DIALOG_FOCUS.set(box, before);
  requestAnimationFrame(() => {
    if (box.hidden || box.contains(document.activeElement)) return;   // it focused something itself
    const all = [...box.querySelectorAll(FOCUSABLE)].filter(shown);
    const first = all.find((n) => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName)) || all.find((n) => !n.classList.contains('xclose')) || all[0];
    if (first) first.focus({ preventScroll: true });
  });
}
function dialogClosed(box) {
  const back = DIALOG_FOCUS.get(box);
  DIALOG_FOCUS.delete(box);
  if (back && back.isConnected && shown(back) && (!document.activeElement || document.activeElement === document.body || box.contains(document.activeElement))) back.focus({ preventScroll: true });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
  const box = topDialog();
  if (!box) return;
  const all = [...box.querySelectorAll(FOCUSABLE)].filter(shown);
  if (!all.length) return;
  const i = all.indexOf(document.activeElement);
  if (i < 0 || (e.shiftKey && i === 0) || (!e.shiftKey && i === all.length - 1)) {
    e.preventDefault();
    all[e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : (i < 0 || i === all.length - 1 ? 0 : i + 1)].focus();
  }
}, true);
for (const id of [...Object.keys(MODALS), 'external', 'askbox']) {
  const e = document.getElementById(id);
  if (!e) continue;
  e.setAttribute('aria-modal', 'true');
  if (!e.getAttribute('role')) e.setAttribute('role', 'dialog');
  let open = !e.hidden;
  new MutationObserver(() => {
    if (!e.hidden && !open) dialogOpened(e);
    if (e.hidden && open) dialogClosed(e);
    open = !e.hidden;
  }).observe(e, { attributes: true, attributeFilter: ['hidden'] });
}
for (const id of Object.keys(MODALS)) {
  const e = document.getElementById(id);
  if (!e) continue;
  let was = e.hidden;
  new MutationObserver(() => {
    syncModal();
    if (e.hidden && !was) { const at = Date.now(); setTimeout(() => { if (!(toast.last >= at)) toast(MODALS[id] + ' closed'); }, 60); }
    was = e.hidden;
  }).observe(e, { attributes: true, attributeFilter: ['hidden'] });
}

let DOC = null;          // payload of /api/doc: files, aux, macros, bib, figs
const FILES = {};        // name -> { text, base (hash on disk), disk (text on disk), segs }
let ORDER = [];          // display order: segments, each with .file and .el
let lastTyping = 0;
// multiple cursors (see the section of that name): declared here, since a
// render, which drops them, can run before that section is reached
let SNAP_HOLD = false;   // snapshot() waits: the edit under way belongs to the step before
const MC = { cursors: [], primary: null, replaying: false, word: false, dwimBlock: false, kill: null, clip: null, raf: 0, expand: -1, note: '', eatClick: false };
const SMC = { cursors: [], primary: null, shadow: null, kill: null, value: null, raf: 0, word: false, dwimBlock: false, undo: [], redo: [] };
// The diff view rewrites the editable blocks with its own marks: while it is
// shown, the page is not the document, and nothing may read it back.
let DIFF_SHOWN = false;

// ------------------------------------------------------- keeping the place
//
// The page is drawn again after a save, a build, an undo: the reader stays
// at the same block, not the same pixel offset (pictures and formulas above
// take their height only once loaded). The block at the top of the view is
// remembered with its offset, put back, and held there while the page
// settles, unless the reader scrolls meanwhile.
// The place of the view: the blocks on screen, from the top, with where each
// is.  Several, so that the view is held by one the change left as it was
// (holding it by the very block that changed moved the page by a block).
function viewAnchor() {
  const top = typeof chromeBottom === 'function' ? chromeBottom() : 0;
  const segs = (typeof ORDER !== 'undefined' ? ORDER : []).filter((s) => s.el && s.el.isConnected);
  const list = [];
  for (const [i, s] of segs.entries()) {
    const r = s.el.getBoundingClientRect();
    if (!r.height || r.bottom <= top) continue;
    if (r.top > innerHeight) break;
    list.push({ i, file: s.file, src: s.src, top: r.top });
    if (list.length >= 12) break;
  }
  return list.length ? { y: window.scrollY, ...list[0], list } : { y: window.scrollY };
}
let anchorHold = null;
// Only one thing places the view at a time: holding the place after a
// redraw and bringing the phrase read aloud into view each stop the other
// (both fighting gave a jitter).
let revealSeq = 0;
for (const ev of ['wheel', 'touchstart']) addEventListener(ev, () => { revealSeq++; }, { capture: true, passive: true });
function restoreAnchor(a) {
  if (!a) return;
  if (anchorHold) anchorHold();
  revealSeq++;
  // the first block of the list that is still there, the same and only once
  const find = () => {
    const segs = ORDER.filter((s) => s.el && s.el.isConnected);
    for (const c of a.list || [a]) {
      const same = segs.filter((s) => s.file === c.file && s.src === c.src);
      if (same.length === 1) return [same[0], c.top];
    }
    const s = segs[a.i];
    return s && s.file === a.file ? [s, a.top] : null;
  };
  const put = () => {
    const hit = a.top !== undefined && find();
    if (hit) window.scrollBy(0, hit[0].el.getBoundingClientRect().top - hit[1]);
    else window.scrollTo(0, a.y);
  };
  put();
  // hold the place for a moment while images and formulas load
  const ro = new ResizeObserver(put);
  ro.observe($('#doc'));
  const stop = () => {
    ro.disconnect(); clearTimeout(t);
    for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) removeEventListener(ev, stop, true);
    anchorHold = null;
  };
  const t = setTimeout(stop, 3000);
  for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) addEventListener(ev, stop, true);
  anchorHold = stop;
}

// ---------------------------------------------------------------- loading

// Read the document from the server and render it.  Unsaved edits are kept,
// file by file, unless the file is in `discard`: a file edited here keeps its
// old base hash, so that saving it after it changed on disk is refused (and
// asks) instead of overwriting the other version.
async function load(keepScroll, discard = []) {
  const y = viewAnchor();
  const caret = captureEditorState();
  const oldMacros = DOC && JSON.stringify(DOC.macros);
  DOC = await (await fetch('/api/doc')).json();
  // started with no paper named: the start page is the list of recent papers
  // (the last one is loaded behind it; Esc keeps it)
  if (DOC.startPick) setTimeout(() => chooseProjectDirectory(), 0);
  if (oldMacros !== JSON.stringify(DOC.macros)) KATEX_CACHE.clear();
  if (DOC) commit();   // typing while the document was being fetched
  for (const [name, f] of Object.entries(DOC.files)) {
    const cur = FILES[name];
    if (cur && cur.text !== cur.disk && !discard.includes(name)) continue;
    FILES[name] = { text: f.text, disk: f.text, base: f.hash };
  }
  if (!keepScroll) VIEW.apply();   // a newly opened paper, as it was left
  render();
  fillMains();
  restoreEditorState(caret);
  if (keepScroll) restoreAnchor(y);
  setBuild(DOC.build);
  $('#doc').lang = (DOC.config && DOC.config.spell_lang) || 'en-GB';
  showWhere();
  refreshSourceView();
  if (new URLSearchParams(location.search).has('selftest')) selfTest();
  if (!keepScroll) { RESUME.read(); checkDraft(); RESUME.apply(); }   // edits left by a crash; where a reload for new code was
}

function captureEditorState() {
  const selection = getSelection();
  if (!selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const seg = segOf(node);
  if (!seg || !seg.edit || !seg.edit.contains(range.startContainer)) return null;
  // a selection inside one block is kept too (both ends, as offsets)
  if (!selection.isCollapsed && !seg.edit.contains(range.endContainer)) return null;
  const upTo = (c, o) => { const r = document.createRange(); r.selectNodeContents(seg.edit); r.setEnd(c, o); return r.toString().length; };
  const segs = (FILES[seg.file] && FILES[seg.file].segs) || [];
  const state = { file: seg.file, index: segs.indexOf(seg), src: seg.src, offset: upTo(range.startContainer, range.startOffset) };
  if (!selection.isCollapsed) state.end = upTo(range.endContainer, range.endOffset);
  return state;
}

// Put the caret back at the same character of the same block after a
// re-render (the block is found by its place in its file, or by its source).
function restoreEditorState(state) {
  if (!state) return;
  const segs = (FILES[state.file] && FILES[state.file].segs) || [];
  let seg = segs[state.index];
  if (!seg || !seg.edit || seg.edit.tagName === 'TEXTAREA') seg = ORDER.find((item) => item.file === state.file && item.src === state.src && item.edit);
  if (!seg || !seg.edit || seg.edit.tagName === 'TEXTAREA') return;
  const point = (off) => {
    const walker = document.createTreeWalker(seg.edit, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (off <= node.data.length) return [node, off];
      off -= node.data.length;
    }
    return null;
  };
  const a = point(state.offset);
  if (!a) return;
  const range = document.createRange();
  range.setStart(a[0], a[1]);
  const b = state.end !== undefined ? point(state.end) : null;
  if (b) range.setEnd(b[0], b[1]); else range.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  seg.edit.focus({ preventScroll: true });
}

// Segments of a file.  Every file is split at its \input/\include/\subfile
// lines; in the main file, everything up to \begin{document} is one hidden
// segment (inputs there are not shown).
function parseFile(name, textOverride) {
  const text = textOverride !== undefined ? textOverride : FILES[name].text;
  const segs = [];
  let front = name === DOC.main && text.includes('\\begin{document}');
  for (const piece of L.documentPieces(text)) {
    if (piece.input) {
      segs.push({ kind: front ? 'hidden' : 'input', src: piece.text, input: resolveInput(piece.input), file: name });
      continue;
    }
    let t = piece.text;
    if (front) {
      const cut = t.indexOf('\\begin{document}');
      if (cut < 0) { segs.push({ kind: 'hidden', src: t, file: name }); continue; }
      const end = cut + '\\begin{document}'.length;
      segs.push({ kind: 'hidden', src: t.slice(0, end), file: name });
      t = t.slice(end);
      front = false;
    }
    // after \end{document} (LaTeX stops there; a converted file keeps the
    // record of its original there): one hidden block
    let tail = '';
    if (name === DOC.main) {
      const m = /(^|\n)[ \t]*\\end\{document\}/.exec(t);
      if (m) { tail = t.slice(m.index + m[1].length); t = t.slice(0, m.index + m[1].length); }
    }
    for (const s of L.segment(t)) segs.push({ ...s, file: name });
    if (tail) segs.push({ kind: 'hidden', src: tail, file: name });
  }
  return segs;
}

// Line numbers (1-based) of every segment, for SyncTeX pages.
function assignLines(segs) {
  let line = 1;
  for (const sg of segs) {
    sg.line = line;
    line += (sg.src.match(/\n/g) || []).length;
    sg.lastLine = line;
  }
  return segs;
}

function resolveInput(raw) {
  raw = raw.trim();
  return DOC.resolve[raw] || (FILES[raw] ? raw : FILES[raw + '.tex'] ? raw + '.tex' : null);
}

// The configuration of the document: theorem environments, code
// environments, heading numbers from the .aux.
function configure() {
  L.THM_ENVS.clear();
  for (const env of Object.keys(DOC.theorems || {})) L.THM_ENVS.add(env);
  L.setCodeEnvs((DOC.config || {}).code_envs);
  HEADS = {};
}
// The heading numbers LaTeX printed, by level in document order.  They are
// used only while the numbered headings of the source come in the same
// levels and order as in the .aux: after a heading is added, deleted or
// moved and before the next build, the k-th subsection of the source is not
// the k-th of the .aux, and the numbers are counted on the page instead.
// Entries without a number (References, \addcontentsline) are not headings
// of the source and are left out.
function auxHeads() {
  const aux = (DOC.aux.heads || []).filter((h) => h.num);
  const src = [];
  const walk = (name) => {
    for (const seg of FILES[name].segs || []) {
      if (seg.kind === 'input') { if (FILES[seg.input]) walk(seg.input); continue; }
      if (seg.kind !== 'heading') continue;
      const h = L.headingParts(seg.src);
      if (h && !h.star) src.push(h.level);
    }
  };
  walk(DOC.main);
  const heads = {};
  if (src.length !== aux.length || aux.some((h, i) => h.level !== src[i])) return heads;
  for (const h of aux) (heads[h.level] = heads[h.level] || []).push(h.num);
  return heads;
}
let HEADS = {};

// ---------------------------------------------------------------- rendering

// Blocks drawn before are kept when nothing they depend on changed: the same
// source, the same numbering state before them (section and theorem counters,
// open environments and lists), the same .aux, macros and figures, and not
// edited on the page since.  An undo or a save then redraws only the blocks
// it changed (the others keep their pictures, formulas and place).
// The first block of every file but the main one: its file's name, which
// opens the file's menu (source, rename, put back) and shows in Structure.
function fileBadge(node, name) {
  const tools = node.querySelector(':scope > .tools');
  let b = tools && tools.querySelector(':scope > .filetool');
  node.classList.toggle('file-start', !!name);
  if (name) node.dataset.file = name; else delete node.dataset.file;
  if (!name) { if (b) b.remove(); return; }
  if (!tools) return;
  if (!b) { b = el('button', 'filetool'); tools.prepend(b); }
  b.textContent = name.replace(/^.*\//, '') + (isNewFile(name) ? ' \u2022' : '');
  b.title = name + (isNewFile(name) ? ' (new, not saved yet)' : '') + ': its menu';
  b.onclick = (e) => { e.stopPropagation(); fileMenu(name, b); };
}
let RENDER_CACHE = new Map();    // key -> [{ el, seg, after }]
let RENDER_STAMP = '';
// The cursors point into the blocks drawn before: they are taken over to the
// new ones whose text is the same (a build, an outside change, a save), and
// dropped where it is not.
function render() {
  const cursors = mcBeforeRender();
  renderPage();
  mcAfterRender(cursors);
}
function renderPage() {
  unicodeEngine.v = undefined;      // the preamble may have changed
  if (DIFF_SHOWN) diffSync();       // the block edited in the diff view, into its file
  const wasDiff = DIFF_SHOWN;
  DIFF_SHOWN = false;
  const speech = typeof TTS !== 'undefined' ? TTS.detach() : null;
  flushEdits();
  const stamp = JSON.stringify([DOC.aux, DOC.figs, DOC.macros, DOC.theorems, DOC.config, DOC.main, Object.keys(DOC.bib || {}).length]);
  let old = RENDER_CACHE;
  // after a build (new numbers, figures, macros) every block is drawn again,
  // but one that comes out the same keeps its element: its measured height
  // stays, and nothing above the view moves
  const stale = !wasDiff && stamp !== RENDER_STAMP ? old : null;
  if (wasDiff || stamp !== RENDER_STAMP) old = new Map();
  RENDER_STAMP = stamp;
  RENDER_CACHE = new Map();
  const reusable = (o) => o.el && o.seg.src === o.src && !o.seg.touched && !o.seg.removed && o.seg.figSrc === undefined && o.seg.patched === undefined;
  const doc = $('#doc');
  if (anchorHold) anchorHold();   // a view held for an earlier redraw is not this one's
  // the page is not emptied: blocks drawn before stay where they are and
  // only what changed moves (layoutPages).  A block taken out and put back
  // loses its measured height (content-visibility), so emptying the page
  // made everything above the view change size and the view jump.
  ORDER = [];
  configure();
  const ctx = { sec: 0, sub: 0, subsub: 0, app: false, counters: {}, heads: {}, env: [] };
  for (const name of Object.keys(FILES)) FILES[name].segs = assignLines(parseFile(name));
  HEADS = auxHeads();
  const title = documentTitle(FILES[DOC.main].text);
  let h1 = doc.querySelector(':scope > h1.doctitle');
  if (title) {
    const h = el('h1', 'doctitle');
    renderMathless(title.replace(/\\\\(\[[^\]]*\])?/g, ' '), h);
    if (!h1 || h1.innerHTML !== h.innerHTML) { if (h1) h1.replaceWith(h); else doc.prepend(h); h1 = h; }
    $('#title').textContent = h.textContent;
    showWhere();
  } else if (h1) h1.remove();
  const walk = (name) => {
    let first = name !== DOC.main;
    for (const seg of FILES[name].segs) {
      if (seg.kind === 'input') { if (FILES[seg.input]) walk(seg.input); continue; }
      ORDER.push(seg);
      if (seg.kind === 'gap' || seg.kind === 'hidden') continue;
      // a heading's number also depends on whether the .aux numbers apply
      const key = seg.kind + '\u0000' + seg.src + '\u0000' + JSON.stringify(ctx) + (seg.kind === 'heading' ? '\u0000' + !!Object.keys(HEADS).length : '');
      const list = old.get(key);
      const k = list ? list.findIndex(reusable) : -1;
      let node, after;
      if (k >= 0) {
        const hit = list.splice(k, 1)[0];
        node = hit.el; after = hit.after;
        for (const p of ['edit', 'parts', 'wide']) if (hit.seg[p] !== undefined) seg[p] = hit.seg[p];
        node.seg = seg;
        Object.assign(ctx, JSON.parse(after));
        seg.fresh = false;
      } else {
        node = renderSeg(seg, ctx);
        after = JSON.stringify(ctx);
        seg.fresh = true;
        const same = node && stale && stale.get(key);
        const j = same ? same.findIndex((o) => reusable(o) && o.el.innerHTML === node.innerHTML) : -1;
        if (j >= 0) {
          const hit = same.splice(j, 1)[0];
          for (const p of ['edit', 'parts', 'wide']) if (hit.seg[p] !== undefined) seg[p] = hit.seg[p];
          node = hit.el;
          node.seg = seg;
          seg.fresh = false;
        }
      }
      if (!node) continue;
      seg.el = node;
      fileBadge(node, first ? name : null);
      first = false;
      if (!RENDER_CACHE.has(key)) RENDER_CACHE.set(key, []);
      RENDER_CACHE.get(key).push({ el: node, seg, after, src: seg.src });
    }
  };
  walk(DOC.main);
  layoutPages(doc);
  watchEdits();
  markEdited();
  markBoxes();
  if (speech) TTS.reattach(speech);
}

// Overfull and underfull boxes of the last build (from its .log, by file and
// line): a badge on each block concerned, and a count beside the build state
// that steps through them.
let BOXES = [];
function markBoxes(list) {
  if (list) {
    const key = JSON.stringify(list);
    if (key === markBoxes.key && document.querySelector('#boxsum')) return;
    markBoxes.key = key; BOXES = list;
  }
  for (const b of document.querySelectorAll('#doc .boxbadge')) b.remove();
  for (const e of document.querySelectorAll('#doc .seg.boxwarn')) e.classList.remove('boxwarn');
  let over = 0, under = 0;
  for (const seg of ORDER) {
    if (!seg.el || !seg.file || seg.line === undefined) continue;
    const hits = BOXES.filter((b) => b.file === seg.file && b.from != null && b.to >= seg.line && b.from <= (seg.lastLine || seg.line));
    if (!hits.length) continue;
    const o = hits.filter((b) => b.kind === 'overfull');
    over += o.length; under += hits.length - o.length;
    seg.el.classList.add('boxwarn');
    const worst = o.length ? o.reduce((a, b) => (parseFloat(b.amount) > parseFloat(a.amount) ? b : a)) : hits[0];
    const badge = el('span', 'boxbadge ' + (o.length ? 'over' : 'under'),
      o.length ? '↔ ' + parseFloat(worst.amount).toFixed(1) + 'pt too wide' : worst.amount.replace(/^badness /, 'badness '));
    if (hits.length > 1) badge.textContent += ` (+${hits.length - 1})`;
    badge.title = hits.map((b) => `${b.kind === 'overfull' ? 'Overfull' : 'Underfull'} \\${b.box} (${b.amount}), ${b.file} line${b.from === b.to ? ' ' + b.from : 's ' + b.from + '–' + b.to}`).join('\n');
    badge.contentEditable = 'false';
    seg.el.append(badge);
  }
  let sum = document.querySelector('#boxsum');
  if (!sum && $('#build')) {
    sum = el('button', '', ''); sum.id = 'boxsum'; sum.type = 'button';
    sum.title = 'Overfull and underfull boxes in the last build: click to go to the next one';
    sum.onclick = () => {
      const marked = [...document.querySelectorAll('#doc .seg.boxwarn')];
      if (!marked.length) return;
      navPush();
      markBoxes.at = ((markBoxes.at ?? -1) + 1) % marked.length;
      marked[markBoxes.at].scrollIntoView({ block: 'center', behavior: SMOOTH() });
      marked[markBoxes.at].classList.add('boxflash');
      setTimeout(() => marked[markBoxes.at] && marked[markBoxes.at].classList.remove('boxflash'), 900);
    };
    $('#build').after(sum);
  }
  if (sum) {
    const parts = [over && `${over} overfull`, under && `${under} underfull`].filter(Boolean);
    sum.textContent = parts.length ? parts.join(', ') + ' box' + (over + under > 1 ? 'es' : '') : '';
    sum.hidden = !parts.length;
  }
}

// Pages: from SyncTeX (the page each source line went to), or estimated from
// the amount of text per page for the class.  Each page is its own box, so in
// two columns typing rebalances one page, not the whole paper.
const CHARS_PER_PAGE = { IEEEtran: 6500, llncs: 2700, iacrcc: 3000, acmart: 6000, article: 3300 };
function layoutPages(doc) {
  // Two-column review mode flows the source naturally, rather than copying
  // SyncTeX page breaks whose figures and columns can leave blank halves.
  const flowing = document.body.classList.contains('two');
  const exact = !flowing && DOC.pages && Object.keys(DOC.pages).length > 0;
  // without SyncTeX (a Makefile build): the page of the PDF whose text holds
  // the start of the block's text
  const pdfText = !flowing && !exact && (DOC.pdftext || []).length > 1 ? DOC.pdftext : null;
  let pdfAll = '', pdfStarts = [], pdfAt = 0;
  if (pdfText) for (const t of pdfText) { pdfStarts.push(pdfAll.length); pdfAll += t; }
  const pdfPageOf = (i) => { let k = 0; while (k + 1 < pdfStarts.length && pdfStarts[k + 1] <= i) k++; return k + 1; };
  const cls = (DOC.docclass || 'article').split('/')[0];
  const twoCol = cls === 'IEEEtran' || /twocolumn/.test(DOC.docclass || '');
  const perPage = Math.round((CHARS_PER_PAGE[cls] || 3300) * (flowing ? 1.55 : 1));
  let page = 1, chars = 0, last = 0, box = null, at = null;
  // the page boxes drawn before are kept (and with them the measured
  // heights of their blocks); a block is moved only when it is not already
  // where it goes
  const old = new Map();
  for (const s of doc.querySelectorAll(':scope > section.page')) if (!old.has(s.dataset.page)) old.set(s.dataset.page, s);
  let prevBox = doc.querySelector(':scope > h1.doctitle');
  const used = new Set();
  const startPage = (n) => {
    const label = flowing ? 'review spread ' + n : (exact || pdfText ? 'page ' : 'approx. page ') + n;
    box = old.get(String(n));
    old.delete(String(n));
    if (!box) { box = el('section', 'page'); box.dataset.page = n; box.append(el('div', 'pagemark', label)); }
    else if (box.firstElementChild && box.firstElementChild.textContent !== label) box.firstElementChild.textContent = label;
    const want = prevBox ? prevBox.nextElementSibling : doc.firstElementChild;
    if (want !== box) doc.insertBefore(box, want);
    used.add(box);
    prevBox = box;
    at = box.firstElementChild ? box.firstElementChild.nextElementSibling : null;
  };
  const live = new Set(ORDER.filter((s) => s.el).map((s) => s.el));
  const place = (node) => {
    // a block no longer drawn (the old version of one that changed) is
    // stepped over: inserting before it would move every block after it
    while (at && !live.has(at)) at = at.nextElementSibling;
    if (at === node) { at = node.nextElementSibling; return; }
    box.insertBefore(node, at);
  };
  for (const seg of ORDER) {
    if (!seg.el) continue;
    if (exact) {
      const lines = DOC.pages[seg.file] || [];
      const hit = lines.find(([ln]) => ln >= seg.line && ln <= seg.lastLine);
      if (hit) page = Math.max(page, hit[1]);
    } else if (pdfText) {
      const letters = seg.edit && seg.edit.tagName !== 'TEXTAREA' ? pageProbe(seg.edit) : '';
      // its start first; then its middle and end, so that a block edited
      // near its start (not in the PDF yet) keeps its page, and the page
      // marks (and the view) do not move as you type or undo
      found: for (const len of [40, 24]) {
        if (letters.length < len) continue;
        for (const from of [0, Math.floor((letters.length - len) / 2), letters.length - len]) {
          const i = pdfAll.indexOf(letters.slice(from, from + len), pdfAt);
          if (i >= 0 && pdfPageOf(i) <= page + 3) {
            page = Math.max(page, pdfPageOf(i));
            if (from === 0) pdfAt = i;
            break found;
          }
        }
      }
    } else {
      const size = seg.kind === 'figure' || seg.kind === 'table'
        ? (seg.wide ? 0.5 : (twoCol ? 0.25 : 0.4)) * perPage
        : (seg.edit && seg.edit.textContent ? seg.edit.textContent.length : 200);
      if (chars + size > perPage * page) page = Math.floor((chars + size) / perPage) + 1;
      chars += size;
    }
    if (!box || page !== last) {
      const prev = box;
      startPage(page); last = page;
      // a heading never ends a page: it moves on with the block it heads
      // (in the PDF a float such as figure* can push that block over)
      // (nor does a heading followed only by blocks that print nothing, its \label)
      const quiet = (e) => e.seg && (e.seg.kind === 'para' || e.seg.kind === 'quote') && e.seg.edit && e.seg.edit.classList.contains('quiet');
      const tails = [];
      for (let t = prev && prev.lastElementChild; t && t.seg && (t.seg.kind === 'heading' || quiet(t)); t = t.previousElementSibling) tails.unshift(t);
      const h = tails.findIndex((t) => t.seg.kind === 'heading');
      if (h >= 0) for (const t of tails.slice(h)) { place(t); t.seg.page = page; }
    }
    seg.page = page;
    place(seg.el);
  }
  // what is no longer drawn: blocks gone (or left in a box by a move), the
  // boxes of pages that no longer have blocks, the marks of a diff
  for (const b of [...doc.children]) {
    if (b.matches('h1.doctitle')) continue;
    if (!used.has(b)) { b.remove(); continue; }
    for (const c of [...b.children].slice(1)) if (!live.has(c)) c.remove();
  }
}

// The letters of a block's text as the PDF has them (maths, hidden LaTeX and
// list marks left out), for finding its page in the PDF's text.
function pageProbe(root) {
  let t = '';
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { t += n.data; continue; }
      if (n.nodeType !== 1) continue;
      const cl = n.classList;
      if (cl.contains('hidden') || cl.contains('math') || cl.contains('tools') || cl.contains('boxbadge') || cl.contains('itemmark') || cl.contains('envmark') && cl.contains('hidden')) continue;
      if (n.dataset.say !== undefined) { t += n.dataset.say.replace(/\s+/g, ''); continue; }
      walk(n);
    }
  };
  walk(root);
  return t.normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '');
}

// Mark a block as touched when anything inside it changes, however it was
// changed (typing, a chip edit, find and replace, a join); untouched blocks
// are not re-serialized.
let EDIT_OBSERVER = null;
function markTouched(records) {
  for (const r of records) {
    const n = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    const seg = n && segOf(n);
    if (seg) seg.touched = true;
  }
}
// The observer reports changes later (a microtask): code that changes the
// page and reads it back at once takes the pending reports first.
function flushEdits() { if (EDIT_OBSERVER) markTouched(EDIT_OBSERVER.takeRecords()); }
function watchEdits() {
  if (EDIT_OBSERVER) EDIT_OBSERVER.disconnect();
  EDIT_OBSERVER = new MutationObserver(markTouched);
  EDIT_OBSERVER.observe($('#doc'), { subtree: true, childList: true, characterData: true });
}

function documentTitle(text) {
  // comments out first, and the offsets below are offsets of that text
  text = text.replace(/(^|[^\\])%.*$/gm, '$1');
  const m = /\\title\s*(\[)?/.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length - (m[1] ? 1 : 0);
  if (text[i] === '[') i = L.groupEnd(text, i);
  while (text[i] === ' ' || text[i] === '\n') i++;
  if (text[i] !== '{') return null;
  const e = L.groupEnd(text, i);
  return e > 0 ? text.slice(i + 1, e - 1) : null;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderSeg(seg, ctx) {
  switch (seg.kind) {
    case 'gap': case 'hidden': return null;
    case 'para': return renderPara(seg, ctx);
    case 'quote': return renderQuote(seg, ctx);
    case 'heading': return renderHeading(seg, ctx);
    case 'code': return renderCode(seg);
    case 'figure': case 'table': return renderFloat(seg);
    default: return null;
  }
}

function wrapSeg(seg, inner, tools) {
  const box = el('div', 'seg ' + seg.kind);
  box.append(inner);
  const t = el('div', 'tools');
  const plus = el('button', '', '+');
  plus.title = 'Add after this block (Ctrl+Alt+A)';
  plus.onclick = (e) => { e.stopPropagation(); addMenu(box.seg, plus); };   // box.seg: a kept block gets the new segment
  t.append(plus);
  for (const b of tools || []) t.append(b);
  // a heading has its own Delete; a block that shows no text has none
  if (seg.kind !== 'heading' && BLOCK_NAMES[seg.kind] && !inner.classList.contains('quiet')) t.append(deleteButton(seg, box));
  box.append(t);
  box.seg = seg;
  return box;
}

// A line break of the source is a space, except where a printed line starts:
// at the start of the paragraph, or after a displayed formula or a block.
// There it would push the first letter in; it is kept (for saving) but not shown.
function quietLeadingBreaks(root) {
  let after = true;   // at the start of a line
  for (const n of root.childNodes) {
    if (n.nodeType === 3) { if (n.data.trim()) after = false; continue; }
    if (n.nodeType !== 1) continue;
    const cl = n.classList;
    if (cl.contains('nl')) { cl.toggle('lead', after); continue; }
    if (cl.contains('hidden')) continue;
    after = cl.contains('display') || cl.contains('parbreak') || n.tagName === 'DIV' || (cl.contains('listing')) || endsInDisplay(n);
  }
}
// a {...} group whose last shown part is a displayed formula: {\setlength{..}{..}\begin{multline}...\end{multline}}
function endsInDisplay(n) {
  if (!n.classList.contains('chip')) return false;
  for (let k = n.lastChild; k; k = k.previousSibling) {
    if (k.nodeType === 3) { if (k.data.trim()) return false; continue; }
    if (k.nodeType !== 1 || k.classList.contains('hidden') || k.classList.contains('nl')) continue;
    return k.classList.contains('display');
  }
  return false;
}

function renderPara(seg, ctx) {
  const p = el('div', 'para');
  p.contentEditable = 'true';
  const toks = L.tokenize(seg.src);
  // italic theorem bodies: an open theorem environment carries over
  if (ctx.env.length && L.THM_ENVS.has(ctx.env[ctx.env.length - 1])) p.classList.add('thm');
  renderTokens(toks, p, ctx);
  quietLeadingBreaks(p);
  if (toks.some((t) => t.t === 'env' && t.mode === 'begin' && L.THM_ENVS.has(t.env))) p.classList.add('thm');
  const visible = [...p.childNodes].some((n) => n.nodeType === 3 ? n.data.trim() : !(n.classList.contains('hidden') || n.classList.contains('nl')));
  if (!visible) { p.classList.add('quiet'); p.contentEditable = 'false'; }
  seg.edit = p;
  return wrapSeg(seg, p);
}

// A quote or quotation environment is a block of its own, shown as a block
// quote indented as LaTeX prints it.  The \begin/\end stay hidden chips, so
// an edited quote still saves back with its exact source.
function renderQuote(seg, ctx) {
  const env = (/^\s*\\begin\{([^}]+)\}/.exec(seg.src) || [])[1];
  const q = el('blockquote', 'para' + (env === 'quotation' ? ' quotation' : ''));
  q.contentEditable = 'true';
  // italic theorem bodies: an open theorem environment carries over
  if (ctx.env.length && L.THM_ENVS.has(ctx.env[ctx.env.length - 1])) q.classList.add('thm');
  renderTokens(L.tokenize(seg.src), q, ctx);
  const visible = [...q.childNodes].some((n) => n.nodeType === 3 ? n.data.trim() : !(n.classList.contains('hidden') || n.classList.contains('nl')));
  if (!visible) { q.classList.add('quiet'); q.contentEditable = 'false'; }
  seg.edit = q;
  return wrapSeg(seg, q);
}

function renderHeading(seg, ctx) {
  const h = L.headingParts(seg.src);
  if (!h) return renderPara({ ...seg, kind: 'para' }, ctx);
  const tag = { part: 'h2', chapter: 'h2', section: 'h2', subsection: 'h3', subsubsection: 'h4' }[h.level];
  const node = el(tag, 'heading');
  let num = '';
  if (!h.star) {
    // the number LaTeX printed (.aux table of contents), in document order
    const k = ctx.heads[h.level] = (ctx.heads[h.level] || 0) + 1;
    const fromAux = (HEADS[h.level] || [])[k - 1];
    if (h.level === 'section') { ctx.sec++; ctx.sub = 0; }
    if (h.level === 'subsection') { ctx.sub++; ctx.subsub = 0; }
    if (h.level === 'subsubsection') ctx.subsub++;
    if (fromAux !== undefined) num = fromAux;
    else if (h.level === 'section') num = ctx.app ? String.fromCharCode(64 + ctx.sec) : String(ctx.sec);
    else if (h.level === 'subsection') num = `${ctx.app ? String.fromCharCode(64 + ctx.sec) : ctx.sec}.${ctx.sub}`;
    else if (h.level === 'subsubsection') num = `${ctx.app ? String.fromCharCode(64 + ctx.sec) : ctx.sec}.${ctx.sub}.${ctx.subsub}`;
    if (num && !/[.:]$/.test(num)) num += '.';
  }
  if (num) node.append(el('span', 'num', num));
  const t = el('span', 'htitle');
  t.contentEditable = 'true';
  renderTokens(L.tokenize(h.title), t, ctx);
  node.append(t);
  // its \label, for the structure view
  for (const m of (h.prefix + h.suffix).matchAll(/\\label\{[^}]*\}/g)) {
    const tag = el('span', 'hlabel');
    tag.dataset.src = m[0];
    tag.contentEditable = 'false';
    node.append(tag);
  }
  seg.edit = t;
  seg.parts = h;
  const del = el('button', '', 'Delete');
  del.title = 'Delete this heading, Ctrl+Alt+X (keeps the text under it)';
  // the segment of the block when clicked (a block kept by render() gets a new one)
  const cur = (e) => segOf(e.target) || seg;
  del.onclick = (e) => { e.stopPropagation(); const sg = cur(e); if (confirm('Delete this heading?' + labelWarning(sg))) structural(() => removeSeg(sg)); };
  const up = el('button', '', 'Up');
  up.title = 'Move this section up (Ctrl+Alt+Up)';
  up.onclick = (e) => { e.stopPropagation(); moveSection(cur(e), -1); };
  const down = el('button', '', 'Down');
  down.title = 'Move this section down (Ctrl+Alt+Down)';
  down.onclick = (e) => { e.stopPropagation(); moveSection(cur(e), 1); };
  const merge = el('button', '', 'Merge');
  merge.title = 'Merge with the previous heading of this level (Ctrl+Alt+J; into this one from the next: Ctrl+Alt+Shift+J)';
  merge.onclick = (e) => { e.stopPropagation(); mergeHeading(cur(e)); };
  const tofile = el('button', '', 'To file');
  tofile.title = 'Move this section into a file of its own under sections/ (Ctrl+Alt+Y)';
  tofile.onclick = (e) => { e.stopPropagation(); splitToFile(cur(e)); };
  const tools = [up, down, merge, del];
  if (HEADING_RANK[h.level] <= SECTION_RANK_MAX) tools.splice(3, 0, tofile);
  return wrapSeg(seg, node, tools);
}

// Removing a heading removes its \label too: say how many references break
function labelWarning(seg) {
  const keys = [...seg.src.matchAll(/\\label\{([^}]*)\}/g)].map((m) => m[1]);
  if (!keys.length) return '';
  commit();
  let n = 0;
  for (const f of Object.values(FILES)) for (const m of (f.text || '').matchAll(/\\(?:[cC]ref|v?ref|autoref|eqref|nameref|pageref)\*?\{([^}]*)\}/g))
    n += m[1].split(',').filter((k) => keys.includes(k.trim())).length;
  return n ? `\n\nIts label (${keys.join(', ')}) is referenced ${n} time${n === 1 ? '' : 's'}; those references will show ?? (Undo brings it back).` : '';
}

// ------------------------------------------------------ the question box
//
// A question with several answers (confirm() has two): resolves to the
// label of the button pressed, or null on Esc, and to whether the optional
// box was ticked.
function ask({ title, text, option, buttons }) {
  const box = $('#askbox');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text || '';
  $('#ask-option').hidden = !option;
  $('#ask-check').checked = false;
  $('#ask-check-label').textContent = option || '';
  const acts = $('#ask-actions');
  acts.textContent = '';
  return new Promise((resolve) => {
    const done = (choice) => { box.hidden = true; box.removeEventListener('keydown', keys, true); resolve({ choice, option: !!option && $('#ask-check').checked }); };
    const keys = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    for (const label of buttons) {
      const b = el('button', '', label);
      b.onclick = (e) => { e.stopPropagation(); done(label); };
      acts.append(b);
    }
    box.addEventListener('keydown', keys, true);
    box.hidden = false;
  });
}

// --------------------------------------------------------- merging headings
//
// Merging heading H into the previous heading P of the same level: H's
// heading goes, its text and its children follow P's last child, and its
// \label moves to P's heading, so references to H print P's number.  With
// the option, H stays as a heading one level down, and so does everything
// under it.  When H is a file of its own read right after P's, the files
// can be merged too: H's file goes to the trash on the next save.
const LEVELS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];
const TRASH_ON_SAVE = new Set();   // files merged into another: trashed on save if nothing reads them

// The headings of the document in reading order (a file's at its \input).
function documentHeadings() {
  const out = [], seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !FILES[name] || !FILES[name].segs) return;
    seen.add(name);
    for (const s of FILES[name].segs) {
      if (s.removed) continue;
      if (s.kind === 'heading' && headingRank(s) !== null) out.push(s);
      else if (s.kind === 'input' && s.input) visit(s.input);
    }
  };
  visit(DOC.main);
  return out;
}
const headingTitle = (seg) => plainOfLatex((L.headingParts(segSource(seg, [])) || {}).title || '');
// The heading H merges into, or the reason it cannot.
function mergeTarget(h) {
  const heads = documentHeadings();
  const i = heads.indexOf(h), rank = headingRank(h);
  if (i < 0 || rank === null) return { why: 'Put the cursor in a heading for that' };
  for (let j = i - 1; j >= 0; j--) {
    const r = headingRank(heads[j]);
    if (r < rank) return { why: `This is the first ${LEVELS[rank]} of its ${LEVELS[r]}: there is no ${LEVELS[rank]} before it to merge into` };
    if (r === rank) return { into: heads[j] };
  }
  return { why: `This is the first ${LEVELS[rank]} of the document: there is nothing before it to merge into` };
}
// The heading after H of its level, in the same parent, if any.
function nextSameLevel(h) {
  const heads = documentHeadings();
  const i = heads.indexOf(h), rank = headingRank(h);
  for (let j = i + 1; j < heads.length; j++) {
    const r = headingRank(heads[j]);
    if (r < rank) return null;
    if (r === rank) return heads[j];
  }
  return null;
}
const noComments = (src) => src.replace(/(^|[^\\])%.*$/gm, '$1');
// The \label of a heading: on its line, or alone at the start of the block
// after it.  Returns the labels and the block that holds the second kind.
function headingLabels(h) {
  const keys = [...h.src.matchAll(/\\label\{([^}]*)\}/g)].map((m) => m[0]);
  const segs = FILES[h.file].segs;
  let k = segs.indexOf(h) + 1;
  while (segs[k] && (segs[k].kind === 'gap' || segs[k].removed)) k++;
  const after = segs[k] && segs[k].kind === 'para' && /^\s*\\label\{[^}]*\}/.exec(segs[k].src);
  return { labels: after ? [...keys, after[0].trim()] : keys, after: after ? segs[k] : null };
}
// How the files can be merged: { how: 'inline', inp } when P is in the file
// that reads H's file, { how: 'append', inp, from, between } when P's file
// is read just before it, or { why } when they cannot.
function fileMerge(h, p) {
  if (h.file === p.file) return null;
  if (!sectionIsWholeFile(h)) return { why: `${h.file} holds more than this ${LEVELS[headingRank(h)]}, so only the heading can go` };
  const inp = inputSegOf(h.file);
  if (!inp) return { why: `${h.file} is not read by \\input` };
  if (inp.file === p.file) return { how: 'inline', inp };
  const pin = inputSegOf(p.file);
  const segs = FILES[inp.file].segs;
  if (!pin || pin.file !== inp.file || segs.indexOf(pin) > segs.indexOf(inp)) return { why: `${p.file} and ${h.file} are not read one after the other` };
  const tail = FILES[p.file].segs.slice(FILES[p.file].segs.indexOf(p));
  if (fixedIn(tail)) return { why: `${p.file} ends with the bibliography, \\appendix or the end of the document` };
  const from = segs.indexOf(pin) + 1, to = segs.indexOf(inp);
  const between = segs.slice(from, to).filter((s) => !s.removed && s.kind !== 'gap');
  if (fixedIn(between)) return { why: `the bibliography, \\appendix or the end of the document is between the two files` };
  return { how: 'append', inp, from, to, between: between.map((s) => s.src).join('\n\n').trim() };
}
// One level down: \section to \subsection, ..., \subsubsection to \paragraph.
function demoteHeadings(segs, seen = new Set()) {
  for (const s of segs) {
    if (s.removed) continue;
    if (s.kind === 'heading') s.src = s.src.replace(/^\\(part|chapter|section|subsection|subsubsection)(?![A-Za-z])/, (_, l) => '\\' + LEVELS[LEVELS.indexOf(l) + 1]);
    else if (s.kind === 'input' && s.input && FILES[s.input] && FILES[s.input].segs && !seen.has(s.input)) { seen.add(s.input); demoteHeadings(FILES[s.input].segs, seen); }
  }
}

async function mergeHeading(h, direction = -1) {
  if (!h || h.kind !== 'heading') { toast('Put the cursor in a heading for that', 'error'); return; }
  if (direction > 0) {
    const n = nextSameLevel(h);
    if (!n) { toast(`This is the last ${LEVELS[headingRank(h)]} of its part of the document: there is nothing after it to merge`, 'error'); return; }
    h = n;
  }
  const t = mergeTarget(h);
  if (!t.into) { toast(t.why, 'error'); return; }
  const p = t.into, rank = headingRank(h);
  if (h.file === p.file) {
    const segs = FILES[h.file].segs;
    if (fixedIn(segs.slice(segs.indexOf(p) + 1, segs.indexOf(h)))) { toast('The bibliography, \\appendix or the end of the document lies between the two headings', 'error'); return; }
  }
  commit();
  const hTitle = headingTitle(h), pTitle = headingTitle(p);
  const { labels, after } = headingLabels(h);
  const keys = labels.map((l) => /\{([^}]*)\}/.exec(l)[1]);
  let refs = 0;
  for (const f of Object.values(FILES)) for (const m of (f.text || '').matchAll(/\\(?:[cC]ref|v?ref|autoref|nameref|pageref)\*?\{([^}]*)\}/g))
    refs += m[1].split(',').filter((k) => keys.includes(k.trim())).length;
  const lines = [];
  if (refs) lines.push(`${refs} reference${refs === 1 ? '' : 's'} to ${keys.join(', ')} will print the number of "${pTitle}" (unless "${hTitle}" is kept as a ${LEVELS[rank + 1]}).`);
  const fm = fileMerge(h, p);
  if (fm) {
    lines.push(`The two are in different files (${p.file} and ${h.file}).`);
    if (fm.why) lines.push(`The files cannot be merged: ${fm.why}.`);
    else if (fm.between) lines.push(`Between the two files there is:\n${fm.between.slice(0, 300)}\nMerging the files puts it before the text of "${hTitle}".`);
    else if (fm.how === 'append') lines.push(`Merging the files appends ${h.file} to ${p.file}; ${h.file} goes to the editor's trash on saving.`);
    else lines.push(`Merging the files puts the text of ${h.file} where it is read in ${p.file}; ${h.file} goes to the editor's trash on saving.`);
    if (/^\\include\{/.test(fm.inp ? fm.inp.src.trim() : '') && !fm.why) lines.push('It is read by \\include: the page break before it goes away if the files are merged.');
  }
  const canKeep = rank + 1 < LEVELS.length;
  if (!canKeep) lines.push(`"${hTitle}" cannot stay as a heading: there is no level below \\${LEVELS[rank]}.`);
  const buttons = fm ? [...(fm.why ? [] : ['Also merge the files']), 'Keep the files', 'Cancel'] : ['Merge', 'Cancel'];
  const a = await ask({
    title: `Merge "${hTitle}" into "${pTitle}"`,
    text: lines.join('\n\n'),
    option: canKeep ? `Keep "${hTitle}" as a ${LEVELS[rank + 1]} of "${pTitle}"` : null,
    buttons,
  });
  if (!a.choice || a.choice === 'Cancel') return;
  const files = a.choice === 'Also merge the files';
  structural(() => {
    // with the files merged, H's file is read for its text and then left as
    // it is on disk (it is not saved, only moved to the trash)
    const hsegs = FILES[h.file].segs;
    const kept = files ? hsegs.map((s) => [s, s.src, s.removed]) : null;
    if (a.option) {
      // H stays, one level down, with everything under it
      if (fm && sectionIsWholeFile(h)) demoteHeadings(FILES[h.file].segs);
      else { const segs = FILES[h.file].segs, i = segs.indexOf(h); demoteHeadings(segs.slice(i, sectionEnd(segs, i, rank))); }
    } else {
      // its labels go to P's heading line, and the heading goes
      if (after) after.src = after.src.replace(/^\s*\\label\{[^}]*\}[ \t]*\n?/, '');
      if (labels.length) p.src = p.src.replace(/\s*$/, '') + labels.join('');
      removeSeg(h);
    }
    if (!files) return;
    const body = hsegs.filter((s) => !s.removed).map((s) => s.src).join('').trim();
    for (const [s, src, removed] of kept) { s.src = src; s.removed = removed; }
    if (fm.how === 'inline') fm.inp.src = body;
    else {
      const segs = FILES[fm.inp.file].segs;
      for (let i = fm.from; i <= fm.to; i++) segs[i].removed = true;
      const psegs = FILES[p.file].segs;
      for (let i = psegs.length - 1; i >= 0 && (psegs[i].removed || psegs[i].kind === 'gap'); i--) psegs[i].removed = true;
      psegs.push({ kind: 'gap', src: '\n\n', file: p.file }, { kind: 'para', src: (fm.between ? fm.between + '\n\n' : '') + body + '\n', file: p.file });
    }
    // H's file is no longer read; the save moves it to the trash (an Undo
    // before that reads it again)
    TRASH_ON_SAVE.add(h.file);
  });
  toast(files ? `Merged into "${pTitle}", with the files; save to write it` : `Merged into "${pTitle}"; Ctrl+Z undoes it`, 'ok');
}

// After a save: the files merged into another and read by nothing go to the
// editor's trash (History and the trash keep them).
async function trashMerged(batch) {
  if (!TRASH_ON_SAVE.size) return;
  const reach = reachableFiles();
  for (const name of [...TRASH_ON_SAVE]) {
    if (reach.has(name) || !FILES[name]) { TRASH_ON_SAVE.delete(name); continue; }
    if (isNewFile(name)) { delete FILES[name]; TRASH_ON_SAVE.delete(name); continue; }
    const r = await fetch('/api/file/trash', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ name, batch }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) { banner(`Could not move ${name} to the trash: ${res.error || r.status}`); continue; }
    TRASH_ON_SAVE.delete(name);
    delete FILES[name];
    if (DOC.files) delete DOC.files[name];
    toast(`${name} moved to ${res.trash}`, 'ok');
  }
}

// Every block the Add menu makes can be deleted: a heading (the text under
// it stays), a paragraph, a quotation, a listing, a figure or a table.
const BLOCK_NAMES = { heading: 'heading', para: 'paragraph', quote: 'quotation', code: 'listing', figure: 'figure', table: 'table' };
function deleteBlock(seg) {
  const name = BLOCK_NAMES[seg.kind];
  if (!name) { toast('This block cannot be deleted here; use the source view', 'error'); return; }
  if (!confirm(`Delete this ${name}?` + labelWarning(seg))) return;
  structural(() => removeSeg(seg));
  toast(`Deleted the ${name}: Ctrl+Z restores it`);
}
function deleteButton(seg, box) {
  const name = BLOCK_NAMES[seg.kind];
  const del = el('button', 'deltool', '✕');
  del.title = `Delete this ${name} (Ctrl+Alt+X); Undo restores it`;
  del.setAttribute('aria-label', `Delete this ${name}`);
  del.onclick = (e) => { e.stopPropagation(); deleteBlock(box.seg); };
  return del;
}

function renderCode(seg) {
  const c = L.splitCode(seg.src);
  seg.parts = c;
  const ta = el('textarea');
  ta.value = c.body;
  ta.spellcheck = false;
  ta.rows = Math.max(2, c.body.split('\n').length);
  ta.addEventListener('input', () => { (segOf(ta) || seg).touched = true; lastTyping = Date.now(); markEditedSoon(); });
  seg.edit = ta;
  // a listing read from a file (\lstinputlisting, \ecsnippet{F}{x}): the
  // code itself, with its LaTeX a click away
  const view = !c.pre && hasListing(c.body) ? listingView(c.body.replace(/^\s*\\begin\{[^}]*\}(?:\[[^\]]*\])?|\\end\{[^}]*\}\s*$/g, '').trim()) : null;
  if (!view) {
    const lang = inlineListingLanguage(c.pre);
    return wrapSeg(seg, lang ? highlightedEditor(ta, lang) : ta);
  }
  const box = el('div', 'lst-seg');
  ta.hidden = true;
  box.append(view, ta);
  const edit = el('button', '', 'LaTeX');
  edit.title = 'Show or hide the LaTeX that reads this listing';
  edit.onclick = (e) => {
    e.stopPropagation();
    ta.hidden = !ta.hidden;
    edit.classList.toggle('on', !ta.hidden);
    if (!ta.hidden) ta.focus();
  };
  // the edited command is read again when the LaTeX is left
  ta.addEventListener('change', () => {
    const fresh = listingView(ta.value.replace(/^\s*\\begin\{[^}]*\}(?:\[[^\]]*\])?|\\end\{[^}]*\}\s*$/g, '').trim());
    if (fresh) box.replaceChild(fresh, box.firstChild);
  });
  view.addEventListener('dblclick', () => edit.click());
  return wrapSeg(seg, box, [edit]);
}

// A listing written in the paper (an lstlisting, alone or in a wrapper such
// as ecblock) is highlighted as listings would typeset it: with the language
// its options pick, else the paper's \lstset.  null: nothing to highlight.
function inlineListingLanguage(pre) {
  const all = DOC && DOC.lst_languages;
  const m = /\\begin\{lstlisting\}(?:\[([^\]]*)\])?\s*$/.exec(pre || '');
  if (!all || !m) return null;
  const opt = (key) => { const o = new RegExp('(?:^|,)\\s*' + key + '\\s*=\\s*(?:\\[[^\\]]*\\])?\\s*\\{?\\s*([^,{}]+)').exec(m[1] || ''); return o ? o[1].trim().toLowerCase() : null; };
  const lang = (all.languages || {})[opt('language')] || (all.styles || {})[opt('style')] || all.base;
  const some = lang && (Object.values(lang.keywords || {}).some((w) => w.length) || (lang.comments || []).length
    || (lang.line_comments || []).length || (lang.strings || []).length);
  return some ? lang : null;
}

// The code's textarea over a highlighted copy of its text: the textarea's
// own text is transparent, so the colours show through and the editing,
// caret and selection stay the textarea's.
function highlightedEditor(ta, lang) {
  const box = el('div', 'code-edit');
  const hl = el('pre', 'code-hl');
  hl.setAttribute('aria-hidden', 'true');
  const code = el('code');
  hl.append(code);
  const paint = () => { code.textContent = ''; code.append(highlightListing(ta.value, lang)); };
  paint();
  ta.addEventListener('input', paint);
  ta.addEventListener('scroll', () => { code.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`; });
  box.append(hl, ta);
  return box;
}

// ------------------------------------------------------------ listings
//
// \lstinputlisting and the paper's macros around it (\ecsnippet{TSGame.ec}{x}
// reads a marked range of ../TSGame.ec) are shown as the code they typeset,
// highlighted with the keywords of the paper's \lstdefinelanguage.  The
// server reads them (DOC.listings, by their source); a new or edited one is
// asked for when it is drawn.
const LISTING_FETCHES = new Map();
function listingCommandRe() {
  const names = ['lstinputlisting', ...((DOC && DOC.listing_macros) || [])];
  return new RegExp('\\\\(?:' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\@]/g, '\\$&')).join('|') + ')(?![A-Za-z@])', 'g');
}
function hasListing(src) { listingCommandRe().lastIndex = 0; return listingCommandRe().test(src); }

function fetchListing(src) {
  if (DOC.listings && DOC.listings[src]) return Promise.resolve(DOC.listings[src]);
  if (!LISTING_FETCHES.has(src)) {
    LISTING_FETCHES.set(src, fetch('/api/listing', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ src }),
    }).then((r) => r.json()).then((res) => { (DOC.listings = DOC.listings || {})[src] = res.listings || []; LISTING_FETCHES.delete(src); return DOC.listings[src]; })
      .catch(() => { LISTING_FETCHES.delete(src); return [{ error: 'could not ask the server' }]; }));
  }
  return LISTING_FETCHES.get(src);
}

// Highlight code as listings would: keywords by class, (nested) comments,
// strings.  Returns a fragment of text nodes and spans.
function highlightListing(code, lang) {
  lang = lang || {};
  const frag = document.createDocumentFragment();
  const classOf = new Map();
  for (const [cls, words] of Object.entries(lang.keywords || {})) for (const w of words) classOf.set(w, cls);
  const comments = lang.comments || [], lineComments = lang.line_comments || [], strings = [...new Set(lang.strings || [])];
  let i = 0, plain = '';
  const flush = () => { if (plain) { frag.append(plain); plain = ''; } };
  const span = (cls, text) => { flush(); const s = el('span', cls, text); frag.append(s); };
  while (i < code.length) {
    const c = comments.find(([open]) => code.startsWith(open, i));
    if (c) {
      const [open, close, nested] = c;
      let depth = 0, j = i;
      while (j < code.length) {
        if (nested && code.startsWith(open, j)) { depth++; j += open.length; continue; }
        if (!nested && j === i) { depth = 1; j += open.length; continue; }
        if (code.startsWith(close, j)) { depth--; j += close.length; if (!depth) break; continue; }
        j++;
      }
      span('lst-comment', code.slice(i, j)); i = j; continue;
    }
    const lc = lineComments.find((open) => code.startsWith(open, i));
    if (lc) { const j = code.indexOf('\n', i); const e = j < 0 ? code.length : j; span('lst-comment', code.slice(i, e)); i = e; continue; }
    const q = strings.find((d) => code[i] === d);
    if (q) { let j = i + 1; while (j < code.length && code[j] !== q && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1; span('lst-string', code.slice(i, j + 1)); i = j + 1; continue; }
    const w = /^[A-Za-z_][A-Za-z0-9_']*/.exec(code.slice(i, i + 80));
    if (w) {
      const cls = classOf.get(w[0]);
      if (cls) span('lst-kw lst-kw' + cls, w[0]); else plain += w[0];
      i += w[0].length; continue;
    }
    plain += code[i++];
  }
  flush();
  return frag;
}

function drawListings(box, list) {
  box.textContent = '';
  for (const l of list.length ? list : [{ error: 'nothing to show' }]) {
    const one = el('figure', 'lst-block');
    if (l.title || l.file) {
      const cap = el('figcaption', 'lst-title', l.title || l.file);
      if (l.file) cap.title = l.file;
      one.append(cap);
    }
    if (l.error) one.append(el('div', 'lst-error small', l.error));
    else {
      const pre = el('pre', 'lst-code');
      pre.append(highlightListing(l.code || '', l.language));
      one.append(pre);
    }
    box.append(one);
  }
}

// The listings a piece of source typesets, drawn into a new element (filled
// in when the server answers).
function listingView(src) {
  const box = el('div', 'lst-view');
  box.contentEditable = 'false';
  const re = listingCommandRe();
  if (!re.test(src)) return null;
  const known = DOC.listings && DOC.listings[src.trim()];
  if (known) drawListings(box, known);
  else {
    box.append(el('div', 'small', 'Reading the listing…'));
    fetchListing(src.trim()).then((list) => drawListings(box, list));
  }
  return box;
}

// Preview LaTeX tabulars without changing their source.  Cell editor remains
// in the figure viewer; this is an accessible reading-only presentation.
function previewTabular(src) {
  const tables = L.parseTabulars(src);
  if (!tables.length) return null;
  const container = el('div', 'tabular-preview');
  for (const t of tables) {
    const table = el('table', 'tabular-render');
    for (const r of t.rows) {
      if (r.empty) continue;
      const tr = el('tr');
      for (const cell of r.cells) {
        const td = el('td');
        // \multicolumn{n}{spec}{x} spans n columns; \multirow{n}{w}{x} shows x
        // in its top cell (the cells below it are empty in the source)
        let content = cell.content, m;
        if ((m = /^\s*\\multicolumn\{(\d+)\}\{[^{}]*\}\{([\s\S]*)\}\s*$/.exec(content))) { td.colSpan = +m[1]; content = m[2]; }
        if ((m = /^\s*\\multirow\{[^{}]*\}(?:\[[^\]]*\])?\{[^{}]*\}\{([\s\S]*)\}\s*$/.exec(content))) content = m[1];
        renderTokens(L.tokenize(content), td, {});
        tr.append(td);
      }
      table.append(tr);
      if (/\\(midrule|toprule|bottomrule|hline)/.test(r.lead))
        tr.classList.add('rule-above');
    }
    container.append(table);
  }
  return container;
}

function renderFloat(seg) {
  const box = el('div');
  seg.wide = /^\s*\\begin\{(figure|table)\*\}/.test(seg.src);
  if (seg.kind === 'figure') {
    const url = DOC.figs[seg.src];
    if (url) { const img = el('img'); img.src = url; img.alt = 'Figure'; box.append(img); }
    else {
      // not cut yet (a new or changed figure): games can be shown from their source meanwhile
      const live = previewGames(seg.src);
      if (live) box.append(live, el('div', 'small stale-note', 'Preview: the typeset picture appears after the build'));
      else box.append(el('div', 'small', '(figure image is being rendered, or the source changed; it appears after the next build)'));
    }
  } else if (DOC.figs[seg.src]) {
    const img = el('img'); img.src = DOC.figs[seg.src]; img.alt = 'Table'; box.append(img);
  } else {
    box.append(previewTabular(seg.src) || el('div', 'small', '(table preview is being rendered)'));
  }
  const cap = L.captionParts(seg.src);
  seg.parts = cap;
  if (cap) {
    const c = el('div', 'caption');
    const lab = /\\label\{([^}]*)\}/.exec(seg.src);
    const n = lab && labelValue(lab[1]);
    const num = el('b', 'capnum', (seg.kind === 'figure' ? ((DOC.cref || {}).figurename || 'Figure') + ' ' : 'Table ') + (n || '?') + '. ');
    const t = el('span');
    t.contentEditable = 'true';
    renderTokens(L.tokenize(cap.caption), t, {});
    c.append(num, t);
    box.append(c);
    seg.edit = t;
  }
  const w = wrapSeg(seg, box);
  if (seg.wide) w.classList.add('wide');
  return w;
}

// Render tokens into parent.  Plain text stays editable; everything else is
// an atomic chip that carries its source in data-src.
const LIGATURES = { '---': '\u2014', '--': '\u2013', '``': '\u201c', "''": '\u201d' };
function renderTokens(toks, parent, ctx) {
  toks.forEach((tok, i) => {
    if (tok.t !== 'env' || tok.mode !== 'begin') return;
    for (let k = i + 1; k < toks.length && k < i + 4; k++) {
      if (toks[k].t === 'cmd' && toks[k].name === 'label') { tok.label = (/\{([^}]*)\}/.exec(toks[k].s) || [])[1]; break; }
      if (toks[k].t !== 'nl' && toks[k].t !== 'comment') break;
    }
  });
  for (const tok of toks) {
    if (tok.t === 'text') {
      // TeX ligatures read as LaTeX prints them; the chip keeps the source
      for (const piece of tok.s.split(/(---|--|``|'')/)) {
        if (!piece) continue;
        if (LIGATURES[piece]) parent.append(chip('char', piece, LIGATURES[piece]));
        else parent.append(document.createTextNode(L.decodeText(piece)));
      }
      continue;
    }
    if (tok.t === 'fmt') {
      const e = el(tok.name === 'textbf' || tok.name === 'paragraph' ? 'strong' : 'em',
        tok.name === 'paragraph' ? 'runin' : '');
      e.dataset.prefix = tok.prefix;
      renderTokens(tok.children, e, ctx);
      parent.append(e);
      continue;
    }
    if (tok.t === 'group') {
      const g = chip('src', '{' + L.serializeTokens(tok.children) + '}');
      g.classList.remove('src');
      renderTokens(tok.children, g, ctx);
      parent.append(g);
      continue;
    }
    parent.append(renderChip(tok, ctx));
  }
}

function chip(cls, src, text) {
  const c = el('span', 'chip ' + cls);
  c.contentEditable = 'false';
  c.dataset.src = src;
  if (text !== undefined) c.textContent = text;
  return c;
}

const HIDDEN = new Set(['label', 'crefalias', 'crefname', 'Crefname', 'urlstyle', 'addlinespace', 'morecmidrules', 'pagebreak', 'linebreak', 'newline', 'clearpage', 'newpage', 'maketitle', 'bibliographystyle', 'FloatBarrier',
  'vspace', 'noindent', 'centering', 'raggedright', 'raggedleft', 'RaggedRight', 'RaggedLeft', 'setlength', 'addtolength', 'setcounter', 'addtocounter', 'title', 'author', 'nonumber', 'medskip', 'smallskip', 'bigskip',
  'Needspace', 'raggedbottom', 'balance', 'IEEEauthorblockN', 'IEEEauthorblockA', 'leavevmode',
  'protect', 'institute', 'inst', 'orcidID', 'email', 'date', 'titlerunning', 'authorrunning', 'thanks',
  'affiliation', 'address', 'addauthor', 'authorrunning', 'keywords', 'IEEEoverridecommandlockouts',
  'IEEEpeerreviewmaketitle', 'license', 'Copyright', 'EventEditors', 'EventNoEds', 'EventLongTitle',
  'EventShortTitle', 'EventAcronym', 'EventYear', 'EventDate', 'EventLocation', 'EventLogo', 'SeriesVolume',
  'ArticleNo', 'ccsdesc', 'relatedversion', 'funding', 'acknowledgements', 'nolinenumbers', 'hideLIPIcs',
  'authorrunning', 'subjclass', 'category', 'supplement', 'copyrightyear', 'acmYear', 'acmDOI', 'acmConference',
  'acmBooktitle', 'acmPrice', 'acmISBN', 'setcopyright', 'orcid', 'country', 'institution', 'city']);

// A label of the bibliography as printed: alpha styles write BCK{$^+$}22
const citeLabel = (v) => v === undefined || v === null ? '' : String(v)
  .replace(/\{?\$\^\{?\+\}?\$\}?/g, '\u207a').replace(/\$\^\{?([^${}]*)\}?\$/g, '$1').replace(/[{}$]/g, '');
const CITE_CMDS = /^(cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|citenum|parencite|textcite|autocite|footcite|smartcite|supercite)$/i;
// a citation note as LaTeX prints it: \S 4.2 -> § 4.2, p.~7 -> p. 7
const citeNote = (n) => n.replace(/\\S\s*/g, '§').replace(/~/g, '\u00a0').replace(/[{}]/g, '').trim();

function renderChip(tok, ctx) {
  switch (tok.t) {
    case 'nl': return chip('nl', tok.s, ' ');
    case 'tie': return chip('tie', '~', '\u00a0');
    case 'comment': return chip('hidden', tok.s);
    case 'math': return mathChip(tok.s, tok.display);
    case 'env': return envChip(tok, ctx);
  }
  const name = tok.name;
  const arg = (k = 0) => { const m = [...tok.s.matchAll(/\{([^{}]*)\}/g)]; return m[k] ? m[k][1] : ''; };
  if (HIDDEN.has(name) || (name !== 'iff' && /^(newif|else|fi|if[a-zA-Z@]*|[a-zA-Z@]+(true|false))$/.test(name))) return chip('hidden', tok.s);
  if (/^[cC]ref$|^ref$|^eqref$|^autoref$/.test(name)) return chip('ref', tok.s, refText(name, arg()));
  if (CITE_CMDS.test(name)) {
    // \cite, natbib (\citep, \citet, \citeauthor …) and biblatex (\parencite,
    // \textcite, \autocite …), with [post] or [pre][post] notes
    const cm = /^\\[A-Za-z]+\*?\s*((?:\[(?:[^\]{}]|\{[^{}]*\})*\]\s*){0,2})\{([^{}]*)\}/.exec(tok.s);
    const keys = (cm ? cm[2] : arg()).split(',').map((k) => k.trim()).filter(Boolean);
    const opts = cm ? [...cm[1].matchAll(/\[((?:[^\]{}]|\{[^{}]*\})*)\]/g)].map((o) => citeNote(o[1])) : [];
    const [pre, post] = opts.length > 1 ? opts : ['', opts[0] || ''];
    const num = (k) => citeLabel(DOC.aux.cites[k]) || '?';
    const info = (k) => (DOC.aux.citeinfo || {})[k] || {};
    const low = name.toLowerCase();
    let text;
    if (low === 'citeauthor') text = keys.map((k) => info(k).author || k).join(', ');
    else if (low === 'citeyear') text = keys.map((k) => info(k).year || '?').join(', ');
    else if (low === 'citeyearpar') text = '(' + keys.map((k) => info(k).year || '?').join(', ') + ')';
    else if (/^(citet|textcite|citealt)$/.test(low))
      text = keys.map((k, i) => (info(k).author ? info(k).author + ' ' : '') + '[' + num(k) + (i === keys.length - 1 && post ? ', ' + post : '') + ']').join(', ');
    else {
      // numbers in ascending order, as sortcites (biblatex) and natbib's sort do
      const nums = keys.map(num);
      if (nums.every((v) => /^\d+$/.test(v))) nums.sort((a, b) => a - b);
      text = '[' + (pre ? pre + ' ' : '') + nums.join(', ') + (post ? ', ' + post : '') + ']';
    }
    const c = chip('cite', tok.s, text);
    c.title = keys.map((k) => DOC.bib[k] || k).join('\n\n').replace(/\\[a-zA-Z]+|[{}]/g, '');
    return c;
  }
  if (name === 'lstinputlisting' || ((DOC.listing_macros || []).includes(name))) {
    // a listing read from a file, in running text or a box: shown as its code
    const c = chip('src listing', tok.s);
    const view = listingView(tok.s);
    if (view) { c.append(view); c.title = tok.s + ' (click to edit)'; return c; }
  }
  if (name === 'ec' || name === 'texttt' || name === 'url' || name === 'nolinkurl' || name === 'lstinline') return chip('ec', tok.s, arg());
  if (name === 'verb') {
    // \verb|x|, \lstinline|x <$ d|, \mintinline{lang}|x|: the text between the delimiters
    const m = /^\\(?:verb\*?|lstinline|mintinline)\s*(?:\[[^\]]*\])*(?:\{[^}]*\})?([^])([^]*?)\1$/.exec(tok.s);
    return chip('ec', tok.s, m ? m[2] : tok.s);
  }
  if (name === 'appendices' || name === 'appendix') { ctx.app = true; ctx.sec = 0; return chip('runin', tok.s, 'Appendices'); }
  if (name === 'bibliography' || name === 'printbibliography') return refList(tok.s);   // BibTeX or biblatex
  if (name === 'bibitem') {
    // a hand-written thebibliography: each entry on its own line, with its label
    const key = (/\{([^}]*)\}\s*$/.exec(tok.s) || [])[1] || arg();
    const label = (/^\\bibitem\s*\[([^\]]*)\]/.exec(tok.s) || [])[1];
    const c = chip('item', tok.s);
    c.append(el('span', 'itemmark', '[' + (label || citeLabel(DOC.aux.cites[key.trim()]) || '?') + '] '));
    return c;
  }
  if (name === 'item') {
    // a line break, then the marker: a bullet, the number in an enumerate,
    // the label of \item[label]; nested lists indent by depth
    const lists = (ctx.lists = ctx.lists || []);
    const top = lists[lists.length - 1] || { env: 'itemize', n: 0 };
    top.n++;
    const opt = /^\\item\s*\[([^\]]*)\]/.exec(tok.s);
    const mark = opt ? opt[1] : top.env === 'enumerate' ? top.n + '.' : '•';
    const c = chip('item', tok.s);
    c.append(el('span', 'itemmark', '\u00a0'.repeat(3 * Math.max(0, lists.length - 1)) + mark + ' '));
    if (opt) c.querySelector('.itemmark').style.fontWeight = 'bold';
    return c;
  }
  // \textnormal{…}, \textsf{…}, \mbox{…} around text with citations or maths:
  // the text, styled (editable through its source, as a group is)
  const style = TEXT_STYLES[name];
  if (style !== undefined && !['textbf', 'textit', 'emph', 'underline', 'ensuremath'].includes(name)) {
    const m = new RegExp('^\\\\' + name + '\\s*\\{([^]*)\\}$').exec(tok.s);
    if (m) {
      const c = chip('styled', tok.s);
      c.style.cssText = style;
      renderTokens(L.tokenize(m[1]), c, ctx);
      return c;
    }
  }
  // a macro of the document that typesets a listing from a file
  // (\ecsnippet{TSGame.ec}{decl} -> \lstinputlisting…): which file and part
  const listingBody = DOC.macros['\\' + name];
  if (listingBody !== undefined && /\\(lstinputlisting|inputminted|verbatiminput)\b/.test(listingBody)) {
    const args = [...tok.s.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]);
    const c = chip('ec listing', tok.s, '\u2398 ' + (args.length ? args.join(' \u203a ') : name));
    c.title = 'Listing typeset from a file: ' + tok.s;
    return c;
  }
  if (name === 'footnote') { const c = chip('src', tok.s, '†'); c.title = arg(); return c; }
  if (name === 'texorpdfstring') { const c = chip('', tok.s); renderTokens(L.tokenize(arg(0)), c, ctx); return c; }
  // \underline{...}, maths inside included (a game's \Statex \underline{$\G{0}$})
  if (name === 'underline') {
    const m = /^\\underline\s*\{([^]*)\}$/.exec(tok.s);
    if (m) { const c = chip('uline', tok.s); renderTokens(L.tokenize(m[1]), c, ctx); return c; }
  }
  if (name === ',' || name === ' ' || name === ';' || name === '@') return chip('nl', tok.s, ' ');
  if (name === 'dots' || name === 'ldots') return chip('nl', tok.s, '…');
  if (name === 'verbatim' && /^tabular(?:\*|x)?$/.test(tok.env)) {
    const c = chip('tabular-inline', tok.s);
    c.append(previewTabular(tok.s) || el('code', '', tok.s));
    return c;
  }
  if (name === 'verbatim' && tok.env === 'tikzpicture') return snippetChip(tok.s, ctx);
  if (name === 'verbatim') return chip('src', tok.s, '[' + tok.env + ']');
  // characters typed into the text are saved as these commands; show them as
  // the characters
  if (name === 'textasciitilde') return chip('char', tok.s, '~');
  if (name === 'textasciicircum') return chip('char', tok.s, '^');
  if (name === 'textbackslash') return chip('char', tok.s, '\\');
  if (name === 'textless') return chip('char', tok.s, '<');
  if (name === 'textgreater') return chip('char', tok.s, '>');
  // Text accents belong to Unicode in the reading view, but keep their exact
  // LaTeX source in data-src so editing/saving still round-trips losslessly.
  const accents = { c: '\u0327', "'": '\u0301', '`': '\u0300', '"': '\u0308',
    '^': '\u0302', '~': '\u0303', '=': '\u0304', '.': '\u0307',
    u: '\u0306', v: '\u030c', H: '\u030b', r: '\u030a', k: '\u0328' };
  const accented = tok.accentBase || arg();
  if (Object.prototype.hasOwnProperty.call(accents, name) && [...accented].length === 1)
    return chip('char', tok.s, (accented + accents[name]).normalize('NFC'));
  // a macro of the document used in text: show it typeset when its body is
  // maths (\ensuremath{...}, \mathsf{...}, \mathcal...)
  const body = DOC.macros['\\' + name];
  if (body !== undefined && /^\s*(\\ensuremath|\\math[a-z]+|\\operatorname|\\textsc)/.test(body)) {
    const c = chip('math macro', tok.s);
    typesetInto('$' + tok.s + '$', c, false);
    if (!c.classList.contains('bad')) return c;
  }
  // a text macro (\oracle -> \textbf{Oracle}\ , \TSUF{1} -> \textsf{TS-UF-}1\xspace):
  // show what it prints
  if (body !== undefined) {
    const shown = textMacroNodes(tok.s);
    if (shown) {
      const c = chip('src textmacro', tok.s);
      c.append(...shown.nodes);
      c.dataset.say = shown.say;
      c.title = tok.s;
      return c;
    }
  }
  if (!NO_SNIPPET.has(name) && !NO_SNIPPET_RE.test(name)) return snippetChip(tok.s, ctx);
  return chip('src', tok.s, tok.s.length > 40 ? tok.s.slice(0, 38) + '…' : tok.s);
}

// ------------------------------------------------------------ snippets
//
// A command the page does not know (\intlongdivision{230}{17}) or a picture
// in running text (an inline tikzpicture) is typeset by LaTeX with the
// paper's preamble and shown as a picture at the size of the text: its height
// and depth in em, so its baseline sits on the line.  Until the picture is
// there, and where LaTeX failed or printed nothing, the chip shows the source.
const NO_SNIPPET = new Set(['input', 'include', 'includeonly', 'let', 'def', 'gdef', 'edef', 'xdef', 'usepackage', 'RequirePackage',
  'documentclass', 'begin', 'end', 'item', 'caption', 'subcaption', 'part', 'chapter', 'section', 'subsection', 'subsubsection',
  'paragraph', 'subparagraph', 'hspace', 'vspace', 'hfill', 'hfil', 'vfill', 'quad', 'qquad', 'enspace', 'thinspace', 'par',
  'indent', 'ignorespaces', 'relax', 'xspace', 'hyphenation', 'index', 'marginpar', 'phantomsection', 'addcontentsline',
  'nocite', 'tableofcontents', 'listoffigures', 'listoftables', 'printindex', 'footnotemark', 'footnotetext', 'tikzset',
  'pgfplotsset', 'lstset', 'hypersetup', 'graphicspath', 'theoremstyle', 'allowdisplaybreaks', 'sloppy', 'fussy', 'selectlanguage']);
const NO_SNIPPET_RE = /^(new|renew|provide|Declare|make|set|add|use|pgf|tikz@)|@/;
const SNIPPET_ASK = new Set();
let snippetTimer = null;
function snippetChip(src, ctx) {
  const c = chip('src snippet', src, src.length > 40 ? src.slice(0, 38) + '…' : src);
  if ((ctx.env || []).includes('center')) c.classList.add('snippet-center');
  const s = (DOC.snips || {})[src];
  if (s) paintSnippet(c, s);
  else askSnippet(src);
  return c;
}
function paintSnippet(c, s) {
  if (s.state === 'ok') {
    const img = el('img');
    img.src = s.url; img.alt = c.dataset.src; img.draggable = false;
    img.style.height = (s.h + s.d) + 'em';
    img.style.width = s.w + 'em';
    img.style.verticalAlign = -s.d + 'em';
    c.textContent = '';
    c.append(img);
    c.classList.add('drawn');
    c.title = c.dataset.src;
  } else if (s.state === 'error') c.title = 'LaTeX could not typeset this alone: ' + (s.err || '');
  else if (s.state === 'pending') c.title = 'Being typeset by LaTeX…';
}
function askSnippet(src) {
  SNIPPET_ASK.add(src);
  clearTimeout(snippetTimer);
  snippetTimer = setTimeout(askSnippetsNow, 50);
}
async function askSnippetsNow() {
  const srcs = [...SNIPPET_ASK];
  SNIPPET_ASK.clear();
  if (!srcs.length || !TOKEN) return;
  const r = await fetch('/api/snippets', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify({ srcs }) }).catch(() => null);
  if (!r || !r.ok) return;
  const res = await r.json().catch(() => ({}));
  DOC.snips = DOC.snips || {};
  for (const [src, s] of Object.entries(res)) if (s.state !== 'pending') DOC.snips[src] = s;
  repaintSnippets(res);
}
function repaintSnippets(res) {
  for (const c of document.querySelectorAll('#doc .chip.snippet:not(.drawn)')) {
    const s = res[c.dataset.src];
    if (s) paintSnippet(c, s);
  }
}
// after the builder finished a batch: ask again for the ones still waiting
function refreshSnippets() {
  const waiting = new Set();
  for (const c of document.querySelectorAll('#doc .chip.snippet:not(.drawn)')) if (!(DOC.snips || {})[c.dataset.src]) waiting.add(c.dataset.src);
  for (const src of waiting) askSnippet(src);
}

// What a use of a text macro of the document prints, as nodes: its body with
// the arguments put in, where the body is only text, text styles (\textsf,
// \textsc, \emph …), maths and other such macros.  Null for anything else
// (the chip then shows the source).
const TEXT_STYLES = { textbf: 'font-weight:bold', textit: 'font-style:italic', emph: 'font-style:italic',
  textsl: 'font-style:oblique', textsf: 'font-family:system-ui,sans-serif', texttt: 'font-family:monospace',
  textsc: 'font-variant:small-caps', textrm: '', textnormal: 'font-style:normal;font-weight:normal', textmd: 'font-weight:normal',
  textup: 'font-style:normal', text: '', mbox: '', hbox: '', underline: 'text-decoration:underline', ensuremath: '' };
const TEXT_SKIP = new Set(['xspace', 'relax', 'protect', '/', '@', 'nobreak', 'allowbreak', 'unskip']);
function textMacroNodes(src) {
  let say = '';
  const readGroup = (s, i) => {
    while (s[i] === ' ') i++;
    if (s[i] !== '{') return null;
    const e = L.groupEnd(s, i);
    return e < 0 ? null : { text: s.slice(i + 1, e - 1), end: e };
  };
  const expand = (name, s, i, depth) => {
    const body = DOC.macros['\\' + name];
    if (body === undefined || depth > 4) return null;
    const n = Math.max(0, ...[...body.matchAll(/#(\d)/g)].map((m) => +m[1]));
    const args = [];
    for (let k = 0; k < n; k++) { const g = readGroup(s, i); if (!g) return null; args.push(g.text); i = g.end; }
    return { text: body.replace(/#(\d)/g, (_, k) => args[k - 1]), end: i };
  };
  const parse = (s, into, depth) => {
    let i = 0, text = '';
    const flush = () => { if (text) { into.append(document.createTextNode(text)); say += text; text = ''; } };
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\') {
        const m = /^\\([A-Za-z@]+|.)/.exec(s.slice(i));
        if (!m) return false;
        const name = m[1];
        i += m[0].length;
        if (TEXT_SKIP.has(name)) { if (/^[A-Za-z]/.test(name)) while (s[i] === ' ') i++; continue; }
        if (name === ' ') { text += ' '; continue; }
        if ('&%$#_{}'.includes(name)) { text += name; continue; }
        if (name === 'textcolor' || name === 'color') {
          // \textcolor{c}{x}; \color{c} colours the rest of its group
          const c = readGroup(s, i);
          if (!c) return false;
          const css = colorOf(c.text);
          let rest, end;
          if (name === 'textcolor') { const g = readGroup(s, c.end); if (!g) return false; rest = g.text; end = g.end; }
          else { rest = s.slice(c.end); end = s.length; }
          flush();
          const span = el('span', 'tcolor');
          if (css) span.style.color = css;
          if (!parse(rest, span, depth)) return false;
          into.append(span);
          i = end;
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(TEXT_STYLES, name)) {
          const g = readGroup(s, i);
          if (!g) return false;
          flush();
          const span = el('span');
          span.style.cssText = TEXT_STYLES[name];
          if (!parse(g.text, span, depth)) return false;
          into.append(span);
          i = g.end;
          continue;
        }
        const x = expand(name, s, i, depth + 1);
        if (!x) return false;
        flush();
        const span = el('span');
        if (!parse(x.text, span, depth + 1)) return false;
        into.append(...span.childNodes);
        i = x.end;
        continue;
      }
      if (ch === '$') {
        const e = s.indexOf('$', i + 1);
        if (e < 0) return false;
        flush();
        const m = el('span', 'tmath');
        typesetInto(s.slice(i, e + 1), m, false);
        if (m.classList.contains('bad')) return false;
        into.append(m);
        say += ' ' + mathSpeech(s.slice(i, e + 1)) + ' ';
        i = e + 1;
        continue;
      }
      if (ch === '{') {
        const e = L.groupEnd(s, i);
        if (e < 0) return false;
        flush();
        const span = el('span');
        if (!parse(s.slice(i + 1, e - 1), span, depth)) return false;
        into.append(...span.childNodes);
        i = e;
        continue;
      }
      if (ch === '}' || ch === '#' || ch === '^' || ch === '_' || ch === '&') return false;
      if (ch === '~') { text += '\u00a0'; i++; continue; }
      if (ch === '%') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e + 1; continue; }
      if (s.startsWith('---', i)) { text += '\u2014'; i += 3; continue; }
      if (s.startsWith('--', i)) { text += '\u2013'; i += 2; continue; }
      text += ch === '\n' ? ' ' : ch;
      i++;
    }
    flush();
    return true;
  };
  const m = /^\\([A-Za-z@]+)/.exec(src);
  if (!m) return null;
  const x = expand(m[1], src, m[0].length, 0);
  if (!x || src.slice(x.end).trim()) return null;
  const box = el('span');
  if (!parse(x.text, box, 0)) return null;
  // the body ends with \  or ~: a space after it
  if (/(\\ |~)\s*$/.test(x.text) && box.lastChild && box.lastChild.nodeType === 3) box.lastChild.data = box.lastChild.data.replace(/[ \u00a0]$/, '') + ' ';
  if (!box.textContent.trim()) return null;
  return { nodes: [...box.childNodes], say: say.replace(/\s+/g, ' ').trim() };
}

function envChip(tok, ctx) {
  const c = envChipInner(tok, ctx);
  // the structure view shows where every environment starts and ends
  c.classList.add('envmark', tok.mode === 'begin' ? 'envbegin' : 'envend');
  c.dataset.env = tok.env;
  return c;
}
function envChipInner(tok, ctx) {
  if (tok.mode === 'begin') {
    ctx.env = ctx.env || [];
    ctx.env.push(tok.env);
    if (L.THM_ENVS.has(tok.env)) {
      const th = (DOC.theorems || {})[tok.env] || { name: tok.env, counter: tok.env };
      let n = '';
      if (th.counter) {
        ctx.counters = ctx.counters || {};
        n = String(ctx.counters[th.counter] = (ctx.counters[th.counter] || 0) + 1);
        if (tok.label && labelValue(tok.label)) n = labelValue(tok.label);
      }
      // the optional title is typeset (maths, \cite, \emph), not shown as source
      const c = chip('thmhead', tok.s, `${th.name}${n ? ' ' + n : ''}${tok.opt ? ' (' : '. '}`);
      if (tok.opt) {
        const t = el('span', 'thmtitle');
        renderTokens(L.tokenize(tok.opt), t, {});
        c.append(t, document.createTextNode('). '));
      }
      return c;
    }
    if (tok.env === 'proof') {
      // the optional title is typeset (\ref, maths, \emph), not shown as source
      const c = chip('runin', tok.s, tok.opt ? '' : 'Proof. ');
      if (tok.opt) {
        const t = el('span', 'thmtitle');
        renderTokens(L.tokenize(tok.opt), t, {});
        c.append(t, document.createTextNode('. '));
      }
      return c;
    }
    if (tok.env === 'abstract') return chip('runin', tok.s, 'Abstract. ');
    if (/^(itemize|enumerate|description)$/.test(tok.env)) {
      (ctx.lists = ctx.lists || []).push({ env: tok.env, n: 0 });
      return chip('hidden', tok.s);
    }
    return chip('hidden', tok.s);
  }
  if (/^(itemize|enumerate|description)$/.test(tok.env)) {
    if (ctx.lists) ctx.lists.pop();
    if (ctx.env) ctx.env.pop();
    return chip('listend', tok.s, '');
  }
  if (ctx.env) ctx.env.pop();
  if (tok.env === 'proof') return chip('nl', tok.s, ' ∎');
  return chip('hidden', tok.s);
}

function mathChip(src, display) {
  const c = chip('math' + (display ? ' display' : ''), src);
  typesetInto(src, c, display);
  return c;
}

function mathBody(src) {
  let m;
  if ((m = /^\$\$([^]*)\$\$$/.exec(src)) || (m = /^\\\[([^]*)\\\]$/.exec(src))) return [m[1], true];
  if ((m = /^\$([^]*)\$$/.exec(src)) || (m = /^\\\(([^]*)\\\)$/.exec(src))) return [m[1], false];
  return [src, true]; // an environment, rendered whole
}

const KATEX_CACHE = new Map();   // source -> rendered HTML (cleared when the macros change)
// LaTeX that KaTeX lacks but papers use in maths and macros
const KATEX_SHIMS = { '\\ensuremath': '#1', '\\xspace': '', '\\mathchoice': '#1', '\\boldmath': '',
  '\\unboldmath': '', '\\textsc': '\\text{#1}', '\\mbox': '\\text{#1}',
  '\\protect': '', '\\nobreak': '', '\\allowbreak': '', '\\qedhere': '', '\\qed': '' };
// cryptocode's keywords (\pcreturn, \sample …) preview in running text too, not
// only in the game editor; the paper's own definitions still win
// KaTeX takes \displaylimits for a no-op and sets the limits as subscripts:
// as in TeX, they go below in a displayed formula and beside inline.
const katexMacros = (display = false) => ({ ...KATEX_SHIMS, ...CRYPTOCODE_MACROS, ...DOC.macros,
  '\\displaylimits': display ? '\\limits' : '\\nolimits' });
// A colour of the paper (\definecolor, \colorlet: gone = #009e73) or of
// xcolor (red, blue …), as CSS; null for one the page cannot know.
const XCOLORS = { red: '#ff0000', green: '#00ff00', blue: '#0000ff', black: '#000000', white: '#ffffff', gray: '#808080',
  darkgray: '#404040', lightgray: '#bfbfbf', cyan: '#00ffff', magenta: '#ff00ff', yellow: '#ffff00', orange: '#ff8000',
  violet: '#800080', purple: '#bf0040', brown: '#bf8040', teal: '#008080', olive: '#808000', lime: '#bfff00', pink: '#ffbfbf' };
function colorOf(name) {
  name = String(name || '').trim();
  const own = ((DOC && DOC.colors) || {}).colors || {};
  if (own[name]) return own[name];
  if (XCOLORS[name]) return XCOLORS[name];
  if (/^#[0-9a-f]{3,8}$/i.test(name)) return name;
  return null;
}
// KaTeX writes \textcolor{gone}{…} as color:gone, which CSS does not know
function paperColorsInto(html) {
  return html.replace(/color:\s*([A-Za-z][\w]*)/g, (all, n) => { const c = colorOf(n); return c ? 'color:' + c : all; });
}
// A numbered display environment shows the numbers LaTeX gave it (from the
// .aux), not KaTeX's own count, which restarts at (1) in every formula: each
// row gets \tag{n}; rows without a label take the number after the row before.
const NUMBERED_ENV = /^\s*\\begin\{(equation|align|gather|multline|flalign|alignat|eqnarray)\}/;
function tagRows(src, body) {
  const env = NUMBERED_ENV.exec(src);
  if (!env || /\\tag\b/.test(body)) return body;
  const wrap = /^(\s*\\begin\{[a-z]+\}(?:\{[^}]*\})?)([\s\S]*?)(\\end\{[a-z]+\}\s*)$/.exec(body);
  if (!wrap) return body;
  const inner = tagInner(env[1], wrap[2]);
  return inner === null ? body : wrap[1] + inner + wrap[3];
}
function tagInner(name, body) {
  const single = name === 'equation' || name === 'multline';
  const rows = single ? [body] : body.split(/(\\\\(?:\[[^\]]*\])?)/);
  const parts = [];                 // indexes of the rows (odd entries are the \\ separators)
  for (let i = 0; i < rows.length; i += 2) parts.push(i);
  const num = parts.map((i) => {
    if (/\\(nonumber|notag)\b/.test(rows[i])) return null;
    if (!single && !rows[i].trim() && i === rows.length - 1) return null;   // a trailing \\
    const lab = /\\label\{([^}]*)\}/.exec(rows[i]);
    return { v: lab ? labelValue(lab[1]) : undefined };
  });
  // fill unlabelled numbered rows from a labelled neighbour (consecutive numbers)
  const known = num.findIndex((n) => n && n.v && /^\d+$/.test(n.v));
  if (known < 0) return null;
  let c = +num[known].v;
  for (let k = known - 1; k >= 0; k--) if (num[k]) num[k].v = num[k].v || String(--c);
  c = +num[known].v;
  for (let k = known + 1; k < num.length; k++) if (num[k]) { if (num[k].v && /^\d+$/.test(num[k].v)) c = +num[k].v; else num[k].v = num[k].v || String(++c); }
  parts.forEach((i, k) => { if (num[k] && num[k].v) rows[i] += `\\tag{${num[k].v}}`; else if (!single && rows[i].trim()) rows[i] += '\\notag'; });
  return rows.join('');
}

// KaTeX writes empty MathML elements as <mspace .../>.  Inside an <mo> (it
// nests one in another for \mathrel{\leftarrow\!\!\mathrel{\$}}, cryptocode's
// \sample, in a \substack) the HTML parser reads HTML, where "/>" closes
// nothing: the <mspace> then holds the rest of the formula, its visible part
// included, and the formula shows as an empty box.  Close them explicitly.
function closeMathmlTags(html) {
  return html.replace(/<(mspace|mglyph|none|mprescripts|malignmark)\b([^<>]*?)\s*\/>/g, '<$1$2></$1>');
}

function typesetInto(src, node, display) {
  let [body, disp] = mathBody(src);
  body = tagRows(src, body);
  body = body.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber)\b/g, '\\notag');
  // Only the preview changes; the original source remains on the chip.
  body = body.replace(/\\begin\{multline\*?\}/g, '\\begin{aligned}')
    .replace(/\\end\{multline\*?\}/g, '\\end{aligned}')
    .replace(/\\begin\{split\}/g, '\\begin{aligned}')
    .replace(/\\end\{split\}/g, '\\end{aligned}');
  try {
    const key = (display || disp ? 'D' : 'I') + body;
    let html = KATEX_CACHE.get(key);
    if (html === undefined) {
      html = closeMathmlTags(katex.renderToString(body, { displayMode: display || disp, throwOnError: false,
        macros: katexMacros(display || disp), strict: false, trust: false }));
      KATEX_CACHE.set(key, html);
    }
    node.innerHTML = paperColorsInto(html);
    node.classList.toggle('bad', !!node.querySelector('.katex-error'));
    if (node.classList.contains('bad')) node.title = 'KaTeX could not preview this formula';
    else node.removeAttribute('title');
  } catch (e) {
    node.textContent = src;
    node.classList.add('bad');
    node.title = 'Math preview error: ' + e.message;
  }
}

function renderMathless(src, node) { renderTokens(L.tokenize(src), node, {}); }

function refList(src) {
  const c = chip('', src);
  c.style.display = 'block';
  const h = el('h2', '', 'References');
  const ol = el('ul', 'refs');
  // numeric labels in order; alphabetic ones (biblatex Aut19) alphabetically
  const keys = Object.entries(DOC.aux.cites).sort((a, b) => (isNaN(a[1]) || isNaN(b[1]) ? String(a[1]).localeCompare(String(b[1])) : a[1] - b[1]));
  for (const [k, n] of keys) {
    const li = el('li');
    li.dataset.key = k;
    li.append(el('span', 'reflabel', `[${citeLabel(n)}]`), (DOC.bib[k] || k).replace(/\\[a-zA-Z]+\s*|[{}~]/g, (m) => (m === '~' ? ' ' : '')));
    ol.append(li);
  }
  c.append(h, ol);
  return c;
}

// ------------------------------------------------------------ references

const TYPE_NAMES = { section: 'Section', subsection: 'Section', subsubsection: 'Section', chapter: 'Chapter',
  lemma: 'Lemma', theorem: 'Theorem', corollary: 'Corollary', definition: 'Definition', proposition: 'Proposition',
  remark: 'Remark', claim: 'Claim', example: 'Example', conjecture: 'Conjecture', fact: 'Fact', assumption: 'Assumption',
  observation: 'Observation', notation: 'Notation', construction: 'Construction', game: 'Game', algorithm: 'Algorithm',
  line: 'Line', footnote: 'Footnote', figure: 'Figure', table: 'Table', appendix: 'Appendix', listing: 'Listing',
  equation: 'Equation', part: 'Part', note: 'Note', result: 'Result', enumi: 'Item' };
const PLURAL_NAMES = { Appendix: 'Appendices', Corollary: 'Corollaries', Fig: 'Figs', 'Fig.': 'Figs.', 'Eq.': 'Eqs.', Line: 'Lines' };
// cleveref's lower-case names (\cref) where it abbreviates them
const CREF_ABBREV = { figure: ['fig.', 'figs.'], equation: ['eq.', 'eqs.'] };
const SAME_AS = { subsection: 'section', subsubsection: 'section', paragraph: 'section' };
const upFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const downFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function labelValue(key) { const l = DOC.aux.labels[key.trim()]; return l && l.v; }

// The name cleveref prints for a kind of label: \crefname / \Crefname of the
// paper first (one derives the other, as in cleveref), then its defaults
// (abbreviated for \cref unless noabbrev, capitalised with capitalise).
function crefName(type, cap, plural) {
  const cfg = DOC.cref || {};
  const opts = cfg.options || [];
  const t = SAME_AS[type] || type;
  const pick = (pair) => pair && pair[plural ? 1 : 0];
  const lower = pick((cfg.names || {})[t]) || pick((cfg.names || {})[type]);
  const upper = pick((cfg.Names || {})[t]) || pick((cfg.Names || {})[type]);
  cap = cap || opts.includes('capitalise') || opts.includes('capitalize');
  if (cap) {
    if (upper) return upper;
    if (lower) return upFirst(lower);
  } else {
    if (lower) return lower;
    if (upper) return downFirst(upper);
  }
  const theorem = (DOC.theorems || {})[type];
  let name = TYPE_NAMES[t] || (theorem && theorem.name) || upFirst(t || '');
  if (!name) return '';
  if (plural) name = PLURAL_NAMES[name] || name + 's';
  if (cap) return name;
  if (!opts.includes('noabbrev') && CREF_ABBREV[t]) return CREF_ABBREV[t][plural ? 1 : 0];
  return downFirst(name);
}

// Natural order of printed numbers: 2 < 10, 3.2 < 3.10, A < B, A.1 < A.2
function compareNumbers(a, b) {
  const pa = String(a).split(/[.\-]/), pb = String(b).split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    const c = na && nb ? +pa[i] - +pb[i] : na !== nb ? (na ? -1 : 1) : pa[i].localeCompare(pb[i]);
    if (c) return c;
  }
  return 0;
}

// As cleveref prints it: one name per kind, in the plural for several, the
// numbers of a kind sorted, and consecutive numbers as a range
// (\Cref{a,b,c,d} -> Sections 4 to 7; \Cref{rem:2,rem:1} -> Remarks 1 and 2)
function refText(cmd, keys) {
  const cap = cmd === 'Cref' || cmd === 'autoref';
  const items = keys.split(',').map((k) => k.trim()).filter(Boolean).map((k) => {
    const l = DOC.aux.labels[k] || {};
    const v = l.v || '??';
    if (cmd === 'ref') return { type: '', v };
    if (cmd === 'eqref') return { type: '', v: `(${v})` };
    const type = (k.startsWith('app:') || (l.type === 'section' && /^[A-Z]/.test(v))) ? 'appendix' : (l.type || '');
    return { type, v: type === 'equation' ? `(${v})` : v, raw: v };
  });
  if (cmd === 'ref' || cmd === 'eqref') return items.map((x) => x.v).join(', ');
  // grouped by kind, in the order the kinds first appear
  const groups = [];
  for (const x of items) {
    const g = groups.find((y) => y.type === x.type);
    if (g) g.items.push(x); else groups.push({ type: x.type, items: [x] });
  }
  for (const g of groups) if (!cmd.endsWith('nosort')) g.items.sort((a, b) => a.v === '??' || b.v === '??' ? 0 : compareNumbers(a.raw, b.raw));
  const list = (a) => a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0];
  const numbers = (vs) => {
    // runs of three or more consecutive numbers (4, 5, 6, 7 or 3.1, 3.2, 3.3) become ranges
    const out = [];
    for (let i = 0; i < vs.length;) {
      let j = i;
      const step = (a, b) => { const m = /^(.*?)(\d+)(\)?)$/.exec(a), n = /^(.*?)(\d+)(\)?)$/.exec(b); return m && n && m[1] === n[1] && +n[2] === +m[2] + 1; };
      while (j + 1 < vs.length && step(vs[j], vs[j + 1])) j++;
      if (j - i >= 2) { out.push(vs[i] + ' to ' + vs[j]); i = j + 1; } else { out.push(vs[i]); i++; }
    }
    return list(out);
  };
  return list(groups.map((g) => {
    const vs = g.items.map((x) => x.v);
    const name = g.type ? crefName(g.type, cap, vs.length > 1) : '';
    return name ? name + ' ' + numbers(vs) : numbers(vs);
  }));
}

function roman(n) {
  return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'][n] || String(n);
}

// --------------------------------------------------- DOM back to source

// Characters the block being serialized already uses as Unicode (an author
// who writes — rather than ---): typography leaves them alone.
let KEEP_UNICODE = '', KEEP_MATH_UNICODE = '';
let HOUSE_RULE_CHANGES = [];
// Maths symbols typed as Unicode (≤, α, ∀ …) stop a pdfLaTeX build: written
// as LaTeX ($\le$), unless the paper is set for XeLaTeX/LuaLaTeX or the block
// already used that character as it is.
const UNI_MATH = {
  '≤': 'le', '≥': 'ge', '≠': 'neq', '≈': 'approx', '≡': 'equiv', '∈': 'in', '∉': 'notin', '⊆': 'subseteq', '⊂': 'subset',
  '⊇': 'supseteq', '⊃': 'supset', '∪': 'cup', '∩': 'cap', '∀': 'forall', '∃': 'exists', '¬': 'neg', '∧': 'land', '∨': 'lor',
  '→': 'to', '←': 'gets', '↦': 'mapsto', '⇒': 'Rightarrow', '⇐': 'Leftarrow', '⇔': 'Leftrightarrow', '↔': 'leftrightarrow',
  '×': 'times', '⋅': 'cdot', '±': 'pm', '∓': 'mp', '∞': 'infty', '∑': 'sum', '∏': 'prod', '∅': 'emptyset', '⊕': 'oplus',
  '⊗': 'otimes', '⊥': 'bot', '⊤': 'top', '∘': 'circ', '∂': 'partial', '∇': 'nabla', '⟨': 'langle', '⟩': 'rangle', '≪': 'll', '≫': 'gg',
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'varepsilon', 'ϵ': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta',
  'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau',
  'υ': 'upsilon', 'φ': 'varphi', 'ϕ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega', 'Γ': 'Gamma', 'Δ': 'Delta', 'Θ': 'Theta',
  'Λ': 'Lambda', 'Ξ': 'Xi', 'Π': 'Pi', 'Σ': 'Sigma', 'Υ': 'Upsilon', 'Φ': 'Phi', 'Ψ': 'Psi', 'Ω': 'Omega',
};
const UNI_MATH_RE = new RegExp('[' + Object.keys(UNI_MATH).join('') + ']', 'g');
// what pdfLaTeX cannot print at all, maths or not: CJK, emoji and the like
const UNPRINTABLE_RE = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
function unicodeEngine() {
  if (unicodeEngine.v === undefined) {
    const b = DOC && DOC.config && DOC.config.build;
    const build = Array.isArray(b) ? b.join(' ') : String(b || '');
    unicodeEngine.v = /xelatex|lualatex|-xe|-lua/.test(build) ||
      Object.values(FILES).some((f) => /\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math)\b/.test(f.text || ''));
  }
  return unicodeEngine.v;
}
function ser(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) {
      // zero-width characters (pasted from web pages) stop pdfLaTeX with
      // "Unicode character U+200B"; they print nothing anyway
      let t = L.encodeText(unicodeEngine() ? n.data : n.data.replace(PASTE_INVISIBLE_RE, ''));
      t = KEEP_UNICODE ? t.replace(/[\u2013\u2014\u2018\u2019\u201c\u201d\u2026]/g, (c) => (KEEP_UNICODE.includes(c) ? c : L.typeset(c))) : L.typeset(t);
      if (!unicodeEngine()) t = t.replace(UNI_MATH_RE, (c) => (KEEP_MATH_UNICODE.includes(c) ? c : '$\\' + UNI_MATH[c] + '$'));
      // text right after a % comment would end up inside the comment: start a new line
      const prevEl = n.previousSibling;
      if (t && prevEl && prevEl.nodeType === 1 && prevEl.dataset && (prevEl.dataset.src || '').startsWith('%') &&
          !/^[\r\n]/.test(t)) t = '\n' + t;
      // text typed right after a command must not merge into it: a letter
      // after a control word (\dots + and), or [ or * after any command
      // (\\[, \item[), would change what LaTeX reads
      if (t && /\\(?:[A-Za-z@]+\*?|.)$/.test(out) && !/\\[%&_#${} ]$/.test(out) &&
          (/^[A-Za-z@]/.test(t) && /\\[A-Za-z@]+$/.test(out) || /^[\[*]/.test(t))) t = '{}' + t;
      else if (t && /^[\[*]/.test(t) && /\\[A-Za-z@]+\*?(\{[^{}]*\}|\[[^\]]*\])+$/.test(out)) t = '{}' + t;
      out += t;
      continue;
    }
    if (n.nodeType !== 1) continue;
    // a line break right after another one (the sentence between them was
    // deleted) would make a blank line, a paragraph break: keep one
    if (n.classList.contains('nl') && /^[ \t]*\n[ \t]*$/.test(n.dataset.src || '') && /\n[ \t]*$/.test(out)) {
      out = out.replace(/[ \t]+$/, '');
      continue;
    }
    if (n.dataset.src !== undefined) { out += n.dataset.src; continue; }
    if (n.dataset.prefix !== undefined) { out += n.dataset.prefix + ser(n) + '}'; continue; }
    const tag = n.tagName;
    if (tag === 'EM' || tag === 'I') out += '\\emph{' + ser(n) + '}';
    else if (tag === 'STRONG' || tag === 'B') out += '\\textbf{' + ser(n) + '}';
    else if (tag === 'BR') { if (n.nextSibling) out += '\n\n'; }
    else if (tag === 'DIV' || tag === 'P') out += '\n\n' + ser(n);
    else out += ser(n);
  }
  return out;
}

// A heading's title or a caption is the argument of a command, where a
// blank line stops LaTeX ("Paragraph ended before \addcontentsline was
// complete").  Whatever the browser left after a deletion (a <br>, a line
// break chip beside another), the lines are joined with one line break.
function oneParagraph(text) {
  return text.replace(/[ \t]*\n(?:[ \t]*\n)+[ \t]*/g, '\n');
}

// The current source of one segment, from its DOM; edited paragraphs get
// the house rules.
function segSource(seg, warnings, changes, applyRules = true) {
  if (seg.removed) return '';
  if (!seg.touched && seg.kind !== 'code') return seg.src;
  KEEP_UNICODE = (seg.src.match(/[\u2013\u2014\u2018\u2019\u201c\u201d\u2026]/g) || []).join('');
  KEEP_MATH_UNICODE = (seg.src.match(UNI_MATH_RE) || []).join('');
  const fix = (text, original) => {
    if (!applyRules || text === original) return text;
    const [t, w] = L.houseRules(text, (DOC.config || {}).house_rules, original);
    if (t !== text && changes) changes.push(seg);
    warnings.push(...w);
    return t;
  };
  switch (seg.kind) {
    case 'para': case 'quote': {
      if (!seg.edit) return seg.src;
      const out = fix(ser(seg.edit), seg.src);
      if (!unicodeEngine() && out !== seg.src) {
        const bad = [...new Set((out.match(UNPRINTABLE_RE) || []).filter((c) => !seg.src.includes(c)))];
        if (bad.length) warnings.push(`pdfLaTeX cannot print ${bad.join(' ')} (use XeLaTeX/LuaLaTeX, or remove them)`);
      }
      return out;
    }
    case 'heading': {
      if (!seg.edit || !seg.parts) return seg.src;
      return seg.parts.prefix + fix(oneParagraph(ser(seg.edit)), seg.parts.title) + seg.parts.suffix;
    }
    case 'code': return seg.edit && seg.touched ? seg.parts.pre + seg.edit.value + seg.parts.post : seg.src;
    case 'figure': case 'table':
      if (!seg.edit || !seg.parts) return seg.figSrc || seg.src;
      return seg.parts.prefix + fix(oneParagraph(ser(seg.edit)), seg.parts.caption) + seg.parts.suffix;
    case 'hidden': return seg.patched !== undefined ? seg.patched : seg.src;
    default: return seg.src;
  }
}

// Write the page back into the file texts.  Returns house-rule warnings.
function commit(applyRules = true) {
  const warnings = [];
  HOUSE_RULE_CHANGES = [];
  // the texts were committed when the diff opened: only the block edited
  // there is read back (the others show marks)
  if (DIFF_SHOWN) { diffSync(); return warnings; }
  flushEdits();
  for (const [name, f] of Object.entries(FILES)) {
    if (!f.segs) continue;
    f.text = f.segs.map((s) => segSource(s, warnings, HOUSE_RULE_CHANGES, applyRules)).join('');
  }
  return warnings;
}

function editedFiles() {
  commit();
  const edited = Object.keys(FILES).filter((n) => FILES[n].text !== FILES[n].disk);
  if (!edited.some(isNewFile)) return edited;
  const reach = reachableFiles();   // a new file nothing reads is not an edit
  return edited.filter((n) => !isNewFile(n) || reach.has(n));
}

function markEdited() {
  flushEdits();
  refreshSidebarSoon();
  countWords();
  const files = editedFiles().concat(SRC ? extraEdited() : []);
  $('#dirty').textContent = files.length ? files.length + ' file' + (files.length > 1 ? 's' : '') + ' edited' : '';
  $('#save').classList.toggle('has-changes', files.length > 0);
  for (const seg of ORDER) {
    if (seg.el) seg.el.classList.toggle('edited', segSource(seg, []) !== seg.src);
  }
}

// ------------------------------------------------------------ word count
//
// The words of the text as printed: paragraphs, headings and captions; an
// inline formula counts as one word, citations and hidden LaTeX as none.
function wordsOf(root) {
  let t = '';
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { t += n.data; continue; }
      if (n.nodeType !== 1 && n.nodeType !== 11) continue;
      const cl = n.classList;
      if (!cl) { walk(n); continue; }
      if (cl.contains('tools') || cl.contains('hidden') || cl.contains('boxbadge')) continue;
      if (cl.contains('math')) { t += cl.contains('display') ? ' ' : ' x '; continue; }
      if (cl.contains('cite') || cl.contains('item')) { t += ' '; continue; }
      if (n.dataset && n.dataset.say !== undefined) { t += ' ' + n.dataset.say + ' '; continue; }
      if (cl.contains('nl') || cl.contains('parbreak')) { t += ' '; continue; }
      walk(n);
    }
  };
  walk(root);
  return (t.match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019\-]*/gu) || []).length;
}
function countWords() {
  let n = 0;
  for (const seg of ORDER) if (seg.edit && seg.edit.isConnected && seg.edit.tagName !== 'TEXTAREA' && seg.el && seg.el.isConnected) n += wordsOf(seg.edit);
  countWords.total = n;
  // shown a moment later: reading the selection right after a render forces
  // a layout of the whole page, which in the diff view is the whole paper
  clearTimeout(showWords.t);
  showWords.t = setTimeout(showWords, 0);
}
function showWords() {
  const w = $('#words');
  if (!w) return;
  const total = (countWords.total || 0).toLocaleString('en');
  const sel = getSelection();
  let picked = null;
  if (sel.rangeCount && !sel.isCollapsed && $('#doc').contains(sel.getRangeAt(0).commonAncestorContainer)) picked = wordsOf(sel.getRangeAt(0).cloneContents());
  w.textContent = picked !== null ? `${picked.toLocaleString('en')} of ${total} words` : `${total} words`;
  w.title = 'Words in the text, headings and captions (a formula counts as one word; citations and hidden LaTeX as none)';
}
document.addEventListener('selectionchange', () => { clearTimeout(showWords.t); showWords.t = setTimeout(showWords, 120); });

// ------------------------------------------------------- structure edits

// Commit, apply a change to the segment lists, re-render from the texts.
function structural(change, snap = true) {
  // the blocks of the diff view are not the document, except the one being
  // edited there: a change in it goes on, and the diff is drawn again after
  const rediff = DIFF.on && (!DIFF_SHOWN || !!diffEditSeg());
  if (!rediff && leaveDiff()) return;
  // every structure change can be undone (Delete and Merge of a heading took
  // no snapshot, so Ctrl+Z could not bring the heading back)
  if (snap) snapshot();
  // where the change was asked for: the new placeholder is the one nearest
  // there, not the first one in the paper (an earlier one may be unfilled)
  const at = (() => { try { const sg = segOf(editableAt(selRange()) || document.body); return sg && sg.file ? { file: sg.file, line: sg.line || 0 } : null; } catch (e) { return null; } })();
  const view = viewAnchor();   // the text on screen stays where it is
  commit();
  // every segment of every file takes its current source first, so that the
  // texts rebuilt below keep the edits of files the change does not touch
  const before = new Map();
  for (const f of Object.values(FILES)) if (f.segs) f.segs.forEach((s) => { before.set(s, s.src); s.src = segSource(s, []); });
  const focus = change();
  // a paragraph break typed at the very end (or start) of a block sits next to
  // the blank line already there: keep one blank line, not two or three
  for (const f of Object.values(FILES)) {
    if (!f.segs) continue;
    const segs = f.segs.filter((x) => !x.removed);
    segs.forEach((x, i) => {
      if (x.kind === 'gap' || before.get(x) === x.src) return;
      // inside a paragraph or heading block every blank line is new (blank
      // lines separate blocks in the source): two breaks in a row make one
      if (x.kind === 'para' || x.kind === 'heading') x.src = x.src.replace(/\n(?:[ \t]*\n){2,}/g, '\n\n');
      if (segs[i + 1] && segs[i + 1].kind === 'gap' && /\n\s*$/.test(x.src)) x.src = x.src.replace(/\s+$/, '');
      if (segs[i - 1] && segs[i - 1].kind === 'gap' && /^\s*\n[ \t]*\n/.test(x.src)) x.src = x.src.replace(/^\s+/, '');
    });
  }
  for (const f of Object.values(FILES)) if (f.segs) f.text = f.segs.map((s) => s.removed ? '' : s.src).join('');
  render();
  restoreAnchor(view);
  const near = INSERT_HINT || at;
  INSERT_HINT = null;
  if (focus) focusPlaceholder(focus, near);
  if (rediff) diffAgain(captureEditorState());
}

// Take a block out with one of the gaps around it: the one after a heading
// (its text then follows the blank line before it, as a paragraph of its own).
function removeSeg(seg) {
  const segs = FILES[seg.file].segs;
  const i = segs.indexOf(seg);
  seg.removed = true;
  if (seg.kind === 'heading' && segs[i + 1] && segs[i + 1].kind === 'gap' && i > 0 && segs[i - 1].kind === 'gap') segs[i + 1].removed = true;
  else if (i > 0 && segs[i - 1].kind === 'gap') segs[i - 1].removed = true;
}

let INSERT_HINT = null;   // where insertAfter put its block: structural focuses there
function insertAfter(seg, src) {
  INSERT_HINT = { file: seg.file, line: (seg.lastLine || seg.line || 0) + 1 };
  const segs = FILES[seg.file].segs;
  const i = segs.indexOf(seg);
  segs.splice(i + 1, 0, { kind: 'gap', src: '\n\n', file: seg.file }, { kind: 'para', src, file: seg.file });
}

const HEADING_RANK = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
// The rank of a heading; for an \input, the rank of the first heading of
// the file it reads (it starts a section of the document), if any.
function headingRank(seg, seen = new Set()) {
  if (!seg) return null;
  if (seg.kind === 'input') {
    const f = seg.input && FILES[seg.input];
    if (!f || !f.segs || seen.has(seg.input)) return null;
    seen.add(seg.input);
    for (const s of f.segs) {
      const r = s.kind === 'heading' || s.kind === 'input' ? headingRank(s, seen) : null;
      if (r !== null) return r;
    }
    return null;
  }
  const h = seg.kind === 'heading' && L.headingParts(seg.src);
  return h ? HEADING_RANK[h.level] : null;
}

function sectionEnd(segs, start, rank) {
  for (let i = start + 1; i < segs.length; i++) {
    const next = headingRank(segs[i]);
    if (next !== null && next <= rank) return i;
  }
  return segs.length;
}

// What must stay where it is: the end of the document, the bibliography,
// the start of the appendices.
const FIXED_RE = /\\(end\{document\}|bibliography\b|printbibliography|begin\{thebibliography\}|appendix\b|appendices\b|backmatter\b)/;
const fixedIn = (chunk) => chunk.some((s) => s.kind !== 'gap' && FIXED_RE.test(s.src.replace(/(^|[^\\])%.*$/gm, '$1')));

// Swap the neighbouring chunks segs[i..j) and segs[j..k), keeping the blank
// lines between and after them where they were.
function swapChunks(segs, i, j, k) {
  const split = (lo, hi) => { let m = hi; while (m > lo && segs[m - 1].kind === 'gap') m--; return [segs.slice(lo, m), segs.slice(m, hi)]; };
  const [aBody, aGap] = split(i, j);
  const [bBody, bGap] = split(j, k);
  const file = segs[i].file;
  const sep = aGap.length ? aGap : [{ kind: 'gap', src: '\n\n', file }];
  segs.splice(i, k - i, ...bBody, ...sep, ...aBody, ...(bGap.length ? bGap : (k === segs.length ? [] : [{ kind: 'gap', src: '\n\n', file }])));
}

function moveSection(seg, direction) {
  // a section that is a whole file moves as its \input, among its siblings
  // in the file that reads it (one section per file)
  if (seg && seg.kind === 'heading' && seg.file !== DOC.main && sectionIsWholeFile(seg)) {
    const inp = inputSegOf(seg.file);
    if (inp && headingRank(inp) === headingRank(seg)) seg = inp;
  }
  const segs = FILES[seg.file] && FILES[seg.file].segs;
  const start = segs ? segs.indexOf(seg) : -1;
  const rank = headingRank(seg);
  if (!segs || start < 0 || rank === null) return;
  const end = sectionEnd(segs, start, rank);
  let lo, mid, hi;
  if (direction < 0) {
    let previous = -1;
    for (let i = start - 1; i >= 0; i--) {
      const r = headingRank(segs[i]);
      if (r !== null && r < rank) break;
      if (r === rank) { previous = i; break; }
    }
    if (previous < 0 || !['heading', 'input'].includes(segs[previous].kind)) {
      banner(previous < 0 ? 'This section is already first among its siblings.' : 'The section before this one is in another file (\\input); move it there.');
      return;
    }
    [lo, mid, hi] = [previous, start, end];
  } else {
    const next = end < segs.length ? headingRank(segs[end]) : null;
    if (next !== rank || !['heading', 'input'].includes(segs[end].kind)) {
      banner(next === rank ? 'The section after this one is in another file (\\input); move it there.' : 'This section is already last among its siblings.');
      return;
    }
    [lo, mid, hi] = [start, end, sectionEnd(segs, end, rank)];
  }
  if (fixedIn(segs.slice(lo, hi))) {
    banner('One of these sections holds the end of the document, the bibliography or \\appendix, which cannot move with it.');
    return;
  }
  structural(() => swapChunks(segs, lo, mid, hi));
}

const PLACEHOLDER = 'Write here.';
function addMenu(seg, anchor) {
  const items = [
    ['Paragraph', PLACEHOLDER],
    ['Section heading', '\\section{' + PLACEHOLDER + '}'],
    ['Subsection heading', '\\subsection{' + PLACEHOLDER + '}'],
    ['Paragraph heading (\\paragraph)', '\\paragraph{' + PLACEHOLDER + '}\nText.'],
    ['Displayed maths', '\\[\n  x\n\\]'],
    ['EasyCrypt listing', '\\begin{ecblock}\n\\begin{lstlisting}\n(* EasyCrypt *)\n\\end{lstlisting}\n\\end{ecblock}'],
  ];
  const m = $('#menu');
  m.textContent = '';
  for (const [label, src] of items) {
    const b = el('button', '', label);
    b.onclick = () => { m.hidden = true; structural(() => { insertAfter(seg, src); return PLACEHOLDER; }); };
    m.append(b);
  }
  const extra = [
    ['Section in a new file (sections/)', () => newSectionFile('', seg)],
    ['Figure from an image…', () => pickImages(seg)],
    ['Include a file…', () => openFiles()],
  ];
  for (const [label, fn] of extra) {
    const b = el('button', '', label);
    b.onclick = () => { m.hidden = true; fn(); };
    m.append(b);
  }
  const r = anchor.getBoundingClientRect();
  m.style.left = (r.right + window.scrollX + 4) + 'px';
  m.style.top = (r.top + window.scrollY) + 'px';
  m.hidden = false;
}
document.addEventListener('click', (e) => { if (!$('#menu').contains(e.target)) $('#menu').hidden = true; });

function focusPlaceholder(text, near) {
  let best = null;
  for (const seg of ORDER) {
    if (!seg.edit || seg.edit.tagName === 'TEXTAREA') continue;
    const walker = document.createTreeWalker(seg.edit, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.data.indexOf(text);
      if (i < 0) continue;
      // nearest to where the change was asked for; at equal distance, after it
      const d = !near ? 0 : seg.file !== near.file ? 1e9 : Math.abs((seg.line || 0) - near.line) * 2 + ((seg.line || 0) < near.line ? 1 : 0);
      if (!best || d < best.d) best = { d, seg, n, i };
      break;
    }
    if (best && best.d === 0) break;
  }
  if (!best) return;
  const r = document.createRange();
  r.setStart(best.n, best.i); r.setEnd(best.n, best.i + text.length);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  best.seg.edit.focus({ preventScroll: true });
  // the new block is shown only if it is out of view: adding a heading
  // under the text you are reading does not move that text
  const rect = r.getBoundingClientRect();
  revealChanged(rect.height ? rect : best.seg.el.getBoundingClientRect(), best.seg);
}

// ------------------------------------------------------------- files
//
// One section per file: a section can move to a file of its own under
// sections/ (beside the main file), every section at once, and back again.
// New files exist only in the editor (FILES[name].base === null) until saved;
// Undo takes them out again, and a new file nothing reads is never written.

const SECTION_RANK_MAX = 2;   // \section (or \chapter, \part) start a file of their own
function sectionsDir() {
  const i = DOC.main.lastIndexOf('/');
  return (i >= 0 ? DOC.main.slice(0, i + 1) : '') + 'sections/';
}
function slugify(s) {
  const slug = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'section';
}
function plainOfLatex(src) {
  const d = el('span');
  try { renderTokens(L.tokenize(src), d, {}); } catch (e) { return src; }
  return d.textContent;
}
function knownFiles(except) {
  // a new file nothing reads any more (undone, put back) does not hold its name
  const reach = Object.keys(FILES).some(isNewFile) ? reachableFiles() : null;
  const s = new Set([...((DOC && DOC.disk_files) || []), ...Object.keys(FILES).filter((n) => !isNewFile(n) || reach.has(n))]);
  if (except) s.delete(except);
  return s;
}
function freeFile(dir, slug, except) {
  const known = knownFiles(except);
  let name = dir + slug + '.tex', k = 2;
  while (known.has(name)) name = dir + slug + '-' + (k++) + '.tex';
  return name;
}
const inputArgOf = (name) => name.replace(/\.tex$/, '');
function newFile(name, text) { FILES[name] = { text, disk: null, base: null }; }
function isNewFile(name) { return !!FILES[name] && FILES[name].base === null; }

// The files the document reads now, from the main file down, in order.
function reachableFiles() {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !FILES[name]) return;
    seen.add(name);
    const segs = FILES[name].segs || parseFile(name);
    for (const s of segs) if (s.kind === 'input' && !s.removed && s.input) visit(s.input);
  };
  visit(DOC.main);
  return seen;
}
// The \input segment that reads a file, and the file it is in.
function inputSegOf(name) {
  for (const f of Object.values(FILES)) for (const s of f.segs || []) if (s.kind === 'input' && !s.removed && s.input === name) return s;
  return null;
}

// The name a section's file gets: its label (sec:intro -> intro), or its title.
function sectionFileName(seg, except) {
  const h = L.headingParts(seg.src);
  const label = /\\label\{(?:sec:|section:|s:|app:|chap:)?([^}]*)\}/.exec(seg.src);
  const title = h ? plainOfLatex(h.title) : '';
  const slug = label ? slugify(label[1]) : slugify(title === PLACEHOLDER ? 'new-section' : title);
  return freeFile(sectionsDir(), slug, except);
}

// The blocks of a section in its file: from its heading to the next heading
// of the same or a higher rank, without what must stay where it is (the
// bibliography, \appendix, \end{document}) and the blank lines after it.
function sectionRange(seg) {
  const segs = FILES[seg.file].segs;
  const start = segs.indexOf(seg);
  const rank = headingRank(seg);
  if (start < 0 || rank === null) return null;
  let end = sectionEnd(segs, start, rank);
  for (let i = start + 1; i < end; i++) {
    if (segs[i].kind !== 'gap' && !segs[i].removed && FIXED_RE.test(segs[i].src.replace(/(^|[^\\])%.*$/gm, '$1'))) { end = i; break; }
  }
  while (end > start + 1 && (segs[end - 1].kind === 'gap' || segs[end - 1].removed)) end--;
  return [start, end];
}
// Whether a file holds just this section (blank lines and comments aside).
function sectionIsWholeFile(seg) {
  const r = sectionRange(seg);
  if (!r) return false;
  const segs = FILES[seg.file].segs;
  const quiet = (s) => s.removed || s.kind === 'gap' || (s.kind === 'para' && !s.src.replace(/(^|[^\\])%.*$/gm, '$1').trim());
  return segs.slice(0, r[0]).every(quiet) && segs.slice(r[1]).every(quiet);
}

// Move a section into a file of its own (inside a structural change).  A
// section at the end of a file that is itself read by another goes beside
// that file's \input (one section per file, not files in files).
function extractSection(seg, name) {
  const segs = FILES[seg.file].segs;
  const r = sectionRange(seg);
  if (!r) return null;
  const [start, end] = r;
  name = name || sectionFileName(seg);
  const body = segs.slice(start, end).filter((s) => !s.removed).map((s) => s.src).join('').replace(/\s*$/, '\n');
  newFile(name, body);
  const atEnd = segs.slice(end).every((s) => s.removed || s.kind === 'gap');
  const parent = seg.file !== DOC.main && atEnd && start > 0 ? inputSegOf(seg.file) : null;
  const input = (file) => ({ kind: 'input', src: '\\input{' + inputArgOf(name) + '}', input: name, file });
  if (parent) {
    // out of this file (with the blank lines before it), in after its \input
    let from = start;
    while (from > 0 && segs[from - 1].kind === 'gap') from--;
    segs.splice(from, end - from);
    const psegs = FILES[parent.file].segs;
    psegs.splice(psegs.indexOf(parent) + 1, 0, { kind: 'gap', src: '\n', file: parent.file }, input(parent.file));
  } else {
    segs.splice(start, end - start, input(seg.file));
  }
  return name;
}

// Put a file's text back where it is read; the file stays on disk (Files…
// can move it to the trash once nothing reads it).
function inlineFile(name) {
  const inp = inputSegOf(name);
  if (!inp || !FILES[name]) return false;
  commit();
  structural(() => { inp.src = FILES[name].text.replace(/\s+$/, ''); });
  toast(isNewFile(name) ? `${name} was never saved: it is gone` : `${name} is back in ${inp.file}; the file stays on disk, unused (Files… can move it to the trash)`, 'ok');
  return true;
}

// Rename a file the editor made and has not saved yet: only the editor knows it.
function renameNewFile(from, to) {
  const inp = inputSegOf(from);
  FILES[to] = FILES[from];
  delete FILES[from];
  if (inp) { inp.src = inp.src.replace('{' + inputArgOf(from) + '}', '{' + inputArgOf(to) + '}').replace('{' + from + '}', '{' + to + '}'); inp.input = to; }
}

// A new file still called after its placeholder (sections/new-section.tex)
// takes the name of its section once that has a title, when it is saved.
function settleNewFileNames() {
  const todo = [];
  for (const name of Object.keys(FILES)) {
    if (!isNewFile(name) || !/(^|\/)new-section(-\d+)?\.tex$/.test(name)) continue;
    const seg = (FILES[name].segs || []).find((s) => s.kind === 'heading' && !s.removed);
    if (!seg) continue;
    const src = segSource(seg, []);
    const h = L.headingParts(src);
    if (!h || plainOfLatex(h.title).trim() === PLACEHOLDER) continue;
    const want = sectionFileName({ src }, name);
    if (want !== name) todo.push([name, want]);
  }
  if (!todo.length) return;
  structural(() => { for (const [a, b] of todo) renameNewFile(a, b); }, false);
}

function splitToFile(seg) {
  if (!seg || seg.kind !== 'heading') { toast('Put the cursor in a section heading for that', 'error'); return; }
  const rank = headingRank(seg);
  if (rank === null) return;
  if (seg.file !== DOC.main && sectionIsWholeFile(seg)) { toast(`This section already has its file: ${seg.file}`); return; }
  let name;
  structural(() => { name = extractSection(seg); });
  if (name) toast(`Section moved to ${name}; save to write it`, 'ok');
}

// Every section of the document in a file of its own.
function planSectionFiles() {
  const top = Math.min(...Object.values(FILES).flatMap((f) => (f.segs || []).filter((s) => s.kind === 'heading' && !s.removed).map(headingRank).filter((r) => r !== null)), SECTION_RANK_MAX);
  const reach = reachableFiles();
  const plan = [];
  for (const name of reach) {
    const heads = (FILES[name].segs || []).filter((s) => s.kind === 'heading' && !s.removed && headingRank(s) === top);
    if (!heads.length) continue;
    // a section file keeps its first section: the others leave it
    const keep = name !== DOC.main && sectionIsWholeFile(heads[0]) ? 1 : (name !== DOC.main && !(FILES[name].segs || []).slice(0, FILES[name].segs.indexOf(heads[0])).some((s) => !s.removed && s.kind !== 'gap' && s.src.replace(/(^|[^\\])%.*$/gm, '$1').trim()) ? 1 : 0);
    heads.slice(keep).forEach((s) => plan.push(s));
  }
  return plan;
}
function splitAllSections() {
  commit();
  const plan = planSectionFiles();
  if (!plan.length) { toast('Every section already has a file of its own'); return; }
  // names first, so that each is distinct
  const taken = new Set();
  const names = plan.map((s) => {
    let n = sectionFileName(s);
    for (let k = 2; taken.has(n); k++) n = n.replace(/(-\d+)?\.tex$/, '-' + k + '.tex');
    taken.add(n);
    return n;
  });
  const list = plan.map((s, i) => `  ${plainOfLatex((L.headingParts(s.src) || {}).title || '')} → ${names[i]}`).join('\n');
  if (!confirm(`Move ${plan.length} section${plan.length === 1 ? '' : 's'} into files of their own?\n\n${list.slice(0, 1800)}\n\nEach is read with \\input where it was. Nothing is written until you save, and Undo puts them back.`)) return;
  // from the last to the first: earlier places stay where they are
  structural(() => { for (let i = plan.length - 1; i >= 0; i--) { taken.delete(names[i]); extractSection(plan[i], names[i]); } });
  toast(`${plan.length} section file${plan.length === 1 ? '' : 's'} under ${sectionsDir()}; save to write them`, 'ok');
}

// Whether the paper keeps its sections in files of their own.
function sectionFilesLayout() {
  const dir = sectionsDir();
  return [...reachableFiles()].some((n) => n.startsWith(dir));
}

// Where a new top-level section goes: after the section at the cursor (after
// its file's \input when it has a file of its own), else before the end of
// the text (the appendix, the bibliography, \end{document}).
function newSectionPlace(seg) {
  if (seg) {
    let head = null;
    const segs = FILES[seg.file].segs;
    for (let i = segs.indexOf(seg); i >= 0; i--) if (segs[i].kind === 'heading' && headingRank(segs[i]) !== null && headingRank(segs[i]) <= SECTION_RANK_MAX) { head = segs[i]; break; }
    if (head && head.file !== DOC.main && sectionIsWholeFile(head)) {
      const inp = inputSegOf(head.file);
      if (inp) return { segs: FILES[inp.file].segs, after: inp };
    }
    if (head) { const r = sectionRange(head); return { segs, after: segs[r[1] - 1] }; }
    return { segs, after: seg };
  }
  const segs = FILES[DOC.main].segs;
  const fixed = segs.findIndex((s) => s.kind !== 'gap' && FIXED_RE.test(s.src.replace(/(^|[^\\])%.*$/gm, '$1')));
  let i = (fixed < 0 ? segs.length : fixed) - 1;
  while (i > 0 && (segs[i].kind === 'gap' || segs[i].removed)) i--;
  return { segs, after: segs[Math.max(0, i)] };
}
function insertInputAfter(place, name) {
  const { segs, after } = place;
  const file = after.file;
  INSERT_HINT = { file: name, line: 1 };
  segs.splice(segs.indexOf(after) + 1, 0, { kind: 'gap', src: after.kind === 'input' ? '\n' : '\n\n', file }, { kind: 'input', src: '\\input{' + inputArgOf(name) + '}', input: name, file });
}
function newSectionFile(title, seg) {
  title = (title || '').trim();
  const slug = slugify(title || 'new-section');
  const name = freeFile(sectionsDir(), title ? slug : 'new-section');
  const label = title ? '\\label{sec:' + slug + '}' : '';
  const place = newSectionPlace(seg);
  structural(() => {
    newFile(name, `\\section{${title ? escapeIn(title, '&%$#_{}') : PLACEHOLDER}}${label}\n\n${PLACEHOLDER}\n`);
    insertInputAfter(place, name);
    return PLACEHOLDER;
  });
  toast(`New section file ${name}; save to write it`, 'ok');
  return name;
}

// ---- adding images: the file goes to figures/, a figure after the block
async function addImages(files, seg) {
  const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(pdf|eps)$/i.test(f.name));
  if (!list.length) { toast('Only images (PNG, JPEG, PDF, EPS, SVG) can be added', 'error'); return; }
  const added = [];
  for (const f of list) {
    if (f.size > 40e6) { banner(`${f.name} is larger than 40 MB`); continue; }
    const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = no; r.readAsDataURL(f); });
    const ext = (/\.[A-Za-z0-9]+$/.exec(f.name) || [''])[0] || ('.' + (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg'));
    const name = /^image\.[a-z]+$|^$/.test(f.name) || !/\./.test(f.name) ? 'pasted-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + ext : f.name;
    const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ name, data }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) { banner(`Adding ${f.name} failed: ${res.error || r.status}`); continue; }
    added.push(res.path);
    DOC.graphicx = res.graphicx;
  }
  if (!added.length) return;
  const target = seg || caretSeg() || ORDER.filter((s) => s.el && s.kind !== 'hidden').pop();
  if (!target) return;
  const figs = added.map((p) => {
    const key = slugify(p.replace(/^.*\//, '').replace(/\.[^.]*$/, ''));
    return `\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{${p}}\n  \\caption{${PLACEHOLDER}}\n  \\label{fig:${key}}\n\\end{figure}`;
  });
  structural(() => { insertAfter(target, figs.join('\n\n')); return PLACEHOLDER; });
  toast(`Added ${added.join(', ')}; the picture shows after the next build`, 'ok');
  if (!DOC.graphicx) offerPackage('graphicx', 'Figures with \\includegraphics need the graphicx package');
}
function offerPackage(pkg, why) {
  const front = preambleSeg();
  if (!front) { banner(why + ': add \\usepackage{' + pkg + '} to the preamble.'); return false; }
  if (!confirm(why + ', which this paper does not load.\n\nAdd \\usepackage{' + pkg + '} to the preamble of ' + DOC.main + '? It is written when you save.')) return false;
  const src = front.patched !== undefined ? front.patched : front.src;
  const i = src.lastIndexOf('\\begin{document}');
  front.patched = src.slice(0, i) + '\\usepackage{' + pkg + '}\n' + src.slice(i);
  front.touched = true;
  if (pkg === 'graphicx') DOC.graphicx = true;
  markEdited();
  return true;
}
function pickImages(seg) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.accept = 'image/*,.pdf,.eps';
  inp.onchange = () => addImages(inp.files, seg);
  inp.click();
}
$('#doc').addEventListener('dragover', (e) => {
  if (DIFF.on || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  $('#doc').classList.add('dropping');
});
$('#doc').addEventListener('dragleave', (e) => { if (e.target === $('#doc')) $('#doc').classList.remove('dropping'); });
$('#doc').addEventListener('drop', (e) => {
  $('#doc').classList.remove('dropping');
  if (DIFF.on || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const at = document.elementFromPoint(e.clientX, e.clientY);
  addImages(e.dataTransfer.files, at ? segOf(at) : null);
});
// a picture pasted into the text (a screenshot): added as a figure
$('#doc').addEventListener('paste', (e) => {
  const files = e.clipboardData && [...e.clipboardData.files].filter((f) => /^image\//.test(f.type));
  if (!files || !files.length || (e.clipboardData.getData('text/plain') || '').trim()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  addImages(files, caretSeg());
}, true);

// ---- the file of a block: a menu on the first block of every file
function fileMenu(name, anchor) {
  const m = $('#menu');
  m.textContent = '';
  const inp = inputSegOf(name);
  const items = [
    [`Open ${name} in the source view`, () => toggleSource(true).then(() => openSourceFile(name))],
    ['Rename…', () => renameFilePrompt(name)],
  ];
  if (inp) items.push([`Put the text back into ${inp.file}`, () => { if (confirm(`Put the text of ${name} back into ${inp.file}, where it is read?\n\nThe file stays on disk${isNewFile(name) ? ' (it was never saved)' : ', unused'}.`)) inlineFile(name); }]);
  if (inp && inp.el === undefined) items.push(['Show where it is read', () => toggleSource(true).then(() => openSourceFile(inp.file, inp.line))]);
  items.push(['Files…', () => openFiles()]);
  for (const [label, fn] of items) {
    const b = el('button', '', label);
    b.onclick = () => { m.hidden = true; fn(); };
    m.append(b);
  }
  const r = anchor.getBoundingClientRect();
  m.style.left = (r.left + window.scrollX) + 'px';
  m.style.top = (r.bottom + window.scrollY + 2) + 'px';
  m.hidden = false;
}

async function renameFilePrompt(name) {
  if (name === DOC.main) { toast('The main file is renamed outside the editor', 'error'); return; }
  const ext = name.endsWith('.bib') ? '.bib' : '.tex';
  const to = (prompt(`Rename ${name} to (a ${ext} path inside the paper's folder):`, name) || '').trim();
  await renameFile(name, to);
}
// Rename a file of the paper (every \input of it, or \bibliography naming
// it, follows); true when it was renamed.
async function renameFile(name, to) {
  if (name === DOC.main) { toast('The main file is renamed outside the editor', 'error'); return false; }
  const ext = name.endsWith('.bib') ? '.bib' : '.tex';
  to = (to || '').trim();
  if (!to || to === name) return false;
  const dest = checkNewName(to, ext);
  if (!dest) return false;
  flushSource();
  if (SRC.extra && SRC.extra[name] && SRC.extra[name].text !== SRC.extra[name].disk) {
    if (!confirm(`${name} has unsaved edits: save them first, then rename?`)) return false;
    await save();
  }
  const shown = SRC.on && SRC.name === name;
  if (isNewFile(name)) {
    structural(() => renameNewFile(name, dest), false);
    toast(`Renamed to ${dest} (not saved yet)`, 'ok');
    refreshFiles();
    if (SRC.on) { await srcReloadFiles(); if (shown) await openSourceFile(dest); else drawSourceFiles(); }
    return true;
  }
  // a file on disk: its readers must be saved, then the server renames it
  // and rewrites their \input
  if (editedFiles().length) {
    if (!confirm('Renaming writes to disk at once, so your edits are saved first. Save and rename?')) return false;
    await save();
    if (editedFiles().length) { toast('Not renamed: some files could not be saved', 'error'); return false; }
  }
  const batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const r = await fetch('/api/file/rename', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ from: name, to: dest, batch }) });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) { banner(`Renaming ${name} failed: ${res.error || r.status}`); return false; }
  delete FILES[name];
  if (SRC.extra) delete SRC.extra[name];
  await load(true);
  toast(`Renamed to ${dest}${res.changed.length ? '; updated ' + res.changed.join(', ') : ''}`, 'ok');
  refreshFiles();
  if (SRC.on) {
    await srcReloadFiles();
    if (shown) await openSourceFile(dest);
    else { syncSourceText(); drawSourceFiles(); }
  }
  return true;
}

// ---- the Files window
const FILESUI = { at: null };
function openFiles() {
  FILESUI.at = caretSeg();
  $('#filesbox').hidden = false;
  refreshFiles();
}
function closeFiles() { $('#filesbox').hidden = true; }
async function refreshFiles() {
  if ($('#filesbox').hidden) return;
  try { const r = await fetch('/api/srcfiles'); if (r.ok) DOC.disk_files = (await r.json()).map((f) => f.name); } catch (e) { /* keep the old list */ }
  commit();
  const reach = reachableFiles();
  const order = [...reach];
  const rest = (DOC.disk_files || []).filter((n) => !reach.has(n) && /\.tex$/.test(n)).sort();
  const list = $('#files-list');
  list.textContent = '';
  const row = (name, used) => {
    const r = el('div', 'file-row' + (used ? '' : ' unused'));
    const n = el('span', 'file-name', name);
    const inp = inputSegOf(name);
    const depth = (() => { let d = 0, cur = inp; while (cur && d < 8) { d++; cur = inputSegOf(cur.file); } return d; })();
    n.style.paddingLeft = (depth * 1.1) + 'em';
    const tags = el('span', 'file-tags');
    if (name === DOC.main) tags.append(el('span', 'tag', 'main'));
    if (isNewFile(name)) tags.append(el('span', 'tag new', 'new, unsaved'));
    else if (FILES[name] && FILES[name].text !== FILES[name].disk) tags.append(el('span', 'tag edited', 'edited'));
    if (!used) tags.append(el('span', 'tag', 'not read by the document'));
    const heads = FILES[name] && (FILES[name].segs || []).filter((s) => s.kind === 'heading' && !s.removed && headingRank(s) !== null && headingRank(s) <= SECTION_RANK_MAX);
    if (heads && heads.length) tags.append(el('span', 'tag sec', heads.map((s) => plainOfLatex((L.headingParts(segSource(s, [])) || {}).title || '')).join(' · ').slice(0, 80)));
    const acts = el('span', 'file-acts');
    const btn = (label, title, fn) => { const b = el('button', '', label); b.title = title; b.onclick = fn; acts.append(b); };
    if (used) {
      const first = ORDER.find((s) => s.file === name && s.el);
      if (first) btn('Go', 'Show it in the paper', () => { closeFiles(); navPush(); first.el.scrollIntoView({ block: 'start', behavior: SMOOTH() }); });
    }
    if (!isNewFile(name)) btn('Source', 'Open it in the source view', () => { closeFiles(); toggleSource(true).then(() => openSourceFile(name)); });
    if (name !== DOC.main) btn('Rename…', 'Rename it (and every \\input of it)', () => renameFilePrompt(name));
    if (inp) btn('Inline', `Put its text back into ${inp.file}`, () => { if (confirm(`Put the text of ${name} back into ${inp.file}?`)) { closeFiles(); inlineFile(name); } });
    if (!used) {
      btn('Include', 'Read it here: \\input after the block at the cursor (or at the end of the text)', () => {
        closeFiles();
        const place = FILESUI.at ? { segs: FILES[FILESUI.at.file].segs, after: FILESUI.at } : newSectionPlace(null);
        (async () => {
          if (!FILES[name]) {
            const r = await fetch('/api/srcfile?name=' + encodeURIComponent(name));
            const d = r.ok ? await r.json() : null;
            if (!d) { toast('Could not read ' + name, 'error'); return; }
            FILES[name] = { text: d.text, disk: d.text, base: d.hash };
          }
          structural(() => insertInputAfter(place, name));
          toast(`${name} is read after the block at the cursor; save to keep it`, 'ok');
        })();
      });
      btn('Trash', 'Move it to the editor\'s trash (.paper-editor/trash)', async () => {
        if (!confirm(`Move ${name} to the editor's trash (.paper-editor/trash)? The document does not read it.`)) return;
        const r = await fetch('/api/file/trash', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ name }) });
        const res = await r.json().catch(() => ({}));
        if (!r.ok) { banner(`Could not move ${name}: ${res.error || r.status}`); return; }
        toast(`${name} moved to ${res.trash}`, 'ok');
        refreshFiles();
      });
    }
    r.append(n, tags, acts);
    list.append(r);
  };
  for (const n of order) row(n, true);
  if (rest.length) list.append(el('div', 'files-sub', 'Other .tex files of the folder'));
  for (const n of rest) row(n, false);
  const plan = planSectionFiles();
  $('#files-split').disabled = !plan.length;
  $('#files-split').title = plan.length ? `Move ${plan.length} section${plan.length === 1 ? '' : 's'} into files of their own under ${sectionsDir()}` : 'Every section already has a file of its own';
}

// Join a paragraph to the previous one (Backspace at its start).
function joinWithPrevious(seg) {
  const segs = FILES[seg.file].segs;
  let i = segs.indexOf(seg) - 1;
  const gaps = [];
  while (i >= 0 && segs[i].kind === 'gap') gaps.push(segs[i--]);
  const prev = segs[i];
  if (!prev || prev.kind !== 'para' || !prev.edit || prev.removed) return false;
  const caretAt = prev.edit.childNodes.length;
  prev.edit.append(chip('nl', '\n', ' '));
  while (seg.edit.firstChild) prev.edit.append(seg.edit.firstChild);
  gaps.forEach((g) => { g.removed = true; });
  seg.removed = true;
  seg.el.remove();
  const r = document.createRange();
  r.setStart(prev.edit, caretAt + 1);
  r.collapse(true);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  prev.edit.focus();
  markEdited();
  return true;
}

// ---------------------------------------------------------- the drawer

let drawerChip = null, drawerSeg = null;

// `fresh`: the chip was just inserted to be written here; closing the
// drawer without applying takes it out again.
let drawerFresh = false;
function openDrawer(chipEl, seg, title, fresh = false) {
  if (drawerChip && drawerChip !== chipEl) closeDrawer(false);   // a new formula left unwritten
  drawerChip = chipEl; drawerSeg = seg; drawerFresh = fresh;
  $('#drawer-title').textContent = title || 'Edit LaTeX';
  const ta = $('#drawer-src');
  ta.value = chipEl.dataset.src;
  $('#drawer').hidden = false;
  // the preview keeps a steady height while the formula is typed: room for
  // a fraction or a sum from the start, and it never shrinks while open
  const [, display] = mathBody(ta.value);
  $('#drawer-preview').style.minHeight = chipEl.classList.contains('math') ? (display ? '5.5em' : '3em') : '';
  preview();
  ta.focus();
  const [body] = mathBody(ta.value);
  if (/^\s*x?\s*$/.test(body)) { // a new formula: put the cursor inside it
    // \[ (empty line) \]: on the empty line, not before the \]
    const nl = body.lastIndexOf('\n');
    const at = ta.value.indexOf(body);
    const i = at + (nl > 0 ? nl : body.length - (body.endsWith(' ') ? 1 : 0));
    // $ $: the space is selected, so what is typed replaces it
    if (body === ' ') ta.setSelectionRange(at, at + 1);
    else ta.setSelectionRange(i, i);
  } else if (body !== ta.value) { // an existing one: at the end of the maths, not after the closing $
    const i = ta.value.lastIndexOf(body) + body.length;
    ta.setSelectionRange(i, i);
  }
}

function preview() {
  const src = $('#drawer-src').value;
  const p = $('#drawer-preview');
  p.textContent = '';
  renderTokens(L.tokenize(src), p, {});
  const h = p.getBoundingClientRect().height;
  if (h > parseFloat(getComputedStyle(p).minHeight || 0)) p.style.minHeight = h + 'px';
}

function applyDrawer(remove) {
  if (!drawerChip) return closeDrawer(true);
  // its window was redrawn or closed: the formula is gone, write nowhere
  if (!drawerChip.isConnected) { closeDrawer(true); toast('That formula is no longer shown (its window changed): open it again', 'error'); return; }
  if (drawerChip.isConnected) snapshot();
  const src = $('#drawer-src').value;
  if (remove || !src.trim()) {
    if (drawerFresh) closeDrawer(false);      // with its line breaks
    else {
      const host = drawerChip.parentElement && drawerChip.parentElement.closest('#fv-body [contenteditable=true]');
      drawerChip.remove();
      if (host) host.dispatchEvent(new Event('input', { bubbles: true }));
      closeDrawer(true);
    }
  } else {
    const frag = document.createDocumentFragment();
    renderTokens(L.tokenize(src), frag, {});
    const last = frag.lastChild;
    const host = drawerChip.parentElement && drawerChip.parentElement.closest('[contenteditable=true]');
    drawerChip.replaceWith(frag);
    // a formula of a game line, table cell or game title: its editor reads it back
    if (host && host.closest('#fv-body, .fv-head')) host.dispatchEvent(new Event('input', { bubbles: true }));
    // back to the text, just after the formula, to go on typing (the focus
    // was in the drawer: typing after Ctrl+Enter used to go nowhere)
    if (last && last.isConnected && host && host.isConnected) { host.focus({ preventScroll: true }); setCaretAfter(last); }
    closeDrawer(true);
  }
  markEdited();
}

function closeDrawer(applied) {
  if (!applied && drawerFresh && drawerChip && drawerChip.isConnected) {
    // the line breaks put around a new displayed formula go with it
    for (const n of [drawerChip.previousSibling, drawerChip.nextSibling]) {
      if (n && n.nodeType === 1 && n.classList.contains('nl') && n.dataset.fresh) n.remove();
    }
    drawerChip.remove();
    markEditedSoon();
  }
  $('#drawer').hidden = true; drawerChip = null; drawerSeg = null; drawerFresh = false;
}

$('#drawer-src').addEventListener('input', preview);
$('#drawer-src').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyDrawer(false); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDrawer(false); }
});
$('#drawer-apply').onclick = () => applyDrawer(false);
$('#drawer-delete').onclick = () => applyDrawer(true);
$('#drawer-cancel').onclick = () => closeDrawer(false);

// Insert a chip with the given source at the caret, and open it.
function insertSource(src, title) {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const host = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  if (!host || !host.closest('[contenteditable=true]')) return;
  const c = chip('src', src, src);
  deleteKeepingEnvs(range);
  range.insertNode(c);
  range.setStartAfter(c); range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
  openDrawer(c, null, title);
}

// --------------------------------------------------------------- events

const doc = $('#doc');
// a chip inside a chip (\underline{$x$}, {...}): the outer one holds the source
function outerChip(n) {
  let c = n.closest('.chip');
  while (c && c.parentElement && c.parentElement.closest('.chip')) c = c.parentElement.closest('.chip');
  return c;
}
// Ctrl+click (Cmd+click) on a reference or citation: go to what it names
// (Lemma 4, the equation, the entry in the references), and back with Alt+Left.
// Back and forward, as in a browser: every jump (a reference followed, a box
// warning, a change of the diff, a find match) remembers where the view was.
const NAV = { back: [], fwd: [], armed: false };
function navUpdate() {
  $('#navback').disabled = !NAV.back.length;
  $('#navfwd').disabled = !NAV.fwd.length;
}
function navPush() {
  NAV.back.push(viewAnchor());
  if (NAV.back.length > 100) NAV.back.shift();
  NAV.fwd = [];
  NAV.armed = true;
  navUpdate();
}
function navGo(from, to) {
  if (!from.length) return;
  to.push(viewAnchor());
  restoreAnchor(from.pop());
  NAV.armed = from.length > 0;
  navUpdate();
}
const navBack = () => navGo(NAV.back, NAV.fwd);
const navForward = () => navGo(NAV.fwd, NAV.back);
$('#navback').onclick = navBack;
$('#navfwd').onclick = navForward;
function jumpTo(target, what) {
  if (!target) { toast(`${what}: not found in this paper`, 'error'); return false; }
  // a hidden \label: the nearest shown element before it, or its block
  let t = target;
  while (t && !(t.getClientRects().length && t.offsetParent !== null)) t = t.previousElementSibling || t.parentElement;
  t = t || target.closest('.seg');
  if (anchorHold) anchorHold();   // a place held after a reload would pull the page back
  navPush();
  t.scrollIntoView({ block: 'center' });
  const box = t.closest('.seg') || t;
  box.classList.add('boxflash');
  setTimeout(() => box.classList.remove('boxflash'), 1200);
  toast(`${what} · Alt+← goes back`);
  return true;
}
// ------------------------------------------------------------ menus
// Popovers: the main menu (☰), reading options (▾), headings, and the tools
// that do not fit in the toolbar (⋯).  A button with data-pop opens one; a
// click elsewhere, Escape or an action in it closes it (data-stay: toggles
// that stay open, such as the theme).
// The popovers sit at the top of #chrome, above both bars (inside a bar,
// the bar after it painted over them and took their clicks).
for (const p of document.querySelectorAll('#chrome .popover')) $('#chrome').append(p);
const popOpener = (p) => document.querySelector(`[data-pop="${p.id}"]`);
const popParent = (p) => { const b = popOpener(p); return b ? b.closest('.popover') : null; };
function closePopovers(keep = null) {
  const kept = new Set();
  for (let p = keep; p; p = popParent(p)) kept.add(p);
  for (const p of document.querySelectorAll('.popover:not([hidden])')) {
    if (kept.has(p)) continue;
    p.hidden = true;
    const b = popOpener(p);
    if (b) b.setAttribute('aria-expanded', 'false');
  }
}
function openPopover(p) {
  if (!p.children.length) return;
  closePopovers(p);
  p.hidden = false;
  const b = popOpener(p);
  if (b) b.setAttribute('aria-expanded', 'true');
  // fixed, under its button
  if (b && b.getClientRects().length) {
    const r = b.getBoundingClientRect(), w = p.offsetWidth;
    p.style.top = Math.round(r.bottom + 4) + 'px';
    p.style.left = Math.round(Math.max(8, Math.min(r.left, innerWidth - w - 8))) + 'px';
  }
}
addEventListener('resize', () => closePopovers());
// open the menus a control is in (shortcuts, tests); true if it is shown
function revealControl(e) {
  const chain = [];
  for (let p = e && e.closest('.popover'); p; p = popParent(p)) chain.unshift(p);
  for (const p of chain) openPopover(p);
  return !!e && !!e.getClientRects().length;
}
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-pop]');
  if (opener) {
    const p = document.getElementById(opener.dataset.pop);
    if (p.hidden) openPopover(p); else closePopovers(popParent(p));
    return;
  }
  const inside = e.target.closest('.popover');
  if (!inside) { closePopovers(); return; }
  const b = e.target.closest('button');
  if (b && !b.hasAttribute('data-stay') && !b.closest('.textsize')) setTimeout(() => closePopovers(), 0);
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.popover:not([hidden])')) { closePopovers(); e.stopPropagation(); }
}, true);

// Button labels in their own span, so narrow windows show only the icons
// (the title keeps the name and the shortcut).
for (const b of document.querySelectorAll('#chrome button')) {
  for (const n of [...b.childNodes]) {
    if (n.nodeType === 3 && n.data.trim()) { const l = el('span', 'lbl', n.data.trim()); n.replaceWith(l); }
  }
  if (b.querySelector('.label')) b.querySelector('.label').classList.add('lbl');
}

// The editing toolbar keeps one row: what does not fit goes, from the
// right, into the ⋯ menu.
const TOOLMORE = { busy: false };
function fitToolbar() {
  if (TOOLMORE.busy) return;
  TOOLMORE.busy = true;
  const bar = $('#toolbar'), more = $('#toolmore'), group = $('#moregroup');
  for (const n of [...more.children]) bar.insertBefore(n, group);
  $('#toolmorebtn').hidden = true;
  if (bar.scrollWidth > bar.clientWidth + 1) {
    $('#toolmorebtn').hidden = false;
    let guard = 60;
    while (bar.scrollWidth > bar.clientWidth + 1 && guard--) {
      const last = group.previousElementSibling;
      if (!last) break;
      more.prepend(last);
    }
    // a separator at either end of the menu or the bar means nothing
    while (more.firstElementChild && more.firstElementChild.classList.contains('sep')) bar.insertBefore(more.firstElementChild, group);
  }
  TOOLMORE.busy = false;
}
new ResizeObserver(() => requestAnimationFrame(fitToolbar)).observe($('#toolbar'));
// a control shown or hidden (the diff's navigation): fit again
new MutationObserver((recs) => { if (recs.some((r) => r.target.id !== 'toolmorebtn')) requestAnimationFrame(fitToolbar); })
  .observe($('#toolbar'), { attributes: true, attributeFilter: ['hidden'], subtree: true });

function followRef(c) {
  const src = c.dataset.src || '';
  const keys = (/\{([^{}]*)\}\s*$/.exec(src) || [])[1];
  if (!keys) return;
  const key = keys.split(',')[0].trim();
  if (c.classList.contains('cite')) {
    jumpTo(document.querySelector(`#doc .refs li[data-key="${CSS.escape(key)}"]`), 'Reference [' + (DOC.aux.cites[key] || key) + ']');
    return;
  }
  const needle = '\\label{' + key + '}';
  const seg = ORDER.find((s) => !s.removed && s.el && s.el.isConnected && (s.src || '').includes(needle));
  let target = null;
  if (seg) target = [...seg.el.querySelectorAll('[data-src]')].find((n) => n.dataset.src.includes(needle)) || seg.el;
  jumpTo(target, refText('cref', key));
}
// (in the text, only right after a jump: Alt+Left moves by words there on a Mac)
document.addEventListener('keydown', (e) => {
  const way = e.key === 'ArrowLeft' ? NAV.back : e.key === 'ArrowRight' ? NAV.fwd : null;
  if (e.altKey && !e.ctrlKey && !e.metaKey && way && way.length &&
      !e.target.closest('input, textarea') && (NAV.armed || !e.target.closest('[contenteditable=true]'))) {
    e.preventDefault(); e.stopPropagation();
    if (way === NAV.back) navBack(); else navForward();
    NAV.armed = true;
  } else if (e.key !== 'Alt') NAV.armed = false;
}, true);
addEventListener('mouseup', (e) => { if (e.button === 3) navBack(); else if (e.button === 4) navForward(); });
doc.addEventListener('click', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const r = outerChip(e.target);
    if (r && (r.classList.contains('ref') || r.classList.contains('cite'))) { e.preventDefault(); followRef(r); return; }
  }
  const c = outerChip(e.target);
  if (!c || c.classList.contains('nl') || c.classList.contains('tie') || c.classList.contains('parbreak')) return;
  if (c.closest('.refs')) return;
  // a preview of a figure or table (shown after Apply, until the next build)
  // is read only: it is edited in the figure window (double-click)
  if (c.closest('.game-preview, .tabular-preview')) { e.preventDefault(); toast('This is a preview: double-click the figure to edit it'); return; }
  e.preventDefault();
  openDrawer(c, null, c.classList.contains('math') ? 'Edit maths' : 'Edit LaTeX');
});

doc.addEventListener('input', () => { lastTyping = Date.now(); markEditedSoon(); });
// The same in the figure window (game lines, cells, titles): most game lines
// are one formula, editable only this way.
$('#fv-body').addEventListener('click', (e) => {
  const c = outerChip(e.target);
  if (!c || !c.closest('[contenteditable=true]') || c.classList.contains('nl') || c.classList.contains('tie')) return;
  e.preventDefault();
  openDrawer(c, null, c.classList.contains('math') ? 'Edit maths' : 'Edit LaTeX');
});
let markTimer = null;
function markEditedSoon() { clearTimeout(markTimer); markTimer = setTimeout(markEdited, 400); }

/* key handling: see the keymap section below */

// Copy, cut and paste.  A copy from the page carries its LaTeX (in a type of
// its own) and a plain text in which formulas are $...$, so that pasting it
// back, here or from anywhere else, gives formulas again.
const LATEX_MIME = 'application/x-paper-editor-latex';
// Zero-width spaces, joiners, word joiners and byte-order marks come along
// with text copied from web pages; they print nothing, and pdfLaTeX stops at
// them ("Unicode character U+200B").  Pastes drop them everywhere.
const PASTE_INVISIBLE_RE = /[\u200b-\u200d\u2060-\u2064\ufeff]/g;
// Pastes into the text boxes (source view, drawer, figure LaTeX) too, as
// the browser's own paste would keep them; insertText keeps native undo.
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (!t || !/^(TEXTAREA|INPUT)$/.test(t.tagName) || t.readOnly) return;
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  if (!text || !PASTE_INVISIBLE_RE.test(text)) return;
  PASTE_INVISIBLE_RE.lastIndex = 0;
  e.preventDefault();
  document.execCommand('insertText', false, text.replace(PASTE_INVISIBLE_RE, ''));
}, true);

// Plain text: formulas between dollars ($...$, $$...$$, \(...\), \[...\])
// become formulas, and so do control words with their arguments and ties
// (\ref{...}, \textbf{…}, ~), as when the LaTeX is copied inside the app;
// everything else is text.  A $ is a dollar sign unless it opens and closes
// a formula: no space just inside, no digit right after the closing one
// (so "5$ or 10$" stays text); \$ is a dollar sign.
function pastedNodes(text) {
  const nodes = [];
  let buf = '';
  const flush = () => { if (buf) nodes.push(document.createTextNode(buf)); buf = ''; };
  const math = (src, display) => { flush(); nodes.push(mathChip(src, display)); };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('\\$', i)) { buf += '$'; i += 2; continue; }
    let close;
    if (text.startsWith('$$', i) && (close = text.indexOf('$$', i + 2)) > i + 2) {
      math(text.slice(i, close + 2), true); i = close + 2; continue;
    }
    if (text.startsWith('\\[', i) && (close = text.indexOf('\\]', i + 2)) > i + 2) {
      math(text.slice(i, close + 2), true); i = close + 2; continue;
    }
    if (text.startsWith('\\(', i) && (close = text.indexOf('\\)', i + 2)) > i + 2) {
      math(text.slice(i, close + 2), false); i = close + 2; continue;
    }
    if (text[i] === '$' && text[i + 1] !== '$' && text[i + 1] && !/\s/.test(text[i + 1])) {
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '\\') { j++; continue; }
        if (text[j] === '$') break;
      }
      if (j < text.length && !/\s/.test(text[j - 1]) && !/[0-9]/.test(text[j + 1] || '')) {
        math(text.slice(i, j + 1), false); i = j + 1; continue;
      }
    }
    // a control word with the groups attached to it (\ref{sec:intro},
    // \textbf{…}): the chip it renders as, as when copied inside the app
    if (text[i] === '\\' && /[A-Za-z@]/.test(text[i + 1] || '')) {
      const t0 = L.tokenize(text.slice(i))[0];
      if (t0) {
        flush();
        const frag = document.createDocumentFragment();
        renderTokens([t0], frag, {});
        for (const n of [...frag.childNodes]) nodes.push(n);
        i += L.serializeTokens([t0]).length;
        continue;
      }
    }
    if (text[i] === '~') { flush(); nodes.push(chip('tie', '~', '\u00a0')); i++; continue; }
    buf += text[i++];
  }
  flush();
  return nodes;
}

doc.addEventListener('paste', (e) => {
  if (/^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;
  e.preventDefault();
  if (!editableAt(selRange())) return;
  if (spansEditables()) { banner(ACROSS); return; }
  const latex = e.clipboardData.getData(LATEX_MIME).replace(PASTE_INVISIBLE_RE, '');
  let nodes;
  if (latex) {
    const frag = document.createDocumentFragment();
    renderTokens(L.tokenize(latex.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n')), frag, {});
    nodes = [...frag.childNodes];
  } else {
    const text = e.clipboardData.getData('text/plain').replace(PASTE_INVISIBLE_RE, '').replace(/\r\n?/g, '\n').replace(/\s*\n\s*/g, ' ');
    nodes = pastedNodes(text);
  }
  if (!nodes.length) return;
  insertNodes(nodes);
  lastTyping = Date.now();
});

// The plain text of a piece of the page, with formulas as their LaTeX.
function plainOf(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { out += n.data; continue; }
    if (n.nodeType !== 1 || n.classList.contains('hidden') || n.classList.contains('tools')) continue;
    if (n.classList.contains('math')) { out += n.dataset.src; continue; }
    if (n.classList.contains('nl') || n.classList.contains('parbreak')) { out += n.classList.contains('parbreak') ? '\n\n' : ' '; continue; }
    if (n.classList.contains('chip')) { out += n.textContent; continue; }
    if (/^(DIV|P|H[1-6])$/.test(n.tagName) && out && !out.endsWith('\n')) out += '\n\n';
    out += plainOf(n);
  }
  return out;
}

function copySelection(e, cut) {
  if (/^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;
  const r = selectionInOneEditable();
  if (!r) {              // across blocks: the text of each block, and the cut takes them
    const across = acrossParts();
    if (!across) { if (cut && spansEditables()) { e.preventDefault(); banner(ACROSS); } return; }
    KEEP_UNICODE = ''; KEEP_MATH_UNICODE = '';
    e.clipboardData.setData('text/plain', across.plain);
    e.clipboardData.setData(LATEX_MIME, across.latex);
    e.preventDefault();
    if (cut) deleteAcross();
    return;
  }
  const frag = r.cloneContents();
  KEEP_UNICODE = ''; KEEP_MATH_UNICODE = '';
  e.clipboardData.setData('text/plain', plainOf(frag));
  e.clipboardData.setData(LATEX_MIME, ser(frag));
  e.preventDefault();
  if (cut) {
    snapshot();
    deleteKeepingEnvs(r);
    markEditedSoon();
  }
}
doc.addEventListener('copy', (e) => copySelection(e, false));
doc.addEventListener('cut', (e) => copySelection(e, true));

function segOf(node) {
  const box = node.closest && node.closest('.seg');
  return box ? box.seg : null;
}

// ------------------------------------------------- selecting across blocks
//
// Every block is its own editable text, and a browser keeps a drag, a
// Shift+click or Shift+arrow inside the one it started in.  Here they go on
// into the next blocks; such a selection can be copied, cut, deleted or typed
// over (the blocks between go, the first and the last are joined).
const hostOf = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return e && e.closest('#doc [contenteditable=true]'); };
function pointAt(x, y) {
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); return p && { node: p.offsetNode, offset: p.offset }; }
  const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
  return r && { node: r.startContainer, offset: r.startOffset };
}
const DRAG = { anchor: null, crossed: false };
doc.addEventListener('mousedown', (e) => {
  DRAG.anchor = null; DRAG.crossed = false;
  if (e.button !== 0 || e.detail > 1) return;
  const sel = getSelection();
  const at = pointAt(e.clientX, e.clientY);
  if (!at || !hostOf(at.node) || (at.node.parentElement && at.node.parentElement.closest('.chip'))) return;
  if (e.shiftKey && sel.rangeCount && hostOf(sel.anchorNode) && hostOf(sel.anchorNode) !== hostOf(at.node)) {
    // Shift+click in another block: from where the selection starts to here
    e.preventDefault();
    sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, at.node, at.offset);
    return;
  }
  if (!e.shiftKey) DRAG.anchor = at;
});
addEventListener('mousemove', (e) => {
  if (!DRAG.anchor || !(e.buttons & 1)) return;
  const at = pointAt(e.clientX, e.clientY);
  if (!at || !hostOf(at.node)) return;
  if (!DRAG.crossed && hostOf(at.node) === hostOf(DRAG.anchor.node)) return;
  DRAG.crossed = true;
  // after the browser's own handling of the move, which would clip it
  const a = DRAG.anchor;
  requestAnimationFrame(() => { if (DRAG.anchor === a) try { getSelection().setBaseAndExtent(a.node, a.offset, at.node, at.offset); } catch (err) { /* gone */ } });
});
addEventListener('mouseup', () => { setTimeout(() => { DRAG.anchor = null; }, 0); });
// Shift+arrows at the edge of a block go on into the next (or previous) one
doc.addEventListener('keydown', (e) => {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !/^Arrow(Up|Down|Left|Right)$/.test(e.key)) return;
  const sel = getSelection();
  if (!sel.rangeCount || !hostOf(sel.focusNode)) return;
  const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
  const fn = sel.focusNode, fo = sel.focusOffset;
  sel.modify('extend', fwd ? 'forward' : 'backward', /Up|Down/.test(e.key) ? 'line' : 'character');
  e.preventDefault();
  if (sel.focusNode !== fn || sel.focusOffset !== fo) return;
  const hosts = [...doc.querySelectorAll('[contenteditable=true]')].filter((h) => h.getClientRects().length);
  const next = hosts[hosts.indexOf(hostOf(fn)) + (fwd ? 1 : -1)];
  if (!next) return;
  const r = document.createRange(); r.selectNodeContents(next); r.collapse(!fwd);
  sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, r.startContainer, r.startOffset);
}, true);

// The blocks of a selection across blocks, in order: the first and the last
// with the selected part, null if it is not one that can be edited (blocks
// of one file: paragraphs, quotes and the blocks between them).
function acrossParts() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const ha = hostOf(r.startContainer), hb = hostOf(r.endContainer);
  if (!ha || !hb || ha === hb) return null;
  const sa = segOf(ha), sb = segOf(hb);
  if (!sa || !sb || sa.file !== sb.file || sa.edit !== ha || sb.edit !== hb) return null;
  const segs = FILES[sa.file].segs;
  const i = segs.indexOf(sa), j = segs.indexOf(sb);
  if (i < 0 || j <= i) return null;
  const middle = segs.slice(i + 1, j).filter((x) => !x.removed);
  const head = document.createRange(); head.setStart(r.startContainer, r.startOffset); head.setEnd(ha, ha.childNodes.length);
  const tail = document.createRange(); tail.setStart(hb, 0); tail.setEnd(r.endContainer, r.endOffset);
  snapOutOfChips(head); snapOutOfChips(tail);
  KEEP_UNICODE = ''; KEEP_MATH_UNICODE = '';
  const parts = [head.cloneContents(), ...middle.filter((x) => x.kind !== 'gap').map((x) => x), tail.cloneContents()];
  const latex = parts.map((p) => p.nodeType === 11 ? ser(p).trim() : segSource(p, []).trim()).filter(Boolean).join('\n\n');
  const plain = parts.map((p) => p.nodeType === 11 ? plainOf(p).trim() : (p.edit && p.edit.tagName !== 'TEXTAREA' ? plainOf(p.edit).trim() : '')).filter(Boolean).join('\n\n');
  const editable = (x) => x.kind === 'para' || x.kind === 'quote';
  return { sa, sb, middle, head, tail, latex, plain, ok: editable(sa) && editable(sb) && !middle.some((x) => x.kind === 'input' || x.kind === 'hidden') };
}
// Delete a selection across blocks; the caret ends where it started.
function deleteAcross() {
  const p = acrossParts();
  if (!p || !p.ok) { banner('Only text between paragraphs of one file can be deleted at once.'); return false; }
  snapshot();
  // blocks that show nothing (\maketitle, \keywords{...}) were not seen, so
  // they stay, and then the first and the last block are not joined
  const quiet = (x) => x.edit && x.edit.classList && x.edit.classList.contains('quiet');
  const gone = p.middle.filter((x) => !quiet(x) && x.kind !== 'gap');
  const keep = unpairedEnvChips([...envChipsIn(p.head), ...gone.flatMap((x) => x.edit ? [...x.edit.querySelectorAll('.chip')] : []), ...envChipsIn(p.tail)]);
  const keepSet = new Set(keep);
  deleteKeeping(p.head, keepSet);
  deleteKeeping(p.tail, keepSet);
  const caretAt = p.sa.edit.childNodes.length;
  for (const x of gone) for (const c of x.edit ? x.edit.querySelectorAll('.chip') : []) if (keepSet.has(c)) p.sa.edit.append(c);
  const blank = (e) => !e.textContent.trim() && !e.querySelector('.chip:not(.nl):not(.parbreak)');
  let at = p.sa;
  if (!p.middle.some(quiet)) {
    for (const x of p.middle) { x.removed = true; if (x.el) x.el.remove(); }
    while (p.sb.edit.firstChild) p.sa.edit.append(p.sb.edit.firstChild);
    p.sb.removed = true;
    if (p.sb.el) p.sb.el.remove();
  } else {
    for (const x of gone) { x.removed = true; if (x.el) x.el.remove(); }
    p.sb.touched = true;
    if (blank(p.sa.edit)) {
      // the first block went whole: it goes with the blank line after it
      const gap = p.middle.find((x) => x.kind === 'gap');
      for (const x of gap ? [p.sa, gap] : [p.sa]) { x.removed = true; if (x.el) x.el.remove(); }
      at = p.sb;
    }
  }
  at.touched = true;
  const r = document.createRange();
  r.setStart(at.edit, at === p.sa ? Math.min(caretAt, at.edit.childNodes.length) : 0); r.collapse(true);
  at.edit.focus({ preventScroll: true });
  keptToast(keep);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  markEdited();
  return true;
}

function caretAtStart(editable) {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const r = document.createRange();
  r.selectNodeContents(editable);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  const frag = r.cloneContents();
  return !frag.textContent.trim() && !frag.querySelector('.chip:not(.hidden)');
}

// The view of each paper (text size, width, columns, what the diff compares
// with) is kept by its main file, so a paper opens as it was left.  The last
// choice of each is also kept on its own, as the start for a paper opened for
// the first time.
const VIEW = {
  key: () => DOC && DOC.path ? 'view:' + DOC.path : null,
  read() {
    try { return (this.key() && JSON.parse(localStorage.getItem(this.key()) || 'null')) || {}; } catch (e) { return {}; }
  },
  save(field, value) {
    try {
      localStorage.setItem(field, String(value));
      const k = this.key();
      if (k) localStorage.setItem(k, JSON.stringify({ ...this.read(), [field]: value }));
    } catch (e) { /* storage unavailable */ }
  },
  // before a newly opened paper is first drawn: its own view, where it has one
  apply() {
    const v = this.read();
    if (v.docsize) setTextSize(+v.docsize, false, false);
    if (v.docwidth) setDocWidth(+v.docwidth);
    if (v.cols) setCols(v.cols === '2', false);
    if (v.diff) setDiffBase(v.diff);
  },
};
// Two columns or one.  With redraw false only the mode is set (before the
// first load, or before a newly opened paper is drawn).
function setCols(two, redraw = true) {
  redraw = redraw && !!DOC;
  if (redraw) commit();
  const caret = redraw ? captureEditorState() : null;
  const y = redraw ? viewAnchor() : null;
  document.body.classList.toggle('two', two);
  $('#cols').setAttribute('aria-pressed', String(two));
  $('#cols').title = (two ? 'Two columns: on (click for one column)' : 'One column (click for two columns)') + ' (Ctrl+Alt+W)';
  if (redraw) {
    toast(two ? 'Two columns' : 'One column');
    render();
    restoreEditorState(caret);
    restoreAnchor(y);
  }
  VIEW.save('cols', two ? '2' : '1');
}
$('#cols').onclick = () => setCols(!document.body.classList.contains('two'));
try { setCols(localStorage.getItem('cols') === '2', false); } catch (e) { /* storage unavailable */ }
$('#help').onclick = () => { $('#helpbox').hidden = false; };
// The paper's text size, apart from the interface (browser zoom changes both).
const TEXT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 27, 30];
function setTextSize(px, say = true, keep = true) {
  px = TEXT_SIZES.includes(px) ? px : 16;
  const y = DOC && keep ? viewAnchor() : null;
  document.documentElement.style.setProperty('--doc-size', px + 'px');
  $('#textsize').textContent = Math.round(px / 16 * 100) + '%';
  $('#textsmaller').disabled = px === TEXT_SIZES[0];
  $('#textbigger').disabled = px === TEXT_SIZES[TEXT_SIZES.length - 1];
  if (y) restoreAnchor(y);
  if (say) toast('Text size ' + $('#textsize').textContent);
  VIEW.save('docsize', px);
}
const textSizeNow = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--doc-size')) || 16;
$('#textsmaller').onclick = () => setTextSize(TEXT_SIZES[Math.max(0, TEXT_SIZES.indexOf(textSizeNow()) - 1)]);
$('#textbigger').onclick = () => setTextSize(TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, TEXT_SIZES.indexOf(textSizeNow()) + 1)]);
$('#textsize').onclick = () => setTextSize(16);
try { setTextSize(+localStorage.getItem('docsize') || 16, false); } catch (e) { setTextSize(16, false); }

$('#save').onclick = () => save();
$('#pdfbtn').onclick = async () => {
  const r = await fetch('/pdf', { method: 'HEAD' }).catch(() => null);
  if (r && r.status === 404) { toast('No PDF yet: save to build it', 'error'); return; }
  window.open('/pdf?' + Date.now(), '_blank');
  toast('Opened the PDF');
};
async function requestBuild(clean) {
  const r = await fetch('/api/build', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify({ clean }) }).catch(() => null);
  if (!r || !r.ok) { toast('Could not start the build', 'error'); return; }
  setBuild({ state: 'running', message: clean ? 'clean build queued' : 'build queued' });
  toast(clean ? 'Clean build started' : 'Build started');
}
$('#rebuildbtn').onclick = () => requestBuild(false);
$('#cleanbtn').onclick = () => requestBuild(true);
$('#reloadbtn').onclick = async () => {
  const edited = editedFiles();
  const discard = edited.length && confirm(`Reload from disk and drop your unsaved edits in ${edited.join(', ')}?\n(Cancel reloads the other files and keeps your edits.)`) ? edited : [];
  toast('Reloading…');
  await load(true, discard);
  toast(discard.length || !edited.length ? 'Reloaded from disk' : 'Reloaded; your unsaved edits were kept', 'ok');
};
$('#helpclose').onclick = () => { $('#helpbox').hidden = true; };

// ----------------------------------------------------------------- save

// One save at a time: a save asked for while one runs happens after it (two
// saves sent together would carry the same base hash, and the second would
// be refused as a conflict with the first).  The poller stays away while
// SAVING, so that it never mistakes our own write for an outside change.
// ---- new code: the page reloads itself, and comes back where it was
//
// The status the page polls carries the version of the editor's code. When
// it changes (app.js, the styles, the server), the page waits for a pause
// (nothing typed or clicked for a moment, no dialog, no save, not reading
// aloud), keeps where it is in sessionStorage — the view, the cursor, the
// source view, the find bar, the diff — and its unsaved edits (the draft),
// reloads, and puts all of that back.
const RESUME = {
  code: null, pending: false, reloading: false, state: null, lastInput: 0,
  read() {
    try {
      const s = JSON.parse(sessionStorage.getItem('pe-resume') || 'null');
      sessionStorage.removeItem('pe-resume');
      this.state = s && Date.now() - s.t < 120000 && s.paper === (DOC.path || DOC.main) ? s : null;
    } catch (e) { this.state = null; }
  },
  apply() {
    const s = this.state;
    if (!s) return;
    this.state = null;
    requestAnimationFrame(async () => {
      if (s.view) restoreAnchor(s.view);
      if (s.caret) restoreEditorState(s.caret);
      if (s.find) {
        openFind(!!s.find.r);
        $('#find-q').value = s.find.q; $('#find-r').value = s.find.r;
        $('#find-re').checked = s.find.re; $('#find-case').checked = s.find.c; $('#find-word').checked = s.find.w;
        $('#find-q').dispatchEvent(new Event('input'));
      }
      if (s.diff) { $('#diffbase').value = DIFF.want = s.diff; if (!DIFF.on) ACTIONS.diff(); }
      if (s.src) {
        await toggleSource(true);
        await openSourceFile(s.src.name);
        const ta = $('#srcta');
        ta.setSelectionRange(s.src.a, s.src.b);
        ta.scrollTop = s.src.top;
        ta.dispatchEvent(new Event('scroll'));
      }
      toast('Updated to the new version of the editor', 'ok');
    });
  },
};
for (const ev of ['keydown', 'pointerdown', 'wheel', 'compositionstart']) addEventListener(ev, () => { RESUME.lastInput = Date.now(); }, { capture: true, passive: true });
function codeVersion(code) {
  if (RESUME.code === null) { RESUME.code = code; return; }
  if (code === RESUME.code || RESUME.pending) return;
  RESUME.pending = true;
  reloadWhenQuiet();
}
function reloadWhenQuiet() {
  const busy = Date.now() - RESUME.lastInput < 2500 || SAVING || topDialog() || !$('#drawer').hidden || !$('#palette').hidden ||
    (typeof TTS !== 'undefined' && TTS.speaking());
  if (busy) { setTimeout(reloadWhenQuiet, 1000); return; }
  try {
    flushSource();
    commit();
    writeDraft();
    // the draft is the edits; this is where the page was
    const ta = SRC.on && $('#srcta');
    sessionStorage.setItem('pe-resume', JSON.stringify({
      t: Date.now(), paper: DOC.path || DOC.main,
      view: viewAnchor(), caret: captureEditorState(),
      src: SRC.on ? { name: SRC.name, a: ta.selectionStart, b: ta.selectionEnd, top: ta.scrollTop } : null,
      find: $('#findbar').hidden ? null : { q: $('#find-q').value, r: $('#find-r').value, re: $('#find-re').checked, c: $('#find-case').checked, w: $('#find-word').checked },
      diff: DIFF.on ? $('#diffbase').value : null,
    }));
  } catch (e) { /* storage off: reload anyway, the draft offer still stands */ }
  RESUME.reloading = true;
  location.reload();
}

// ---- drafts: unsaved edits survive a crash or a closed tab
//
// Every few seconds (and when the page is hidden or closed) the texts of the
// edited files, with the version on disk each started from, are kept in the
// browser under the paper's path; a save clears them.  When the paper opens
// with a draft left over, the page offers it back.  A file that changed on
// disk since is restored against the version it started from, so that saving
// it asks (Reload / Overwrite / Backup) instead of overwriting the other one.
const DRAFT = { key: () => DOC && 'draft:' + (DOC.path || DOC.main), last: '' };
function writeDraft() {
  if (!DOC) return;
  let files, extra;
  try {
    files = editedFiles();
    extra = typeof SRC !== 'undefined' && SRC ? extraEdited() : [];
  } catch (e) { return; }
  try {
    if (!files.length && !extra.length) { if (DRAFT.last) localStorage.removeItem(DRAFT.key()); DRAFT.last = ''; return; }
    const d = { t: Date.now(), files: {}, extra: {} };
    for (const n of files) d.files[n] = { text: FILES[n].text, base: FILES[n].base };
    for (const n of extra) d.extra[n] = { text: SRC.extra[n].text, base: SRC.extra[n].base };
    const s = JSON.stringify(d);
    if (s.slice(s.indexOf(',')) === DRAFT.last) return;   // unchanged since the last one (time aside)
    localStorage.setItem(DRAFT.key(), s);
    DRAFT.last = s.slice(s.indexOf(','));
  } catch (e) { /* storage full or off: the warning on leaving still stands */ }
}
setInterval(writeDraft, 3000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeDraft(); });
addEventListener('pagehide', writeDraft);

function checkDraft() {
  // the draft left by the last session moves aside (…:kept) while it is on
  // offer, so that drafts of this session never write over it
  const key = DRAFT.key(), kept = key + ':kept';
  let d = null;
  try {
    const left = localStorage.getItem(key);
    if (left) { localStorage.setItem(kept, left); localStorage.removeItem(key); }
    d = JSON.parse(localStorage.getItem(kept) || 'null');
  } catch (e) { d = null; }
  DRAFT.last = '';
  if (!d || !d.files) return;
  const files = Object.keys(d.files).filter((n) => !FILES[n] || FILES[n].text !== d.files[n].text);
  const extra = Object.keys(d.extra || {});
  if (!files.length && !extra.length) { try { localStorage.removeItem(kept); } catch (e) { /* none */ } return; }
  const ago = Math.round((Date.now() - d.t) / 60000);
  const when = ago < 1 ? 'less than a minute ago' : ago < 120 ? `${ago} min ago` : new Date(d.t).toLocaleString();
  const changed = files.filter((n) => FILES[n] && d.files[n].base && FILES[n].base !== d.files[n].base);
  // the page reloaded itself for new code a moment ago: its edits come back
  // without asking (unless a file changed on disk meanwhile)
  if (RESUME.state && !changed.length) {
    restoreDraft(d, files, extra, true);
    try { localStorage.removeItem(kept); } catch (e) { /* none */ }
    return;
  }
  const n = files.length + extra.length;
  banner(`Unsaved edits from ${when} were kept (${n} file${n === 1 ? '' : 's'}: ${[...files, ...extra].join(', ')})` +
    (changed.length ? `; ${changed.join(', ')} changed on disk since, so saving will ask first.` : '.'), [
    ['Restore', () => { restoreDraft(d, files, extra); try { localStorage.removeItem(kept); } catch (e) { /* none */ } }, 'Put these edits back as unsaved edits (Undo takes them out)'],
    ['Discard', () => { try { localStorage.removeItem(kept); } catch (e) { /* none */ } $('#banner').hidden = true; toast('Kept edits discarded'); }, 'Forget these edits'],
  ]);
}
async function restoreDraft(d, files, extra, quiet = false) {
  snapshot();
  for (const n of files) {
    const f = d.files[n];
    if (!FILES[n]) newFile(n, f.text);
    else { FILES[n].text = f.text; if (f.base) FILES[n].base = f.base; }
  }
  for (const n of extra) {
    const f = d.extra[n];
    const r = await fetch('/api/srcfile?name=' + encodeURIComponent(n)).catch(() => null);
    const cur = r && r.ok ? await r.json() : null;
    SRC.extra[n] = { text: f.text, disk: cur ? cur.text : null, base: f.base };
  }
  $('#banner').hidden = true;
  const y = viewAnchor();
  render();
  restoreAnchor(y);
  markEdited();
  writeDraft();
  if (!quiet) toast('Unsaved edits restored: save to keep them', 'ok');
}

let SAVING = false, SAVE_AGAIN = false;
async function save() {
  // the diff view is drawn again after the save, with the caret where it was
  const caret = DIFF_SHOWN && diffEditSeg() ? captureEditorState() : null;
  if (DIFF_SHOWN) { const y = viewAnchor(); render(); restoreAnchor(y); }
  flushSource();
  if (SAVING) { SAVE_AGAIN = true; return; }
  SAVING = true;
  try {
    do { SAVE_AGAIN = false; await saveOnce(); } while (SAVE_AGAIN);
    writeDraft();   // what was saved is no longer a draft
  } catch (e) {
    banner('Saving failed: ' + e.message + '. Your edits are still here.');
  } finally {
    SAVING = false;
    if (DIFF.on && !DIFF_SHOWN) diffAgain(caret);
  }
}

async function saveOnce() {
  settleNewFileNames();
  commit(false);
  const rawTexts = Object.fromEntries(Object.entries(FILES).map(([name, f]) => [name, f.text]));
  let warnings = commit(true);
  let apply = true;
  if (HOUSE_RULE_CHANGES.length) {
    const kinds = [...new Set(HOUSE_RULE_CHANGES.map((seg) => seg.kind))].join(', ');
    apply = confirm(`House rules will adjust ${HOUSE_RULE_CHANGES.length} edited ${kinds} block${HOUSE_RULE_CHANGES.length === 1 ? '' : 's'} (${[...new Set(warnings)].join('; ') || 'ties, dashes, quotes, spacing'}${(DOC.config || {}).house_rules?.one_sentence_per_line ? ', one sentence per line' : ''}). Apply them before saving?`);
    if (!apply) {
      for (const [name, text] of Object.entries(rawTexts)) FILES[name].text = text;
      warnings = [];
    }
  }
  // a new file nothing reads (its section was put back, or undone) is not written
  const reach = reachableFiles();
  const files = Object.keys(FILES).filter((n) => FILES[n].text !== FILES[n].disk && (!isNewFile(n) || reach.has(n)));
  if (!files.length && extraEdited().length) {
    const n = await saveExtra(Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    if (n) toast(`Saved ${n} file${n > 1 ? 's' : ''}`, 'ok');
    markEdited();
    return;
  }
  if (!files.length) { setBuild({ state: 'idle', message: 'nothing to save' }); toast('Nothing to save'); return; }
  const conflicts = [];
  let saved = 0;
  const batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);   // one entry of the history
  for (const name of files) {
    const text = FILES[name].text;
    const r = await fetch('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
      body: JSON.stringify({ name, base: FILES[name].base, text, batch, create: FILES[name].base === null }),
    });
    const res = await r.json().catch(() => ({}));
    if (r.status === 409) { conflicts.push([name, res.hash]); continue; }
    if (r.status === 403) { banner(`Saving ${name} failed: the editor was restarted and no longer accepts this page. Your edits are still here: copy them out, then reload the page.`); continue; }
    if (!r.ok) { banner(`Saving ${name} failed: ${res.error || r.status}. Your edits are still here.`); continue; }
    if (FILES[name].base === null && DOC.disk_files && !DOC.disk_files.includes(name)) DOC.disk_files.push(name);
    FILES[name].disk = text;
    FILES[name].base = res.hash;
    saved++;
  }
  saved += await saveExtra(batch);
  if (!conflicts.length) await trashMerged(batch);
  // the blocks take the source just saved (with or without the house rules,
  // as chosen), so that the page and the file agree; typing that happened
  // while the save was on its way stays an edit
  if (document.querySelector('#doc .chip.parbreak, #doc .chip.src[data-src^="\\\\section"], #doc .chip.src[data-src^="\\\\subsection"], #doc .chip.src[data-src^="\\\\paragraph"], #doc .chip.src[data-src^="\\\\input"]')) {
    // new structure (a paragraph break, a heading) is shown as a chip until
    // it is parsed again
    commit(apply);
    const y = viewAnchor();
    const caret = captureEditorState();
    render();
    restoreEditorState(caret);
    restoreAnchor(y);
  } else {
    for (const seg of ORDER) if (seg.touched) { seg.src = segSource(seg, [], null, apply); seg.touched = false; }
    markEdited();
  }
  // a failure shown before is over once a save goes through
  if (saved && !conflicts.length && /^Sav(ing|e) .*failed/.test($('#banner').textContent)) { $('#banner').hidden = true; clearTimeout(banner.t); }
  if (saved) { setBuild({ state: 'running', message: 'saved; rebuilding PDF' }); toast(`Saved ${saved} file${saved > 1 ? 's' : ''}; rebuilding the PDF`, 'ok'); }
  if (conflicts.length) toast(`${conflicts.length} file${conflicts.length > 1 ? 's' : ''} not saved: changed on disk`, 'error');
  if (warnings.length && saved) houseBanner('Saved. ', warnings);
  if (conflicts.length) showExternal(conflicts, true);
  // a new \input names a file the page has not read yet
  if (saved && Object.values(FILES).some((f) => (f.segs || []).some((s) => s.kind === 'input' && !s.removed && !s.input))) {
    await load(true);
  }
}

// ---- one way to close: a × in the corner of every bar, panel and dialog
//
// The text "Close" buttons become a ×, labelled for screen readers; panels
// that only closed with Esc or another button get one too.  Esc still closes
// whatever is on top.
function xButton(label, fn, title = 'Close (Esc)') {
  const b = el('button', 'xclose');
  b.type = 'button';
  b.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg>';
  b.setAttribute('aria-label', label);
  b.title = title;
  if (fn) b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}
function asX(id, label) {
  const b = document.getElementById(id);
  if (!b) return;
  b.classList.add('xclose');
  b.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg>';
  b.setAttribute('aria-label', label);
  b.title = 'Close (Esc)';
}
for (const [id, label] of [['find-close', 'Close find and replace'], ['md-close', 'Close Paper'], ['files-close', 'Close Files'],
  ['history-close', 'Close History'], ['keys-close', 'Close Keys'], ['fv-close', 'Close the figure viewer'], ['helpclose', 'Close Help']]) asX(id, label);
{
  // the find bar: its × right after its buttons, where the eye already is
  const fx = $('#find-close');
  if (fx && $('#find-all')) $('#find-all').after(fx);
  // Help: its × in the corner, not at the end of a long text
  const help = $('#helpbox'), x = $('#helpclose');
  if (help && x) { help.prepend(x); x.classList.add('corner'); }
  // the search palette (cite, ref, insert LaTeX…)
  const ph = document.querySelector('#palette .pal-head');
  if (ph) ph.append(xButton('Close the search', () => closePalette()));
  // the LaTeX drawer: × is Cancel
  const dh = document.querySelector('#drawer .drawer-head');
  if (dh) dh.append(xButton('Close the LaTeX editor without applying', () => $('#drawer-cancel').click(), 'Cancel (Esc)'));
  // files changed on disk: × is Later
  const ex = $('#external');
  if (ex) { const b = xButton('Decide later', () => $('#external-later').click(), 'Later (Esc)'); b.classList.add('corner'); ex.prepend(b); }
  const ob = $('#openbox');
  if (ob) { const b = xButton('Cancel opening', () => $('#open-cancel').click(), 'Cancel (Esc)'); b.classList.add('corner'); ob.prepend(b); }
  const nb = $('#newbox');
  if (nb) { const b = xButton('Cancel the new paper', () => $('#new-cancel').click(), 'Cancel (Esc)'); b.classList.add('corner'); nb.prepend(b); }
}

// Leaving the page (closing the tab, reloading) with unsaved edits asks first.
// this page, for the server: when the last page closes, a server that opened
// its own window stops (a reload says goodbye and comes back at once)
const CLIENT_ID = Math.random().toString(36).slice(2, 12);
addEventListener('pagehide', () => {
  try { navigator.sendBeacon('/api/bye', JSON.stringify({ token: TOKEN, c: CLIENT_ID })); } catch (e) { /* none */ }
});
window.addEventListener('beforeunload', (e) => {
  if (!DOC || RESUME.reloading) return;   // reloading for new code: the edits come back by themselves
  let edited = false;
  try { edited = editedFiles().length > 0; } catch (err) { edited = false; }
  if (edited || SAVING) { e.preventDefault(); e.returnValue = ''; }
});

// Which file is open: the version (converted/llncs/...) and the folder.
function showWhere() {
  const w = $('#where');
  if (!w || !DOC) return;
  const root = (DOC.root || '').replace(/\/+$/, '');
  const path = DOC.path || DOC.main;
  const rel = root && path.startsWith(root + '/') ? path.slice(root.length + 1) : DOC.main;
  w.textContent = (root ? root.split('/').pop() + '/' : '') + rel;
  w.title = path;
  document.title = ($('#title').textContent || 'Crypto Paper Reviewer') + ' — ' + rel;
}

// A message under the bars: it closes by itself after a while, or with its ×;
// `actions` ([label, fn, title]) add buttons, and a message with actions stays
// until it is closed.
function banner(msg, actions = []) {
  const b = $('#banner');
  b.textContent = msg;
  for (const [label, fn, title] of actions) {
    const a = el('button', 'banner-act', label);
    if (title) a.title = title;
    a.onclick = (e) => { e.stopPropagation(); fn(a); };
    b.append(' ', a);
  }
  const x = el('button', 'banner-close xclose');
  x.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg>';
  x.setAttribute('aria-label', 'Dismiss');
  x.title = 'Dismiss (Esc)';
  x.onclick = () => { b.hidden = true; clearTimeout(banner.t); };
  b.append(x);
  b.hidden = false;
  clearTimeout(banner.t);
  if (!actions.length) banner.t = setTimeout(() => { b.hidden = true; }, 12000);
}

// House-rule warnings point at their blocks: every block of the paper where
// the rule holds now, to step through; a warning can be silenced for good.
function mutedHouseWarnings() { try { return JSON.parse(localStorage.getItem('mutedHouse') || '[]'); } catch (e) { return []; } }
function houseWarningSegs(msg) {
  const rules = (DOC.config || {}).house_rules;
  return ORDER.filter((s) => s.el && !s.removed && ['para', 'quote', 'heading', 'figure', 'table'].includes(s.kind) &&
    L.houseRules(segSource(s, [], null, false), rules)[1].includes(msg));
}
function houseBanner(prefix, warnings) {
  const muted = mutedHouseWarnings();
  const list = [...new Set(warnings)].filter((w) => !muted.includes(w));
  if (!list.length) { if (prefix) toast(prefix.replace(/\.\s*$/, ''), 'ok'); return; }
  const actions = [];
  for (const w of list) {
    const segs = houseWarningSegs(w);
    if (!segs.length) continue;
    let k = -1;
    actions.push([`Show (${segs.length})`, (btn) => {
      k = (k + 1) % segs.length;
      const s = segs[k];
      if (!s.el || !s.el.isConnected) return;
      navPush();
      s.el.scrollIntoView({ block: 'center', behavior: SMOOTH() });
      s.el.classList.remove('house-flag'); void s.el.offsetWidth; s.el.classList.add('house-flag');
      btn.textContent = `Next (${k + 1} of ${segs.length})`;
    }, `Where: ${w} (${segs.length} block${segs.length === 1 ? '' : 's'}); click again for the next`]);
  }
  actions.push(['Don\'t warn again', () => {
    try { localStorage.setItem('mutedHouse', JSON.stringify([...new Set([...muted, ...list])])); } catch (e) { /* storage unavailable */ }
    $('#banner').hidden = true;
    toast('These house-rule warnings are off (Keys… → Reset brings them back)', 'ok');
  }, 'Stop showing these warnings in this browser']);
  banner(prefix + 'House rules: ' + list.join('; '), actions);
}

function setBuild(b) {
  const e = $('#build');
  e.textContent = b.message ? 'PDF: ' + b.message : '';
  e.className = b.state === 'error' ? 'error' : '';
}

// Poll for builds and for changes made outside the editor.
let AUXVER = 0;
let PENDING_EXTERNAL = null;
const IGNORED_EXTERNAL = {};

// The dialog for files that changed on disk while they have edits here:
// changed is [[name, hash on disk]].  `refused`: a save was just refused.
function showExternal(changed, refused) {
  if (PENDING_EXTERNAL) {
    for (const c of changed) if (!PENDING_EXTERNAL.some(([n]) => n === c[0])) PENDING_EXTERNAL.push(c);
  } else PENDING_EXTERNAL = changed;
  $('#external-title').textContent = refused
    ? 'Not saved: these files changed on disk since the editor read them'
    : 'Files you are editing changed outside the editor';
  $('#external-files').textContent = PENDING_EXTERNAL.map(([name]) => name).join(', ');
  $('#external').hidden = false;
}

function closeExternal() {
  const pending = PENDING_EXTERNAL || [];
  pending.forEach(([name]) => { delete IGNORED_EXTERNAL[name]; });
  PENDING_EXTERNAL = null; $('#external').hidden = true;
  return pending;
}

// Reload: take the disk version, dropping the edits made here.
async function reloadExternal() {
  if (!PENDING_EXTERNAL) return;
  const names = closeExternal().map(([name]) => name);
  await load(true, names);
}

// Overwrite: save the version made here over the one on disk.
async function overwriteExternal() {
  if (!PENDING_EXTERNAL) return;
  // a file gone from disk has no hash: the save writes it again
  for (const [name, hash] of closeExternal()) if (FILES[name]) FILES[name].base = hash || null;
  await save();
}

// Backup: keep the version made here in a new file beside it, then reload.
async function backupExternal() {
  if (!PENDING_EXTERNAL) return;
  const names = PENDING_EXTERNAL.map(([name]) => name);
  commit(false);
  const made = [];
  for (const name of names) {
    const f = FILES[name];
    if (!f) continue;
    const r = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
      body: JSON.stringify({ name, text: f.text }) });
    if (!r.ok) { banner(`Could not back up ${name}; nothing was reloaded.`); return; }
    made.push((await r.json()).backup);
  }
  closeExternal();
  await load(true, names);
  banner('Your edits were saved in ' + made.join(', ') + ', and the files were reloaded from disk.');
}

// Merge: your edits and the change on disk, where they touch different
// lines, as unsaved edits to look over and save.  Where both changed the
// same lines nothing is merged and the dialog stays.
async function mergeExternal() {
  if (!PENDING_EXTERNAL) return;
  commit(false);
  const merged = [], failed = [];
  const results = {};
  for (const [name] of PENDING_EXTERNAL) {
    const f = FILES[name];
    if (!f) continue;
    const r = await fetch('/api/merge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
      body: JSON.stringify({ name, base: f.base, text: f.text, base_text: f.disk }) }).catch(() => null);
    const res = r ? await r.json().catch(() => ({})) : { error: 'the editor is not running' };
    if (!r || !r.ok) { failed.push(`${name}: ${res.error || r.status}`); continue; }
    if (res.merged === null) {
      const at = res.conflicts.length > 1 ? 'lines ' + res.conflicts.slice(0, -1).join(', ') + ' and ' + res.conflicts[res.conflicts.length - 1] : 'line ' + res.conflicts[0];
      failed.push(`${name}: your edits and the change on disk both changed ${at} of the file on disk`);
      continue;
    }
    results[name] = res;
  }
  if (Object.keys(results).length) {
    snapshot();
    for (const [name, res] of Object.entries(results)) {
      FILES[name] = { text: res.merged, disk: res.disk, base: res.hash };
      merged.push(name);
    }
    PENDING_EXTERNAL = PENDING_EXTERNAL.filter(([n]) => !results[n]);
    for (const n of merged) delete IGNORED_EXTERNAL[n];
    if (!PENDING_EXTERNAL.length) closeExternal();
    else showExternal([], false);
    const y = viewAnchor();
    render();
    restoreAnchor(y);
    markEdited();
    writeDraft();
    toast(`Merged ${merged.join(', ')} with the version on disk: save to keep it`, 'ok');
  }
  if (failed.length) banner('Not merged. ' + failed.join('. ') + '. Choose Reload, Overwrite disk or Save backup instead.');
}

$('#external-merge').onclick = mergeExternal;
$('#external-reload').onclick = reloadExternal;
$('#external-overwrite').onclick = overwriteExternal;
$('#external-backup').onclick = backupExternal;
$('#external-later').onclick = () => {
  const pending = PENDING_EXTERNAL || [];
  PENDING_EXTERNAL = null; $('#external').hidden = true;
  for (const [name, hash] of pending) IGNORED_EXTERNAL[name] = hash;
};

// Every 2 s: the build state, a new build (new numbers), files changed on
// disk.  A changed file without edits here is reloaded at once; one with
// edits asks (once per version on disk).  Nothing happens while typing,
// while a dialog or the LaTeX drawer is open, or while saving.
let FIGVER;
async function refreshFigures() {
  const d = await (await fetch('/api/doc')).json();
  DOC.figs = d.figs || {};
  for (const seg of ORDER) {
    if ((seg.kind !== 'figure' && seg.kind !== 'table') || seg.touched || !seg.el) continue;
    const url = DOC.figs[seg.src];
    const box = seg.el.querySelector(':scope > div:first-child');
    const shown = box && box.querySelector(':scope > img, :scope > .tabular-preview, :scope > .game-preview, :scope > div.small:not(.stale-note)');
    if (!url || !shown || (shown.tagName === 'IMG' && shown.getAttribute('src') === url && !shown.classList.contains('stale'))) continue;
    const img = el('img'); img.src = url; img.alt = seg.kind === 'figure' ? 'Figure' : 'Table';
    shown.replaceWith(img);
    for (const n of box.querySelectorAll(':scope > .stale-note')) n.remove();
  }
}
async function poll() {
  try {
    const s = SAVING ? null : await (await fetch('/api/state?c=' + CLIENT_ID)).json();
    if (s && !SAVING) {
      setBuild(s.build);
      if (s.boxes) markBoxes(s.boxes);
      // not while you type, move or select in the text (a selection held for
      // a while does not hold the reload off for ever)
      const sel = getSelection();
      const selecting = sel.rangeCount && !sel.isCollapsed && $('#doc').contains(sel.anchorNode) && Date.now() - RESUME.lastInput < 30000;
      const busy = Date.now() - lastTyping < 4000 || Date.now() - RESUME.lastInput < 2500 || selecting || !$('#drawer').hidden || PENDING_EXTERNAL || !$('#figview').hidden || DIFF_SHOWN || DIFF.on;
      const changed = Object.keys(s.hashes).filter((n) => FILES[n] && s.hashes[n] !== FILES[n].base);
      if (!busy && (changed.length || s.auxver !== AUXVER)) {
        commit();
        const edited = changed.filter((n) => FILES[n].text !== FILES[n].disk);
        const quiet = changed.filter((n) => !edited.includes(n));
        const ask = edited.filter((n) => IGNORED_EXTERNAL[n] !== s.hashes[n]);
        const newBuild = s.auxver !== AUXVER;
        AUXVER = s.auxver;
        if (quiet.length || newBuild) await load(true);
        if (ask.length) showExternal(ask.map((n) => [n, s.hashes[n]]));
      }
      // the figures are cut after the PDF is built: show the new pictures
      // (an edited game, a table) when they are ready
      if (s.figver !== undefined && s.figver !== FIGVER) { FIGVER = s.figver; await refreshFigures(); refreshSnippets(); }
      if (s.code) codeVersion(s.code);
    }
  } catch (e) { /* server restarting */ }
  setTimeout(poll, 2000);
}

// -------------------------------------------------------------- speech

const TTS = (() => {
  // The queue holds the phrases of a few blocks at a time (from `end` on, the
  // blocks are not read yet): building it is cheap after an edit or a jump.
  let queue = [], idx = 0, end = 0;      // idx: the next phrase to read
  let cur = null, curRange = null;       // the phrase read (or paused on), and its live range
  let heard = '';                        // the text of the audio of `cur`
  let stale = false;                     // the page was edited since the phrases were taken
  let speaking = false, paused = false, current = null, audio = null;
  let anchor = null;
  let generation = 0;
  let speakTimer = 0, stalls = 0;        // a browser-voice utterance that never finishes is noticed, not waited for
  let keepAlive = 0;                     // Chrome stops a network voice after about 15 s unless nudged
  let fetching = false, fails = 0;       // a clip on its way; server clips that failed in a row
  const clips = new Map();               // url -> Promise<{ src, span }>: fetched audio, ahead of time
  const synth = window.speechSynthesis;
  const voiceSel = $('#voice');

  function setState(state) { $('#tts-state').textContent = state; }
  function updateControls() {
    const reading = speaking && !paused;
    $('#pause').disabled = !speaking;
    $('#stop').disabled = !speaking;
    $('#pause').setAttribute('aria-pressed', String(paused));
    $('#play').classList.toggle('reading', reading);
    $('#ttsbar').classList.toggle('active', speaking);
    $('#pause').querySelector('.label').textContent = paused ? 'Resume' : 'Pause';
    if (navigator.mediaSession) {
      try { navigator.mediaSession.playbackState = !speaking ? 'none' : paused ? 'paused' : 'playing'; } catch (e) { /* unsupported */ }
    }
  }
  function voices() { return synth ? synth.getVoices() : []; }
  // Option values are "engine|voice"; engine "browser" is speechSynthesis,
  // the others are produced by the server (/api/tts).
  let serverVoices = [];
  async function loadServerVoices() {
    try { serverVoices = await (await fetch('/api/voices')).json(); } catch (e) { serverVoices = []; }
    fillVoices();
  }
  function fillVoices() {
    const vs = voices();
    voiceSel.textContent = '';
    for (const v of serverVoices) voiceSel.append(new Option(v.label, v.engine + '|' + v.voice));
    for (const v of vs) voiceSel.append(new Option('Browser: ' + v.name, 'browser|' + v.name));
    let saved = null;
    try { saved = localStorage.getItem('voice'); } catch (e) { /* none */ }
    if (saved && [...voiceSel.options].some((o) => o.value === saved)) voiceSel.value = saved;
    else if (!serverVoices.length) { const en = vs.find((v) => /^en/i.test(v.lang)); if (en) voiceSel.value = 'browser|' + en.name; }
    if (!voiceSel.options.length) voiceSel.append(new Option('no voices', ''));
  }
  if (synth) synth.onvoiceschanged = fillVoices;
  voiceSel.onchange = () => {
    try { localStorage.setItem('voice', voiceSel.value); } catch (e) { /* none */ }
    if (speaking && !paused) again();
  };
  const showRate = () => { $('#rateval').textContent = (Math.round(parseFloat($('#rate').value) * 20) / 20) + '×'; };
  $('#rate').addEventListener('input', () => {   // while dragging: the number follows, and so does a playing clip
    showRate();
    if (audio) audio.playbackRate = rate();
  });
  $('#rate').addEventListener('change', () => {   // released: the speed applies to reading
    showRate();
    try { localStorage.setItem('rate', $('#rate').value); } catch (e) { /* none */ }
    if (audio) audio.playbackRate = rate();
    else if (speaking && !paused) again();     // a browser voice takes the rate per phrase
  });
  try {                                 // the chosen speed survives a reload, like the voice
    const saved = parseFloat(localStorage.getItem('rate'));
    if (saved >= 0.5 && saved <= 2) $('#rate').value = saved;
  } catch (e) { /* none */ }
  showRate();
  const rate = () => parseFloat($('#rate').value) || 1;

  // The phrases of one block, as the page shows it now.
  function phrases(seg) {
    if (!seg || !seg.el || seg.removed) return [];
    const node = (seg.kind === 'para' || seg.kind === 'quote') ? (seg.edit.classList.contains('quiet') ? null : seg.edit)
      : (seg.kind === 'heading' || seg.kind === 'figure' || seg.kind === 'table') ? seg.edit : null;
    if (!node) return [];
    const map = speechMap(node);
    const bounds = phraseBounds(map.text);
    return bounds.map(([a, b], k) => {
      const text = map.text.slice(a, b);
      // the range of the phrase in the block as it is drawn now: a map made
      // when the queue was filled goes stale when the block is drawn again
      // (a chip typeset, a figure refreshed), and the highlight went with it
      const range = () => {
        const live = seg.edit && seg.edit.isConnected ? seg.edit : null;
        if (!live) return null;
        const m = speechMap(live);
        if (m.text === map.text) return rangeFor(m, a, b);
        const bs = phraseBounds(m.text);
        let j = bs.findIndex(([x, y]) => m.text.slice(x, y) === text);
        if (j < 0) j = Math.min(k, bs.length - 1);
        return j >= 0 ? rangeFor(m, bs[j][0], bs[j][1]) : null;
      };
      return { seg, text, range };
    });
  }
  function build(from, to = ORDER.length) {
    const q = [];
    for (let i = from; i < to; i++) q.push(...phrases(ORDER[i]));
    return q;
  }
  function startAt(i) { queue = []; idx = 0; end = Math.max(0, i); extend(); }
  function extend(ahead = 3) {
    while (queue.length - idx < ahead && end < ORDER.length) queue.push(...phrases(ORDER[end++]));
  }
  // the block before the queue, put in front of it: for « Prev at its start
  function prepend() {
    let i = queue.length ? ORDER.indexOf(queue[0].seg) : end;
    while (--i >= 0) {
      const p = phrases(ORDER[i]);
      if (p.length) { queue.unshift(...p); idx += p.length; return p.length; }
    }
    return 0;
  }

  // Index of the phrase holding the caret; the last phrase that starts at or
  // before it, never blindly the first of the paragraph.
  function caretIndex(queue, seg, caret) {
    let best = -1;
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item.seg !== seg) { if (best >= 0) break; continue; }
      let r;
      try { r = item.range(); } catch (e) { continue; }
      if (!r) continue;
      try {
        if (caret.compareBoundaryPoints(Range.START_TO_START, r) >= 0) best = i;
        else break;
      } catch (e) { /* detached range */ }
    }
    return best;
  }
  // The queue from the phrase of `seg` holding `caret`; false if it has none.
  function seek(seg, caret) {
    const i = ORDER.indexOf(seg);
    if (i < 0 || !seg.el || seg.removed) return false;
    startAt(i);
    const k = caretIndex(queue, seg, caret);
    if (k < 0) return false;
    idx = k; extend();
    return true;
  }

  // Find a remembered phrase in its file: by the block's source, then by
  // text anywhere, then the same block and phrase number (the page was drawn
  // again after an edit of that very phrase).
  function locate(state) {
    const segs = ORDER.filter((s) => s.file === state.file && !s.removed);
    const fragment = (state.text || '').trim().slice(0, 60);
    const at = (seg, k) => { startAt(ORDER.indexOf(seg)); idx = k; extend(); return true; };
    for (const ok of [(s) => s.src === state.src, () => true]) {
      for (const seg of segs) {
        if (!ok(seg)) continue;
        const p = phrases(seg);
        let k = p.findIndex((item) => item.text === state.text);
        if (k < 0 && fragment.length >= 20) k = p.findIndex((item) => item.text.includes(fragment));
        if (k >= 0) return at(seg, k);
      }
    }
    const seg = state.at !== undefined && ORDER[state.at];
    if (seg && seg.file === state.file) {
      const n = phrases(seg).length;
      if (n) return at(seg, Math.min(state.k || 0, n - 1));
    }
    return false;
  }

  function currentCaret() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;    // the start of a selection counts as a place too
    const range = sel.getRangeAt(0);
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    if (!node || !$('#doc').contains(node)) return null;
    const seg = segOf(node);
    if (!seg || !seg.edit || (seg.kind !== 'para' && seg.kind !== 'heading') || !seg.edit.contains(node)) return null;
    return { seg, range: range.cloneRange() };
  }

  // Where Read starts: the caret (or the start of the selection), the last
  // place clicked, and otherwise the top of the paper.
  function place() {
    for (const c of [currentCaret(), anchor]) {
      if (c && c.seg.el && !c.seg.removed && ORDER.includes(c.seg)) return c;
    }
    return null;
  }
  function prepare() {
    const c = place();
    if (c && seek(c.seg, c.range)) return;
    startAt(0);
  }

  // After edits: the phrases again, from the block being read, and `cur` the
  // phrase now where it was (its live range followed the typing).
  function refresh() {
    stale = false;
    if (!cur || !curRange) return;
    const at = curRange.cloneRange();
    at.collapse(true);
    if (!seek(cur.seg, at)) return;     // the block is gone: carry on with the queue
    cur = queue[idx++];
    curRange = cur.range();
  }
  let editTimer = 0;
  function edited() {
    if (!cur) return;
    stale = true;
    // the highlight follows the phrase while it is typed in
    clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      if (!cur || !stale) return;
      refresh();
      markPhrase(curRange, false);
    }, 150);
  }

  function voiceOk() {
    if (voiceSel.value) return true;
    banner('No text-to-speech voice is available. See the README of the editor for how to install one.');
    return false;
  }
  function begin() {
    speaking = true; paused = false;
    updateControls();
    next();
  }
  // Whether sound is coming out now (or about to: a clip being fetched).
  function audible() {
    if (audio) return !audio.paused && !audio.done;
    if (fetching) return true;
    return !!(synth && (synth.speaking || synth.pending) && !synth.paused);
  }
  function play() {
    if (speaking && paused) { pause(); return; }
    // the page says Reading but nothing is heard: read the phrase again
    // rather than ignore the key
    if (speaking && cur && !audible()) { again(); return; }
    if (speaking) return;
    if (!voiceOk()) return;
    stop();
    prepare();                  // the caret or the last click, else the top of the paper
    begin();
  }
  // Read on purpose, from somewhere specific: the cursor (or the last
  // click), the start of the section it is in, or the very beginning.
  function playFrom(c) {         // c: {seg, range}
    if (!voiceOk()) return;
    stop();
    if (!seek(c.seg, c.range)) { banner('Reading could not start there.'); return; }
    begin();
  }
  function playHere() {
    const c = place();
    if (!c) { banner('Click in the text where reading should start.'); return; }
    playFrom(c);
  }
  function playSection() {
    const c = place();
    let i = c ? ORDER.indexOf(c.seg) : -1;
    for (; i >= 0; i--) {
      const h = ORDER[i].kind === 'heading' && L.headingParts(ORDER[i].src);
      if (h && /^(part|chapter|section)$/.test(h.level)) {
        if (!voiceOk()) return;
        stop();
        startAt(i);
        begin();
        return;
      }
    }
    playTop();                   // before the first section: the paper's start
  }
  function playTop() {
    if (!voiceOk()) return;
    stop();
    startAt(0);
    begin();
  }

  function halt() {
    generation++;
    clearTimeout(speakTimer);
    speakTimer = 0;
    clearInterval(keepAlive);
    keepAlive = 0;
    fetching = false;
    if (synth) synth.cancel();
    if (audio) { audio.done = true; audio.pause(); audio = null; }
  }

  function jump(delta) {
    if (stale) refresh();
    if (!speaking || !queue.length) prepare();
    let target = (cur && queue.includes(cur) ? queue.indexOf(cur) : idx) + delta;
    while (target < 0) { const n = prepend(); if (!n) { target = 0; break; } target += n; }
    idx = Math.max(0, target);
    extend();
    if (idx >= queue.length) idx = Math.max(0, queue.length - 1);
    halt();
    if (queue[idx]) { speaking = true; paused = false; next(); } else stop();
  }

  function highlight(seg) {
    if (current === seg) return;
    if (current && current.el) current.el.classList.remove('speaking');
    current = seg;
    if (seg && seg.el) seg.el.classList.add('speaking');
  }

  function next(run = generation) {
    if (run !== generation) return;
    if (stale) refresh();
    extend();
    if (!speaking || idx >= queue.length) { stop(); return; }
    cur = queue[idx++];
    curRange = cur.range();
    say(run);
  }
  // read the current phrase again from its start (a new voice or speed, an
  // edit of it, a resume with a browser voice)
  function again() {
    if (!cur) return;
    halt();
    if (stale) refresh();
    curRange = cur.range();
    say(generation);
  }

  function say(run) {
    const item = cur;
    setState(paused ? 'Paused' : 'Reading');
    updateControls();
    highlight(item.seg);
    markPhrase(curRange, true, true);   // reading wins over a recent keystroke
    heard = item.text;
    const [engine, name] = voiceSel.value.split(/\|(.*)/s);
    if (engine !== 'browser') {
      fetching = true;
      clip(engine, name, item.text).then((c) => {
        if (run !== generation) return;
        fetching = false;
        fails = 0;
        const a = new Audio(c.src);
        audio = a;
        a.playbackRate = rate();
        // paused or played by something else (a media key, a headset taken
        // off, the system): the reader follows, so its buttons say what is heard
        a.onpause = () => {
          if (a.done || run !== generation || audio !== a || paused || a.ending) return;
          if (a.currentTime >= (a.duration || Infinity) - 0.05) return;   // the end of the clip
          paused = true; setState('Paused'); updateControls();
        };
        a.onplay = () => {
          if (a.done || run !== generation || audio !== a || !paused) return;
          paused = false; setState('Reading'); updateControls();
        };
        const finish = () => {
          if (a.done || run !== generation) return;
          a.done = true; a.ending = true; a.pause();
          if (audio === a) audio = null;
          next(run);
        };
        a.onended = finish;
        a.onerror = () => {
          if (run !== generation || a.done) return;
          a.done = true;
          if (audio === a) audio = null;
          skipOrStop(run, 'the audio could not be played');
        };
        // the voice's own silence before and after the phrase is skipped:
        // phrases follow each other as in speech, not with a second between
        const span = c.span;
        if (span && span.start > 0.08) a.currentTime = span.start - 0.05;
        if (span) {
          const stopAt = span.end + 0.3;
          const tick = () => {
            if (a.done || run !== generation) return;
            if (!a.paused && a.currentTime >= stopAt) { finish(); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
        if (!paused) a.play().catch(() => {
          if (run !== generation || a.done) return;
          a.done = true;
          banner('The browser blocked the playback; press Read (Alt+R) to go on.');
          stop();
        });
      }, (e) => {
        if (run !== generation) return;
        fetching = false;
        skipOrStop(run, e.message);
      });
      // the next phrases are fetched (and made by the server) meanwhile
      extend();
      for (const it of queue.slice(idx, idx + 2)) clip(engine, name, it.text).catch(() => {});
      return;
    }
    if (paused) return;
    const u = new SpeechSynthesisUtterance(item.text);
    const v = voices().find((x) => x.name === name);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = rate();
    // Chrome's speech engine sometimes loses the end of an utterance: the
    // sound stops, neither onend nor onerror comes, and the reader would sit
    // on the phrase forever with the page still saying Reading.  A watchdog
    // notices: an utterance that started is treated as finished once it goes
    // quiet; one that never started is skipped, and if two in a row never
    // start the engine is wedged, so reading stops with the reason instead of
    // failing silently.
    let started = false, waited = 0;
    const budget = 5000 + (item.text.split(/\s+/).length * 600) / rate();
    const arm = (ms) => {
      clearTimeout(speakTimer);
      speakTimer = setTimeout(() => {
        if (run !== generation || paused || u.done) return;
        // still talking (a network voice sends no word events, and a phrase
        // with maths read out is long): wait for it, up to three budgets,
        // instead of cutting it off mid-sentence
        if (started && synth.speaking && !synth.paused && (waited += ms) < budget * 3) { arm(2000); return; }
        u.done = true;                 // its own events, if any come late, are ignored
        synth.cancel();
        if (started) { stalls = 0; next(run); return; }
        if (++stalls >= 3) {
          banner('Reading stopped: the browser speech engine stalled. Press Read (Alt+R) to go on from here.');
          stop();
          return;
        }
        next(run);
      }, ms);
    };
    u.onstart = () => { if (run === generation) { started = true; stalls = 0; arm(budget); } };
    u.onboundary = () => { if (run === generation) arm(4000); };   // quiet for this long mid-phrase: it is over
    u.onend = () => {
      if (u.done || run !== generation) return;    // a late event of a cancelled attempt
      u.done = true;
      clearInterval(keepAlive);
      stalls = 0;
      clearTimeout(speakTimer);
      speakTimer = 0;
      next(run);
    };
    u.onerror = (e) => {
      if (run === generation && !u.done && e.error !== 'interrupted' && e.error !== 'canceled') {
        clearTimeout(speakTimer);
        speakTimer = 0;
        next(run);
      }
    };
    synth.speak(u);
    if (synth.paused) synth.resume();   // a wedged engine refuses to start speaking otherwise
    arm(budget + 4000);                 // for the utterance that never begins at all
    // Chrome cuts a network voice (Google UK English …) off after about 15 s
    // without an end event; a pause and resume every 10 s keeps it going
    clearInterval(keepAlive);
    if (v && v.localService === false) {
      keepAlive = setInterval(() => {
        if (run !== generation || paused || u.done) { clearInterval(keepAlive); return; }
        if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
      }, 10000);
    }
  }

  // A server clip that failed: once is skipped (with a word), three in a row
  // stop reading with the reason.
  function skipOrStop(run, why) {
    if (run !== generation) return;
    if (++fails >= 3) { banner('Reading stopped: speech failed three times in a row (' + why + '); see the server output.'); stop(); fails = 0; return; }
    toast('Skipped a sentence the voice could not read (' + why + ')', 'error');
    next(run);
  }

  function clip(engine, voice, text) {
    const url = `/api/tts?engine=${encodeURIComponent(engine)}&voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`;
    if (!clips.has(url)) {
      const p = (async () => {
        const giveUp = new AbortController();      // a stalled synthesis is noticed, not waited for
        const timer = setTimeout(() => giveUp.abort(), 60000);
        try {
          const r = await fetch(url, { signal: giveUp.signal });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
          const blob = await r.blob();
          return { src: URL.createObjectURL(blob), span: await speechSpan(blob).catch(() => null) };
        } catch (e) {
          if (e.name === 'AbortError') throw new Error('the server took too long');
          throw e;
        } finally {
          clearTimeout(timer);
        }
      })();
      p.catch(() => clips.delete(url));
      clips.set(url, p);
      if (clips.size > 16) {
        const [k, old] = clips.entries().next().value;
        clips.delete(k);
        old.then((c) => setTimeout(() => URL.revokeObjectURL(c.src), 60000), () => {});
      }
    }
    return clips.get(url);
  }

  // Where the voice speaks in a clip, in seconds: the first and the last
  // sample above a small fraction of the loudest.
  let actx = null;
  async function speechSpan(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    actx = actx || new Ctx();
    const buf = await actx.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
    if (!peak) return null;
    const th = Math.max(0.002, peak * 0.012);
    let a = 0, b = data.length - 1;
    while (a < b && Math.abs(data[a]) < th) a++;
    while (b > a && Math.abs(data[b]) < th) b--;
    return { start: a / buf.sampleRate, end: b / buf.sampleRate };
  }

  function stop() {
    halt();
    speaking = false;
    paused = false;
    cur = null; curRange = null; stale = false;
    stalls = 0; fails = 0;
    highlight(null);
    markPhrase(null);
    setState('Stopped');
    updateControls();
  }

  // Pause keeps the place.  A browser voice is stopped and the phrase is read
  // again from its start on resume (speechSynthesis.pause is unreliable); a
  // phrase edited while paused is read as it is now.
  function pause() {
    if (!speaking) return;
    paused = !paused;
    setState(paused ? 'Paused' : 'Reading');
    updateControls();
    if (paused) {
      if (audio) audio.pause();
      else { generation++; clearTimeout(speakTimer); speakTimer = 0; clearInterval(keepAlive); keepAlive = 0; fetching = false; if (synth) synth.cancel(); }
      return;
    }
    if (stale) refresh();
    if (audio && cur && cur.text === heard) audio.play().catch(() => {});
    else again();
  }

  function setAnchor(seg, range) { anchor = { seg, range: range.cloneRange() }; }

  function reset() { stop(); queue = []; idx = 0; end = 0; anchor = null; setState('Ready'); }

  // The page is drawn again (a save, a build): the voice goes on, and the
  // phrase is found again in the new page.
  function detach() {
    if (!speaking || !cur) {
      // not reading: the place to start from (the last click) is kept
      const a = anchor && anchor.seg.edit && anchor.seg.edit.isConnected && placeOf(anchor.seg, anchor.range);
      reset();
      return a ? { anchorOnly: a } : null;
    }
    const p = phrases(cur.seg);
    const state = { file: cur.seg.file, src: cur.seg.src, text: cur.text, paused,
      at: ORDER.indexOf(cur.seg), k: Math.max(0, p.findIndex((x) => x.text === cur.text)) };
    highlight(null);
    markPhrase(null);
    queue = []; idx = 0; end = 0; cur = null; curRange = null; anchor = null; stale = false;
    return state;
  }
  function reattach(state) {
    if (!state) return;
    if (state.anchorOnly) { const p = rangeOfPlace(state.anchorOnly); if (p) anchor = p; return; }
    if (!locate(state)) {
      // the phrase is gone (rewritten, its block deleted): go on from the
      // first block with text at or after where it was, rather than stop
      let i = Math.min(state.at || 0, ORDER.length - 1);
      while (i >= 0 && i < ORDER.length && !phrases(ORDER[i]).length) i++;
      if (i < 0 || i >= ORDER.length) { stop(); return; }
      startAt(i);
      if (!queue.length) { stop(); return; }
      heard = '';
    }
    cur = queue[idx++];
    curRange = cur.range();
    highlight(cur.seg);
    markPhrase(curRange, false);
    updateControls();
    if (cur.text !== heard && !paused) again();
  }

  function testPrepare() {
    prepare();
    return { text: queue[idx]?.text || null, index: idx };
  }

  return { play, stop, pause, speaking: () => speaking && !paused, hold: () => { if (speaking && !paused) pause(); }, prev: () => jump(-1), next: () => jump(1), setAnchor, reset, detach, reattach,
    edited, fillVoices, loadServerVoices, build, testPrepare, playHere, playSection, playTop };
})();
$('#play').onclick = () => TTS.play();
$('#tts-prev').onclick = () => TTS.prev();
$('#tts-next').onclick = () => TTS.next();
$('#stop').onclick = () => TTS.stop();
$('#pause').onclick = () => TTS.pause();
$('#readhere').onclick = () => TTS.playHere();
$('#readsection').onclick = () => TTS.playSection();
$('#readtop').onclick = () => TTS.playTop();
$('#doc').addEventListener('input', () => TTS.edited());
// media keys and the system's media controls drive the reader, so they cannot
// pause the sound behind its back
if (navigator.mediaSession) {
  for (const [action, fn] of [['play', () => TTS.play()], ['pause', () => TTS.hold()], ['stop', () => TTS.stop()],
    ['previoustrack', () => TTS.prev()], ['nexttrack', () => TTS.next()]]) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* not supported */ }
  }
}

// Pressing inside a selection starts a new selection (as in a text field),
// not a drag of the selected text, which would move LaTeX around; dragging
// text inside the paper is off altogether.
$('#doc').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || DIFF.on) return;
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  const inside = [...r.getClientRects()].some((b) => e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom);
  if (!inside) return;
  const at = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
  if (at) { sel.removeAllRanges(); sel.addRange(at); }
}, true);
$('#doc').addEventListener('dragstart', (e) => {
  if (e.target.closest && e.target.closest('#doc') && !e.target.closest('[draggable="true"]')) e.preventDefault();
});

// A place in the text that survives a redraw: the block (by its file and
// index there, or its source) and the character offset in its text.
function placeOf(seg, range) {
  try {
    const before = document.createRange();
    before.selectNodeContents(seg.edit);
    before.setEnd(range.startContainer, range.startOffset);
    const segs = (FILES[seg.file] && FILES[seg.file].segs) || [];
    return { file: seg.file, index: segs.indexOf(seg), src: seg.src, offset: before.toString().length };
  } catch (e) { return null; }
}
function rangeOfPlace(p) {
  const segs = (FILES[p.file] && FILES[p.file].segs) || [];
  let seg = segs[p.index];
  if (!seg || seg.src !== p.src) seg = segs.find((x) => x.src === p.src) || seg;
  if (!seg || !seg.edit || !seg.edit.isConnected || seg.edit.tagName === 'TEXTAREA') return null;
  const w = document.createTreeWalker(seg.edit, NodeFilter.SHOW_TEXT);
  let n, off = p.offset;
  while ((n = w.nextNode())) {
    if (off <= n.data.length) { const r = document.createRange(); r.setStart(n, off); r.collapse(true); return { seg, range: r }; }
    off -= n.data.length;
  }
  const r = document.createRange(); r.selectNodeContents(seg.edit); r.collapse(false);
  return { seg, range: r };
}

function rangeContainsCaret(phrase, caret) {
  try {
    return caret.compareBoundaryPoints(Range.START_TO_START, phrase) >= 0 &&
      caret.compareBoundaryPoints(Range.START_TO_END, phrase) <= 0;
  } catch (e) { return false; }
}

function updateSpeechAnchor() {
  const selection = getSelection();
  if (!selection.rangeCount || !selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const seg = segOf(range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
  if (!seg || !seg.edit || (seg.kind !== 'para' && seg.kind !== 'heading')) return;
  TTS.setAnchor(seg, range);
}

document.addEventListener('selectionchange', updateSpeechAnchor);

// The caret must never rest past trailing hidden chips (a block's \end{...},
// a trailing comment): they are display:none, but End/arrows can still put the
// caret after them, and text typed there would land outside the environment.
// Clamp a collapsed caret to the last visible position of its block.
function lastVisiblePos(node) {
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const c = node.childNodes[i];
    if (c.nodeType === 3) { if (c.data.length) return { node: c, offset: c.data.length }; continue; }
    if (c.nodeType !== 1 || c.classList.contains('hidden') || c.classList.contains('tools') || c.classList.contains('nl')) continue;
    // a visible chip (maths, citation): the caret goes after it, never inside it
    if (c.classList.contains('chip')) return { node, offset: i + 1 };
    const r = lastVisiblePos(c);
    if (r) return r;
  }
  return null;
}
function clampCaretToVisibleEnd() {
  const s = getSelection();
  if (!s.rangeCount || !s.isCollapsed) return;
  const a = s.anchorNode;
  if (!a || !(a.isContentEditable || (a.parentElement && a.parentElement.isContentEditable))) return;
  const seg = segOf(a.nodeType === 1 ? a : a.parentElement);
  if (!seg || !seg.edit || !seg.edit.contains(a)) return;
  const end = lastVisiblePos(seg.edit);
  if (!end) return;
  const r = document.createRange();
  r.setStart(a, s.anchorOffset);
  const er = document.createRange();
  er.setStart(end.node, end.offset);
  if (r.compareBoundaryPoints(Range.START_TO_START, er) > 0) {
    const nr = document.createRange();
    nr.setStart(end.node, end.offset);
    nr.collapse(true);
    s.removeAllRanges();
    s.addRange(nr);
  }
}
document.addEventListener('selectionchange', clampCaretToVisibleEnd);
// and before the text lands: the selectionchange task can run after the first
// character is already inserted, so clamp on beforeinput as well
document.addEventListener('beforeinput', (e) => {
  if (/^insert/.test(e.inputType || '')) clampCaretToVisibleEnd();
}, true);

$('#doc').addEventListener('click', () => {
  setTimeout(updateSpeechAnchor, 0);
});

// The spoken text of a block, with the DOM node behind every piece, so that
// a phrase of the speech maps back to a range of the page.
function speechMap(root) {
  const parts = [];
  let text = '';
  const add = (spoken, node, kind) => {
    parts.push({ start: text.length, end: text.length + spoken.length, node, kind });
    text += spoken;
  };
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { add(n.data, n, 'text'); continue; }
      if (n.nodeType !== 1) continue;
      const cl = n.classList;
      if (cl.contains('hidden')) continue;
      if (cl.contains('math')) { add(' ' + mathSpeech(n.dataset.src) + ' ', n, 'chip'); continue; }
      if (cl.contains('parbreak')) { add('. ', n, 'chip'); continue; }
      if (n.dataset.say !== undefined) { add(' ' + n.dataset.say + ' ', n, 'chip'); continue; }
      if (cl.contains('cite') || cl.contains('src')) { add(' ', n, 'chip'); continue; }
      if (cl.contains('chip')) { add(n.textContent, n, 'chip'); continue; }
      walk(n);
    }
  };
  walk(root);
  return { text, parts };
}

// Phrases: sentences, split again at ; and :.  Commas stay inside one
// utterance so speech does not pause unnaturally at every long clause.
const ABBREV = /\b(Fig|Figs|Thm|Eq|Sec|Sect|Lem|Def|Cor|App|i\.e|e\.g|cf|vs|resp|al|Prop)\.$/;
function phraseBounds(text) {
  const out = [];
  let start = 0, m;
  const re = /[.!?;:](?=\s)/g;
  while ((m = re.exec(text))) {
    const end = m.index + 1;
    const piece = text.slice(start, end).trim();
    if (m[0] === '.' && ABBREV.test(piece)) continue;
    if (piece.length < 12 && m[0] !== '.') continue;
    out.push([start, end]);
    start = end;
  }
  if (text.slice(start).trim()) out.push([start, text.length]);
  return out.map(([a, b]) => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    return [a, b];
  }).filter(([a, b]) => b > a);
}

function rangeFor(map, a, b) {
  const r = document.createRange();
  let started = false;
  for (const p of map.parts) {
    if (!started && a < p.end) {
      // offsets are clamped: the text may have been edited since the map was made
      if (!p.node.isConnected) return null;
      if (p.kind === 'text') r.setStart(p.node, Math.min(p.node.length, Math.max(0, a - p.start))); else r.setStartBefore(p.node);
      started = true;
    }
    if (started && b <= p.end) {
      if (!p.node.isConnected) return started ? r : null;
      if (p.kind === 'text') r.setEnd(p.node, Math.min(p.node.length, Math.max(0, b - p.start))); else r.setEndAfter(p.node);
      return r;
    }
  }
  return started ? r : null;
}

// Highlight the phrase being read and keep it on screen.  The highlight is
// one bar per line, drawn over the text (a CSS ::highlight paints every box
// of a formula on its own, so sub- and superscripts stuck out of the line).
const PHRASE = { range: null, layer: null, ro: null, raf: 0 };
function markPhrase(range, reveal = true, force = false) {
  PHRASE.range = range || null;
  drawPhrase();
  if (!PHRASE.ro && range) {
    // the bars follow the text when the page is laid out again
    PHRASE.ro = new ResizeObserver(() => {
      cancelAnimationFrame(PHRASE.raf);
      PHRASE.raf = requestAnimationFrame(drawPhrase);
    });
    PHRASE.ro.observe($('#doc'));
    addEventListener('resize', () => PHRASE.range && drawPhrase());
  }
  if (range && reveal) revealRange(range, true, force);
}

// The bars of a range: its boxes grouped into lines (boxes beside each other
// at the same height, so two columns stay apart), each line as wide as its
// boxes and as tall as its text.  A line with only a formula takes its box.
function phraseBars(range) {
  const text = [], other = [];
  const root = range.commonAncestorContainer;
  const walk = document.createTreeWalker(root.nodeType === 1 ? root : root.parentNode, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!range.intersectsNode(n) || !n.data.trim()) continue;
    if (n.parentElement && n.parentElement.closest('math, .math')) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    if (n === range.startContainer) r.setStart(n, range.startOffset);
    if (n === range.endContainer) r.setEnd(n, range.endOffset);
    for (const b of r.getClientRects()) if (b.width && b.height) text.push(b);
  }
  for (const b of range.getClientRects()) if (b.width && b.height) other.push(b);
  const lines = [];
  const near = (l, b) => b.top < l.bottom && b.bottom > l.top && b.left < l.right + 24 && b.right > l.left - 24;
  for (const b of text) {
    const l = lines.find((x) => near(x, b));
    if (l) { l.left = Math.min(l.left, b.left); l.right = Math.max(l.right, b.right); l.top = Math.min(l.top, b.top); l.bottom = Math.max(l.bottom, b.bottom); }
    else lines.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
  }
  // formulas widen the line they sit on (by their middle), or make one
  for (const b of other) {
    const mid = (b.top + b.bottom) / 2;
    const l = lines.find((x) => mid >= x.top && mid <= x.bottom && b.left < x.right + 24 && b.right > x.left - 24);
    if (l) { l.left = Math.min(l.left, b.left); l.right = Math.max(l.right, b.right); }
    else if (!lines.some((x) => near(x, b))) lines.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
  }
  // the words either side of a formula are one line once it is in
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      if (!near(a, b) || Math.abs((a.top + a.bottom) - (b.top + b.bottom)) / 2 > (a.bottom - a.top) / 2) continue;
      a.left = Math.min(a.left, b.left); a.right = Math.max(a.right, b.right);
      a.top = Math.min(a.top, b.top); a.bottom = Math.max(a.bottom, b.bottom);
      lines.splice(j, 1); j = i;
    }
  }
  return lines;
}

function drawPhrase() {
  const range = PHRASE.range;
  if (!range) { if (PHRASE.layer) PHRASE.layer.replaceChildren(); return; }
  if (!PHRASE.layer) {
    PHRASE.layer = document.createElement('div');
    PHRASE.layer.id = 'ttsmark';
    PHRASE.layer.setAttribute('aria-hidden', 'true');
    document.body.append(PHRASE.layer);
  }
  const bars = [];
  if (range.startContainer.isConnected) {
    for (const l of phraseBars(range)) {
      const d = document.createElement('div');
      d.style.cssText = `left:${l.left + scrollX - 1}px;top:${l.top + scrollY}px;width:${l.right - l.left + 2}px;height:${l.bottom - l.top}px`;
      bars.push(d);
    }
  }
  PHRASE.layer.replaceChildren(...bars);
}

// Bring a range into view below the bars, a third of the way down.  Blocks
// off screen are not laid out (content-visibility) and their size is only
// estimated: a far range is first brought near by its element, then placed.
// The first line counts: a range across two columns is as tall as they are.
function revealRange(range, smooth, force = false) {
  // the writer is typing: the caret's place wins over the reader's — unless
  // the reader itself asked (force), because following a phrase you are
  // listening to must not leave it hidden behind the bars
  if (!force && Date.now() - lastTyping < 1500) return;
  const top = chromeBottom();
  const first = () => range.getClientRects()[0] || range.getBoundingClientRect();
  let r = first();
  if (r.top >= top + 12 && r.bottom <= innerHeight - 40) return;
  if (anchorHold) anchorHold();
  const seq = ++revealSeq;
  const far = r.bottom < -innerHeight / 2 || r.top > innerHeight * 1.5 || (!r.width && !r.height);
  if (far) {
    const n = range.startContainer;
    const e = n.nodeType === 1 ? n : n.parentElement;
    if (e) e.scrollIntoView({ block: 'center' });
    r = first();
  }
  const delta = r.top - top - (innerHeight - top) / 3;
  const glide = smooth && !far && Math.abs(delta) < innerHeight / 2;   // a short move glides, a long one jumps
  window.scrollBy({ top: delta, behavior: glide ? SMOOTH() : 'auto' });
  // blocks just scrolled past are measured for real in the next frames and
  // push the range away: place it again until it stays (a few frames)
  if (!glide) {
    let tries = 0;
    const settle = () => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!range.startContainer.isConnected || seq !== revealSeq) return;
      const q = first(), want = top + (innerHeight - top) / 3;
      if (Math.abs(q.top - want) > 4 && tries++ < 20) { window.scrollBy(0, q.top - want); settle(); }
    }));
    settle();
  }
}

const SPOKEN = { '≤': ' at most ', '≥': ' at least ', '=': ' equals ', '≠': ' is not ', '<': ' less than ',
  '>': ' greater than ', '+': ' plus ', '−': ' minus ', '-': ' minus ', '⋅': ' times ', '×': ' times ',
  '∈': ' in ', '∉': ' not in ', '←': ' gets ', '→': ' to ', '↦': ' maps to ', '∑': ' the sum ',
  '∏': ' the product ', '∣': ' given ', '|': ' ', '(': ' ', ')': ' ', '[': ' ', ']': ' ', '{': ' ', '}': ' ',
  ',': ', ', '/': ' over ', '′': ' prime ', '∗': ' star ', '∪': ' union ', '∩': ' intersect ',
  '⊆': ' a subset of ', '∧': ' and ', '∨': ' or ', '¬': ' not ', '∘': ' composed with ', '…': ', and so on, ',
  '⋯': ', and so on, ', '⇒': ' implies ', '⟹': ' implies ', '⟺': ' if and only if ', '↔': ' swapped with ',
  '≈': ' approximately ', '∞': ' infinity ', '∀': ' for all ', '∃': ' there is ', ':': ' such that ',
  '∅': ' the empty set ', '⊕': ' x-or ', '$': ' \u0001 ', '!': ' factorial ', '∕': ' over ', '∖': ' minus ',
  '≔': ' is defined as ', '≡': ' is equivalent to ', '⊂': ' a subset of ', '⊇': ' a superset of ', '±': ' plus or minus ',
  '·': ' times ', '∥': ' concatenated with ', '‖': ' concatenated with ', '⌊': ' the floor of ', '⌋': ' ', '⌈': ' the ceiling of ', '⌉': ' ',
  '⟨': ' ', '⟩': ' ', '≪': ' much less than ', '≫': ' much greater than ', '∼': ' distributed as ', '≃': ' approximately ' };
// letters a voice would otherwise spell out, or skip
const GREEK = { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta',
  ϑ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ϖ: 'pi', ρ: 'rho', ϱ: 'rho', σ: 'sigma',
  ς: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega', Γ: 'Gamma', Δ: 'Delta', Θ: 'Theta',
  Λ: 'Lambda', Ξ: 'Xi', Π: 'Pi', Σ: 'Sigma', Υ: 'Upsilon', Φ: 'Phi', Ψ: 'Psi', Ω: 'Omega', ℓ: 'ell', '∂': 'partial', '∇': 'nabla' };
const INVISIBLE_RE = /[\u2061-\u2064\u200b-\u200d\u2060\ufeff]/g;
const FENCES = new Set(['|', '∣', '‖', '∥']);
function spokenChars(t) {
  return [...t].map((c) => GREEK[c] !== undefined ? ' ' + GREEK[c] + ' ' : SPOKEN[c] !== undefined ? SPOKEN[c] : c).join('');
}

function mathSpeech(src) {
  let [body] = mathBody(src);
  body = body.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '');
  let html;
  try { html = closeMathmlTags(katex.renderToString(body, { output: 'mathml', throwOnError: false, macros: katexMacros(), strict: false })); }
  catch (e) { return ''; }
  const m = new DOMParser().parseFromString(html, 'text/html').querySelector('math');
  if (!m) return '';
  return speak(m)
    .replace(/\bgets\s+\u0001/g, 'is sampled from')       // x \sample S: x ←$ S
    .replace(/\u0001/g, ' ')
    .replace(/\bPr\b(?!\s+over\b)/g, 'the probability that')
    .replace(/\bsuch that\s+equals\b/g, 'is defined as')
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

function speak(e) {
  const tag = e.tagName.toLowerCase();
  const kids = [...e.children];
  // NFKC keeps Greek letters and ℓ apart from Latin ones (ℓ would become l)
  const txt = () => (e.textContent || '').replace(INVISIBLE_RE, '').replace(/[^ℓ]+/g, (s) => s.normalize('NFKC'));
  switch (tag) {
    case 'annotation': return '';
    case 'mi': case 'mn': case 'mtext': {
      const t = txt();
      if (!t) return '';
      if (tag === 'mtext') return ' ' + t + ' ';
      // a single sign set as an identifier (KaTeX writes / and | so): spoken as a sign
      if ([...t].length === 1) return GREEK[t] !== undefined || SPOKEN[t] !== undefined ? spokenChars(t) : (tag === 'mi' ? ' ' + t + ' ' : t);
      return ' ' + spokenChars(t) + ' ';
    }
    case 'mo': {
      const t = txt();
      if (!t) return '';
      return SPOKEN[t] !== undefined ? SPOKEN[t] : ' ' + spokenChars(t) + ' ';
    }
    case 'mfrac': return ` ${speak(kids[0])} over ${speak(kids[1])} `;
    case 'msqrt': return ` the square root of ${kids.map(speak).join('')} `;
    case 'msub': case 'munder': {
      const base = speak(kids[0]).trim();
      const sub = speak(kids[1]);
      if (base === 'Pr') return ` the probability over ${sub} of `;
      if (base === 'E' || base === '𝔼') return ` the expectation over ${sub} of `;
      return ` ${base} ${sub} `;
    }
    case 'msup': case 'mover': {
      const base = speak(kids[0]);
      const sup = (kids[1].textContent || '').normalize('NFKC');
      if (tag === 'mover') return base;
      if (sup === '′' || sup === "'") return base + ' prime ';
      if (sup === '∗' || sup === '*') return base + ' star ';
      if (sup === '2') return base + ' squared ';
      return ` ${base} to the ${speak(kids[1])} `;
    }
    case 'msubsup': case 'munderover': return ` ${speak(kids[0])} from ${speak(kids[1])} to ${speak(kids[2])} `;
    case 'mtable': return kids.map(speak).join('. ');
    default: {
      // |X| (the size of a set), ‖x‖: a fence on each side of a group
      const sign = (k) => k && /^m[oi]$/.test(k.tagName.toLowerCase()) ? (k.textContent || '').replace(INVISIBLE_RE, '') : null;
      if (kids.length >= 3 && FENCES.has(sign(kids[0])) && sign(kids[0]) === sign(kids[kids.length - 1]))
        return ` the size of ${kids.slice(1, -1).map(speak).join('')} `;
      // the same in a flat row: |H(X)| <= |X|/2; \mid (spaced as a relation) is "given"
      const bar = (k) => FENCES.has(sign(k)) && !(k.getAttribute('lspace') || '').startsWith('0.27');
      // \mathrm{eval}, \mathsf{Coll}: KaTeX writes a letter per identifier; they are one word
      const letter = (k) => k && k.tagName.toLowerCase() === 'mi' && k.getAttribute('mathvariant') && /^[A-Za-z]$/.test(k.textContent || '');
      let out = '';
      for (let i = 0; i < kids.length; i++) {
        if (letter(kids[i]) && letter(kids[i + 1]) && kids[i].getAttribute('mathvariant') === kids[i + 1].getAttribute('mathvariant')) {
          let w = '';
          const v = kids[i].getAttribute('mathvariant');
          while (letter(kids[i]) && kids[i].getAttribute('mathvariant') === v) w += kids[i++].textContent;
          i--;
          out += ' ' + w + ' ';
          continue;
        }
        if (bar(kids[i])) {
          let j = i + 1;
          while (j < kids.length && !(bar(kids[j]) && sign(kids[j]) === sign(kids[i]))) j++;
          if (j < kids.length && j > i + 1) { out += ` the size of ${kids.slice(i + 1, j).map(speak).join('')} `; i = j; continue; }
        }
        out += speak(kids[i]);
      }
      return out;
    }
  }
}

// ----------------------------------------------------------- self-test

// Re-serializes every block from the page without any edit and compares
// with the source: the page must give back exactly what it read.
function selfTest() {
  let bad = 0, n = 0;
  const report = [];
  for (const seg of ORDER) {
    if (!seg.edit) continue;
    n++;
    const got = segSource(seg, []);
    if (got !== seg.src) {
      bad++;
      let i = 0;
      while (got[i] === seg.src[i]) i++;
      report.push(`${seg.file} ${seg.kind}: …${JSON.stringify(seg.src.slice(Math.max(0, i - 20), i + 30))} became …${JSON.stringify(got.slice(Math.max(0, i - 20), i + 30))}`);
    }
  }
  const files = editedFiles();
  const maths = [...document.querySelectorAll('.chip.math')];
  const badMath = maths.filter((m) => m.classList.contains('bad'));
  report.push(`maths ${maths.length}, errors ${badMath.length}, rendered ${maths.filter((m) => m.querySelector('.katex')).length}, fonts ${document.fonts.status}`);
  badMath.slice(0, 8).forEach((m) => report.push('MATH ERROR ' + m.dataset.src.slice(0, 80) + ' :: ' + (m.querySelector('.katex-error')?.title || '').slice(0, 120)));
  const q = TTS.build(0);
  report.push(`speech: ${q.length} phrases`);
  for (const item of q.slice(0, 7)) {
    const r = item.range();
    report.push(`  SAY ${JSON.stringify(item.text.slice(0, 70))}  MARK ${JSON.stringify(r ? r.toString().slice(0, 70) : null)}`);
  }
  const mathItem = q.find((it) => /over|sub|probability/.test(it.text));
  if (mathItem) report.push(`  SAY ${JSON.stringify(mathItem.text.slice(0, 140))}`);
  report.push('highlight API: ' + !!(window.CSS && CSS.highlights));
  const shown = [...document.querySelectorAll('[hidden]')].filter((e) => getComputedStyle(e).display !== 'none');
  if (shown.length) { bad++; report.push('HIDDEN BUT SHOWN: ' + shown.map((e) => '#' + e.id).join(' ')); }
  // timing: a typed character and a click into a block, with layout forced
  const timeIt = (label) => {
    const ps = ORDER.filter((x) => x.kind === 'para' && x.edit && !x.edit.classList.contains('quiet'));
    const seg = ps[Math.min(40, ps.length - 1)];
    if (!seg) return;
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) {
      const tn = document.createTextNode('x');
      seg.edit.append(tn); void document.body.offsetHeight; tn.remove(); void document.body.offsetHeight;
    }
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) {
      const r = document.createRange(); r.selectNodeContents(seg.edit); r.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(r); seg.edit.focus(); void document.body.offsetHeight;
      seg.edit.blur(); void document.body.offsetHeight;
    }
    const t2 = performance.now();
    report.push(`timing ${label}: keystroke ${((t1 - t0) / 10).toFixed(1)} ms, click ${((t2 - t1) / 10).toFixed(1)} ms`);
  };
  timeIt('one column');
  document.body.classList.add('two'); void document.body.offsetHeight;
  timeIt('two columns');
  document.body.classList.remove('two');
  const msg = `SELFTEST ${bad ? 'FAILED' : 'OK'}: ${n} blocks, ${bad} differ, ${files.length} files differ`;
  document.title = msg;
  const b = $('#banner');
  b.hidden = false;
  b.textContent = msg + (report.length ? ' — ' + report.slice(0, 3).join(' | ') : '');
  console.log(msg, report);
  fetch('/api/log', { method: 'POST', headers: { 'X-Token': TOKEN }, body: msg + '\n' + report.join('\n') });
}

// Scripted edits through the same DOM and model code as the UI, then the
// resulting source changes are logged (nothing is saved).
function editTest() {
  const log = [];
  const paras = ORDER.filter((x) => x.kind === 'para' && x.edit && !x.edit.classList.contains('quiet'));
  const firstPara = paras[Math.floor(paras.length / 4)];
  const someLabel = (collectLabels()[0] || { key: 'sec:x' }).key;
  firstPara.edit.append(document.createTextNode(' Costs 50% & “more” — see Section '));
  firstPara.edit.append(chip('ref', '\\ref{' + someLabel + '}', '1'));
  firstPara.edit.append(document.createTextNode(' with '));
  firstPara.edit.append(mathChip('$x_1^2$', false));
  firstPara.edit.append(document.createTextNode('.'));
  firstPara.edit.append(chip('parbreak', '\n\n', ''));
  firstPara.edit.append(document.createTextNode('A new paragraph.'));
  const fig = ORDER.find((s) => s.kind === 'figure');
  fig.edit.append(document.createTextNode(' Edited caption.'));
  const head = ORDER.find((x) => x.kind === 'heading' && x.file === firstPara.file) || ORDER.find((x) => x.kind === 'heading');
  head.edit.append(document.createTextNode(' (edited)'));
  const code = ORDER.find((s) => s.kind === 'code');
  code.edit.value += '(* added line *)\n';
  structural(() => { insertAfter(head, '\\subsection{' + PLACEHOLDER + '}'); return null; });
  const warnings = commit();
  for (const n of Object.keys(FILES)) {
    const a = FILES[n].disk, b = FILES[n].text;
    if (a === b) continue;
    let i = 0; while (a[i] === b[i]) i++;
    let j = 0; while (j < a.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    log.push(`${n}: -${JSON.stringify(a.slice(i, a.length - j))} +${JSON.stringify(b.slice(i, b.length - j))}`);
  }
  log.push('warnings: ' + JSON.stringify(warnings));
  fetch('/api/log', { method: 'POST', headers: { 'X-Token': TOKEN }, body: 'EDITTEST\n' + log.join('\n') });
}

function readerTest() {
  const failures = [];
  const fail = (message) => failures.push(message);
  if (phraseBounds('This is a deliberately long clause that contains a comma, and it should remain one natural spoken sentence.')
      .length !== 1) fail('comma split speech into multiple phrases');
  const phrases = TTS.build(0);
  if (phrases.length < 2) fail('not enough speech phrases');
  else {
    const target = phrases[1];
    const source = target.range();
    const caret = document.createRange();
    caret.setStart(source.startContainer, source.startOffset);
    caret.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges(); selection.addRange(caret);
    updateSpeechAnchor();
    const selected = TTS.testPrepare();
    if (selected.text !== target.text) fail('caret selected the wrong sentence');
    TTS.reset();
    getSelection().removeAllRanges();
    const begun = TTS.testPrepare();
    if (begun.text !== phrases[0].text) fail('with no place chosen, reading does not start at the top');
  }
  if (!$('#pause').disabled || !$('#stop').disabled) fail('idle controls are enabled');
  const msg = `READTEST ${failures.length ? 'FAILED' : 'OK'}: ${failures.length ? failures.join('; ') : 'caret, top of the paper, controls'}`;
  document.title = msg;
  console.log(msg);
  fetch('/api/log', { method: 'POST', headers: { 'X-Token': TOKEN }, body: msg });
}

load(false).then(() => {
  TTS.loadServerVoices();
  const query = new URLSearchParams(location.search);
  if (query.has('edittest')) editTest();
  if (query.has('readertest')) readerTest();
  AUXVER = DOC.auxver; TTS.fillVoices(); poll(); });

// =============================================================== keymap
//
// Your Emacs bindings where a browser allows them (C-w and C-q are
// reserved by Firefox), the usual editor keys, and keys for structure.

// ---- undo history: snapshots of the file texts, taken before every
// change made by the editor and at pauses in typing
const HISTORY = { undo: [], redo: [] };
function snapshot() {
  if (MC.replaying || SNAP_HOLD) return;   // an edit at many cursors (or a spelling cycle) is one step, taken before it
  commit();
  const texts = Object.fromEntries(Object.entries(FILES).map(([n, f]) => [n, f.text]));
  const last = HISTORY.undo[HISTORY.undo.length - 1];
  if (last && Object.keys(texts).every((n) => texts[n] === last[n])) return;
  HISTORY.undo.push(texts);
  if (HISTORY.undo.length > 300) HISTORY.undo.shift();
  HISTORY.redo = [];
}
// one snapshot per burst of typing in one block: typing elsewhere, or after
// an undo or redo, starts a new one
let typingSnap = null, typingIn = null;
doc.addEventListener('beforeinput', (e) => {
  const here = e.target.closest ? e.target.closest('[contenteditable=true], textarea') : null;
  if (!typingSnap || here !== typingIn) snapshot();
  typingIn = here;
  clearTimeout(typingSnap);
  typingSnap = setTimeout(() => { typingSnap = null; }, 1200);
});
function restore(from, to) {
  clearTimeout(typingSnap); typingSnap = null; typingIn = null;
  mcClear();   // an undo goes back to one cursor
  const rediff = DIFF.on && !SRC.on;
  if (!rediff) leaveDiff();
  commit();
  const cur = Object.fromEntries(Object.entries(FILES).map(([n, f]) => [n, f.text]));
  let texts = from.pop();
  while (texts && Object.keys(texts).every((n) => texts[n] === cur[n])) texts = from.pop();
  if (!texts) return;
  to.push(cur);
  // where the texts differ, and the text of the block there, to put the
  // caret at the change afterwards
  const change = textChange(cur, texts);
  // a file made since (a section moved to its own file) is left unread; one
  // made before and dropped since comes back, still to be written
  for (const [n, t] of Object.entries(texts)) if (FILES[n]) FILES[n].text = t; else newFile(n, t);
  const y = viewAnchor();
  render();
  restoreAnchor(y);
  if (SRC.on) { refreshSourceView(); return; }
  caretAtChange(change);
  if (rediff) diffAgain(captureEditorState());
}

// The first change between two sets of file texts: the file, where it
// starts and ends in the new text, and the text the block there showed.
function textChange(oldTexts, newTexts) {
  const files = [...new Set([...ORDER.map((s) => s.file), ...Object.keys(newTexts)])];
  for (const n of files) {
    const a = oldTexts[n], b = newTexts[n];
    if (a === undefined || b === undefined || a === b) continue;
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const seg = segAtOffset(n, p);
    return { file: n, start: p, end: b.length - s, was: seg && seg.edit && seg.edit.isContentEditable ? seg.edit.textContent : null };
  }
  return null;
}
function segAtOffset(name, offset) {
  let at = 0;
  for (const s of (FILES[name] && FILES[name].segs) || []) {
    if (s.removed) continue;
    const len = s.src.length;
    if (offset < at + len || (offset === at + len && s.kind !== 'gap')) return s.kind === 'gap' ? null : s;
    at += len;
  }
  return null;
}

// After an undo or redo: the caret goes where the text changed (the end of
// the changed part, in the first block drawn again), and that is shown.
function caretAtChange(change) {
  if (!change || !FILES[change.file]) return;
  // the block at the end of the change (the start, if that is a blank line)
  let seg = segAtOffset(change.file, Math.max(change.start, change.end - 1)) || segAtOffset(change.file, change.start);
  if (!seg || !seg.el) return;
  if (!seg.edit || !seg.edit.isContentEditable) { revealChanged(seg.el.getBoundingClientRect(), seg); return; }
  const segs = FILES[seg.file].segs;
  const index = segs.indexOf(seg);
  const now = seg.edit.textContent;
  const was = change.was;
  let offset = now.length;
  if (typeof was === 'string') {
    let a = 0;
    while (a < now.length && a < was.length && now[a] === was[a]) a++;
    let b = 0;
    while (b < now.length - a && b < was.length - a && now[now.length - 1 - b] === was[was.length - 1 - b]) b++;
    offset = now.length - b;
  }
  restoreEditorState({ file: seg.file, index, src: seg.src, offset });
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  revealChanged(r.height ? r : seg.el.getBoundingClientRect(), seg);
}
// Bring the place of an undone change into view only when it is not in view;
// a third of the way down, at once (a glide would fight the held view).
function revealChanged(rect, seg) {
  const top = chromeBottom();
  if (rect.top >= top + 8 && rect.bottom <= innerHeight - 24) return;
  if (anchorHold) anchorHold();
  if (!rect.height && !rect.top) { seg.el.scrollIntoView({ block: 'center' }); return; }
  // just out of view: the least scroll that shows it (as an editor does);
  // far away: a third of the way down
  // the same edges as the test above: a caret just inside them is not nudged
  const up = rect.top - (top + 8), down = rect.bottom - (innerHeight - 24);
  const near = rect.bottom > top - innerHeight && rect.top < innerHeight * 2;
  window.scrollBy(0, near ? (up < 0 ? up : down) : rect.top - top - (innerHeight - top) / 3);
}
const undo = () => restore(HISTORY.undo, HISTORY.redo);
const redo = () => restore(HISTORY.redo, HISTORY.undo);

// ---- selection helpers
function selRange() { const s = getSelection(); return s.rangeCount ? s.getRangeAt(0) : null; }
function setCaretAfter(node) {
  const r = document.createRange(); r.setStartAfter(node); r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function editableAt(range) {
  if (!range) return null;
  const n = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  return n && n.closest('[contenteditable=true]');
}
function selectLine() {
  const s = getSelection();
  s.modify('move', 'backward', 'lineboundary');
  s.modify('extend', 'forward', 'lineboundary');
}

// Wrap the selection (or a placeholder) in \emph, \textbf or \textit.
function wrap(prefix, tag) {
  let r = selRange();
  if (!editableAt(r)) return;
  if (!r.collapsed) {
    r = selectionInOneEditable();
    if (!r) { banner('Select text inside one paragraph to format it.'); return; }
  }
  snapshot();
  // already formatted that way: remove the formatting from the selection
  const sel = tag === 'strong' ? 'strong, b' : tag === 'code' ? 'code' : 'em, i';
  const anc = r.commonAncestorContainer;
  const root = (anc.nodeType === 1 ? anc : anc.parentElement).closest('[contenteditable="true"]');
  const fmt = (anc.nodeType === 1 ? anc : anc.parentElement).closest(sel);
  if (fmt && root && root.contains(fmt) && fmt !== root && !fmt.classList.contains('runin')) {
    if (!r.collapsed) {
      const cut = (a, b) => {
        const x = document.createRange();
        x.setStart(...a); x.setEnd(...b);
        const f = x.extractContents();
        if (!f.textContent) return null;
        const c = fmt.cloneNode(false); c.append(f); return c;
      };
      const pre = cut([fmt, 0], [r.startContainer, r.startOffset]);
      const post = cut([r.endContainer, r.endOffset], [fmt, fmt.childNodes.length]);
      if (pre) fmt.before(pre);
      if (post) fmt.after(post);
    }
    const kids = [...fmt.childNodes];
    fmt.replaceWith(...kids);
    if (kids.length) {
      const nr = document.createRange();
      nr.setStartBefore(kids[0]); nr.setEndAfter(kids[kids.length - 1]);
      const s = getSelection(); s.removeAllRanges(); s.addRange(nr);
    }
    markEditedSoon();
    return;
  }
  const e = el(tag);
  e.dataset.prefix = prefix;
  if (r.collapsed) e.append(document.createTextNode('text'));
  else e.append(r.extractContents());
  r.insertNode(e);
  const nr = document.createRange(); nr.selectNodeContents(e);
  const s = getSelection(); s.removeAllRanges(); s.addRange(nr);
  markEditedSoon();
}

// A range never cuts through a chip (maths, a reference): it is widened to
// take the whole chip, so that wrapping or copying never splits one.
function snapOutOfChips(r) {
  const chipOf = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest('.chip');
  const a = chipOf(r.startContainer), b = chipOf(r.endContainer);
  if (a) r.setStartBefore(a);
  if (b) r.setEndAfter(b);
  return r;
}

// The selection (a copy, widened to whole chips) when it lies inside one
// editable text, else null.
function selectionInOneEditable() {
  const r = selRange();
  if (!r || r.collapsed || spansEditables(r)) return null;
  return snapOutOfChips(r.cloneRange());
}

// A selection from one block (or heading, caption) into another: the
// browser would delete across blocks, page structure included, so nothing
// may edit it.
function spansEditables(r = selRange()) {
  if (!r || r.collapsed) return false;
  const a = editableAt(r);
  const endNode = r.endContainer.nodeType === 1 ? r.endContainer : r.endContainer.parentElement;
  return !a || !endNode || endNode.closest('[contenteditable=true]') !== a;
}
const ACROSS = 'Select inside one paragraph (or heading) for that: a selection across paragraphs can be copied, cut, deleted or typed over.';
document.addEventListener('beforeinput', (e) => {
  if (e.target.closest && e.target.closest('#doc') && e.target.isContentEditable && spansEditables()) {
    e.preventDefault();
    // typing (or deleting) over blocks of text joins them first
    const t = e.inputType || '';
    const across = acrossParts();
    if (across && across.ok && (t === 'insertText' || t === 'insertReplacementText' || /^delete/.test(t)) && t !== 'deleteByCut') {
      if (deleteAcross() && /^insert/.test(t) && e.data) document.execCommand('insertText', false, e.data);
      return;
    }
    banner(ACROSS);
  }
}, true);
// A deletion in one block (Backspace, Delete, typing over a selection) that
// would take a \begin or an \end without its partner keeps it.
document.addEventListener('beforeinput', (e) => {
  const t = e.inputType || '';
  if (e.defaultPrevented || !(e.target.closest && e.target.closest('#doc') && e.target.isContentEditable)) return;
  if (!/^delete/.test(t) && t !== 'insertText' && t !== 'insertReplacementText' && t !== 'insertParagraph' && t !== 'insertLineBreak') return;
  const sel = getSelection();
  if (!sel.rangeCount || spansEditables()) return;
  const ranges = sel.isCollapsed ? e.getTargetRanges().map((s) => { const r = document.createRange(); r.setStart(s.startContainer, s.startOffset); r.setEnd(s.endContainer, s.endOffset); return r; })
    : [sel.getRangeAt(0)];
  const lone = ranges.flatMap((r) => unpairedEnvChips(envChipsIn(r)));
  if (!lone.length) return;
  e.preventDefault();
  if (sel.isCollapsed) {
    const m = envOf(lone[0]);
    toast(`${/Backward/.test(t) ? 'Backspace' : 'Delete'} stops at the ${m[1] === 'begin' ? 'start' : 'end'} of ${envName(lone[0])}`);
    return;
  }
  snapshot();
  const r = sel.getRangeAt(0);
  deleteKeepingEnvs(r);
  sel.removeAllRanges(); sel.addRange(r);
  if (/^insert/.test(t) && t !== 'insertText' && t !== 'insertReplacementText') insertBreak();
  else if (e.data) document.execCommand('insertText', false, e.data);
  markEditedSoon();
}, true);

// Keys that wrap a selection instead of replacing it; both the opening and
// the closing key wrap.  Quotes become TeX quotes (`` '' and ` ') on saving.
const WRAP_PAIRS = {
  '(': ['(', ')'], ')': ['(', ')'], '[': ['[', ']'], ']': ['[', ']'], '{': ['{', '}'], '}': ['{', '}'],
  '"': ['“', '”'], "'": ['‘', '’'], '`': ['‘', '’'],
};

// In the paper view, ( and [ typed at the caret come in pairs when that is
// turned on (☰ → Close brackets as you type; off by default, since text
// rarely wants it), with the rules of srcPair.
let PAPER_PAIRS = false;
try { PAPER_PAIRS = localStorage.getItem('paper-pairs') === '1'; } catch (e) { /* storage unavailable */ }
const PAPER_PAIR = { '(': ')', '[': ']' };
function setPaperPairs(on) {
  PAPER_PAIRS = !!on;
  try { localStorage.setItem('paper-pairs', on ? '1' : ''); } catch (e) { /* storage unavailable */ }
  const b = document.getElementById('pairsbtn');
  if (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('pressed', !!on); }
}
// the characters just before and after a collapsed selection, in its text node
function caretChars() {
  const s = getSelection();
  if (!s.rangeCount || !s.isCollapsed) return null;
  const n = s.focusNode, o = s.focusOffset;
  if (n.nodeType !== 3) return { before: '', after: '' };
  return { before: n.data[o - 1] || '', after: n.data[o] || '' };
}
function paperPair(key) {
  if (!PAPER_PAIRS) return false;
  const c = caretChars();
  if (!c) return false;
  if (PAPER_PAIR[key]) {
    if (c.after && !/[\s)\],.;:\u00a0]/.test(c.after)) return false;
    document.execCommand('insertText', false, key + PAPER_PAIR[key]);
    getSelection().modify('move', 'backward', 'character');
    return true;
  }
  if (')]'.includes(key) && c.after === key) { getSelection().modify('move', 'forward', 'character'); return true; }
  return false;
}
function paperPairBackspace() {
  if (!PAPER_PAIRS) return false;
  const c = caretChars();
  if (!c || !PAPER_PAIR[c.before] || c.after !== PAPER_PAIR[c.before]) return false;
  const s = getSelection();
  s.modify('move', 'backward', 'character');
  s.modify('extend', 'forward', 'character');
  s.modify('extend', 'forward', 'character');
  document.execCommand('delete');
  return true;
}

// Wrap the selection in open … close; the selection stays on the wrapped
// text, so that another key wraps it again.
function wrapLiteral(open, close) {
  const r = selectionInOneEditable();
  if (!r) return false;
  snapshot();
  const contents = r.extractContents();
  const a = document.createTextNode(open), b = document.createTextNode(close);
  const frag = document.createDocumentFragment();
  frag.append(a, contents, b);
  r.insertNode(frag);
  const nr = document.createRange();
  nr.setStartAfter(a); nr.setEndBefore(b);
  const s = getSelection(); s.removeAllRanges(); s.addRange(nr);
  markEditedSoon();
  return true;
}

const TEXT_CHAR_CMD = /^\\text(?:backslash|asciitilde|asciicircum|less|greater)\b/;
// The LaTeX of a piece of the page taken as maths: typed text as it is (an
// x^2 typed as text is maths x^2), formulas without their dollars.
function mathSourceOf(node, top = true) {
  let out = '';
  for (const n of node.childNodes) {
    // in maths too, % starts a comment (it would eat the rest of the line,
    // closing braces included), # and & mean other things, and $ ends it
    if (n.nodeType === 3) { out += escapeIn(n.data.replace(/ /g, '~'), '%#&$'); continue; }
    if (n.nodeType !== 1) continue;
    if (n.classList.contains('math')) { out += mathBody(n.dataset.src)[0]; continue; }
    // a character typed as text and saved as \textbackslash{}, \textless{}…:
    // in maths it is that character again, as when just typed (\G1 typed,
    // saved and then made maths is $\G1$, not $\textbackslash{}G1$)
    if (n.classList.contains('char') && TEXT_CHAR_CMD.test(n.dataset.src || '')) { out += n.textContent; continue; }
    if (n.dataset.src !== undefined) { out += n.classList.contains('nl') ? ' ' : n.dataset.src; continue; }
    out += mathSourceOf(n, false);
  }
  if (top) {
    // braces typed as text that do not pair up are literal braces
    let depth = 0, ok = true;
    for (const c of out.replace(/\\./g, '')) { if (c === '{') depth++; if (c === '}' && --depth < 0) ok = false; }
    if (!ok || depth) out = escapeIn(out, '{}');
  }
  return out;
}

// Put a backslash before each of `chars` in s that has none yet.
function escapeIn(s, chars) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i++; continue; }
    out += (chars.includes(s[i]) ? '\\' : '') + s[i];
  }
  return out;
}

// Ctrl+M (or $ over a selection): the selection becomes inline maths; with no selection, a new
// formula opens in the drawer.
function mathAtSelection() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return insertMath(false);
  const r = selectionInOneEditable();
  if (!r) { banner('Select text inside one paragraph to make it maths.'); return; }
  snapshot();
  const body = mathSourceOf(r.cloneContents());
  const lead = body.match(/^\s*/)[0], trail = body.match(/\s*$/)[0];
  const math = mathChip('$' + body.trim() + '$', false);
  r.deleteContents();
  const frag = document.createDocumentFragment();
  if (lead) frag.append(document.createTextNode(lead));
  frag.append(math);
  if (trail) frag.append(document.createTextNode(trail));
  r.insertNode(frag);
  setCaretAfter(math);
  markEditedSoon();
}

// $ typed at the caret with an unclosed $ before it in the same run of text:
// the closing $ turns what was typed between the dollars into one maths
// chip.  The same heuristics as on paste: no space just inside the dollars,
// no digit right after the closing one (so "5$ or 10$" stays text).
function closeMathAtCaret() {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  if (!editableAt(r) || r.startContainer.nodeType !== 3) return false;
  // the text before the caret, back to the previous chip (a chip already
  // closed any earlier $)
  const run = [[r.startContainer, r.startOffset]];
  let before = r.startContainer.data.slice(0, r.startOffset);
  for (let p = r.startContainer.previousSibling; p && p.nodeType === 3; p = p.previousSibling) {
    run.unshift([p, p.data.length]);
    before = p.data + before;
  }
  if (!before || /\s$/.test(before)) return false;
  if (/^[0-9]/.test(r.startContainer.data.slice(r.startOffset))) return false;
  let open = -1;
  for (let k = before.length - 1; k >= 0; k--) {
    if (before[k] !== '$' || (k > 0 && before[k - 1] === '\\')) continue;
    if (/\s/.test(before[k + 1] || '')) continue;
    open = k; break;
  }
  if (open < 0) return false;
  const body = before.slice(open + 1);
  if (!body) return false;
  for (let k = 0; k < body.length; k++) if (body[k] === '$' && (k === 0 || body[k - 1] !== '\\')) return false;
  let pos = 0, startNode = null, startOff = 0;
  for (const [tn, len] of run) {
    if (open < pos + len) { startNode = tn; startOff = open - pos; break; }
    pos += len;
  }
  if (!startNode) return false;
  snapshot();
  const bodyRange = document.createRange();
  bodyRange.setStart(startNode, startOff + 1);   // the opening $ is not part of the formula
  bodyRange.setEnd(r.startContainer, r.startOffset);
  const math = mathChip('$' + mathSourceOf(bodyRange.cloneContents()) + '$', false);
  bodyRange.setStart(startNode, startOff);
  bodyRange.deleteContents();
  bodyRange.insertNode(math);
  setCaretAfter(math);
  markEditedSoon();
  return true;
}

// Insert chips at the caret: a paragraph break, maths, raw LaTeX.
function insertNodes(nodes) {
  const r = selRange();
  if (!editableAt(r)) return false;
  snapshot();
  deleteKeepingEnvs(r);
  const frag = document.createDocumentFragment();
  nodes.forEach((n) => frag.append(n));
  const last = nodes[nodes.length - 1];
  r.insertNode(frag);
  setCaretAfter(last);
  markEditedSoon();
  return true;
}

// A paragraph break (with anything after it) at the caret.  A line break
// right beside the caret goes: the paragraph break replaces it, rather than
// leaving three newlines in the file.
function insertBreak(nodes = [chip('parbreak', '\n\n', '')]) {
  const r = selRange();
  if (!editableAt(r)) return false;
  if (r.collapsed) {
    const nb = neighbours(r);
    const isNl = (n) => n && n.nodeType === 1 && n.classList.contains('nl') && /^\s*\n\s*$/.test(n.dataset.src || '');
    if (!nb.inText) {
      snapshot();
      if (isNl(nb.before)) { const b = nb.before; r.setStartBefore(b); r.collapse(true); b.remove(); }
      else if (isNl(nb.after)) nb.after.remove();
    }
  }
  return insertNodes(nodes);
}

// A heading at the caret: the paragraph is split there, and the text after
// the caret goes under the new heading.
function headingAtCaret(level) {
  const seg = segOf(editableAt(selRange()) || document.body);
  // on a heading: the new heading goes right after it (a subsection under
  // the section just made, say)
  if (seg && seg.kind === 'heading') {
    const after = level === 'paragraph' ? '\\paragraph{' + PLACEHOLDER + '}\nText.' : '\\' + level + '{' + PLACEHOLDER + '}';
    structural(() => { insertAfter(seg, after); return PLACEHOLDER; });
    return;
  }
  if (!seg || seg.kind !== 'para') return;
  const src = level === 'paragraph' ? '\\paragraph{' + PLACEHOLDER + '}\n' : '\\' + level + '{' + PLACEHOLDER + '}';
  const nodes = level === 'paragraph'
    ? [chip('parbreak', '\n\n', ''), chip('src', src, src)]
    : [chip('parbreak', '\n\n', ''), chip('src', src, src), chip('parbreak', '\n\n', '')];
  if (!insertBreak(nodes)) return;
  structural(() => PLACEHOLDER);
  // one section per file: a section split off inside a section file goes to
  // a file of its own, read right after that one
  if (HEADING_RANK[level] <= SECTION_RANK_MAX && seg.file !== DOC.main && seg.file.startsWith(sectionsDir())) {
    const fresh = (FILES[seg.file].segs || []).find((s) => s.kind === 'heading' && !s.removed && L.headingParts(s.src) && plainOfLatex(L.headingParts(s.src).title) === PLACEHOLDER);
    if (fresh && FILES[seg.file].segs.indexOf(fresh) > 0) {
      let name;
      structural(() => { name = extractSection(fresh); return PLACEHOLDER; }, false);
      if (name) toast(`The new section has its own file, ${name} (named after its title when you save)`, 'ok');
    }
  }
}

function splitSectionAtCaret() {
  const r = selRange();
  const seg = segOf(editableAt(r) || document.body);
  if (!seg || seg.kind !== 'para') { banner('Put the cursor in the section where it should split.'); return; }
  const segs = FILES[seg.file].segs;
  const at = segs.indexOf(seg);
  let heading = null;
  for (let i = at - 1; i >= 0; i--) if (segs[i].kind === 'heading') { heading = segs[i]; break; }
  const h = heading && L.headingParts(heading.src);
  if (!h) { banner('This text is not inside a named section.'); return; }
  headingAtCaret(h.level);
}

function insertMath(display) {
  const m = display ? mathChip('\\[\n  \n\\]', true) : mathChip('$ $', false);
  let nodes = [m];
  if (display) {
    // a displayed formula on its own lines; never a blank line (a new
    // paragraph) where a line break was already
    const r = selRange();
    const around = r && editableAt(r) ? neighbours(r) : {};
    const isBreak = (n) => n && n.nodeType === 1 && /\n/.test(n.dataset.src || '') && (n.classList.contains('nl') || n.classList.contains('parbreak'));
    const br = () => { const c = chip('nl', '\n', ' '); c.dataset.fresh = '1'; return c; };
    nodes = [...(isBreak(around.before) ? [] : [br()]), m, ...(isBreak(around.after) ? [] : [br()])];
  }
  if (insertNodes(nodes)) openDrawer(m, null, display ? 'New displayed equation' : 'New inline maths', true);
}

// The nodes just before and after a collapsed range (empty text skipped).
// ------------------------------------------------- environment marks
//
// \begin{...} and \end{...} show as marks ("Abstract.", "Theorem 1.") or as
// nothing at all.  A deletion that takes one without its partner leaves
// LaTeX that does not build, often with nothing on screen to show it, so a
// deletion keeps such a mark and says so.
const envOf = (n) => n && n.nodeType === 1 && n.classList.contains('chip') && /^\s*\\(begin|end)\s*\{([^}]*)\}/.exec(n.dataset.src || '');
const envName = (n) => { const m = envOf(n); return m && (m[2] === 'abstract' ? 'the abstract' : '\\' + m[1] + '{' + m[2] + '}'); };
// The marks of a range (whole chips only), in order.
function envChipsIn(r) {
  const root = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
  const all = root.classList && root.classList.contains('chip') ? [root] : [...root.querySelectorAll('.chip')];
  return all.filter((c) => envOf(c) && r.intersectsNode(c));
}
// The marks among `nodes` (in order) whose partner is not among them.
function unpairedEnvChips(nodes) {
  const open = [], lone = [];
  for (const n of nodes) {
    const m = envOf(n);
    if (!m) continue;
    if (m[1] === 'begin') { open.push({ env: m[2], n }); continue; }
    let k = open.length - 1;
    while (k >= 0 && open[k].env !== m[2]) k--;
    if (k >= 0) open.splice(k, 1); else lone.push(n);
  }
  const keep = new Set([...lone, ...open.map((o) => o.n)]);
  return nodes.filter((n) => keep.has(n));
}
// Delete a range but keep the marks of `keep` that are in it, where the
// range was (with the line break after a \begin); the range ends collapsed
// after the last kept \begin, so that typed text goes inside it.
function deleteKeeping(r, keep) {
  const mine = [];
  for (const c of envChipsIn(r).filter((x) => keep.has(x))) {
    mine.push(c);
    let n = c.nextSibling;
    while (n && n.nodeType === 3 && !n.data) n = n.nextSibling;
    if (envOf(c)[1] === 'begin' && n && n.nodeType === 1 && n.classList.contains('nl') && r.intersectsNode(n)) mine.push(n);
  }
  mine.forEach((c) => c.remove());
  r.deleteContents();
  if (!mine.length) return;
  const f = document.createDocumentFragment();
  f.append(...mine);
  r.insertNode(f);
  const begins = mine.filter((c) => envOf(c) && envOf(c)[1] === 'begin');
  const last = begins.length ? begins[begins.length - 1] : null;
  if (last) { const n = last.nextSibling; r.setStartAfter(n && n.classList && n.classList.contains('nl') ? n : last); }
  else r.setStartBefore(mine[0]);
  r.collapse(true);
}
function keptToast(keep) {
  if (keep.length) toast(`Kept the start or end of ${[...new Set(keep.map(envName))].join(', ')}: the source view removes a whole environment`);
}
// Delete a range in one block, keeping unpaired marks; true if it kept one.
function deleteKeepingEnvs(r) {
  const keep = unpairedEnvChips(envChipsIn(r));
  deleteKeeping(r, new Set(keep));
  keptToast(keep);
  return keep.length > 0;
}

// ------------------------------------------------- the balance check
//
// An edit the browser makes in a block (Backspace, Delete, typing, typing
// over a selection) must not change the block's balance of { and }, or of
// \begin and \end of any environment, and must not remove \maketitle or
// \documentclass.  Such an edit would leave LaTeX that does not build, or a
// paper without its title, often with nothing on screen to show it, so it
// is undone and a toast names what it removed.
function latexTokens(src) {
  const s = src.replace(/\\verb\*?([^A-Za-z\s]).*?\1/g, '').replace(/\\[\\{}%]/g, '').replace(/%.*$/gm, '');
  const n = { '{': 0, '}': 0 };
  for (const c of s) if (c === '{' || c === '}') n[c]++;
  for (const m of s.matchAll(/\\(begin|end)\s*\{([^}]*)\}|\\(maketitle|documentclass)(?![A-Za-z@])/g)) {
    const k = m[3] ? '\\' + m[3] : '\\' + m[1] + '{' + m[2] + '}';
    n[k] = (n[k] || 0) + 1;
  }
  return n;
}
// What an edit from `before` to `after` broke: the tokens it removed (or,
// if none, added), or null if it broke nothing.
function brokenBalance(before, after) {
  const a = latexTokens(before), b = latexTokens(after);
  const at = (x, k) => x[k] || 0;
  const net = (x, open, close) => at(x, open) - at(x, close);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const envs = [...new Set(keys.filter((k) => /^\\(begin|end)\{/.test(k)).map((k) => k.replace(/^\\(begin|end)/, '')))];
  const broken = net(a, '{', '}') !== net(b, '{', '}') ||
    envs.some((e) => net(a, '\\begin' + e, '\\end' + e) !== net(b, '\\begin' + e, '\\end' + e)) ||
    ['\\maketitle', '\\documentclass'].some((k) => at(b, k) < at(a, k));
  if (!broken) return null;
  const removed = keys.filter((k) => at(b, k) < at(a, k));
  return { removed: removed.length > 0, tokens: removed.length ? removed : keys.filter((k) => at(b, k) > at(a, k)) };
}
// The block's source as it is now, without the house rules.
function blockSource(seg) {
  flushEdits();
  return seg.touched ? segSource(seg, [], null, false) : seg.src;
}
let BALANCE = null;   // the block before the edit under way
doc.addEventListener('beforeinput', (e) => {
  BALANCE = null;
  if (e.defaultPrevented) return;
  const edit = e.target.closest && e.target.closest('#doc [contenteditable=true]');
  const seg = edit && segOf(edit);
  if (!seg || seg.edit !== edit) return;
  BALANCE = { seg, edit, src: blockSource(seg), nodes: [...edit.childNodes].map((n) => n.cloneNode(true)), caret: captureEditorState() };
});
doc.addEventListener('input', (e) => {
  const g = BALANCE;
  BALANCE = null;
  if (!g || !g.edit.isConnected || !(e.target.closest && e.target.closest('#doc [contenteditable=true]') === g.edit)) return;
  const bad = brokenBalance(g.src, blockSource(g.seg));
  if (!bad) return;
  g.edit.replaceChildren(...g.nodes);
  restoreEditorState(g.caret);
  toast(`Undid that edit, which ${bad.removed ? 'removed' : 'added'} ${bad.tokens.join(', ')} on its own. The source view can change it.`);
}, true);

function neighbours(r) {
  const skip = (n, dir) => { while (n && n.nodeType === 3 && !n.data) n = n[dir]; return n; };
  const c = r.startContainer, o = r.startOffset;
  let before, after;
  if (c.nodeType === 3) {
    before = o > 0 ? c : skip(c.previousSibling, 'previousSibling');
    after = o < c.data.length ? c : skip(c.nextSibling, 'nextSibling');
    if (o > 0 && o < c.data.length) return { before: c, after: c, inText: true };
  } else {
    before = skip(c.childNodes[o - 1], 'previousSibling');
    after = skip(c.childNodes[o], 'nextSibling');
  }
  return { before, after };
}

// A footnote at the caret: the selection (if any) becomes its text
function insertFootnote() {
  const r = selectionInOneEditable();
  const text = r ? ser(r.cloneContents()) : '';
  if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  insertLatex('\\footnote{' + text + '}', 'Footnote');
  if (!text) { const ta = $('#drawer-src'); if (ta) { ta.setSelectionRange(10, 10); ta.focus(); } }
}
// A list at the caret, edited in place: the selected lines (or one line of
// placeholder text) become its items
function insertList(env) {
  const r = selRange();
  if (!editableAt(r)) { toast('Put the cursor in the text first', 'error'); return; }
  const one = selectionInOneEditable();
  if (!r.collapsed && !one) { banner('Select text inside one paragraph to make a list of it.'); return; }
  const text = one ? ser(one.cloneContents()).trim() : '';
  if (one) { const s = getSelection(); s.removeAllRanges(); s.addRange(one); }
  const items = (text ? text.split(/\n+|(?<=[.;])\s+/) : ['text']).filter((x) => x.trim());
  // no newline after \end: the line break after it, if any, is already there
  // (a second one would make a blank line, a paragraph break)
  const src = `\n\\begin{${env}}\n` + items.map((x) => '  \\item ' + x.trim()).join('\n') + `\n\\end{${env}}`;
  const frag = document.createDocumentFragment();
  renderTokens(L.tokenize(src), frag, { env: [], lists: [], counters: {}, heads: {} });
  const nodes = [...frag.childNodes];
  if (!insertNodes(nodes)) return;
  // the first item's text is selected, ready to be typed over
  const first = nodes.find((n) => n.nodeType === 1 && n.classList.contains('item'));
  const t = first && first.nextSibling;
  if (t && t.nodeType === 3) {
    const lead = t.data.length - t.data.trimStart().length;
    const end = t.data.indexOf('\n', lead);
    const sel = document.createRange(); sel.setStart(t, lead); sel.setEnd(t, end < 0 ? t.data.length : end);
    const s = getSelection(); s.removeAllRanges(); s.addRange(sel);
  }
}

function insertLatex(src, title) {
  const c = chip('src', src, src);
  // the starting text is an example: selected, so typing replaces it
  if (insertNodes([c])) { openDrawer(c, null, title, true); $('#drawer-src').select(); }
}

// C-d: delete the current line.  M-w: cut the region, or the line.
// C-p: duplicate the region, or the line.  C-+: word, line, paragraph.
// (copy and cut go through the page's own copy and cut, so the clipboard
// gets the LaTeX as well as the text, and a cut across paragraphs joins them)
async function cutRegionOrLine() {
  const s = getSelection();
  if (s.isCollapsed) selectLine();
  if (document.execCommand('cut')) return;
  snapshot();
  killRecord(s.toString());
  try { await navigator.clipboard.writeText(s.toString()); } catch (e) { /* clipboard refused */ }
  deleteKeepingEnvs(selRange());
  markEditedSoon();
}
// C-w: copy the region, or the line
function copyRegionOrLine() {
  const s = getSelection();
  const line = s.isCollapsed;
  if (line) selectLine();
  document.execCommand('copy');
  if (line) s.collapseToEnd();
  toast(line ? 'Line copied' : 'Copied');
}
// C-q: delete the character before the caret
function deleteBackwardChar() { document.execCommand('delete'); }
// C-Backspace: delete back to the previous space (not only the word)
function deleteToSpace() {
  const s = getSelection();
  if (!s.rangeCount) return;
  if (!s.isCollapsed) { document.execCommand('delete'); return; }
  const n = s.focusNode, o = s.focusOffset;
  if (n.nodeType !== 3 || o === 0) { s.modify('extend', 'backward', 'word'); document.execCommand('delete'); return; }
  let i = o;
  while (i > 0 && /\s/.test(n.data[i - 1])) i--;          // the spaces just before, then the word
  while (i > 0 && !/\s/.test(n.data[i - 1])) i--;
  const r = document.createRange(); r.setStart(n, i); r.setEnd(n, o);
  s.removeAllRanges(); s.addRange(r);
  document.execCommand('delete');
}
function deleteLine() { snapshot(); selectLine(); deleteKeepingEnvs(selRange()); markEditedSoon(); }
function duplicate() {
  const s = getSelection();
  if (s.isCollapsed) selectLine();
  snapshot();
  const r = selRange();
  const copy = r.cloneContents();
  const end = r.cloneRange(); end.collapse(false);
  const space = document.createTextNode(s.toString().endsWith(' ') ? '' : ' ');
  end.insertNode(copy);
  end.insertNode(space);
  markEditedSoon();
}
let expandLevel = 0, expandAt = null;
function expandRegion() {
  const s = getSelection();
  const r = selRange();
  const ed = editableAt(r);
  if (!ed) return;
  if (s.isCollapsed || expandAt !== ed) expandLevel = 0;
  expandAt = ed;
  if (expandLevel === 0) { s.modify('move', 'backward', 'word'); s.modify('extend', 'forward', 'word'); }
  else if (expandLevel === 1) selectLine();
  else { const nr = document.createRange(); nr.selectNodeContents(ed); s.removeAllRanges(); s.addRange(nr); }
  expandLevel = Math.min(expandLevel + 1, 2);
}

// C-S-r: find and replace (a regular expression) in the text of the paper.
function replaceAll(find, repl) {
  let re;
  try { re = new RegExp(find, 'g'); } catch (e) { banner('Invalid regular expression: ' + e.message); return; }
  snapshot();
  let count = 0;
  for (const seg of ORDER) {
    if (!seg.edit || seg.edit.tagName === 'TEXTAREA') continue;
    const walker = document.createTreeWalker(seg.edit, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) if (!n.parentElement.closest('.chip')) nodes.push(n);
    for (const t of nodes) {
      const out = t.data.replace(re, () => { count++; return '\u0000'; });
      if (out !== t.data) t.data = t.data.replace(re, repl);
    }
  }
  markEdited();
  banner(`Replaced ${count} occurrence${count === 1 ? '' : 's'} (text only; maths and LaTeX chips are not searched).`);
}
function openReplace() {
  const find = prompt('Replace (regular expression, in the text):');
  if (!find) return;
  const repl = prompt(`Replace /${find}/ with ($1, $2 … for groups):`, '');
  if (repl !== null) replaceAll(find, repl);
}

function keyName(e) {
  return (e.ctrlKey ? 'C-' : '') + (e.altKey ? 'M-' : '') + (e.shiftKey && e.key.length > 1 ? 'S-' : '') +
    (e.key.length === 1 ? e.key : e.key);
}

function closeCurrentMenu() {
  if (mcLeave()) return;
  if (SRC.on && $('#palette').hidden && $('#external').hidden) { toggleSource(false); return; }
  if (!$('#external').hidden) { $('#external-later').click(); return; }
  if (!$('#askbox').hidden) { const c = [...$('#ask-actions').children].pop(); if (c) c.click(); return; }
  if (!$('#openbox').hidden) { $('#open-cancel').click(); return; }
  if (!$('#newbox').hidden) { $('#new-cancel').click(); return; }
  if (!$('#historybox').hidden) { $('#historybox').hidden = true; return; }
  if (!$('#filesbox').hidden) { closeFiles(); return; }
  if (!$('#palette').hidden) { closePalette(); return; }
  if (!$('#keysbox').hidden) { RECORDING = null; $('#keysbox').hidden = true; return; }
  if (!$('#paperbox').hidden) { $('#md-close').click(); return; }
  if (!$('#figview').hidden) { closeFigure(); return; }
  if (!$('#drawer').hidden) { closeDrawer(); return; }
  if (!$('#findbar').hidden) { closeFind(); return; }
  if (!$('#helpbox').hidden) { $('#helpbox').hidden = true; return; }
  if (!$('#menu').hidden) { $('#menu').hidden = true; return; }
  if (!$('#banner').hidden) { $('#banner').hidden = true; clearTimeout(banner.t); }
}

// Bindings available anywhere on the page.
const GLOBAL_KEYS = {
  'C-s': save, 'C-S': save,
  'C-z': undo, 'C-Z': redo, 'C-y': redo,
  'M-r': () => TTS.play(), 'M-R': () => TTS.play(),
  'M-p': () => TTS.pause(), 'M-P': () => TTS.pause(), 'M-s': () => TTS.stop(), 'M-S': () => TTS.stop(),
  'C-M-ArrowLeft': () => TTS.prev(), 'C-M-ArrowRight': () => TTS.next(),
  'Escape': closeCurrentMenu,
};
// Bindings in the text of the source view (filled from ACTION_DEFS).
const SOURCE_KEYS = {};
// Bindings inside the text of the paper.
const TEXT_KEYS = {
  'C-b': () => wrap('\\textbf{', 'strong'),
  'C-i': () => wrap('\\emph{', 'em'),
  'C-I': () => wrap('\\textit{', 'em'),
  'C-m': mathAtSelection, 'C-M': () => insertMath(true),
  'C-\\': () => insertLatex('\\cref{}', 'Insert LaTeX'),
  'C-M-r': () => insertLatex('\\cref{}', 'Insert a reference'),
  'C-M-c': () => insertLatex('\\cite{}', 'Insert a citation'),
  'C-M-1': () => headingAtCaret('section'),
  'C-M-2': () => headingAtCaret('subsection'),
  'C-M-3': () => headingAtCaret('paragraph'),
  'C-a': () => getSelection().modify('move', 'backward', 'lineboundary'),
  'C-e': () => getSelection().modify('move', 'forward', 'lineboundary'),
  'C-A': () => getSelection().modify('extend', 'backward', 'lineboundary'),
  'C-E': () => getSelection().modify('extend', 'forward', 'lineboundary'),
  'C-d': deleteLine,
  'M-w': cutRegionOrLine,
  'C-p': duplicate,
  'C-+': expandRegion, 'C-=': expandRegion,
  'C-R': openReplace,
};

document.addEventListener('keydown', (e) => {
  const k = keyName(e);
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.closest('.seg');
  const inSourceText = SRC.on && e.target.id === 'srcta' && GLOBAL_KEYS[k] && GLOBAL_KEYS[k].inSource;
  if (inField && !inSourceText && !['C-s', 'C-S', 'C-f', 'Escape'].includes(k) && !(GLOBAL_KEYS[k] && GLOBAL_KEYS[k].cancels)) {
    // the source view's text keeps its own keys too, but switches back
    if (SRC.on && e.target.id === 'srcta' && (USER_KEYS.source || ['C-M-e']).includes(k)) { e.preventDefault(); toggleSource(false); }
    // and opens the file in the user's own editor
    if (SRC.on && e.target.id === 'srcta' && (USER_KEYS.external || ['C-M-z']).includes(k)) { e.preventDefault(); openExternalHere(); }
    return;
  }
  if (SRC.on && k === 'C-f') return;   // the browser's own find, in the source text
  // the figure viewer and the drawer keep their arrows (Alt+Up moves a game statement)
  if (GLOBAL_KEYS[k] && /Arrow|Page/.test(k) && e.target.closest && e.target.closest('#figview, #drawer, #palette')) return;
  if (GLOBAL_KEYS[k]) { e.preventDefault(); GLOBAL_KEYS[k](); return; }
  if (e.target.tagName === 'TEXTAREA' && CODE_KEYS[k] && e.target.closest('#doc .seg')) { e.preventDefault(); CODE_KEYS[k](); return; }
  const inText = e.target.isContentEditable && segOf(e.target);
  if (!inText) return;
  const sel = getSelection();
  if (spansEditables() && ((e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) ||
      ['Enter', 'Backspace', 'Delete', 'Tab'].includes(e.key))) {
    e.preventDefault();
    // across blocks: they are joined, then the key does what it does at the caret
    if (e.key === 'Tab' || e.key === '$' || WRAP_PAIRS[e.key] || !acrossParts()) { banner(ACROSS); return; }
    if (!deleteAcross()) return;
    if (e.key.length === 1) document.execCommand('insertText', false, e.key);
    else if (e.key === 'Enter') insertBreak();
    return;
  }
  // a bracket or quote typed over a selection wraps it instead of replacing it
  if (WRAP_PAIRS[e.key] && !e.ctrlKey && !e.altKey && !e.metaKey && !getSelection().isCollapsed) {
    e.preventDefault();
    if (!wrapLiteral(...WRAP_PAIRS[e.key])) banner('Select text inside one paragraph to wrap it.');
    return;
  }
  // $ typed over a selection makes it maths; typed at the caret, it closes
  // a formula opened with an earlier $ (otherwise it types a dollar sign; a
  // new formula is Ctrl+M)
  if (e.key === '$' && !e.ctrlKey && !e.altKey && !e.metaKey && !TEXT_KEYS[k]) {
    if (!getSelection().isCollapsed) { e.preventDefault(); mathAtSelection(); return; }
    if (closeMathAtCaret()) e.preventDefault();
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && ((e.key === 'Backspace' && paperPairBackspace()) || (e.key.length === 1 && paperPair(e.key)))) { e.preventDefault(); return; }
  if (TEXT_KEYS[k]) { e.preventDefault(); TEXT_KEYS[k](); return; }
  // the browser's own bold, italic, underline would bypass the editor (and
  // keep working after the shortcut is moved to another key)
  if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[biu]$/i.test(e.key)) { e.preventDefault(); return; }
  const seg = segOf(e.target);
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (seg.kind === 'para' || seg.kind === 'quote') insertBreak();
    // Enter in a heading goes on to the section's text: the start of the
    // paragraph after it, or, when none follows (a new section), a new one.
    // (It used to do nothing, and what came next was typed into the heading.)
    else if (seg.kind === 'heading') {
      const i = ORDER.indexOf(seg);
      const next = ORDER.slice(i + 1).find((x) => x.kind !== 'gap' && x.kind !== 'hidden');
      if (next && (next.kind === 'para' || next.kind === 'quote') && next.edit && next.file === seg.file) {
        const r = document.createRange(); r.setStart(next.edit, 0); r.collapse(true);
        next.edit.focus(); const sel2 = getSelection(); sel2.removeAllRanges(); sel2.addRange(r);
      } else structural(() => { insertAfter(seg, PLACEHOLDER); return PLACEHOLDER; });
    }
    return;
  }
  if (e.key === 'Backspace' && !e.ctrlKey && seg.kind === 'para' && caretAtStart(seg.edit)) {
    snapshot();
    if (joinWithPrevious(seg)) { e.preventDefault(); return; }
  }
  // Backspace or Delete next to a paragraph or line break takes the break
  // (the browser does not delete these empty, non-editable marks)
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && sel.rangeCount && sel.isCollapsed) {
    const nb = neighbours(sel.getRangeAt(0));
    const n = e.key === 'Backspace' ? nb.before : nb.after;
    if (!nb.inText && n && n.nodeType === 1 && n.classList.contains('chip') &&
        (n.classList.contains('parbreak') || n.classList.contains('nl') || n.classList.contains('tie'))) {
      e.preventDefault();
      // the line break after \begin{abstract} (or before an \end) shows
      // nothing: taking it would change nothing on screen, and the next
      // Backspace would take the \begin itself
      let m = e.key === 'Backspace' ? n.previousSibling : n.nextSibling;
      while (m && m.nodeType === 3 && !m.data) m = e.key === 'Backspace' ? m.previousSibling : m.nextSibling;
      if (envOf(m)) { toast(`${e.key} stops at the ${envOf(m)[1] === 'begin' ? 'start' : 'end'} of ${envName(m)}`); return; }
      snapshot();
      const r = document.createRange(); r.setStartBefore(n); r.collapse(true);
      n.remove();
      sel.removeAllRanges(); sel.addRange(r);
      markEditedSoon();
    }
  }
});

// Keys that only work while their own dialog is open: the choices of the
// outside-change bar, Enter in the open dialog, the figure viewer's tabs.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || e.target.closest('input, textarea, select')) return;
  if (!$('#external').hidden && e.key.length === 1 && 'mrobl'.includes(e.key)) {
    e.preventDefault();
    ({ m: $('#external-merge'), r: $('#external-reload'), o: $('#external-overwrite'), b: $('#external-backup'), l: $('#external-later') })[e.key].click();
  } else if (!$('#openbox').hidden && /^[1-9]$/.test(e.key) && document.querySelectorAll('#open-recent .open-paper')[+e.key - 1]) {
    // like an editor's start page: the number of a recent paper opens it
    e.preventDefault(); document.querySelectorAll('#open-recent .open-paper')[+e.key - 1].click();
  } else if (!$('#openbox').hidden && e.key === 'Delete' && e.target.closest('#open-recent .open-row')) {
    // the focused recent paper comes off the list (not the one open now)
    const x = e.target.closest('.open-row').querySelector('.open-forget');
    e.preventDefault();
    if (x) x.click();
  } else if (!$('#openbox').hidden && e.key === 'Enter' && !e.target.closest('button') && !$('#open-mainrow').hidden) {
    // (Enter on a button presses that button: a recent paper, a folder)
    e.preventDefault(); $('#open-confirm').click();
  } else if (!$('#figview').hidden && /^[1-6]$/.test(e.key)) {
    // only the tabs on show count (the Games and Cells tabs hide when not used)
    const tabs = [...document.querySelectorAll('#figview .fv-tabs button')].filter((b) => b.getBoundingClientRect().width > 0);
    if (tabs[+e.key - 1]) { e.preventDefault(); tabs[+e.key - 1].click(); }
  }
}, true);

// ============================================================== palette
//
// A search dialog shared by citations and references.  The caret position
// is saved when it opens and restored before the pick is inserted.

const PAL = { items: [], active: 0, savedRange: null, opts: null, picked: [], timer: null, seq: 0 };

function openPalette(opts) {
  const r = selRange();
  PAL.savedRange = editableAt(r) ? r.cloneRange() : null;
  if (!PAL.savedRange && !opts.anywhere) { banner('Put the cursor in the text first.'); return; }
  PAL.opts = opts; PAL.picked = []; PAL.items = []; PAL.active = 0;
  $('#pal-title').textContent = opts.title;
  $('#pal-tray').textContent = '';
  const q = $('#pal-q');
  q.placeholder = opts.placeholder;
  q.value = opts.initial || '';
  $('#pal-foot').textContent = '';
  if (opts.footer) opts.footer($('#pal-foot'));
  $('#palette').hidden = false;
  q.focus();
  refreshPalette();
}

function closePalette() {
  $('#palette').hidden = true; PAL.opts = null; PAL.busy = false;
  for (const p of ['top', 'left', 'transform']) $('#palette').style[p] = '';   // (placed at a word by the spelling list)
  MC.hold = false;
  clearTimeout(PAL.timer);
  if (PAL.abort) { PAL.abort.abort(); PAL.abort = null; }
}

function refreshPalette() {
  PAL.busy = true;              // until the results for this query are shown
  clearTimeout(PAL.timer);
  PAL.timer = setTimeout(async () => {
    if (!PAL.opts) return;      // closed before the search ran
    const seq = ++PAL.seq;
    // a newer search makes the one still on its way useless: drop it
    if (PAL.abort) PAL.abort.abort();
    const abort = PAL.abort = new AbortController();
    let items;
    try { items = await PAL.opts.search($('#pal-q').value, abort.signal); }
    catch (e) {
      if (e.name === 'AbortError') return;
      if (seq === PAL.seq) banner('Search failed: ' + e.message);
      items = [];
    }
    if (seq !== PAL.seq || !PAL.opts) return;
    PAL.items = items; PAL.active = 0; PAL.busy = false;
    drawPalette();
  }, PAL.opts && PAL.opts.delay !== undefined ? PAL.opts.delay : 120);
}

function drawPalette() {
  const list = $('#pal-list');
  list.textContent = '';
  if (!PAL.items.length) list.append(el('div', 'pal-empty', PAL.opts.empty || 'Nothing found.'));
  PAL.items.forEach((it, i) => {
    const row = el('div', 'pal-item' + (i === PAL.active ? ' active' : ''));
    const v = PAL.opts.view(it);
    for (const b of v.badges || []) row.append(el('span', 'badge ' + (b.cls || ''), b.text));
    const main = el('div', 'main');
    main.innerHTML = v.main;
    row.append(main, el('div', 'sub', v.sub || ''));
    row.onmousedown = (e) => { e.preventDefault(); PAL.active = i; choose(e.ctrlKey || e.metaKey); };
    list.append(row);
  });
  const act = list.children[PAL.active];
  if (act) act.scrollIntoView({ block: 'nearest' });
}

async function choose(keepOpen) {
  // Enter typed right after the query: wait for its results, not the old ones
  for (let t = 0; PAL.busy && t < 100; t++) await new Promise((r) => setTimeout(r, 50));
  if (!PAL.opts) return;
  const it = PAL.items[PAL.active];
  if (!it) return;
  await PAL.opts.pick(it, keepOpen);
}

// Insert source at the caret saved when the palette opened.
function insertAtSaved(src) {
  const s = getSelection();
  s.removeAllRanges(); s.addRange(PAL.savedRange);
  const host = editableAt(PAL.savedRange);
  if (host) host.focus();
  s.removeAllRanges(); s.addRange(PAL.savedRange);
  // a reference or citation is separated from the word before it; the house
  // rules turn "word \cite" into "word~\cite" when saving
  const r = PAL.savedRange;
  let prev = '';
  if (r.startContainer.nodeType === 3) prev = r.startContainer.data[r.startOffset - 1] || '';
  else { const n = r.startContainer.childNodes[r.startOffset - 1]; prev = n ? (n.textContent || ' ').slice(-1) : ''; }
  if (prev && !/[\s\u00a0(]/.test(prev)) src = ' ' + src;
  const frag = document.createDocumentFragment();
  renderTokens(L.tokenize(src), frag, {});
  const nodes = [...frag.childNodes];
  insertNodes(nodes);
}

$('#pal-q').addEventListener('input', refreshPalette);
$('#pal-q').addEventListener('keydown', (e) => {
  if (PAL.opts && PAL.opts.onKey && PAL.opts.onKey(e)) { e.preventDefault(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); PAL.active = Math.min(PAL.active + 1, PAL.items.length - 1); drawPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); PAL.active = Math.max(PAL.active - 1, 0); drawPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(e.ctrlKey || e.metaKey); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
document.addEventListener('mousedown', (e) => { if (!$('#palette').hidden && !$('#palette').contains(e.target)) closePalette(); });

const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cleanTex = (t) => String(t || '').replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}$~]/g, '');

// ---------------------------------------------------------------- cite

function citePalette() {
  let online = false;
  let noteInput = null;
  const tray = () => {
    const t = $('#pal-tray');
    t.textContent = PAL.picked.length ? 'picked:' : '';
    PAL.picked.forEach((k) => {
      const chipEl = el('span', 'key', k);
      const x = el('button', 'unpick', '×'); x.title = 'Remove ' + k; x.setAttribute('aria-label', 'Remove ' + k);
      x.onmousedown = (e) => { e.preventDefault(); PAL.picked = PAL.picked.filter((y) => y !== k); tray(); };
      chipEl.append(x); t.append(chipEl);
    });
  };
  const finish = () => {
    if (!PAL.picked.length) return;
    // \cite[note]{keys}: a note with ] in it is braced
    const note = noteInput ? noteInput.value.trim() : '';
    const opt = note ? '[' + (note.includes(']') ? '{' + note + '}' : note) + ']' : '';
    const src = '\\cite' + opt + '{' + PAL.picked.join(',') + '}';
    const saved = PAL.savedRange;
    closePalette();
    PAL.savedRange = saved;
    insertAtSaved(src);
  };
  const pickKey = (key, keepOpen) => {
    if (!PAL.picked.includes(key)) PAL.picked.push(key);
    tray();
    if (keepOpen) { $('#pal-q').select(); return; }
    finish();
  };
  openPalette({
    title: 'Cite',
    placeholder: 'Key, title words, authors or year: e.g. "goldwasser micali", "probabilistic encryption 84"',
    empty: 'Nothing in references.bib or cryptobib. Press Search online.',
    search: async (q, signal) => {
      if (!q.trim()) return [];
      if (online) {
        const r = await fetch('/api/online?q=' + encodeURIComponent(q), { signal });
        const res = await r.json().catch(() => ({ error: 'the online search failed (' + r.status + ')' }));
        if (!r.ok) { banner(res.error || 'the online search failed'); return []; }
        return res.map((h) => ({ ...h, online: true }));
      }
      const r = await fetch('/api/bib?q=' + encodeURIComponent(q), { signal });
      if (!r.ok) { banner('The bibliography search failed (' + r.status + '); see the server output.'); return []; }
      return r.json();
    },
    delay: 150,
    view: (it) => it.online ? {
      main: (it.have ? `<code>${escHtml(it.have)}</code> (already in your bibliography)` : `<code>${escHtml(it.key)}</code> (new)`) + ' ' + escHtml(cleanTex(it.title)),
      sub: `${it.authors} · ${it.venue} ${it.year} · ${it.source === 'arxiv' ? 'arXiv ' : 'doi:'}${it.id}`,
      badges: [{ text: it.source }],
    } : {
      main: `<code>${escHtml(it.key)}</code> ${escHtml(cleanTex(it.title))}`,
      sub: `${cleanTex(it.authors)}${it.year ? ' · ' + it.year : ''}`,
      badges: [it.cited ? { text: 'cited', cls: 'cited' } : null,
        { text: it.source === 'references.bib' ? 'references.bib' : 'cryptobib' }].filter(Boolean),
    },
    pick: async (it, keepOpen) => {
      if (!it.online) return pickKey(it.key, keepOpen);
      if (it.have) return pickKey(it.have, keepOpen);
      const key = prompt(`Add this entry to references.bib under the key:\n\n${cleanTex(it.title)}`, it.key);
      if (!key) return;
      const r = await fetch('/api/bibadd', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
        body: JSON.stringify({ source: it.source, id: it.id, key }) });
      const res = await r.json();
      if (!r.ok) { banner('Could not add: ' + res.error); return; }
      banner(`Added ${key} to references.bib. Its number appears after the next build.`);
      pickKey(key, keepOpen);
    },
    footer: (f) => {
      // optional note: \cite[\S 4.2]{key}; Enter here inserts (the highlighted entry if none is picked)
      const nl = el('label', 'pal-note', 'Note ');
      noteInput = el('input'); noteInput.id = 'pal-note'; noteInput.spellcheck = false; noteInput.autocomplete = 'off';
      noteInput.placeholder = 'optional, e.g. \\S 4.2 or p.~7';
      noteInput.title = 'Goes in \\cite[…]{…}: a section, page or theorem';
      noteInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        for (let t = 0; PAL.busy && t < 100; t++) await new Promise((r) => setTimeout(r, 50));
        if (!PAL.picked.length && PAL.items[PAL.active]) await PAL.opts.pick(PAL.items[PAL.active], true);
        finish();
      });
      nl.append(noteInput);
      f.append(nl, '↑↓ choose · Enter insert · Ctrl+Enter add to picked · ');
      const b = el('button', '', 'Search online (Crossref, arXiv)');
      b.onmousedown = (e) => {
        e.preventDefault();
        online = !online;
        b.textContent = online ? 'Back to local search' : 'Search online (Crossref, arXiv)';
        PAL.opts.delay = online ? 600 : 150;
        refreshPalette();
        $('#pal-q').focus();
      };
      const done = el('button', '', 'Insert picked');
      done.onmousedown = (e) => { e.preventDefault(); finish(); };
      f.append(b, done);
    },
  });
}

// ----------------------------------------------------------------- refs

// Every \label in the paper, with its number, type and a description.
function collectLabels() {
  const out = [];
  for (const seg of ORDER) {
    if (!seg.src || seg.removed) continue;
    for (const m of seg.src.matchAll(/\\label\{([^}]+)\}/g)) {
      const key = m[1];
      const l = DOC.aux.labels[key] || {};
      let text = '';
      if (seg.edit && seg.edit.tagName !== 'TEXTAREA') text = seg.edit.textContent;
      const before = seg.src.slice(0, m.index);
      const inMath = (before.match(/\\begin\{(align|equation|gather|multline)\*?\}/g) || []).length >
        (before.match(/\\end\{(align|equation|gather|multline)\*?\}/g) || []).length || /\\\[[^\]]*$/.test(before);
      if (inMath) {
        const eq = seg.src.slice(m.index - 200 < 0 ? 0 : m.index - 200, m.index + 60);
        text = cleanTex(eq).replace(/\s+/g, ' ').trim().slice(-140);
      } else if (seg.kind === 'para') {
        const env = /\\begin\{(\w+)\}(\[([^\]]*)\])?\s*$/.exec(before);
        text = (env && env[3] ? env[3] + ': ' : '') + text.replace(/\s+/g, ' ').trim();
      }
      const type = l.type || (key.split(':')[0]);
      const name = key.startsWith('app:') ? 'Appendix' : (TYPE_NAMES[type] || (type === 'equation' ? 'Eq.' : type));
      out.push({ key, num: l.v || '?', type, name, text: text.replace(/\s+/g, ' ').trim().slice(0, 160) });
    }
  }
  return out;
}

function refPalette() {
  const labels = collectLabels();
  let cmd = 'cref';
  openPalette({
    title: 'Reference',
    placeholder: 'Number, type, title or caption words: e.g. "fig 3", "lemma same", "games", "eq"',
    delay: 0,
    search: async (q) => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return labels.filter((l) => {
        const hay = `${l.name} ${l.num} ${l.key} ${l.text}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    },
    view: (l) => ({ main: `${escHtml(l.name)} ${escHtml(l.num)} <code>${escHtml(l.key)}</code>`, sub: l.text,
      badges: [{ text: l.type }] }),
    pick: async (l) => {
      const c = l.type === 'equation' && cmd === 'cref' ? 'eqref' : cmd;
      const saved = PAL.savedRange;
      closePalette();
      PAL.savedRange = saved;
      insertAtSaved(`\\${c}{${l.key}}`);
    },
    footer: (f) => {
      f.append('Insert as: ');
      for (const c of ['cref', 'Cref', 'ref', 'eqref']) {
        const lab = el('label');
        const r = el('input'); r.type = 'radio'; r.name = 'refcmd'; r.checked = c === cmd;
        r.onchange = () => { cmd = c; $('#pal-q').focus(); };
        lab.append(r, ' \\' + c + ' ');
        f.append(lab);
      }
      f.append(' (equations use \\eqref with \\cref)');
    },
  });
}

// ---------------------------------------------------------- find/replace

const FIND = { matches: [], ctx: [], cur: -1, listNav: false, listFor: null };

// ---- maths in a search ("hello $x$")
//
// With the $x$ toggle on, a formula takes part in the searchable text as
// \u0001 its LaTeX \u0002 (spaces dropped, {x} written as x), and the query
// is read as text and $…$ parts: text matches text only, $x$ a formula with
// the token x (not \max or \exp), $=x$ a formula that is x, $$ any formula.
const findLiteral = () => $('#find-lit').checked && !$('#find-re').checked;
function normMath(s) {
  s = s.replace(/\{(\\[A-Za-z]+|[A-Za-z0-9])\}/g, ' $1 ');
  return s.replace(/\s+/g, (m, off) => (/\\[A-Za-z]+$/.test(s.slice(0, off)) && /^[A-Za-z]/.test(s.slice(off + m.length)) ? ' ' : '')).trim();
}
// the LaTeX of a formula chip, without its delimiters (an environment's too)
function searchMathBody(src) {
  const t = (src || '').trim();
  let m;
  if ((m = /^\$\$([\s\S]*)\$\$$/.exec(t)) || (m = /^\$([\s\S]*)\$$/.exec(t)) || (m = /^\\\(([\s\S]*)\\\)$/.exec(t)) || (m = /^\\\[([\s\S]*)\\\]$/.exec(t))) return m[1];
  if ((m = /^\\begin\{([^}]*)\}([\s\S]*)\\end\{\1\}$/.exec(t))) return m[2];
  return t;
}
// The query in text and maths parts: [{math: false, s}, {math: true, s}]
function findParts(q) {
  const parts = [];
  const re = /\$([^$]*)\$/g;
  let i = 0, m;
  while ((m = re.exec(q))) {
    if (m.index > i) parts.push({ math: false, s: q.slice(i, m.index) });
    parts.push({ math: true, s: m[1] });
    i = m.index + m[0].length;
  }
  if (i < q.length) parts.push({ math: false, s: q.slice(i) });
  return parts;
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function literalRegex(q) {
  const word = $('#find-word').checked;
  const src = findParts(q).map((p, i, all) => {
    if (!p.math) {
      let t = p.s;
      const lead = /^\s/.test(t) && i > 0, trail = /\s$/.test(t) && i < all.length - 1;
      t = t.trim();
      if (!t) return '\\s*';
      // without Aa, a letter of the text matches either case (the maths are exact)
      const cased = (w) => ($('#find-case').checked ? escRe(w) : escRe(w).replace(/\p{L}/gu, (c) => (c.toLowerCase() === c.toUpperCase() ? c : `[${c.toLowerCase()}${c.toUpperCase()}]`)));
      let r = t.split(/\s+/).map(cased).join('\\s+');
      if (word) r = '\\b' + r + '\\b';
      return (lead ? '\\s*' : '') + r + (trail ? '\\s*' : '');
    }
    const body = p.s.trim();
    if (!body) return '\u0001[^\u0002]*\u0002';
    if (body.startsWith('=')) return '\u0001' + escRe(normMath(body.slice(1))) + '\u0002';
    const n = normMath(body);
    return '\u0001[^\u0002]*?' + (/^[A-Za-z]/.test(n) ? '(?<![A-Za-z])' : '') + escRe(n) + (/[A-Za-z]$/.test(n) ? '(?![A-Za-z])' : '') + '[^\u0002]*\u0002';
  }).join('');
  try { return new RegExp(src, 'gu'); } catch (e) { return null; }
}

function findRegex() {
  const q = $('#find-q').value;
  if (!q) return null;
  if (findLiteral()) return literalRegex(q);
  let src = $('#find-re').checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if ($('#find-word').checked) src = '\\b(?:' + src + ')\\b';
  try { return new RegExp(src, $('#find-case').checked ? 'g' : 'gi'); } catch (e) { return null; }
}

// The searchable text of each block: its text nodes, with a tie (~) and a
// line break counted as a space, so that a match may cross them.
function searchMaps() {
  const maps = [];
  const lit = findLiteral();
  for (const seg of ORDER) {
    if (!seg.edit || seg.edit.tagName === 'TEXTAREA' || seg.removed) continue;
    const parts = [];
    let text = '';
    const w = document.createTreeWalker(seg.edit, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => n.nodeType === 1
        ? (n.classList.contains('chip') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
        : NodeFilter.FILTER_ACCEPT });
    // walk children in order, treating tie/nl chips as a space and other chips as a barrier
    const visit = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { parts.push({ start: text.length, node: n }); text += n.data; }
        else if (n.nodeType === 1 && n.classList.contains('chip')) {
          if (n.classList.contains('tie') || n.classList.contains('nl')) { parts.push({ start: text.length, chip: n }); text += ' '; }
          else if (lit && n.classList.contains('math')) { parts.push({ start: text.length, chip: n }); text += '\u0001' + normMath(searchMathBody(n.dataset.src)) + '\u0002'; }
          else { parts.push({ start: text.length, chip: n }); text += '\u0000'; }
        } else if (n.nodeType === 1) visit(n);
      }
    };
    visit(seg.edit);
    void w;
    maps.push({ text, parts });
  }
  return maps;
}

function posAt(map, off, end) {
  // the DOM position of text offset off (end: the end of a range)
  for (let i = map.parts.length - 1; i >= 0; i--) {
    const p = map.parts[i];
    if (p.start <= off - (end ? 1 : 0) || (p.start === off && !end)) {
      if (p.node) return [p.node, Math.min(off - p.start, p.node.data.length)];
      return end ? ['after', p.chip] : ['before', p.chip];
    }
  }
  return null;
}

// html's scroll-padding keeps the caret clear of the sticky bars. A field in
// those bars is always on screen, yet Chrome "reveals" it below the padding
// on every keystroke, so typing in Find crept the page up to the top. While
// focus is in the bars, the padding is off.
const IN_BARS = '#chrome, #bar, #toolbar, #findbar';
document.addEventListener('focusin', (e) => {
  document.documentElement.style.scrollPaddingTop = e.target.closest && e.target.closest(IN_BARS) ? '0px' : '';
});

// a piece of the searchable text as a person reads it
const readable = (t) => t.replace(/\u0001([^\u0001\u0002]*)\u0002/g, '$$$1$$').replace(/[\u0001\u0002]/g, '').replace(/\u0000/g, '…');
function runFind(keepIndex) {
  const re = findRegex();
  FIND.matches = [];
  FIND.ctx = [];
  if (re) {
    for (const map of searchMaps()) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(map.text))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        if (m[0].includes('\u0000')) continue;          // never across maths or LaTeX
        const a = posAt(map, m.index, false), b = posAt(map, m.index + m[0].length, true);
        if (!a || !b) continue;
        const r = document.createRange();
        if (a[0] === 'before') r.setStartBefore(a[1]); else if (a[0] === 'after') r.setStartAfter(a[1]); else r.setStart(a[0], a[1]);
        if (b[0] === 'after') r.setEndAfter(b[1]); else if (b[0] === 'before') r.setEndBefore(b[1]); else r.setEnd(b[0], b[1]);
        FIND.matches.push(r);
        FIND.ctx.push([map.text.slice(Math.max(0, m.index - 40), m.index), m[0], map.text.slice(m.index + m[0].length, m.index + m[0].length + 60)].map(readable));
      }
    }
  }
  if (!keepIndex || FIND.cur >= FIND.matches.length) FIND.cur = FIND.matches.length ? firstVisibleMatch() : -1;
  paintFind();
}

function firstVisibleMatch() {
  const i = FIND.matches.findIndex((r) => r.getBoundingClientRect().top > 100);
  return i < 0 ? 0 : i;
}

// one row per match with the text around it; the row of the current match
// is marked, and the page follows the arrows
function drawFindList() {
  const list = $('#find-list');
  list.textContent = '';
  list.hidden = !FIND.matches.length || !$('#find-q').value;
  FIND.ctx.slice(0, 300).forEach(([pre, hit, post], i) => {
    const row = el('div', 'find-row');
    row.setAttribute('role', 'option');
    const mk = el('mark', '', hit);
    row.append(pre, mk, post);
    row.onmousedown = (e) => { e.preventDefault(); FIND.cur = i; stayAtMatch(); };
    list.append(row);
  });
}
function paintFind(scroll) {
  if (FIND.listFor !== FIND.matches) { FIND.listFor = FIND.matches; drawFindList(); }
  [...$('#find-list').children].forEach((row, i) => row.classList.toggle('sel', i === FIND.cur));
  const selRow = $('#find-list').children[FIND.cur];
  if (selRow) selRow.scrollIntoView({ block: 'nearest' });
  const n = FIND.matches.length;
  $('#find-count').textContent = $('#find-q').value ? (n ? `${FIND.cur + 1} of ${n}` : 'no match') : '';
  if (!(window.CSS && CSS.highlights)) return;
  CSS.highlights.set('find', new Highlight(...FIND.matches));
  if (FIND.cur >= 0 && FIND.matches[FIND.cur]) {
    const r = FIND.matches[FIND.cur];
    CSS.highlights.set('findcur', new Highlight(r));
    if (scroll) revealRange(r, false);
  } else CSS.highlights.delete('findcur');
}

function stepFind(d) {
  if (!FIND.matches.length) return;
  FIND.cur = (FIND.cur + d + FIND.matches.length) % FIND.matches.length;
  navPush();
  paintFind(true);
}

function replacement(matchText) {
  const re = findRegex();
  const r = $('#find-r').value;
  if (!$('#find-re').checked) return r;
  re.lastIndex = 0;
  return matchText.replace(re, r);
}

function replaceOne() {
  const r = FIND.matches[FIND.cur];
  if (!r) { toast('No match to replace'); return; }
  snapshot();
  replaceRange(r);
  markEditedSoon();
  runFind(true);
  paintFind(true);
  toast(`Replaced 1 · ${FIND.matches.length} match${FIND.matches.length === 1 ? '' : 'es'} left (Ctrl+Z undoes)`);
}

function replaceAllMatches() {
  if (!FIND.matches.length) { toast('No match to replace'); return; }
  snapshot();
  const n = FIND.matches.length;
  // last to first, so earlier ranges stay valid
  for (const r of [...FIND.matches].reverse()) replaceRange(r);
  markEdited();
  runFind();
  toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'} (Ctrl+Z undoes)`, 'ok');
}

function replaceRange(r) {
  if (findLiteral()) {
    // text stays text, and $…$ becomes a formula
    const frag = document.createDocumentFragment();
    for (const p of findParts($('#find-r').value)) frag.append(p.math ? mathChip('$' + p.s + '$', false) : document.createTextNode(p.s));
    r.deleteContents();
    r.insertNode(frag);
    return;
  }
  const text = r.toString().replace(/\u00a0/g, ' ');
  const rep = document.createTextNode(replacement(text));
  r.deleteContents();
  r.insertNode(rep);
}

function openFind(focusReplace) {
  $('#findbar').hidden = false;
  const sel = getSelection().toString();
  if (sel && !sel.includes('\n') && sel.length < 80) $('#find-q').value = sel;
  (focusReplace ? $('#find-r') : $('#find-q')).focus();
  $('#find-q').select();
  runFind();
}
function closeFind() {
  $('#findbar').hidden = true;
  FIND.listNav = false;
  if (window.CSS && CSS.highlights) { CSS.highlights.delete('find'); CSS.highlights.delete('findcur'); }
}

for (const id of ['#find-q', '#find-re', '#find-case', '#find-word', '#find-lit']) $(id).addEventListener('input', () => { FIND.listNav = false; runFind(); });
// Ctrl+Shift+F: the lines of every .tex and .bib file of the paper that hold
// all the words of the query (in any order), by file and line; a pick opens
// the source view there.
async function sourceSearch() {
  commit();
  const texts = Object.fromEntries(Object.entries(FILES).filter(([, f]) => typeof f.text === 'string').map(([n, f]) => [n, f.text]));
  for (const [n, f] of Object.entries((SRC && SRC.extra) || {})) if (typeof f.text === 'string') texts[n] = f.text;
  try {
    const list = await (await fetch('/api/srcfiles')).json();
    for (const f of Array.isArray(list) ? list : []) {
      const n = f.name;
      if (texts[n] !== undefined || !/\.(tex|bib)$/.test(n)) continue;
      const r = await fetch('/api/srcfile?name=' + encodeURIComponent(n)).catch(() => null);
      const d = r && r.ok ? await r.json() : null;
      if (d && typeof d.text === 'string') texts[n] = d.text;
    }
  } catch (e) { /* the paper's own files are enough */ }
  const lines = Object.entries(texts).flatMap(([file, t]) => t.split('\n').map((text, i) => ({ file, line: i + 1, text, low: text.toLowerCase() })));
  openPalette({
    title: 'Find in the source',
    placeholder: 'Words of one line, in any order (in every .tex and .bib file)',
    anywhere: true,
    delay: 60,
    empty: 'No line holds all these words.',
    search: async (q) => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const out = [];
      for (const l of lines) { if (words.every((w) => l.low.includes(w))) { out.push(l); if (out.length >= 300) break; } }
      return out;
    },
    view: (l) => ({ main: `<code>${escHtml(l.file)}:${l.line}</code>`, sub: l.text.trim().slice(0, 200) }),
    pick: async (l) => {
      closePalette();
      if (!SRC.on) await toggleSource(true);
      await openSourceFile(l.file, l.line);
    },
  });
}

// The current match becomes the selection in the text, and the bar closes.
function stayAtMatch() {
  const r = FIND.matches[FIND.cur];
  if (!r) return;
  navPush();
  closeFind();
  const host = hostOf(r.startContainer);
  if (host) host.focus({ preventScroll: true });
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r.cloneRange());
  revealRange(r, false);
}
// a $ in the query turns maths on (unless it is a regular expression)
$('#find-q').addEventListener('input', () => { if ($('#find-q').value.includes('$') && !$('#find-re').checked && !$('#find-lit').checked) { $('#find-lit').checked = true; runFind(); } }, true);
for (const id of ['#find-q', '#find-r']) {
  $(id).addEventListener('keydown', (e) => {
    // the arrows move through the list and the page follows; Enter after
    // them stays at that match (closes the bar, selects it)
    if (id === '#find-q' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && FIND.matches.length) {
      e.preventDefault();
      FIND.listNav = true;
      FIND.cur = (FIND.cur + (e.key === 'ArrowDown' ? 1 : -1) + FIND.matches.length) % FIND.matches.length;
      paintFind(true);
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); if (id === '#find-r' && (e.ctrlKey || e.altKey)) replaceAllMatches(); else if (id === '#find-r') replaceOne(); else if (FIND.listNav) stayAtMatch(); else stepFind(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
}
$('#find-next').onclick = () => stepFind(1);
$('#find-prev').onclick = () => stepFind(-1);
$('#find-one').onclick = replaceOne;
$('#find-all').onclick = replaceAllMatches;
$('#find-close').onclick = closeFind;
doc.addEventListener('input', () => { if (!$('#findbar').hidden) setTimeout(() => runFind(true), 0); });

// ---------------------------------------------------------------- theme

const THEMES = ['auto', 'light', 'dark'];
function setTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  $('#theme').innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-${t === 'auto' ? 'auto' : t}"/></svg> ` +
    'Theme: ' + { auto: 'follow the system', light: 'light', dark: 'dark' }[t];
  if (setTheme.ready) toast('Colours: ' + { auto: 'follow the system', light: 'light', dark: 'dark' }[t]);
  setTheme.ready = true;
  try { localStorage.setItem('theme', t); } catch (e) { /* storage unavailable */ }
}
$('#theme').onclick = () => {
  const cur = document.documentElement.dataset.theme || 'auto';
  setTheme(THEMES[(THEMES.indexOf(cur) + 1) % 3]);
};
try { setTheme(localStorage.getItem('theme') || 'auto'); } catch (e) { setTheme('auto'); }

// Colour-blind palette (Okabe-Ito): additions blue, removals vermillion, and
// shapes besides colour (dashed underline, strike-through). Remembered per browser.
function setColourBlind(on) {
  if (on) document.documentElement.dataset.cb = '1'; else delete document.documentElement.dataset.cb;
  const b = document.getElementById('cbmode');
  if (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('pressed', !!on); }
  try { localStorage.setItem('colourblind', on ? '1' : ''); } catch (e) { /* storage unavailable */ }
}
{
  setPaperPairs(PAPER_PAIRS);
  const p = document.getElementById('pairsbtn');
  if (p) p.addEventListener('click', () => { setPaperPairs(!PAPER_PAIRS); toast(PAPER_PAIRS ? 'Brackets close as you type' : 'Brackets no longer close as you type'); });
  const b = document.getElementById('cbmode');
  if (b) b.addEventListener('click', () => { setColourBlind(!document.documentElement.dataset.cb); toast(document.documentElement.dataset.cb ? 'Colour-blind palette on' : 'Colour-blind palette off'); });
  let on = false;
  try { on = localStorage.getItem('colourblind') === '1'; } catch (e) { /* storage unavailable */ }
  setColourBlind(on);
}

// The width of the paper in one column (the slider in the ☰ menu).
function setDocWidth(em, say = false) {
  em = Math.max(30, Math.min(100, Math.round(em)));
  document.documentElement.style.setProperty('--doc-width', em + 'em');
  $('#docwidth').value = em;
  $('#docwidthval').textContent = em + 'em';
  VIEW.save('docwidth', em);
  if (say) toast('Width ' + em + 'em');
}
$('#docwidth').addEventListener('input', () => setDocWidth(+$('#docwidth').value));
try { const w = parseFloat(localStorage.getItem('docwidth')); if (w) setDocWidth(w); } catch (e) { /* storage unavailable */ }

// The structure view: environment starts and ends, and labels, as small tags.
// The tags take room above and inside the blocks: the view stays on the
// caret's line when it is on screen, otherwise on the block at the top.
function setDetails(on) {
  const sel = getSelection();
  let caret = null;
  if (sel.rangeCount && $('#doc').contains(sel.anchorNode)) {
    const r = sel.getRangeAt(0).cloneRange(); r.collapse(true);
    const rect = r.getClientRects()[0] || (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).getBoundingClientRect();
    if (rect && rect.top >= chromeBottom() && rect.bottom <= innerHeight) caret = { r, top: rect.top };
  }
  const anchor = caret ? null : viewAnchor();
  document.body.classList.toggle('details', !!on);
  if (caret) {
    const rect = caret.r.getClientRects()[0] || (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).getBoundingClientRect();
    if (rect) window.scrollBy(0, rect.top - caret.top);
  } else if (anchor && anchor.list) restoreAnchor(anchor);
  for (const id of ['detailsbtn', 'structbtn']) {
    const b = document.getElementById(id);
    if (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('pressed', !!on); }
  }
  try { localStorage.setItem('details', on ? '1' : ''); } catch (e) { /* storage unavailable */ }
}
{
  const b = document.getElementById('detailsbtn');
  const flip = () => { const on = !document.body.classList.contains('details'); setDetails(on); toast(on ? 'Structure shown' : 'Structure hidden'); };
  if (b) b.addEventListener('click', flip);
  document.getElementById('structbtn').addEventListener('click', flip);
  let on = false;
  try { on = localStorage.getItem('details') === '1'; } catch (e) { /* storage unavailable */ }
  setDetails(on);
}

// -------------------------------------------------------------- toolbar

const ACTIONS = {
  bold: () => wrap('\\textbf{', 'strong'),
  emph: () => wrap('\\emph{', 'em'),
  math: mathAtSelection,
  display: () => insertMath(true),
  cite: citePalette,
  ref: refPalette,
  latex: () => insertLatex('\\cref{}', 'Insert LaTeX'),
  section: () => headingAtCaret('section'),
  subsection: () => headingAtCaret('subsection'),
  paragraph: () => headingAtCaret('paragraph'),
  splitsection: splitSectionAtCaret,
  newpara: () => insertBreak(),
  find: () => openFind(false),
  mono: () => wrap('\\texttt{', 'code'),
  footnote: insertFootnote,
  itemize: () => insertList('itemize'),
  enumerate: () => insertList('enumerate'),
  undo, redo,
};
// Edits from the toolbar (and their keys) say what they did, or that there
// was nothing to do: the page changing is the only other sign.
let DOC_CHANGES = 0;
new MutationObserver(() => { DOC_CHANGES++; }).observe($('#doc'), { childList: true, subtree: true, characterData: true });
const SAID = { mono: 'Typewriter', itemize: 'Bulleted list', enumerate: 'Numbered list', bold: 'Bold', emph: 'Emphasis', math: 'Inline maths', display: 'Displayed equation', section: 'Section heading',
  subsection: 'Subsection heading', paragraph: 'Paragraph heading', splitsection: 'Section split', newpara: 'New paragraph',
  undo: 'Undone', redo: 'Redone' };
const NOTHING = { undo: 'Nothing to undo', redo: 'Nothing to redo' };
function announced(name, fn) {
  return (...args) => {
    const n = DOC_CHANGES;
    const r = fn(...args);
    setTimeout(() => {
      if (DOC_CHANGES !== n) toast(SAID[name]);
      else toast(NOTHING[name] || SAID[name] + ': put the cursor in the text first');
    }, 30);
    return r;
  };
}
// actions that open a window: if none opened, say why
for (const name of ['cite', 'ref', 'latex']) {
  const fn = ACTIONS[name];
  ACTIONS[name] = (...args) => {
    const r = fn(...args);
    setTimeout(() => { if ($('#palette').hidden && $('#drawer').hidden) toast('Put the cursor in the text first', 'error'); }, 60);
    return r;
  };
}
for (const name of Object.keys(SAID)) {
  const fn = ACTIONS[name];
  ACTIONS[name] = announced(name, fn);
  for (const keys of [TEXT_KEYS, GLOBAL_KEYS]) for (const k of Object.keys(keys)) if (keys[k] === fn) keys[k] = ACTIONS[name];
}
for (const b of document.querySelectorAll('#toolbar button, #headpop button')) {
  // keep the caret in the text when a button is pressed
  b.addEventListener('mousedown', (e) => e.preventDefault());
  if (b.dataset.act) b.addEventListener('click', () => ACTIONS[b.dataset.act]());
}
Object.assign(TEXT_KEYS, { 'C-M-c': citePalette, 'C-M-C': citePalette, 'C-M-r': refPalette, 'C-M-R': refPalette });
Object.assign(GLOBAL_KEYS, { 'C-f': () => openFind(false), 'C-h': () => openFind(true) });
delete TEXT_KEYS['C-R'];


// ?uitest: drive the palettes, find/replace and theme as a user would, and
// log the resulting source changes (nothing is saved).
async function uiTest() {
  const log = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const paras = ORDER.filter((x) => x.kind === 'para' && x.edit && !x.edit.classList.contains('quiet'));
  const para = paras[paras.length - 5];
  const citeQuery = Object.keys(DOC.aux.cites)[0] || 'crypto';
  const putCaretAtEnd = () => {
    const r = document.createRange(); r.selectNodeContents(para.edit); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); para.edit.focus();
  };
  // cite
  putCaretAtEnd();
  citePalette();
  $('#pal-q').value = citeQuery; refreshPalette(); await wait(800);
  log.push('cite results: ' + PAL.items.slice(0, 3).map((i) => i.key).join(', '));
  await choose(false);
  // ref
  putCaretAtEnd();
  refPalette();
  $('#pal-q').value = 'fig'; refreshPalette(); await wait(300);
  log.push('ref results: ' + PAL.items.slice(0, 3).map((i) => `${i.name} ${i.num} ${i.key}`).join('; '));
  log.push('labels: ' + collectLabels().length);
  await choose(false);
  // find and replace
  openFind(false);
  $('#find-q').value = 'the'; $('#find-word').checked = true; runFind();
  log.push('find "the" (word): ' + FIND.matches.length + ' matches');
  $('#find-r').value = 'FINDER'; replaceOne();
  // theme
  setTheme('dark');
  log.push('dark background: ' + getComputedStyle(document.body).backgroundColor);
  setTheme('auto');
  commit();
  for (const n of Object.keys(FILES)) {
    const a = FILES[n].disk, b = FILES[n].text;
    if (a === b) continue;
    let i = 0; while (a[i] === b[i]) i++;
    let j = 0; while (j < a.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    log.push(`${n}: -${JSON.stringify(a.slice(i, a.length - j))} +${JSON.stringify(b.slice(i, b.length - j))}`);
  }
  fetch('/api/log', { method: 'POST', headers: { 'X-Token': TOKEN }, body: 'UITEST\n' + log.join('\n') });
}
if (new URLSearchParams(location.search).has('uitest')) {
  const t = setInterval(() => { if (ORDER.length) { clearInterval(t); setTimeout(uiTest, 500); } }, 200);
}

// ================================================================ fuzz
//
// ?fuzz=N&seed=S: N random edits through the page, each checked for
//   locality: the file changed only inside the edited block;
//   fidelity: the saved source, parsed again, shows the text on the page;
//   round trip: the block's new source parses and serializes exactly.
// Then a real save; the page logs a hash of every file it wrote, which
// tests/fixtures.py compares with the files on disk.  Only for copies.
async function fuzzTest(n, seed) {
  let x = seed || 1;
  const rnd = (k) => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % k; };
  const pick = (a) => a[rnd(a.length)];
  const CHARS = ['a', 'Z', ' ', '%', '&', '_', '#', '$', '{', '}', '~', '^', '\\', 'é', 'ß', '→', '"', "'", '`',
    '-', '.', ',', '(', ')', '[', ']', '|', '<', '>', '/', '*', '!', '?', ':', ';', '1', '0'];
  const norm = (t) => t.replace(/ /g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
  // visible text without what depends on the surrounding document (theorem
  // and list numbers), and without raw-command display details
  const visible = (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.data; continue; }
      if (n.nodeType !== 1 || n.classList.contains('hidden')) continue;
      if (n.classList.contains('thmhead') || n.classList.contains('itemmark') || n.classList.contains('runin')) continue;
      if (n.classList.contains('chip') && n.classList.contains('src')) { out += (n.dataset.src || '').replace(/\{\}/g, ''); continue; }
      if (n.classList.contains('item')) { out += ' '; continue; }
      out += visible(n);
    }
    return out;
  };
  const shown = (src) => { const d = el('div'); renderTokens(L.tokenize(src), d, {}); return norm(visible(d)); };
  const fails = [];
  commit();
  const before = () => Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, f.text]));
  for (let i = 0; i < n; i++) {
    const segs = ORDER.filter((sg) => sg.edit && !sg.removed && sg.el &&
      !(sg.edit.classList && sg.edit.classList.contains('quiet')));
    const seg = pick(segs);
    const old = before();
    const oldSrc = seg.src;
    const offset = (() => { // where the segment starts in its file
      let o = 0;
      for (const sg of FILES[seg.file].segs) { if (sg === seg) return o; o += sg.src.length; }
      return -1;
    })();
    let op;
    if (seg.edit.tagName === 'TEXTAREA') {
      op = 'code';
      const v = seg.edit.value, at = rnd(v.length + 1);
      seg.edit.value = v.slice(0, at) + pick(CHARS) + pick(CHARS) + v.slice(at);
      seg.touched = true;
    } else {
      const texts = [];
      const w = document.createTreeWalker(seg.edit, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = w.nextNode())) if (!t.parentElement.closest('.chip')) texts.push(t);
      op = pick(['type', 'type', 'type', 'delete', 'math', 'emph', seg.kind === 'para' ? 'parbreak' : 'type']);
      const tn = texts.length ? pick(texts) : null;
      if (!tn && op !== 'math') op = 'append';
      if (op === 'type' || op === 'append') {
        const s = Array.from({ length: 1 + rnd(5) }, () => pick(CHARS)).join('');
        if (tn) { const at = rnd(tn.data.length + 1); tn.data = tn.data.slice(0, at) + s + tn.data.slice(at); }
        else seg.edit.append(document.createTextNode(s));
      } else if (op === 'delete') {
        const a = rnd(tn.data.length + 1), b = Math.min(tn.data.length, a + 1 + rnd(4));
        tn.data = tn.data.slice(0, a) + tn.data.slice(b);
      } else if (op === 'math') {
        const m = mathChip(pick(['$x_1$', '$\\frac{a}{b}$', '$\\{0,1\\}^n$', '$50\\%$']), false);
        if (tn) { const at = rnd(tn.data.length + 1); const rest = tn.splitText(at); rest.before(m); }
        else seg.edit.append(m);
      } else if (op === 'emph') {
        const at = rnd(tn.data.length + 1); const rest = tn.splitText(at);
        const e = el('em'); e.dataset.prefix = '\\emph{'; e.append(document.createTextNode('word'));
        rest.before(e);
      } else if (op === 'parbreak') {
        const at = rnd(tn.data.length + 1); const rest = tn.splitText(at);
        rest.before(chip('parbreak', '\n\n', ''));
      }
      seg.touched = true;
    }
    commit();
    const now = before();
    const newSrc = segSource(seg, []);
    // locality: other files untouched; this file = prefix + new block + suffix
    for (const f of Object.keys(now)) {
      if (f !== seg.file && now[f] !== old[f]) fails.push(`#${i} ${op}: ${f} changed although ${seg.file} was edited`);
    }
    const expect = old[seg.file].slice(0, offset) + newSrc + old[seg.file].slice(offset + oldSrc.length);
    if (now[seg.file] !== expect) fails.push(`#${i} ${op}: ${seg.file} changed outside the edited block`);
    // round trip of the new block
    if (seg.kind === 'para' && L.serializeTokens(L.tokenize(newSrc)) !== newSrc) fails.push(`#${i} ${op}: block does not round-trip`);
    // fidelity: the source shows what the page shows (paragraphs; a heading or
    // caption compares its title or caption)
    const pageText = norm(seg.edit.tagName === 'TEXTAREA' ? seg.edit.value : visible(seg.edit));
    let srcText = null;
    if (seg.kind === 'para') srcText = shown(newSrc);
    else if (seg.kind === 'heading') { const h = L.headingParts(newSrc); srcText = h && shown(h.title); }
    else if (seg.kind === 'figure' || seg.kind === 'table') { const c = L.captionParts(newSrc); srcText = c && shown(c.caption); }
    if (srcText !== null && op !== 'code' && srcText.replace(/\s/g, '') !== pageText.replace(/[\s¶]/g, '')) {
      const pa = pageText.replace(/[\s¶]/g, ''), sb = srcText.replace(/\s/g, '');
      let d = 0; while (pa[d] === sb[d]) d++;
      fails.push(`#${i} ${op}: page …${JSON.stringify(pa.slice(Math.max(0, d - 25), d + 35))} vs source …${JSON.stringify(sb.slice(Math.max(0, d - 25), d + 35))}`);
    }
    seg.src = newSrc; seg.touched = false;   // the next round compares with this state
    if (seg.kind === 'heading') seg.parts = L.headingParts(newSrc);
    if (seg.kind === 'figure' || seg.kind === 'table') seg.parts = L.captionParts(newSrc);
    if (seg.kind === 'code') seg.parts = L.splitCode(newSrc);
  }
  // a real save, then the hashes of what was written
  await save();
  const hashes = {};
  for (const [name, f] of Object.entries(FILES)) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(f.text));
    hashes[name] = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const edited = Object.keys(FILES).filter((k) => FILES[k].text !== DOC.files[k].text);
  fetch('/api/log', { method: 'POST', headers: { 'X-Token': TOKEN },
    body: 'FUZZ ' + JSON.stringify({ rounds: n, fails: fails.slice(0, 30), nfails: fails.length, hashes, edited }) });
}
function updateDiffMap() {
  if (!DIFF.on || !DIFF.marks.length) return;
  const map = $('#diffmap');
  const height = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  map.querySelectorAll('.diffmap-mark').forEach((mark) => {
    const target = DIFF.marks[+mark.dataset.index];
    if (!target || !target.isConnected) return;
    const y = Math.max(0, target.getBoundingClientRect().top + scrollY) / height;
    mark.style.top = `${Math.min(98, y * 98)}%`;
    mark.classList.toggle('active', target.classList.contains('diff-current'));
  });
  const view = $('#diffmap-viewport');
  view.style.top = `${Math.max(0, Math.min(98, 98 * scrollY / height))}%`;
  view.style.height = `${Math.max(2, Math.min(100, innerHeight * 100 / document.documentElement.scrollHeight))}%`;
}
function fillDiffMap() {
  const map = $('#diffmap');
  map.querySelectorAll('.diffmap-mark').forEach((node) => node.remove());
  map.hidden = !DIFF.on || !DIFF.marks.length;
  DIFF.marks.forEach((target, i) => {
    const mark = el('button', 'diffmap-mark');
    mark.type = 'button';
    mark.dataset.index = i;
    mark.setAttribute('aria-label', `Go to change ${i + 1}`);
    mark.title = `Change ${i + 1} of ${DIFF.marks.length}`;
    mark.classList.add(target.classList.contains('diff-gone') ? 'removed' :
      target.classList.contains('diff-new') ? 'added' : 'modified');
    mark.onclick = () => {
      if (DIFF.marks[DIFF.cur]) DIFF.marks[DIFF.cur].classList.remove('diff-current');
      DIFF.cur = i - 1;
      diffStep(1);
    };
    map.append(mark);
  });
  requestAnimationFrame(updateDiffMap);
}
addEventListener('scroll', updateDiffMap, { passive: true });
addEventListener('resize', updateDiffMap);
{
  const q = new URLSearchParams(location.search);
  if (q.has('fuzz')) {
    const t = setInterval(() => { if (ORDER.length) { clearInterval(t); setTimeout(() => fuzzTest(+q.get('fuzz') || 200, +q.get('seed') || 1), 500); } }, 200);
  }
}


// ================================================================= diff
//
// Compare every file with a baseline (the last git commit, or the text when
// the editor opened): blocks are matched by their source; a block that
// changed shows a word diff, a new block is tinted green, a deleted one is
// shown struck through in red where it was.  Read-only while on.

// editing: the block being edited in the diff view ({ file, index }), drawn
// as usual while the other blocks show their changes.  bases: the texts
// compared with, kept while the diff is drawn again after an edit.
const DIFF = { on: false, marks: [], cur: -1, editing: null, bases: null, busy: false };
function diffEditSeg() {
  const e = DIFF.editing;
  const seg = e && FILES[e.file] && FILES[e.file].segs ? FILES[e.file].segs[e.index] : null;
  return seg && seg.el && seg.el.isConnected ? seg : null;
}
const diffSource = (s) => s.removed ? '' : s.diffSrc !== undefined ? s.diffSrc : s.kind === 'hidden' && s.patched !== undefined ? s.patched : s.src;
// The block edited in the diff view, into the text of its file (the other
// blocks are taken as they were when the diff was drawn).
function diffSync() {
  const seg = diffEditSeg();
  if (!seg) return;
  flushEdits();
  if (!seg.touched) return;
  const src = segSource(seg, [], null, false);
  seg.src = src; seg.diffSrc = src; seg.touched = false;
  FILES[seg.file].text = FILES[seg.file].segs.map(diffSource).join('');
}
// Draw the diff again after an edit.  state (from captureEditorState) is the
// block to edit and the caret in it, or null when no block is edited.  That
// block keeps its place on screen.
async function diffAgain(state) {
  if (DIFF.busy) return;
  DIFF.busy = true;
  try {
    if (DIFF_SHOWN) diffSync();
    DIFF.editing = null;
    const before = state && FILES[state.file] && FILES[state.file].segs ? FILES[state.file].segs[state.index] : null;
    const top = before && before.el && before.el.isConnected ? before.el.getBoundingClientRect().top : null;
    const y = viewAnchor();
    render();
    restoreAnchor(y);
    if (state && FILES[state.file]) {
      // the block by its place in its file, else the nearest with its source
      const segs = FILES[state.file].segs;
      if (!segs[state.index] || segs[state.index].src !== state.src) {
        let best = -1;
        segs.forEach((sg, i) => { if (sg.src === state.src && sg.edit && (best < 0 || Math.abs(i - state.index) < Math.abs(best - state.index))) best = i; });
        if (best >= 0) state.index = best;
      }
      const seg = segs[state.index];
      if (seg && seg.edit && seg.el) DIFF.editing = { file: state.file, index: state.index };
    }
    DIFF.on = true;
    await diffOn(true);
    const seg = diffEditSeg();
    if (seg) {
      if (top !== null) window.scrollBy(0, seg.el.getBoundingClientRect().top - top);
      if (seg.edit.tagName === 'TEXTAREA') seg.edit.focus({ preventScroll: true });
      else {
        state.offset = Math.min(state.offset ?? Infinity, seg.edit.textContent.length);
        if (state.end !== undefined) state.end = Math.min(state.end, seg.edit.textContent.length);
        restoreEditorState(state);
      }
    }
  } finally {
    DIFF.busy = false;
  }
}

function diffUnits(src) {
  // words, spaces and punctuation of the text; every other token whole
  const out = [];
  for (const tok of L.tokenize(src)) {
    if (tok.t === 'text') {
      for (const w of tok.s.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || []) out.push({ key: 'T' + w, tok: { t: 'text', s: w } });
    } else if (tok.t === 'nl') out.push({ key: 'T ', tok });
    else out.push({ key: 'K' + L.serializeTokens([tok]), tok });
  }
  return out;
}

function lcs(a, b, eq) {
  const n = a.length, m = b.length;
  if (n * m > 4e6) return null;   // too big: treat as replaced
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) { ops.push(['=', a[i], b[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++], null]);
    else ops.push(['+', null, b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++], null]);
  while (j < m) ops.push(['+', null, b[j++]]);
  return ops;
}

// The word diff as runs, each either equal ({eq: true, b}) or a change
// ({eq: false, a, b}: the old units replaced by the new ones), after a
// semantic cleanup (as in diff-match-patch): a short equal run between two
// changes, no longer than the changes on both sides of it, or one with no
// letters or digits (a space, a comma), is folded into a single change.
// Without it a rewritten sentence reads as alternating fragments of the old
// and new wording, matched on the spaces and the words "the" and "of".
function wordDiffRuns(oldSrc, newSrc) {
  const ops = lcs(diffUnits(oldSrc), diffUnits(newSrc), (x, y) => x.key === y.key);
  if (!ops) return null;
  const runs = [];
  for (const [op, a, b] of ops) {
    const eq = op === '=';
    let r = runs[runs.length - 1];
    if (!r || r.eq !== eq) { r = { eq, a: [], b: [] }; runs.push(r); }
    if (op !== '+') r.a.push(a);
    if (op !== '-') r.b.push(b);
  }
  const len = (us) => us.reduce((n, u) => n + u.key.length - 1, 0);
  const wordy = (us) => us.some((u) => u.key[0] === 'K' || /[\p{L}\p{N}]/u.test(u.key));
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 1; k + 1 < runs.length; k++) {
      const [p, e, q] = [runs[k - 1], runs[k], runs[k + 1]];
      if (!e.eq || p.eq || q.eq) continue;
      const n = len(e.b);
      if (wordy(e.b) && (n > Math.max(len(p.a), len(p.b)) || n > Math.max(len(q.a), len(q.b)))) continue;
      runs.splice(k - 1, 3, { eq: false, a: [...p.a, ...e.a, ...q.a], b: [...p.b, ...e.b, ...q.b] });
      changed = true;
      break;
    }
  }
  return runs;
}

// How alike two sources are, from 0 to 1: the share of their words (and
// formulas) that the word diff keeps.
function diffSimilarity(oldSrc, newSrc) {
  const words = (s) => diffUnits(s).filter((u) => u.key !== 'T ' && !/^T\s+$/.test(u.key));
  const a = words(oldSrc), b = words(newSrc);
  if (!a.length && !b.length) return 1;
  const ops = lcs(a, b, (x, y) => x.key === y.key);
  let same;
  if (ops) same = ops.filter((o) => o[0] === '=').length;
  else {   // too long for the LCS: count shared words regardless of order
    const bag = new Map();
    for (const u of a) bag.set(u.key, (bag.get(u.key) || 0) + 1);
    same = 0;
    for (const u of b) if (bag.get(u.key) > 0) { bag.set(u.key, bag.get(u.key) - 1); same++; }
  }
  return 2 * same / (a.length + b.length);
}

function renderWordDiff(oldSrc, newSrc, into) {
  const runs = wordDiffRuns(oldSrc, newSrc);
  into.textContent = '';
  if (!runs) { // too large to diff word by word
    const d = el('span', 'd-del'); renderTokens(L.tokenize(oldSrc), d, {});
    const n = el('span', 'd-ins'); renderTokens(L.tokenize(newSrc), n, {});
    into.append(d, n);
    return;
  }
  for (const r of runs) {
    if (r.eq) { renderTokens(r.b.map((u) => u.tok), into, {}); continue; }
    if (r.a.length) { const d = el('span', 'd-del'); renderTokens(r.a.map((u) => u.tok), d, {}); into.append(d); }
    if (r.b.length) { const n = el('span', 'd-ins'); renderTokens(r.b.map((u) => u.tok), n, {}); into.append(n); }
  }
}

// ---- change peek: hover an edited block's change bar (left of the text)
// to see what changed since the last save, word by word, and revert it;
// as in VS Code's gutter.
const PEEK = { seg: null, timer: null };
function peekBox() {
  let box = document.getElementById('peek');
  if (!box) {
    box = el('div'); box.id = 'peek'; box.hidden = true; box.setAttribute('role', 'tooltip');
    box.addEventListener('mouseleave', () => hidePeek());
    document.body.append(box);
  }
  return box;
}
function hidePeek() { clearTimeout(PEEK.timer); PEEK.seg = null; const b = document.getElementById('peek'); if (b) b.hidden = true; }
function showPeek(seg) {
  if (DIFF_SHOWN || !seg.el || !seg.el.classList.contains('edited')) return;
  const now = segSource(seg, [], null, false);
  if (now === seg.src) return;
  const box = peekBox();
  box.textContent = '';
  const head = el('div', 'peek-head');
  head.append(el('span', '', `Changed since the last save · ${seg.file}`));
  const revert = el('button', '', '↶ Revert block');
  revert.title = 'Put this block back as it was at the last save (Ctrl+Alt+Backspace; Ctrl+Z undoes)';
  revert.onclick = () => {
    const orig = seg.src;
    hidePeek();
    snapshot();
    structural(() => { seg.src = orig; });
    markEdited();
    toast('Block reverted to the last save', 'ok');
  };
  head.append(revert, xButton('Close', () => hidePeek(), 'Close'));
  const body = el('div', 'peek-body');
  const a = contentOf(seg, seg.src), b = contentOf(seg, now);
  if (a === b) body.append(el('div', 'small', 'Changed outside the text shown (LaTeX of the block):'));
  renderWordDiff(a === b ? seg.src : a, a === b ? now : b, body);
  box.append(head, body);
  const r = seg.el.getBoundingClientRect();
  box.hidden = false;
  const w = Math.min(560, innerWidth - 24);
  box.style.width = w + 'px';
  box.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.left)) + 'px';
  const h = box.getBoundingClientRect().height;
  const below = r.bottom + 6, above = r.top - h - 6;
  box.style.top = (above > chromeBottom() + 4 ? above : Math.min(below, innerHeight - h - 8)) + 'px';
  PEEK.seg = seg;
}
// It opens only once the pointer has rested on the bar (600 ms: passing over
// it does nothing), or at once on a click; typing or scrolling cancels it, and
// it waits a moment before closing so that the pointer can reach Revert.
function barSeg(e) {
  if (e.target.closest && e.target.closest('.tools, button, #menu')) return null;   // the block's tools stay theirs
  const segEl = e.target.closest && e.target.closest('#doc .seg.edited');
  if (!segEl || !segEl.seg) return null;
  const r = segEl.getBoundingClientRect();
  return e.clientX < r.left + 2 && e.clientX > r.left - 14 ? segEl.seg : null;   // on the change bar
}
document.addEventListener('mousemove', (e) => {
  if (e.target.closest && e.target.closest('#peek')) { clearTimeout(PEEK.timer); PEEK.wait = null; return; }
  const hit = barSeg(e);
  if (hit && hit === PEEK.seg) { clearTimeout(PEEK.timer); return; }   // back on the open one
  if (hit && hit === PEEK.wait) return;                                // still resting
  clearTimeout(PEEK.timer);
  PEEK.wait = hit;
  if (!hit) { if (PEEK.seg) PEEK.timer = setTimeout(hidePeek, 250); return; }
  PEEK.timer = setTimeout(() => { PEEK.wait = null; showPeek(hit); }, 600);
});
document.addEventListener('mousedown', (e) => {
  const hit = barSeg(e);
  if (hit) { e.preventDefault(); clearTimeout(PEEK.timer); PEEK.wait = null; showPeek(hit); }
}, true);
const cancelPeek = () => { clearTimeout(PEEK.timer); PEEK.wait = null; if (PEEK.seg) hidePeek(); };
window.addEventListener('scroll', cancelPeek, { passive: true });
document.addEventListener('keydown', cancelPeek, true);

function contentOf(seg, src) {
  // the editable part of a block, as source: a heading's title, a caption
  if (seg.kind === 'heading') { const h = L.headingParts(src); return h ? h.title : src; }
  if (seg.kind === 'figure' || seg.kind === 'table') { const c = L.captionParts(src); return c ? c.caption : src; }
  return src;
}

// The commits of the paper's folder, in the diff's "compare with" list.
// Read again each time the diff view opens, and on its reload button, so a
// commit made outside the editor shows.
let COMMITS = null;
async function loadCommits() {
  try { COMMITS = await (await fetch('/api/commits', { cache: 'no-store' })).json(); } catch (e) { COMMITS = []; }
  const sel = $('#diffbase'), was = DIFF.want || sel.value;
  DIFF.want = null;
  const g = $('#diffcommits');
  g.textContent = '';
  const ago = (s) => {
    const d = Date.now() / 1000 - s, n = Math.round(d / 86400);
    return d < 3600 ? Math.max(1, Math.round(d / 60)) + ' min ago' : d < 86400 ? Math.round(d / 3600) + ' h ago'
      : d < 86400 * 60 ? n + (n === 1 ? ' day ago' : ' days ago') : new Date(s * 1000).toISOString().slice(0, 10);
  };
  // short labels: the native list is as wide as its longest option, and runs
  // off the window's edge otherwise (the whole subject is in the tooltip)
  const short = (t) => (t.length > 34 ? t.slice(0, 33).trimEnd() + '…' : t);
  // the first is HEAD, already "since the last commit"
  for (const c of COMMITS.slice(1)) {
    const o = new Option(`${c.short} · ${ago(c.t)} · ${short(c.subject)}`, c.hash);
    o.title = `${c.subject}\n${c.author}, ${new Date(c.t * 1000).toLocaleString()}`;
    g.append(o);
  }
  g.hidden = !g.children.length;
  // rebuilding the list drops a chosen commit: choose it again, or the last
  // commit when it is now the last one (or gone)
  sel.value = was;
  if (sel.value !== was) sel.value = 'head';
}
function diffBaseName(ref) {
  if (ref === 'save') return 'the last save';
  if (ref === 'session') return 'when the editor opened';
  if (ref === 'head') return 'the last commit';
  const c = (COMMITS || []).find((x) => x.hash === ref);
  return c ? `commit ${c.short} (${c.subject.slice(0, 50)})` : 'commit ' + ref.slice(0, 7);
}

// Undo one change of the diff view: the block as it was in the baseline.
function diffRevert(name, fn) {
  const segs = FILES[name] && FILES[name].segs;
  if (!segs) return;
  snapshot();   // with the block being edited, if any
  DIFF.editing = null;
  fn(segs);
  FILES[name].text = segs.map(diffSource).join('');
  for (const s of segs) delete s.diffSrc;
  const y = viewAnchor();
  render();
  restoreAnchor(y);
  DIFF.on = true;
  diffOn(true);
  markEdited();
  toast('Change reverted (Ctrl+Z brings it back); save to keep it', 'ok');
}

async function diffOn(quiet = false) {
  commit();
  const ref = $('#diffbase').value;
  DIFF.marks = [];
  document.body.classList.add('diffing');
  DIFF_SHOWN = true;
  // every block is read-only but the one being edited; a click on one of
  // the others edits it instead (data-diff-edit)
  const editing = diffEditSeg();
  for (const e of document.querySelectorAll('#doc [contenteditable="true"]')) {
    if (editing && editing.el.contains(e)) continue;
    e.contentEditable = 'false'; e.dataset.diffEdit = '1';
  }
  for (const ta of document.querySelectorAll('#doc textarea')) {
    if (editing && editing.el.contains(ta)) continue;
    ta.readOnly = true; ta.dataset.diffEdit = '1';
  }
  if (editing) editing.el.classList.add('diff-editing');
  const names = Object.keys(FILES).filter((n) => FILES[n].segs);
  let changedFiles = 0;
  // Last save is the editor's disk snapshot; any other version is read for
  // all files at once.
  let bases = {};
  if (ref !== 'save' && quiet && DIFF.bases && DIFF.bases.ref === ref) bases = DIFF.bases.texts;
  else if (ref !== 'save') {
    try {
      const r = await fetch(`/api/baselines?ref=${encodeURIComponent(ref)}`);
      bases = r.ok ? await r.json() : {};
    } catch (e) { bases = {}; }
    DIFF.bases = { ref, texts: bases };
  }
  for (const name of names) {
    let base;
    if (ref === 'save') base = FILES[name].disk;
    else if (name in bases) base = bases[name];
    else {
      const r = await fetch(`/api/baseline?name=${encodeURIComponent(name)}&ref=${ref}`);
      base = r.ok ? (await r.json()).text : null;
    }
    // every block's source as the diff is drawn: what an edit in the diff
    // view rebuilds its file from
    for (const sg of FILES[name].segs) sg.diffSrc = segSource(sg, [], null, false);
    const cur = FILES[name].segs.filter((sg) => sg.el && !sg.removed);
    if (base === null) { cur.forEach((sg) => { sg.el.classList.add('diff-new'); DIFF.marks.push(sg.el); }); changedFiles++; continue; }
    if (base === FILES[name].text) continue;
    changedFiles++;
    const old = parseFile(name, base).filter((sg) => !['gap', 'hidden', 'input'].includes(sg.kind));
    // a block edited since it was read: its source now, not as it was read
    const now = new Map(cur.map((sg) => [sg, sg.touched || sg.figSrc ? segSource(sg, [], null, false) : sg.src]));
    for (const [sg, src] of now) sg.diffSrc = src;   // the page is about to show marks: read nothing back from it
    const ops = lcs(old, cur, (a, b) => a.src === now.get(b) && a.kind === b.kind) ||
      [...old.map((o) => ['-', o, null]), ...cur.map((c) => ['+', null, c])];
    // pair runs of deletions and insertions of the same kind as modified blocks
    for (let i = 0; i < ops.length; i++) {
      if (ops[i][0] === '=') continue;
      let j = i;
      while (j < ops.length && ops[j][0] !== '=') j++;
      const dels = ops.slice(i, j).filter((o) => o[0] === '-').map((o) => o[1]);
      const ins = ops.slice(i, j).filter((o) => o[0] === '+').map((o) => o[2]);
      const anchor = (ins[0] && ins[0].el) || (ops[j] && ops[j][2] && ops[j][2].el) || null;
      // An inserted block is paired with the deleted block of its kind whose
      // words it shares most, at least half of them, so that a rewritten or
      // moved paragraph is not word-diffed against an unrelated one; pairs
      // keep the order of the file.
      let from = 0;
      for (const b of ins) {
        let k = -1, best = 0.5;
        for (let x = from; x < dels.length; x++) {
          if (dels[x].kind !== b.kind) continue;
          const sim = diffSimilarity(contentOf(dels[x], dels[x].src), contentOf(b, now.get(b)));
          if (sim >= best) { best = sim; k = x; }
        }
        if (k >= 0) {
          from = k;
          const d = dels.splice(k, 1)[0];
          b.el.classList.add('diff-changed');
          b.el.diffRevert = () => diffRevert(name, () => { b.diffSrc = d.src; });
          const target = b.edit && b.edit.tagName !== 'TEXTAREA' ? b.edit : null;
          if (target && b !== editing) renderWordDiff(contentOf(d, d.src), contentOf(b, now.get(b)), target);
          DIFF.marks.push(b.el);
        } else {
          b.el.classList.add('diff-new');
          b.el.diffRevert = () => diffRevert(name, (segs) => {
            const i = segs.indexOf(b);
            b.removed = true;
            if (segs[i + 1] && segs[i + 1].kind === 'gap') segs[i + 1].removed = true;
            else if (i > 0 && segs[i - 1].kind === 'gap') segs[i - 1].removed = true;
          });
          DIFF.marks.push(b.el);
        }
      }
      for (const d of dels) {   // deleted blocks, shown where they were
        const ghost = renderSeg({ ...d }, { sec: 0, sub: 0, subsub: 0, app: false, counters: {}, heads: {}, env: [] });
        if (!ghost) continue;
        ghost.classList.add('diff-gone', 'diff-ghost');
        const before = (ins[0] && !ins[0].removed && ins[0]) || (ops[j] && ops[j][2]) || null;
        ghost.diffRevert = () => diffRevert(name, (segs) => {
          const block = { kind: d.kind, src: d.src, file: name }, gap = { kind: 'gap', src: '\n\n', file: name };
          const i = before ? segs.indexOf(before) : -1;
          if (i >= 0) segs.splice(i, 0, block, gap);
          else {
            const last = cur.length ? segs.indexOf(cur[cur.length - 1]) : segs.length - 1;
            segs.splice(last + 1, 0, gap, block);
          }
        });
        for (const e of ghost.querySelectorAll('[contenteditable]')) e.contentEditable = 'false';
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(ghost, anchor);
        else if (cur.length && cur[cur.length - 1].el) cur[cur.length - 1].el.after(ghost);
        DIFF.marks.push(ghost);
      }
      i = j - 1;
    }
  }
  DIFF.marks.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  // every change can be put back as it was in the baseline
  for (const m of DIFF.marks) {
    if (!m.diffRevert || m.querySelector(':scope > .diff-revert')) continue;
    const b = el('button', 'diff-revert', '\u21b6 Revert');
    b.title = 'Put this block back as it was in ' + diffBaseName(ref) + ' (Ctrl+Alt+Backspace on the current change)';
    b.contentEditable = 'false';
    b.onclick = (e) => { e.stopPropagation(); m.diffRevert(); };
    m.append(b);
  }
  DIFF.cur = -1;
  fillDiffMap();
  $('#diffnav').hidden = false;
  $('#diffcount').textContent = DIFF.marks.length ? `${DIFF.marks.length} changes` : 'no changes';
  if (!quiet || !DIFF.marks.length) banner(DIFF.marks.length ? `${DIFF.marks.length} changed blocks in ${changedFiles} file(s), compared with ${diffBaseName(ref)}. Click a block to edit it, and the diff follows; Revert puts a block back.`
    : 'No changes since ' + diffBaseName(ref) + '.');
}

function diffOff() {
  if (DIFF_SHOWN) diffSync();
  DIFF.editing = null;
  DIFF.bases = null;
  DIFF.on = false;
  $('#diffmap').hidden = true;
  document.body.classList.remove('diffing');
  $('#diffnav').hidden = true;
  $('#diffbase').hidden = true;
  $('#diffbtn').setAttribute('aria-pressed', 'false');
  $('#diffbtn').title = 'Show what changed, Ctrl+Alt+V (click a block to edit it)';
  const y = viewAnchor();
  render();
  restoreAnchor(y);
}

// Leave the diff view if it is on (the page is rendered again from the
// texts).  Returns true when a structure edit should not go on: its block
// was one of the diff view's.
function leaveDiff() {
  if (!DIFF.on && !DIFF_SHOWN) return false;
  diffOff();
  banner('Left the diff view.');
  return true;
}

function diffStep(d) {
  if (!DIFF.marks.length) return;
  if (DIFF.marks[DIFF.cur]) DIFF.marks[DIFF.cur].classList.remove('diff-current');
  DIFF.cur = (DIFF.cur + d + DIFF.marks.length) % DIFF.marks.length;
  const e = DIFF.marks[DIFF.cur];
  navPush();
  e.classList.add('diff-current');
  e.scrollIntoView({ block: 'center', behavior: SMOOTH() });
  $('#diffcount').textContent = `${DIFF.cur + 1} of ${DIFF.marks.length}`;
  updateDiffMap();
}

ACTIONS.diff = () => {
  if (DIFF.on) return diffOff();
  DIFF.on = true;
  $('#diffbtn').setAttribute('aria-pressed', 'true');
  $('#diffbtn').title = 'Leave the diff view (Ctrl+Alt+V)';
  $('#diffbase').hidden = false;
  loadCommits().then(() => {
    if (!DIFF.on) return;
    commit();
    const y = viewAnchor(); render(); restoreAnchor(y);
    diffOn();
  });
};
// after a commit outside the editor: the new list of commits, and the diff
// computed again against it
$('#diffreload').onclick = async () => {
  if (!DIFF.on) return;
  await loadCommits();
  const y = viewAnchor(); render(); restoreAnchor(y); DIFF.on = true; diffOn();
};
// What the diff compares with, as kept for this paper: a commit is chosen
// when the list of commits is read (it falls back to the last commit when
// that commit is gone).
function setDiffBase(ref) {
  const sel = $('#diffbase');
  sel.value = ref;
  if (sel.value !== ref) DIFF.want = ref;
}
$('#diffbase').onchange = () => { VIEW.save('diff', $('#diffbase').value); if (DIFF.on) { const y = viewAnchor(); render(); restoreAnchor(y); DIFF.on = true; diffOn(); } };
$('#diffprev').onclick = () => diffStep(-1);
$('#diffnext').onclick = () => diffStep(1);
// While diffing, only the block being edited takes input.  A click on
// another block edits that one: the page is drawn again with it as usual
// (no marks) and the caret where the click was, counted in the text without
// what was deleted.  Leaving the block (a click outside the text, Esc) draws
// its changes again.
document.addEventListener('beforeinput', (e) => {
  const seg = DIFF.on && DIFF_SHOWN ? diffEditSeg() : null;
  if (DIFF.on && !(seg && seg.el.contains(e.target))) e.preventDefault();
}, true);
$('#doc').addEventListener('mousedown', (e) => {
  if (!DIFF_SHOWN || DIFF.busy || e.button !== 0 || e.target.closest('button, a, input, select, .diff-ghost, .tools')) return;
  const segEl = e.target.closest('.seg');
  const seg = segEl && segEl.seg;
  if (!seg || !seg.file || seg === diffEditSeg() || !seg.edit || !seg.edit.dataset.diffEdit) return;
  const segs = FILES[seg.file] && FILES[seg.file].segs;
  if (!segs || segs.indexOf(seg) < 0) return;
  e.preventDefault();
  let offset = Infinity;
  const p = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
  if (p && seg.edit.contains(p.startContainer)) {
    const r = document.createRange();
    r.selectNodeContents(seg.edit);
    r.setEnd(p.startContainer, p.startOffset);
    const upTo = r.cloneContents();
    for (const x of upTo.querySelectorAll('.d-del, .diff-revert, .boxbadge')) x.remove();
    offset = upTo.textContent.length;
  }
  diffAgain({ file: seg.file, index: segs.indexOf(seg), src: seg.src, offset });
}, true);
$('#doc').addEventListener('focusout', (e) => {
  const seg = DIFF_SHOWN && !DIFF.busy ? diffEditSeg() : null;
  if (!seg || (e.relatedTarget && seg.el.contains(e.relatedTarget))) return;
  setTimeout(() => {
    if (!DIFF_SHOWN || DIFF.busy || diffEditSeg() !== seg) return;
    const a = document.activeElement;
    if (a && seg.el.contains(a)) return;
    if (a && a !== document.body && !$('#doc').contains(a)) return;   // a toolbar or a dialog: still editing
    diffAgain(null);
  }, 0);
});
document.addEventListener('keydown', (e) => {
  const seg = e.key === 'Escape' && DIFF_SHOWN && !DIFF.busy ? diffEditSeg() : null;
  if (!seg || !seg.el.contains(e.target) || e.target.closest('input') || document.querySelector('.popover:not([hidden])')) return;
  e.preventDefault(); e.stopPropagation();
  diffAgain(null);
}, true);
{
  const q = new URLSearchParams(location.search);
  if (q.has('difftest')) {
    const t = setInterval(async () => {
      if (!ORDER.length) return;
      clearInterval(t);
      DIFF.on = true;
      await diffOn();
      const lines = DIFF.marks.map((m) => {
        const cls = [...m.classList].filter((c) => c.startsWith('diff-')).join(',');
        const del = [...m.querySelectorAll('.d-del')].map((x) => x.textContent).join(' | ');
        const ins = [...m.querySelectorAll('.d-ins')].map((x) => x.textContent).join(' | ');
        return `${cls} ${m.seg ? m.seg.file : ''} DEL[${del.slice(0, 120)}] INS[${ins.slice(0, 120)}]`;
      });
      fetch('/api/log', { method: 'POST', headers: { 'X-Token': TOKEN }, body: 'DIFFTEST ' + DIFF.marks.length + ' marks\n' + lines.join('\n') });
    }, 300);
  }
}

// ======================================================= figure viewer
//
// Double-click a figure or table: its image, its text (from the typeset
// figure), its LaTeX, and for pseudocode a structured game editor.

const FV = { seg: null, src: '', tab: 'image', games: null, undo: [], redo: [], lastEditor: null, dragIndex: -1 };
const GAME_ENVS = ['gameenv', 'algorithmic'];
const BLOCK_OPEN = new Set(['If', 'For', 'ForAll', 'While', 'Repeat', 'Loop', 'Procedure', 'Function']);
const BLOCK_CLOSE = new Set(['EndIf', 'EndFor', 'EndWhile', 'Until', 'EndLoop', 'EndProcedure', 'EndFunction']);
const KW = { State: '', Statex: '', If: 'if', ElsIf: 'else if', Else: 'else', EndIf: 'end if', For: 'for', ForAll: 'for all',
  EndFor: 'end for', While: 'while', EndWhile: 'end while', Repeat: 'repeat', Until: 'until', Loop: 'loop',
  EndLoop: 'end loop', Procedure: 'procedure', EndProcedure: 'end procedure', Function: 'function',
  EndFunction: 'end function', Return: 'return', Require: 'require', Ensure: 'ensure' };
// cryptocode's commands, for previews
const CRYPTOCODE_MACROS = { '\\pcreturn': '\\mathbf{return}\\ ', '\\pcif': '\\mathbf{if}\\ ', '\\pcthen': '\\ \\mathbf{then}',
  '\\pcelse': '\\mathbf{else}\\ ', '\\pcelseif': '\\mathbf{else\\ if}\\ ', '\\pcfi': '\\mathbf{fi}', '\\pcendif': '\\mathbf{endif}',
  '\\pcfor': '\\mathbf{for}\\ ', '\\pcdo': '\\ \\mathbf{do}', '\\pcendfor': '\\mathbf{endfor}', '\\pcwhile': '\\mathbf{while}\\ ',
  '\\pcendwhile': '\\mathbf{endwhile}', '\\pcind': '\\quad ', '\\sample': '\\xleftarrow{\\$}', '\\gets': '\\leftarrow',
  '\\pcassert': '\\mathbf{assert}\\ ', '\\pccomment': '\\quad /\\!/\\ \\text{#1}', '\\pclinecomment': '/\\!/\\ \\text{#1}' };

const parseGames = (src) => L.parseGames(src, GAME_ENVS);
const parseGameLine = (line) => L.parseGameLine(line);
const gameLineSrc = (l) => L.gameLineSrc(l);

function openFigure(seg) {
  FV.seg = seg;
  // with any caption edit made since; while the diff view shows marks in the
  // page, the source it was compared with
  FV.src = DIFF_SHOWN ? (seg.diffSrc !== undefined ? seg.diffSrc : seg.src) : segSource(seg, [], null, false);
  FV.orig = FV.src;      // what the figure was when opened: Apply compares with this
  FV.games = parseGames(FV.src);
  FV.tables = L.parseTabulars(FV.src);
  FV.undo = []; FV.redo = []; FV.lastEditor = null; FV.dragIndex = -1;
  $('#fv-title').textContent = (seg.kind === 'figure' ? 'Figure ' : 'Table ') + (seg.el.querySelector('.capnum')?.textContent || '');
  $('#fv-games-tab').hidden = !FV.games.length;
  $('#fv-cells-tab').hidden = !FV.tables.length;
  $('#figview').hidden = false;
  // the diff view carries on in the window: it opens on what changed
  showFigTab(DIFF.on ? 'changes' : FV.games.length ? 'games' : FV.tables.length ? 'cells' : 'image');
}

function showFigTab(tab) {
  dropFigureDrawer();   // the tab is drawn again: its chips are replaced
  // leaving the LaTeX tab keeps what was typed there: it becomes the draft
  // the other tabs show (it used to be dropped, and Apply then wrote nothing)
  if (FV.tab === 'latex' && tab !== 'latex' && FV.latexEdited) {
    const ta = $('#fv-body textarea');
    if (ta) {
      FV.latexEdited = false;
      gameCheckpoint();                 // the draft before the LaTeX edit, for Undo
      FV.src = ta.value;
      FV.games = parseGames(FV.src);
      FV.tables = L.parseTabulars(FV.src);
      FV.lastEditor = null;
    }
  }
  FV.tab = tab;
  updateGameActions();
  for (const b of document.querySelectorAll('.fv-tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  const body = $('#fv-body');
  body.textContent = '';
  const url = DOC.figs[FV.seg.src];
  if (tab === 'image') {
    if (url) { const img = el('img'); img.src = url; body.append(img); }
    else body.append(el('div', 'small', 'No image yet (rendered after the next build).'));
    const cap = FV.seg.el.querySelector('.caption');
    if (cap) body.append(el('p', '', cap.textContent));
  } else if (tab === 'text') {
    const pre = el('pre', 'figtext', 'Loading…');
    body.append(pre);
    if (url) fetch('/figtext/' + url.match(/([0-9a-f]{16})\.png$/)[1]).then((r) => r.json())
      .then((j) => { pre.textContent = j.text || '(no text in this figure)'; });
    else pre.textContent = 'No text yet (extracted after the next build).';
  } else if (tab === 'latex') {
    const ta = el('textarea', 'fv-src');
    ta.value = FV.src; ta.spellcheck = false;
    ta.oninput = () => { FV.latexEdited = true; };
    body.append(ta);
  } else if (tab === 'games') {
    renderGames(body);
  } else if (tab === 'cells') {
    renderCells(body);
  } else if (tab === 'changes') {
    renderFigureChanges(body);
  }
}

// The figure's LaTeX now (with the draft edits of this window) against the
// last save, or the last commit when the diff view compares with it; the
// figure is found in the old file by its \label, else by its place.
async function renderFigureChanges(body) {
  const seg = FV.seg;
  const now = figureWithEdits();
  const ref = DIFF.on ? $('#diffbase').value : 'save';
  let old = seg.src;
  if (ref === 'head') {
    old = null;
    const r = await fetch(`/api/baseline?name=${encodeURIComponent(seg.file)}&ref=head`).catch(() => null);
    const text = r && r.ok ? (await r.json()).text : null;
    if (text !== null && text !== undefined) {
      const floats = parseFile(seg.file, text).filter((s) => s.kind === seg.kind);
      const lab = (src) => (/\\label\{([^}]*)\}/.exec(src) || [])[1];
      const mine = lab(seg.src) || lab(now);
      const same = floats.find((s) => mine && lab(s.src) === mine) ||
        floats[ORDER.filter((s) => s.file === seg.file && s.kind === seg.kind).indexOf(seg)];
      old = same ? same.src : '';
    }
  }
  if (FV.tab !== 'changes' || FV.seg !== seg) return;   // another tab was chosen meanwhile
  body.textContent = '';
  const what = ref === 'head' ? 'the last commit' : 'the last save';
  if (old === null) { body.append(el('p', 'small', 'The file is not in the last commit.')); return; }
  if (old === now) { body.append(el('p', 'small', `No changes in this ${seg.kind} since ${what}.`)); return; }
  body.append(el('p', 'small', `Changes in this ${seg.kind} since ${what}` + (FV.undo.length ? ', with the edits made here (not applied yet)' : '') + ':'));
  const pre = el('pre', 'hist-diff', '');
  lineDiff(old, now, pre);
  body.append(pre);
}

// Draft-only undo history: source remains untouched until Apply, then Save.
function updateGameActions() {
  // games and table cells share one draft history
  const editing = !!FV.seg && (FV.tab === 'games' || FV.tab === 'cells');
  for (const id of ['#fv-undo', '#fv-redo']) $(id).hidden = !editing;
  $('#fv-add-game').hidden = !FV.seg || FV.tab !== 'games';
  $('#fv-undo').disabled = !editing || !FV.undo.length;
  $('#fv-redo').disabled = !editing || !FV.redo.length;
  $('#fv-add-game').disabled = !editing || !FV.games.some((g) => g.kind === 'algo' && g.env === 'gameenv');
  $('#fv-status').textContent = editing && FV.undo.length ? 'Draft changed - Apply to use edits' : '';
}
function gameCheckpoint(editor = null) {
  if (editor && FV.lastEditor === editor) return;
  const current = figureWithEdits();
  if (FV.undo[FV.undo.length - 1] !== current) {
    FV.undo.push(current);
    if (FV.undo.length > 100) FV.undo.shift();
  }
  FV.redo = [];
  FV.lastEditor = editor;
  updateGameActions();
}
// The editable fields of the window (game lines, titles, cells), in order.
const fvFields = () => [...document.querySelectorAll('#fv-body [contenteditable=true]')];
function setGameDraft(src, restoreFocus = false) {
  // the window is drawn again: keep the cursor in the same field, and show
  // which lines changed (an undo is otherwise hard to see)
  const fields = fvFields();
  const at = fields.indexOf(document.activeElement);
  const before = new Map();
  for (const f of fields) before.set(f.textContent, (before.get(f.textContent) || 0) + 1);
  FV.src = src;
  FV.games = parseGames(src);
  FV.tables = L.parseTabulars(src);
  FV.latexEdited = false;
  FV.lastEditor = null;
  showFigTab(FV.tab === 'cells' ? 'cells' : 'games');
  if (!restoreFocus) return;
  const now = fvFields();
  for (const f of now) {
    const n = before.get(f.textContent) || 0;
    if (n) before.set(f.textContent, n - 1);
    else { const row = f.closest('.gline, td') || f; row.classList.add('fv-flash'); setTimeout(() => row.classList.remove('fv-flash'), 900); }
  }
  const f = at >= 0 && now[Math.min(at, now.length - 1)];
  if (f) {
    f.focus();
    const r = document.createRange(); r.selectNodeContents(f); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  }
}
function undoGame() {
  if (!FV.undo.length) { toast('Nothing to undo'); return; }
  FV.redo.push(figureWithEdits());
  setGameDraft(FV.undo.pop(), true);
  toast('Undone (in this window)');
}
function redoGame() {
  if (!FV.redo.length) { toast('Nothing to redo'); return; }
  FV.undo.push(figureWithEdits());
  setGameDraft(FV.redo.pop(), true);
  toast('Redone (in this window)');
}
function changeGameSource(transform) {
  const current = figureWithEdits();
  const games = parseGames(current);
  const next = transform(current, games);
  if (next === current || typeof next !== 'string') return false;
  gameCheckpoint();
  setGameDraft(next);
  return true;
}
$('#fv-undo').onclick = undoGame;
$('#fv-redo').onclick = redoGame;

function gameSpan(g) {
  return g && Number.isInteger(g.start) && Number.isInteger(g.end) && g.end > g.start;
}
function gameMove(from, to) {
  return changeGameSource((src, games) => {
    if (from < 0 || to < 0 || from >= games.length || to >= games.length || from === to) return src;
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const selected = games.slice(lo, hi + 1);
    if (selected.some((g) => !gameSpan(g) || g.kind !== 'algo' || g.env !== 'gameenv')) {
      banner('Game movement requires sibling gameenv blocks.');
      return src;
    }
    const blocks = selected.map((g) => src.slice(g.start, g.end));
    const gaps = selected.slice(1).map((g, i) => src.slice(selected[i].end, g.start));
    if (gaps.some((x) => !/^(?:\s|%[^\n]*\n)*$/.test(x))) {
      banner('A LaTeX layout command separates the games; source order is unchanged.');
      return src;
    }
    const moved = blocks.splice(from - lo, 1)[0];
    blocks.splice(to - lo, 0, moved);
    let replacement = blocks[0];
    for (let i = 0; i < gaps.length; i++) replacement += gaps[i] + blocks[i + 1];
    return src.slice(0, selected[0].start) + replacement + src.slice(selected[selected.length - 1].end);
  });
}
function gameInsert(after) {
  return changeGameSource((src, games) => {
    const g = games[after];
    if (!gameSpan(g) || g.kind !== 'algo' || g.env !== 'gameenv') return src;
    const fresh = ['\\begin{gameenv}{New game}', '  \\State $x \\gets y$', '\\end{gameenv}'].join('\n');
    return src.slice(0, g.end) + '\n' + fresh + src.slice(g.end);
  });
}
function gameDuplicate(index) {
  return changeGameSource((src, games) => {
    const g = games[index];
    if (!gameSpan(g) || g.kind !== 'algo' || g.env !== 'gameenv') return src;
    return src.slice(0, g.end) + '\n' + src.slice(g.start, g.end) + src.slice(g.end);
  });
}
function gameRemove(index) {
  if (!confirm('Delete this game block? Undo works until Apply.')) return;
  return changeGameSource((src, games) => {
    const g = games[index];
    if (!gameSpan(g)) return src;
    return src.slice(0, g.start) + src.slice(g.end);
  });
}
$('#fv-add-game').onclick = () => gameInsert(FV.games.length - 1);

const GAME_COLORS = {
  none: 'No mark',
  'yellow!20': 'Yellow (change)',
  'cyan!20': 'Cyan (alternative)',
  'green!20': 'Green (checked)',
  'magenta!15': 'Magenta (important)',
};
function colorMarked(line) {
  return /^\\colorbox\{(yellow!20|cyan!20|green!20|magenta!15)\}\{([\s\S]*)\}$/.exec(line.content);
}
// xcolor, directly or through a package that loads it
const XCOLOR_RE = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:xcolor|tikz|pgf|tcolorbox|todonotes)\b[^}]*\}/;
function preambleSeg() {
  return ((FILES[DOC.main] || {}).segs || []).find((x) => x.kind === 'hidden' && x.src.includes('\\begin{document}'));
}
function hasXcolor() {
  const front = preambleSeg();
  return (front && front.patched !== undefined && XCOLOR_RE.test(front.patched)) ||
    Object.values(FILES).some((f) => XCOLOR_RE.test(f.text));
}
// Colour boxes need xcolor: offer to load it, as an ordinary edit (written on save, shown in Diff)
function offerXcolor() {
  const front = preambleSeg();
  if (!front) { banner('Colour marking needs \\usepackage{xcolor} in the preamble.'); return false; }
  if (!confirm('Colour marking needs the xcolor package, which this paper does not load.\n\n' +
    'Add \\usepackage{xcolor} to the preamble of ' + DOC.main + '? It is written when you save.')) return false;
  const src = front.patched !== undefined ? front.patched : front.src;
  const i = src.lastIndexOf('\\begin{document}');
  front.patched = src.slice(0, i) + '\\usepackage{xcolor}\n' + src.slice(i);
  front.touched = true;
  markEdited();
  toast('Added \\usepackage{xcolor} to the preamble: save to write it', 'ok');
  return true;
}
function gameChangeColor(line, color) {
  if (!line || line.raw || !Object.prototype.hasOwnProperty.call(GAME_COLORS, color)) return;
  const match = colorMarked(line);
  const bare = match ? match[2] : line.content;
  if (color !== 'none' && !hasXcolor() && !offerXcolor()) return;
  const result = color === 'none' ? bare : '\\colorbox{' + color + '}{' + bare + '}';
  if (result === line.content) return;
  gameCheckpoint();
  line.content = result;
  showFigTab('games');
}

// A reading preview of a figure made of games, from its source: shown in the
// paper after Apply, until the next build brings the typeset picture.  Only
// when games and layout (minipages, \hfill, the caption) are all there is.
function previewGames(src) {
  const games = parseGames(src);
  if (!games.length) return null;
  let rest = src;
  for (const g of [...games].reverse()) rest = rest.slice(0, g.start) + rest.slice(g.end);
  for (let m; (m = /\\caption\s*(\[[^\]]*\])?\s*\{/.exec(rest));) {
    const e = L.groupEnd(rest, m.index + m[0].length - 1);
    if (e < 0) return null;
    rest = rest.slice(0, m.index) + rest.slice(e);
  }
  rest = rest.replace(/%[^\n]*/g, '')
    .replace(/\\(begin|end)\{(figure\*?|minipage|center|subfigure|algorithm\*?)\}(\s*\[[^\]]*\])*(\s*\{[^{}]*\})*/g, '')
    .replace(new RegExp('\\\\(begin|end)\\{(' + ['multicols', ...multicolEnvs()].map((e) => e.replace(/\*/g, '\\*')).join('|') + ')\\}(\\s*\\{\\d+\\})?', 'g'), '')
    .replace(/\\(hfill|centering|quad|qquad|noindent|par|small|footnotesize|scriptsize|medskip|smallskip|bigskip|columnbreak|gamebreak|null)(?![A-Za-z])|\\mbox\{\}|\\\\/g, '')
    .replace(/\\([hv]space\*?|label)\s*\{[^{}]*\}/g, '');
  if (rest.trim()) return null;
  const wrap = el('div', 'game-preview');
  const math = (tex, into) => {
    try { katex.render(tex, into, { throwOnError: false, macros: { ...katexMacros(), ...CRYPTOCODE_MACROS } }); }
    catch (e) { into.textContent = tex; }
  };
  for (const g of games) {
    const box = el('div', 'gp-game');
    if (g.title) { const t = el('div', 'gp-title'); renderTokens(L.tokenize(g.title), t, {}); box.append(t); }
    let depth = 0, no = 0;
    for (const l of g.lines) {
      if (g.kind === 'proc') {
        if (!l.content.trim()) continue;
        const row = el('div', 'gp-line'); math(l.content.replace(/\\\\\s*$/, ''), row); box.append(row);
        continue;
      }
      if (l.raw) continue;   // blank lines and comments print nothing
      if (BLOCK_CLOSE.has(l.cmd) || l.cmd === 'ElsIf' || l.cmd === 'Else') depth = Math.max(0, depth - 1);
      const row = el('div', 'gp-line');
      row.append(el('span', 'gp-no', l.cmd === 'Statex' ? '' : ++no + ':'));
      const body = el('span', 'gp-body');
      body.style.paddingLeft = (depth * 1.2) + 'em';
      if (KW[l.kind]) body.append(el('b', '', KW[l.kind] + ' '));
      const mark = colorMarked(l);
      const text = el('span', mark ? 'gp-mark' : '');
      if (mark) text.dataset.mark = mark[1];
      // a two-way macro (\layoutchoice) shows as the page prints it
      const ch = !mark && choiceHead(l.content);
      const shown = ch ? topComment(choiceExpanded(ch.tail) || '') : null;
      renderTokens(L.tokenize(mark ? mark[2] : ch ? ch.head : l.content), text, {});
      body.append(text);
      if (shown && shown.comment !== null) { const cm = el('span', 'gp-comment', '▹ '); renderTokens(L.tokenize(shown.comment), cm, {}); body.append(cm); }
      if (/^(If|ElsIf)$/.test(l.cmd)) body.append(el('b', '', ' then'));
      if (/^(For|ForAll|While)$/.test(l.cmd)) body.append(el('b', '', ' do'));
      const c = /\\Comment\s*\{([^]*)\}/.exec(l.suffix || '');
      if (c) { const cm = el('span', 'gp-comment', '▹ '); renderTokens(L.tokenize(c[1]), cm, {}); body.append(cm); }
      row.append(body);
      box.append(row);
      if (BLOCK_OPEN.has(l.cmd) || l.cmd === 'ElsIf' || l.cmd === 'Else') depth++;
    }
    wrap.append(box);
  }
  // laid out as in the paper: a grid of cells, a cell a stack of games
  const lay = L.gameLayout(src, games, multicolEnvs());
  if (lay.ok && lay.cols > 1) {
    const boxes = [...wrap.children];
    wrap.textContent = '';
    wrap.classList.add('gp-grid');
    wrap.style.gridTemplateColumns = `repeat(${lay.cols}, minmax(0, max-content))`;
    for (const row of lay.rows) for (const cell of row) {
      const c = el('div', 'gp-cell');
      for (const gi of cell) c.append(boxes[gi]);
      wrap.append(c);
    }
  }
  return wrap;
}

// Environments of the paper that open multicols (\newenvironment{games}[1]{…
// \begin{multicols}{#1}…}): their argument is a number of columns.
function multicolEnvs() {
  const out = new Set();
  for (const f of Object.values(FILES)) {
    for (const m of (f.text || '').matchAll(/\\(?:re)?newenvironment\*?\s*\{([A-Za-z*]+)\}/g))
      if (/\\begin\{multicols\}/.test(f.text.slice(m.index, m.index + 400))) out.add(m[1]);
  }
  return [...out];
}
// Change the arrangement of the games: `change(rows, cols)` edits the rows
// (cells of game indexes) in place and returns the number of columns.
function arrangeGames(change) {
  return changeGameSource((src, games) => {
    const lay = L.gameLayout(src, games, multicolEnvs());
    if (!lay.ok) { banner('The games cannot be arranged here (' + lay.reason + '); arrange them in the LaTeX tab.'); return src; }
    const rows = lay.rows.map((r) => r.map((c) => c.slice()));
    const cols = change(rows, lay.cols);
    if (!cols) return src;
    return L.writeGameLayout(src, games, lay, cols, rows);
  });
}
function findGame(rows, gi) {
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < rows[r].length; c++) {
      const k = rows[r][c].indexOf(gi);
      if (k >= 0) return { r, c, k };
    }
  return null;
}
// put game gi in row r, column c, at place k of its stack (the end if omitted);
// a row past the last is a new one
function placeGame(gi, r, c, k) {
  return arrangeGames((rows, cols) => {
    const from = findGame(rows, gi);
    if (!from) return 0;
    while (rows.length <= r) rows.push(Array.from({ length: cols }, () => []));
    const cell = rows[r][c];
    if (!cell) return 0;
    rows[from.r][from.c].splice(from.k, 1);
    if (cell === rows[from.r][from.c] && k !== undefined && k > from.k) k--;
    cell.splice(k === undefined ? cell.length : Math.max(0, Math.min(k, cell.length)), 0, gi);
    return cols;
  });
}
function stepGame(gi, dr, dc) {
  const lay = L.gameLayout(figureWithEdits(), parseGames(figureWithEdits()), multicolEnvs());
  const at = lay.ok && findGame(lay.rows, gi);
  if (!at) return;
  if (dc) return placeGame(gi, at.r, at.c + dc, at.k);
  const stack = lay.rows[at.r][at.c];
  if (at.k + dr >= 0 && at.k + dr < stack.length) return placeGame(gi, at.r, at.c, at.k + dr + (dr > 0 ? 1 : 0));
  if (dr < 0) return at.r > 0 && placeGame(gi, at.r - 1, at.c);
  return placeGame(gi, at.r + 1, at.c, 0);
}
// another number of columns: the cells keep their order, row by row
function setGameColumns(n) {
  return arrangeGames((rows) => {
    let cells = rows.flat().filter((c) => c.length);
    if (n === 1) cells = cells.flat().map((g) => [g]);
    rows.length = 0;
    for (let i = 0; i < cells.length; i += n) rows.push(cells.slice(i, i + n));
    return n;
  });
}

function gameBox(g, gi, lay, at) {
  const box = el('div', 'game' + (g.kind === 'proc' ? ' gproc' : ''));
  box.dataset.game = gi;
  const head = el('div', 'game-title');
  if (g.title !== null) {
    const t = el('span'); t.contentEditable = 'true';
    renderTokens(L.tokenize(g.title), t, {});
    t.addEventListener('input', () => { gameCheckpoint(t); g.newTitle = ser(t); });
    t.addEventListener('blur', () => { FV.lastEditor = null; });
    head.append(t);
  } else head.append(el('span', 'small', g.kind === 'proc' ? 'procedure' : g.env));
  const actions = el('span', 'game-actions');
  const action = (label, title, fn, cls = '') => {
    const b = el('button', cls, label); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
    b.onclick = fn; actions.append(b); return b;
  };
  if (at) {
    const rows = lay.rows, stack = rows[at.r][at.c];
    action('←', 'Move to the cell on the left', () => stepGame(gi, 0, -1), 'gmove').disabled = at.c === 0;
    action('→', 'Move to the cell on the right', () => stepGame(gi, 0, 1), 'gmove').disabled = at.c >= lay.cols - 1;
    action('↑', 'Move up: above the game over it, or into the row above', () => stepGame(gi, -1, 0), 'gmove').disabled = at.r === 0 && at.k === 0;
    action('↓', 'Move down: below the game under it, or into the row below (a new row after the last)', () => stepGame(gi, 1, 0), 'gmove')
      .disabled = at.r === rows.length - 1 && stack.length === 1 && rows[at.r].every((c, k) => k === at.c || !c.length);
    const handle = el('span', 'game-drag', '⠿');
    handle.title = 'Drag onto a cell of the grid (or onto a game, to go above it)';
    handle.draggable = true;
    handle.addEventListener('dragstart', (e) => {
      FV.dragIndex = gi;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(gi));
      box.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => { FV.dragIndex = -1; box.classList.remove('dragging'); });
    actions.append(handle);
    // a game dropped on this one goes above it, in its cell
    box.addEventListener('dragover', (e) => { if (FV.dragIndex >= 0 && FV.dragIndex !== gi) { e.preventDefault(); e.stopPropagation(); box.classList.add('drop-above'); } });
    box.addEventListener('dragleave', () => box.classList.remove('drop-above'));
    box.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      box.classList.remove('drop-above');
      const from = FV.dragIndex; FV.dragIndex = -1;
      if (from >= 0 && from !== gi) placeGame(from, at.r, at.c, at.k);
    });
  }
  action('Copy', 'Duplicate this game block', () => gameDuplicate(gi)).disabled = g.kind !== 'algo' || g.env !== 'gameenv';
  action('Delete', 'Remove this game block', () => gameRemove(gi));
  head.append(actions);
  box.append(head);
  let depth = 0, no = 0;
  const boxes = [];   // the open \BeginBox regions: their colours
  g.lines.forEach((l, li) => {
    if (g.kind === 'proc') { box.append(procLine(g, l, li)); return; }
    // the empty lines a body starts and ends with (\begin{...}\n ... \n\end): not shown
    if (l.raw && !l.prefix.trim() && (li === 0 || li === g.lines.length - 1)) return;
    if (BLOCK_CLOSE.has(l.cmd) || l.cmd === 'ElsIf' || l.cmd === 'Else') depth = Math.max(0, depth - 1);
    const begin = l.raw && /^\s*\\BeginBox\b/.test(l.prefix), end = l.raw && /^\s*\\EndBox\b/.test(l.prefix);
    if (begin) boxes.push(boxColor(l.prefix));
    // numbered as in the paper: \Statex, comments and box marks get no number
    const row = algoLine(g, l, li, depth, l.raw || l.cmd === 'Statex' ? '' : String(++no));
    if (boxes.length) { row.classList.add('in-gbox'); row.style.setProperty('--gbox', boxes[boxes.length - 1]); }
    box.append(row);
    if (end) boxes.pop();
    if (BLOCK_OPEN.has(l.cmd) || l.cmd === 'ElsIf' || l.cmd === 'Else') depth++;
  });
  return box;
}

function renderGames(body) {
  const src = figureWithEdits();
  const lay = L.gameLayout(src, parseGames(src), multicolEnvs());
  if (!lay.ok) {
    const grid = el('div', 'games-grid');
    FV.games.forEach((g, gi) => grid.append(gameBox(g, gi, lay, null)));
    body.append(el('p', 'small', 'These games cannot be arranged here (' + lay.reason + '): arrange them in the LaTeX tab.'), grid);
  } else {
    const bar = el('div', 'games-layout');
    bar.append(el('span', 'small', 'Columns'));
    for (let n = 1; n <= 4; n++) {
      const b = el('button', '', String(n)); b.type = 'button';
      b.title = n === 1 ? 'One game under another' : `A grid of ${n} columns (minipages side by side)`;
      b.setAttribute('aria-pressed', String(lay.cols === n));
      b.onclick = () => { if (lay.cols !== n) setGameColumns(n); };
      bar.append(b);
    }
    bar.append(el('span', 'small', 'Drag ⠿ or use the arrows to place games in the grid; a cell can hold several games, one under the other.'));
    body.append(bar);
    const grid = el('div', 'games-grid games-cells');
    grid.style.gridTemplateColumns = `repeat(${lay.cols}, minmax(0, 1fr))`;
    const cell = (r, c, games, fresh) => {
      const d = el('div', 'gcell' + (games.length ? '' : ' empty') + (fresh ? ' fresh' : ''));
      if (!games.length) d.append(el('div', 'gcell-hint', fresh ? 'Drop here: a new row' : 'Empty: drop a game here'));
      for (const gi of games) d.append(gameBox(FV.games[gi], gi, lay, { r, c, k: games.indexOf(gi) }));
      d.addEventListener('dragover', (e) => { if (FV.dragIndex >= 0) { e.preventDefault(); d.classList.add('drop'); } });
      d.addEventListener('dragleave', (e) => { if (!d.contains(e.relatedTarget)) d.classList.remove('drop'); });
      d.addEventListener('drop', (e) => {
        e.preventDefault(); d.classList.remove('drop');
        const from = FV.dragIndex; FV.dragIndex = -1;
        if (from >= 0) placeGame(from, r, c);
      });
      return d;
    };
    lay.rows.forEach((row, r) => row.forEach((games, c) => grid.append(cell(r, c, games, false))));
    if (lay.cols > 1) for (let c = 0; c < lay.cols; c++) grid.append(cell(lay.rows.length, c, [], true));
    body.append(grid);
  }
  body.append(el('p', 'small', 'Enter: a new statement. Backspace on an empty line or Ctrl+Shift+K: delete the line (a whole block from its first or last line). ' +
    'Box: put a line in a box or take it out; click the edge of a box to restyle, grow, shrink or remove it. Up/Down also move a line into or out of a box. ' +
    'Add: insert common statements, conditions and loops. Up/Down or Alt+Up/Down: reorder safe statements. ' +
    'Mark: coloured xcolor boxes. Ctrl+Z/Ctrl+Shift+Z: undo/redo; Ctrl+Enter: Apply; Ctrl+S: Apply and Save. ' +
    'Changes are not written until Apply, then Save.'));
}

function gameMoveLine(g, index, offset) {
  const line = g.lines[index];
  let otherIndex = index + offset;
  while (g.lines[otherIndex] && g.lines[otherIndex].raw && !g.lines[otherIndex].prefix.trim())
    otherIndex += offset;
  const other = g.lines[otherIndex];
  // a statement steps over the edge of a box (into it or out of it), and an
  // edge steps over a statement (the box grows or shrinks)
  const lineBox = boxMarker(line), otherBox = boxMarker(other);
  if (line && other && (lineBox || otherBox) && !(lineBox && otherBox) &&
      !(lineBox ? other : line).raw && !(lineBox && (BLOCK_OPEN.has(other.cmd) || BLOCK_CLOSE.has(other.cmd)))) {
    gameCheckpoint();
    const [moved] = g.lines.splice(index, 1);
    g.lines.splice(otherIndex, 0, moved);
    showFigTab('games');
    return { to: otherIndex };
  }
  if (!line || !other || line.raw || other.raw ||
      BLOCK_OPEN.has(line.cmd) || BLOCK_CLOSE.has(line.cmd) ||
      BLOCK_OPEN.has(other.cmd) || BLOCK_CLOSE.has(other.cmd) ||
      ['Else', 'ElsIf'].includes(line.cmd) || ['Else', 'ElsIf'].includes(other.cmd)) {
    banner('Only ordinary statements can move without breaking control-flow blocks.');
    return false;
  }
  gameCheckpoint();
  const [moved] = g.lines.splice(index, 1);
  g.lines.splice(otherIndex, 0, moved);
  showFigTab('games');
  return { to: otherIndex };
}

// algpseudocodex's boxes (\BeginBox[gbox=one] … \EndBox): a line that is one
// of their edges, its kind and options
const BOX_RE = /^\s*\\(BeginBox|EndBox)(?![A-Za-z])(?:\[([^\]]*)\])?/;
function boxMarker(l) {
  const m = l && l.raw && BOX_RE.exec(l.prefix);
  return m ? { kind: m[1], opts: m[2] || '' } : null;
}
// the boxes of a game: the indexes of their \BeginBox and \EndBox lines
function boxPairs(g) {
  const out = [], open = [];
  g.lines.forEach((l, k) => {
    const b = boxMarker(l);
    if (b && b.kind === 'BeginBox') open.push(k);
    else if (b && open.length) out.push({ begin: open.pop(), end: k });
  });
  return out;
}
// the innermost box that line li is in (or that it is an edge of)
function boxAround(g, li) {
  let best = null;
  for (const p of boxPairs(g)) if (p.begin <= li && li <= p.end && (!best || p.end - p.begin < best.end - best.begin)) best = p;
  return best;
}
// The box options the paper uses (gbox=one, gbox=two, …), in order of first
// use; '' is a box without options. Empty when the paper has no boxes and
// does not load algpseudocodex, which defines them.
function gameBoxStyles() {
  const seen = new Set();
  const texts = [figureWithEdits(), ...Object.values(FILES).map((f) => f.text || '')];
  for (const t of texts) for (const m of t.matchAll(/\\BeginBox(?![A-Za-z])(?:\[([^\]]*)\])?/g)) seen.add(m[1] || '');
  if (!seen.size && texts.some((t) => /\\usepackage(\[[^\]]*\])?\{[^}]*algpseudocodex/.test(t))) seen.add('');
  return [...seen];
}
const boxLabel = (opts) => opts ? opts.replace(/^\w+=/, '') : 'plain';
const blankLine = (l) => l.raw && !l.prefix.trim();
// The lines a statement takes: a block (if … end if) from its first line or
// its last, an else branch up to the next branch or the end of the block
function lineSpan(g, li) {
  const l = g.lines[li];
  const open = (x) => BLOCK_OPEN.has(x.cmd), close = (x) => BLOCK_CLOSE.has(x.cmd);
  if (open(l) || l.cmd === 'Else' || l.cmd === 'ElsIf') {
    let depth = 0;
    for (let k = li + 1; k < g.lines.length; k++) {
      const x = g.lines[k];
      if (open(x)) depth++;
      else if (close(x)) { if (depth === 0) return open(l) ? [li, k] : [li, k - 1]; depth--; }
      else if (depth === 0 && !open(l) && (x.cmd === 'Else' || x.cmd === 'ElsIf')) return [li, k - 1];
    }
  } else if (close(l)) {
    let depth = 0;
    for (let k = li - 1; k >= 0; k--) {
      const x = g.lines[k];
      if (close(x)) depth++;
      else if (open(x)) { if (depth === 0) return [k, li]; depth--; }
    }
  }
  return [li, li];
}
// boxes left with nothing in them go
function dropEmptyBoxes(g) {
  for (let again = true; again;) {
    again = false;
    for (const p of boxPairs(g)) {
      if (g.lines.slice(p.begin + 1, p.end).every(blankLine)) { g.lines.splice(p.begin, p.end - p.begin + 1); again = true; break; }
    }
  }
}
const cloneLine = (l) => parseGameLine(gameLineSrc(l));
// put line li (with its block) in a new box
function gameBoxWrap(g, li, opts) {
  const [a, b] = lineSpan(g, li);
  const indent = /^\s*/.exec(g.lines[a].prefix)[0];
  gameCheckpoint();
  g.lines.splice(b + 1, 0, parseGameLine(indent + '\\EndBox'));
  g.lines.splice(a, 0, parseGameLine(indent + '\\BeginBox' + (opts ? '[' + opts + ']' : '')));
  showFigTab('games');
  return a + 1;
}
// take line li (with its block) out of its box: the box closes before it and
// opens again after it, as far as it has lines there
function gameBoxTakeOut(g, li) {
  const p = boxAround(g, li);
  if (!p) return li;
  const [a, b] = lineSpan(g, li);
  if (a <= p.begin || b >= p.end) { banner('This block starts or ends outside the box: change the box in the LaTeX tab.'); return li; }
  gameCheckpoint();
  const begin = g.lines[p.begin], end = g.lines[p.end];
  const before = g.lines.slice(p.begin + 1, a), mid = g.lines.slice(a, b + 1), after = g.lines.slice(b + 1, p.end);
  const out = [];
  if (before.every(blankLine)) out.push(...before); else out.push(begin, ...before, cloneLine(end));
  const at = p.begin + out.length;
  out.push(...mid);
  if (after.every(blankLine)) out.push(...after); else out.push(cloneLine(begin), ...after, end);
  g.lines.splice(p.begin, p.end - p.begin + 1, ...out);
  showFigTab('games');
  return at;
}
// remove the box with an edge at li; its lines stay, or go too
function gameBoxRemove(g, li, withLines = false) {
  const p = boxAround(g, li);
  if (!p) return li;
  gameCheckpoint();
  if (withLines) g.lines.splice(p.begin, p.end - p.begin + 1);
  else { g.lines.splice(p.end, 1); g.lines.splice(p.begin, 1); }
  showFigTab('games');
  return p.begin;
}
function gameBoxRestyle(g, li, opts) {
  const l = g.lines[li];
  if (!boxMarker(l) || boxMarker(l).kind !== 'BeginBox') return;
  gameCheckpoint();
  g.lines[li] = parseGameLine(l.prefix.replace(/\\BeginBox(\[[^\]]*\])?/, '\\BeginBox' + (opts ? '[' + opts + ']' : '')));
  showFigTab('games');
}
// Delete line li in one step: a block goes whole (if … end if), the edge of a
// box removes the box and keeps its lines, and a box left empty goes too.
// The index of the line to go on editing.
function gameDeleteLine(g, li) {
  if (boxMarker(g.lines[li])) return gameBoxRemove(g, li);
  const [a, b] = lineSpan(g, li);
  gameCheckpoint();
  g.lines.splice(a, b - a + 1);
  dropEmptyBoxes(g);
  showFigTab('games');
  if (b > a) toast('Deleted the whole block (' + (b - a + 1) + ' lines): Ctrl+Z restores it');
  return a - 1;
}
// a new empty statement after line li (inside it, when it opens a block)
function gameNewLine(g, li) {
  const l = g.lines[li];
  const indent = /^\s*/.exec(l.prefix)[0] + (BLOCK_OPEN.has(l.cmd) || l.cmd === 'Else' || l.cmd === 'ElsIf' ? '  ' : '');
  gameCheckpoint();
  g.lines.splice(li + 1, 0, parseGameLine(indent + '\\State '));
  showFigTab('games');
  return li + 1;
}
// the cursor in the editable line nearest to li (at or before it, else after)
function focusGameLine(g, li, atEnd = true) {
  const gi = FV.games.indexOf(g);
  let best = null;
  for (const r of document.querySelectorAll(`#fv-body .gline[data-game="${gi}"]`)) {
    const t = r.querySelector('.gtext[contenteditable=true]') || (r.tabIndex >= 0 ? r : null);
    if (!t) continue;
    if (+r.dataset.line <= li) best = t;
    else { if (!best) best = t; break; }
  }
  if (!best) return;
  best.focus();
  if (best.isContentEditable) {
    const r = document.createRange(); r.selectNodeContents(best); r.collapse(!atEnd);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  }
}

// A \Comment of a game line as the paper prints it: maths, dashes, colours.
function gameComment(src) {
  const c = el('span', 'gcomment');
  c.append('\u25b9 ');
  renderTokens(L.tokenize(src), c, {});
  for (const n of c.querySelectorAll('[contenteditable]')) n.contentEditable = 'false';
  return c;
}
// The colour of \BeginBox[gbox=one]: a TikZ style of the paper that draws in
// a colour named after its argument (gbox/.style={draw=g#1}: gone), or draw=…
function boxColor(prefix) {
  const opts = (/\[([^\]]*)\]/.exec(prefix) || [])[1] || '';
  const styles = ((DOC && DOC.colors) || {}).styles || {};
  for (const part of opts.split(',')) {
    const [k, v] = part.split('=').map((x) => (x || '').trim());
    if (styles[k] !== undefined) { const c = colorOf(styles[k].replace(/#1/g, v || '')); if (c) return c; }
    if ((k === 'draw' || k === 'color') && colorOf(v)) return colorOf(v);
  }
  return 'var(--accent)';
}
// A macro of the paper that picks one of its arguments by an \if
// (\newcommand{\layoutchoice}[2]{\ifmobile#1\else#2\fi}): the text with it
// replaced by the branch the paper prints (the \if is false unless the
// preamble sets it true); null when there is none.
function choiceExpanded(src) {
  let changed = false, s = String(src), guard = 0;
  for (;;) {
    let hit = false;
    for (const [name, body] of Object.entries(DOC.macros || {})) {
      // (the server may have dropped the branch that is off: \ifmobile\else#2\fi)
      const m = /^\s*\\if([A-Za-z@]+)\s*(?:#(\d))?\s*\\else\s*(?:#(\d))?\s*\\fi\s*$/.exec(body);
      if (!m) continue;
      const at = s.indexOf(name + '{');
      if (at < 0 || /[A-Za-z@]/.test(s[at + name.length]) ) continue;
      const a = at + name.length, ae = L.groupEnd(s, a);
      if (ae < 0 || s[ae] !== '{') continue;
      const be = L.groupEnd(s, ae);
      if (be < 0) continue;
      const args = [s.slice(a + 1, ae - 1), s.slice(ae + 1, be - 1)];
      const on = new RegExp('\\\\' + m[1] + 'true\\b').test(FILES[DOC.main] ? FILES[DOC.main].text.split('\\begin{document}')[0] : '');
      const pick = on ? m[2] : m[3];
      s = s.slice(0, at) + (pick ? args[+pick - 1] : '') + s.slice(be);
      hit = changed = true;
      if (++guard > 20) return s;
    }
    if (!hit) break;
  }
  return changed ? s : null;
}
// The two-way macros of the paper (\layoutchoice{phone}{page}) used in s,
// with where the first one starts
function choiceAt(s) {
  let best = null;
  for (const [name, body] of Object.entries(DOC.macros || {})) {
    if (!/^\s*\\if[A-Za-z@]+\s*(?:#\d)?\s*\\else\s*(?:#\d)?\s*\\fi\s*$/.test(body)) continue;
    for (let at = s.indexOf(name + '{'); at >= 0; at = s.indexOf(name + '{', at + 1)) {
      if (/[A-Za-z@]/.test(s[at + name.length])) continue;
      if (!best || at < best.at) best = { at, name };
      break;
    }
  }
  return best;
}
function choiceName(s) { const c = choiceAt(s); return c ? c.name : 'a layout macro'; }
// A line that is a statement and then a two-way macro: the statement (to
// edit) and the rest from the macro on, with the % and line break before it
function choiceHead(s) {
  const c = choiceAt(String(s));
  if (!c) return null;
  const m = /%?\s*$/.exec(s.slice(0, c.at));
  const cut = m ? m.index : c.at;
  const head = s.slice(0, cut), tail = s.slice(cut);
  if (!head.trim() || choiceAt(head) || choiceExpanded(tail) === null) return null;
  // braces must pair up on both sides
  let depth = 0;
  for (let k = 0; k < head.length; k++) { if (head[k] === '\\') { k++; continue; } if (head[k] === '{') depth++; if (head[k] === '}') depth--; }
  return depth === 0 ? { head, tail } : null;
}
// A text split at its top-level \Comment{…}
function topComment(s) {
  for (let k = 0, depth = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && depth === 0 && /^\\Comment\s*\{/.test(s.slice(k))) {
      const open = s.indexOf('{', k), e = L.groupEnd(s, open);
      return { text: s.slice(0, k).trim(), comment: s.slice(open + 1, e - 1) };
    }
    if (ch === '\\') { k++; continue; }
    if (ch === '{') depth++; else if (ch === '}') depth--;
  }
  return { text: s, comment: null };
}

function algoLine(g, l, li, depth, no = String(li + 1)) {
  const row = el('div', 'gline');
  row.dataset.game = String(FV.games.indexOf(g)); row.dataset.line = String(li);
  row.append(el('span', 'gno', no));
  const pad = el('span'); pad.style.width = (depth * 1.4) + 'em'; pad.style.flex = 'none';
  row.append(pad);
  const boxMark = l.raw && /^\s*\\(BeginBox|EndBox)\b(?:\[([^\]]*)\])?/.exec(l.prefix);
  if (boxMark) {
    // algpseudocodex's boxes: a band beside the lines, in its colour
    row.classList.add(boxMark[1] === 'BeginBox' ? 'gbox-begin' : 'gbox-end');
    row.title = l.prefix.trim() + ': click for the box tools';
    row.tabIndex = 0;
    if (boxMark[1] === 'BeginBox') row.append(el('span', 'gbox-label', boxMark[2] ? boxMark[2].replace(/^\w+=/, '') : 'box'));
    row.append(boxTools(g, li));
    return row;
  } else if (l.raw) {
    row.append(el('code', 'gcomment', l.prefix.trim() || ' '));
  } else if (choiceHead(l.content)) {
    // a statement followed by a two-way macro (\State $L\assign…$%
    // \layoutchoice{\Statex…}{\Comment{…}}): the statement is edited here,
    // the macro is kept as it is and shown as the page prints it
    const { head, tail } = choiceHead(l.content);
    if (KW[l.kind]) row.append(el('span', 'gkw', KW[l.kind]));
    const t = el('span', 'gtext'); t.contentEditable = 'true';
    renderTokens(L.tokenize(head), t, {});
    t.addEventListener('input', () => {
      gameCheckpoint(t);
      l.content = ser(t) + tail;
      row.classList.add('edited');
    });
    t.addEventListener('blur', () => { FV.lastEditor = null; });
    row.append(t);
    const shown = topComment(choiceExpanded(tail) || '');
    const rest = el('span', 'gtext readonly');
    rest.title = 'This part chooses between layouts (' + choiceName(tail) + '): edit it in the LaTeX tab';
    renderTokens(L.tokenize(shown.text.replace(/^\s*%?\s*/, '').replace(/^\\Statex\b/, '')), rest, {});
    row.append(rest);
    if (shown.comment !== null) row.append(gameComment(shown.comment));
  } else if (choiceExpanded(l.content) !== null) {
    // a line with a two-way macro (\layoutchoice{phone}{page}): shown as the
    // page prints it; its LaTeX is edited in the LaTeX tab
    const shown = choiceExpanded(l.content);
    const split = topComment(shown);
    if (KW[l.kind]) row.append(el('span', 'gkw', KW[l.kind]));
    const t = el('span', 'gtext readonly');
    t.title = 'This line chooses between layouts (' + choiceName(l.content) + '): edit it in the LaTeX tab';
    renderTokens(L.tokenize(split.text), t, {});
    row.append(t);
    if (split.comment !== null) row.append(gameComment(split.comment));
  } else {
    if (KW[l.kind]) row.append(el('span', 'gkw', KW[l.kind]));
    const t = el('span', 'gtext'); t.contentEditable = 'true';
    const existingMark = colorMarked(l);
    if (existingMark) {
      row.classList.add('game-marked');
      row.dataset.mark = existingMark[1];
      renderTokens(L.tokenize(existingMark[2]), t, {});
    } else renderTokens(L.tokenize(l.content), t, {});
    t.addEventListener('input', () => {
      gameCheckpoint(t);
      const newText = ser(t);
      l.content = existingMark ? '\\colorbox{' + existingMark[1] + '}{' + newText + '}' : newText;
      row.classList.add('edited');
    });
    t.addEventListener('blur', () => { FV.lastEditor = null; });
    row.append(t);
    const cm = suffixComment(l);
    if (cm) row.append(editableComment(g, l, row));
  }
  const tools = el('span', 'gtools');
  const indent = /^\s*/.exec(l.prefix)[0];
  const inner = indent + (BLOCK_OPEN.has(l.cmd) || l.cmd === 'Else' || l.cmd === 'ElsIf' ? '  ' : '');
  const choices = {
    State: [inner + '\\State $x \\gets y$'],
    If: [inner + '\\If{$c$}', inner + '  \\State $x \\gets y$', inner + '\\EndIf'],
    While: [inner + '\\While{$c$}', inner + '  \\State $x \\gets y$', inner + '\\EndWhile'],
    For: [inner + '\\For{$i=0$ to $n$}', inner + '  \\State $x \\gets y$', inner + '\\EndFor'],
    Repeat: [inner + '\\Repeat', inner + '  \\State $x \\gets y$', inner + '\\Until{$c$}'],
    Else: [inner + '\\Else', inner + '  \\State $x \\gets y$'],
    Return: [inner + '\\State \\Return $x$'],
    Comment: [inner + '\\State \\Comment{explain the change}'],
    Assert: [inner + '\\State \\textbf{assert} $P$'],
  };
  const addChoice = el('select', 'g-insert');
  addChoice.title = 'Choose a statement or control-flow block to insert after this line';
  for (const label of Object.keys(choices)) {
    const option = el('option', '', label); option.value = label; addChoice.append(option);
  }
  const add = el('button', '', '+ Add');
  add.title = 'Insert the selected command after this line';
  add.onclick = () => {
    gameCheckpoint();
    g.lines.splice(li + 1, 0, ...choices[addChoice.value].map(parseGameLine));
    showFigTab('games');
  };
  const up = el('button', '', 'Up'); up.title = 'Move one ordinary statement up';
  up.disabled = li === 0; up.onclick = () => gameMoveLine(g, li, -1);
  const down = el('button', '', 'Down'); down.title = 'Move one ordinary statement down';
  down.disabled = li === g.lines.length - 1; down.onclick = () => gameMoveLine(g, li, 1);
  const mark = el('select', 'g-mark');
  mark.title = 'Wrap this line in a reversible coloured LaTeX box (xcolor required)';
  for (const [color, label] of Object.entries(GAME_COLORS)) {
    const option = el('option', '', label); option.value = color; mark.append(option);
  }
  mark.value = colorMarked(l) ? colorMarked(l)[1] : 'none';
  mark.disabled = l.raw;
  mark.onchange = () => gameChangeColor(l, mark.value);
  const del = el('button', '', 'Delete');
  del.title = BLOCK_OPEN.has(l.cmd) || BLOCK_CLOSE.has(l.cmd) ? 'Delete this whole block (Ctrl+Shift+K); Undo restores it'
    : 'Delete this line (Ctrl+Shift+K, or Backspace on an empty line); Undo restores it';
  del.onclick = () => focusGameLine(g, gameDeleteLine(g, li));
  tools.append(addChoice, add, up, down, mark);
  if (!l.raw) {
    const styles = gameBoxStyles(), around = boxAround(g, li);
    const box = el('select', 'g-box');
    box.title = 'Put this line in a box (\\BeginBox … \\EndBox), or take it out of its box';
    const opt = (value, label) => { const o = el('option', '', label); o.value = value; box.append(o); };
    opt('', 'Box…');
    for (const st of styles) opt('in:' + st, 'In a new box: ' + boxLabel(st));
    if (around) opt('out', 'Out of its box');
    box.disabled = box.options.length === 1;
    if (box.disabled) box.title = 'Boxes need algpseudocodex (\\BeginBox), which this paper does not load';
    box.onchange = () => {
      const v = box.value;
      focusGameLine(g, v === 'out' ? gameBoxTakeOut(g, li) : gameBoxWrap(g, li, v.slice(3)));
    };
    tools.append(box);
    if (!suffixComment(l) && !choiceHead(l.content) && choiceExpanded(l.content) === null && !BLOCK_CLOSE.has(l.cmd)) {
      const c = el('button', '', '▹ Comment'); c.title = 'Add a comment at the right of this line (\\Comment{…})';
      c.onclick = () => {
        gameCheckpoint();
        l.suffix = l.suffix.replace(/\s*$/, '') + ' \\Comment{}' + /\s*$/.exec(l.suffix)[0];
        showFigTab('games');
        const t = document.querySelector(`#fv-body .gline[data-game="${FV.games.indexOf(g)}"][data-line="${li}"] .gcomment-edit`);
        if (t) t.focus();
      };
      tools.append(c);
    }
  }
  tools.append(del);
  row.append(tools);
  return row;
}

// The tools of the edge of a box: its style, moving it, removing it.
function boxTools(g, li) {
  const tools = el('span', 'gtools');
  const b = boxMarker(g.lines[li]);
  if (b.kind === 'BeginBox') {
    const style = el('select', 'g-box');
    style.title = 'The style of this box';
    const styles = gameBoxStyles();
    if (!styles.includes(b.opts)) styles.push(b.opts);
    for (const st of styles) { const o = el('option', '', 'Style: ' + boxLabel(st)); o.value = st; style.append(o); }
    style.value = b.opts;
    style.onchange = () => { gameBoxRestyle(g, li, style.value); focusGameLine(g, li); };
    tools.append(style);
  }
  const step = (label, title, offset) => {
    const x = el('button', '', label); x.title = title;
    x.onclick = () => { const r = gameMoveLine(g, li, offset); if (r) focusGameLine(g, r.to); };
    tools.append(x);
  };
  if (b.kind === 'BeginBox') { step('Up', 'Grow the box by the line above', -1); step('Down', 'Shrink the box by its first line', 1); }
  else { step('Up', 'Shrink the box by its last line', -1); step('Down', 'Grow the box by the line below', 1); }
  const rm = el('button', '', 'Remove box'); rm.title = 'Remove this box and keep its lines (Delete or Backspace)';
  rm.onclick = () => focusGameLine(g, gameBoxRemove(g, li));
  const rmAll = el('button', '', 'Delete box and lines'); rmAll.title = 'Delete this box with the lines in it; Undo restores them';
  rmAll.onclick = () => focusGameLine(g, gameBoxRemove(g, li, true) - 1);
  tools.append(rm, rmAll);
  return tools;
}
// The \Comment{…} at the top level of a line's suffix: where its text is
function suffixComment(l) {
  const m = /\\Comment\s*\{/.exec(l.suffix || '');
  if (!m) return null;
  const open = m.index + m[0].length - 1, e = L.groupEnd(l.suffix, open);
  return e < 0 ? null : { start: open + 1, end: e - 1 };
}
// the comment of a line, edited in place
function editableComment(g, l, row) {
  const c = el('span', 'gcomment');
  c.append('\u25b9 ');
  const t = el('span', 'gcomment-edit'); t.contentEditable = 'true';
  const at = suffixComment(l);
  renderTokens(L.tokenize(l.suffix.slice(at.start, at.end)), t, {});
  t.title = 'The comment of this line (\\Comment); Backspace when it is empty removes it';
  t.addEventListener('input', () => {
    gameCheckpoint(t);
    const now = suffixComment(l);
    l.suffix = l.suffix.slice(0, now.start) + ser(t) + l.suffix.slice(now.end);
    row.classList.add('edited');
  });
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); return; }   // a comment is one line
    if (e.key !== 'Backspace' || e.ctrlKey || e.altKey || e.metaKey || ser(t).trim()) return;
    e.preventDefault(); e.stopPropagation();
    gameCheckpoint();
    const m = /\s*\\Comment\s*\{/.exec(l.suffix), now = suffixComment(l);
    l.suffix = l.suffix.slice(0, m.index) + l.suffix.slice(now.end + 1);
    const li = g.lines.indexOf(l);
    showFigTab('games');
    focusGameLine(g, li);
  });
  t.addEventListener('blur', () => { FV.lastEditor = null; });
  c.append(t);
  return c;
}

function procLine(g, l, li) {
  const row = el('div');
  const ta = el('textarea'); ta.rows = 1; ta.value = l.content; ta.spellcheck = false;
  const prev = el('div', 'gprev');
  const show = () => {
    prev.textContent = '';
    try { katex.render(l.content.replace(/\\\\\s*$/, ''), prev, { throwOnError: false, macros: { ...katexMacros(), ...CRYPTOCODE_MACROS } }); }
    catch (e) { prev.textContent = l.content; }
  };
  ta.oninput = () => { gameCheckpoint(ta); l.content = ta.value; show(); };
  ta.onblur = () => { FV.lastEditor = null; };
  show();
  const tools = el('div', 'gtools'); tools.style.opacity = 1;
  const b1 = el('button', '', '+ line'); b1.onclick = () => { gameCheckpoint(); g.lines.splice(li + 1, 0, { prefix: '', content: '', suffix: l.suffix || ' \\\\\n' }); if (!l.suffix) l.suffix = ' \\\\\n'; showFigTab('games'); };
  const b3 = el('button', '', 'Delete'); b3.onclick = () => { gameCheckpoint(); g.lines.splice(li, 1); showFigTab('games'); };
  tools.append(b1, b3);
  row.append(ta, prev, tools);
  return row;
}

function renderCells(body) {
  FV.tables.forEach((t) => {
    const ncols = Math.max(1, ...t.rows.map((r) => r.cells.length));
    const tbl = el('table', 'cells');
    t.rows.forEach((r, ri) => {
      if (r.lead.trim()) {   // rules above the row
        const tr = el('tr', 'rule');
        const td = el('td', 'rulecell', r.lead.trim().replace(/\s+/g, ' '));
        td.colSpan = ncols + 1;
        tr.append(td); tbl.append(tr);
      }
      if (r.empty) return;
      const tr = el('tr');
      r.cells.forEach((c) => {
        const td = el('td'); td.contentEditable = 'true';
        renderTokens(L.tokenize(c.content), td, {});
        td.addEventListener('input', () => { gameCheckpoint(td); c.content = ser(td); td.classList.add('edited'); });
        tr.append(td);
      });
      for (let k = r.cells.length; k < ncols; k++) tr.append(el('td'));
      const tools = el('td', 'rowtools');
      const add = el('button', '', '+ row'); add.title = 'Add an empty row below';
      add.onclick = () => {
        const nr = { lead: '', empty: false, rawRest: '', sep: r.sep || ' \\\\\n',
          cells: Array.from({ length: ncols }, (_, k) => ({ lead: k ? ' ' : '', content: '', trail: ' ' })) };
        if (!r.sep) r.sep = ' \\\\\n';
        gameCheckpoint(); t.rows.splice(ri + 1, 0, nr); showFigTab('cells');
      };
      const del = el('button', '', 'Delete'); del.title = 'Delete this row';
      del.onclick = () => { gameCheckpoint(); t.rows.splice(ri, 1); showFigTab('cells'); };
      tools.append(add, del);
      tr.append(tools);
      tbl.append(tr);
    });
    const col = el('button', '', '+ column');
    col.title = 'Add a column at the right (the column spec gets the same type as the last column)';
    col.onclick = () => {
      gameCheckpoint();
      for (const r of t.rows) if (!r.empty && r.cells.length) {
        const lastCell = r.cells[r.cells.length - 1];
        lastCell.trail = lastCell.trail || ' ';
        r.cells.push({ lead: ' ', content: '', trail: lastCell.trail });
        lastCell.trail = ' ';
      }
      const m = /([lcrX]|p\{[^}]*\})(@\{\}|\|)?\s*$/.exec(t.spec);
      t.spec = m ? t.spec.slice(0, m.index + m[1].length) + m[1] + t.spec.slice(m.index + m[1].length) : t.spec + 'l';
      t.specEdited = true;
      showFigTab('cells');
    };
    body.append(tbl, col);
  });
  body.append(el('p', 'small', 'Edit cells in place. Rules (\\toprule, \\hline …) stay with their rows; untouched cells keep their exact source. Apply, then save.'));
}

// The figure source with the edited games, cells (or the edited LaTeX).
function figureWithEdits() {
  if (FV.tab === 'latex' && FV.latexEdited) return $('#fv-body textarea').value;
  let src = FV.src;
  for (const t of [...(FV.tables || [])].reverse()) {
    src = src.slice(0, t.bodyStart) + L.tabularBody(t) + src.slice(t.bodyEnd);
    if (t.specEdited) src = src.slice(0, t.specRange[0]) + t.spec + src.slice(t.specRange[1]);
  }
  const games = FV.tables && FV.tables.length ? parseGamesKeepingEdits(src) : FV.games;
  for (const g of [...games].reverse()) {   // last first, so offsets stay valid
    const body = g.kind === 'proc' ? g.lines.map(gameLineSrc).join('') : g.lines.map(gameLineSrc).join('\n');
    src = src.slice(0, g.bodyStart) + body + src.slice(g.bodyEnd);
    if (g.newTitle !== undefined && g.titleRange) src = src.slice(0, g.titleRange[0]) + g.newTitle + src.slice(g.titleRange[1]);
  }
  return src;
}

// after table edits shift offsets, find the games again and carry their edits over
function parseGamesKeepingEdits(src) {
  const fresh = parseGames(src);
  fresh.forEach((g, i) => { if (FV.games[i]) { g.lines = FV.games[i].lines; g.newTitle = FV.games[i].newTitle; } });
  return fresh;
}

function applyFigure() {
  if (DIFF.on) { toast('Leave the diff view (± Diff) to apply changes', 'error'); return; }
  const seg = FV.seg;
  const src = figureWithEdits();
  // compare with the figure as opened: a draft can be rebased (LaTeX tab,
  // undo) and still differ from the paper
  if (src === (FV.orig !== undefined ? FV.orig : FV.src)) { closeFigure(); return; }
  snapshot();
  seg.figSrc = src;
  seg.parts = L.captionParts(src) || { prefix: src, caption: '', suffix: '' };
  seg.touched = true;
  // the caption shown is the new caption, if it changed in the LaTeX
  if (seg.edit && seg.parts.caption !== undefined) { seg.edit.textContent = ''; renderTokens(L.tokenize(seg.parts.caption), seg.edit, {}); }
  // the picture shows the old source until the next build: a table can be
  // previewed now; a figure is dimmed, with a note, so it does not mislead
  // (a preview put there by an earlier Apply is replaced too)
  const box = seg.el && seg.el.querySelector(':scope > div:first-child');
  const shown = box && box.querySelector(':scope > img, :scope > .tabular-preview, :scope > .game-preview, :scope > div.small:not(.stale-note)');
  if (shown) {
    const live = seg.kind === 'table' ? previewTabular(src) : previewGames(src);
    for (const n of box.querySelectorAll(':scope > .stale-note')) n.remove();
    if (live) {
      shown.replaceWith(live);
      if (seg.kind === 'figure') live.after(el('div', 'small stale-note', 'Preview of your edit: the typeset picture comes back after the next save'));
    } else {
      if (shown.tagName === 'IMG') shown.classList.add('stale');
      shown.after(el('div', 'small stale-note', 'Changed: the picture updates after the next save'));
    }
  }
  markEdited();
  toast('Figure updated: save (Ctrl+S) to write it', 'ok');
  closeFigure(true);
}

function closeFigure(force = false) {
  if (!FV.seg) return;
  if (!force && figureWithEdits() !== (FV.orig !== undefined ? FV.orig : FV.src) &&
      !confirm('Discard pending figure/game changes? Undo and redo here will be lost.')) return;
  $('#figview').hidden = true;
  dropFigureDrawer();
  FV.seg = null; FV.latexEdited = false; FV.lastEditor = null;
}
// the formula editor open on a chip of the figure window goes with it
function dropFigureDrawer() {
  if (drawerChip && (drawerChip.closest('#figview') || !drawerChip.isConnected)) closeDrawer(true);
}

for (const b of document.querySelectorAll('.fv-tabs button')) b.onclick = () => showFigTab(b.dataset.tab);
document.addEventListener('keydown', (e) => {
  if ($('#figview').hidden || FV.tab !== 'games' || !e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const row = e.target.closest('.gline');
  if (!row || !e.target.closest('.gtext')) return;
  const game = FV.games[+row.dataset.game];
  if (!game) return;
  e.preventDefault(); e.stopPropagation();
  const r = gameMoveLine(game, +row.dataset.line, e.key === 'ArrowUp' ? -1 : 1);
  if (r) focusGameLine(game, r.to);
}, true);
// Line keys of the games: Enter starts a new statement, Backspace on an
// empty line or Ctrl+Shift+K deletes the line; on the edge of a box, Delete
// or Backspace removes the box
document.addEventListener('keydown', (e) => {
  if ($('#figview').hidden || FV.tab !== 'games' || e.altKey || !e.target.closest) return;
  const row = e.target.closest('.gline');
  if (!row || e.target.closest('.gtools, .gcomment-edit')) return;
  const g = FV.games[+row.dataset.game], li = +row.dataset.line;
  if (!g || g.kind !== 'algo' || !g.lines[li]) return;
  const plain = !e.ctrlKey && !e.metaKey && !e.shiftKey;
  const t = e.target.closest('.gtext[contenteditable=true]');
  let to = null;
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') to = gameDeleteLine(g, li);
  else if (e.target === row && boxMarker(g.lines[li]) && plain && (e.key === 'Delete' || e.key === 'Backspace')) to = gameBoxRemove(g, li);
  else if (t && plain && e.key === 'Backspace' && !ser(t).trim()) to = gameDeleteLine(g, li);
  else if (t && plain && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); focusGameLine(g, gameNewLine(g, li), false); return; }
  else return;
  e.preventDefault(); e.stopPropagation();
  focusGameLine(g, to);
}, true);

$('#fv-apply').onclick = applyFigure;
$('#fv-close').onclick = () => closeFigure();
// While editing a figure, Ctrl+S applies its draft before saving the paper.
// Ctrl+Z/Y in Games operates on game drafts, not the document history.
document.addEventListener('keydown', (e) => {
  if ($('#figview').hidden || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  // the formula editor over the window keeps its own keys (undo in its text, Ctrl+Enter applies the formula)
  if (e.target.closest && e.target.closest('#drawer')) return;
  const key = e.key.toLowerCase();
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); e.stopPropagation(); applyFigure();
  } else if ((FV.tab === 'games' || FV.tab === 'cells') && (key === 'z' || key === 'y')) {
    e.preventDefault(); e.stopPropagation();
    if (key === 'y' || e.shiftKey) redoGame(); else undoGame();
  } else if (key === 's') {
    e.preventDefault(); e.stopPropagation();
    applyFigure(); save();
  }
}, true);
doc.addEventListener('dblclick', (e) => {
  const box = e.target.closest('.seg.figure, .seg.table');
  if (!box || e.target.closest('.caption')) return;
  e.preventDefault();
  openFigure(box.seg);
});
// The global Escape handler closes the viewer, with one confirmation if dirty.
{
  const q = new URLSearchParams(location.search);
  if (q.has('gametest')) {
    const t = setInterval(() => {
      if (!ORDER.length) return;
      clearInterval(t);
      const log = [];
      const seg = ORDER.find((x) => (x.kind === 'figure') && L.parseGames(x.src, GAME_ENVS).length);
      if (!seg) { fetch('/api/log', { method: 'POST', headers: { 'X-Token': TOKEN }, body: 'GAMETEST no games' }); return; }
      openFigure(seg);
      log.push('games: ' + FV.games.map((g) => `${g.kind}(${g.lines.length} lines, title ${JSON.stringify((g.title || '').slice(0, 30))})`).join(', '));
      // edit the first editable line of the first game, add an if-block, edit a line of the second game
      const g0 = FV.games[0];
      const l0 = g0.lines.find((l) => !l.raw && l.content);
      l0.content += g0.kind === 'proc' ? ' + 1' : ' \\land y';
      if (g0.kind === 'algo') g0.lines.splice(g0.lines.indexOf(l0) + 1, 0, ...['\\If{$z$}', '  \\State $w$', '\\EndIf'].map(L.parseGameLine));
      if (FV.games[1]) { const l1 = FV.games[1].lines.find((l) => !l.raw && l.content); if (l1) l1.content = l1.content.replace(/\$/, '$\\mathsf{new}\\,'); }
      FV.tab = 'games';
      applyFigure();
      commit();
      const a = FILES[seg.file].disk, b = FILES[seg.file].text;
      let i = 0; while (a[i] === b[i]) i++;
      let j = 0; while (j < a.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
      log.push(`${seg.file}: -${JSON.stringify(a.slice(i, a.length - j))}\n+${JSON.stringify(b.slice(i, b.length - j))}`);
      log.push('other files changed: ' + Object.keys(FILES).filter((n) => n !== seg.file && FILES[n].text !== FILES[n].disk).length);
      fetch('/api/log', { method: 'POST', headers: { 'X-Token': TOKEN }, body: 'GAMETEST\n' + log.join('\n') });
    }, 300);
  }
}
{
  const q = new URLSearchParams(location.search);
  if (q.has('tabletest')) {
    const t = setInterval(() => {
      if (!ORDER.length) return;
      clearInterval(t);
      const seg = ORDER.find((x) => x.kind === 'table' && L.parseTabulars(x.src).length);
      openFigure(seg);
      const tb = FV.tables[0];
      const row = tb.rows.find((r) => r.cells.length && r.cells[0].content === 'Classical');
      row.cells[2].content = 'yes, \\emph{tight}';
      showFigTab('cells');
      [...document.querySelectorAll('table.cells td.rowtools button')][0].click();   // a row below the header
      [...document.querySelectorAll('#fv-body > button')][0].click();               // a column
      applyFigure();
      commit();
      const a = FILES[seg.file].disk, b = FILES[seg.file].text;
      let i = 0; while (a[i] === b[i]) i++;
      let j = 0; while (j < a.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
      fetch('/api/log', { method: 'POST', headers: { 'X-Token': TOKEN },
        body: 'TABLETEST\n' + b.slice(b.lastIndexOf('\\begin{tabular}', i), b.indexOf('\\end{tabular}', i) + 13) });
    }, 300);
  }
}

// ============================================================ shortcuts
//
// Every action with a key, in one table; your changes (saved in
// ~/.config/paper-editor/keys.json) replace the default keys of an action.

const ACTION_DEFS = [
  // scope global: anywhere on the page; text: in the text of the paper
  ['save', 'Save', 'global', ['C-s'], () => save()],
  ['undo', 'Undo', 'global', ['C-z'], () => undo()],
  ['redo', 'Redo', 'global', ['C-Z', 'C-y'], () => redo()],
  ['find', 'Find', 'global', ['C-f'], () => openFind(false)],
  ['replace', 'Find and replace', 'global', ['C-h'], () => openFind(true)],
  ['read', 'Play or resume reading', 'global', ['M-r'], () => TTS.play()],
  ['readpause', 'Pause or resume reading', 'global', ['M-p'], () => TTS.pause()],
  ['readstop', 'Stop reading', 'global', ['M-s'], () => TTS.stop()],
  ['readprev', 'Previous sentence', 'global', ['C-M-ArrowLeft'], () => TTS.prev()],
  ['readnext', 'Next sentence', 'global', ['C-M-ArrowRight'], () => TTS.next()],
  ['readhere', 'Read from here (the cursor, or the last click)', 'global', [], () => TTS.playHere()],
  ['readsection', 'Read from the start of the section', 'global', [], () => TTS.playSection()],
  ['readtop', 'Read from the beginning of the paper', 'global', [], () => TTS.playTop()],
  ['bold', 'Bold (\\textbf)', 'text', ['C-b'], () => wrap('\\textbf{', 'strong')],
  ['emph', 'Emphasis (\\emph)', 'text', ['C-i'], () => wrap('\\emph{', 'em')],
  ['italic', 'Italic (\\textit)', 'text', ['C-I'], () => wrap('\\textit{', 'em')],
  ['mono', 'Typewriter (\\texttt)', 'text', [], () => wrap('\\texttt{', 'code')],
  ['footnote', 'Footnote', 'text', [], () => insertFootnote()],
  ['itemize', 'Bulleted list', 'text', [], () => insertList('itemize')],
  ['enumerate', 'Numbered list', 'text', [], () => insertList('enumerate')],
  ['math', 'Inline maths (the selection, or a new formula)', 'text', ['C-m'], () => mathAtSelection()],
  ['display', 'Displayed equation', 'text', ['C-M'], () => insertMath(true)],
  ['cite', 'Cite (search)', 'text', ['C-M-c'], () => citePalette()],
  ['ref', 'Reference (search)', 'text', ['C-M-r'], () => refPalette()],
  ['latex', 'Insert LaTeX', 'text', ['C-\\'], () => insertLatex('\\cref{}', 'Insert LaTeX')],
  ['section', 'Section heading at the cursor', 'text', ['C-M-1'], () => headingAtCaret('section')],
  ['subsection', 'Subsection heading at the cursor', 'text', ['C-M-2'], () => headingAtCaret('subsection')],
  ['paragraph', '\\paragraph heading at the cursor', 'text', ['C-M-3'], () => headingAtCaret('paragraph')],
  ['splitsection', 'Split section at the cursor', 'text', ['C-M-s'], () => splitSectionAtCaret()],
  ['newpara', 'New paragraph at the cursor', 'text', [], () => insertBreak()],
  ['addblock', 'Add a block after the one at the cursor', 'text', ['C-M-a'], () => {
    const a = document.activeElement;
    const s = a && a.tagName === 'TEXTAREA' && a.closest('#doc') ? segOf(a) : caretSeg();
    if (s) addMenu(s, s.el || s.edit); else toast('Put the cursor in the text first', 'error');
  }],
  ['delblock', 'Delete the block at the cursor (a heading keeps the text under it)', 'text', ['C-M-x'], () => {
    const a = document.activeElement;
    const s = a && a.tagName === 'TEXTAREA' && a.closest('#doc') ? segOf(a) : caretSeg();
    if (s) deleteBlock(s); else toast('Put the cursor in a block first', 'error');
  }],
  ['nextheading', 'Next heading: the cursor goes to it', 'global', ['C-M-PageDown'], () => stepBlock(1, true)],
  ['prevheading', 'Previous heading', 'global', ['C-M-PageUp'], () => stepBlock(-1, true)],
  ['nextblock', 'Next block (paragraph, heading, figure…): the cursor goes to its start', 'global', ['M-ArrowDown'], () => stepBlock(1, false)],
  ['prevblock', 'Previous block', 'global', ['M-ArrowUp'], () => stepBlock(-1, false)],
  ['moveup', 'Move the section at the cursor up', 'text', ['C-M-ArrowUp'], () => { const s = headingSegAtCaret(); if (s) moveSection(s, -1); }],
  ['movedown', 'Move the section at the cursor down', 'text', ['C-M-ArrowDown'], () => { const s = headingSegAtCaret(); if (s) moveSection(s, 1); }],
  ['combine', 'Merge the heading at the cursor with the previous one of its level', 'text', ['C-M-j'], () => { const s = headingSegAtCaret(); if (s) mergeHeading(s); }],
  ['combinenext', 'Merge the next heading of this level into the one at the cursor', 'text', ['C-M-J'], () => { const s = headingSegAtCaret(); if (s) mergeHeading(s, 1); }],
  ['revertblock', 'Revert the block at the cursor to the last save (in the diff: the current change)', 'text', ['C-M-Backspace'], () => {
    if (DIFF.on) { const m = DIFF.marks[DIFF.cur]; if (m && m.diffRevert) m.diffRevert(); else toast('Step to a change first (Ctrl+Alt+] )'); return; }
    const s = caretSeg();
    if (!s) return toast('Put the cursor in the text first', 'error');
    if (!s.touched && segSource(s, []) === s.src) return toast('This block has no unsaved changes');
    const orig = s.src;
    structural(() => { s.src = orig; });
    markEdited();
    toast('Block reverted to the last save', 'ok');
  }],
  ['figedit', 'Open the figure or table at the cursor in the viewer', 'text', ['C-M-f'], () => {
    const s = caretSeg();
    if (s && (s.kind === 'figure' || s.kind === 'table')) openFigure(s);
    else toast('Put the cursor in a figure or table for that', 'error');
  }],
  ['colourblind', 'Colour-blind palette on or off', 'global', ['C-M-k'], () => setColourBlind(!document.documentElement.dataset.cb)],
  ['spellfix', 'Spelling: correct the misspelled word at or before the cursor (pressed again: the next suggestion)', 'text', ['C-.'], () => spellFix()],
  ['spelllist', 'Spelling: the suggestions for the misspelled word at or before the cursor (pressed again: the word before)', 'text', ['C-,'], () => spellList()],
  ['yank', 'Paste one of the last copies and cuts (the kill ring)', 'global', ['C-V'], () => killRingPalette()],
  ['latexindent', 'latexindent: indent the file (in the source view the file shown, in the paper the file of the block at the cursor)', 'global', ['C-C C-F'], () => latexindentFile()],
  ['pairs', 'Close brackets as you type in the paper view, on or off (the source view always does)', 'global', [], () => { setPaperPairs(!PAPER_PAIRS); toast(PAPER_PAIRS ? 'Brackets close as you type' : 'Brackets no longer close as you type'); }],
  ['linestart', 'Start of line', 'text', ['C-a'], () => getSelection().modify('move', 'backward', 'lineboundary')],
  ['lineend', 'End of line', 'text', ['C-e'], () => getSelection().modify('move', 'forward', 'lineboundary')],
  ['selstart', 'Select to start of line', 'text', ['C-A'], () => getSelection().modify('extend', 'backward', 'lineboundary')],
  ['selend', 'Select to end of line', 'text', ['C-E'], () => getSelection().modify('extend', 'forward', 'lineboundary')],
  ['deleteline', 'Delete the line', 'text', ['C-d'], () => deleteLine()],
  ['cut', 'Cut the region, or the line', 'text', ['M-w'], () => cutRegionOrLine()],
  ['copyline', 'Copy the region, or the line (the browser may keep Ctrl+W for itself)', 'text', ['C-w'], () => copyRegionOrLine()],
  ['delback', 'Delete the character before the caret', 'text', ['C-q'], () => deleteBackwardChar()],
  ['deltospace', 'Delete back to the previous space', 'text', ['C-Backspace'], () => deleteToSpace()],
  // the source view's text: the same Emacs bindings, as in a code editor
  ['src-linestart', 'Source: start of the code on the line, then of the line', 'source', ['C-a'], () => SOURCE_ACTIONS.lineStart(false)],
  ['src-lineend', 'Source: end of the code on the line, then of the line', 'source', ['C-e'], () => SOURCE_ACTIONS.lineEnd(false)],
  ['src-selstart', 'Source: select to the start of the line', 'source', ['C-A'], () => SOURCE_ACTIONS.lineStart(true)],
  ['src-selend', 'Source: select to the end of the line', 'source', ['C-E'], () => SOURCE_ACTIONS.lineEnd(true)],
  ['src-deleteline', 'Source: delete the line', 'source', ['C-d'], () => SOURCE_ACTIONS.deleteLine()],
  ['src-duplicate', 'Source: duplicate the region, or the line', 'source', ['C-p'], () => SOURCE_ACTIONS.duplicate()],
  ['src-copy', 'Source: copy the region, or the line', 'source', ['C-w'], () => SOURCE_ACTIONS.copy()],
  ['src-cut', 'Source: cut the region, or the line', 'source', ['M-w'], () => SOURCE_ACTIONS.cut()],
  ['src-delback', 'Source: delete the character before the caret', 'source', ['C-q'], () => SOURCE_ACTIONS.deleteBackward()],
  ['src-deltospace', 'Source: delete back to the previous space', 'source', ['C-Backspace'], () => SOURCE_ACTIONS.deleteToSpace()],
  ['src-indent', 'Source: indent the region (or type two spaces)', 'source', ['Tab'], () => SOURCE_ACTIONS.indent()],
  ['src-unindent', 'Source: unindent the region, or the line', 'source', ['S-Tab'], () => SOURCE_ACTIONS.unindent()],
  ['src-newline', 'Source: new line, indented as this one', 'source', ['Enter'], () => SOURCE_ACTIONS.newline()],
  ['src-goto', 'Source: go to line', 'source', ['M-g'], () => SOURCE_ACTIONS.gotoLine()],
  ['src-delete', 'Source: delete the file shown (to the editor\'s trash)', 'source', [], () => srcDelete()],
  ['findsource', 'Find in the source of every .tex and .bib file of the paper', 'global', ['C-F'], () => sourceSearch()],
  ['sidebar', 'Contents sidebar: open it, go to its filter, or close it', 'global', ['M-o'], () => { if (sidebarOpen() && !$('#sidebar').contains(document.activeElement)) $('#sb-filter').focus({ preventScroll: true }); else toggleSidebar(); }],
  ['cancel', 'Cancel: close the menu or window on top, or drop the selection (as Emacs C-g)', 'global', ['C-g'], () => cancelKey()],
  ['src-comment', 'Source: comment the region (or line) out with %, or back in', 'source', ['C-/'], () => SOURCE_ACTIONS.toggleComment()],
  ['duplicate', 'Duplicate the region, or the line', 'text', ['C-p'], () => duplicate()],
  ['expand', 'Expand the selection', 'text', ['C-+', 'C-='], () => expandRegion()],
  // multiple cursors, with the keys of Emacs's multiple-cursors
  ['mcnext', 'Multiple cursors: mark the next occurrence of the selection (or of the word at the cursor)', 'global', ['C->'], () => mcNext(1)],
  ['mcprev', 'Multiple cursors: mark the previous occurrence', 'global', ['C-M->'], () => mcNext(-1)],
  ['mcunnext', 'Multiple cursors: drop the last cursor', 'global', ['C-<'], () => mcUnmark(1)],
  ['mcunprev', 'Multiple cursors: drop the first cursor', 'global', ['C-M-<'], () => mcUnmark(-1)],
  ['mcall', 'Multiple cursors: mark every occurrence in the paper (from the find bar: every match)', 'global', ['C-C C-A'], () => mcAll('paper')],
  ['mcdwim', 'Multiple cursors: mark every occurrence in the paragraph, then, pressed again, in the paper', 'global', ['C-C C-D'], () => mcDwim()],
  ['mclines', 'Multiple cursors: a cursor on each line of the selection', 'global', ['C-C C-C'], () => mcLines()],
  ['mcnumbers', 'Multiple cursors: insert 0, 1, 2, … at the cursors', 'global', ['C-C C-N'], () => mcNumbers()],
  ['mcsrclines', 'Multiple cursors: a cursor on each line of the LaTeX source in the selection (with one sentence per line, each sentence)', 'global', ['C-C C-L'], () => mcSourceLines()],
  // the chrome: every button of the bars and the ☰ menu has a key too
  ['menu', 'Open or close the ☰ menu', 'global', ['C-M-m'], () => $('#menubtn').click()],
  ['open', 'Open a paper directory…', 'global', ['C-o', 'C-M-o'], () => $('#openbtn').click()],
  ['newpaper', 'New paper: folder, format, title, authors, abstract…', 'global', ['C-M-N'], () => openNewPaper()],
  ['details', 'Show the structure: where environments start and end, labels', 'global', ['C-M-i'], () => $('#detailsbtn').click()],
  ['source', 'Source view of the .tex and .bib files', 'global', ['C-M-e'], () => toggleSource()],
  ['srcwrap', 'Source view: wrap long lines or not', 'global', [], () => { buildSourceView(); setSourceWrap(!SRC.wrap); }],
  ['external', 'Open the file at the cursor\'s line in your own editor', 'global', ['C-M-z'], () => openExternalHere()],
  ['srcpreview', 'Source view: preview only (edit in your own editor)', 'global', [], () => { buildSourceView(); setSourcePreview(!SRC.preview); }],
  ['history', 'Save history…', 'global', ['C-M-t'], () => $('#historybtn').click()],
  ['files', 'Files: section files, images, rename, include…', 'global', ['C-M-n'], () => openFiles()],
  ['tofile', 'Move the section at the cursor into a file of its own', 'text', ['C-M-y'], () => { const s = headingSegAtCaret(); if (s) splitToFile(s); }],
  ['splitfiles', 'One file per section (every section into sections/)', 'global', [], () => splitAllSections()],
  ['addimage', 'Add an image as a figure after the block at the cursor', 'global', [], () => pickImages(caretSeg())],
  ['reload', 'Reload the document from disk', 'global', ['C-M-l'], () => $('#reloadbtn').click()],
  ['build', 'Build the PDF now', 'global', ['C-M-b'], () => $('#rebuildbtn').click()],
  ['cleanbuild', 'Clean build (set the .aux, .bbl aside first)', 'global', ['C-M-B'], () => $('#cleanbtn').click()],
  ['pdf', 'Open the rendered PDF', 'global', ['C-M-d'], () => $('#pdfbtn').click()],
  ['paper', 'Paper metadata and conversion…', 'global', ['C-M-p'], () => $('#paperbtn').click()],
  ['keys', 'Keyboard shortcuts…', 'global', ['C-M-,'], () => $('#keysbtn').click()],
  ['help', 'Help', 'global', ['C-M-h'], () => $('#help').click()],
  ['report', 'Report a problem (keeps the last minutes of what happened)', 'global', ['C-M-q'], () => REC.report()],
  ['theme', 'Colour scheme: auto, light, dark', 'global', ['C-M-g'], () => $('#theme').click()],
  ['cols', 'One or two columns', 'global', ['C-M-w'], () => $('#cols').click()],
  ['textsmaller', 'Smaller paper text', 'global', ['C-M--'], () => $('#textsmaller').click()],
  ['textbigger', 'Larger paper text', 'global', ['C-M-='], () => $('#textbigger').click()],
  ['textreset', 'Reset the paper text size', 'global', ['C-M-0'], () => $('#textsize').click()],
  ['narrower', 'Narrower paper (one column)', 'global', [], () => setDocWidth(+$('#docwidth').value - 4, true)],
  ['wider', 'Wider paper (one column)', 'global', [], () => setDocWidth(+$('#docwidth').value + 4, true)],
  ['diff', 'Show or leave the diff of what changed', 'global', ['C-M-v'], () => ACTIONS.diff()],
  ['diffprev', 'Previous change in the diff', 'global', ['C-M-['], () => { if (DIFF.on) $('#diffprev').click(); }],
  ['diffnext', 'Next change in the diff', 'global', ['C-M-]'], () => { if (DIFF.on) $('#diffnext').click(); }],
  ['ttsopts', 'Reading speed and voice', 'global', ['C-M-u'], () => $('#ttsopts').click()],
];

// From block to block (or heading to heading) without the mouse: the caret
// goes to the start of the next one that can hold it, which is brought into
// view and announced (its kind and first words) for screen readers.
function stepBlock(dir, headings) {
  if (SRC && SRC.on) return;
  const blocks = ORDER.filter((s) => s.el && s.el.isConnected && !s.removed && (headings ? s.kind === 'heading' : s.kind !== 'gap' && s.kind !== 'hidden'));
  if (!blocks.length) return;
  const here = caretSeg();
  let i = here ? ORDER.indexOf(here) : -1;
  let next = null;
  if (i < 0) {
    // no caret: the first (or last) block below the bars
    const top = chromeBottom();
    next = dir > 0 ? blocks.find((s) => s.el.getBoundingClientRect().bottom > top + 4) : [...blocks].reverse().find((s) => s.el.getBoundingClientRect().top < top);
  } else {
    next = dir > 0 ? blocks.find((s) => ORDER.indexOf(s) > i) : [...blocks].reverse().find((s) => ORDER.indexOf(s) < i);
  }
  if (!next) { toast(dir > 0 ? 'This is the last one' : 'This is the first one'); return; }
  navPush();
  const target = next.edit && (next.edit.isContentEditable || next.edit.tagName === 'TEXTAREA') ? next.edit : null;
  if (target) {
    if (target.tagName === 'TEXTAREA') { target.focus({ preventScroll: true }); target.setSelectionRange(0, 0); }
    else {
      const r = document.createRange(); r.selectNodeContents(target); r.collapse(true);
      target.focus({ preventScroll: true });
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }
  } else { next.el.tabIndex = -1; next.el.focus({ preventScroll: true }); }
  revealChanged(next.el.getBoundingClientRect(), next);
  const kind = { heading: 'Heading', para: 'Paragraph', figure: 'Figure', table: 'Table', code: 'Code', quote: 'Quote' }[next.kind] || 'Block';
  announce(`${kind}: ${(next.edit ? next.edit.textContent || next.edit.value || '' : next.el.textContent).trim().slice(0, 80)}`);
}
// A message for screen readers only (the polite live region).
function announce(msg) {
  let r = document.getElementById('sr-live');
  if (!r) { r = el('div'); r.id = 'sr-live'; r.className = 'sr-only'; r.setAttribute('aria-live', 'polite'); document.body.append(r); }
  r.textContent = '';
  requestAnimationFrame(() => { r.textContent = msg; });
}

// ------------------------------------------------------- contents sidebar
//
// The headings of the paper (Contents) or its theorems, lemmas, definitions
// and the like (Results), filtered by words in any order.  A click or Enter
// goes there (Alt+Left comes back), and the section in view is marked.  In
// the source view it lists the headings of the file shown, and goes to
// their line.
// var and function: markEdited() may run before these lines do
var SIDEBAR = { tab: 'contents', all: [], items: [], sel: -1, timer: null };
function sidebarOpen() { return !$('#sidebar').hidden; }
const SIDEBAR_DOCKED = () => matchMedia('(min-width: 1100px)').matches;
function toggleSidebar(on = !sidebarOpen(), focus = true) {
  $('#sidebar').hidden = !on;
  document.body.classList.toggle('sidebar', on);
  $('#sidebarbtn').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('sidebar', on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  if (!on) return;
  refreshSidebar();
  if (focus) $('#sb-filter').focus({ preventScroll: true });
}
function refreshSidebarSoon() {
  if (!SIDEBAR || !sidebarOpen()) return;
  clearTimeout(SIDEBAR.timer);
  SIDEBAR.timer = setTimeout(refreshSidebar, 250);
}
const THM_NAME = (env) => ((DOC.theorems || {})[env] || {}).name || env.charAt(0).toUpperCase() + env.slice(1);
// The title of \paragraph{...} at the start of a source text.
function paragraphTitle(src) {
  const m = /^\s*\\paragraph\*?\{/.exec(src);
  if (!m) return null;
  const end = L.groupEnd(src, m[0].length - 1);
  return end < 0 ? null : plainOfLatex(src.slice(m[0].length, end - 1)).trim();
}
function paperItems(tab) {
  const out = [];
  for (const seg of ORDER) {
    if (seg.removed || !seg.el || !seg.el.isConnected || !seg.edit || seg.edit.tagName === 'TEXTAREA') continue;
    if (tab === 'contents') {
      if (seg.kind === 'heading' && seg.parts) {
        const num = ((seg.el.querySelector('.num') || {}).textContent || '').replace(/\.$/, '');
        const key = (/\\label\{([^}]*)\}/.exec(seg.src) || [])[1] || '';
        out.push({ level: { part: 0, chapter: 0, section: 0, subsection: 1, subsubsection: 2 }[seg.parts.level] || 0, num, text: seg.edit.textContent.trim(), key, seg, anchor: seg.el });
      } else if (seg.kind === 'para') {
        const t = paragraphTitle(seg.src);
        if (t !== null) out.push({ level: 3, num: '', text: t, seg, anchor: seg.el });
      }
      continue;
    }
    for (const c of seg.edit.querySelectorAll('.chip.thmhead')) {
      const src = c.dataset.src || '';
      const env = (/\\begin\{([^}]*)\}/.exec(src) || [])[1] || '';
      const head = (c.firstChild && c.firstChild.nodeType === 3 ? c.firstChild.data : c.textContent).replace(/[\s(.]+$/, '');
      const title = ((c.querySelector('.thmtitle') || {}).textContent || '').trim();
      let key = (/\\label\{([^}]*)\}/.exec(src) || [])[1];
      if (!key) { const i = seg.src.indexOf(src); const m = i >= 0 && /^\s*\\label\{([^}]*)\}/.exec(seg.src.slice(i + src.length)); key = m ? m[1] : ''; }
      out.push({ level: 0, num: '', text: head + (title ? ` (${title})` : ''), key, env, seg, chip: c, anchor: c });
    }
  }
  return out;
}
function sourceItems(tab) {
  const ta = $('#srcta');
  if (!ta) return [];
  const out = [];
  const re = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{(.*)/;
  const thm = /^\s*\\begin\{([A-Za-z]+\*?)\}(?:\[([^\]]*)\])?\s*(?:\\label\{([^}]*)\})?/;
  const level = { part: 0, chapter: 0, section: 0, subsection: 1, subsubsection: 2, paragraph: 3 };
  ta.value.split('\n').forEach((l, i) => {
    let m;
    if (tab === 'contents' && (m = re.exec(l))) out.push({ level: level[m[1]], num: '', text: plainOfLatex(m[2].replace(/\}[^}]*$/, '')).trim(), line: i + 1 });
    else if (tab === 'results' && (m = thm.exec(l)) && L.THM_ENVS.has(m[1].replace(/\*$/, ''))) out.push({ level: 0, num: '', text: THM_NAME(m[1].replace(/\*$/, '')) + (m[2] ? ` (${plainOfLatex(m[2])})` : ''), key: m[3] || '', line: i + 1 });
  });
  return out;
}
function refreshSidebar() {
  clearTimeout(SIDEBAR.timer);
  if (!sidebarOpen() || !DOC) return;
  SIDEBAR.all = SRC.on ? sourceItems(SIDEBAR.tab) : paperItems(SIDEBAR.tab);
  for (const it of SIDEBAR.all) it.hay = `${it.num} ${it.text} ${it.key || ''} ${it.env || ''}`.toLowerCase();
  for (const b of document.querySelectorAll('.sb-tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === SIDEBAR.tab));
  drawSidebar();
}
function drawSidebar() {
  const list = $('#sb-list');
  const words = $('#sb-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  SIDEBAR.items = SIDEBAR.all.filter((it) => words.every((w) => it.hay.includes(w)));
  list.textContent = '';
  if (!SIDEBAR.items.length) {
    list.append(el('div', 'sb-empty', SIDEBAR.all.length ? 'Nothing matches the filter' : SIDEBAR.tab === 'results' ? 'No theorems, lemmas or definitions' : 'No headings'));
  }
  SIDEBAR.items.forEach((it, i) => {
    const row = el('div', 'sb-item l' + it.level);
    row.setAttribute('role', 'option');
    row.append(el('span', 'sb-num', it.num), el('span', 'sb-text', it.text));
    if (it.key) row.append(el('span', 'sb-key', it.key));
    row.onclick = () => { SIDEBAR.sel = i; goSidebar(it); };
    it.row = row;
    list.append(row);
  });
  SIDEBAR.sel = Math.min(SIDEBAR.sel, SIDEBAR.items.length - 1);
  markSidebar();
}
function markSidebar() {
  SIDEBAR.items.forEach((it, i) => it.row.classList.toggle('sel', i === SIDEBAR.sel));
  const s = SIDEBAR.items[SIDEBAR.sel];
  if (s) s.row.scrollIntoView({ block: 'nearest' });
  markCurrentSection();
}
// the last item whose place starts above a line just below the bars
function markCurrentSection() {
  if (!sidebarOpen() || SRC.on) return;
  const line = chromeBottom() + 80;
  let cur = null;
  for (const it of SIDEBAR.items) {
    if (!it.anchor || !it.anchor.isConnected) continue;
    if (it.anchor.getBoundingClientRect().top <= line) cur = it; else break;
  }
  if (!cur) cur = SIDEBAR.items.find((it) => it.anchor && it.anchor.isConnected) || null;   // above the first one
  for (const it of SIDEBAR.items) it.row.classList.toggle('current', it === cur);
}
function goSidebar(it) {
  if (!it) return;
  if (it.line) { SOURCE_ACTIONS.gotoLine(it.line); return; }
  if (!it.seg || !it.seg.edit || !it.seg.edit.isConnected) { toast('That place is gone; the list is drawn again'); refreshSidebar(); return; }
  navPush();
  const ed = it.seg.edit;
  const r = document.createRange();
  if (it.chip && it.chip.isConnected) r.setStartAfter(it.chip); else { r.selectNodeContents(ed); }
  r.collapse(true);
  ed.focus({ preventScroll: true });
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  revealChanged((it.chip || it.seg.el).getBoundingClientRect(), it.seg);
  // over the page (a narrow window), the sidebar makes way
  if (!SIDEBAR_DOCKED()) toggleSidebar(false);
}
// ---------------------------------------------------------- label rename
//
// A label's key changes in every file of the paper at once: the \label, and
// every reference to it (\ref, \cref, \Cref, \eqref, \autoref, \nameref,
// \pageref and their kin, a key inside a list such as \cref{a,k,b}, both
// keys of \crefrange, \hyperref[k]).  One Ctrl+Z undoes it.
const REF_CMDS = 'ref|cref|Cref|eqref|autoref|Autoref|nameref|Nameref|pageref|cpageref|Cpageref|labelcref|vref|Vref|vpageref|crefrange|Crefrange|cpagerefrange|Cpagerefrange|namecref|nameCref|lcnamecref';
function labelKeys() {
  const keys = new Set();
  for (const f of Object.values(FILES)) for (const m of (f.text || '').matchAll(/\\label\{([^}]*)\}/g)) keys.add(m[1].trim());
  return keys;
}
function badLabel(key, old) {
  if (!key) return 'The label is empty';
  if (/[\s{},%\\#~]/.test(key)) return 'A label cannot hold spaces or { } , % \\ # ~';
  if (key !== old && labelKeys().has(key)) return `${key} is already a label`;
  return null;
}
function renameLabelIn(text, from, to) {
  let labels = 0, refs = 0;
  const one = (k) => (k.trim() === from ? (refs++, k.replace(from, to)) : k);
  text = text.replace(/\\label\{([^}]*)\}/g, (m, k) => (k.trim() === from ? (labels++, m.replace(from, to)) : m));
  text = text.replace(new RegExp('(\\\\(?:' + REF_CMDS + ')\\*?\\{)([^}]*)\\}', 'g'), (m, head, list) => head + list.split(',').map(one).join(',') + '}');
  text = text.replace(/(\\[cC](?:page)?refrange\*?\{[^}]*\})\{([^}]*)\}/g, (m, head, k) => head + '{' + one(k) + '}');
  text = text.replace(/\\hyperref\[([^\]]*)\]/g, (m, k) => '\\hyperref[' + one(k) + ']');
  return { text, labels, refs };
}
function renameLabel(from, to) {
  to = (to || '').trim();
  if (to === from) return true;
  const bad = badLabel(to, from);
  if (bad) { toast(bad, 'error'); return false; }
  snapshot();
  commit();
  let labels = 0, refs = 0;
  for (const f of Object.values(FILES)) {
    if (typeof f.text !== 'string') continue;
    const r = renameLabelIn(f.text, from, to);
    f.text = r.text; labels += r.labels; refs += r.refs;
  }
  // the numbers of the last build go with the new key until the next one
  if (DOC.aux && DOC.aux.labels && DOC.aux.labels[from]) DOC.aux.labels[to] = DOC.aux.labels[from];
  const y = viewAnchor();
  render();
  restoreAnchor(y);
  refreshSidebar();
  toast(`Renamed ${from} → ${to}: ${labels} label${labels === 1 ? '' : 's'}, ${refs} reference${refs === 1 ? '' : 's'}`, 'ok');
  return true;
}
// F2 or a double-click on a key in the sidebar: a field in its place
function editSidebarKey(it) {
  if (!it || !it.key || !it.row || SRC.on) return;
  const span = it.row.querySelector('.sb-key');
  const input = el('input', 'sb-keyedit');
  input.value = it.key;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'New label');
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    if (ok && input.value.trim() !== it.key && !renameLabel(it.key, input.value)) { done = false; input.focus(); return; }
    if (!ok || input.value.trim() === it.key) drawSidebar();
    $('#sb-filter').focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => { if (!done) { done = true; drawSidebar(); } });
}
$('#sb-list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.sb-item');
  const it = row && SIDEBAR.items.find((x) => x.row === row);
  if (it && it.key) { e.preventDefault(); editSidebarKey(it); }
});

$('#sidebarbtn').onclick = () => toggleSidebar();
for (const b of document.querySelectorAll('.sb-tabs button')) b.onclick = () => { SIDEBAR.tab = b.dataset.tab; SIDEBAR.sel = -1; refreshSidebar(); $('#sb-filter').focus({ preventScroll: true }); };
$('#sb-filter').addEventListener('input', () => { SIDEBAR.sel = 0; drawSidebar(); });
$('#sb-filter').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = SIDEBAR.items.length;
    if (!n) return;
    SIDEBAR.sel = SIDEBAR.sel < 0 ? 0 : (SIDEBAR.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    markSidebar();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    goSidebar(SIDEBAR.items[Math.max(0, SIDEBAR.sel)]);
  } else if (e.key === 'F2') {
    e.preventDefault();
    const it = SIDEBAR.items[Math.max(0, SIDEBAR.sel)];
    if (it && it.key) editSidebarKey(it); else toast('This entry has no label');
  } else if (e.key === 'Escape' && e.target.value) {
    e.preventDefault(); e.stopPropagation();
    e.target.value = ''; drawSidebar();
  }
});
let sidebarScroll = 0;
addEventListener('scroll', () => { if (!sidebarScroll) sidebarScroll = requestAnimationFrame(() => { sidebarScroll = 0; markCurrentSection(); }); }, { passive: true });
// open as it was left (after the script has run: DOC and SRC exist then)
setTimeout(() => { try { if (localStorage.getItem('sidebar') === '1') toggleSidebar(true, false); } catch (e) { /* storage unavailable */ } }, 0);

// the block the caret is in, for the block actions above
function caretSeg() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const n = s.anchorNode;
  return n ? segOf(n.nodeType === 1 ? n : n.parentElement) : null;
}
function headingSegAtCaret() {
  const seg = caretSeg();
  if (!seg) { toast('Put the cursor in the text first', 'error'); return null; }
  if (seg.kind !== 'heading') { toast('Put the cursor in a heading for that', 'error'); return null; }
  return seg;
}
let USER_KEYS = {};

function applyKeymap() {
  for (const k of Object.keys(GLOBAL_KEYS)) if (k !== 'Escape') delete GLOBAL_KEYS[k];
  for (const k of Object.keys(TEXT_KEYS)) delete TEXT_KEYS[k];
  for (const k of Object.keys(SOURCE_KEYS)) delete SOURCE_KEYS[k];
  for (const k of Object.keys(CODE_KEYS)) delete CODE_KEYS[k];
  for (const [id, label, scope, defaults, fn] of ACTION_DEFS) {
    const run = scope === 'source' ? smcGuard(id, label, fn) : mcGuard(id, label, scope, fn);
    for (const key of USER_KEYS[id] || defaults) ({ global: GLOBAL_KEYS, text: TEXT_KEYS, source: SOURCE_KEYS }[scope])[key] = run;
    // a listing's text box keeps its own keys, but adding and deleting the
    // block work there too
    if (id === 'delblock' || id === 'addblock') for (const key of USER_KEYS[id] || defaults) CODE_KEYS[key] = fn;
  }
}
const CODE_KEYS = {};
fetch('/api/keys').then((r) => r.json()).then((k) => { USER_KEYS = k || {}; applyKeymap(); }).catch(applyKeymap);

// C-g, as in Emacs: closes what is on top (a popover, a menu, a dialog, the
// find bar), else drops the selection.  In the source view it never leaves
// the view, which Escape does.
function cancelKey() {
  if (PREFIX) { dropPrefix(); return; }
  if (mcLeave()) return;
  if (document.querySelector('.popover:not([hidden])')) { closePopovers(); return; }
  if (SRC.on) {
    if (!$('#palette').hidden) { closePalette(); return; }
    if (!$('#external').hidden) { $('#external-later').click(); return; }
    if (!$('#askbox').hidden) { [...$('#ask-actions').children].pop().click(); return; }
    const ta = $('#srcta');
    if (ta) ta.setSelectionRange(ta.selectionEnd, ta.selectionEnd);
    return;
  }
  if (topDialog() || ['#findbar', '#drawer', '#menu', '#banner'].some((id) => $(id) && !$(id).hidden)) { closeCurrentMenu(); return; }
  const sel = getSelection();
  if (sel.rangeCount && !sel.isCollapsed) sel.collapseToEnd();
}
// the cancel key works in fields too (the find bar, the palette)
for (const [id, , , , fn] of ACTION_DEFS) if (id === 'cancel') fn.cancels = true;
// (and the kill ring's key works in the source view's text too)
for (const [id, , , , fn] of ACTION_DEFS) if (id === 'yank') fn.inSource = true;

// ------------------------------------------------------------ prefix keys
//
// A key written "C-c C-a" (in keys.json, or recorded as two presses in
// Keys…) is a chord: after its first key, a hint lists the keys that can
// follow and what they do; C-g or Escape drops it.
let PREFIX = null;
const prettyChord = (k) => k.split(' ').map(prettyKey).join(' ');
const KEY_MAPS = () => [GLOBAL_KEYS, TEXT_KEYS, SOURCE_KEYS, CODE_KEYS];
const isPrefix = (p) => KEY_MAPS().some((m) => Object.keys(m).some((k) => k.startsWith(p + ' ')));
function keyLabel(k) {
  const d = ACTION_DEFS.find(([id, , , defaults]) => (USER_KEYS[id] || defaults).includes(k));
  return d ? d[1] : '';
}
function showPrefixHint(p) {
  const box = $('#whichkey');
  box.textContent = '';
  box.append(el('b', '', prettyChord(p) + ' …'));
  const next = [...new Set(KEY_MAPS().flatMap((m) => Object.keys(m)).filter((k) => k.startsWith(p + ' ')))].sort();
  for (const k of next) {
    const row = el('div', 'wk-row');
    row.append(el('kbd', '', prettyChord(k.slice(p.length + 1))), el('span', '', keyLabel(k)));
    box.append(row);
  }
  box.hidden = false;
}
function dropPrefix() { PREFIX = null; $('#whichkey').hidden = true; }
document.addEventListener('keydown', (e) => {
  if (RECORDING || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  const t = e.target;
  // fields of their own (the find bar, the palette) keep their keys
  const k = keyName(e);
  // (except the chord that marks every match of the find bar with a cursor)
  const findChord = t.closest && t.closest('#findbar') && (PREFIX || (USER_KEYS.mcall || ['C-C C-A']).some((c) => c.startsWith(k + ' ')));
  if (!findChord && (/^(INPUT|SELECT)$/.test(t.tagName) || (t.tagName === 'TEXTAREA' && t.id !== 'srcta' && !t.closest('#doc .seg')))) return;
  if (!PREFIX) {
    if (!isPrefix(k)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    PREFIX = k;
    showPrefixHint(k);
    return;
  }
  e.preventDefault(); e.stopImmediatePropagation();
  const full = PREFIX + ' ' + k;
  if (isPrefix(full)) { PREFIX = full; showPrefixHint(full); return; }
  dropPrefix();
  if ((k === 'C-g' || k === 'Escape') && !KEY_MAPS().some((m) => m[full])) return;
  const inText = t.isContentEditable && segOf(t);
  const fn = (t.id === 'srcta' && SOURCE_KEYS[full]) || (inText && TEXT_KEYS[full]) ||
    (t.tagName === 'TEXTAREA' && t.closest('#doc .seg') && CODE_KEYS[full]) || GLOBAL_KEYS[full];
  if (fn) fn(); else toast(`${prettyChord(full)} does nothing here`);
}, true);

// ------------------------------------------------------- multiple cursors
//
// A page has one real selection, and the browser edits only there.  The
// other cursors are the editor's: kept as character offsets in their block,
// drawn over the text, and an edit is made at each of them in turn through
// the real selection, from the last to the first, so that the existing code
// does the work.  An offset counts the characters of the block's text and
// one for each chip (a formula, a reference), which no cursor goes inside.
// Every cursor lies in one editable text (a paragraph, a heading, a
// caption).  The real selection is the primary cursor.  A render, a click,
// Esc or C-g go back to one cursor.
const mcActive = () => MC.cursors.length > 1;
// Esc and C-g in the text with many cursors: back to one (in the find bar
// or a dialog they close that first)
function mcLeave() {
  const a = document.activeElement;
  if (mcActive() && a && a.closest && a.closest('#doc') && !topDialog()) { mcClear(); return true; }
  if (smcActive() && a && a.id === 'srcta' && !topDialog()) { smcShow.one(); return true; }
  return false;
}
// the number of cursors: one toast, changed in place while it shows
function mcCount(msg) {
  const t = mcCount.el;
  if (t && t.isConnected && !t.classList.contains('gone')) { t.textContent = msg; return; }
  toast(msg);
  mcCount.el = $('#toasts') && $('#toasts').lastElementChild;
}
// (a <br> is only the browser's placeholder in an emptied block: no character)
const mcAtom = (n) => n.nodeType === 1 && (n.classList.contains('chip') || n.getAttribute('contenteditable') === 'false' || n.tagName === 'IMG');
// the text of a node as the offsets count it: a chip is one character
function mcText(node) {
  let s = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) s += c.data;
    else if (c.nodeType === 1) s += mcAtom(c) ? '\uFFFC' : mcText(c);
  }
  return s;
}
// the offset of a point of the page in the block `ed` (a point inside a chip
// counts as after it)
function mcOff(ed, node, off) {
  let atom = null;
  for (let n = node.nodeType === 1 ? node : node.parentElement; n && n !== ed; n = n.parentElement) if (mcAtom(n)) atom = n;
  if (atom) { node = atom.parentNode; off = [...node.childNodes].indexOf(atom) + 1; }
  let count = 0, done = false;
  const walk = (p) => {
    for (let i = 0; i < p.childNodes.length; i++) {
      if (p === node && i === off) { done = true; return; }
      const c = p.childNodes[i];
      if (c === node) { count += off; done = true; return; }
      if (c.nodeType === 3) count += c.data.length;
      else if (c.nodeType === 1) {
        if (mcAtom(c)) count += 1;
        else { walk(c); if (done) return; }
      }
    }
    if (p === node) done = true;
  };
  walk(ed);
  return count;
}
// the point at an offset: in a text node where there is one, never in a chip
function mcPoint(ed, n) {
  let rest = n, found = null;
  const walk = (p) => {
    for (const c of p.childNodes) {
      if (c.nodeType === 3) {
        if (rest <= c.data.length) { found = [c, rest]; return true; }
        rest -= c.data.length;
      } else if (c.nodeType === 1) {
        if (mcAtom(c)) {
          if (rest === 0) { found = [p, [...p.childNodes].indexOf(c)]; return true; }
          rest -= 1;
        } else if (walk(c)) return true;
      }
    }
    return false;
  };
  return walk(ed) ? found : [ed, ed.childNodes.length];
}
const mcUsable = (ed) => !!(ed && ed.isConnected && ed.getAttribute('contenteditable') === 'true' && ed.closest('#doc') &&
  !ed.closest('.chip') && segOf(ed) && !DIFF.on);
const mcEditables = () => [...document.querySelectorAll('#doc [contenteditable=true]')].filter(mcUsable);
const mcLo = (c) => Math.min(c.a, c.f), mcHi = (c) => Math.max(c.a, c.f);
function mcCmp(x, y) {
  if (x.ed !== y.ed) return x.ed.compareDocumentPosition(y.ed) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  return mcLo(x) - mcLo(y) || mcHi(x) - mcHi(y);
}
const mcSorted = () => [...MC.cursors].sort(mcCmp);
function mcRange(c) {
  const r = document.createRange();
  r.setStart(...mcPoint(c.ed, mcLo(c)));
  r.setEnd(...mcPoint(c.ed, mcHi(c)));
  return r;
}
// make a cursor the real selection
function mcSelect(c) {
  if (document.activeElement !== c.ed) c.ed.focus({ preventScroll: true });
  const a = mcPoint(c.ed, c.a), f = mcPoint(c.ed, c.f);
  getSelection().setBaseAndExtent(a[0], a[1], f[0], f[1]);
  if (c.a === c.f) clampCaretToVisibleEnd();
}
// the real selection as a cursor, if it lies in one usable block
function mcFromSelection() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const ed = hostOf(s.anchorNode);
  if (!mcUsable(ed) || hostOf(s.focusNode) !== ed) return null;
  return { ed, a: mcOff(ed, s.anchorNode, s.anchorOffset), f: mcOff(ed, s.focusNode, s.focusOffset) };
}
// the real selection becomes the first cursor
function mcStart() {
  if (DIFF.on) { toast('Multiple cursors work outside the diff view'); return false; }
  if (mcActive()) return true;
  const c = mcFromSelection();
  if (!c) { toast('Put the cursor in the text of a paragraph, heading or caption first', 'error'); return false; }
  MC.cursors = [c]; MC.primary = c; MC.word = false; MC.dwimBlock = false;
  return true;
}
// a banner about the cursors goes with them
const MC_BANNER = 'Esc goes back to one.';
function mcBannerOff() { const b = $('#banner'); if (b && !b.hidden && b.textContent.includes(MC_BANNER)) b.hidden = true; }
function mcClear(keepBanner = false) {
  MC.stamp = null;
  if (MC.cursors.length > 1 && !keepBanner) mcBannerOff();
  MC.cursors = []; MC.primary = null; MC.dwimBlock = false; MC.expand = -1;
  cancelAnimationFrame(MC.raf); MC.raf = 0;
  const layer = document.getElementById('mc-layer');
  if (layer) layer.textContent = '';
  if (window.CSS && CSS.highlights) CSS.highlights.delete('mc');
}
// across a render: each cursor by its block (file, place in the file, and
// which editable text of the block) and the block's text
function mcBeforeRender() {
  if (!mcActive()) { if (MC.cursors.length) mcClear(); return null; }
  const keep = MC.cursors.map((c) => {
    const box = c.ed.closest('.seg'), seg = box && box.seg;
    if (!seg || !FILES[seg.file] || !c.ed.isConnected) return null;
    return { file: seg.file, index: (FILES[seg.file].segs || []).indexOf(seg), k: [...box.querySelectorAll('[contenteditable=true]')].indexOf(c.ed),
      text: mcText(c.ed), a: c.a, f: c.f, primary: c === MC.primary };
  });
  mcClear(true);
  return keep;
}
function mcAfterRender(keep) {
  if (!keep || DIFF.on) return;
  const at = (seg, k) => {
    const eds = seg && seg.el ? [...seg.el.querySelectorAll('[contenteditable=true]')] : [];
    const ed = eds[k.k];
    return ed && mcUsable(ed) && mcText(ed) === k.text ? ed : null;
  };
  const cs = [];
  for (const k of keep) {
    if (!k) continue;
    const segs = (FILES[k.file] && FILES[k.file].segs) || [];
    const ed = at(segs[k.index], k) || segs.reduce((got, seg) => got || at(seg, k), null);
    if (ed) cs.push({ ed, a: k.a, f: k.f, primary: k.primary });
  }
  if (cs.length < 2) { mcBannerOff(); return; }
  MC.cursors = cs.map(({ ed, a, f }) => ({ ed, a, f }));
  MC.primary = MC.cursors[cs.findIndex((c) => c.primary)] || MC.cursors[MC.cursors.length - 1];
  mcSettle();
  const a = document.activeElement;
  if (mcActive() && a && a.closest && a.closest('#doc')) mcShowPrimary();
  mcDraw();
}
// one cursor left: the editor's own end, the real selection stays
function mcSettle() {
  mcMerge();
  if (MC.cursors.length > 1) { if (!MC.raf) MC.raf = requestAnimationFrame(mcLoop); return; }
  const last = MC.cursors[0];
  mcClear();
  if (last && last.ed.isConnected) mcSelect(last);
}
// cursors that meet become one
function mcMerge() {
  const out = [];
  for (const c of mcSorted()) {
    if (!c.ed.isConnected) continue;
    const p = out[out.length - 1];
    if (p && p.ed === c.ed && (mcLo(c) < mcHi(p) || (mcLo(c) === mcHi(p) && (c.a === c.f || p.a === p.f)))) {
      const lo = Math.min(mcLo(p), mcLo(c)), hi = Math.max(mcHi(p), mcHi(c));
      const keep = c === MC.primary ? c : p;
      if (keep.a <= keep.f) { keep.a = lo; keep.f = hi; } else { keep.a = hi; keep.f = lo; }
      out[out.length - 1] = keep;
      continue;
    }
    out.push(c);
  }
  MC.cursors = out;
  if (!out.includes(MC.primary)) MC.primary = out[out.length - 1] || null;
}
// After each action the carets show without blinking for a moment, as the
// browser's own does, then blink with it (else they could be off just when
// one looks for them).
function mcSteady() {
  const layer = document.getElementById('mc-layer');
  if (!layer) return;
  layer.classList.add('steady');
  clearTimeout(mcSteady.t);
  mcSteady.t = setTimeout(() => layer.classList.remove('steady'), 530);
}
// the real selection back on the primary cursor, scrolled to if asked
function mcShowPrimary(scroll) {
  mcSteady();
  const p = MC.primary;
  if (!p || !p.ed.isConnected) return;
  mcSelect(p);
  if (!scroll) return;
  const b = mcRange(p).getBoundingClientRect();
  if (b.top < 80 || b.bottom > innerHeight - 40) {
    const n = mcPoint(p.ed, p.f)[0];
    (n.nodeType === 1 ? n : n.parentElement).scrollIntoView({ block: 'center' });
  }
}

// ---- drawing: the selected text with a highlight, the carets as bars
function mcCaretBox(r) {
  const rs = r.getClientRects();
  if (rs.length && rs[0].height) return { x: rs[0].left, top: rs[0].top, h: rs[0].height };
  const n = r.startContainer, o = r.startOffset;
  const q = document.createRange();
  if (n.nodeType === 3 && n.data.length) {
    if (o > 0) { q.setStart(n, o - 1); q.setEnd(n, o); const b = [...q.getClientRects()].pop(); if (b) return { x: b.right, top: b.top, h: b.height }; }
    else { q.setStart(n, 0); q.setEnd(n, 1); const b = q.getClientRects()[0]; if (b) return { x: b.left, top: b.top, h: b.height }; }
  }
  const after = n.nodeType === 1 && n.childNodes[o], before = n.nodeType === 1 && n.childNodes[o - 1];
  const k = after || before;
  if (k) {
    q.selectNode(k);
    const b = q.getBoundingClientRect();
    if (b.height) return { x: after ? b.left : b.right, top: b.top, h: b.height };
  }
  const host = n.nodeType === 1 ? n : n.parentElement;
  const b = host.getBoundingClientRect();
  return b.height ? { x: b.left, top: b.top, h: Math.min(b.height, parseFloat(getComputedStyle(host).fontSize) * 1.3) } : null;
}
function mcDraw() {
  if (!mcActive()) return;
  // a render, the figure viewer or a dialog: back to one cursor
  if (MC.cursors.some((c) => !c.ed.isConnected) || (topDialog() && !MC.hold) || !$('#figview').hidden || SRC.on) { mcClear(); return; }
  let layer = document.getElementById('mc-layer');
  if (!layer) { layer = el('div'); layer.id = 'mc-layer'; document.body.append(layer); }
  const sel = [];
  let i = 0;
  for (const c of MC.cursors) {
    if (c === MC.primary) continue;
    // a selection is drawn as the real one is, without a caret
    if (c.a !== c.f) { sel.push(mcRange(c)); continue; }
    const f = document.createRange();
    f.setStart(...mcPoint(c.ed, c.f));
    const box = mcCaretBox(f);
    const bar = layer.children[i] || layer.appendChild(el('div', 'mc-caret'));
    i++;
    if (!box) { bar.style.display = 'none'; continue; }
    bar.style.display = '';
    bar.style.left = box.x + 'px'; bar.style.top = box.top + 'px'; bar.style.height = box.h + 'px';
  }
  while (layer.children.length > i) layer.lastChild.remove();
  if (window.CSS && CSS.highlights) CSS.highlights.set('mc', new Highlight(...sel));
}
// the state the drawing depends on: drawn again only when it changes
const mcStamp = (list, extra) => [scrollX, scrollY, innerWidth, innerHeight, document.documentElement.scrollHeight, extra,
  list.map((c) => c.a + ',' + c.f + (c.ed ? ',' + c.ed.offsetHeight : '')).join(';')].join('|');
function mcLoop() {
  MC.raf = 0;
  if (!mcActive()) return;
  const stamp = mcStamp(MC.cursors, MC.cursors.indexOf(MC.primary));
  if (stamp !== MC.stamp || MC.cursors.some((c) => !c.ed.isConnected) || topDialog() || !$('#figview').hidden || SRC.on) { MC.stamp = stamp; mcDraw(); }
  if (mcActive()) MC.raf = requestAnimationFrame(mcLoop);
}

// ---- an edit at every cursor
//
// fn runs with the real selection on each cursor in turn, last first; i is
// the cursor's place in the paper (0 for the first).  kind: 'type' (typing,
// one undo step per burst, as for one cursor), 'edit' (one undo step), or
// 'move' (no change to the text).  check: the balance of braces and
// environments is checked afterwards, as for an edit with one cursor.
function mcEach(fn, { kind = 'edit', check = kind === 'edit' } = {}) {
  if (!mcActive()) return;
  if (kind === 'type') {
    if (!typingSnap || typingIn !== MC) snapshot();
    typingIn = MC;
    clearTimeout(typingSnap);
    typingSnap = setTimeout(() => { typingSnap = null; }, 1200);
  } else if (kind === 'edit') { clearTimeout(typingSnap); typingSnap = null; typingIn = null; snapshot(); }
  if (kind !== 'move') MC.expand = -1;
  MC.dwimBlock = false;
  const list = mcSorted();
  const blocks = new Map();
  if (check) for (const c of list) { const seg = segOf(c.ed); if (seg && seg.edit === c.ed && !blocks.has(seg)) blocks.set(seg, blockSource(seg)); }
  MC.note = '';
  MC.replaying = true;
  try {
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (!c.ed.isConnected) continue;
      const len0 = mcText(c.ed).length;
      mcSelect(c);
      fn(c, i);
      if (!c.ed.isConnected) continue;
      const now = mcFromSelection();
      if (now && now.ed === c.ed) { c.a = now.a; c.f = now.f; }
      const len = mcText(c.ed).length;
      c.a = Math.min(c.a, len); c.f = Math.min(c.f, len);
      // the cursors after this one in its block, done already, move with the text
      const d = len - len0;
      for (let j = i + 1; j < list.length && list[j].ed === c.ed; j++) { list[j].a += d; list[j].f += d; }
    }
  } finally { MC.replaying = false; }
  // (the browser's beforeinput for each edit took the burst as its own)
  if (kind === 'type') typingIn = MC;
  if (kind !== 'move') { markEditedSoon(); lastTyping = Date.now(); }
  for (const [seg, before] of blocks) {
    if (!seg.edit || !seg.edit.isConnected) continue;
    const bad = brokenBalance(before, blockSource(seg));
    if (!bad) continue;
    restore(HISTORY.undo, HISTORY.redo);
    HISTORY.redo.pop();
    toast(`Undid that edit, which ${bad.removed ? 'removed' : 'added'} ${bad.tokens.join(', ')} on its own. The source view can change it.`);
    return;
  }
  if (MC.note) toast(MC.note);
  mcSettle();
  mcShowPrimary(true);
  mcDraw();
}

// a character typed (or a piece of text put in) at every cursor; brackets,
// quotes and $ do over a selection what they do with one cursor
function mcType(text) {
  const over = MC.cursors.some((c) => c.a !== c.f);
  mcEach(() => {
    const s = getSelection();
    if (!s.isCollapsed && WRAP_PAIRS[text]) { wrapLiteral(...WRAP_PAIRS[text]); return; }
    if (text === '$') {
      if (!s.isCollapsed) { mathAtSelection(); return; }
      if (closeMathAtCaret()) return;
    }
    if (paperPair(text)) return;
    if (!s.isCollapsed) {
      const r = s.getRangeAt(0).cloneRange();
      if (unpairedEnvChips(envChipsIn(r)).length) { deleteKeepingEnvs(r); s.removeAllRanges(); s.addRange(r); }
    }
    document.execCommand('insertText', false, text);
  }, { kind: over || text === '$' ? 'edit' : 'type', check: over });
  // what is typed next joins this step, as with one cursor
  if (mcActive()) {
    typingIn = MC;
    clearTimeout(typingSnap);
    typingSnap = setTimeout(() => { typingSnap = null; }, 1200);
  }
}
// Backspace (back) or Delete at every cursor, a character or a word; like
// the keys with one cursor, they never take the start or the end of an
// environment alone
function mcDelete(back, unit = 'character') {
  const key = back ? 'Backspace' : 'Delete';
  // at the start (or end) of a block it would join two blocks
  if (MC.cursors.some((c) => c.a === c.f && (back ? c.f === 0 : c.f === mcText(c.ed).length))) {
    banner(`${key} at the ${back ? 'start' : 'end'} of a paragraph would join it with the ${back ? 'previous' : 'next'} one, which takes one cursor: Esc goes back to one.`);
    return;
  }
  const stops = (m) => `${key} stops at the ${envOf(m)[1] === 'begin' ? 'start' : 'end'} of ${envName(m)}`;
  mcEach((c) => {
    const s = getSelection();
    if (s.isCollapsed && back && unit === 'character' && paperPairBackspace()) return;
    if (s.isCollapsed) {
      const nb = neighbours(s.getRangeAt(0));
      const n = back ? nb.before : nb.after;
      if (unit === 'character' && !nb.inText && n && n.nodeType === 1 && n.classList.contains('chip') &&
          (n.classList.contains('parbreak') || n.classList.contains('nl') || n.classList.contains('tie'))) {
        let m = back ? n.previousSibling : n.nextSibling;
        while (m && m.nodeType === 3 && !m.data) m = back ? m.previousSibling : m.nextSibling;
        if (envOf(m)) { MC.note = stops(m); return; }
        const r = document.createRange(); r.setStartBefore(n); r.collapse(true);
        n.remove();
        s.removeAllRanges(); s.addRange(r);
        return;
      }
      s.modify('extend', back ? 'backward' : 'forward', unit);
      if (s.isCollapsed || hostOf(s.focusNode) !== c.ed) { mcSelect(c); return; }
      const lone = unpairedEnvChips(envChipsIn(s.getRangeAt(0)));
      if (lone.length) { MC.note = stops(lone[0]); mcSelect(c); return; }
      document.execCommand('delete');
      return;
    }
    const r = s.getRangeAt(0).cloneRange();
    if (unpairedEnvChips(envChipsIn(r)).length) { deleteKeepingEnvs(r); s.removeAllRanges(); s.addRange(r); return; }
    document.execCommand('delete');
  }, { kind: 'edit' });
}
// arrows, Home and End at every cursor, Shift extending; a cursor never
// leaves its block
function mcMove(key, extend, ctrl) {
  const back = /Left|Up|Home/.test(key);
  const unit = /Up|Down/.test(key) ? 'line' : /Home|End/.test(key) ? (ctrl ? 'paragraphboundary' : 'lineboundary') : ctrl ? 'word' : 'character';
  mcEach(() => {
    const s = getSelection();
    if (!extend && !s.isCollapsed && unit === 'character') { if (back) s.collapseToStart(); else s.collapseToEnd(); return; }
    s.modify(extend ? 'extend' : 'move', back ? 'backward' : 'forward', unit);
  }, { kind: 'move' });
}

// ---- the clipboard: a copy takes the text at every cursor, one line each,
// and a paste of as many lines as there are cursors puts one at each
function mcClipboard(e, cut, line) {
  const s = getSelection();
  const pieces = [];
  MC.replaying = true;
  try {
    for (const c of mcSorted()) {
      mcSelect(c);
      if (s.isCollapsed && line) selectLine();
      const now = mcFromSelection();
      if (s.isCollapsed || !now || now.ed !== c.ed) { pieces.push(null); continue; }
      const r = snapOutOfChips(s.getRangeAt(0).cloneRange());
      KEEP_UNICODE = ''; KEEP_MATH_UNICODE = '';
      const frag = r.cloneContents();
      pieces.push({ c, plain: plainOf(frag), latex: ser(frag), a: mcOff(c.ed, r.startContainer, r.startOffset), f: mcOff(c.ed, r.endContainer, r.endOffset) });
    }
  } finally { MC.replaying = false; }
  const got = pieces.filter(Boolean);
  e.preventDefault();
  if (!got.length) { mcShowPrimary(); toast('Nothing is selected at the cursors'); return; }
  e.clipboardData.setData('text/plain', got.map((p) => p.plain).join('\n'));
  e.clipboardData.setData(LATEX_MIME, got.map((p) => p.latex).join('\n'));
  MC.kill = { plain: got.map((p) => p.plain), latex: got.map((p) => p.latex) };
  killRecord(got.map((p) => p.plain).join('\n'), got.map((p) => p.latex).join('\n'));
  if (!cut) { mcShowPrimary(); toast(`Copied the text at ${got.length} cursors`); return; }
  const at = new Map(got.map((p) => [p.c, p]));
  mcEach((c) => {
    const p = at.get(c);
    if (!p) return;
    mcSelect({ ed: c.ed, a: p.a, f: p.f });
    const r = getSelection().getRangeAt(0).cloneRange();
    deleteKeepingEnvs(r);
    const s2 = getSelection(); s2.removeAllRanges(); s2.addRange(r);
  }, { kind: 'edit' });
}
for (const type of ['copy', 'cut']) {
  document.addEventListener(type, (e) => {
    if (!mcActive() || MC.replaying || !e.target.closest || !e.target.closest('#doc') || /^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;
    e.stopImmediatePropagation();
    mcClipboard(e, type === 'cut' || !!(MC.clip && MC.clip.cut), !!(MC.clip && MC.clip.line));
  }, true);
}
// C-w and M-w: the region, or the line, at every cursor
function mcCopy(cut) {
  MC.clip = { cut, line: true };
  try { document.execCommand('copy'); } finally { MC.clip = null; }
}
document.addEventListener('paste', (e) => {
  if (!mcActive() || MC.replaying || !e.target.closest || !e.target.closest('#doc') || /^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const plain = e.clipboardData.getData('text/plain'), latex = e.clipboardData.getData(LATEX_MIME);
  const n = MC.cursors.length;
  let pieces;
  const kill = MC.kill;
  if (kill && kill.plain.length === n && kill.plain.join('\n') === plain) pieces = kill.plain.map((p, i) => ({ plain: p, latex: kill.latex[i] }));
  else {
    const lines = plain.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const ll = latex ? latex.replace(/\n$/, '').split('\n') : [];
    pieces = lines.length === n && n > 1 ? lines.map((l, i) => ({ plain: l, latex: ll.length === n ? ll[i] : '' }))
      : MC.cursors.map(() => ({ plain, latex }));
  }
  mcEach((c, i) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', pieces[i].plain);
    if (pieces[i].latex) dt.setData(LATEX_MIME, pieces[i].latex);
    c.ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { kind: 'edit' });
}, true);

// ---- keys
//
// With more than one cursor, every action of the keymap either runs at each
// cursor, runs once (the actions of the whole page, and those of the
// cursors themselves), or is refused (those that change the page's
// structure).
const MC_EACH = { bold: 'edit', emph: 'edit', italic: 'edit', mono: 'edit', math: 'edit', deleteline: 'edit', duplicate: 'edit', deltospace: 'edit',
  linestart: 'move', lineend: 'move', selstart: 'move', selend: 'move' };
const MC_CLEARS = new Set(['nextheading', 'prevheading', 'nextblock', 'prevblock', 'source']);
function mcGuard(id, label, scope, fn) {
  if (/^mc/.test(id)) { fn.isMc = true; return fn; }
  if (scope === 'global') return MC_CLEARS.has(id) ? () => { mcClear(); return fn(); } : fn;
  return () => {
    if (!mcActive()) return fn();
    if (id === 'copyline') return mcCopy(false);
    if (id === 'cut') return mcCopy(true);
    if (id === 'delback') return mcDelete(true);
    if (id === 'expand') return mcExpand();
    if (id === 'math' && MC.cursors.some((c) => c.a === c.f)) { banner('Select text at every cursor to make it maths: a new formula takes one cursor.'); return; }
    if (MC_EACH[id]) return mcEach(() => fn(), { kind: MC_EACH[id] });
    banner(`${label} works with one cursor: Esc goes back to one.`);
  };
}
// C-+ at every cursor: words, then lines, then blocks, all at one level
function mcExpand() {
  const lvl = MC.cursors.every((c) => c.a === c.f) ? 0 : Math.min(MC.expand + 1, 2);
  mcEach((c) => {
    if (lvl > 0) { expandLevel = lvl; expandAt = c.ed; }
    expandRegion();
  }, { kind: 'move' });
  MC.expand = Math.max(lvl, 0);
}
// the keys the keymap does not bind: typing, deleting, moving
document.addEventListener('keydown', (e) => {
  if (!mcActive() || RECORDING || PREFIX || e.isComposing || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  const t = e.target;
  if (!t.isContentEditable || !t.closest || !t.closest('#doc')) return;
  const k = keyName(e);
  if (TEXT_KEYS[k] || GLOBAL_KEYS[k]) return;   // through mcGuard
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.metaKey) return;
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) { stop(); mcType(e.key); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.altKey) { stop(); mcDelete(e.key === 'Backspace', e.ctrlKey ? 'word' : 'character'); return; }
  if (/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key) && !e.altKey) { stop(); mcMove(e.key, e.shiftKey, e.ctrlKey); return; }
  if (e.key === 'Enter' || e.key === 'Tab') { stop(); banner(`${e.key} would ${e.key === 'Enter' ? 'split a paragraph' : 'leave the text'}, which takes one cursor: Esc goes back to one.`); }
}, true);
// text put in without a key (a spelling suggestion, an input method's text)
document.addEventListener('beforeinput', (e) => {
  if (!mcActive() || MC.replaying || e.isComposing || !e.target.closest || !e.target.closest('#doc') || !e.target.isContentEditable) return;
  // a spelling suggestion replaces its own word: back to one cursor for it
  if (e.inputType === 'insertReplacementText') { mcClear(); return; }
  if (e.inputType === 'insertText' && e.data) { e.preventDefault(); e.stopImmediatePropagation(); mcType(e.data); }
}, true);
// a dead key or an input method composes its text at the real cursor (the
// browser lets no one else in); when it is done, the same text goes to the
// other cursors
document.addEventListener('compositionstart', (e) => {
  MC.compose = mcActive() && e.target.closest && e.target.closest('#doc') && MC.primary ? { p: MC.primary, len: mcText(MC.primary.ed).length } : null;
}, true);
document.addEventListener('compositionend', (e) => {
  const g = MC.compose;
  MC.compose = null;
  if (!g || !mcActive() || g.p !== MC.primary || !e.data || !g.p.ed.isConnected) return;
  const p = g.p, d = mcText(p.ed).length - g.len;
  for (const c of MC.cursors) if (c !== p && c.ed === p.ed && mcLo(c) >= mcHi(p)) { c.a += d; c.f += d; }
  const now = mcFromSelection();
  if (now && now.ed === p.ed) { p.a = now.a; p.f = now.f; }
  const text = e.data;
  mcEach((c) => { if (c !== p) document.execCommand('insertText', false, text); }, { kind: 'edit', check: false });
}, true);
// C-S-click adds a cursor (or takes away the one there); any other click
// goes back to one cursor
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.target.closest && e.target.closest('#doc')) {
    e.preventDefault(); e.stopImmediatePropagation();
    MC.eatClick = true;   // the click that follows would open a formula, a reference
    const at = pointAt(e.clientX, e.clientY);
    const ed = at && hostOf(at.node);
    if (!mcUsable(ed)) { toast('A cursor goes in the text of a paragraph, heading or caption'); return; }
    if (!MC.cursors.length) { const c = mcFromSelection(); if (c) { MC.cursors = [c]; MC.primary = c; } }
    const off = mcOff(ed, at.node, at.offset);
    const there = MC.cursors.find((c) => c.ed === ed && c.a === c.f && c.f === off);
    if (there && MC.cursors.length > 1) MC.cursors = MC.cursors.filter((c) => c !== there);
    else if (!there) { const c = { ed, a: off, f: off }; MC.cursors.push(c); if (!MC.primary) MC.primary = c; }
    mcSettle();
    mcShowPrimary();
    mcDraw();
    return;
  }
  if (mcActive() && !(e.target.closest && e.target.closest('#findbar, #whichkey, #palette'))) mcClear();
}, true);
for (const type of ['mouseup', 'click']) {
  document.addEventListener(type, (e) => {
    if (!MC.eatClick) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (type === 'click') MC.eatClick = false;
  }, true);
}

// ---- marking
//
// The text to look for: the selection of the primary cursor, or else the
// word at it, which the first press selects.  A word found that way is
// matched as a whole word only.
function mcNeedle() {
  const p = MC.primary;
  if (p.a === p.f) {
    const t = mcText(p.ed), w = /[\p{L}\p{N}_]/u;
    let i = p.f, j = p.f;
    while (i > 0 && w.test(t[i - 1])) i--;
    while (j < t.length && w.test(t[j])) j++;
    if (i === j) { toast('Put the cursor on a word, or select some text'); return null; }
    p.a = i; p.f = j;
    MC.word = true;
  }
  const needle = mcText(p.ed).slice(mcLo(p), mcHi(p));
  if (needle.includes('\uFFFC')) { banner('Select text without formulas or references to mark it again.'); return null; }
  return needle;
}
function mcOccurrences(needle, eds) {
  const out = [], w = /[\p{L}\p{N}_]/u;
  for (const ed of eds) {
    const t = mcText(ed);
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + 1)) {
      if (MC.word && (w.test(t[i - 1] || '') || w.test(t[i + needle.length] || ''))) continue;
      out.push({ ed, a: i, f: i + needle.length });
    }
  }
  return out;
}
const mcTaken = (o) => MC.cursors.some((c) => c.ed === o.ed && mcLo(c) < o.f && o.a < mcHi(c));
function mcNext(dir) {
  if (SRC.on) return smcNext(dir);
  const fresh = !mcActive();
  if (fresh) { if (!mcStart()) return; MC.word = false; }
  MC.dwimBlock = false;
  const needle = mcNeedle();
  if (needle === null) { if (fresh) mcClear(); return; }
  const all = mcOccurrences(needle, mcEditables());
  const sorted = mcSorted();
  const ref = dir > 0 ? sorted[sorted.length - 1] : sorted[0];
  const after = all.filter((o) => mcCmp(o, ref) > 0), before = all.filter((o) => mcCmp(o, ref) < 0);
  const order = dir > 0 ? [...after, ...before] : [...before.reverse(), ...after.reverse()];
  const next = order.find((o) => !mcTaken(o));
  if (!next) {
    toast(`No other “${needle}” in the paper`);
    if (fresh) { const p = MC.primary; mcClear(); mcSelect(p); } else { mcShowPrimary(); mcDraw(); }
    return;
  }
  MC.cursors.push(next);
  MC.primary = next;
  mcSettle();
  mcShowPrimary(true);
  mcDraw();
  mcCount(`${MC.cursors.length} cursors`);
}
function mcUnmark(dir) {
  if (SRC.on) return smcUnmark(dir);
  if (!mcActive()) { toast('There is one cursor'); return; }
  const sorted = mcSorted();
  const gone = dir > 0 ? sorted[sorted.length - 1] : sorted[0];
  MC.cursors = MC.cursors.filter((c) => c !== gone);
  if (MC.primary === gone) { const rest = mcSorted(); MC.primary = dir > 0 ? rest[rest.length - 1] : rest[0]; }
  mcSettle();
  mcShowPrimary(true);
  mcDraw();
}
// every occurrence in the paper, or in the primary cursor's block; from
// the find bar, every match of the search
function mcAll(scope) {
  if (SRC.on) return smcAll(scope);
  const bar = document.activeElement && document.activeElement.closest && document.activeElement.closest('#findbar');
  if (bar) {
    const cs = [];
    for (const r of FIND.matches) {
      const ed = hostOf(r.startContainer);
      if (!mcUsable(ed) || hostOf(r.endContainer) !== ed) continue;
      cs.push({ ed, a: mcOff(ed, r.startContainer, r.startOffset), f: mcOff(ed, r.endContainer, r.endOffset) });
    }
    if (!cs.length) { toast('No matches in the text to put cursors on'); return; }
    const cur = FIND.matches[FIND.cur];
    closeFind();
    mcClear();
    MC.cursors = cs; MC.word = false;
    MC.primary = (cur && cs.find((c) => c.ed === hostOf(cur.startContainer) && c.a === mcOff(c.ed, cur.startContainer, cur.startOffset))) || cs[0];
  } else {
    const fresh = !mcActive();
    if (fresh) { if (!mcStart()) return; MC.word = false; }
    const needle = mcNeedle();
    if (needle === null) { if (fresh) mcClear(); return; }
    const p = MC.primary;
    const found = mcOccurrences(needle, scope === 'block' ? [p.ed] : mcEditables());
    MC.cursors = found.map((o) => (o.ed === p.ed && o.a === mcLo(p) ? p : o));
    if (!MC.cursors.includes(p)) MC.cursors.push(p);
  }
  const n = MC.cursors.length;
  mcSettle();
  mcShowPrimary(true);
  mcDraw();
  mcCount(n > 1 ? `${n} cursors` : 'No other occurrence');
}
function mcDwim() {
  if (SRC.on) return smcDwim();
  if (mcActive() && MC.dwimBlock) { mcAll('paper'); return; }
  mcAll('block');
  MC.dwimBlock = mcActive();
}
// a cursor on each line of the selection, at the column of its end, as
// the lines are drawn on the screen (lines out of the window get none)
function mcLines() {
  if (SRC.on) return smcLines();
  const s = getSelection();
  const r = selRange();
  if (!r || r.collapsed) { banner('Select the lines first: a cursor goes on each line of the selection.'); return; }
  const f = document.createRange();
  f.setStart(s.focusNode, s.focusOffset);
  const fb = mcCaretBox(f);
  // every place between two characters of the selection, with where it is
  // drawn (the boxes of the characters exist off screen too), by line
  const lines = [];
  const root = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const q = document.createRange();
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!r.intersectsNode(n) || !n.data.trim() || (n.parentElement && n.parentElement.closest('.chip')) || !mcUsable(hostOf(n))) continue;
    const from = n === r.startContainer ? r.startOffset : 0, to = n === r.endContainer ? r.endOffset : n.data.length;
    for (let i = from; i < to; i++) {
      q.setStart(n, i); q.setEnd(n, i + 1);
      const b = q.getClientRects()[0];
      if (!b || !b.height) continue;
      const mid = (b.top + b.bottom) / 2;
      let l = lines.find((x) => mid >= x.top && mid <= x.bottom);
      if (!l) lines.push(l = { top: b.top, bottom: b.bottom, at: [] });
      l.at.push([n, i, b.left], [n, i + 1, b.right]);
    }
    if (n === r.endContainer) break;
  }
  const x = fb ? fb.x : 0;
  const cs = [];
  for (const l of lines.sort((a, b) => a.top - b.top)) {
    const [n, i] = l.at.reduce((best, p) => (Math.abs(p[2] - x) < Math.abs(best[2] - x) ? p : best));
    const ed = hostOf(n);
    const off = mcOff(ed, n, i);
    cs.push({ ed, a: off, f: off });
  }
  if (cs.length < 2) { toast('The selection is one line'); return; }
  mcClear();
  MC.cursors = cs; MC.primary = cs[cs.length - 1]; MC.word = false;
  mcSettle();
  mcShowPrimary();
  mcDraw();
  mcCount(`${MC.cursors.length} cursors`);
}
// A cursor on each line of the source that the selection covers, at the
// column (in the line) of the selection's end, as Emacs's edit-lines on the
// .tex file.  A line break of the source is a chip in the page (.nl, or a
// paragraph break), so the lines of a block are the pieces between them.
function mcSourceLines() {
  if (SRC.on) return smcLines();
  const r = selRange(), s = getSelection();
  if (!r || r.collapsed) { banner('Select the lines first: a cursor goes on each line of the source in the selection.'); return; }
  // the source lines of a block, as [start, end] offsets
  const linesOf = (ed) => {
    const out = [];
    let start = 0, off = 0;
    const walk = (p) => {
      for (const c of p.childNodes) {
        if (c.nodeType === 3) { off += c.data.length; continue; }
        if (c.nodeType !== 1) continue;
        if (!mcAtom(c)) { walk(c); continue; }
        if (c.classList.contains('nl') || c.classList.contains('parbreak')) { out.push([start, off]); start = off + 1; }
        off += 1;
      }
    };
    walk(ed);
    out.push([start, off]);
    return out;
  };
  const fed = hostOf(s.focusNode);
  let col = 0;
  if (mcUsable(fed)) {
    const f = mcOff(fed, s.focusNode, s.focusOffset);
    const line = linesOf(fed).find(([a, b]) => f >= a && f <= b);
    col = line ? f - line[0] : 0;
  }
  const cs = [];
  for (const ed of mcEditables()) {
    if (!r.intersectsNode(ed)) continue;
    const lo = ed.contains(r.startContainer) ? mcOff(ed, r.startContainer, r.startOffset) : 0;
    const len = mcText(ed).length;
    const hi = ed.contains(r.endContainer) ? mcOff(ed, r.endContainer, r.endOffset) : len;
    for (const [a, b] of linesOf(ed)) {
      if (b < lo || a > hi || (a === hi && hi > lo)) continue;
      const o = Math.min(a + col, b);
      cs.push({ ed, a: o, f: o });
    }
  }
  if (cs.length < 2) { toast('The selection is on one line of the source'); return; }
  mcClear();
  MC.cursors = cs; MC.primary = cs[cs.length - 1]; MC.word = false;
  mcSettle();
  mcShowPrimary();
  mcDraw();
  mcCount(`${MC.cursors.length} cursors`);
}
function mcNumbers() {
  if (SRC.on) return smcNumbers();
  if (!mcActive()) { toast('Insert numbers needs more than one cursor'); return; }
  mcEach((c, i) => document.execCommand('insertText', false, String(i)), { kind: 'edit', check: false });
}

// "C-M-r" -> "Ctrl+Alt+R"
const prettyKey = (k) => k.replace(/^((?:[CMS]-)*)(.+)$/, (_, mods, key) =>
  mods.replace(/C-/g, 'Ctrl+').replace(/M-/g, 'Alt+').replace(/S-/g, 'Shift+') +
  (key.length === 1 && key !== key.toLowerCase() ? 'Shift+' + key : key.length === 1 ? key.toUpperCase() : key));

let KEYS_DRAFT = null, RECORDING = null;
function openKeys() {
  KEYS_DRAFT = JSON.parse(JSON.stringify(USER_KEYS));
  drawKeys();
  $('#keysbox').hidden = false;
}
function drawKeys() {
  const list = $('#keys-list');
  list.textContent = '';
  const current = (id, d) => KEYS_DRAFT[id] || d;
  // a key clashes with another of the same place, or with a global one
  const used = {};
  for (const [id, , scope, d] of ACTION_DEFS) for (const k of current(id, d)) (used[k] = used[k] || []).push(scope);
  // a key that also starts a chord never runs alone
  const starts = (k) => Object.keys(used).some((o) => o.startsWith(k + ' '));
  const clash = (k, scope) => { const u = used[k] || []; return starts(k) || u.filter((x) => x === scope).length > 1 || (scope === 'global' ? u.length > 1 : u.includes('global')); };
  for (const [id, label, scope, d] of ACTION_DEFS) {
    const keys = current(id, d);
    const row = el('div', 'keyrow');
    if (keys.some((k) => clash(k, scope))) row.classList.add('conflict');
    if (RECORDING === id) row.classList.add('recording');
    row.append(el('span', '', label));
    const ks = el('span', 'keys');
    if (RECORDING === id) ks.textContent = 'press a key (or two, for a chord)…';
    else keys.forEach((k) => ks.append(el('kbd', '', prettyChord(k))));
    const ch = el('button', '', 'Change');
    ch.onclick = () => { RECORDING = id; drawKeys(); };
    row.append(ks, ch);
    list.append(row);
  }
}
// a key, or keys pressed less than a second apart (a chord such as C-c C-a)
let REC_KEYS = [], REC_TIMER = null;
document.addEventListener('keydown', (e) => {
  if (!RECORDING) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  clearTimeout(REC_TIMER);
  if (e.key === 'Escape') { REC_KEYS = []; RECORDING = null; drawKeys(); return; }
  REC_KEYS.push(keyName(e));
  const ks = document.querySelector('#keys-list .keyrow.recording .keys');
  if (ks) ks.textContent = prettyChord(REC_KEYS.join(' ')) + ' …';
  REC_TIMER = setTimeout(finishRecording, 1000);
}, true);
// the keys pressed so far become the shortcut (Save does not wait the second)
function finishRecording() {
  clearTimeout(REC_TIMER);
  if (RECORDING && REC_KEYS.length) KEYS_DRAFT[RECORDING] = [REC_KEYS.join(' ')];
  REC_KEYS = []; RECORDING = null;
  drawKeys();
}
$('#keysbtn').onclick = openKeys;
$('#keys-close').onclick = () => { RECORDING = null; $('#keysbox').hidden = true; };
$('#keys-reset').onclick = () => { KEYS_DRAFT = {}; drawKeys(); try { localStorage.removeItem('mutedHouse'); } catch (e) { /* storage unavailable */ } };
$('#keys-save').onclick = async () => {
  finishRecording();
  await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify(KEYS_DRAFT) });
  USER_KEYS = KEYS_DRAFT;
  applyKeymap();
  $('#keysbox').hidden = true;
  banner('Shortcuts saved.');
};

// ========================================================== save history
//
// The server keeps, for every save, the text each file had before and after
// it.  The dialog lists the saves (newest first), shows what one changed, and
// restores the files as they were before or after it: as unsaved edits.

const HIST = { list: [], cur: null };

async function openHistory() {
  $('#historybox').hidden = false;
  $('#history-list').textContent = 'Loading…';
  try { HIST.list = await (await fetch('/api/history')).json(); }
  catch (e) { HIST.list = []; }
  drawHistoryList();
}

function drawHistoryList() {
  const list = $('#history-list');
  list.textContent = '';
  $('#history-delete').disabled = !HIST.cur || !HIST.list.some((b) => b.batch === HIST.cur.batch);
  if (!HIST.list.length) { list.append(el('p', 'small', 'No saves yet.')); return; }
  for (const b of HIST.list) {
    const row = el('div', 'hist-item' + (HIST.cur === b ? ' active' : ''));
    const d = new Date(b.t * 1000);
    row.append(el('div', 'when', d.toLocaleDateString() + ' ' + d.toLocaleTimeString()),
      el('div', 'what', b.files.map((f) => f.name).join(', ')));
    row.dataset.batch = b.batch;
    row.onclick = () => showHistory(b);
    list.append(row);
  }
}

const historyText = async (id) => {
  const r = await fetch('/api/history/text?id=' + encodeURIComponent(id));
  if (!r.ok) throw new Error('that version is no longer kept');
  return (await r.json()).text;
};

// Lines that changed, with a little context; the rest elided.
function lineDiff(a, b, into) {
  const A = a.split('\n'), B = b.split('\n');
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0; while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const midA = A.slice(p, A.length - q), midB = B.slice(p, B.length - q);
  const ops = lcs(midA, midB, (x, y) => x === y) || [...midA.map((x) => ['-', x, null]), ...midB.map((y) => ['+', null, y])];
  const ctx = 2;
  if (p > ctx) into.append(el('span', 'skip', `… ${p - ctx} unchanged lines\n`));
  for (const l of A.slice(Math.max(0, p - ctx), p)) into.append(l + '\n');
  for (const [op, x, y] of ops) {
    if (op === '=') into.append(x + '\n');
    else into.append(el('span', op === '-' ? 'del' : 'ins', (op === '-' ? x : y) + '\n'));
  }
  for (const l of A.slice(A.length - q, Math.min(A.length, A.length - q + ctx))) into.append(l + '\n');
  if (q > ctx) into.append(el('span', 'skip', `… ${q - ctx} unchanged lines`));
}

async function showHistory(b) {
  HIST.cur = b;
  drawHistoryList();
  const box = $('#history-detail');
  box.textContent = '';
  const acts = el('div', 'hist-actions');
  const before = el('button', '', 'Restore as before this save');
  before.title = 'Put the files of this save back as they were just before it (as unsaved edits)';
  before.onclick = () => restoreHistory(b, 'before');
  const after = el('button', '', 'Restore as after this save');
  after.title = 'Put the files of this save back as this save wrote them (as unsaved edits)';
  after.onclick = () => restoreHistory(b, 'after');
  acts.append(before, after);
  box.append(acts);
  for (const f of b.files) {
    box.append(el('h4', '', f.name));
    const pre = el('pre', 'hist-diff', '');
    box.append(pre);
    try { lineDiff(await historyText(f.before), await historyText(f.after), pre); }
    catch (e) { pre.textContent = e.message; }
    if (HIST.cur !== b) return;     // another save was chosen meanwhile
  }
}

async function restoreHistory(b, which) {
  commit();
  const texts = {};
  try { for (const f of b.files) texts[f.name] = await historyText(f[which]); }
  catch (e) { banner('Could not restore: ' + e.message); return; }
  const missing = Object.keys(texts).filter((n) => !FILES[n]);
  const edited = Object.keys(texts).filter((n) => FILES[n] && FILES[n].text !== FILES[n].disk && FILES[n].text !== texts[n]);
  if (edited.length && !confirm(`${edited.join(', ')} ${edited.length === 1 ? 'has' : 'have'} unsaved edits, which the restored version replaces (Undo brings them back). Restore?`)) return;
  snapshot();
  for (const [n, t] of Object.entries(texts)) if (FILES[n]) FILES[n].text = t;
  const y = viewAnchor();
  render();
  restoreAnchor(y);
  $('#historybox').hidden = true;
  const changed = Object.keys(texts).filter((n) => FILES[n] && FILES[n].text !== FILES[n].disk);
  banner((changed.length ? `Restored ${changed.join(', ')} as ${which} that save: save to keep it, or undo.` : 'The files are already as in that version.') +
    (missing.length ? ` Not restored (no longer part of the document): ${missing.join(', ')}.` : ''));
}

async function deleteHistory(all) {
  const selected = HIST.cur;
  if (!all && !selected) return;
  const message = all
    ? 'Permanently delete ALL editor save-history snapshots for this paper? This does not affect your LaTeX files or Git commits.'
    : 'Permanently delete this editor save-history entry? This does not affect the current paper or Git.';
  if (!confirm(message)) return;
  const req = all ? { all: true } : { batch: selected.batch };
  const response = await fetch('/api/history/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify(req),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { banner('Could not delete save history: ' + (result.error || response.status)); return; }
  HIST.list = result.saves;
  HIST.cur = null;
  $('#history-detail').textContent = 'Select a save to inspect and restore it.';
  drawHistoryList();
  banner('Deleted ' + result.removed + ' save snapshot(s). Manuscript and Git history unchanged.');
}

$('#historybtn').onclick = openHistory;
$('#filesbtn').onclick = () => { closePopovers(); openFiles(); };
$('#files-close').onclick = closeFiles;
$('#files-newsec').onclick = () => {
  const title = prompt('Title of the new section (it names the file too):', '');
  if (title === null) return;
  closeFiles();
  newSectionFile(title, FILESUI.at);
};
$('#files-new').onclick = () => {
  const name = (prompt('Name of the new file (a .tex path inside the paper\'s folder):', sectionsDir() + 'notes.tex') || '').trim();
  if (!name) return;
  const dest = /\.tex$/.test(name) ? name : name + '.tex';
  if (dest.split('/').some((p) => !p || p === '..' || p.startsWith('.'))) { toast('That name is not inside the paper\'s folder', 'error'); return; }
  if (knownFiles().has(dest)) { toast(`${dest} already exists: use Include for it`, 'error'); return; }
  closeFiles();
  const place = FILESUI.at ? { segs: FILES[FILESUI.at.file].segs, after: FILESUI.at } : newSectionPlace(null);
  structural(() => { newFile(dest, PLACEHOLDER + '\n'); insertInputAfter(place, dest); return PLACEHOLDER; });
  toast(`New file ${dest}; save to write it`, 'ok');
};
$('#files-image').onclick = () => { closeFiles(); pickImages(FILESUI.at); };
$('#files-split').onclick = () => { closeFiles(); splitAllSections(); };
$('#history-delete').onclick = () => deleteHistory(false);
$('#history-clear').onclick = () => deleteHistory(true);
$('#history-close').onclick = () => { $('#historybox').hidden = true; };

// ======================================================= main switcher

let OPEN_PROJECT = null;

// ---- Open: recent papers, then the system's folder dialog or a new paper
const OPEN = { path: null };
const agoText = (t) => { const d = Date.now() / 1000 - t; return !t ? '' : d < 3600 ? Math.max(1, Math.round(d / 60)) + ' min ago' : d < 86400 ? Math.round(d / 3600) + ' h ago' : d < 86400 * 30 ? Math.round(d / 86400) + ' days ago' : new Date(t * 1000).toLocaleDateString(); };
async function chooseProjectDirectory() {
  $('#openbox').hidden = false;
  $('#open-mainrow').hidden = true;
  await showRecent(0);
}
// The list of recent papers, with the focus on the one at index `at`.  Each
// one but the paper open now has a × that takes it off the list (Delete does
// the same on the focused one); its files stay where they are.
async function showRecent(at) {
  let recent = await fetch('/api/recent', { headers: { 'X-Token': TOKEN } }).then((r) => r.json()).catch(() => []);
  if (!Array.isArray(recent)) recent = [];
  const list = $('#open-recent');
  list.textContent = '';
  for (const [i, p] of recent.entries()) {
    const row = el('div', 'open-row');
    row.setAttribute('role', 'listitem');
    const b = el('button', 'open-paper' + (p.current ? ' current' : ''));
    b.append(el('span', 'open-paper-no', i < 9 ? String(i + 1) : ''), el('span', 'open-paper-title', p.title || p.main), el('span', 'open-paper-where', p.path.replace(/^\/home\/[^/]+/, '~') + '/' + p.main),
      el('span', 'open-paper-when', p.current ? 'open now' : agoText(p.t)));
    b.title = 'Open ' + p.path + '/' + p.main;
    b.onclick = () => { if (p.current) { $('#openbox').hidden = true; return; } openProject(p.path, p.main); };
    row.append(b);
    if (p.current) row.append(el('span', 'open-forget-none'));
    else {
      const x = xButton('Remove ' + (p.title || p.main) + ' from the recent papers', () => forgetRecent(p, i),
        'Remove from the recent papers (Delete). The files stay.');
      x.classList.add('open-forget');
      x.tabIndex = -1;
      row.append(x);
    }
    list.append(row);
  }
  $('#open-recent-wrap').hidden = !recent.length;
  $('#open-hint').hidden = !recent.length;
  const papers = list.querySelectorAll('.open-paper');
  const focus = papers[Math.min(at, papers.length - 1)] || $('#open-system');
  if (focus) focus.focus({ preventScroll: true });
}
async function forgetRecent(p, i) {
  const r = await fetch('/api/recent/forget', { method: 'POST', headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p.path, main: p.main }) }).catch(() => null);
  if (!r || !r.ok) {
    const err = r ? (await r.json().catch(() => ({}))).error : '';
    toast('Could not remove it from the recent papers' + (err ? ': ' + err : ''), 'error');
    return;
  }
  await showRecent(i);
}
// The documents of a folder chosen with the system's dialog: one opens at
// once, several are offered as buttons
function offerMains(dir, mains) {
  const select = $('#open-main');
  select.textContent = '';
  for (const m of mains) select.append(new Option(m, m));
  OPEN_PROJECT = { path: dir, mains };
  if (mains.length === 1) { openSelectedProject(); return; }
  const row = $('#open-mains');
  row.textContent = '';
  for (const m of mains) {
    const b = el('button', 'primary', 'Open ' + m);
    b.title = 'Open ' + dir + '/' + m;
    b.onclick = () => { select.value = m; openSelectedProject(); };
    row.append(b);
  }
  $('#open-mainsay').textContent = 'This folder has ' + mains.length + ' documents:';
  $('#open-mainrow').hidden = false;
  row.querySelector('button').focus();
}
async function openProject(path, main) {
  OPEN_PROJECT = { path, mains: [main] };
  const select = $('#open-main');
  select.textContent = '';
  select.append(new Option(main, main));
  await openSelectedProject();
}
async function pickDirectory(title) {
  const r = await fetch('/api/pick-directory', { method: 'POST', headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }).catch(() => null);
  if (!r || r.status === 204) return null;
  if (!r.ok) { banner('Could not show the system\'s folder dialog (it needs zenity or kdialog on Linux).'); return null; }
  return r.json();
}
$('#open-system').onclick = async () => {
  const picked = await pickDirectory('Open a paper folder');
  if (!picked) return;
  if (!picked.mains.length) { toast('That folder has no main LaTeX document: \\documentclass and \\begin{document}', 'error'); return; }
  offerMains(picked.path, picked.mains);
};

// ---- New paper: a folder with main.tex for a venue, sections/, references.bib
// and cryptobib, opened at once
async function openNewPaper() {
  $('#openbox').hidden = true;
  const box = $('#newbox');
  box.hidden = false;
  $('#new-status').textContent = '';
  $('#new-create').disabled = false;
  const v = await fetch('/api/venues').then((r) => r.json()).catch(() => null);
  if (v) {
    const sel = $('#new-venue'), was = sel.value;
    sel.textContent = '';
    for (const x of v.venues) sel.append(new Option(x.label, x.id));
    sel.value = was || 'ieee';
    if (!$('#new-parent').value) $('#new-parent').value = v.parent.replace(v.home, '~');
  }
  if (!$('#new-authors').children.length) newAuthorRow();
  newWhere();
  $('#new-name').focus();
}
function newAuthorRow() {
  const row = el('span', 'new-author');
  for (const [k, ph] of [['name', 'Name'], ['email', 'Email'], ['affiliation', 'Affiliation'], ['country', 'Country']]) {
    const i = el('input'); i.dataset.k = k; i.placeholder = ph; i.setAttribute('aria-label', 'Author ' + ph.toLowerCase());
    row.append(i);
  }
  const x = el('button', '', '✕'); x.title = 'Remove this author'; x.onclick = () => row.remove();
  row.append(x);
  $('#new-authors').append(row);
  return row;
}
function newWhere() {
  const p = $('#new-parent').value.trim().replace(/\/+$/, ''), n = $('#new-name').value.trim();
  $('#new-where').textContent = n ? '→ ' + p + '/' + n + '/main.tex' : '';
}
$('#new-name').addEventListener('input', newWhere);
$('#new-parent').addEventListener('input', newWhere);
$('#new-addauthor').onclick = () => newAuthorRow().querySelector('input').focus();
$('#new-pick').onclick = async () => {
  const picked = await pickDirectory('The folder to make the paper in');
  if (picked) { $('#new-parent').value = picked.path; newWhere(); }
};
$('#new-cancel').onclick = () => { $('#newbox').hidden = true; };
$('#open-new').onclick = openNewPaper;
$('#newpaperbtn').onclick = () => { closePopovers(); openNewPaper(); };
$('#new-create').onclick = async () => {
  if (!$('#new-name').value.trim()) { $('#new-status').textContent = 'Give the new folder a name.'; $('#new-name').focus(); return; }
  if (editedFiles().length && !confirm('You have unsaved edits; opening the new paper discards them. Continue?')) return;
  const md = {
    title: $('#new-ptitle').value.trim(),
    abstract: $('#new-abstract').value.trim(),
    keywords: $('#new-keywords').value.split(',').map((k) => k.trim()).filter(Boolean),
    authors: [...document.querySelectorAll('#new-authors .new-author')].map((r) => Object.fromEntries([...r.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()]))).filter((a) => a.name),
  };
  const cryptobib = (document.querySelector('input[name=new-cb]:checked') || {}).value || 'none';
  $('#new-create').disabled = true;
  $('#new-status').textContent = cryptobib === 'none' ? 'Making the paper…' : 'Making the paper and fetching cryptobib (it is large: this can take a minute)…';
  const r = await fetch('/api/new-project', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify({ parent: $('#new-parent').value.trim(), name: $('#new-name').value.trim(), venue: $('#new-venue').value,
      anonymous: $('#new-anon').checked, cryptobib, metadata: md }) }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : { error: 'no answer from the editor' };
  $('#new-create').disabled = false;
  if (!r || !r.ok) { $('#new-status').textContent = 'Could not make it: ' + (d.error || r.status); return; }
  $('#newbox').hidden = true;
  forgetDocument();
  await load(false);
  AUXVER = DOC.auxver;
  for (const k of ['new-name', 'new-ptitle', 'new-abstract', 'new-keywords']) $('#' + k).value = '';
  $('#new-authors').textContent = '';
  toast('New paper ' + d.path + '/' + d.main, 'ok');
  if (d.warnings && d.warnings.length) banner(d.warnings.join(' '));
};

async function openSelectedProject() {
  if (!OPEN_PROJECT) return;
  if (editedFiles().length && !confirm('You have unsaved edits; opening another paper discards them. Continue?')) return;
  const r = await fetch('/api/open-project', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify({ path: OPEN_PROJECT.path, main: $('#open-main').value }) });
  if (!r.ok) { banner('Could not open it: ' + (await r.json()).error); return; }
  $('#openbox').hidden = true;
  OPEN.path = null;
  OPEN_PROJECT = null;
  forgetDocument();
  await load(false);
  AUXVER = DOC.auxver;
}

$('#openbtn').onclick = chooseProjectDirectory;
$('#open-confirm').onclick = openSelectedProject;
$('#open-cancel').onclick = () => { OPEN_PROJECT = null; $('#openbox').hidden = true; };

// Before another document or project is opened: nothing of this one stays.
function forgetDocument() {
  for (const k of Object.keys(FILES)) delete FILES[k];
  HISTORY.undo = []; HISTORY.redo = [];
  for (const k of Object.keys(IGNORED_EXTERNAL)) delete IGNORED_EXTERNAL[k];
  PENDING_EXTERNAL = null; $('#external').hidden = true;
}

function fillMains() {
  const sel = $('#mainsel');
  const mains = DOC.mains || [];
  $('#mainrow').hidden = mains.length < 2;
  sel.textContent = '';
  const here = DOC.main.split('/').pop();
  for (const m of mains) sel.append(new Option(m, m, false, m === here));
}
$('#mainsel').onchange = async () => {
  if (editedFiles().length && !confirm('You have unsaved edits; switching documents discards them. Switch?')) { fillMains(); return; }
  const r = await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify({ main: $('#mainsel').value }) });
  if (!r.ok) { banner('Could not open it: ' + (await r.json()).error); return; }
  forgetDocument();
  await load(false);
};

// ============================================================ paper dialog
//
// Metadata (extracted from the front matter, edited here, saved in the
// project's .paper-editor/metadata.json), and conversion to another class.

const MD = { data: null, info: null, target: 'llncs', anon: false, dirty: false, rootOutput: false, undo: [] };
// Every destructive step in the dialog (restore detected fields, delete an
// author or affiliation) can be taken back: a list of 20 authors must never be
// one wrong click away from gone.
function mdCheckpoint(what) {
  MD.undo.push({ what, data: structuredClone(MD.data) });
  if (MD.undo.length > 50) MD.undo.shift();
}
function mdUndo() {
  const last = MD.undo.pop();
  if (!last) return;
  MD.data = last.data;
  drawPaper(); metadataDirty();
  toast('Undone: ' + last.what);
}
function metadataDirty() {
  MD.dirty = true;
  const status = $('#md-status'); if (status) status.textContent = 'Unsaved metadata changes';
}

async function openPaper() {
  MD.info = await (await fetch('/api/metadata')).json();
  MD.data = JSON.parse(JSON.stringify(MD.info.metadata));
  MD.dirty = false;
  MD.rootOutput = false;
  MD.undo = [];
  MD.history = await fetch('/api/metadata/history').then((r) => r.ok ? r.json() : []).catch(() => []);
  drawPaper();
  $('#paperbox').hidden = false;
}

function drawPaper() {
  const md = MD.data, body = $('#md-body');
  body.textContent = '';
  const need = new Set(missingNow().map(([w, f]) => w + '|' + f));
  const field = (obj, key, label, where, width) => {
    const i = el('input'); i.type = 'text'; i.value = obj[key] || ''; i.placeholder = label;
    i.style.width = width || '14em';
    if (need.has(where + '|' + key)) i.classList.add('need');
    i.oninput = () => {
      obj[key] = i.value;
      metadataDirty();
      if (key === 'name' && md.affiliations.includes(obj)) {
        const afid = md.affiliations.indexOf(obj);
        document.querySelectorAll(`[data-afflink="${afid}"]`).forEach((node) =>
          node.textContent = `${afid + 1}. ${(i.value || '?').slice(0, 30)}`);
      }
      refreshMissing();
    };
    const l = el('label', '', label + ' '); l.append(i);
    return l;
  };
  const origin = el('div', 'small', `Detected from ${md.source_class} front matter${MD.info.saved ? '; manual overrides applied' : ''}. Metadata is saved separately; the LaTeX is never rewritten.`);
  const reset = el('button', '', 'Restore detected fields');
  reset.title = 'Replace saved metadata overrides with values detected from the LaTeX source';
  reset.onclick = () => {
    if (!confirm('Replace your metadata edits with values found in the LaTeX source? (Undo takes it back.)')) return;
    mdCheckpoint('restore detected fields');
    MD.data = structuredClone(MD.info.extracted);
    drawPaper(); metadataDirty();
  };
  const undoBtn = el('button', '', 'Undo');
  undoBtn.id = 'md-undo';
  undoBtn.disabled = !MD.undo.length;
  undoBtn.title = MD.undo.length ? 'Take back: ' + MD.undo[MD.undo.length - 1].what : 'Nothing to undo';
  undoBtn.onclick = mdUndo;
  const status = el('span', 'small', MD.dirty ? 'Unsaved metadata changes' : 'Metadata loaded');
  status.id = 'md-status'; status.setAttribute('role', 'status');
  // earlier saved versions (kept by the server before every save)
  const hist = el('select');
  hist.title = 'Every save keeps the version it replaced: load one into the form (Save to keep it)';
  hist.append(new Option((MD.history || []).length ? `Earlier versions (${MD.history.length})…` : 'No earlier versions yet', ''));
  hist.disabled = !(MD.history || []).length;
  for (const h of MD.history || []) {
    const when = h.at ? new Date(h.at * 1000).toLocaleString() : h.name;
    hist.append(new Option(`${when} · ${h.authors} author${h.authors === 1 ? '' : 's'} · ${(h.title || '').slice(0, 40)}`, h.name));
  }
  hist.onchange = async () => {
    const name = hist.value;
    if (!name) return;
    const r = await fetch('/api/metadata/history/' + encodeURIComponent(name));
    if (!r.ok) { banner('Could not load that version'); return; }
    const v = await r.json();
    mdCheckpoint('load earlier version');
    MD.data = v.metadata;
    drawPaper(); metadataDirty();
    toast('Earlier version loaded: Save metadata keeps it, Undo takes it back');
  };
  body.append(origin, reset, undoBtn, hist, status);
  body.append(el('h4', '', 'Paper'));
  let r = el('div', 'row');
  r.append(field(md, 'title', 'Title', 'paper', '30em'), field(md, 'running_title', 'Running title', 'paper'));
  body.append(r);
  r = el('div', 'row');
  const kw = el('input'); kw.type = 'text'; kw.value = (md.keywords || []).join(', '); kw.style.width = '30em';
  kw.oninput = () => { md.keywords = kw.value.split(',').map((x) => x.trim()).filter(Boolean); metadataDirty(); };
  const kl = el('label', '', 'Keywords (comma-separated) '); kl.append(kw);
  r.append(kl, field(md, 'license', 'Licence (e.g. CC-by)', 'paper', '9em'));
  body.append(r);
  body.append(el('h4', '', 'Authors'));
  md.authors.forEach((a, i) => {
    const where = `author ${i + 1} (${a.name || '?'})`;
    const c = el('div', 'card');
    r = el('div', 'row');
    r.append(field(a, 'name', 'Name', where, '16em'), field(a, 'email', 'Email', where), field(a, 'orcid', 'ORCID', where, '11em'));
    const del = el('button', '', 'Delete'); del.title = 'Remove this author';
    del.onclick = () => { mdCheckpoint('delete author ' + (md.authors[i].name || (i + 1))); md.authors.splice(i, 1); drawPaper(); metadataDirty(); };
    r.append(del);
    c.append(r);
    r = el('div', 'row');
    r.append(el('span', need.has(where + '|affiliation') ? 'missing' : '', 'Affiliations:'));
    md.affiliations.forEach((af, k) => {
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = (a.affiliations || []).includes(k);
      cb.onchange = () => { a.affiliations = md.affiliations.map((_, j) => j).filter((j) => (j === k ? cb.checked : (a.affiliations || []).includes(j))); refreshMissing(); metadataDirty(); };
      const l = el('label', '');
      const txt = el('span', '', (k + 1) + '. ' + (af.name || '?').slice(0, 30));
      txt.dataset.afflink = k;
      l.append(cb, txt);
      r.append(l);
    });
    c.append(r);
    body.append(c);
  });
  const addA = el('button', '', '+ author');
  addA.onclick = () => { md.authors.push({ name: '', email: '', orcid: '', affiliations: [] }); drawPaper(); metadataDirty(); };
  body.append(addA);
  body.append(el('h4', '', 'Affiliations'));
  md.affiliations.forEach((af, k) => {
    const where = `affiliation ${k + 1} (${af.name || '?'})`;
    r = el('div', 'row card');
    r.append(el('b', '', (k + 1) + '.'), field(af, 'name', 'Name', where, '18em'), field(af, 'department', 'Department', where, '10em'),
      field(af, 'city', 'City', where, '8em'), field(af, 'country', 'Country', where, '8em'), field(af, 'ror', 'ROR id', where, '8em'));
    const del = el('button', '', 'Delete');
    del.onclick = () => {
      mdCheckpoint('delete affiliation ' + (md.affiliations[k].name || (k + 1)));
      md.affiliations.splice(k, 1);
      for (const a of md.authors) a.affiliations = (a.affiliations || []).filter((j) => j !== k).map((j) => (j > k ? j - 1 : j));
      drawPaper(); metadataDirty();
    };
    r.append(del);
    body.append(r);
  });
  const addF = el('button', '', '+ affiliation');
  addF.onclick = () => { md.affiliations.push({ name: '', department: '', city: '', country: '', ror: '' }); drawPaper(); metadataDirty(); };
  body.append(addF);
  // conversion
  const cv = el('div', 'convert');
  cv.append(el('h4', '', 'Convert to another class'));
  r = el('div', 'row');
  const sel = el('select');
  for (const [k, label] of Object.entries(MD.info.targets)) sel.append(new Option(label, k, false, k === MD.target));
  sel.onchange = () => { MD.target = sel.value; drawPaper(); };
  const an = el('input'); an.type = 'checkbox'; an.checked = MD.anon;
  an.onchange = () => { MD.anon = an.checked; drawPaper(); };
  const al = el('label', '', ' anonymous (no authors, affiliations or acknowledgements)'); al.prepend(an);
  const rootOutput = el('input'); rootOutput.type = 'checkbox'; rootOutput.checked = MD.rootOutput;
  rootOutput.onchange = () => { MD.rootOutput = rootOutput.checked; };
  const rootLabel = el('label', '', ' Put converted document beside original (rather than converted/<venue>/)');
  rootLabel.prepend(rootOutput);
  const name = el('input'); name.type = 'text'; name.style.width = '16em';
  name.value = DOC.main.split('/').pop().replace(/\.tex$/, '') + '-' + MD.target + (MD.anon ? '-anon' : '') + '.tex';
  const go = el('button', '', 'Convert and build');
  r.append(sel, al);
  cv.append(r);
  r = el('div', 'row');
  const nl = el('label', '', 'Converted document filename '); nl.append(name);
  r.append(nl, rootLabel, go);
  cv.append(r);
  const miss = el('div', 'missingbox');
  cv.append(miss);
  const result = el('div');
  cv.append(result);
  body.append(cv);
  refreshMissing();
  go.onclick = async () => {
    if (!(await saveMetadata(true))) return;
    // the converter reads the files from disk, so unsaved edits would be lost
    // from the converted copy — offer to save first, or say so explicitly
    const dirty = editedFiles();
    if (dirty.length) {
      if (confirm(`You have unsaved edits in ${dirty.join(', ')}. The converter reads the files from disk, so they will NOT be in the converted document. Save them first?`)) {
        await save();
        const still = editedFiles();
        if (still.length) { result.textContent = `Could not save ${still.join(', ')}; not converting.`; return; }
      } else if (!confirm('Convert the on-disk version anyway? Your unsaved edits will not be included.')) {
        return;
      }
    }
    result.textContent = 'Converting and building…';
    const send = (overwrite) => fetch('/api/convert', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
      body: JSON.stringify({ target: MD.target, anonymous: MD.anon, name: name.value, overwrite,
        root: rootOutput.checked }) });
    let resp = await send(false);
    if (resp.status === 409 && confirm(`${name.value} exists. Overwrite it?`)) resp = await send(true);
    const res = await resp.json();
    if (!resp.ok) { result.textContent = res.error; return; }
    result.textContent = '';
    result.append(el('p', res.built && !res.undefined ? 'ok' : 'missing',
      res.built ? `${res.file} written and built` + (res.undefined ? `, with ${res.undefined} undefined references or citations` : '.') :
        `${res.file} written, but the build failed: ${res.errors.join(' ')}`));
    for (const w of res.warnings) result.append(el('p', 'small', '• ' + w));
    const open = el('button', '', 'Open it in the editor');
    open.onclick = async () => {
      const opened = await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ main: res.file }) });
      if (!opened.ok) { banner('Could not open converted file: ' + (await opened.json()).error); return; }
      for (const k of Object.keys(FILES)) delete FILES[k];
      $('#paperbox').hidden = true;
      await load(false);
    };
    result.append(open);
  };
}

function missingNow() {
  // what the chosen target needs, computed here so the form updates as you type
  const req = { ieee: [['name'], ['name'], ['title']], llncs: [['name'], ['name'], ['title']],
    iacrcc: [['name', 'email'], ['name', 'country'], ['title', 'license']], iacrtrans: [['name'], ['name'], ['title']],
    acmart: [['name', 'email'], ['name', 'city', 'country'], ['title']], lipics: [['name'], ['name'], ['title', 'license']],
    article: [['name'], [], ['title']] }[MD.target];
  const md = MD.data, out = [];
  if (!req) return out;
  for (const f of req[2]) if (!md[f]) out.push(['paper', f]);
  if (!md.authors.length && !MD.anon) out.push(['paper', 'authors']);
  if (MD.anon) return out;     // an anonymous version needs no author data
  md.authors.forEach((a, i) => {
    const w = `author ${i + 1} (${a.name || '?'})`;
    for (const f of req[0]) if (!a[f]) out.push([w, f]);
    if (req[1].length && !(a.affiliations || []).length) out.push([w, 'affiliation']);
  });
  md.affiliations.forEach((af, k) => { for (const f of req[1]) if (!af[f]) out.push([`affiliation ${k + 1} (${af.name || '?'})`, f]); });
  return out;
}

function refreshMissing() {
  const box = document.querySelector('#md-body .missingbox');
  if (!box) return;
  const m = missingNow();
  box.className = 'missingbox ' + (m.length ? 'missing' : 'ok');
  box.textContent = m.length ? `${MD.info.targets[MD.target]} needs: ` + m.map(([w, f]) => `${f} of ${w}`).join('; ')
    : `Everything ${MD.info.targets[MD.target]} needs is filled in.`;
}

async function saveMetadata(quiet) {
  const r = await fetch('/api/metadata', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify(MD.data) });
  if (!r.ok) {
    const msg = 'Metadata save failed (' + r.status + ')';
    const status = $('#md-status'); if (status) status.textContent = msg;
    banner(msg);
    return false;
  }
  MD.info = await r.json();
  MD.dirty = false;
  MD.history = await fetch('/api/metadata/history').then((x) => x.ok ? x.json() : MD.history).catch(() => MD.history);
  const status = $('#md-status');
  if (status) status.textContent = 'Saved locally at ' + new Date().toLocaleTimeString();
  if (!quiet) banner('Metadata saved successfully in .paper-editor/metadata.json.');
  return true;
}

$('#paperbtn').onclick = openPaper;
$('#md-save').onclick = () => saveMetadata(false);
$('#md-close').onclick = () => {
  if (MD.dirty && !confirm('Discard unsaved metadata changes?')) return;
  $('#paperbox').hidden = true;
};

// ============================================================ source view
//
// The .tex and .bib files of the folder as text, with line numbers and light
// syntax colouring, beside a small list of the files.  A file of the document
// edited here is the same text as the paper view (the page is drawn again
// from it); another .tex or a .bib file is kept apart and saved with Ctrl+S
// like the rest.
var SRC = { on: false,   // var: read by markEdited() before this line runs
  name: null, files: [], extra: {}, timer: 0, snap: 0 };

function srcDoc(name) { return !!FILES[name] && !!(DOC && Object.prototype.hasOwnProperty.call(DOC.files, name)); }
function srcText(name) {
  if (srcDoc(name)) { commit(); return FILES[name].text; }
  return SRC.extra[name] ? SRC.extra[name].text : '';
}
function extraEdited() { return Object.keys(SRC.extra).filter((n) => SRC.extra[n].text !== SRC.extra[n].disk); }

const escSrc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// colours for LaTeX: comments, \commands, \begin/\end{env}, maths, braces
function highlightTex(text) {
  const re = /(%[^\n]*)|(\\(?:begin|end)\s*\{[^}\n]*\})|(\\(?:[A-Za-z@]+\*?|.))|(\$\$?(?:[^$\\]|\\.)*?\$\$?)|([{}\[\]])/g;
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    out += escSrc(text.slice(last, m.index));
    const t = escSrc(m[0]);
    if (m[1]) out += `<span class="hc">${t}</span>`;
    else if (m[2]) out += `<span class="he">${t}</span>`;
    else if (m[3]) out += `<span class="hk">${t}</span>`;
    else if (m[4]) out += `<span class="hm">${highlightMath(m[0])}</span>`;
    else out += `<span class="hb">${t}</span>`;
    last = m.index + m[0].length;
  }
  return out + escSrc(text.slice(last));
}
function highlightMath(t) { return escSrc(t).replace(/\\[A-Za-z]+/g, '<span class="hk">$&</span>'); }
// colours for BibTeX: @type{key, field = …
function highlightBib(text) {
  return text.split('\n').map((line) => {
    let m;
    if ((m = /^(\s*)(@\w+)(\s*\{\s*)([^,\s]*)(.*)$/.exec(line))) return escSrc(m[1]) + `<span class="he">${escSrc(m[2])}</span>` + escSrc(m[3]) + `<span class="hk">${escSrc(m[4])}</span>` + escSrc(m[5]);
    if ((m = /^(\s*)([A-Za-z][\w-]*)(\s*=)(.*)$/.exec(line))) return escSrc(m[1]) + `<span class="hf">${escSrc(m[2])}</span>` + escSrc(m[3]) + highlightTex(m[4]);
    if (/^\s*%/.test(line)) return `<span class="hc">${escSrc(line)}</span>`;
    return highlightTex(line);
  }).join('\n');
}

function buildSourceView() {
  if ($('#srcview')) return;
  const v = el('div'); v.id = 'srcview'; v.hidden = true;
  v.innerHTML = `<nav id="srcfiles" aria-label="Files"></nav>
    <div id="srcmain">
      <div id="srchead"><b id="srcname"></b><span id="srcstate" class="small"></span><span class="spacer"></span>
        <select id="srcoutline" title="Go to a heading of this file" aria-label="Headings of this file"></select>
        <span id="srcpos" class="small" title="Go to line (Alt+G)"></span>
        <button id="srcrename" title="Rename this file (every \\input of it, or \\bibliography naming it, is updated)">Rename…</button>
        <button id="srcdelete" title="Move this file to the editor's trash (.paper-editor/trash)">Delete…</button>
        <button id="srcwrapbtn" title="Wrap long lines" aria-pressed="true">Wrap</button>
        <button id="srcpreview" title="Show the files without editing them here: edit in your own editor, and this view follows the files on disk" aria-pressed="false">Preview only</button>
        <button id="srcext" title="Open this file at the cursor's line in your editor (Ctrl+Alt+Z)">Open in your editor</button>
        <button id="srcback" title="Back to the paper at this line (Ctrl+Alt+E or Esc)">Back to the paper</button>
        <button id="srcx" class="xclose" aria-label="Close the source view" title="Close: back to the paper (Esc)"><svg class="ic" aria-hidden="true"><use href="#i-close"/></svg></button></div>
      <div id="srcbox"><pre id="srcgutter" aria-hidden="true"></pre>
        <div id="srcwrap"><pre id="srchl" aria-hidden="true"></pre><textarea id="srcta" spellcheck="false" wrap="soft" aria-label="Source"></textarea></div></div>
    </div>`;
  $('#doc').after(v);
  const ta = $('#srcta');
  const sync = () => { $('#srchl').style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`; $('#srcgutter').scrollTop = ta.scrollTop; };
  ta.addEventListener('scroll', sync);
  ta.addEventListener('beforeinput', () => {
    // one snapshot of the paper's undo history per burst of typing here
    if (Date.now() - SRC.snap > 1500 && srcDoc(SRC.name)) snapshot();
    SRC.snap = Date.now();
  });
  ta.addEventListener('input', () => {
    if (SRC.quiet) return;
    paintSource();
    const name = SRC.name;
    if (srcDoc(name)) {
      clearTimeout(SRC.timer);
      SRC.timer = setTimeout(() => flushSource(), 400);
    } else if (SRC.extra[name]) { SRC.extra[name].text = ta.value; markEdited(); drawSourceFiles(); }
  });
  const pos = () => {
    const before = ta.value.slice(0, ta.selectionStart);
    const line = before.split('\n').length, col = before.length - before.lastIndexOf('\n');
    $('#srcpos').textContent = `line ${line}, column ${col}`;
  };
  ta.addEventListener('keyup', pos); ta.addEventListener('click', pos); ta.addEventListener('select', pos);
  ta.addEventListener('keydown', (e) => {
    const k = keyName(e);
    if (SRC.preview && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key.length === 1 || /^(Enter|Backspace|Delete|Tab)$/.test(e.key))) {
      if (!(Date.now() - (SRC.saidPreview || 0) < 4000)) toast('Preview only: edit in your editor (Ctrl+Alt+Z), or turn Preview only off to edit here');
      SRC.saidPreview = Date.now();
      return;
    }
    if (SOURCE_KEYS[k] && !ta.readOnly) { e.preventDefault(); e.stopPropagation(); SOURCE_KEYS[k](); setTimeout(() => ta.dispatchEvent(new Event('keyup')), 0); return; }
    // brackets typed at the caret come in pairs (and Backspace takes an empty pair)
    if (!ta.readOnly && !e.ctrlKey && !e.altKey && !e.metaKey &&
        ((e.key === 'Backspace' && srcPairBackspace(ta)) || (e.key.length === 1 && srcPair(ta, e.key)))) { e.preventDefault(); return; }
    // a bracket or $ typed over a selection wraps it, as in the page
    const pair = { '{': '}', '(': ')', '[': ']', $: '$' }[e.key];
    if (pair && !ta.readOnly && !e.ctrlKey && !e.altKey && !e.metaKey && ta.selectionStart !== ta.selectionEnd) {
      e.preventDefault();
      const a = ta.selectionStart, b = ta.selectionEnd, inner = ta.value.slice(a, b);
      srcReplace(ta, a, b, e.key + inner + pair);
      ta.setSelectionRange(a + 1, a + 1 + inner.length);
    }
  });
  $('#srcpos').onclick = () => SOURCE_ACTIONS.gotoLine();
  $('#srcoutline').onchange = () => {
    const line = +$('#srcoutline').value;
    if (line) SOURCE_ACTIONS.gotoLine(line);
    $('#srcoutline').value = '';
  };
  $('#srcback').onclick = () => toggleSource(false);
  $('#srcx').onclick = () => toggleSource(false);
  $('#srcrename').onclick = () => srcRename();
  $('#srcdelete').onclick = () => srcDelete();
  $('#srcwrapbtn').onclick = () => setSourceWrap(!SRC.wrap);
  $('#srcpreview').onclick = () => setSourcePreview(!SRC.preview);
  $('#srcext').onclick = () => openExternalHere();
  let previewOn = false;
  try { previewOn = localStorage.getItem('srcpreview') === '1'; } catch (e) { /* storage unavailable */ }
  setSourcePreview(previewOn, true);
  let wrapOn = true;
  try { wrapOn = localStorage.getItem('srcwrap') !== '0'; } catch (e) { /* storage unavailable */ }
  setSourceWrap(wrapOn, true);
  // a wider or narrower window wraps the lines anew: the line numbers follow
  new ResizeObserver(() => { if (SRC.on && SRC.wrap) requestAnimationFrame(sizeGutter); }).observe($('#srcwrap'));
}
// Preview only: the source view shows the files and follows them on disk,
// and they are edited in the user's own editor (Open in your editor).
function setSourcePreview(on, quiet = false) {
  SRC.preview = !!on;
  $('#srcpreview').setAttribute('aria-pressed', String(SRC.preview));
  $('#srcpreview').classList.toggle('pressed', SRC.preview);
  try { localStorage.setItem('srcpreview', SRC.preview ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  const ta = $('#srcta');
  if (SRC.on) {
    flushSource();
    ta.readOnly = SRC.preview || !!(SRC.extra[SRC.name] && SRC.extra[SRC.name].truncated);
  }
  if (!quiet) toast(SRC.preview ? 'Preview only: edit in your editor (Ctrl+Alt+Z)' : 'The source view edits again');
}
// The top of line `line` (from 1) in the source text, in pixels, wrapped
// lines counted at their height
function srcLineTop(line) {
  const hl = $('#srchl'), row = hl && hl.children[line - 1];
  if (row) return row.getBoundingClientRect().top - hl.getBoundingClientRect().top;
  const lh = parseFloat(getComputedStyle($('#srcta')).lineHeight) || 18;
  return (line - 1) * lh;
}
// The first line whose row shows at the top of the source view
function srcTopLine() {
  const ta = $('#srcta'), rows = $('#srchl').children;
  if (!rows.length) return Math.floor(ta.scrollTop / (parseFloat(getComputedStyle(ta).lineHeight) || 18)) + 1;
  const base = $('#srchl').getBoundingClientRect().top;
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {           // the first row whose bottom is below the top
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom - base > ta.scrollTop + 1) hi = mid; else lo = mid + 1;
  }
  return lo + 1;
}

// ---- your own editor: the file at a line, in the editor of the config's
// "external_editor" (Emacs, else VS Code, else the system's opener).
async function openExternal(name, line = 1, col = 1) {
  if (!name) { toast('No file here to open', 'error'); return; }
  if (editedFiles().includes(name)) toast(name + ' has unsaved edits here: your editor opens the file on disk (save first to give it them)');
  const r = await fetch('/api/external-edit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify({ name, line, col }) }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) { toast('Could not open your editor: ' + (d.error || (r ? 'error ' + r.status : 'no answer from the editor')), 'error'); return; }
  toast(`Opened ${name}:${line} in ${d.cmd}`, 'ok');
}
function openExternalHere() {
  if (SRC.on) {
    const ta = $('#srcta'), before = ta.value.slice(0, ta.selectionStart);
    const line = before.split('\n').length, col = before.length - before.lastIndexOf('\n');
    // the cursor's line, or the top line when the cursor is off screen
    const caretOn = srcLineTop(line) >= ta.scrollTop && srcLineTop(line) < ta.scrollTop + ta.clientHeight;
    return openExternal(SRC.name, caretOn ? line : srcTopLine(), caretOn ? col : 1);
  }
  const seg = caretSeg();
  const at = seg && seg.file ? seg : (() => { const a = viewAnchor(); return a.list ? ORDER.filter((x) => x.el && x.el.isConnected)[a.i] : null; })();
  if (!at || !at.file) return openExternal(DOC.main, 1);
  return openExternal(at.file, at.line || 1);
}

// Long lines wrapped (the default) or scrolled sideways
function setSourceWrap(on, quiet = false) {
  SRC.wrap = !!on;
  $('#srcview').classList.toggle('wrap', SRC.wrap);
  $('#srcta').setAttribute('wrap', SRC.wrap ? 'soft' : 'off');
  $('#srcwrapbtn').setAttribute('aria-pressed', String(SRC.wrap));
  try { localStorage.setItem('srcwrap', SRC.wrap ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  if (SRC.on) { paintSource(); $('#srcta').dispatchEvent(new Event('scroll')); }
  if (!quiet) toast(SRC.wrap ? 'Long lines wrapped' : 'Long lines not wrapped');
}
// Each line number as tall as its line once wrapped
function sizeGutter() {
  const g = $('#srcgutter'), hl = $('#srchl'), ta = $('#srcta');
  hl.style.width = ta.clientWidth + 'px';
  const rows = hl.children, nums = g.children;
  if (!SRC.wrap || $('#srcwrap').classList.contains('plain')) { for (const n of nums) n.style.height = ''; return; }
  const hs = [...rows].map((r) => r.getBoundingClientRect().height);
  for (let i = 0; i < nums.length; i++) nums[i].style.height = hs[i] ? hs[i] + 'px' : '';
  g.scrollTop = ta.scrollTop;
}

function paintSource() {
  const ta = $('#srcta');
  const text = ta.value;
  // a very large file (cryptobib's crypto.bib) is shown without colours
  const plain = text.length > 600000;
  $('#srcwrap').classList.toggle('plain', plain);
  const lines = text.split('\n');
  const bib = /\.bib$/.test(SRC.name || '');
  // one row per line, so that a wrapped line's number can be as tall as it
  $('#srchl').innerHTML = plain ? '' : lines.map((l) => '<div>' + ((bib ? highlightBib(l) : highlightTex(l)) || '\u200b') + '</div>').join('');
  const n = lines.length;
  if ($('#srcgutter').dataset.n !== String(n)) {
    $('#srcgutter').innerHTML = Array.from({ length: n }, (_, i) => `<div>${i + 1}</div>`).join('');
    $('#srcgutter').dataset.n = String(n);
  }
  sizeGutter();
  $('#srcgutter').scrollTop = ta.scrollTop;
  const name = SRC.name;
  const edited = srcDoc(name) ? ta.value !== FILES[name].disk : (SRC.extra[name] && SRC.extra[name].text !== SRC.extra[name].disk);
  $('#srcstate').textContent = edited ? 'edited' : '';
  clearTimeout(paintSource.t);
  paintSource.t = setTimeout(() => { markSourceChanges(); fillSourceOutline(); }, 250);
}

// The lines changed since the last save, marked in the gutter as an editor's
// change bar: added, changed, and where lines were taken out.
function markSourceChanges() {
  const g = $('#srcgutter');
  const name = SRC.name;
  const disk = srcDoc(name) ? FILES[name].disk : SRC.extra[name] && SRC.extra[name].disk;
  for (const d of g.querySelectorAll('.chg-add, .chg-mod, .chg-del')) d.classList.remove('chg-add', 'chg-mod', 'chg-del');
  const text = $('#srcta').value;
  if (disk === undefined || text.length > 600000) return;
  const a = disk === null ? [] : disk.split('\n'), b = text.split('\n');
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const rows = g.children;
  const mark = (i, cls) => { if (rows[i]) rows[i].classList.add(cls); };
  const ops = lcs(a.slice(lo, ea), b.slice(lo, eb), (x, y) => x === y);
  if (!ops) { for (let i = lo; i < eb; i++) mark(i, 'chg-mod'); return; }
  let j = lo, pendingDel = 0;
  for (let k = 0; k < ops.length; k++) {
    const [op] = ops[k];
    if (op === '=') { if (pendingDel) { mark(j, 'chg-del'); pendingDel = 0; } j++; continue; }
    if (op === '-') { pendingDel++; continue; }
    mark(j, pendingDel ? 'chg-mod' : 'chg-add');
    if (pendingDel) pendingDel--;
    j++;
  }
  if (pendingDel) mark(Math.min(j, rows.length - 1), 'chg-del');
}

// The headings of the file, to jump to.
function fillSourceOutline() {
  const sel = $('#srcoutline');
  const lines = $('#srcta').value.split('\n');
  const items = [];
  const re = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{(.*)/;
  const indent = { part: '', chapter: '', section: '', subsection: '\u2003', subsubsection: '\u2003\u2003', paragraph: '\u2003\u2003\u2003' };
  lines.forEach((l, i) => {
    const m = re.exec(l);
    if (m) items.push([i + 1, indent[m[1]] + plainOfLatex(m[2].replace(/\}[^}]*$/, '')).slice(0, 70)]);
    else if (/^\s*@\w+\s*\{\s*([^,\s]+)/.test(l) && /\.bib$/.test(SRC.name || '')) items.push([i + 1, /\{\s*([^,\s]+)/.exec(l)[1]]);
  });
  refreshSidebarSoon();
  const key = JSON.stringify(items);
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  sel.textContent = '';
  sel.append(new Option(items.length ? `Go to… (${items.length})` : 'No headings', ''));
  for (const [line, label] of items.slice(0, 2000)) sel.append(new Option(`${label}  ·  ${line}`, String(line)));
  sel.hidden = !items.length;
}

// The text of the source view into the document (a file of the paper): the
// page is drawn again from it.
function flushSource() {
  clearTimeout(SRC.timer);
  const name = SRC.name;
  if (!SRC.on || !name || !srcDoc(name)) return;
  const v = $('#srcta').value;
  commit();
  if (FILES[name].text === v) return;
  FILES[name].text = v;
  render();
  drawSourceFiles();
}

async function openSourceFile(name, line, screenY = null) {
  flushSource();
  if (!srcDoc(name) && !SRC.extra[name]) {
    const r = await fetch('/api/srcfile?name=' + encodeURIComponent(name)).catch(() => null);
    const d = r && r.ok ? await r.json() : null;
    if (!d) { toast('Could not read ' + name, 'error'); return; }
    SRC.extra[name] = { text: d.text, disk: d.text, base: d.hash, truncated: !!d.truncated };
  }
  SRC.name = name;
  const ta = $('#srcta');
  ta.value = srcText(name);
  const part = !!(SRC.extra[name] && SRC.extra[name].truncated);
  ta.readOnly = part || !!SRC.preview;
  $('#srcname').textContent = name;
  paintSource();
  if (part) $('#srcstate').textContent = 'large file: its first 2 MB, read only';
  drawSourceFiles();
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  // the line where the paper showed its block (screenY), else a few lines down
  // (kept inside the text box: the paper's block may sit above its top)
  const place = () => {
    const want = screenY !== null ? Math.max(0, Math.min(ta.clientHeight - 2 * lh, screenY - ta.getBoundingClientRect().top)) : 3 * lh;
    ta.scrollTop = Math.max(0, srcLineTop(line || 1) - want);
    ta.dispatchEvent(new Event('scroll'));
  };
  place();
  // again once the wrapped rows have their final heights (the gutter and the
  // text box size themselves after this first paint)
  requestAnimationFrame(() => { if (SRC.on && SRC.name === name) place(); });
  if (line) {
    const lines = ta.value.split('\n');
    const at = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
    ta.setSelectionRange(at, at);
  }
  ta.focus({ preventScroll: true });
  ta.dispatchEvent(new Event('scroll'));
}

function drawSourceFiles() {
  const nav = $('#srcfiles');
  if (!nav) return;
  nav.textContent = '';
  const add = el('button', 'srcnew', '+ New file…');
  add.title = 'A new .tex or .bib file in the paper\'s folder (a .tex can be read by the document at once)';
  add.onclick = () => srcNewFile();
  nav.append(add);
  if ($('#srcrename')) {
    const main = SRC.name === DOC.main;
    $('#srcrename').disabled = main || !SRC.name;
    $('#srcdelete').disabled = main || !SRC.name;
    $('#srcrename').title = main ? 'The main file is renamed outside the editor' : 'Rename this file (every \\input of it, or \\bibliography naming it, is updated)';
    $('#srcdelete').title = main ? 'The main file cannot be deleted here' : 'Move this file to the editor\'s trash (.paper-editor/trash)';
  }
  const groups = [['Document', SRC.files.filter((f) => f.doc)], ['Other .tex', SRC.files.filter((f) => !f.doc && f.name.endsWith('.tex'))],
    ['Bibliography', SRC.files.filter((f) => f.name.endsWith('.bib'))]];
  for (const [title, files] of groups) {
    if (!files.length) continue;
    nav.append(el('div', 'srcgroup', title));
    for (const f of files) {
      const b = el('button', 'srcfile', f.name);
      b.title = f.name;
      const edited = srcDoc(f.name) ? (f.name === SRC.name ? $('#srcta').value : FILES[f.name].text) !== FILES[f.name].disk
        : SRC.extra[f.name] && SRC.extra[f.name].text !== SRC.extra[f.name].disk;
      if (edited) b.classList.add('edited');
      if (f.name === SRC.name) { b.classList.add('current'); b.setAttribute('aria-current', 'true'); }
      b.onclick = () => openSourceFile(f.name);
      const row = el('div', 'srcrow');
      row.append(b);
      // every file but the main one can be renamed (✎, a double-click or F2
      // on it) or go to the trash (✕) from here
      if (f.name !== DOC.main) {
        const ren = el('button', 'srcfile-ren', '✎');
        ren.title = `Rename ${f.name} (every \\input of it, or \\bibliography naming it, follows)`;
        ren.setAttribute('aria-label', `Rename ${f.name}`);
        ren.onclick = (e) => { e.stopPropagation(); renameInList(row, f.name); };
        row.append(ren);
        b.ondblclick = (e) => { e.preventDefault(); renameInList(row, f.name); };
        b.addEventListener('keydown', (e) => { if (e.key === 'F2') { e.preventDefault(); renameInList(row, f.name); } });
        const del = el('button', 'srcfile-del', '✕');
        del.title = `Delete ${f.name}: move it to the editor's trash (.paper-editor/trash)`;
        del.setAttribute('aria-label', `Delete ${f.name}`);
        del.onclick = (e) => { e.stopPropagation(); srcDelete(f.name); };
        row.append(del);
      }
      nav.append(row);
    }
  }
}

async function toggleSource(on = !SRC.on) {
  if (on === SRC.on) return;
  buildSourceView();
  if (on) {
    leaveDiff();
    commit();
    // where the caret is in the paper: that file and line
    const caret = caretSeg();
    SRC.paperAt = caret && caret.el ? caret : null;      // where a new file's \input goes
    // the source shows the same place as the paper: the caret's block when
    // it is on screen, otherwise the block at the top, each line where its
    // block was on the screen
    const onScreen = (x) => { if (!x || !x.el || !x.file) return false; const r = x.el.getBoundingClientRect(); return r.bottom > chromeBottom() && r.top < innerHeight; };
    let seg = onScreen(caret) ? caret : null;
    if (!seg) { const a = viewAnchor(); seg = a.list ? ORDER.filter((x) => x.el && x.el.isConnected)[a.i] : null; if (seg && !seg.file) seg = null; }
    if (!seg && caret && caret.file) seg = caret;
    const screenY = onScreen(seg) ? seg.el.getBoundingClientRect().top : null;
    const name = seg && seg.file ? seg.file : (SRC.name && (srcDoc(SRC.name) || SRC.extra[SRC.name]) ? SRC.name : DOC.main);
    const line = seg && seg.file ? seg.line : null;
    SRC.on = true;
    document.body.classList.add('sourcemode');
    $('#srcview').hidden = false;
    $('#sourcebtn').setAttribute('aria-pressed', 'true');
    window.scrollTo(0, 0);
    try { SRC.files = await (await fetch('/api/srcfiles')).json(); } catch (e) { SRC.files = []; }
    if (!Array.isArray(SRC.files)) SRC.files = [];
    for (const n of Object.keys(FILES)) if (!SRC.files.some((f) => f.name === n)) SRC.files.unshift({ name: n, doc: true });
    await openSourceFile(name, line, screenY);
    return;
  }
  flushSource();
  const ta = $('#srcta');
  const caretLine = ta.value.slice(0, ta.selectionStart).split('\n').length;
  const name = SRC.name;
  // the caret's line when it is on screen, otherwise the top line; its block
  // goes where that block's first line was on the screen
  const visible = (l) => srcLineTop(l) + 2 >= ta.scrollTop && srcLineTop(l) < ta.scrollTop + ta.clientHeight;
  const useCaret = visible(caretLine) && document.activeElement === ta;
  const line = useCaret ? caretLine : srcTopLine();
  // (the block of that line, or the last one before it: a blank line or a comment)
  const segOfLine = srcDoc(name) ? (ORDER.find((s) => s.file === name && s.el && s.line <= line && line <= (s.lastLine || s.line))
    || ORDER.filter((s) => s.file === name && s.el && s.line && s.line <= line).pop()) : null;
  const screenY = segOfLine ? ta.getBoundingClientRect().top + srcLineTop(segOfLine.line) - ta.scrollTop : null;
  SRC.on = false;
  refreshSidebarSoon();
  document.body.classList.remove('sourcemode');
  $('#srcview').hidden = true;
  $('#sourcebtn').setAttribute('aria-pressed', 'false');
  // back at the block of that line
  const seg = segOfLine && segOfLine.el.isConnected ? segOfLine
    : srcDoc(name) && ORDER.find((s) => s.file === name && s.el && s.line <= line && line <= (s.lastLine || s.line));
  if (seg) {
    const top = Math.max(chromeBottom(), Math.min(innerHeight - 40, screenY === null ? innerHeight / 3 : screenY));
    window.scrollBy(0, seg.el.getBoundingClientRect().top - top);
    restoreAnchor({ y: window.scrollY, i: ORDER.indexOf(seg), file: seg.file, src: seg.src, top, list: [{ file: seg.file, src: seg.src, top }] });
    if (useCaret && seg.edit && seg.edit.isContentEditable) {
      const r = document.createRange(); r.selectNodeContents(seg.edit); r.collapse(true);
      seg.edit.focus({ preventScroll: true });
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }
  }
}
$('#sourcebtn').onclick = () => toggleSource();

// The document was read again (a save, an outside change): the source view
// shows the new text unless it has edits of its own.
function refreshSourceView() {
  if (!SRC.on || !SRC.name || !srcDoc(SRC.name)) return;
  const ta = $('#srcta');
  commit();
  let changedAt = null;
  if (ta.value !== FILES[SRC.name].text && (SRC.preview || document.activeElement !== ta)) {
    const top = ta.scrollTop, a = ta.selectionStart;
    const was = ta.value.split('\n'), now = FILES[SRC.name].text.split('\n');
    let k = 0;
    while (k < was.length && k < now.length && was[k] === now[k]) k++;
    changedAt = k + 1;
    ta.value = FILES[SRC.name].text;
    ta.scrollTop = top; ta.setSelectionRange(a, a);
  }
  paintSource();
  // a change made in the user's editor: shown, if it is off screen
  if (changedAt !== null && SRC.preview) {
    const y = srcLineTop(changedAt);
    if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - 20) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
    ta.dispatchEvent(new Event('scroll'));
  }
  drawSourceFiles();
}

// ---- editing keys of the source view (your Emacs bindings by default).
// Every change goes through insertText, so the text's own undo (Ctrl+Z)
// takes it back.
const srcTa = () => SMC.shadow || $('#srcta');
function srcLineBounds(ta, a = ta.selectionStart, b = ta.selectionEnd) {
  const v = ta.value;
  const start = v.lastIndexOf('\n', a - 1) + 1;
  let end = v.indexOf('\n', b > a && v[b - 1] === '\n' ? b - 1 : b);
  if (end < 0) end = v.length;
  return [start, end];
}
function srcReplace(ta, a, b, text) {
  if (ta.shadow) {
    if (a !== b || text) ta.ops.push([a, b, text]);
    ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
    ta.setSelectionRange(a + text.length, a + text.length);
    return;
  }
  ta.focus();
  ta.setSelectionRange(a, b);
  if (!document.execCommand('insertText', false, text)) { ta.setRangeText(text, a, b, 'end'); ta.dispatchEvent(new Event('input')); }
}
// Brackets typed at the caret come in pairs, as with Emacs's
// electric-pair-mode: ( [ { insert their closing one after the caret (after a
// backslash, the escaped one: \( gives \(\)), when what follows is a space,
// the end of the line or a closing bracket or punctuation; a closing bracket
// typed before the same one steps over it; Backspace between an empty pair
// takes both.  ta is the text area, or the copy of its text that multiple
// cursors edit.
const SRC_PAIRS = { '(': ')', '[': ']', '{': '}' };
function srcPair(ta, key) {
  const a = ta.selectionStart, v = ta.value;
  if (a !== ta.selectionEnd) return false;
  if (SRC_PAIRS[key]) {
    if (v[a] !== undefined && !/[\s)\]},.;:]/.test(v[a])) return false;
    const esc = v[a - 1] === '\\' && v[a - 2] !== '\\';
    srcReplace(ta, a, a, key + (esc ? '\\' : '') + SRC_PAIRS[key]);
    ta.setSelectionRange(a + 1, a + 1);
    return true;
  }
  if (')]}'.includes(key) && v[a] === key) { ta.setSelectionRange(a + 1, a + 1); return true; }
  return false;
}
function srcPairBackspace(ta) {
  const a = ta.selectionStart, v = ta.value;
  if (a !== ta.selectionEnd || !a) return false;
  if (SRC_PAIRS[v[a - 1]] && v[a] === SRC_PAIRS[v[a - 1]]) { srcReplace(ta, a - 1, a + 1, ''); return true; }
  if (v[a - 2] === '\\' && SRC_PAIRS[v[a - 1]] && v.slice(a, a + 2) === '\\' + SRC_PAIRS[v[a - 1]]) { srcReplace(ta, a - 2, a + 2, ''); return true; }
  return false;
}
async function srcClip(text) {
  killRecord(text); try { await navigator.clipboard.writeText(text); } catch (e) { /* clipboard refused */ } }
const SOURCE_ACTIONS = {
  gotoLine(line) {
    const ta = srcTa();
    const n = ta.value.split('\n').length;
    if (!line) {
      const cur = ta.value.slice(0, ta.selectionStart).split('\n').length;
      const ans = prompt(`Go to line (1–${n}):`, String(cur));
      line = parseInt(ans, 10);
      if (!line) return;
    }
    line = Math.max(1, Math.min(n, line));
    const at = ta.value.split('\n').slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(at, at);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const row = $('#srcgutter').children[line - 1];
    ta.scrollTop = Math.max(0, (row ? row.offsetTop : (line - 1) * lh) - ta.clientHeight / 3);
    ta.dispatchEvent(new Event('scroll'));
    ta.dispatchEvent(new Event('keyup'));
  },
  // % at the start of the lines of the region (or the line), or off again
  toggleComment() {
    const ta = srcTa();
    const a0 = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let b0 = ta.value.indexOf('\n', Math.max(ta.selectionStart, ta.selectionEnd - (ta.selectionEnd > ta.selectionStart ? 1 : 0)));
    if (b0 < 0) b0 = ta.value.length;
    const block = ta.value.slice(a0, b0).split('\n');
    const all = block.filter((l) => l.trim()).every((l) => /^\s*%/.test(l));
    const out = block.map((l) => !l.trim() ? l : all ? l.replace(/^(\s*)% ?/, '$1') : l.replace(/^(\s*)/, '$1% ')).join('\n');
    srcReplace(ta, a0, b0, out);
    ta.setSelectionRange(a0, a0 + out.length);
  },
  deleteLine() {
    const ta = srcTa(); const [a, b] = srcLineBounds(ta);
    srcReplace(ta, a, Math.min(ta.value.length, b), '');
  },
  duplicate() {
    const ta = srcTa();
    if (ta.selectionStart !== ta.selectionEnd) {
      const t = ta.value.slice(ta.selectionStart, ta.selectionEnd), e = ta.selectionEnd;
      srcReplace(ta, e, e, t); ta.setSelectionRange(e, e + t.length); return;
    }
    const [a, b] = srcLineBounds(ta); const col = ta.selectionStart - a;
    srcReplace(ta, b, b, '\n' + ta.value.slice(a, b));
    ta.setSelectionRange(b + 1 + col, b + 1 + col);
  },
  copy() {
    const ta = srcTa();
    if (ta.selectionStart !== ta.selectionEnd) { srcClip(ta.value.slice(ta.selectionStart, ta.selectionEnd)); toast('Copied'); return; }
    const [a, b] = srcLineBounds(ta); srcClip(ta.value.slice(a, b) + '\n'); toast('Line copied');
  },
  cut() {
    const ta = srcTa();
    if (ta.selectionStart !== ta.selectionEnd) { srcClip(ta.value.slice(ta.selectionStart, ta.selectionEnd)); srcReplace(ta, ta.selectionStart, ta.selectionEnd, ''); return; }
    const [a, b] = srcLineBounds(ta); srcClip(ta.value.slice(a, b) + '\n');
    srcReplace(ta, a, Math.min(ta.value.length, b + 1), '');
  },
  deleteBackward() {
    const ta = srcTa();
    if (ta.selectionStart !== ta.selectionEnd) srcReplace(ta, ta.selectionStart, ta.selectionEnd, '');
    else if (ta.selectionStart > 0) srcReplace(ta, ta.selectionStart - 1, ta.selectionStart, '');
  },
  deleteToSpace() {
    const ta = srcTa(); const v = ta.value; const o = ta.selectionStart;
    if (ta.selectionEnd !== o) { srcReplace(ta, o, ta.selectionEnd, ''); return; }
    let i = o;
    while (i > 0 && v[i - 1] !== '\n' && /\s/.test(v[i - 1])) i--;
    while (i > 0 && !/\s/.test(v[i - 1])) i--;
    if (i === o && i > 0) i--;          // at a line start: join with the line before
    srcReplace(ta, i, o, '');
  },
  // C-a: the first non-blank character of the line, then its very start
  lineStart(extend) {
    const ta = srcTa(); const [a] = srcLineBounds(ta, ta.selectionEnd, ta.selectionEnd);
    let code = a; while (/[ \t]/.test(ta.value[code] || '')) code++;
    const to = ta.selectionEnd === code ? a : code;
    ta.setSelectionRange(extend ? Math.min(ta.selectionStart, to) : to, extend ? Math.max(ta.selectionStart, to) : to, extend && to < ta.selectionStart ? 'backward' : 'none');
  },
  lineEnd(extend) {
    const ta = srcTa(); const [, b] = srcLineBounds(ta, ta.selectionEnd, ta.selectionEnd);
    let code = b; while (code > 0 && /[ \t]/.test(ta.value[code - 1])) code--;
    const to = ta.selectionEnd === code ? b : code;
    ta.setSelectionRange(extend ? ta.selectionStart : to, to);
  },
  indent() {
    const ta = srcTa();
    if (ta.selectionStart === ta.selectionEnd) { srcReplace(ta, ta.selectionStart, ta.selectionStart, '  '); return; }
    const [a, b] = srcLineBounds(ta); const t = ta.value.slice(a, b).replace(/^/gm, '  ');
    srcReplace(ta, a, b, t); ta.setSelectionRange(a, a + t.length);
  },
  unindent() {
    const ta = srcTa(); const [a, b] = srcLineBounds(ta); const t = ta.value.slice(a, b).replace(/^ {1,2}/gm, '');
    const one = ta.selectionStart === ta.selectionEnd, at = ta.selectionStart;
    srcReplace(ta, a, b, t);
    if (one) { const p = Math.max(a, at - (b - a - t.length)); ta.setSelectionRange(p, p); } else ta.setSelectionRange(a, a + t.length);
  },
  // RET: a new line indented as the one it leaves
  newline() {
    const ta = srcTa(); const [a] = srcLineBounds(ta, ta.selectionStart, ta.selectionStart);
    const ind = /^[ \t]*/.exec(ta.value.slice(a))[0];
    srcReplace(ta, ta.selectionStart, ta.selectionEnd, '\n' + ind);
  },
};

// ---- multiple cursors in the source view
//
// The cursors are offsets in the text of #srcta, as anchor and focus.  An
// edit runs at each cursor, last first, on a copy of the text (SMC.shadow,
// which srcTa() then returns, so that SOURCE_ACTIONS work unchanged), and
// the result goes into the text in one insertText: one step of the text's
// own undo.  The highlighted copy of the text (#srchl) gives the places to
// draw the other cursors.
const smcActive = () => !!SRC.on && SMC.cursors.length > 1;
const smcLo = (c) => Math.min(c.a, c.f), smcHi = (c) => Math.max(c.a, c.f);
const smcSorted = () => [...SMC.cursors].sort((x, y) => smcLo(x) - smcLo(y) || smcHi(x) - smcHi(y));
function smcShadow(value) {
  return { shadow: true, value, ops: [], selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', readOnly: false, scrollTop: 0, clientHeight: 0,
    focus() {}, dispatchEvent() {},
    setSelectionRange(a, b, d = 'none') { if (b < a) a = b; this.selectionStart = a; this.selectionEnd = b; this.selectionDirection = d; } };
}
function smcFromTa(ta) {
  const back = ta.selectionDirection === 'backward';
  return { a: back ? ta.selectionEnd : ta.selectionStart, f: back ? ta.selectionStart : ta.selectionEnd };
}
function smcToTa(ta, c) { ta.setSelectionRange(smcLo(c), smcHi(c), c.f < c.a ? 'backward' : 'forward'); }
function smcStart() {
  const ta = $('#srcta');
  if (!ta || ta.readOnly) { toast(ta && ta.readOnly ? 'Preview only: turn it off to edit here' : 'Open the source view first'); return false; }
  if (smcActive()) return true;
  const c = smcFromTa(ta);
  SMC.cursors = [c]; SMC.primary = c; SMC.word = false; SMC.dwimBlock = false; SMC.value = ta.value;
  return true;
}
function smcClear() {
  SMC.stamp = null;
  if (SMC.cursors.length > 1) mcBannerOff();
  SMC.cursors = []; SMC.primary = null; SMC.dwimBlock = false; SMC.value = null;
  cancelAnimationFrame(SMC.raf); SMC.raf = 0;
  const layer = document.getElementById('mc-layer');
  if (layer && !mcActive()) layer.textContent = '';
  if (window.CSS && CSS.highlights && !mcActive()) CSS.highlights.delete('mc');
}
function smcMerge() {
  const out = [];
  for (const c of smcSorted()) {
    const p = out[out.length - 1];
    if (p && (smcLo(c) < smcHi(p) || (smcLo(c) === smcHi(p) && (c.a === c.f || p.a === p.f)))) {
      const lo = Math.min(smcLo(p), smcLo(c)), hi = Math.max(smcHi(p), smcHi(c));
      const keep = c === SMC.primary ? c : p;
      if (keep.a <= keep.f) { keep.a = lo; keep.f = hi; } else { keep.a = hi; keep.f = lo; }
      out[out.length - 1] = keep;
      continue;
    }
    out.push(c);
  }
  SMC.cursors = out;
  if (!out.includes(SMC.primary)) SMC.primary = out[out.length - 1] || null;
}
// the real selection on the primary cursor, scrolled to; one cursor left ends it
function smcShow() {
  smcMerge();
  const ta = $('#srcta');
  const p = SMC.primary;
  if (SMC.cursors.length < 2) { smcClear(); if (p) { ta.focus(); smcToTa(ta, p); } return; }
  ta.focus();
  smcToTa(ta, p);
  SMC.value = ta.value;
  mcSteady();
  const line = ta.value.slice(0, p.f).split('\n').length, y = srcLineTop(line);
  if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - 30) { ta.scrollTop = Math.max(0, y - ta.clientHeight / 3); ta.dispatchEvent(new Event('scroll')); }
  ta.dispatchEvent(new Event('keyup'));
  if (!SMC.raf) SMC.raf = requestAnimationFrame(smcLoop);
}
// Esc, C-g: back to the primary cursor alone
smcShow.one = () => {
  const p = SMC.primary;
  smcClear();
  if (p) smcToTa($('#srcta'), p);
};
// an edit at every cursor (fn gets the copy of the text, with the cursor
// as its selection), or, with move, a change of the cursors only
function smcEach(fn) {
  const ta = $('#srcta');
  if (ta.readOnly) { toast('Preview only: turn it off to edit here'); return; }
  const before = ta.value;
  const sh = smcShadow(before);
  const list = smcSorted();
  const was = smcSave();
  SMC.dwimBlock = false;
  SMC.shadow = sh;
  try {
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      const len0 = sh.value.length;
      smcToTa(sh, c);
      fn(sh, c, i);
      Object.assign(c, smcFromTa(sh));
      const d = sh.value.length - len0;
      for (let j = i + 1; j < list.length; j++) { list[j].a += d; list[j].f += d; }
    }
  } finally { SMC.shadow = null; }
  if (sh.ops.length) {
    // the same small edits, in the same order, in the text itself: each is a
    // step of the text's own undo (a single replacement of the whole span
    // would be one step, but Chrome takes seconds to insert text with many
    // lines); the view is drawn again once, at the end
    SRC.quiet = true;
    try { for (const [a, b, t] of sh.ops) srcReplace(ta, a, b, t); } finally { SRC.quiet = false; }
    if (ta.value !== sh.value) { ta.setRangeText(sh.value, 0, ta.value.length); SMC.undo = []; }
    else { SMC.undo.push({ n: sh.ops.length, at: ta.value, cursors: was, after: null }); SMC.redo = []; }
    ta.dispatchEvent(new Event('input'));
  }
  smcShow();
  if (sh.ops.length && SMC.undo.length && SMC.undo[SMC.undo.length - 1].at === ta.value) SMC.undo[SMC.undo.length - 1].after = smcSave();
}
// the cursors as they are (for undo and redo), and back
function smcSave() { return { list: SMC.cursors.map((c) => ({ a: c.a, f: c.f })), primary: SMC.cursors.indexOf(SMC.primary) }; }
function smcLoad(st) {
  if (!st || st.list.length < 2) return false;
  SMC.cursors = st.list.map((c) => ({ ...c }));
  SMC.primary = SMC.cursors[st.primary] || SMC.cursors[SMC.cursors.length - 1];
  return true;
}
function smcType(ch) {
  smcEach((ta) => {
    const a = ta.selectionStart, b = ta.selectionEnd;
    if (srcPair(ta, ch)) return;
    const pair = { '{': '}', '(': ')', '[': ']', $: '$' }[ch];
    if (pair && a !== b) {
      const inner = ta.value.slice(a, b);
      srcReplace(ta, a, b, ch + inner + pair);
      ta.setSelectionRange(a + 1, a + 1 + inner.length);
      return;
    }
    srcReplace(ta, a, b, ch);
  });
}
const SMC_WORD = /[\p{L}\p{N}_@]/u;
function smcDelete(back, word) {
  smcEach((ta) => {
    const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    if (a !== b) { srcReplace(ta, a, b, ''); return; }
    if (back && !word && srcPairBackspace(ta)) return;
    if (back) {
      let i = a - 1;
      if (word) { i = a; while (i > 0 && !SMC_WORD.test(v[i - 1]) && v[i - 1] !== '\n') i--; while (i > 0 && SMC_WORD.test(v[i - 1])) i--; if (i === a) i = a - 1; }
      if (i >= 0) srcReplace(ta, i, a, '');
    } else {
      let j = a + 1;
      if (word) { j = a; while (j < v.length && !SMC_WORD.test(v[j]) && v[j] !== '\n') j++; while (j < v.length && SMC_WORD.test(v[j])) j++; if (j === a) j = a + 1; }
      if (j <= v.length) srcReplace(ta, a, j, '');
    }
  });
}
// arrows, Home and End at every cursor (Up and Down keep the column the
// cursor had, as Emacs does)
function smcMove(key, extend, ctrl) {
  const v = $('#srcta').value;
  const lineStart = (o) => v.lastIndexOf('\n', o - 1) + 1;
  const lineEnd = (o) => { const e = v.indexOf('\n', o); return e < 0 ? v.length : e; };
  for (const c of SMC.cursors) {
    let f = c.f;
    if (!/Up|Down/.test(key)) c.goal = undefined;
    if (!extend && c.a !== c.f && /Left|Right/.test(key) && !ctrl) f = /Left/.test(key) ? smcLo(c) : smcHi(c);
    else if (key === 'ArrowLeft') {
      if (ctrl) { f = c.f; while (f > 0 && !SMC_WORD.test(v[f - 1])) f--; while (f > 0 && SMC_WORD.test(v[f - 1])) f--; } else f = Math.max(0, c.f - 1);
    } else if (key === 'ArrowRight') {
      if (ctrl) { f = c.f; while (f < v.length && !SMC_WORD.test(v[f])) f++; while (f < v.length && SMC_WORD.test(v[f])) f++; } else f = Math.min(v.length, c.f + 1);
    } else if (key === 'Home') f = ctrl ? 0 : lineStart(c.f);
    else if (key === 'End') f = ctrl ? v.length : lineEnd(c.f);
    else {
      const s = lineStart(c.f);
      if (c.goal === undefined) c.goal = c.f - s;
      if (key === 'ArrowUp') { if (s === 0) f = 0; else { const ps = lineStart(s - 1); f = Math.min(ps + c.goal, s - 1); } }
      else { const e = lineEnd(c.f); if (e === v.length) f = v.length; else { const ns = e + 1; f = Math.min(ns + c.goal, lineEnd(ns)); } }
    }
    c.f = f;
    if (!extend) c.a = f;
  }
  smcShow();
}
// the text at each cursor: the selection, or the line
function smcPieces() {
  const v = $('#srcta').value;
  return smcSorted().map((c) => {
    if (c.a !== c.f) return { c, text: v.slice(smcLo(c), smcHi(c)), a: smcLo(c), b: smcHi(c) };
    const [a, b] = srcLineBounds({ value: v }, c.f, c.f);
    return { c, text: v.slice(a, b), a, b: Math.min(v.length, b + 1) };
  });
}
function smcCopy(cut, clipboardData) {
  const ps = smcPieces();
  const text = ps.map((p) => p.text).join('\n');
  SMC.kill = ps.map((p) => p.text);
  killRecord(text);
  if (clipboardData) clipboardData.setData('text/plain', text); else srcClip(text);
  if (!cut) { toast(`Copied the text at ${ps.length} cursors`); return; }
  const at = new Map(ps.map((p) => [p.c, p]));
  smcEach((ta, c) => { const p = at.get(c); srcReplace(ta, p.a, p.b, ''); });
}
function smcPaste(text) {
  const n = SMC.cursors.length;
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const pieces = SMC.kill && SMC.kill.length === n && SMC.kill.join('\n') === text ? SMC.kill
    : lines.length === n ? lines : null;
  smcEach((ta, c, i) => srcReplace(ta, ta.selectionStart, ta.selectionEnd, pieces ? pieces[i] : text));
}
// the word at the primary cursor (selected by the first press), or its selection
function smcNeedle() {
  const v = $('#srcta').value, p = SMC.primary;
  if (p.a === p.f) {
    let i = p.f, j = p.f;
    while (i > 0 && SMC_WORD.test(v[i - 1])) i--;
    while (j < v.length && SMC_WORD.test(v[j])) j++;
    if (i === j) { toast('Put the cursor on a word, or select some text'); return null; }
    p.a = i; p.f = j; SMC.word = true;
  }
  return v.slice(smcLo(p), smcHi(p));
}
function smcOccurrences(needle, from = 0, to = Infinity) {
  const v = $('#srcta').value, out = [];
  for (let i = v.indexOf(needle, from); i >= 0 && i + needle.length <= to; i = v.indexOf(needle, i + 1)) {
    if (SMC.word && (SMC_WORD.test(v[i - 1] || '') || SMC_WORD.test(v[i + needle.length] || ''))) continue;
    out.push({ a: i, f: i + needle.length });
  }
  return out;
}
const smcTaken = (o) => SMC.cursors.some((c) => smcLo(c) < o.f && o.a < smcHi(c));
function smcNext(dir) {
  const fresh = !smcActive();
  if (fresh && !smcStart()) return;
  SMC.dwimBlock = false;
  const needle = smcNeedle();
  if (needle === null) { if (fresh) smcClear(); return; }
  const all = smcOccurrences(needle), sorted = smcSorted();
  const ref = dir > 0 ? smcHi(sorted[sorted.length - 1]) : smcLo(sorted[0]);
  const order = dir > 0 ? [...all.filter((o) => o.a >= ref), ...all.filter((o) => o.a < ref)]
    : [...all.filter((o) => o.f <= ref).reverse(), ...all.filter((o) => o.f > ref).reverse()];
  const next = order.find((o) => !smcTaken(o));
  if (!next) { toast(`No other “${needle}” in this file`); if (fresh) { const p = SMC.primary; smcClear(); smcToTa($('#srcta'), p); } else smcShow(); return; }
  SMC.cursors.push(next);
  SMC.primary = next;
  smcShow();
  mcCount(`${SMC.cursors.length} cursors`);
}
function smcUnmark(dir) {
  if (!smcActive()) { toast('There is one cursor'); return; }
  const sorted = smcSorted();
  const gone = dir > 0 ? sorted[sorted.length - 1] : sorted[0];
  SMC.cursors = SMC.cursors.filter((c) => c !== gone);
  if (SMC.primary === gone) { const rest = smcSorted(); SMC.primary = dir > 0 ? rest[rest.length - 1] : rest[0]; }
  smcShow();
}
// every occurrence in the file, or in the paragraph (the lines between blank ones)
function smcAll(scope) {
  const fresh = !smcActive();
  if (fresh && !smcStart()) return;
  const needle = smcNeedle();
  if (needle === null) { if (fresh) smcClear(); return; }
  const v = $('#srcta').value, p = SMC.primary;
  let from = 0, to = v.length;
  if (scope === 'block') {
    const blank = /\n[ \t]*\n/g;
    let m;
    while ((m = blank.exec(v))) { if (m.index + m[0].length <= smcLo(p)) from = m.index + m[0].length; else if (m.index >= smcHi(p)) { to = m.index; break; } }
  }
  const found = smcOccurrences(needle, from, to);
  SMC.cursors = found.map((o) => (o.a === smcLo(p) ? p : o));
  if (!SMC.cursors.includes(p)) SMC.cursors.push(p);
  const n = SMC.cursors.length;
  smcShow();
  mcCount(n > 1 ? `${n} cursors` : 'No other occurrence');
}
function smcDwim() {
  if (smcActive() && SMC.dwimBlock) { smcAll('paper'); return; }
  smcAll('block');
  SMC.dwimBlock = smcActive();
}
// a cursor on each line of the selection, at the column of its end (a
// line too short gets one at its end), as Emacs's edit-lines
function smcLines() {
  const ta = $('#srcta');
  if (ta.readOnly) { toast('Preview only: turn it off to edit here'); return; }
  const c = smcActive() ? SMC.primary : smcFromTa(ta);
  if (c.a === c.f) { banner('Select the lines first: a cursor goes on each line of the selection.'); return; }
  const v = ta.value;
  const lo = smcLo(c);
  let hi = smcHi(c);
  if (hi > lo && v[hi - 1] === '\n') hi--;          // a selection to the start of a line leaves that line out
  const col = c.f - (v.lastIndexOf('\n', c.f - 1) + 1);
  const cs = [];
  for (let s = v.lastIndexOf('\n', lo - 1) + 1; s <= hi; ) {
    let e = v.indexOf('\n', s);
    if (e < 0) e = v.length;
    const o = Math.min(s + col, e);
    cs.push({ a: o, f: o });
    s = e + 1;
    if (e === v.length) break;
  }
  if (cs.length < 2) { toast('The selection is one line'); return; }
  SMC.cursors = cs; SMC.primary = cs[cs.length - 1]; SMC.word = false; SMC.dwimBlock = false;
  smcShow();
  mcCount(`${cs.length} cursors`);
}
function smcNumbers() {
  if (!smcActive()) { toast('Insert numbers needs more than one cursor'); return; }
  smcEach((ta, c, i) => srcReplace(ta, ta.selectionStart, ta.selectionEnd, String(i)));
}

// ---- drawing, from the rows of #srchl (one per line of the text)
// the start of every line, for smcLine
function smcStarts(v) {
  const out = [0];
  for (let i = v.indexOf('\n'); i >= 0; i = v.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}
function smcLine(starts, off) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo;
}
function smcPoint(rows, starts, off) {
  const line = smcLine(starts, off);
  const row = rows[line];
  if (!row) return null;
  let col = off - starts[line];
  const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let n, last = null;
  while ((n = w.nextNode())) {
    if (n.data === '​') return [n, 0];
    if (col <= n.data.length) return [n, col];
    col -= n.data.length;
    last = n;
  }
  return last ? [last, last.data.length] : [row, 0];
}
function smcDraw() {
  const ta = $('#srcta');
  if (SMC.compose) return;   // the text changes under a composition; its end catches up
  if (!smcActive() || !ta || ta.value !== SMC.value || mcActive()) { smcClear(); return; }
  const rows = $('#srchl').children, v = ta.value;
  if (SMC.startsFor !== v) { SMC.starts = smcStarts(v); SMC.startsFor = v; }
  const starts = SMC.starts;
  // only the lines in the window are looked at
  const first = Math.max(0, srcTopLine() - 2), last = first + Math.ceil(ta.clientHeight / 12) + 4;
  let layer = document.getElementById('mc-layer');
  if (!layer) { layer = el('div'); layer.id = 'mc-layer'; document.body.append(layer); }
  const box = $('#srcwrap').getBoundingClientRect();
  if (!rows.length) { smcDrawPlain(ta, starts, first, last, layer, box); return; }
  const sel = [];
  let i = 0;
  for (const c of SMC.cursors) {
    if (c === SMC.primary) continue;
    const lf = smcLine(starts, c.f), ll = smcLine(starts, smcLo(c)), lh = smcLine(starts, smcHi(c));
    if (lh < first || ll > last) continue;
    const f = lf >= first && lf <= last ? smcPoint(rows, starts, c.f) : null;
    if (c.a !== c.f) {
      const a = smcPoint(rows, starts, smcLo(c)), b = smcPoint(rows, starts, smcHi(c));
      if (a && b) { const r = document.createRange(); r.setStart(...a); r.setEnd(...b); sel.push(r); }
      continue;
    }
    if (!f) continue;
    const r = document.createRange();
    r.setStart(...f);
    const cb = mcCaretBox(r);
    const bar = layer.children[i] || layer.appendChild(el('div', 'mc-caret'));
    i++;
    const shown = cb && cb.top + cb.h > box.top && cb.top < box.bottom && cb.x >= box.left - 1 && cb.x <= box.right;
    bar.style.display = shown ? '' : 'none';
    if (shown) { bar.style.left = cb.x + 'px'; bar.style.top = cb.top + 'px'; bar.style.height = cb.h + 'px'; }
  }
  while (layer.children.length > i) layer.lastChild.remove();
  if (window.CSS && CSS.highlights) CSS.highlights.set('mc', new Highlight(...sel));
}
// A file too large for colours (#srchl is empty, the text draws itself): with
// long lines not wrapped, a place is its line times the line height and its
// column times the width of a character (the font is monospaced); wrapped,
// the cursors work but are not drawn, which a toast says once.
function smcDrawPlain(ta, starts, first, last, layer, box) {
  if (window.CSS && CSS.highlights) CSS.highlights.delete('mc');
  if (SRC.wrap) {
    layer.textContent = '';
    if (SMC.saidPlain !== SRC.name) { SMC.saidPlain = SRC.name; toast('In a file this large the other cursors are drawn only with Wrap off; they work either way'); }
    return;
  }
  const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight) || 18;
  if (SMC.chFont !== cs.font) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = cs.font;
    SMC.ch = ctx.measureText('M'.repeat(100)).width / 100;
    SMC.chFont = cs.font;
  }
  const tab = parseInt(cs.tabSize, 10) || 4, tb = ta.getBoundingClientRect(), v = ta.value;
  let i = 0;
  for (const c of SMC.cursors) {
    if (c === SMC.primary || c.a !== c.f) continue;
    const line = smcLine(starts, c.f);
    if (line < first || line > last) continue;
    let col = 0;
    for (let k = starts[line]; k < c.f; k++) col = v[k] === '\t' ? (Math.floor(col / tab) + 1) * tab : col + 1;
    const x = tb.left + parseFloat(cs.paddingLeft) + col * SMC.ch - ta.scrollLeft;
    const top = tb.top + parseFloat(cs.paddingTop) + line * lh - ta.scrollTop;
    const bar = layer.children[i] || layer.appendChild(el('div', 'mc-caret'));
    i++;
    const shown = top + lh > box.top && top < box.bottom && x >= box.left - 1 && x <= box.right;
    bar.style.display = shown ? '' : 'none';
    if (shown) { bar.style.left = x + 'px'; bar.style.top = top + 'px'; bar.style.height = lh + 'px'; }
  }
  while (layer.children.length > i) layer.lastChild.remove();
}
function smcLoop() {
  SMC.raf = 0;
  if (!smcActive()) { smcClear(); return; }
  const ta = $('#srcta');
  const stamp = mcStamp(SMC.cursors, [SMC.cursors.indexOf(SMC.primary), ta.scrollTop, ta.scrollLeft, ta.clientWidth, ta.value.length, $('#srchl').childElementCount, SRC.wrap, $('#srchl').offsetHeight].join(','));
  if (stamp !== SMC.stamp || ta.value !== SMC.value || mcActive()) { SMC.stamp = stamp; smcDraw(); }
  if (smcActive()) SMC.raf = requestAnimationFrame(smcLoop);
}

// ---- keys and the mouse in the source text
const SMC_EACH = new Set(['src-linestart', 'src-lineend', 'src-selstart', 'src-selend', 'src-deleteline', 'src-duplicate', 'src-delback',
  'src-deltospace', 'src-indent', 'src-unindent', 'src-newline', 'src-comment']);
function smcGuard(id, label, fn) {
  return () => {
    if (!smcActive()) return fn();
    if (id === 'src-copy') return smcCopy(false);
    if (id === 'src-cut') return smcCopy(true);
    if (SMC_EACH.has(id)) return smcEach(() => fn());
    if (id === 'src-goto') { smcClear(); return fn(); }
    banner(`${label.replace(/^Source: /, '')} works with one cursor: Esc goes back to one.`);
  };
}
document.addEventListener('keydown', (e) => {
  if (RECORDING || PREFIX || e.isComposing || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key) || e.target.id !== 'srcta') return;
  const k = keyName(e);
  // Ctrl+Z after an edit at many cursors takes all of it back at once (the
  // text's own undo, as many steps as the edit made), and Ctrl+Shift+Z or
  // Ctrl+Y redoes it
  if ((k === 'C-z' || k === 'C-Z' || k === 'C-y') && !e.target.readOnly) {
    const redo = k !== 'C-z', from = redo ? SMC.redo : SMC.undo, to = redo ? SMC.undo : SMC.redo;
    const top = from[from.length - 1], ta = e.target;
    if (top && top.at === ta.value) {
      e.preventDefault(); e.stopImmediatePropagation();
      from.pop();
      smcClear();
      SRC.quiet = true;
      try { for (let i = 0; i < top.n; i++) document.execCommand(redo ? 'redo' : 'undo'); } finally { SRC.quiet = false; }
      to.push({ n: top.n, at: ta.value, cursors: top.cursors, after: top.after });
      ta.dispatchEvent(new Event('input'));
      // the cursors come back where they were before (or after) the edit
      if (smcLoad(redo ? top.after : top.cursors)) smcShow();
      return;
    }
  }
  // C-> and the other marking keys (the chords go through the prefix keys)
  const g = GLOBAL_KEYS[k];
  if (g && g.isMc) { e.preventDefault(); e.stopImmediatePropagation(); g(); return; }
  if (!smcActive() || SOURCE_KEYS[k] || GLOBAL_KEYS[k] || e.metaKey) return;
  if (e.target.readOnly) return;
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) { stop(); smcType(e.key); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.altKey) { stop(); smcDelete(e.key === 'Backspace', e.ctrlKey); return; }
  if (/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key) && !e.altKey) { stop(); smcMove(e.key, e.shiftKey, e.ctrlKey); }
}, true);
for (const type of ['copy', 'cut']) {
  addEventListener(type, (e) => {
    if (!smcActive() || e.target.id !== 'srcta') return;
    e.preventDefault(); e.stopImmediatePropagation();
    smcCopy(type === 'cut', e.clipboardData);
  }, true);
}
addEventListener('paste', (e) => {
  if (!smcActive() || e.target.id !== 'srcta' || e.target.readOnly) return;
  e.preventDefault(); e.stopImmediatePropagation();
  smcPaste(e.clipboardData.getData('text/plain').replace(PASTE_INVISIBLE_RE, ''));
}, true);
addEventListener('beforeinput', (e) => {
  if (!smcActive() || e.target.id !== 'srcta' || SMC.shadow || SRC.quiet || e.isComposing) return;
  if (e.inputType === 'insertReplacementText') { smcClear(); return; }
  if (e.inputType === 'insertText' && e.data) { e.preventDefault(); e.stopImmediatePropagation(); smcType(e.data); }
}, true);
// a dead key or an input method: its text goes to the other cursors at the end
addEventListener('compositionstart', (e) => {
  SMC.compose = smcActive() && e.target.id === 'srcta' ? { p: SMC.primary, len: e.target.value.length } : null;
}, true);
addEventListener('compositionend', (e) => {
  const g = SMC.compose, ta = e.target;
  SMC.compose = null;
  if (!g || SMC.cursors.length < 2 || g.p !== SMC.primary || !e.data) return;
  const p = g.p, d = ta.value.length - g.len;
  for (const c of SMC.cursors) if (c !== p && smcLo(c) >= smcHi(p)) { c.a += d; c.f += d; }
  Object.assign(p, smcFromTa(ta));
  SMC.value = ta.value;
  smcEach((sh, c) => { if (c !== p) srcReplace(sh, sh.selectionStart, sh.selectionEnd, e.data); });
}, true);
// C-S-click: the browser moves the caret there (extending the selection),
// which becomes a cursor of its own; any other click goes back to one cursor
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.id !== 'srcta') { if (smcActive() && e.button === 0 && !(e.target.closest && e.target.closest('#whichkey, #palette'))) smcClear(); return; }
  const ta = e.target;
  if (!(e.ctrlKey && e.shiftKey && !e.altKey)) { if (smcActive()) smcClear(); return; }
  if (ta.readOnly) return;
  if (!SMC.cursors.length) { const c = smcFromTa(ta); SMC.cursors = [c]; SMC.primary = c; SMC.value = ta.value; }
  addEventListener('mouseup', () => setTimeout(() => {
    const o = smcFromTa(ta).f;
    const there = SMC.cursors.find((c) => c.a === c.f && c.f === o);
    if (there && SMC.cursors.length > 1) { SMC.cursors = SMC.cursors.filter((c) => c !== there); if (SMC.primary === there) SMC.primary = SMC.cursors[SMC.cursors.length - 1]; }
    else if (!there) { const c = { a: o, f: o }; SMC.cursors.push(c); SMC.primary = c; }
    smcShow();
  }, 0), { once: true, capture: true });
}, true);

// ---- spelling keys, as flyspell: C-. corrects the misspelled word at or
// before the caret with the first suggestion (pressed again at once, the
// next one, and at the end the word as it was), C-, lists the suggestions at
// the word.  The words are those of the caret's block (never in a formula, a
// reference or another chip).  The Electron window's own spell checker
// answers when it has its dictionary; else hunspell on the server.  Words
// added go to the paper's dictionary, .paper-editor/words.txt.
const SPELL = { dict: null, cache: new Map(), cycle: null };
const SPELL_WORD = /\p{L}+(?:['’]\p{L}+)*/gu;
async function spellDict() {
  if (!SPELL.dict) {
    try { SPELL.dict = new Set(((await (await fetch('/api/spell/words')).json()).words) || []); } catch (e) { SPELL.dict = new Set(); }
  }
  return SPELL.dict;
}
function shellSpell() {
  const s = window.__shellSpell;
  try { return s && s.misspelled('recieve') ? s : null; } catch (e) { return null; }
}
// word -> its suggestions, for the misspelled ones
async function spellCheck(words) {
  const dict = await spellDict();
  const ask = [...new Set(words)].filter((w) => w.length > 1 && !dict.has(w) && !dict.has(w.toLowerCase()) && !SPELL.cache.has(w));
  const sh = shellSpell();
  if (sh) for (const w of ask) SPELL.cache.set(w, sh.misspelled(w) ? (sh.suggestions(w) || []) : null);
  else if (ask.length) {
    const r = await fetch('/api/spell', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
      body: JSON.stringify({ words: ask, lang: (DOC.config && DOC.config.spell_lang) || 'en-GB' }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'error ' + r.status);
    for (const w of ask) SPELL.cache.set(w, d.misspelled[w] || null);
  }
  const out = new Map();
  for (const w of words) if (!dict.has(w) && !dict.has(w.toLowerCase()) && SPELL.cache.get(w)) out.set(w, SPELL.cache.get(w));
  return out;
}
async function spellAdd(word) {
  (await spellDict()).add(word);
  SPELL.cache.delete(word);
  const sh = shellSpell();
  if (sh) sh.add(word);
  await fetch('/api/spell/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ word }) }).catch(() => {});
}
// the words of the caret's block up to the caret (the one it is in counts),
// nearest first, as offsets in the block (see mcOff)
function spellWordsBefore() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const ed = hostOf(s.focusNode);
  if (!mcUsable(ed)) return null;
  const caret = mcOff(ed, s.focusNode, s.focusOffset);
  const words = [];
  for (const m of mcText(ed).matchAll(SPELL_WORD)) if (m.index <= caret) words.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  return { ed, caret, words: words.reverse() };
}
async function spellFirstBad(here, before = Infinity) {
  const words = here.words.filter((w) => w.start < before).slice(0, 300);
  let bad;
  try { bad = await spellCheck(words.map((w) => w.word)); } catch (e) { banner('Spelling suggestions need hunspell, or the Electron window: ' + e.message); return undefined; }
  const w = words.find((x) => bad.has(x.word));
  return w ? { ...w, sugg: bad.get(w.word) } : null;
}
// replace start..end of the block with text, the caret kept where it was
// (moved with the text after it); returns the caret's new offset
function spellReplace(ed, start, end, text, caret) {
  const a = mcPoint(ed, start), b = mcPoint(ed, end);
  ed.focus({ preventScroll: true });
  getSelection().setBaseAndExtent(a[0], a[1], b[0], b[1]);
  SNAP_HOLD = true;
  try { document.execCommand('insertText', false, text); } finally { SNAP_HOLD = false; }
  clearTimeout(typingSnap); typingSnap = null; typingIn = null;   // what is typed next is a step of its own
  const c = caret >= end ? caret + text.length - (end - start) : Math.min(caret, start + text.length);
  const p = mcPoint(ed, c);
  getSelection().setBaseAndExtent(p[0], p[1], p[0], p[1]);
  markEditedSoon();
  return c;
}
async function spellFix() {
  const here = spellWordsBefore();
  if (!here) { toast('Put the cursor in the text first', 'error'); return; }
  const cy = SPELL.cycle;
  if (cy && cy.ed === here.ed && cy.caret === here.caret && Date.now() - cy.t < 10000 && mcText(cy.ed).slice(cy.start, cy.start + cy.current.length) === cy.current) {
    cy.idx = (cy.idx + 1) % (cy.sugg.length + 1);
    const next = cy.idx < cy.sugg.length ? cy.sugg[cy.idx] : cy.orig;
    cy.caret = spellReplace(cy.ed, cy.start, cy.start + cy.current.length, next, cy.caret);
    cy.current = next; cy.t = Date.now();
    toast(cy.idx < cy.sugg.length ? `${cy.orig} → ${next}` : `${cy.orig}, as it was`);
    return;
  }
  SPELL.cycle = null;
  const bad = await spellFirstBad(here);
  if (bad === undefined) return;
  if (!bad) { toast('No misspelled word before the cursor in this paragraph'); return; }
  if (!bad.sugg.length) { toast(`No suggestion for “${bad.word}”`); return; }
  snapshot();
  const caret = spellReplace(here.ed, bad.start, bad.end, bad.sugg[0], here.caret);
  SPELL.cycle = { ed: here.ed, start: bad.start, orig: bad.word, current: bad.sugg[0], sugg: bad.sugg, idx: 0, caret, t: Date.now() };
  toast(`${bad.word} → ${bad.sugg[0]}`);
}
async function spellList(before) {
  const here = spellWordsBefore();
  if (!here) { toast('Put the cursor in the text first', 'error'); return; }
  SPELL.cycle = null;
  const bad = await spellFirstBad(here, before);
  if (bad === undefined) return;
  if (!bad) { toast(before !== undefined ? 'No other misspelled word before it in this paragraph' : 'No misspelled word before the cursor in this paragraph'); return; }
  const back = () => { const p = mcPoint(here.ed, here.caret); here.ed.focus({ preventScroll: true }); getSelection().setBaseAndExtent(p[0], p[1], p[0], p[1]); };
  openPalette({
    title: `Spelling: “${bad.word}”`, placeholder: 'Filter the suggestions (1 to 9 pick one)', delay: 0,
    empty: 'No suggestion',
    search: async (q) => [...bad.sugg.filter((x) => x.toLowerCase().includes(q.toLowerCase())).map((x) => ({ s: x })), { add: true }],
    view: (it) => it.add ? { main: `Add “${escHtml(bad.word)}” to the paper's dictionary`, sub: '.paper-editor/words.txt' }
      : { main: escHtml(it.s), badges: PAL.items.indexOf(it) < 9 ? [{ text: String(PAL.items.indexOf(it) + 1) }] : [] },
    pick: async (it) => {
      closePalette();
      back();
      if (it.add) { await spellAdd(bad.word); toast(`“${bad.word}” is in the paper's dictionary`, 'ok'); return; }
      snapshot();
      spellReplace(here.ed, bad.start, bad.end, it.s, here.caret);
      toast(`${bad.word} → ${it.s}`);
    },
    onKey: (e) => {
      if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const i = +e.key - 1;
        if (PAL.items[i] && !PAL.items[i].add) { PAL.active = i; choose(); }
        return true;
      }
      if ((USER_KEYS.spelllist || ['C-,']).includes(keyName(e))) { closePalette(); back(); spellList(bad.start); return true; }
      return false;
    },
  });
  // the list at the word, below it (or above, near the bottom of the window)
  const pal = $('#palette');
  if (pal.hidden) return;
  const r = mcRange({ ed: here.ed, a: bad.start, f: bad.end }).getBoundingClientRect();
  const h = pal.offsetHeight || 300;
  pal.style.transform = 'none';
  pal.style.top = (r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
  pal.style.left = Math.max(8, Math.min(r.left, innerWidth - pal.offsetWidth - 8)) + 'px';
}

// ---- the kill ring: the last 30 copies and cuts, of the paper and of the
// source view, newest first; C-S-v (consult-yank-pop) picks one in the
// palette and pastes it as a paste would (formulas and all, at every cursor).
const KILLS = [];
function killRecord(plain, latex = '') {
  if (!plain || !plain.trim()) return;
  const i = KILLS.findIndex((k) => k.plain === plain && k.latex === latex);
  if (i >= 0) KILLS.splice(i, 1);
  KILLS.unshift({ plain, latex, at: Date.now() });
  if (KILLS.length > 30) KILLS.length = 30;
}
// after the handlers of the page have put their text on the clipboard
for (const type of ['copy', 'cut']) {
  document.addEventListener(type, (e) => {
    const t = e.target;
    if (t.tagName === 'INPUT') return;
    if (t.tagName === 'TEXTAREA') { if (!e.defaultPrevented) killRecord(t.value.slice(t.selectionStart, t.selectionEnd)); return; }
    if (e.defaultPrevented && e.clipboardData) killRecord(e.clipboardData.getData('text/plain'), e.clipboardData.getData(LATEX_MIME));
    else if (!e.defaultPrevented) killRecord(getSelection().toString());
  });
}
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
function killRingPalette() {
  if (!KILLS.length) { toast('Nothing copied or cut yet'); return; }
  const ta = $('#srcta');
  const inSrc = SRC.on && document.activeElement === ta;
  if (inSrc && ta.readOnly) { toast('Preview only: turn it off to edit here'); return; }
  const at = inSrc ? [ta.selectionStart, ta.selectionEnd] : null;
  MC.hold = mcActive();    // the cursors stay while the palette is open
  openPalette({
    title: 'Paste one of the last copies and cuts', placeholder: 'Words of the text', anywhere: inSrc, delay: 0,
    empty: 'No copy or cut has these words.',
    search: async (q) => { const ws = q.toLowerCase().split(/\s+/).filter(Boolean); return KILLS.filter((k) => ws.every((w) => k.plain.toLowerCase().includes(w))); },
    view: (k) => ({ main: escHtml(k.plain.length > 160 ? k.plain.slice(0, 157) + '…' : k.plain).replace(/\n/g, ' <span class="sub">⏎</span> '),
      sub: ago(k.at) + (k.latex ? ' · with its LaTeX' : '') }),
    pick: (k) => {
      const saved = PAL.savedRange;
      closePalette();
      killRecord(k.plain, k.latex);
      if (inSrc) {
        ta.focus();
        ta.setSelectionRange(...at);
        if (smcActive()) smcPaste(k.plain); else srcReplace(ta, at[0], at[1], k.plain);
        return;
      }
      if (!saved) return;
      const host = editableAt(saved);
      if (host) host.focus();
      const s = getSelection(); s.removeAllRanges(); s.addRange(saved);
      if (mcActive()) mcShowPrimary();
      const dt = new DataTransfer();
      dt.setData('text/plain', k.plain);
      if (k.latex) dt.setData(LATEX_MIME, k.latex);
      (host || document.activeElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
  });  if ($('#palette').hidden) MC.hold = false;
}

// ---- completion in the source view (as corfu): after \ and a letter the
// macros of the preamble, the commands the paper uses and common ones; after
// \begin{ the environments (the \end comes with the choice); in \cref{...}
// and the like the labels; in \cite{...} the keys of the .bib files.  Up and
// Down choose, Enter or Tab take one, Escape (or any other key that leaves
// the word) closes the list.
const COMP = { open: false, items: [], active: 0, from: 0, kind: '', seq: 0, cache: null };
const COMMON_MACROS = ['section', 'subsection', 'subsubsection', 'paragraph', 'label', 'cref', 'Cref', 'ref', 'eqref', 'cite', 'citep', 'citet',
  'emph', 'textbf', 'textit', 'texttt', 'textsc', 'footnote', 'item', 'begin', 'end', 'includegraphics', 'caption', 'centering',
  'mathsf', 'mathcal', 'mathbb', 'mathbf', 'mathrm', 'frac', 'sum', 'prod', 'left', 'right', 'leq', 'geq', 'neq', 'cdot', 'ldots',
  'cdots', 'gets', 'leftarrow', 'rightarrow', 'Rightarrow', 'Leftrightarrow', 'mapsto', 'in', 'notin', 'subseteq', 'cup', 'cap',
  'land', 'lor', 'neg', 'forall', 'exists', 'top', 'bot', 'oplus', 'otimes', 'sample', 'text', 'url', 'href', 'input', 'newcommand',
  'renewcommand', 'usepackage', 'noindent', 'medskip', 'smallskip', 'bigskip', 'vspace', 'hspace', 'quad', 'qquad'];
const COMMON_ENVS = ['itemize', 'enumerate', 'description', 'figure', 'table', 'tabular', 'equation', 'equation*', 'align', 'align*',
  'gather', 'multline', 'theorem', 'lemma', 'definition', 'corollary', 'proposition', 'proof', 'remark', 'example', 'abstract',
  'center', 'quote', 'minipage', 'lstlisting', 'verbatim', 'tikzpicture', 'array', 'cases', 'pmatrix'];
// what is being typed at the caret, if it is something to complete
function compContext(ta) {
  const a = ta.selectionStart;
  if (a !== ta.selectionEnd) return null;
  const v = ta.value, line = v.slice(v.lastIndexOf('\n', a - 1) + 1, a);
  let m;
  if ((m = /\\begin\{([A-Za-z*]*)$/.exec(line))) return { kind: 'env', from: a - m[1].length, q: m[1] };
  if ((m = /\\(?:[cC]ref|[cC]pageref|[vV]ref|ref|eqref|autoref|pageref|nameref|labelcref)\{(?:[^{}]*,)?\s*([^{},\s]*)$/.exec(line))) return { kind: 'label', from: a - m[1].length, q: m[1] };
  if ((m = /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\])*\{(?:[^{}]*,)?\s*([^{},\s]*)$/.exec(line))) return { kind: 'cite', from: a - m[1].length, q: m[1] };
  if ((m = /(\\+)([A-Za-z@]+)$/.exec(line)) && m[1].length % 2 === 1) return { kind: 'macro', from: a - m[2].length, q: m[2] };
  return null;
}
// the macros and environments of the paper, counted (read again when the files change)
function compNames() {
  const stamp = Object.values(FILES).reduce((n, f) => n + (f.text || '').length, 0) + ':' + Object.keys(FILES).length;
  if (COMP.cache && COMP.cache.stamp === stamp) return COMP.cache;
  const macros = new Map(), envs = new Map();
  const bump = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);
  for (const f of Object.values(FILES)) {
    for (const m of (f.text || '').matchAll(/\\([A-Za-z@]+)/g)) bump(macros, m[1]);
    for (const m of (f.text || '').matchAll(/\\begin\{([A-Za-z*]+)\}/g)) bump(envs, m[1]);
  }
  for (const k of Object.keys(DOC.macros || {})) bump(macros, k.replace(/^\\/, ''), 5);
  for (const k of COMMON_MACROS) bump(macros, k, 0.5);
  // the paper's own first, then its theorem kinds, then common ones
  for (const k of Object.keys(DOC.theorems || {})) bump(envs, k, 0.6);
  for (const k of COMMON_ENVS) bump(envs, k, 0.5);
  envs.delete('document');
  macros.delete('begin'); macros.delete('end');
  for (const k of ['begin', 'end']) macros.set(k, 0.4);
  COMP.cache = { stamp, macros, envs };
  return COMP.cache;
}
// names matching q: those that start with it first, the most used first
function compRank(map, q) {
  const ql = q.toLowerCase();
  return [...map.entries()].filter(([k]) => k.toLowerCase().includes(ql) && k !== q)
    .sort((x, y) => (y[0].toLowerCase().startsWith(ql) - x[0].toLowerCase().startsWith(ql)) || (y[1] - x[1]) || x[0].localeCompare(y[0]))
    .slice(0, 12).map(([k]) => ({ name: k, sub: '' }));
}
async function compItems(c) {
  if (c.kind === 'macro') {
    const items = compRank(compNames().macros, c.q);
    for (const it of items) { const d = (DOC.macros || {})['\\' + it.name]; if (d) it.sub = d.slice(0, 40); }
    return items;
  }
  if (c.kind === 'env') return compRank(compNames().envs, c.q);
  if (c.kind === 'label') {
    const ql = c.q.toLowerCase();
    return collectLabels().filter((l) => l.key.toLowerCase().includes(ql) && l.key !== c.q)
      .sort((x, y) => y.key.toLowerCase().startsWith(ql) - x.key.toLowerCase().startsWith(ql)).slice(0, 12)
      .map((l) => ({ name: l.key, sub: `${l.name} ${l.num}${l.text ? ' · ' + l.text.slice(0, 50) : ''}` }));
  }
  // cite: the .bib files (what is cited already, before anything is typed)
  if (!c.q) return Object.keys(DOC.bib || {}).slice(0, 12).map((k) => ({ name: k, sub: cleanTex(DOC.bib[k]).slice(0, 60) }));
  const r = await fetch('/api/bib?q=' + encodeURIComponent(c.q)).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => []) : [];
  return d.filter((e) => e.key !== c.q).slice(0, 12).map((e) => ({ name: e.key, sub: cleanTex(`${e.title || ''} ${e.year || ''}`).slice(0, 60) }));
}
function compBox() {
  let b = document.getElementById('comp');
  if (!b) { b = el('div'); b.id = 'comp'; b.setAttribute('role', 'listbox'); document.body.append(b); }
  return b;
}
function compClose() {
  COMP.open = false; COMP.items = []; COMP.seq++;
  const b = document.getElementById('comp');
  if (b) b.hidden = true;
}
// where the caret of the source text is drawn
function srcCaretBox(off) {
  const ta = $('#srcta'), v = ta.value, rows = $('#srchl').children;
  if (rows.length) {
    const p = smcPoint(rows, smcStarts(v.slice(0, off + 1)), off);
    if (p) { const r = document.createRange(); r.setStart(...p); return mcCaretBox(r); }
  }
  const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight) || 18, tb = ta.getBoundingClientRect();
  const line = v.slice(0, off).split('\n').length - 1, col = off - (v.lastIndexOf('\n', off - 1) + 1);
  return { x: tb.left + parseFloat(cs.paddingLeft) + col * 7.8 - ta.scrollLeft, top: tb.top + parseFloat(cs.paddingTop) + line * lh - ta.scrollTop, h: lh };
}
function compDraw() {
  const b = compBox();
  b.textContent = '';
  COMP.items.forEach((it, i) => {
    const row = el('div', 'comp-item' + (i === COMP.active ? ' active' : ''));
    row.setAttribute('role', 'option');
    row.append(el('span', 'comp-name', (COMP.kind === 'macro' ? '\\' : '') + it.name), el('span', 'comp-sub', it.sub || ''));
    row.onmousedown = (e) => { e.preventDefault(); COMP.active = i; compAccept(); };
    b.append(row);
  });
  const box = srcCaretBox(COMP.from);
  b.hidden = false;
  const h = b.offsetHeight;
  b.style.left = Math.max(4, Math.min(box.x - 4, innerWidth - b.offsetWidth - 4)) + 'px';
  b.style.top = (box.top + box.h + 2 + h < innerHeight ? box.top + box.h + 2 : Math.max(4, box.top - h - 2)) + 'px';
}
async function compUpdate(opening) {
  // (after the code that typed: a bracket pair puts the caret between its brackets after inserting them)
  await null;
  const ta = $('#srcta');
  if (!ta || !SRC.on || ta.readOnly || smcActive() || document.activeElement !== ta) { compClose(); return; }
  const c = compContext(ta);
  if (!c || (!COMP.open && !opening) || (c.kind === 'macro' && !c.q)) { compClose(); return; }
  const seq = ++COMP.seq;
  const items = await compItems(c);
  if (seq !== COMP.seq) return;
  if (!items.length) { compClose(); return; }
  const same = COMP.open && COMP.kind === c.kind && COMP.from === c.from && COMP.items[COMP.active];
  const keep = same ? items.findIndex((it) => it.name === COMP.items[COMP.active].name) : -1;
  Object.assign(COMP, { open: true, items, kind: c.kind, from: c.from, active: Math.max(0, keep) });
  compDraw();
}
function compAccept() {
  const it = COMP.items[COMP.active], ta = $('#srcta');
  if (!it) { compClose(); return; }
  const a = ta.selectionStart, v = ta.value;
  if (COMP.kind === 'env') {
    // \begin{name} … \end{name}, the caret on the line between them
    const close = v[a] === '}' ? 1 : 0;
    const ind = /^[ \t]*/.exec(v.slice(v.lastIndexOf('\n', a - 1) + 1))[0];
    srcReplace(ta, COMP.from, a + close, `${it.name}}\n${ind}\n${ind}\\end{${it.name}}`);
    const at = COMP.from + it.name.length + 2 + ind.length;
    ta.setSelectionRange(at, at);
  } else srcReplace(ta, COMP.from, a, it.name);
  compClose();
}
document.addEventListener('input', (e) => {
  if (e.target.id !== 'srcta' || SRC.quiet || SMC.shadow) return;
  compUpdate(e.inputType === 'insertText');
}, true);
addEventListener('keydown', (e) => {
  if (!COMP.open || e.target.id !== 'srcta') return;
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  const n = COMP.items.length;
  if (e.key === 'ArrowDown' && !e.ctrlKey && !e.altKey) { stop(); COMP.active = (COMP.active + 1) % n; compDraw(); }
  else if (e.key === 'ArrowUp' && !e.ctrlKey && !e.altKey) { stop(); COMP.active = (COMP.active + n - 1) % n; compDraw(); }
  else if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.altKey && !e.shiftKey) { stop(); compAccept(); }
  else if (e.key === 'Escape') { stop(); compClose(); }
  else if (/^(ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(e.key) || e.ctrlKey || e.altKey) compClose();
}, true);
document.addEventListener('mousedown', (e) => { if (COMP.open && !(e.target.closest && e.target.closest('#comp'))) compClose(); }, true);
document.addEventListener('focusout', (e) => { if (COMP.open && e.target.id === 'srcta') setTimeout(() => { if (document.activeElement && document.activeElement.id !== 'srcta') compClose(); }, 0); }, true);
// (typing scrolls the text now and then: the list follows the caret)
document.addEventListener('scroll', () => { if (COMP.open) requestAnimationFrame(() => { if (COMP.open) compDraw(); }); }, true);

// ---- latexindent: a file through latexindent (on the server), as with
// Emacs's C-c f.  In the source view the changed lines go into the text one
// by one (Chrome is slow to insert many lines at once), and one Ctrl+Z takes
// them all back; in the paper it is one step of the paper's undo.
async function latexindentFile() {
  let name, text;
  if (SRC.on) {
    name = SRC.name;
    if (SRC.preview || $('#srcta').readOnly) { toast('Preview only: turn it off to change the file here'); return; }
    text = $('#srcta').value;
  } else {
    const seg = caretSeg();
    name = seg && seg.file;
    if (!name) { toast('Put the cursor in the text first', 'error'); return; }
    commit();
    text = FILES[name].text;
  }
  if (!/\.tex$/.test(name || '')) { toast('latexindent is for .tex files'); return; }
  const r = await fetch('/api/latexindent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify({ text }) }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) { banner('latexindent did not run: ' + (d.error || 'no answer from the editor')); return; }
  if (d.text === text) { toast(`latexindent changed nothing in ${name}`); return; }
  if (SRC.on) {
    if (SRC.name !== name || $('#srcta').value !== text) { toast('The text changed while latexindent ran: run it again'); return; }
    srcSetText(d.text);
  } else {
    commit();
    if (FILES[name].text !== text) { toast('The text changed while latexindent ran: run it again'); return; }
    snapshot();
    const y = viewAnchor();
    FILES[name].text = d.text;
    render();
    restoreAnchor(y);
  }
  toast(`${name}: indented by latexindent (Ctrl+Z takes it back)`, 'ok');
}
// The source view's text becomes `out`: the lines that differ are replaced
// one by one (when the number of lines is the same), as one step of undo.
function srcSetText(out) {
  const ta = $('#srcta'), v = ta.value;
  const a = v.split('\n'), b = out.split('\n');
  const caretLine = v.slice(0, ta.selectionStart).split('\n').length - 1;
  const caretCol = ta.selectionStart - (v.lastIndexOf('\n', ta.selectionStart - 1) + 1);
  const starts = [0];
  for (let i = 0; i < a.length - 1; i++) starts.push(starts[i] + a[i].length + 1);
  const ops = [];
  if (a.length === b.length) {
    for (let i = a.length - 1; i >= 0; i--) if (a[i] !== b[i]) ops.push([starts[i], starts[i] + a[i].length, b[i]]);
  } else {
    let p = 0;
    while (p < v.length && p < out.length && v[p] === out[p]) p++;
    let q = 0;
    while (q < v.length - p && q < out.length - p && v[v.length - 1 - q] === out[out.length - 1 - q]) q++;
    ops.push([p, v.length - q, out.slice(p, out.length - q)]);
  }
  SRC.quiet = true;
  try { for (const [x, y, t] of ops) srcReplace(ta, x, y, t); } finally { SRC.quiet = false; }
  if (ta.value !== out) { ta.setRangeText(out, 0, ta.value.length); SMC.undo = []; }
  else { SMC.undo.push({ n: ops.length, at: ta.value, cursors: null, after: null }); SMC.redo = []; }
  // the caret stays on its line, moved with the line's indentation
  if (a.length === b.length) {
    const ind = (l) => /^[ \t]*/.exec(l)[0].length;
    const ns = b.slice(0, caretLine).reduce((n, l) => n + l.length + 1, 0);
    const col = Math.max(0, Math.min(b[caretLine].length, caretCol + ind(b[caretLine]) - ind(a[caretLine])));
    ta.setSelectionRange(ns + col, ns + col);
  }
  ta.dispatchEvent(new Event('input'));
}

// Saving the files of the source view that are not part of the document.
// ---- files from the source view: new, rename, delete
async function srcReloadFiles() {
  try { SRC.files = await (await fetch('/api/srcfiles')).json(); } catch (e) { SRC.files = []; }
  if (!Array.isArray(SRC.files)) SRC.files = [];
  for (const n of Object.keys(FILES)) if (srcDoc(n) && !SRC.files.some((f) => f.name === n)) SRC.files.unshift({ name: n, doc: true });
  DOC.disk_files = SRC.files.map((f) => f.name);
}
function checkNewName(name, ext) {
  name = (name || '').trim().replace(/^\.\//, '');
  if (!name) return null;
  if (!/\.(tex|bib)$/.test(name)) name += ext || '.tex';
  if (name.split('/').some((p) => !p || p === '..' || p.startsWith('.'))) { toast('That name is not inside the paper\'s folder', 'error'); return null; }
  if (ext && !name.endsWith(ext)) { toast(`Keep the ${ext} ending: a ${ext} file stays one`, 'error'); return null; }
  if (knownFiles().has(name) || (SRC.files || []).some((f) => f.name === name)) { toast(`${name} already exists`, 'error'); return null; }
  return name;
}
async function srcNewFile() {
  const name = checkNewName(prompt('Name of the new file (.tex or .bib, inside the paper\'s folder):', sectionsDir() + 'new.tex'));
  if (!name) return;
  const text = name.endsWith('.bib') ? '' : '% ' + name.replace(/^.*\//, '') + '\n';
  const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify({ name, base: null, text, create: true }) });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) { banner(`Could not make ${name}: ${res.error || r.status}`); return; }
  await srcReloadFiles();
  if (name.endsWith('.tex') && confirm(`Read ${name} in the document? Its \\input goes after the block the cursor was in (or at the end of the text); save to keep that.`)) {
    flushSource();
    FILES[name] = { text, disk: text, base: res.hash };
    DOC.files[name] = { text, hash: res.hash };
    const at = SRC.paperAt && SRC.paperAt.el && SRC.paperAt.el.isConnected ? SRC.paperAt : null;
    structural(() => insertInputAfter(at ? { segs: FILES[at.file].segs, after: at } : newSectionPlace(null), name), true);
    // the file shown in the source view may be the one that got the \input:
    // it shows that now (flushing its old text would take the \input out)
    if (SRC.on && srcDoc(SRC.name)) { commit(); $('#srcta').value = FILES[SRC.name].text; paintSource(); }
    SRC.files = SRC.files.map((f) => (f.name === name ? { ...f, doc: true } : f));
  }
  await openSourceFile(name);
  toast(`Made ${name}`, 'ok');
}
async function srcRename() {
  const name = SRC.name;
  if (!name || name === DOC.main) return;
  await renameFilePrompt(name);
}
// The \bibliography and \addbibresource that name a .bib file, by file.
const bibEntry = (b) => (b.trim().endsWith('.bib') ? b.trim() : b.trim() + '.bib');
function bibNamers(name) {
  const out = [];
  for (const [n, f] of Object.entries(FILES)) {
    const t = typeof f.text === 'string' ? f.text.replace(/(^|[^\\])%.*$/gm, '$1') : '';
    if ([...t.matchAll(/\\bibliography\s*\{([^}]*)\}/g)].some((m) => m[1].split(',').map(bibEntry).includes(name)) ||
        [...t.matchAll(/\\addbibresource(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)].some((m) => m[1].trim() === name)) out.push(n);
  }
  return out;
}
// Take a .bib out of every \bibliography list (the command goes when it
// names nothing else) and every \addbibresource of it.
function unnameBib(name) {
  for (const f of Object.values(FILES)) {
    if (typeof f.text !== 'string') continue;
    f.text = f.text
      .replace(/\\bibliography\s*\{([^}]*)\}[ \t]*\n?/g, (m, list) => {
        const keep = list.split(',').filter((b) => bibEntry(b) !== name);
        return keep.length ? m.replace(list, keep.map((b) => b.trim()).join(',')) : '';
      })
      .replace(/\\addbibresource(?:\[[^\]]*\])?\s*\{([^}]*)\}[ \t]*\n?/g, (m, b) => (b.trim() === name ? '' : m));
  }
}

// The file shown in the source view takes the text changed under it (even
// with the focus in it, where refreshSourceView leaves it alone), so that
// the next flush does not write the old text back.
function syncSourceText() {
  if (!SRC.on || !SRC.name || !srcDoc(SRC.name)) return;
  commit();
  const ta = $('#srcta'), a = ta.selectionStart, top = ta.scrollTop;
  if (ta.value === FILES[SRC.name].text) return;
  ta.value = FILES[SRC.name].text;
  ta.scrollTop = top; ta.setSelectionRange(a, a);
  refreshSourceView();
}

// A field in place of the file's name in the list: Enter renames, Esc keeps.
function renameInList(row, name) {
  const input = el('input', 'srcfile-edit');
  input.value = name;
  input.spellcheck = false;
  input.setAttribute('aria-label', `New name for ${name}`);
  row.replaceChildren(input);
  input.focus();
  // the name without the folder and the extension is selected
  const from = name.lastIndexOf('/') + 1, to = name.lastIndexOf('.') > from ? name.lastIndexOf('.') : name.length;
  input.setSelectionRange(from, to);
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    if (ok && input.value.trim() !== name) { input.disabled = true; if (await renameFile(name, input.value)) return; }
    drawSourceFiles();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(false));
}

async function srcDelete(name = SRC.name) {
  if (!name || name === DOC.main) return;
  flushSource();
  commit();
  const inp = inputSegOf(name);
  const namers = name.endsWith('.bib') ? bibNamers(name) : [];
  if (namers.length) {
    if (!confirm(`${name} is named by \\bibliography in ${namers.join(', ')}. Take it out of that list, save, and move ${name} to the editor's trash?\n\nCitations of its entries will show ?; the trash (.paper-editor/trash) and History keep it.`)) return;
    snapshot();
    unnameBib(name);
    const y = viewAnchor();
    render();
    restoreAnchor(y);
    syncSourceText();
    await save();
    commit();
    if (namers.some((n) => FILES[n] && FILES[n].text !== FILES[n].disk)) { toast(`Not deleted: ${namers.join(', ')} could not be saved`, 'error'); return; }
  } else if (inp) {
    if (!confirm(`${name} is read by ${inp.file}. Take its \\input out of ${inp.file}, save, and move ${name} to the editor's trash?\n\nIts text leaves the paper; the trash (.paper-editor/trash) and History keep it.`)) return;
    structural(() => {
      const segs = FILES[inp.file].segs, i = segs.indexOf(inp);
      inp.removed = true;
      if (segs[i - 1] && segs[i - 1].kind === 'gap') segs[i - 1].removed = true;
      else if (segs[i + 1] && segs[i + 1].kind === 'gap') segs[i + 1].removed = true;
    });
    syncSourceText();
    await save();
    if (inputSegOf(name)) { toast(`Not deleted: ${inp.file} could not be saved`, 'error'); return; }
  } else if (!confirm(`Move ${name} to the editor's trash (.paper-editor/trash)?`)) return;
  if (isNewFile(name)) { delete FILES[name]; toast(`${name} was never saved: it is gone`, 'ok'); }
  else {
    const r = await fetch('/api/file/trash', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ name }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) { banner(`Could not delete ${name}: ${res.error || r.status}`); return; }
    delete FILES[name];
    if (DOC.files) delete DOC.files[name];
    delete SRC.extra[name];
    toast(`${name} moved to ${res.trash}`, 'ok');
  }
  const wasOpen = name === SRC.name;
  await srcReloadFiles();
  if (SRC.on && wasOpen) await openSourceFile(DOC.main);
  else drawSourceFiles();
}

async function saveExtra(batch) {
  let saved = 0;
  const conflicts = [];
  for (const name of extraEdited()) {
    const f = SRC.extra[name];
    const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
      body: JSON.stringify({ name, base: f.base, text: f.text, batch }) });
    const res = await r.json().catch(() => ({}));
    if (r.status === 409) { conflicts.push(name); continue; }
    if (!r.ok) { banner(`Saving ${name} failed: ${res.error || r.status}. Your edits are still here.`); continue; }
    f.disk = f.text; f.base = res.hash;
    saved++;
  }
  if (conflicts.length) banner(`${conflicts.join(', ')} changed on disk since it was opened in the source view; not saved. Copy your edits, then open the file again.`);
  if (SRC.on) paintSource();
  drawSourceFiles();
  return saved;
}

// ================================================================= trace
//
// A flight recorder for problems: what was pressed and clicked, what the
// editor did (draws, loads, saves, structure changes, messages) and every
// scroll with what caused it.  A scroll nobody asked for (no wheel, key or
// click just before, no scroll call of the editor) is marked as a jump, with
// the layout shifts the browser saw.  Kept on this machine only, in
// .paper-editor/debug/trace.jsonl; ☰ → Report a problem… copies the last
// minutes aside with a note.  Typed text is not kept: only how much was typed.
const REC = (() => {
  const buf = [];
  let sent = 0, lastInput = 0, lastCall = 0, lastY = scrollY, typed = 0, typedAt = 0;
  const push = (k, data = {}) => {
    buf.push({ t: Date.now(), k, y: Math.round(scrollY), ...data });
    if (buf.length > 6000) { buf.splice(0, 1000); sent = Math.max(0, sent - 1000); }
  };
  const desc = (n) => {
    if (!n || n.nodeType !== 1) return '';
    const b = n.closest('button, a, input, select, textarea, [contenteditable="true"], .chip, .seg') || n;
    const parts = [b.tagName.toLowerCase()];
    if (b.id) parts.push('#' + b.id);
    if (b.dataset && b.dataset.act) parts.push('[' + b.dataset.act + ']');
    const label = b.getAttribute && (b.getAttribute('aria-label') || b.title);
    if (label) parts.push('"' + label.slice(0, 40) + '"');
    else if (b.tagName === 'BUTTON' || b.tagName === 'A') parts.push('"' + (b.textContent || '').trim().slice(0, 30) + '"');
    if (b.classList && b.classList.contains('chip')) parts.push('chip ' + (b.dataset.src || '').slice(0, 30));
    const seg = typeof segOf === 'function' ? segOf(b) : null;
    if (seg) parts.push(`in ${seg.kind} ${seg.file}:${seg.line || '?'}`);
    const box = b.closest('[role=dialog], #toolbar, #bar, #findbar, #banner, #srcview, #menu, .popover');
    if (box && box.id) parts.push('(' + box.id + ')');
    return parts.join(' ');
  };
  const flushTyped = () => { if (typed) { push('typed', { n: typed }); typed = 0; } };
  const user = () => { lastInput = Date.now(); };
  addEventListener('wheel', user, { capture: true, passive: true });
  addEventListener('touchstart', user, { capture: true, passive: true });
  addEventListener('pointerdown', (e) => { user(); flushTyped(); push('press', { on: desc(e.target), x: Math.round(e.clientX), yy: Math.round(e.clientY), b: e.button }); }, true);
  addEventListener('keydown', (e) => {
    user();
    const k = typeof keyName === 'function' ? keyName(e) : e.key;
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) return;   // counted as input below
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    flushTyped();
    push('key', { key: k, on: desc(e.target) });
  }, true);
  // typing (keys, input methods, pastes) as a count of characters, not the text
  addEventListener('beforeinput', (e) => {
    if (/^insert(Text|CompositionText|ReplacementText)$/.test(e.inputType)) { typed += (e.data || '').length || 1; typedAt = Date.now(); }
    else if (e.inputType !== 'insertText') { flushTyped(); push('input', { type: e.inputType, on: desc(e.target) }); }
  }, true);
  setInterval(() => { if (typed && Date.now() - typedAt > 1500) flushTyped(); }, 1000);
  // scrolls: by the user, by the editor (which function), or by neither (a jump)
  const wrapScroll = (o, name) => {
    const f = o[name];
    o[name] = function (...a) {
      lastCall = Date.now();
      const by = (new Error().stack.split('\n')[2] || '').trim().replace(/^at /, '').replace(/\(?https?:\/\/[^)]*\/static\//, '').slice(0, 70);
      push('scrollcall', { fn: name, by, a: JSON.stringify(a).slice(0, 60) });
      return f.apply(this, a);
    };
  };
  wrapScroll(window, 'scrollBy'); wrapScroll(window, 'scrollTo'); wrapScroll(Element.prototype, 'scrollIntoView');
  let scrollT = null, scrollFrom = scrollY;
  addEventListener('scroll', () => {
    const now = Date.now(), d = scrollY - lastY;
    lastY = scrollY;
    if (now - lastInput > 500 && now - lastCall > 150 && Math.abs(d) > 40) push('jump', { d: Math.round(d), note: 'no input or scroll call just before: layout or browser anchoring' });
    clearTimeout(scrollT);
    scrollT = setTimeout(() => { if (Math.abs(scrollY - scrollFrom) > 2) push('scrolled', { from: Math.round(scrollFrom), to: Math.round(scrollY) }); scrollFrom = scrollY; }, 300);
  }, { passive: true });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.value < 0.02 || e.hadRecentInput) continue;
        push('shift', { v: +e.value.toFixed(3), what: (e.sources || []).slice(0, 3).map((s) => desc(s.node) + ` ${Math.round(s.previousRect.top)}→${Math.round(s.currentRect.top)}`) });
      }
    }).observe({ type: 'layout-shift', buffered: false });
  } catch (e) { /* not supported */ }
  addEventListener('error', (e) => push('error', { msg: String(e.message).slice(0, 300), at: `${(e.filename || '').replace(/^.*\//, '')}:${e.lineno}` }));
  addEventListener('unhandledrejection', (e) => push('error', { msg: String(e.reason && (e.reason.stack || e.reason)).slice(0, 400) }));
  // the editor's own steps
  const wrap = (name, info, onlyChanges = false) => {
    const f = window[name];
    if (typeof f !== 'function') return;
    let last = '';
    window[name] = function (...a) {
      const data = { fn: name, ...(info ? info(...a) : {}) };
      const key = JSON.stringify(data);
      if (!onlyChanges || key !== last) { flushTyped(); push('do', data); }
      last = key;
      return f.apply(this, a);
    };
  };
  for (const name of ['render', 'load', 'save', 'structural', 'restore', 'restoreAnchor', 'revealChanged', 'focusPlaceholder', 'toggleSource',
    'openFigure', 'diffOn', 'diffOff', 'openFind', 'openFiles', 'splitToFile', 'splitAllSections', 'inlineFile', 'moveSection', 'requestBuild', 'checkDraft', 'restoreDraft']) wrap(name);
  wrap('toast', (msg, kind) => ({ msg: String(msg).slice(0, 160), kind }));
  wrap('banner', (msg) => ({ msg: String(msg).slice(0, 200) }));
  wrap('setBuild', (b) => ({ state: b && b.state, msg: b && String(b.message || '').slice(0, 80) }), true);   // (polled every 2 s)
  push('open', { ua: navigator.userAgent.replace(/^.*(Chrome\/[\d.]+).*$/, '$1'), w: innerWidth, h: innerHeight, dpr: devicePixelRatio });
  const flush = async () => {
    flushTyped();
    if (sent >= buf.length) return;
    const entries = buf.slice(sent);
    const upTo = buf.length;
    try {
      const r = await fetch('/api/trace', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ client: CLIENT_ID, entries }) });
      if (r.ok) sent = upTo;
    } catch (e) { /* the server is away: kept for the next try */ }
  };
  setInterval(flush, 4000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  async function report() {
    const note = prompt('What went wrong? (a line is enough; the last 10 minutes of what you pressed and what the editor did are kept with it, on this machine only)', '');
    if (note === null) return;
    push('report', { note: note.slice(0, 2000) });
    await flush();
    const r = await fetch('/api/trace/report', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ note }) }).catch(() => null);
    const res = r && r.ok ? await r.json() : null;
    if (res) banner(`Problem report kept in ${res.file.replace(/^.*\/\.paper-editor\//, '.paper-editor/')} — tell Claude to read it.`);
    else banner('Could not keep the report: the server did not answer.');
  }
  return { push, flush, report };
})();
$('#reportbtn').onclick = () => { closePopovers(); REC.report(); };
