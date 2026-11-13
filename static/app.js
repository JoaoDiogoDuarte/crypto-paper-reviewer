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
const MODALS = { paperbox: 'Paper', historybox: 'History', keysbox: 'Keys', figview: 'Figure', helpbox: 'Help', openbox: 'Open' };
function syncModal() {
  const open = Object.keys(MODALS).some((id) => { const e = document.getElementById(id); return e && !e.hidden; });
  document.documentElement.classList.toggle('modal-open', open);
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
function viewAnchor() {
  const top = (document.querySelector('#toolbar') || document.querySelector('#bar'))?.getBoundingClientRect().bottom || 0;
  const segs = (typeof ORDER !== 'undefined' ? ORDER : []).filter((s) => s.el && s.el.isConnected);
  for (const [i, s] of segs.entries()) {
    const r = s.el.getBoundingClientRect();
    if (r.height && r.bottom > top) return { y: window.scrollY, i, file: s.file, src: s.src, top: r.top };
  }
  return { y: window.scrollY };
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
  const find = () => {
    const segs = ORDER.filter((s) => s.el && s.el.isConnected);
    return segs.find((s) => s.file === a.file && s.src === a.src) ||
      (segs[a.i] && segs[a.i].file === a.file ? segs[a.i] : null);
  };
  const put = () => {
    const s = a.top !== undefined && find();
    if (s) window.scrollBy(0, s.el.getBoundingClientRect().top - a.top);
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
  if (oldMacros !== JSON.stringify(DOC.macros)) KATEX_CACHE.clear();
  if (DOC) commit();   // typing while the document was being fetched
  for (const [name, f] of Object.entries(DOC.files)) {
    const cur = FILES[name];
    if (cur && cur.text !== cur.disk && !discard.includes(name)) continue;
    FILES[name] = { text: f.text, disk: f.text, base: f.hash };
  }
  render();
  fillMains();
  restoreEditorState(caret);
  if (keepScroll) restoreAnchor(y);
  setBuild(DOC.build);
  showWhere();
  if (new URLSearchParams(location.search).has('selftest')) selfTest();
}

function captureEditorState() {
  const selection = getSelection();
  if (!selection.rangeCount || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const seg = segOf(node);
  if (!seg || !seg.edit || !seg.edit.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(seg.edit);
  before.setEnd(range.startContainer, range.startOffset);
  const segs = (FILES[seg.file] && FILES[seg.file].segs) || [];
  return { file: seg.file, index: segs.indexOf(seg), src: seg.src, offset: before.toString().length };
}

// Put the caret back at the same character of the same block after a
// re-render (the block is found by its place in its file, or by its source).
function restoreEditorState(state) {
  if (!state) return;
  const segs = (FILES[state.file] && FILES[state.file].segs) || [];
  let seg = segs[state.index];
  if (!seg || !seg.edit || seg.edit.tagName === 'TEXTAREA') seg = ORDER.find((item) => item.file === state.file && item.src === state.src && item.edit);
  if (!seg || !seg.edit || seg.edit.tagName === 'TEXTAREA') return;
  const walker = document.createTreeWalker(seg.edit, NodeFilter.SHOW_TEXT);
  let node, offset = state.offset;
  while ((node = walker.nextNode())) {
    if (offset <= node.data.length) {
      const range = document.createRange();
      range.setStart(node, offset); range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      seg.edit.focus({ preventScroll: true });
      return;
    }
    offset -= node.data.length;
  }
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
  for (const h of DOC.aux.heads || []) (HEADS[h.level] = HEADS[h.level] || []).push(h.num);
}
let HEADS = {};

// ---------------------------------------------------------------- rendering

function render() {
  unicodeEngine.v = undefined;      // the preamble may have changed
  DIFF_SHOWN = false;
  const speech = typeof TTS !== 'undefined' ? TTS.detach() : null;
  const doc = $('#doc');
  doc.textContent = '';
  ORDER = [];
  configure();
  const ctx = { sec: 0, sub: 0, subsub: 0, app: false, counters: {}, heads: {}, env: [] };
  for (const name of Object.keys(FILES)) FILES[name].segs = assignLines(parseFile(name));
  const title = documentTitle(FILES[DOC.main].text);
  if (title) {
    const h = el('h1', 'doctitle');
    renderMathless(title.replace(/\\\\(\[[^\]]*\])?/g, ' '), h);
    doc.append(h);
    $('#title').textContent = h.textContent;
    showWhere();
  }
  const walk = (name) => {
    for (const seg of FILES[name].segs) {
      if (seg.kind === 'input') { if (FILES[seg.input]) walk(seg.input); continue; }
      ORDER.push(seg);
      const node = renderSeg(seg, ctx);
      if (node) seg.el = node;
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
      marked[markBoxes.at].scrollIntoView({ block: 'center', behavior: 'smooth' });
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
  const cls = (DOC.docclass || 'article').split('/')[0];
  const twoCol = cls === 'IEEEtran' || /twocolumn/.test(DOC.docclass || '');
  const perPage = Math.round((CHARS_PER_PAGE[cls] || 3300) * (flowing ? 1.55 : 1));
  let page = 1, chars = 0, last = 0, box = null;
  const startPage = (n) => {
    box = el('section', 'page');
    box.dataset.page = n;
    box.append(el('div', 'pagemark', flowing ? 'review spread ' + n : (exact ? 'page ' : 'approx. page ') + n));
    doc.append(box);
  };
  for (const seg of ORDER) {
    if (!seg.el) continue;
    if (exact) {
      const lines = DOC.pages[seg.file] || [];
      const hit = lines.find(([ln]) => ln >= seg.line && ln <= seg.lastLine);
      if (hit) page = Math.max(page, hit[1]);
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
      for (let tail; prev && (tail = prev.lastElementChild) && tail.seg && tail.seg.kind === 'heading';) {
        box.insertBefore(tail, box.children[1] || null);
        tail.seg.page = page;
      }
    }
    seg.page = page;
    box.append(seg.el);
  }
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
  const m = /\\title\s*(\[)?/.exec(text.replace(/(^|[^\\])%.*$/gm, '$1'));
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
  plus.onclick = (e) => { e.stopPropagation(); addMenu(seg, plus); };
  t.append(plus);
  for (const b of tools || []) t.append(b);
  box.append(t);
  box.seg = seg;
  return box;
}

function renderPara(seg, ctx) {
  const p = el('div', 'para');
  p.contentEditable = 'true';
  const toks = L.tokenize(seg.src);
  // italic theorem bodies: an open theorem environment carries over
  if (ctx.env.length && L.THM_ENVS.has(ctx.env[ctx.env.length - 1])) p.classList.add('thm');
  renderTokens(toks, p, ctx);
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
    else if (h.level === 'subsubsection') num = `${ctx.sec}.${ctx.sub}.${ctx.subsub}`;
    if (num && !/[.:]$/.test(num)) num += '.';
  }
  if (num) node.append(el('span', 'num', num));
  const t = el('span', 'htitle');
  t.contentEditable = 'true';
  renderTokens(L.tokenize(h.title), t, ctx);
  node.append(t);
  seg.edit = t;
  seg.parts = h;
  const del = el('button', '', 'Delete');
  del.title = 'Delete this heading, Ctrl+Alt+X (keeps the text under it)';
  del.onclick = (e) => { e.stopPropagation(); if (confirm('Delete this heading?' + labelWarning(seg))) structural(() => removeSeg(seg)); };
  const up = el('button', '', 'Up');
  up.title = 'Move this section up (Ctrl+Alt+Up)';
  up.onclick = (e) => { e.stopPropagation(); moveSection(seg, -1); };
  const down = el('button', '', 'Down');
  down.title = 'Move this section down (Ctrl+Alt+Down)';
  down.onclick = (e) => { e.stopPropagation(); moveSection(seg, 1); };
  const merge = el('button', '', 'Merge');
  merge.title = 'Combine this section with the previous one (Ctrl+Alt+J)';
  merge.onclick = (e) => { e.stopPropagation(); if (confirm('Combine this section with the previous one?' + labelWarning(seg))) structural(() => removeSeg(seg)); };
  return wrapSeg(seg, node, [up, down, merge, del]);
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

function renderCode(seg) {
  const c = L.splitCode(seg.src);
  seg.parts = c;
  const ta = el('textarea');
  ta.value = c.body;
  ta.spellcheck = false;
  ta.rows = Math.max(2, c.body.split('\n').length);
  ta.addEventListener('input', () => { seg.touched = true; lastTyping = Date.now(); markEditedSoon(); });
  seg.edit = ta;
  return wrapSeg(seg, ta);
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
    const num = el('b', 'capnum', (seg.kind === 'figure' ? 'Fig. ' : 'Table ') + (n || '?') + '. ');
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

const HIDDEN = new Set(['label', 'clearpage', 'newpage', 'maketitle', 'bibliographystyle', 'FloatBarrier',
  'vspace', 'noindent', 'centering', 'title', 'author', 'nonumber', 'medskip', 'smallskip', 'bigskip',
  'Needspace', 'raggedbottom', 'balance', 'IEEEauthorblockN', 'IEEEauthorblockA', 'leavevmode',
  'protect', 'institute', 'inst', 'orcidID', 'email', 'date', 'titlerunning', 'authorrunning', 'thanks',
  'affiliation', 'address', 'addauthor', 'authorrunning', 'keywords', 'IEEEoverridecommandlockouts',
  'IEEEpeerreviewmaketitle', 'license', 'Copyright', 'EventEditors', 'EventNoEds', 'EventLongTitle',
  'EventShortTitle', 'EventAcronym', 'EventYear', 'EventDate', 'EventLocation', 'EventLogo', 'SeriesVolume',
  'ArticleNo', 'ccsdesc', 'relatedversion', 'funding', 'acknowledgements', 'nolinenumbers', 'hideLIPIcs',
  'authorrunning', 'subjclass', 'category', 'supplement', 'copyrightyear', 'acmYear', 'acmDOI', 'acmConference',
  'acmBooktitle', 'acmPrice', 'acmISBN', 'setcopyright', 'orcid', 'country', 'institution', 'city']);

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
    const num = (k) => DOC.aux.cites[k] || '?';
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
    c.append(el('span', 'itemmark', '[' + (label || DOC.aux.cites[key.trim()] || '?') + '] '));
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
  if (name === 'verbatim') return chip('src', tok.s, '[' + tok.env + ']');
  // characters typed into the text are saved as these commands; show them as
  // the characters
  if (name === 'textasciitilde') return chip('char', tok.s, '~');
  if (name === 'textasciicircum') return chip('char', tok.s, '^');
  if (name === 'textbackslash') return chip('char', tok.s, '\\');
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
  // a text macro (\oracle -> \textbf{Oracle}\ ): show what it prints
  const textMacro = body !== undefined && tok.s === '\\' + name &&
    /^\s*\\(textbf|textit|textsf|textrm|texttt|textsc|emph|mbox|text)\{([^{}\\$]*)\}\s*(\\ |~|\\xspace)?\s*$/.exec(body);
  if (textMacro) {
    const c = chip('src textmacro', tok.s, textMacro[2] + (textMacro[3] ? ' ' : ''));
    c.style.fontWeight = textMacro[1] === 'textbf' ? 'bold' : '';
    c.style.fontStyle = /textit|emph/.test(textMacro[1]) ? 'italic' : '';
    c.title = tok.s;
    return c;
  }
  return chip('src', tok.s, tok.s.length > 40 ? tok.s.slice(0, 38) + '…' : tok.s);
}

function envChip(tok, ctx) {
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
const katexMacros = () => ({ ...KATEX_SHIMS, ...CRYPTOCODE_MACROS, ...DOC.macros });
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
      html = katex.renderToString(body, { displayMode: display || disp, throwOnError: false,
        macros: katexMacros(), strict: false, trust: false });
      KATEX_CACHE.set(key, html);
    }
    node.innerHTML = html;
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
    li.textContent = `[${n}] ` + (DOC.bib[k] || k).replace(/\\[a-zA-Z]+\s*|[{}~]/g, (m) => (m === '~' ? ' ' : ''));
    ol.append(li);
  }
  c.append(h, ol);
  return c;
}

// ------------------------------------------------------------ references

const TYPE_NAMES = { section: 'Section', subsection: 'Section', lemma: 'Lemma', theorem: 'Theorem',
  corollary: 'Corollary', definition: 'Definition', figure: 'Fig.', table: 'Table', appendix: 'Appendix' };

function labelValue(key) { const l = DOC.aux.labels[key.trim()]; return l && l.v; }

function refText(cmd, keys) {
  const parts = keys.split(',').map((k) => {
    k = k.trim();
    const l = DOC.aux.labels[k] || {};
    const v = l.v || '??';
    if (cmd === 'ref') return v;
    if (cmd === 'eqref' || l.type === 'equation') return `(${v})`;
    const n = k.startsWith('app:') ? 'Appendix' : (TYPE_NAMES[l.type] || '');
    return (n ? n + '\u00a0' : '') + v;
  });
  return parts.join(' and ');
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
      let t = L.encodeText(n.data);
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
      return seg.parts.prefix + fix(ser(seg.edit), seg.parts.title) + seg.parts.suffix;
    }
    case 'code': return seg.edit && seg.touched ? seg.parts.pre + seg.edit.value + seg.parts.post : seg.src;
    case 'figure': case 'table':
      if (!seg.edit || !seg.parts) return seg.figSrc || seg.src;
      return seg.parts.prefix + fix(ser(seg.edit), seg.parts.caption) + seg.parts.suffix;
    case 'hidden': return seg.patched !== undefined ? seg.patched : seg.src;
    default: return seg.src;
  }
}

// Write the page back into the file texts.  Returns house-rule warnings.
function commit(applyRules = true) {
  const warnings = [];
  HOUSE_RULE_CHANGES = [];
  if (DIFF_SHOWN) return warnings;   // the texts were committed when the diff opened
  flushEdits();
  for (const [name, f] of Object.entries(FILES)) {
    if (!f.segs) continue;
    f.text = f.segs.map((s) => segSource(s, warnings, HOUSE_RULE_CHANGES, applyRules)).join('');
  }
  return warnings;
}

function editedFiles() {
  commit();
  return Object.keys(FILES).filter((n) => FILES[n].text !== FILES[n].disk);
}

function markEdited() {
  flushEdits();
  const files = editedFiles();
  $('#dirty').textContent = files.length ? files.length + ' file' + (files.length > 1 ? 's' : '') + ' edited' : '';
  $('#save').classList.toggle('has-changes', files.length > 0);
  for (const seg of ORDER) {
    if (seg.el) seg.el.classList.toggle('edited', segSource(seg, []) !== seg.src);
  }
}

// ------------------------------------------------------- structure edits

// Commit, apply a change to the segment lists, re-render from the texts.
function structural(change) {
  if (leaveDiff()) return;   // the blocks of the diff view are not the document
  // every structure change can be undone (Delete and Merge of a heading took
  // no snapshot, so Ctrl+Z could not bring the heading back)
  snapshot();
  // where the change was asked for: the new placeholder is the one nearest
  // there, not the first one in the paper (an earlier one may be unfilled)
  const at = (() => { try { const sg = segOf(editableAt(selRange()) || document.body); return sg && sg.file ? { file: sg.file, line: sg.line || 0 } : null; } catch (e) { return null; } })();
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
  const near = INSERT_HINT || at;
  INSERT_HINT = null;
  if (focus) focusPlaceholder(focus, near);
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
    if (previous < 0 || segs[previous].kind !== 'heading') {
      banner(previous < 0 ? 'This section is already first among its siblings.' : 'The section before this one is in another file (\\input); move it there.');
      return;
    }
    [lo, mid, hi] = [previous, start, end];
  } else {
    const next = end < segs.length ? headingRank(segs[end]) : null;
    if (next !== rank || segs[end].kind !== 'heading') {
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
  best.seg.edit.focus();
  best.seg.el.scrollIntoView({ block: 'center' });
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
  range.deleteContents();
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
  const latex = e.clipboardData.getData(LATEX_MIME);
  let nodes;
  if (latex) {
    const frag = document.createDocumentFragment();
    renderTokens(L.tokenize(latex.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n')), frag, {});
    nodes = [...frag.childNodes];
  } else {
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/\s*\n\s*/g, ' ');
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
  if (!r) {              // across blocks: the browser's own copy, and no cut
    if (cut && spansEditables()) { e.preventDefault(); banner(ACROSS); }
    return;
  }
  const frag = r.cloneContents();
  KEEP_UNICODE = ''; KEEP_MATH_UNICODE = '';
  e.clipboardData.setData('text/plain', plainOf(frag));
  e.clipboardData.setData(LATEX_MIME, ser(frag));
  e.preventDefault();
  if (cut) {
    snapshot();
    r.deleteContents();
    markEditedSoon();
  }
}
doc.addEventListener('copy', (e) => copySelection(e, false));
doc.addEventListener('cut', (e) => copySelection(e, true));

function segOf(node) {
  const box = node.closest && node.closest('.seg');
  return box ? box.seg : null;
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

$('#cols').onclick = () => {
  // This handler also restores the remembered mode before the first load().
  // No document exists yet in that case, so defer any rerender.
  if (DOC) commit();
  const caret = DOC ? captureEditorState() : null;
  const y = viewAnchor();
  const two = document.body.classList.toggle('two');
  $('#cols').setAttribute('aria-pressed', String(two));
  $('#cols').title = (two ? 'Two columns: on (click for one column)' : 'One column (click for two columns)') + ' (Ctrl+Alt+W)';
  if (DOC) toast(two ? 'Two columns' : 'One column');
  if (DOC) {
    render();
    restoreEditorState(caret);
    restoreAnchor(y);
  }
  try { localStorage.setItem('cols', two ? '2' : '1'); } catch (e) { /* storage unavailable */ }
};
try { if (localStorage.getItem('cols') === '2') $('#cols').click(); } catch (e) { /* storage unavailable */ }
$('#help').onclick = () => { $('#helpbox').hidden = false; };
// The paper's text size, apart from the interface (browser zoom changes both).
const TEXT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 27, 30];
function setTextSize(px, say = true) {
  px = TEXT_SIZES.includes(px) ? px : 16;
  const y = DOC ? viewAnchor() : null;
  document.documentElement.style.setProperty('--doc-size', px + 'px');
  $('#textsize').textContent = Math.round(px / 16 * 100) + '%';
  $('#textsmaller').disabled = px === TEXT_SIZES[0];
  $('#textbigger').disabled = px === TEXT_SIZES[TEXT_SIZES.length - 1];
  if (y) restoreAnchor(y);
  if (say) toast('Text size ' + $('#textsize').textContent);
  try { localStorage.setItem('docsize', String(px)); } catch (e) { /* storage unavailable */ }
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
let SAVING = false, SAVE_AGAIN = false;
async function save() {
  leaveDiff();
  if (SAVING) { SAVE_AGAIN = true; return; }
  SAVING = true;
  try {
    do { SAVE_AGAIN = false; await saveOnce(); } while (SAVE_AGAIN);
  } catch (e) {
    banner('Saving failed: ' + e.message + '. Your edits are still here.');
  } finally {
    SAVING = false;
  }
}

async function saveOnce() {
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
  const files = Object.keys(FILES).filter((n) => FILES[n].text !== FILES[n].disk);
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
    FILES[name].disk = text;
    FILES[name].base = res.hash;
    saved++;
  }
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
  if (warnings.length && saved) banner('Saved. House rules: ' + [...new Set(warnings)].join('; '));
  if (conflicts.length) showExternal(conflicts, true);
  // a new \input names a file the page has not read yet
  if (saved && Object.values(FILES).some((f) => (f.segs || []).some((s) => s.kind === 'input' && !s.removed && !s.input))) {
    await load(true);
  }
}

// Leaving the page (closing the tab, reloading) with unsaved edits asks first.
// this page, for the server: when the last page closes, a server that opened
// its own window stops (a reload says goodbye and comes back at once)
const CLIENT_ID = Math.random().toString(36).slice(2, 12);
addEventListener('pagehide', () => {
  try { navigator.sendBeacon('/api/bye', JSON.stringify({ token: TOKEN, c: CLIENT_ID })); } catch (e) { /* none */ }
});
window.addEventListener('beforeunload', (e) => {
  if (!DOC) return;
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

function banner(msg) {
  const b = $('#banner');
  b.textContent = msg;
  b.hidden = false;
  clearTimeout(banner.t);
  banner.t = setTimeout(() => { b.hidden = true; }, 12000);
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
      const busy = Date.now() - lastTyping < 4000 || !$('#drawer').hidden || PENDING_EXTERNAL || !$('#figview').hidden || DIFF_SHOWN || DIFF.on;
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
      if (s.figver !== undefined && s.figver !== FIGVER) { FIGVER = s.figver; await refreshFigures(); }
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
  $('#rate').onchange = () => {
    try { localStorage.setItem('rate', $('#rate').value); } catch (e) { /* none */ }
    if (audio) audio.playbackRate = rate();
    else if (speaking && !paused) again();     // a browser voice takes the rate per phrase
  };
  try {                                 // the chosen speed survives a reload, like the voice
    const savedRate = localStorage.getItem('rate');
    if (savedRate && [...$('#rate').options].some((o) => o.value === savedRate)) $('#rate').value = savedRate;
  } catch (e) { /* none */ }
  const rate = () => parseFloat($('#rate').value) || 1;

  // The phrases of one block, as the page shows it now.
  function phrases(seg) {
    if (!seg || !seg.el || seg.removed) return [];
    const node = (seg.kind === 'para' || seg.kind === 'quote') ? (seg.edit.classList.contains('quiet') ? null : seg.edit)
      : (seg.kind === 'heading' || seg.kind === 'figure' || seg.kind === 'table') ? seg.edit : null;
    if (!node) return [];
    const map = speechMap(node);
    return phraseBounds(map.text).map(([a, b]) => ({ seg, text: map.text.slice(a, b), range: () => rangeFor(map, a, b) }));
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
  function play() {
    if (speaking && paused) { pause(); return; }
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
    if (queue[idx]) { speaking = true; paused = false; next(); }
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
      clip(engine, name, item.text).then((c) => {
        if (run !== generation) return;
        const a = new Audio(c.src);
        audio = a;
        a.playbackRate = rate();
        const finish = () => {
          if (a.done || run !== generation) return;
          a.done = true; a.pause();
          if (audio === a) audio = null;
          next(run);
        };
        a.onended = finish;
        a.onerror = () => { if (run === generation && !a.done) { banner('Speech failed for this voice; see the server output.'); stop(); } };
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
        banner('Speech failed for this voice: ' + e.message);
        stop();
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
    let started = false;
    const budget = 4000 + (item.text.split(/\s+/).length * 420) / rate();
    const arm = (ms) => {
      clearTimeout(speakTimer);
      speakTimer = setTimeout(() => {
        if (run !== generation || paused || u.done) return;
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
    stalls = 0;
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
      else { generation++; clearTimeout(speakTimer); speakTimer = 0; if (synth) synth.cancel(); }
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
    if (!speaking || !cur) { reset(); return null; }
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
    if (!locate(state)) { stop(); return; }
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

  return { play, stop, pause, prev: () => jump(-1), next: () => jump(1), setAnchor, reset, detach, reattach,
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

// Highlight the phrase being read (CSS Custom Highlight API) and keep it on
// screen.  Without the API, the block highlight remains.
function markPhrase(range, reveal = true, force = false) {
  if (window.CSS && CSS.highlights) {
    if (range) CSS.highlights.set('tts', new Highlight(range)); else CSS.highlights.delete('tts');
  }
  if (range && reveal) revealRange(range, true, force);
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
  window.scrollBy({ top: delta, behavior: glide ? 'smooth' : 'auto' });
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
  '∅': ' the empty set ', '⊕': ' x-or ', '$': ' ', '!': ' factorial ' };

function mathSpeech(src) {
  let [body] = mathBody(src);
  body = body.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '');
  let html;
  try { html = katex.renderToString(body, { output: 'mathml', throwOnError: false, macros: katexMacros(), strict: false }); }
  catch (e) { return ''; }
  const m = new DOMParser().parseFromString(html, 'text/html').querySelector('math');
  return m ? speak(m).replace(/\s+/g, ' ').trim() : '';
}

function speak(e) {
  const tag = e.tagName.toLowerCase();
  const kids = [...e.children];
  const txt = () => (e.textContent || '').normalize('NFKC');
  switch (tag) {
    case 'annotation': return '';
    case 'mi': case 'mn': case 'mtext': { const t = txt(); return t.length > 1 && tag === 'mi' ? ' ' + t + ' ' : t; }
    case 'mo': { const t = txt(); return SPOKEN[t] !== undefined ? SPOKEN[t] : ' ' + t + ' '; }
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
    default: return kids.map(speak).join('');
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
  leaveDiff();
  commit();
  const cur = Object.fromEntries(Object.entries(FILES).map(([n, f]) => [n, f.text]));
  let texts = from.pop();
  while (texts && Object.keys(texts).every((n) => texts[n] === cur[n])) texts = from.pop();
  if (!texts) return;
  to.push(cur);
  for (const [n, t] of Object.entries(texts)) if (FILES[n]) FILES[n].text = t;
  const y = viewAnchor();
  render();
  restoreAnchor(y);
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
  const sel = tag === 'strong' ? 'strong, b' : 'em, i';
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
const ACROSS = 'Select inside one paragraph (or heading) to change it: a selection across blocks is only for copying.';
document.addEventListener('beforeinput', (e) => {
  if (e.target.closest && e.target.closest('#doc') && e.target.isContentEditable && spansEditables()) {
    e.preventDefault();
    banner(ACROSS);
  }
}, true);

// Keys that wrap a selection instead of replacing it; both the opening and
// the closing key wrap.  Quotes become TeX quotes (`` '' and ` ') on saving.
const WRAP_PAIRS = {
  '(': ['(', ')'], ')': ['(', ')'], '[': ['[', ']'], ']': ['[', ']'], '{': ['{', '}'], '}': ['{', '}'],
  '"': ['“', '”'], "'": ['‘', '’'], '`': ['‘', '’'],
};

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
  r.deleteContents();
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

function insertLatex(src, title) {
  const c = chip('src', src, src);
  // the starting text is an example: selected, so typing replaces it
  if (insertNodes([c])) { openDrawer(c, null, title, true); $('#drawer-src').select(); }
}

// C-d: delete the current line.  M-w: cut the region, or the line.
// C-p: duplicate the region, or the line.  C-+: word, line, paragraph.
async function cutRegionOrLine() {
  const s = getSelection();
  if (s.isCollapsed) selectLine();
  snapshot();
  try { await navigator.clipboard.writeText(s.toString()); } catch (e) { /* clipboard refused */ }
  selRange().deleteContents();
  markEditedSoon();
}
function deleteLine() { snapshot(); selectLine(); selRange().deleteContents(); markEditedSoon(); }
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
  if (!$('#external').hidden) { $('#external-later').click(); return; }
  if (!$('#openbox').hidden) { $('#open-cancel').click(); return; }
  if (!$('#historybox').hidden) { $('#historybox').hidden = true; return; }
  if (!$('#palette').hidden) { closePalette(); return; }
  if (!$('#keysbox').hidden) { RECORDING = null; $('#keysbox').hidden = true; return; }
  if (!$('#paperbox').hidden) { $('#md-close').click(); return; }
  if (!$('#figview').hidden) { closeFigure(); return; }
  if (!$('#drawer').hidden) { closeDrawer(); return; }
  if (!$('#findbar').hidden) { closeFind(); return; }
  if (!$('#helpbox').hidden) { $('#helpbox').hidden = true; return; }
  if (!$('#menu').hidden) $('#menu').hidden = true;
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
  if (inField && !['C-s', 'C-S', 'C-f', 'Escape'].includes(k)) return;   // a field keeps its own keys (undo)
  if (GLOBAL_KEYS[k]) { e.preventDefault(); GLOBAL_KEYS[k](); return; }
  const inText = e.target.isContentEditable && segOf(e.target);
  if (!inText) return;
  const sel = getSelection();
  if (spansEditables() && ((e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) ||
      ['Enter', 'Backspace', 'Delete', 'Tab'].includes(e.key))) {
    e.preventDefault();
    banner(ACROSS);
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
  if (!$('#external').hidden && 'robl'.includes(e.key)) {
    e.preventDefault();
    ({ r: $('#external-reload'), o: $('#external-overwrite'), b: $('#external-backup'), l: $('#external-later') })[e.key].click();
  } else if (!$('#openbox').hidden && e.key === 'Enter') {
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
  if (!PAL.savedRange) { banner('Put the cursor in the text first.'); return; }
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

const FIND = { matches: [], cur: -1 };

function findRegex() {
  const q = $('#find-q').value;
  if (!q) return null;
  let src = $('#find-re').checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if ($('#find-word').checked) src = '\\b(?:' + src + ')\\b';
  try { return new RegExp(src, $('#find-case').checked ? 'g' : 'gi'); } catch (e) { return null; }
}

// The searchable text of each block: its text nodes, with a tie (~) and a
// line break counted as a space, so that a match may cross them.
function searchMaps() {
  const maps = [];
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

function runFind(keepIndex) {
  const re = findRegex();
  FIND.matches = [];
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

function paintFind(scroll) {
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
  if (window.CSS && CSS.highlights) { CSS.highlights.delete('find'); CSS.highlights.delete('findcur'); }
}

for (const id of ['#find-q', '#find-re', '#find-case', '#find-word']) $(id).addEventListener('input', () => runFind());
for (const id of ['#find-q', '#find-r']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (id === '#find-r' && (e.ctrlKey || e.altKey)) replaceAllMatches(); else if (id === '#find-r') replaceOne(); else stepFind(e.shiftKey ? -1 : 1); }
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
  const b = document.getElementById('cbmode');
  if (b) b.addEventListener('click', () => { setColourBlind(!document.documentElement.dataset.cb); toast(document.documentElement.dataset.cb ? 'Colour-blind palette on' : 'Colour-blind palette off'); });
  let on = false;
  try { on = localStorage.getItem('colourblind') === '1'; } catch (e) { /* storage unavailable */ }
  setColourBlind(on);
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
  undo, redo,
};
// Edits from the toolbar (and their keys) say what they did, or that there
// was nothing to do: the page changing is the only other sign.
let DOC_CHANGES = 0;
new MutationObserver(() => { DOC_CHANGES++; }).observe($('#doc'), { childList: true, subtree: true, characterData: true });
const SAID = { bold: 'Bold', emph: 'Emphasis', math: 'Inline maths', display: 'Displayed equation', section: 'Section heading',
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

const DIFF = { on: false, marks: [], cur: -1 };

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

function renderWordDiff(oldSrc, newSrc, into) {
  const ops = lcs(diffUnits(oldSrc), diffUnits(newSrc), (x, y) => x.key === y.key);
  into.textContent = '';
  if (!ops) { // too large to diff word by word
    const d = el('span', 'd-del'); renderTokens(L.tokenize(oldSrc), d, {});
    const n = el('span', 'd-ins'); renderTokens(L.tokenize(newSrc), n, {});
    into.append(d, n);
    return;
  }
  for (const [op, a, b] of ops) {
    const u = op === '-' ? a : b;
    const target = op === '=' ? into : el('span', op === '-' ? 'd-del' : 'd-ins');
    renderTokens([u.tok], target, {});
    if (op !== '=') into.append(target);
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
  head.append(revert);
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

async function diffOn() {
  commit();
  const ref = $('#diffbase').value;
  DIFF.marks = [];
  document.body.classList.add('diffing');
  DIFF_SHOWN = true;
  for (const e of document.querySelectorAll('#doc [contenteditable="true"]')) e.contentEditable = 'false';
  for (const ta of document.querySelectorAll('#doc textarea')) ta.readOnly = true;
  const names = Object.keys(FILES).filter((n) => FILES[n].segs);
  let changedFiles = 0;
  for (const name of names) {
    // Last save is the editor's disk snapshot; Git HEAD is fetched separately.
    let base;
    if (ref === 'save') base = FILES[name].disk;
    else {
      const r = await fetch(`/api/baseline?name=${encodeURIComponent(name)}&ref=${ref}`);
      base = r.ok ? (await r.json()).text : null;
    }
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
      for (const b of ins) {
        const k = dels.findIndex((d) => d.kind === b.kind);
        if (k >= 0) {
          const d = dels.splice(k, 1)[0];
          b.el.classList.add('diff-changed');
          const target = b.edit && b.edit.tagName !== 'TEXTAREA' ? b.edit : null;
          if (target) renderWordDiff(contentOf(d, d.src), contentOf(b, now.get(b)), target);
          DIFF.marks.push(b.el);
        } else { b.el.classList.add('diff-new'); DIFF.marks.push(b.el); }
      }
      for (const d of dels) {   // deleted blocks, shown where they were
        const ghost = renderSeg({ ...d }, { sec: 0, sub: 0, subsub: 0, app: false, counters: {}, heads: {}, env: [] });
        if (!ghost) continue;
        ghost.classList.add('diff-gone', 'diff-ghost');
        for (const e of ghost.querySelectorAll('[contenteditable]')) e.contentEditable = 'false';
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(ghost, anchor);
        else if (cur.length && cur[cur.length - 1].el) cur[cur.length - 1].el.after(ghost);
        DIFF.marks.push(ghost);
      }
      i = j - 1;
    }
  }
  DIFF.marks.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  DIFF.cur = -1;
  fillDiffMap();
  $('#diffnav').hidden = false;
  $('#diffcount').textContent = DIFF.marks.length ? `${DIFF.marks.length} changes` : 'no changes';
  banner(DIFF.marks.length ? `${DIFF.marks.length} changed blocks in ${changedFiles} file(s), compared with ${ref === 'save' ? 'the last save' : 'the last commit'}. The page is read-only until you leave diff mode.`
    : 'No changes.');
}

function diffOff() {
  DIFF.on = false;
  $('#diffmap').hidden = true;
  document.body.classList.remove('diffing');
  $('#diffnav').hidden = true;
  $('#diffbase').hidden = true;
  $('#diffbtn').setAttribute('aria-pressed', 'false');
  $('#diffbtn').title = 'Show what changed, Ctrl+Alt+V (read-only while on)';
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
  e.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#diffcount').textContent = `${DIFF.cur + 1} of ${DIFF.marks.length}`;
  updateDiffMap();
}

ACTIONS.diff = () => {
  if (DIFF.on) return diffOff();
  DIFF.on = true;
  $('#diffbtn').setAttribute('aria-pressed', 'true');
  $('#diffbtn').title = 'Leave the diff view (Ctrl+Alt+V)';
  $('#diffbase').hidden = false;
  diffOn();
};
$('#diffbase').onchange = () => { if (DIFF.on) { const y = viewAnchor(); render(); restoreAnchor(y); DIFF.on = true; diffOn(); } };
$('#diffprev').onclick = () => diffStep(-1);
$('#diffnext').onclick = () => diffStep(1);
// no editing while diffing
document.addEventListener('beforeinput', (e) => { if (DIFF.on) e.preventDefault(); }, true);
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
      renderTokens(L.tokenize(mark ? mark[2] : l.content), text, {});
      body.append(text);
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
  g.lines.forEach((l, li) => {
    if (g.kind === 'proc') { box.append(procLine(g, l, li)); return; }
    // the empty lines a body starts and ends with (\begin{...}\n ... \n\end): not shown
    if (l.raw && !l.prefix.trim() && (li === 0 || li === g.lines.length - 1)) return;
    if (BLOCK_CLOSE.has(l.cmd) || l.cmd === 'ElsIf' || l.cmd === 'Else') depth = Math.max(0, depth - 1);
    // numbered as in the paper: \Statex and comments get no number
    box.append(algoLine(g, l, li, depth, l.raw || l.cmd === 'Statex' ? '' : String(++no)));
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
  body.append(el('p', 'small', 'Add: insert common statements, conditions and loops. Up/Down or Alt+Up/Down: reorder safe statements. ' +
    'Mark: coloured xcolor boxes. Ctrl+Z/Ctrl+Shift+Z: undo/redo; Ctrl+Enter: Apply; Ctrl+S: Apply and Save. ' +
    'Changes are not written until Apply, then Save.'));
}

function gameMoveLine(g, index, offset) {
  const line = g.lines[index];
  let otherIndex = index + offset;
  while (g.lines[otherIndex] && g.lines[otherIndex].raw && !g.lines[otherIndex].prefix.trim())
    otherIndex += offset;
  const other = g.lines[otherIndex];
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
  return true;
}

function algoLine(g, l, li, depth, no = String(li + 1)) {
  const row = el('div', 'gline');
  row.dataset.game = String(FV.games.indexOf(g)); row.dataset.line = String(li);
  row.append(el('span', 'gno', no));
  const pad = el('span'); pad.style.width = (depth * 1.4) + 'em'; pad.style.flex = 'none';
  row.append(pad);
  if (l.raw) {
    row.append(el('code', 'gcomment', l.prefix.trim() || ' '));
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
    if (/\\Comment/.test(l.suffix)) {
      const c = /\\Comment\s*\{([^]*)\}/.exec(l.suffix);
      row.append(el('span', 'gcomment', '▹ ' + (c ? cleanTex(c[1]) : '')));
    }
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
  const del = el('button', '', 'Delete'); del.title = 'Delete this line; Undo restores it';
  del.onclick = () => { gameCheckpoint(); g.lines.splice(li, 1); showFigTab('games'); };
  tools.append(addChoice, add, up, down, mark, del);
  row.append(tools);
  return row;
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
  gameMoveLine(game, +row.dataset.line, e.key === 'ArrowUp' ? -1 : 1);
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
    const s = caretSeg();
    if (s) addMenu(s, s.el || s.edit); else toast('Put the cursor in the text first', 'error');
  }],
  ['delblock', 'Delete the heading at the cursor', 'text', ['C-M-x'], () => {
    const s = headingSegAtCaret();
    if (s && confirm('Delete this heading?' + labelWarning(s))) structural(() => removeSeg(s));
  }],
  ['moveup', 'Move the section at the cursor up', 'text', ['C-M-ArrowUp'], () => { const s = headingSegAtCaret(); if (s) moveSection(s, -1); }],
  ['movedown', 'Move the section at the cursor down', 'text', ['C-M-ArrowDown'], () => { const s = headingSegAtCaret(); if (s) moveSection(s, 1); }],
  ['combine', 'Combine the section at the cursor with the previous one', 'text', ['C-M-j'], () => {
    const s = headingSegAtCaret();
    if (s && confirm('Combine this section with the previous one?' + labelWarning(s))) structural(() => removeSeg(s));
  }],
  ['revertblock', 'Revert the block at the cursor to the last save', 'text', ['C-M-Backspace'], () => {
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
  ['linestart', 'Start of line', 'text', ['C-a'], () => getSelection().modify('move', 'backward', 'lineboundary')],
  ['lineend', 'End of line', 'text', ['C-e'], () => getSelection().modify('move', 'forward', 'lineboundary')],
  ['selstart', 'Select to start of line', 'text', ['C-A'], () => getSelection().modify('extend', 'backward', 'lineboundary')],
  ['selend', 'Select to end of line', 'text', ['C-E'], () => getSelection().modify('extend', 'forward', 'lineboundary')],
  ['deleteline', 'Delete the line', 'text', ['C-d'], () => deleteLine()],
  ['cut', 'Cut the region, or the line', 'text', ['M-w'], () => cutRegionOrLine()],
  ['duplicate', 'Duplicate the region, or the line', 'text', ['C-p'], () => duplicate()],
  ['expand', 'Expand the selection', 'text', ['C-+', 'C-='], () => expandRegion()],
  // the chrome: every button of the bars and the ☰ menu has a key too
  ['menu', 'Open or close the ☰ menu', 'global', ['C-M-m'], () => $('#menubtn').click()],
  ['open', 'Open a paper directory…', 'global', ['C-M-o'], () => $('#openbtn').click()],
  ['history', 'Save history…', 'global', ['C-M-t'], () => $('#historybtn').click()],
  ['reload', 'Reload the document from disk', 'global', ['C-M-l'], () => $('#reloadbtn').click()],
  ['build', 'Build the PDF now', 'global', ['C-M-b'], () => $('#rebuildbtn').click()],
  ['cleanbuild', 'Clean build (set the .aux, .bbl aside first)', 'global', ['C-M-B'], () => $('#cleanbtn').click()],
  ['pdf', 'Open the rendered PDF', 'global', ['C-M-d'], () => $('#pdfbtn').click()],
  ['paper', 'Paper metadata and conversion…', 'global', ['C-M-p'], () => $('#paperbtn').click()],
  ['keys', 'Keyboard shortcuts…', 'global', ['C-M-,'], () => $('#keysbtn').click()],
  ['help', 'Help', 'global', ['C-M-h'], () => $('#help').click()],
  ['theme', 'Colour scheme: auto, light, dark', 'global', ['C-M-g'], () => $('#theme').click()],
  ['cols', 'One or two columns', 'global', ['C-M-w'], () => $('#cols').click()],
  ['textsmaller', 'Smaller paper text', 'global', ['C-M--'], () => $('#textsmaller').click()],
  ['textbigger', 'Larger paper text', 'global', ['C-M-='], () => $('#textbigger').click()],
  ['textreset', 'Reset the paper text size', 'global', ['C-M-0'], () => $('#textsize').click()],
  ['diff', 'Show or leave the diff of what changed', 'global', ['C-M-v'], () => ACTIONS.diff()],
  ['diffprev', 'Previous change in the diff', 'global', ['C-M-['], () => { if (DIFF.on) $('#diffprev').click(); }],
  ['diffnext', 'Next change in the diff', 'global', ['C-M-]'], () => { if (DIFF.on) $('#diffnext').click(); }],
  ['ttsopts', 'Reading speed and voice', 'global', ['C-M-u'], () => $('#ttsopts').click()],
];

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
  for (const [id, , scope, defaults, fn] of ACTION_DEFS) {
    for (const key of USER_KEYS[id] || defaults) (scope === 'global' ? GLOBAL_KEYS : TEXT_KEYS)[key] = fn;
  }
}
fetch('/api/keys').then((r) => r.json()).then((k) => { USER_KEYS = k || {}; applyKeymap(); }).catch(applyKeymap);

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
  const used = {};
  for (const [id, , , d] of ACTION_DEFS) for (const k of current(id, d)) (used[k] = used[k] || []).push(id);
  for (const [id, label, , d] of ACTION_DEFS) {
    const keys = current(id, d);
    const row = el('div', 'keyrow');
    if (keys.some((k) => used[k].length > 1)) row.classList.add('conflict');
    if (RECORDING === id) row.classList.add('recording');
    row.append(el('span', '', label));
    const ks = el('span', 'keys');
    if (RECORDING === id) ks.textContent = 'press a key…';
    else keys.forEach((k) => ks.append(el('kbd', '', prettyKey(k))));
    const ch = el('button', '', 'Change');
    ch.onclick = () => { RECORDING = id; drawKeys(); };
    row.append(ks, ch);
    list.append(row);
  }
}
document.addEventListener('keydown', (e) => {
  if (!RECORDING) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  if (e.key !== 'Escape') KEYS_DRAFT[RECORDING] = [keyName(e)];
  RECORDING = null;
  drawKeys();
}, true);
$('#keysbtn').onclick = openKeys;
$('#keys-close').onclick = () => { RECORDING = null; $('#keysbox').hidden = true; };
$('#keys-reset').onclick = () => { KEYS_DRAFT = {}; drawKeys(); };
$('#keys-save').onclick = async () => {
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
$('#history-delete').onclick = () => deleteHistory(false);
$('#history-clear').onclick = () => deleteHistory(true);
$('#history-close').onclick = () => { $('#historybox').hidden = true; };

// ======================================================= main switcher

let OPEN_PROJECT = null;

async function chooseProjectDirectory() {
  const r = await fetch('/api/pick-directory', { method: 'POST', headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' }, body: '{}' });
  if (r.status === 204) return;
  if (!r.ok) { banner('Could not choose a paper directory.'); return; }
  const picked = await r.json();
  if (!picked.mains.length) { banner('That directory contains no main LaTeX documents.'); return; }
  OPEN_PROJECT = picked;
  $('#open-path').textContent = picked.path;
  const select = $('#open-main');
  select.textContent = '';
  for (const main of picked.mains) select.append(new Option(main, main));
  $('#openbox').hidden = false;
  select.focus();
}

async function openSelectedProject() {
  if (!OPEN_PROJECT) return;
  if (editedFiles().length && !confirm('You have unsaved edits; opening another paper discards them. Continue?')) return;
  const r = await fetch('/api/open-project', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify({ path: OPEN_PROJECT.path, main: $('#open-main').value }) });
  if (!r.ok) { banner('Could not open it: ' + (await r.json()).error); return; }
  $('#openbox').hidden = true;
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
  sel.hidden = mains.length < 2;
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
