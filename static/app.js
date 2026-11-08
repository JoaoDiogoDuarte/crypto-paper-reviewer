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

let DOC = null;          // payload of /api/doc: files, aux, macros, bib, figs
const FILES = {};        // name -> { text, base (hash on disk), disk (text on disk), segs }
let ORDER = [];          // display order: segments, each with .file and .el
let lastTyping = 0;
// The diff view rewrites the editable blocks with its own marks: while it is
// shown, the page is not the document, and nothing may read it back.
let DIFF_SHOWN = false;

// ---------------------------------------------------------------- loading

// Read the document from the server and render it.  Unsaved edits are kept,
// file by file, unless the file is in `discard`: a file edited here keeps its
// old base hash, so that saving it after it changed on disk is refused (and
// asks) instead of overwriting the other version.
async function load(keepScroll, discard = []) {
  const y = window.scrollY;
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
  if (keepScroll) window.scrollTo(0, y);
  setBuild(DOC.build);
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
    for (const s of L.segment(t)) segs.push({ ...s, file: name });
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
  DIFF_SHOWN = false;
  const speech = typeof TTS !== 'undefined' ? TTS.capture() : null;
  if (typeof TTS !== 'undefined') TTS.reset();
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
    document.title = h.textContent + ' — editor';
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
  if (speech) TTS.restore(speech);
}

// Pages: from SyncTeX (the page each source line went to), or estimated from
// the amount of text per page for the class.  Each page is its own box, so in
// two columns typing rebalances one page, not the whole paper.
const CHARS_PER_PAGE = { IEEEtran: 6500, llncs: 2700, iacrcc: 3000, acmart: 6000, article: 3300 };
function layoutPages(doc) {
  const exact = DOC.pages && Object.keys(DOC.pages).length > 0;
  const cls = (DOC.docclass || 'article').split('/')[0];
  const twoCol = cls === 'IEEEtran' || /twocolumn/.test(DOC.docclass || '');
  const perPage = CHARS_PER_PAGE[cls] || 3300;
  let page = 1, chars = 0, last = 0, box = null;
  const startPage = (n) => {
    box = el('section', 'page');
    box.dataset.page = n;
    box.append(el('div', 'pagemark', (exact ? 'page ' : '≈ page ') + n));
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
    if (!box || page !== last) { startPage(page); last = page; }
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
  plus.title = 'Add after this block';
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
  const del = el('button', '', '✕');
  del.title = 'Delete this heading (keeps the text under it)';
  del.onclick = (e) => { e.stopPropagation(); if (confirm('Delete this heading?')) structural(() => removeSeg(seg)); };
  const up = el('button', '', '↑');
  up.title = 'Move this section up';
  up.onclick = (e) => { e.stopPropagation(); moveSection(seg, -1); };
  const down = el('button', '', '↓');
  down.title = 'Move this section down';
  down.onclick = (e) => { e.stopPropagation(); moveSection(seg, 1); };
  const merge = el('button', '', '⇐');
  merge.title = 'Combine this section with the previous one';
  merge.onclick = (e) => { e.stopPropagation(); if (confirm('Combine this section with the previous one?')) structural(() => removeSeg(seg)); };
  return wrapSeg(seg, node, [up, down, merge, del]);
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
        renderTokens(L.tokenize(cell.content), td, {});
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
    else box.append(el('div', 'small', '(figure image is being rendered, or the source changed; it appears after the next build)'));
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
function renderTokens(toks, parent, ctx) {
  toks.forEach((tok, i) => {
    if (tok.t !== 'env' || tok.mode !== 'begin') return;
    for (let k = i + 1; k < toks.length && k < i + 4; k++) {
      if (toks[k].t === 'cmd' && toks[k].name === 'label') { tok.label = (/\{([^}]*)\}/.exec(toks[k].s) || [])[1]; break; }
      if (toks[k].t !== 'nl' && toks[k].t !== 'comment') break;
    }
  });
  for (const tok of toks) {
    if (tok.t === 'text') { parent.append(document.createTextNode(L.decodeText(tok.s))); continue; }
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
  'Needspace', 'raggedbottom', 'balance', 'IEEEauthorblockN', 'IEEEauthorblockA', 'leavevmode']);

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
  if (name === 'cite') {
    const nums = arg().split(',').map((k) => (DOC.aux.cites[k.trim()] || '?'));
    const c = chip('cite', tok.s, '[' + nums.join(', ') + ']');
    c.title = arg().split(',').map((k) => DOC.bib[k.trim()] || k).join('\n\n').replace(/\\[a-zA-Z]+|[{}]/g, '');
    return c;
  }
  if (name === 'ec' || name === 'texttt' || name === 'url' || name === 'nolinkurl') return chip('ec', tok.s, arg());
  if (name === 'appendices' || name === 'appendix') { ctx.app = true; ctx.sec = 0; return chip('runin', tok.s, 'Appendices'); }
  if (name === 'bibliography') return refList(tok.s);
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
  if (Object.prototype.hasOwnProperty.call(accents, name) && arg().length === 1)
    return chip('char', tok.s, (arg() + accents[name]).normalize('NFC'));
  // a macro of the document used in text: show it typeset when its body is
  // maths (\ensuremath{...}, \mathsf{...}, \mathcal...)
  const body = DOC.macros['\\' + name];
  if (body !== undefined && /^\s*(\\ensuremath|\\math[a-z]+|\\operatorname|\\textsc)/.test(body)) {
    const c = chip('math macro', tok.s);
    typesetInto('$' + tok.s + '$', c, false);
    if (!c.classList.contains('bad')) return c;
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
      return chip('thmhead', tok.s, `${th.name}${n ? ' ' + n : ''}${tok.opt ? ' (' + tok.opt + ')' : ''}. `);
    }
    if (tok.env === 'proof') return chip('runin', tok.s, (tok.opt || 'Proof') + '. ');
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
  '\\protect': '', '\\nobreak': '', '\\allowbreak': '' };
const katexMacros = () => ({ ...KATEX_SHIMS, ...DOC.macros });
function typesetInto(src, node, display) {
  let [body, disp] = mathBody(src);
  body = body.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '');
  // KaTeX cannot parse amsmath's multline/multline* directly.  A display
  // aligned environment handles line breaks, alignment marks and spacing.
    if (node.classList.contains('bad')) node.title = 'Math preview unsupported by KaTeX: ' + node.textContent;
    else node.removeAttribute('title');
  // Only the preview changes; data-src always remains the original LaTeX.
  body = body.replace(/\\begin\{multline\*?\}/g, '\\begin{aligned}')
    .replace(/\\end\{multline\*?\}/g, '\\end{aligned}')
    node.title = 'Math preview error: ' + e.message;
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
  } catch (e) {
    node.textContent = src;
    node.classList.add('bad');
  }
}

function renderMathless(src, node) { renderTokens(L.tokenize(src), node, {}); }

function refList(src) {
  const c = chip('', src);
  c.style.display = 'block';
  const h = el('h2', '', 'References');
  const ol = el('ul', 'refs');
  const keys = Object.entries(DOC.aux.cites).sort((a, b) => a[1] - b[1]);
  for (const [k, n] of keys) {
    const li = el('li');
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
let KEEP_UNICODE = '';
let HOUSE_RULE_CHANGES = [];
function ser(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) {
      let t = L.encodeText(n.data);
      t = KEEP_UNICODE ? t.replace(/[\u2013\u2014\u2018\u2019\u201c\u201d\u2026]/g, (c) => (KEEP_UNICODE.includes(c) ? c : L.typeset(c))) : L.typeset(t);
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
  const fix = (text, original) => {
    if (!applyRules || text === original) return text;
    const [t, w] = L.houseRules(text, (DOC.config || {}).house_rules, original);
    if (t !== text && changes) changes.push(seg);
    warnings.push(...w);
    return t;
  };
  switch (seg.kind) {
    case 'para': return seg.edit ? fix(ser(seg.edit), seg.src) : seg.src;
    case 'heading': {
      if (!seg.edit || !seg.parts) return seg.src;
      return seg.parts.prefix + fix(ser(seg.edit), seg.parts.title) + seg.parts.suffix;
    }
    case 'code': return seg.edit && seg.touched ? seg.parts.pre + seg.edit.value + seg.parts.post : seg.src;
    case 'figure': case 'table':
      if (!seg.edit || !seg.parts) return seg.figSrc || seg.src;
      return seg.parts.prefix + fix(ser(seg.edit), seg.parts.caption) + seg.parts.suffix;
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
  commit();
  // every segment of every file takes its current source first, so that the
  // texts rebuilt below keep the edits of files the change does not touch
  for (const f of Object.values(FILES)) if (f.segs) f.segs.forEach((s) => { s.src = segSource(s, []); });
  const focus = change();
  for (const f of Object.values(FILES)) if (f.segs) f.text = f.segs.map((s) => s.removed ? '' : s.src).join('');
  render();
  if (focus) focusPlaceholder(focus);
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

function insertAfter(seg, src) {
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

function focusPlaceholder(text) {
  for (const seg of ORDER) {
    if (!seg.edit || seg.edit.tagName === 'TEXTAREA') continue;
    const walker = document.createTreeWalker(seg.edit, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.data.indexOf(text);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + text.length);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        seg.edit.focus();
        seg.el.scrollIntoView({ block: 'center' });
        return;
      }
    }
  }
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
  preview();
  ta.focus();
  const [body] = mathBody(ta.value);
  if (/^\s*x?\s*$/.test(body)) { // a new formula: put the cursor inside it
    const i = ta.value.indexOf(body) + body.length - (body.endsWith(' ') ? 1 : 0);
    ta.setSelectionRange(i, i);
  }
}

function preview() {
  const src = $('#drawer-src').value;
  const p = $('#drawer-preview');
  p.textContent = '';
  renderTokens(L.tokenize(src), p, {});
}

function applyDrawer(remove) {
  if (!drawerChip) return closeDrawer(true);
  if (drawerChip.isConnected) snapshot();
  const src = $('#drawer-src').value;
  if (remove || !src.trim()) {
    if (drawerFresh) closeDrawer(false);      // with its line breaks
    else { drawerChip.remove(); closeDrawer(true); }
  } else {
    const frag = document.createDocumentFragment();
    renderTokens(L.tokenize(src), frag, {});
    const last = frag.lastChild;
    drawerChip.replaceWith(frag);
    if (last && last.isConnected && editableAt(selRange())) setCaretAfter(last);
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
doc.addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c || c.classList.contains('nl') || c.classList.contains('tie') || c.classList.contains('parbreak')) return;
  if (c.closest('.refs')) return;
  e.preventDefault();
  openDrawer(c, null, c.classList.contains('math') ? 'Edit maths' : 'Edit LaTeX');
});

doc.addEventListener('input', () => { lastTyping = Date.now(); markEditedSoon(); });
let markTimer = null;
function markEditedSoon() { clearTimeout(markTimer); markTimer = setTimeout(markEdited, 400); }

/* key handling: see the keymap section below */

// Copy, cut and paste.  A copy from the page carries its LaTeX (in a type of
// its own) and a plain text in which formulas are $...$, so that pasting it
// back, here or from anywhere else, gives formulas again.
const LATEX_MIME = 'application/x-paper-editor-latex';

// Plain text: formulas between dollars ($...$, $$...$$, \(...\), \[...\])
// become formulas; everything else is text.  A $ is a dollar sign unless it
// opens and closes a formula: no space just inside, no digit right after
// the closing one (so "5$ or 10$" stays text); \$ is a dollar sign.
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
  KEEP_UNICODE = '';
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
  const two = document.body.classList.toggle('two');
  $('#cols').textContent = two ? 'One column' : 'Two columns';
  try { localStorage.setItem('cols', two ? '2' : '1'); } catch (e) { /* storage unavailable */ }
};
try { if (localStorage.getItem('cols') === '2') $('#cols').click(); } catch (e) { /* storage unavailable */ }
$('#help').onclick = () => { $('#helpbox').hidden = false; };
$('#save').onclick = () => save();
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
  if (!files.length) { setBuild({ state: 'idle', message: 'nothing to save' }); return; }
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
    const y = window.scrollY;
    const caret = captureEditorState();
    render();
    restoreEditorState(caret);
    window.scrollTo(0, y);
  } else {
    for (const seg of ORDER) if (seg.touched) { seg.src = segSource(seg, [], null, apply); seg.touched = false; }
    markEdited();
  }
  if (saved) setBuild({ state: 'running', message: 'saved; rebuilding PDF' });
  if (warnings.length && saved) banner('Saved. House rules: ' + [...new Set(warnings)].join('; '));
  if (conflicts.length) showExternal(conflicts, true);
  // a new \input names a file the page has not read yet
  if (saved && Object.values(FILES).some((f) => (f.segs || []).some((s) => s.kind === 'input' && !s.removed && !s.input))) {
    await load(true);
  }
}

// Leaving the page (closing the tab, reloading) with unsaved edits asks first.
window.addEventListener('beforeunload', (e) => {
  if (!DOC) return;
  let edited = false;
  try { edited = editedFiles().length > 0; } catch (err) { edited = false; }
  if (edited || SAVING) { e.preventDefault(); e.returnValue = ''; }
});

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
async function poll() {
  try {
    const s = SAVING ? null : await (await fetch('/api/state')).json();
    if (s && !SAVING) {
      setBuild(s.build);
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
    }
  } catch (e) { /* server restarting */ }
  setTimeout(poll, 2000);
}

// -------------------------------------------------------------- speech

const TTS = (() => {
  let queue = [], idx = 0, speaking = false, paused = false, current = null, audio = null, prefetched = null;
  let anchor = null;
  let generation = 0;
  const synth = window.speechSynthesis;
  const voiceSel = $('#voice');
  const positionKey = () => 'paper-editor:tts:' + location.pathname + ':' + (DOC && DOC.main || '');

  function setState(state) { $('#tts-state').textContent = state; }
  function updateControls() {
    $('#pause').disabled = !speaking;
    $('#stop').disabled = !speaking;
    $('#pause').setAttribute('aria-pressed', String(paused));
  }
  function savePosition(item) {
    try { localStorage.setItem(positionKey(), JSON.stringify({ file: item.seg.file, src: item.seg.src, text: item.text })); }
    catch (e) { /* storage unavailable */ }
  }
  function savedPosition() {
    try { return JSON.parse(localStorage.getItem(positionKey()) || 'null'); }
    catch (e) { return null; }
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
  voiceSel.onchange = () => { try { localStorage.setItem('voice', voiceSel.value); } catch (e) { /* none */ } };

  function startSeg() {
    const sel = getSelection();
    if (sel.rangeCount) {
      const n = sel.getRangeAt(0).startContainer;
      const seg = segOf(n.nodeType === 1 ? n : n.parentElement);
      if (seg) return ORDER.indexOf(seg);
    }
    // otherwise the first block on screen
    for (let i = 0; i < ORDER.length; i++) {
      const e = ORDER[i].el;
      if (e && e.getBoundingClientRect().bottom > 60) return i;
    }
    return 0;
  }

  function build(from) {
    const q = [];
    for (let i = from; i < ORDER.length; i++) {
      const seg = ORDER[i];
      if (!seg.el || seg.removed) continue;
      const node = seg.kind === 'para' ? (seg.edit.classList.contains('quiet') ? null : seg.edit)
        : (seg.kind === 'heading' || seg.kind === 'figure' || seg.kind === 'table') ? seg.edit : null;
      if (!node) continue;
      const map = speechMap(node);
      for (const [a, b] of phraseBounds(map.text)) {
        q.push({ seg, text: map.text.slice(a, b), range: () => rangeFor(map, a, b) });
      }
    }
    return q;
  }

  function prepareQueue() {
    if (anchor) {
      const queue = build(ORDER.indexOf(anchor.seg));
      let index = queue.findIndex((item) => item.seg === anchor.seg && rangeContainsCaret(item.range(), anchor.range));
      if (index < 0) index = 0;
      return { queue, index };
    }
    const saved = savedPosition();
    if (saved) {
      const candidates = ORDER.filter((item) => item.file === saved.file && !item.removed);
      for (const seg of candidates) {
        const queue = build(ORDER.indexOf(seg));
        const index = queue.findIndex((item) => item.seg === seg && item.text === saved.text);
        if (index >= 0) return { queue, index };
        const fragment = saved.text.trim().slice(0, 60);
        if (fragment.length >= 20) {
          const fuzzy = queue.findIndex((item) => item.seg === seg && item.text.includes(fragment));
          if (fuzzy >= 0) return { queue, index: fuzzy };
        }
      }
    }
    return { queue: build(startSeg()), index: 0 };
  }

  function play() {
    stop();
    if (!voiceSel.value) { banner('No text-to-speech voice is available. See the README of the editor for how to install one.'); return; }
    ({ queue, index: idx } = prepareQueue());
    speaking = true; paused = false;
    updateControls();
    next();
  }

  function jump(delta) {
    if (!queue.length) {
      ({ queue, index: idx } = prepareQueue());
    }
    const target = Math.max(0, Math.min(queue.length - 1, (speaking ? idx - 1 : idx) + delta));
    stop();
    idx = target;
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
    if (!speaking || idx >= queue.length) { stop(); return; }
    const item = queue[idx++];
    savePosition(item);
    setState('Reading');
    highlight(item.seg);
    markPhrase(item.range());
    const rate = parseFloat($('#rate').value);
    const [engine, name] = voiceSel.value.split(/\|(.*)/s);
    if (engine !== 'browser') {
      // server audio: this phrase (prefetched when possible) and the next
      const url = (it) => `/api/tts?engine=${encodeURIComponent(engine)}&voice=${encodeURIComponent(name)}&text=${encodeURIComponent(it.text)}`;
      audio = prefetched && prefetched.src.endsWith(url(item).slice(1)) ? prefetched : new Audio(url(item));
      prefetched = idx < queue.length ? new Audio(url(queue[idx])) : null;
      if (prefetched) prefetched.preload = 'auto';
      audio.playbackRate = rate;
      audio.onended = () => next(run);
      audio.onerror = () => { if (run !== generation) return; banner('Speech failed for this voice; see the server output.'); next(run); };
      audio.play().catch(() => {});
      return;
    }
    const u = new SpeechSynthesisUtterance(item.text);
    const v = voices().find((x) => x.name === name);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = rate;
    u.onend = () => next(run);
    u.onerror = (e) => { if (run === generation && e.error !== 'interrupted' && e.error !== 'canceled') next(run); };
    synth.speak(u);
  }

  function stop() {
    generation++;
    speaking = false;
    paused = false;
    if (synth) synth.cancel();
    if (audio) { audio.pause(); audio = null; }
    prefetched = null;
    highlight(null);
    markPhrase(null);
    setState('Stopped');
    updateControls();
  }

  function pause() {
    if (!speaking) return;
    paused = !paused;
    setState(paused ? 'Paused' : 'Reading');
    if (audio) { if (paused) audio.pause(); else audio.play(); return; }
    if (paused) synth.pause(); else synth.resume();
  }

  function setAnchor(seg, range) { anchor = { seg, range: range.cloneRange() }; }

  function reset() { stop(); queue = []; idx = 0; anchor = null; setState('Ready'); }

  function capture() {
    const item = speaking && queue[idx - 1];
    return item ? { file: item.seg.file, src: item.seg.src, text: item.text, paused } : null;
  }

  function restore(state) {
    if (!state) return;
    const seg = ORDER.find((item) => item.file === state.file && !item.removed);
    if (!seg) return;
    queue = build(ORDER.indexOf(seg));
    idx = queue.findIndex((item) => item.seg === seg && item.text === state.text);
    if (idx < 0) idx = queue.findIndex((item) => item.seg === seg && item.text.includes(state.text.trim().slice(0, 60)));
    if (idx < 0) return;
    speaking = true; paused = false;
    next();
    if (state.paused) pause();
  }

  function testPrepare() {
    const prepared = prepareQueue();
    return { text: prepared.queue[prepared.index]?.text || null, index: prepared.index };
  }

  return { play, stop, pause, prev: () => jump(-1), next: () => jump(1), setAnchor, reset, capture, restore, fillVoices, loadServerVoices, build,
    testPrepare, testSavePosition: savePosition };
})();
$('#play').onclick = () => TTS.play();
$('#tts-prev').onclick = () => TTS.prev();
$('#tts-next').onclick = () => TTS.next();
$('#stop').onclick = () => TTS.stop();
$('#pause').onclick = () => TTS.pause();

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
      if (p.kind === 'text') r.setStart(p.node, Math.max(0, a - p.start)); else r.setStartBefore(p.node);
      started = true;
    }
    if (started && b <= p.end) {
      if (p.kind === 'text') r.setEnd(p.node, Math.max(0, b - p.start)); else r.setEndAfter(p.node);
      return r;
    }
  }
  return started ? r : null;
}

// Highlight the phrase being read (CSS Custom Highlight API) and keep it on
// screen.  Without the API, the block highlight remains.
function markPhrase(range) {
  if (window.CSS && CSS.highlights) {
    if (range) CSS.highlights.set('tts', new Highlight(range)); else CSS.highlights.delete('tts');
  }
  if (range) {
    const rect = range.getBoundingClientRect();
    if (rect.top < 80 || rect.bottom > window.innerHeight - 40) {
      window.scrollBy({ top: rect.top - window.innerHeight / 3, behavior: 'smooth' });
    }
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
    TTS.testSavePosition(target);
    TTS.reset();
    const resumed = TTS.testPrepare();
    if (resumed.text !== target.text) fail('saved position did not resume');
  }
  if (!$('#pause').disabled || !$('#stop').disabled) fail('idle controls are enabled');
  const key = 'paper-editor:tts:' + location.pathname + ':' + (DOC && DOC.main || '');
  try { localStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
  const msg = `READTEST ${failures.length ? 'FAILED' : 'OK'}: ${failures.length ? failures.join('; ') : 'caret, resume, controls'}`;
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
let typingSnap = null;
doc.addEventListener('beforeinput', () => {
  if (!typingSnap) snapshot();
  clearTimeout(typingSnap);
  typingSnap = setTimeout(() => { typingSnap = null; }, 1200);
});
function restore(from, to) {
  leaveDiff();
  commit();
  const cur = Object.fromEntries(Object.entries(FILES).map(([n, f]) => [n, f.text]));
  let texts = from.pop();
  while (texts && Object.keys(texts).every((n) => texts[n] === cur[n])) texts = from.pop();
  if (!texts) return;
  to.push(cur);
  for (const [n, t] of Object.entries(texts)) if (FILES[n]) FILES[n].text = t;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
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

// $ or Ctrl+M: the selection becomes inline maths; with no selection, a new
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
  if (insertNodes([c])) openDrawer(c, null, title, true);
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
  if (!$('#paperbox').hidden) { $('#paperbox').hidden = true; return; }
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
  '$': mathAtSelection,
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
  if (TEXT_KEYS[k]) { e.preventDefault(); TEXT_KEYS[k](); return; }
  // the browser's own bold, italic, underline would bypass the editor (and
  // keep working after the shortcut is moved to another key)
  if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[biu]$/i.test(e.key)) { e.preventDefault(); return; }
  const seg = segOf(e.target);
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (seg.kind === 'para') insertBreak();
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
  $('#palette').hidden = true; PAL.opts = null;
  clearTimeout(PAL.timer);
  if (PAL.abort) { PAL.abort.abort(); PAL.abort = null; }
}

function refreshPalette() {
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
    PAL.items = items; PAL.active = 0;
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
  const tray = () => {
    const t = $('#pal-tray');
    t.textContent = PAL.picked.length ? 'picked:' : '';
    PAL.picked.forEach((k) => t.append(el('span', 'key', k)));
  };
  const finish = () => {
    if (!PAL.picked.length) return;
    const src = '\\cite{' + PAL.picked.join(',') + '}';
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
      f.append('↑↓ choose · Enter insert · Ctrl+Enter pick several · ');
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
    if (scroll) {
      const b = r.getBoundingClientRect();
      if (b.top < 140 || b.bottom > innerHeight - 40) window.scrollBy({ top: b.top - innerHeight / 3 });
    }
  } else CSS.highlights.delete('findcur');
}

function stepFind(d) {
  if (!FIND.matches.length) return;
  FIND.cur = (FIND.cur + d + FIND.matches.length) % FIND.matches.length;
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
  if (!r) return;
  snapshot();
  replaceRange(r);
  markEditedSoon();
  runFind(true);
  paintFind(true);
}

function replaceAllMatches() {
  if (!FIND.matches.length) return;
  snapshot();
  const n = FIND.matches.length;
  // last to first, so earlier ranges stay valid
  for (const r of [...FIND.matches].reverse()) replaceRange(r);
  markEdited();
  runFind();
  banner(`Replaced ${n} occurrence${n === 1 ? '' : 's'}.`);
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
  $('#theme').textContent = { auto: 'Auto', light: 'Light', dark: 'Dark' }[t];
  try { localStorage.setItem('theme', t); } catch (e) { /* storage unavailable */ }
}
$('#theme').onclick = () => {
  const cur = document.documentElement.dataset.theme || 'auto';
  setTheme(THEMES[(THEMES.indexOf(cur) + 1) % 3]);
};
try { setTheme(localStorage.getItem('theme') || 'auto'); } catch (e) { setTheme('auto'); }

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
for (const b of document.querySelectorAll('#toolbar button')) {
  // keep the caret in the text when a button is pressed
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => ACTIONS[b.dataset.act]());
}
Object.assign(TEXT_KEYS, { 'C-M-c': citePalette, 'C-M-C': citePalette, 'C-M-r': refPalette, 'C-M-R': refPalette });
Object.assign(GLOBAL_KEYS, { 'C-f': () => openFind(false), 'C-h': () => openFind(true) });
delete TEXT_KEYS['C-R'];

// The toolbar and find bar stick below the header, whatever its height.
new ResizeObserver(() => {
  const h = $('#bar').offsetHeight;
  $('#toolbar').style.top = h + 'px';
  $('#findbar').style.top = (h + $('#toolbar').offsetHeight) + 'px';
}).observe($('#bar'));

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
    const r = await fetch(`/api/baseline?name=${encodeURIComponent(name)}&ref=${ref}`);
    const base = r.ok ? (await r.json()).text : null;
    const cur = FILES[name].segs.filter((sg) => sg.el && !sg.removed);
    if (base === null) { cur.forEach((sg) => { sg.el.classList.add('diff-new'); DIFF.marks.push(sg.el); }); changedFiles++; continue; }
    if (base === FILES[name].text) continue;
    changedFiles++;
    const old = parseFile(name, base).filter((sg) => !['gap', 'hidden', 'input'].includes(sg.kind));
    const ops = lcs(old, cur, (a, b) => a.src === b.src && a.kind === b.kind) ||
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
          if (target) renderWordDiff(contentOf(d, d.src), contentOf(b, b.src), target);
          DIFF.marks.push(b.el);
        } else { b.el.classList.add('diff-new'); DIFF.marks.push(b.el); }
      }
      for (const d of dels) {   // deleted blocks, shown where they were
        const ghost = renderSeg({ ...d }, {});
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
  $('#diffnav').hidden = false;
  $('#diffcount').textContent = DIFF.marks.length ? `${DIFF.marks.length} changes` : 'no changes';
  banner(DIFF.marks.length ? `${DIFF.marks.length} changed blocks in ${changedFiles} file(s), compared with ${ref === 'head' ? 'the last commit' : 'when the editor opened'}. The page is read-only until you leave diff mode.`
    : 'No changes.');
}

function diffOff() {
  DIFF.on = false;
  document.body.classList.remove('diffing');
  $('#diffnav').hidden = true;
  $('#diffbase').hidden = true;
  $('#diffbtn').textContent = 'Diff';
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
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
  e.classList.add('diff-current');
  e.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#diffcount').textContent = `${DIFF.cur + 1} of ${DIFF.marks.length}`;
}

ACTIONS.diff = () => {
  if (DIFF.on) return diffOff();
  DIFF.on = true;
  $('#diffbtn').textContent = 'Leave diff';
  $('#diffbase').hidden = false;
  diffOn();
};
$('#diffbase').onchange = () => { if (DIFF.on) { const y = scrollY; render(); scrollTo(0, y); DIFF.on = true; diffOn(); } };
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

const FV = { seg: null, src: '', tab: 'image', games: null };
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
  FV.src = segSource(seg, [], null, false);   // with any caption edit made since
  FV.games = parseGames(FV.src);
  FV.tables = L.parseTabulars(FV.src);
  $('#fv-title').textContent = (seg.kind === 'figure' ? 'Figure ' : 'Table ') + (seg.el.querySelector('.capnum')?.textContent || '');
  $('#fv-games-tab').hidden = !FV.games.length;
  $('#fv-cells-tab').hidden = !FV.tables.length;
  $('#figview').hidden = false;
  showFigTab(FV.games.length ? 'games' : FV.tables.length ? 'cells' : 'image');
}

function showFigTab(tab) {
  FV.tab = tab;
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
  }
}

function renderGames(body) {
  const grid = el('div', 'games-grid');
  FV.games.forEach((g, gi) => {
    const box = el('div', 'game' + (g.kind === 'proc' ? ' gproc' : ''));
    const head = el('div', 'game-title');
    if (g.title !== null) {
      const t = el('span'); t.contentEditable = 'true';
      renderTokens(L.tokenize(g.title), t, {});
      t.addEventListener('input', () => { g.newTitle = ser(t); });
      head.append(t);
    } else head.append(el('span', 'small', g.kind === 'proc' ? 'procedure' : g.env));
    box.append(head);
    let depth = 0;
    g.lines.forEach((l, li) => {
      if (g.kind === 'proc') { box.append(procLine(g, l, li)); return; }
      if (BLOCK_CLOSE.has(l.cmd) || l.cmd === 'ElsIf' || l.cmd === 'Else') depth = Math.max(0, depth - 1);
      box.append(algoLine(g, l, li, depth));
      if (BLOCK_OPEN.has(l.cmd) || l.cmd === 'ElsIf' || l.cmd === 'Else') depth++;
    });
    grid.append(box);
  });
  body.append(grid);
  body.append(el('p', 'small', 'Edit a line in place; ＋ adds a statement below, ⊕ an if-block, ✕ deletes. ' +
    'Lines you do not touch are kept exactly. Apply, then save, to write the file; the image updates after the build.'));
}

function algoLine(g, l, li, depth) {
  const row = el('div', 'gline');
  row.append(el('span', 'gno', String(li + 1)));
  const pad = el('span'); pad.style.width = (depth * 1.4) + 'em'; pad.style.flex = 'none';
  row.append(pad);
  if (l.raw) {
    row.append(el('code', 'gcomment', l.prefix.trim() || ' '));
  } else {
    if (KW[l.kind]) row.append(el('span', 'gkw', KW[l.kind]));
    const t = el('span', 'gtext'); t.contentEditable = 'true';
    renderTokens(L.tokenize(l.content), t, {});
    t.addEventListener('input', () => { l.content = ser(t); row.classList.add('edited'); });
    row.append(t);
    if (/\\Comment/.test(l.suffix)) {
      const c = /\\Comment\s*\{([^]*)\}/.exec(l.suffix);
      row.append(el('span', 'gcomment', '▹ ' + (c ? cleanTex(c[1]) : '')));
    }
  }
  const tools = el('span', 'gtools');
  const indentOf = (x) => /^\s*/.exec(x.prefix)[0];
  const add = (lines) => { g.lines.splice(li + 1, 0, ...lines.map(parseGameLine)); showFigTab('games'); };
  const inner = indentOf(l) + (BLOCK_OPEN.has(l.cmd) || l.cmd === 'Else' || l.cmd === 'ElsIf' ? '  ' : '');
  const b1 = el('button', '', '+'); b1.title = 'Add a statement below';
  b1.onclick = () => add([inner + '\\State $x \\gets y$']);
  const b2 = el('button', '', '⊕'); b2.title = 'Add an if-block below';
  b2.onclick = () => add([inner + '\\If{$c$}', inner + '  \\State $x \\gets y$', inner + '\\EndIf']);
  const b3 = el('button', '', '✕'); b3.title = 'Delete this line';
  b3.onclick = () => { g.lines.splice(li, 1); showFigTab('games'); };
  tools.append(b1, b2, b3);
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
  ta.oninput = () => { l.content = ta.value; show(); };
  show();
  const tools = el('div', 'gtools'); tools.style.opacity = 1;
  const b1 = el('button', '', '+ line'); b1.onclick = () => { g.lines.splice(li + 1, 0, { prefix: '', content: '', suffix: l.suffix || ' \\\\\n' }); if (!l.suffix) l.suffix = ' \\\\\n'; showFigTab('games'); };
  const b3 = el('button', '', '✕'); b3.onclick = () => { g.lines.splice(li, 1); showFigTab('games'); };
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
        td.addEventListener('input', () => { c.content = ser(td); td.classList.add('edited'); });
        tr.append(td);
      });
      for (let k = r.cells.length; k < ncols; k++) tr.append(el('td'));
      const tools = el('td', 'rowtools');
      const add = el('button', '', '＋ row'); add.title = 'Add an empty row below';
      add.onclick = () => {
        const nr = { lead: '', empty: false, rawRest: '', sep: r.sep || ' \\\\\n',
          cells: Array.from({ length: ncols }, (_, k) => ({ lead: k ? ' ' : '', content: '', trail: ' ' })) };
        if (!r.sep) r.sep = ' \\\\\n';
        t.rows.splice(ri + 1, 0, nr); showFigTab('cells');
      };
      const del = el('button', '', '✕'); del.title = 'Delete this row';
      del.onclick = () => { t.rows.splice(ri, 1); showFigTab('cells'); };
      tools.append(add, del);
      tr.append(tools);
      tbl.append(tr);
    });
    const col = el('button', '', '＋ column');
    col.title = 'Add a column at the right (the column spec gets the same type as the last column)';
    col.onclick = () => {
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
  const seg = FV.seg;
  const src = figureWithEdits();
  if (src === FV.src) { closeFigure(); return; }
  snapshot();
  seg.figSrc = src;
  seg.parts = L.captionParts(src) || { prefix: src, caption: '', suffix: '' };
  seg.touched = true;
  // the caption shown is the new caption, if it changed in the LaTeX
  if (seg.edit && seg.parts.caption !== undefined) { seg.edit.textContent = ''; renderTokens(L.tokenize(seg.parts.caption), seg.edit, {}); }
  markEdited();
  banner('Figure updated; save to write the file. The image updates after the build.');
  closeFigure();
}

function closeFigure() { $('#figview').hidden = true; FV.seg = null; FV.latexEdited = false; }

for (const b of document.querySelectorAll('.fv-tabs button')) b.onclick = () => showFigTab(b.dataset.tab);
$('#fv-apply').onclick = applyFigure;
$('#fv-close').onclick = closeFigure;
doc.addEventListener('dblclick', (e) => {
  const box = e.target.closest('.seg.figure, .seg.table');
  if (!box || e.target.closest('.caption')) return;
  e.preventDefault();
  openFigure(box.seg);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#figview').hidden) closeFigure(); });
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
  ['bold', 'Bold (\\textbf)', 'text', ['C-b'], () => wrap('\\textbf{', 'strong')],
  ['emph', 'Emphasis (\\emph)', 'text', ['C-i'], () => wrap('\\emph{', 'em')],
  ['italic', 'Italic (\\textit)', 'text', ['C-I'], () => wrap('\\textit{', 'em')],
  ['math', 'Inline maths (the selection, or a new formula)', 'text', ['C-m', '$'], () => mathAtSelection()],
  ['display', 'Displayed equation', 'text', ['C-M'], () => insertMath(true)],
  ['cite', 'Cite (search)', 'text', ['C-M-c'], () => citePalette()],
  ['ref', 'Reference (search)', 'text', ['C-M-r'], () => refPalette()],
  ['latex', 'Insert LaTeX', 'text', ['C-\\'], () => insertLatex('\\cref{}', 'Insert LaTeX')],
  ['section', 'Section heading at the cursor', 'text', ['C-M-1'], () => headingAtCaret('section')],
  ['subsection', 'Subsection heading at the cursor', 'text', ['C-M-2'], () => headingAtCaret('subsection')],
  ['paragraph', '\\paragraph heading at the cursor', 'text', ['C-M-3'], () => headingAtCaret('paragraph')],
  ['splitsection', 'Split section at the cursor', 'text', [], () => splitSectionAtCaret()],
  ['linestart', 'Start of line', 'text', ['C-a'], () => getSelection().modify('move', 'backward', 'lineboundary')],
  ['lineend', 'End of line', 'text', ['C-e'], () => getSelection().modify('move', 'forward', 'lineboundary')],
  ['selstart', 'Select to start of line', 'text', ['C-A'], () => getSelection().modify('extend', 'backward', 'lineboundary')],
  ['selend', 'Select to end of line', 'text', ['C-E'], () => getSelection().modify('extend', 'forward', 'lineboundary')],
  ['deleteline', 'Delete the line', 'text', ['C-d'], () => deleteLine()],
  ['cut', 'Cut the region, or the line', 'text', ['M-w'], () => cutRegionOrLine()],
  ['duplicate', 'Duplicate the region, or the line', 'text', ['C-p'], () => duplicate()],
  ['expand', 'Expand the selection', 'text', ['C-+', 'C-='], () => expandRegion()],
];
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
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
  $('#historybox').hidden = true;
  const changed = Object.keys(texts).filter((n) => FILES[n] && FILES[n].text !== FILES[n].disk);
  banner((changed.length ? `Restored ${changed.join(', ')} as ${which} that save: save to keep it, or undo.` : 'The files are already as in that version.') +
    (missing.length ? ` Not restored (no longer part of the document): ${missing.join(', ')}.` : ''));
}

$('#historybtn').onclick = openHistory;
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

const MD = { data: null, info: null, target: 'llncs', anon: false, dirty: false };
function metadataDirty() {
  MD.dirty = false;
  MD.dirty = true;
  const status = $('#md-status'); if (status) status.textContent = 'Unsaved metadata changes';
}

async function openPaper() {
  MD.info = await (await fetch('/api/metadata')).json();
  MD.data = JSON.parse(JSON.stringify(MD.info.metadata));
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
    if (!confirm('Replace your metadata edits with values found in the LaTeX source?')) return;
    MD.data = structuredClone(MD.info.extracted);
    drawPaper(); metadataDirty();
  };
  const status = el('span', 'small', MD.dirty ? 'Unsaved metadata changes' : 'Metadata loaded');
  status.id = 'md-status'; status.setAttribute('role', 'status');
  body.append(origin, reset, status);
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
    const del = el('button', '', '✕'); del.title = 'Remove this author';
    del.onclick = () => { md.authors.splice(i, 1); drawPaper(); metadataDirty(); };
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
  const addA = el('button', '', '＋ author');
  addA.onclick = () => { md.authors.push({ name: '', email: '', orcid: '', affiliations: [] }); drawPaper(); metadataDirty(); };
  body.append(addA);
  body.append(el('h4', '', 'Affiliations'));
  md.affiliations.forEach((af, k) => {
    const where = `affiliation ${k + 1} (${af.name || '?'})`;
    r = el('div', 'row card');
    r.append(el('b', '', (k + 1) + '.'), field(af, 'name', 'Name', where, '18em'), field(af, 'department', 'Department', where, '10em'),
      field(af, 'city', 'City', where, '8em'), field(af, 'country', 'Country', where, '8em'), field(af, 'ror', 'ROR id', where, '8em'));
    const del = el('button', '', '✕');
    del.onclick = () => {
      md.affiliations.splice(k, 1);
      for (const a of md.authors) a.affiliations = (a.affiliations || []).filter((j) => j !== k).map((j) => (j > k ? j - 1 : j));
      drawPaper();
    };
    r.append(del);
    body.append(r);
  });
  const addF = el('button', '', '＋ affiliation');
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
  const rootOutput = el('input'); rootOutput.type = 'checkbox'; rootOutput.checked = false;
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
    await saveMetadata(true);
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

  if (!r.ok) { const msg = 'Metadata save failed (' + r.status + ')';
    const status = $('#md-status'); if (status) status.textContent = msg;
    banner(msg); return;
  }
async function saveMetadata(quiet) {
  const r = await fetch('/api/metadata', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify(MD.data) });
  MD.info = await r.json();
  MD.dirty = false;
  const status = $('#md-status');
  if (status) status.textContent = 'Saved locally at ' + new Date().toLocaleTimeString();
  if (!quiet) banner('Metadata saved successfully in .paper-editor/metadata.json.');
}

$('#paperbtn').onclick = openPaper;
$('#md-save').onclick = () => saveMetadata(false);
$('#md-close').onclick = () => { $('#paperbox').hidden = true; };
