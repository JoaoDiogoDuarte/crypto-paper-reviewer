// The reading editor.  The model is the text of each file; the page is
// rendered from it, and edits are committed back to text (commit()) before
// every structural change and every save.  A file is edited exactly when
// its committed text differs from the text read from disk.
'use strict';
const L = window.LatexDoc;
const TOKEN = document.querySelector('meta[name=token]').content;
const $ = (s) => document.querySelector(s);

let DOC = null;          // payload of /api/doc: files, aux, macros, bib, figs
const FILES = {};        // name -> { text, base (hash on disk), disk (text on disk), segs }
let ORDER = [];          // display order: segments, each with .file and .el
let lastTyping = 0;

// ---------------------------------------------------------------- loading

async function load(keepScroll) {
  const y = window.scrollY;
  const oldMacros = DOC && JSON.stringify(DOC.macros);
  DOC = await (await fetch('/api/doc')).json();
  if (oldMacros !== JSON.stringify(DOC.macros)) KATEX_CACHE.clear();
  for (const [name, f] of Object.entries(DOC.files)) {
    const cur = FILES[name];
    // keep unsaved edits of a file that did not change on disk
    if (cur && cur.text !== cur.disk && cur.base === f.hash) continue;
    FILES[name] = { text: f.text, disk: f.text, base: f.hash };
  }
  render();
  if (keepScroll) window.scrollTo(0, y);
  setBuild(DOC.build);
  if (new URLSearchParams(location.search).has('selftest')) selfTest();
}

// Segments of a file.  Every file is split at its \input/\include/\subfile
// lines; in the main file, everything up to \begin{document} is one hidden
// segment (inputs there are not shown).
function parseFile(name) {
  const text = FILES[name].text;
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
function watchEdits() {
  if (EDIT_OBSERVER) EDIT_OBSERVER.disconnect();
  EDIT_OBSERVER = new MutationObserver((records) => {
    for (const r of records) {
      const n = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      const seg = n && segOf(n);
      if (seg) seg.touched = true;
    }
  });
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
  const plus = el('button', '', '＋');
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
  const visible = [...p.childNodes].some((n) => n.nodeType === 3 ? n.data.trim() : !n.classList.contains('hidden'));
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
  return wrapSeg(seg, node, [del]);
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

function renderFloat(seg) {
  const box = el('div');
  seg.wide = /^\s*\\begin\{(figure|table)\*\}/.test(seg.src);
  if (seg.kind === 'figure') {
    const url = DOC.figs[seg.src];
    if (url) { const img = el('img'); img.src = url; img.alt = 'Figure'; box.append(img); }
    else box.append(el('div', 'small', '(figure image is being rendered, or the source changed; it appears after the next build)'));
  } else {
    const raw = /\\begin\{tabular\}[^]*?\\end\{tabular\}/.exec(seg.src);
    if (raw) box.append(el('pre', 'rawsrc', raw[0]));
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
  if (HIDDEN.has(name)) return chip('hidden', tok.s);
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
  if (name === 'verbatim') return chip('src', tok.s, '[' + tok.env + ']');
  if (name === 'textasciitilde') return chip('nl', tok.s, '~');
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
function typesetInto(src, node, display) {
  let [body, disp] = mathBody(src);
  body = body.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '');
  try {
    const key = (display || disp ? 'D' : 'I') + body;
    let html = KATEX_CACHE.get(key);
    if (html === undefined) {
      html = katex.renderToString(body, { displayMode: display || disp, throwOnError: false,
        macros: { ...DOC.macros }, strict: false, trust: false });
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

function ser(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { out += L.typeset(L.encodeText(n.data)); continue; }
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
function segSource(seg, warnings) {
  if (seg.removed) return '';
  if (!seg.touched && seg.kind !== 'code') return seg.src;
  const fix = (text, original) => {
    if (text === original) return text;
    const [t, w] = L.houseRules(text, (DOC.config || {}).house_rules);
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
      if (!seg.edit || !seg.parts) return seg.src;
      return seg.parts.prefix + fix(ser(seg.edit), seg.parts.caption) + seg.parts.suffix;
    default: return seg.src;
  }
}

// Write the page back into the file texts.  Returns house-rule warnings.
function commit() {
  const warnings = [];
  for (const [name, f] of Object.entries(FILES)) {
    if (!f.segs) continue;
    f.text = f.segs.map((s) => segSource(s, warnings)).join('');
  }
  return warnings;
}

function editedFiles() {
  commit();
  return Object.keys(FILES).filter((n) => FILES[n].text !== FILES[n].disk);
}

function markEdited() {
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
  commit();
  // every segment of every file takes its current source first, so that the
  // texts rebuilt below keep the edits of files the change does not touch
  for (const f of Object.values(FILES)) if (f.segs) f.segs.forEach((s) => { s.src = segSource(s, []); });
  const focus = change();
  for (const f of Object.values(FILES)) if (f.segs) f.text = f.segs.map((s) => s.removed ? '' : s.src).join('');
  render();
  if (focus) focusPlaceholder(focus);
}

function removeSeg(seg) {
  const segs = FILES[seg.file].segs;
  const i = segs.indexOf(seg);
  seg.removed = true;
  if (i > 0 && segs[i - 1].kind === 'gap') segs[i - 1].removed = true;
}

function insertAfter(seg, src) {
  const segs = FILES[seg.file].segs;
  const i = segs.indexOf(seg);
  segs.splice(i + 1, 0, { kind: 'gap', src: '\n\n', file: seg.file }, { kind: 'para', src, file: seg.file });
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

function openDrawer(chipEl, seg, title) {
  drawerChip = chipEl; drawerSeg = seg;
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
  if (!drawerChip) return closeDrawer();
  if (remove) drawerChip.remove();
  else {
    const frag = document.createDocumentFragment();
    renderTokens(L.tokenize($('#drawer-src').value), frag, {});
    drawerChip.replaceWith(frag);
  }
  closeDrawer();
  markEdited();
}

function closeDrawer() { $('#drawer').hidden = true; drawerChip = null; drawerSeg = null; }

$('#drawer-src').addEventListener('input', preview);
$('#drawer-src').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyDrawer(false); }
  if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); }
});
$('#drawer-apply').onclick = () => applyDrawer(false);
$('#drawer-delete').onclick = () => applyDrawer(true);
$('#drawer-cancel').onclick = closeDrawer;

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

// Paste plain text only.
doc.addEventListener('paste', (e) => {
  if (e.target.tagName === 'TEXTAREA') return;
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/\n{2,}/g, ' ').replace(/\n/g, ' ');
  document.execCommand('insertText', false, text);
});

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
$('#helpclose').onclick = () => { $('#helpbox').hidden = true; };

// ----------------------------------------------------------------- save

async function save() {
  const warnings = commit();
  const files = Object.keys(FILES).filter((n) => FILES[n].text !== FILES[n].disk);
  if (!files.length) return setBuild({ state: 'idle', message: 'nothing to save' });
  for (const name of files) {
    const r = await fetch('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
      body: JSON.stringify({ name, base: FILES[name].base, text: FILES[name].text }),
    });
    if (r.status === 409) { banner(`${name} changed on disk since it was loaded; your edits to it are kept here but not saved. Copy them, then reload.`); continue; }
    if (!r.ok) { banner(`Saving ${name} failed: ${(await r.json()).error}`); continue; }
    const { hash } = await r.json();
    FILES[name].disk = FILES[name].text;
    FILES[name].base = hash;
  }
  if (warnings.length) banner('Saved. House rules: ' + [...new Set(warnings)].join('; '));
  setBuild({ state: 'running', message: 'saved; rebuilding PDF' });
  // re-render only when the saved text has new structure (a paragraph break,
  // a heading) that the page shows as a chip until it is parsed again
  if (document.querySelector('#doc .chip.parbreak, #doc .chip.src[data-src^="\\\\section"], #doc .chip.src[data-src^="\\\\subsection"]')) {
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  } else {
    for (const seg of ORDER) if (seg.touched) { seg.src = segSource(seg, []); seg.touched = false; }
    for (const name of files) FILES[name].segs.forEach((sg) => { if (!sg.el) return; });
    markEdited();
  }
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
async function poll() {
  try {
    const s = await (await fetch('/api/state')).json();
    setBuild(s.build);
    const changed = Object.keys(s.hashes).filter((n) => FILES[n] && s.hashes[n] !== FILES[n].base);
    const busy = Date.now() - lastTyping < 4000 || !$('#drawer').hidden;
    if ((changed.length || s.auxver !== AUXVER) && !busy) {
      commit();
      const conflicts = changed.filter((n) => FILES[n].text !== FILES[n].disk);
      if (conflicts.length) banner(`${conflicts.join(', ')} changed on disk while you were editing it; your version is kept until you save (which will refuse) or reload.`);
      AUXVER = s.auxver;
      await load(true);
    }
  } catch (e) { /* server restarting */ }
  setTimeout(poll, 2000);
}

// -------------------------------------------------------------- speech

const TTS = (() => {
  let queue = [], idx = 0, speaking = false, paused = false, current = null, audio = null, prefetched = null;
  const synth = window.speechSynthesis;
  const voiceSel = $('#voice');

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

  function play() {
    stop();
    if (!voiceSel.value) { banner('No text-to-speech voice is available. See the README of the editor for how to install one.'); return; }
    queue = build(startSeg());
    idx = 0; speaking = true; paused = false;
    next();
  }

  function highlight(seg) {
    if (current === seg) return;
    if (current && current.el) current.el.classList.remove('speaking');
    current = seg;
    if (seg && seg.el) seg.el.classList.add('speaking');
  }

  function next() {
    if (!speaking || idx >= queue.length) { stop(); return; }
    const item = queue[idx++];
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
      audio.onended = next;
      audio.onerror = () => { banner('Speech failed for this voice; see the server output.'); next(); };
      audio.play().catch(() => {});
      return;
    }
    const u = new SpeechSynthesisUtterance(item.text);
    const v = voices().find((x) => x.name === name);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = rate;
    u.onend = next;
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') next(); };
    synth.speak(u);
  }

  function stop() {
    speaking = false;
    if (synth) synth.cancel();
    if (audio) { audio.pause(); audio = null; }
    highlight(null);
    markPhrase(null);
  }

  function pause() {
    if (!speaking) return;
    paused = !paused;
    if (audio) { if (paused) audio.pause(); else audio.play(); return; }
    if (paused) synth.pause(); else synth.resume();
  }

  return { play, stop, pause, fillVoices, loadServerVoices, build };
})();
$('#play').onclick = () => TTS.play();
$('#stop').onclick = () => TTS.stop();
$('#pause').onclick = () => TTS.pause();

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

// Phrases: sentences, split again at ; and :, and in long sentences at
// commas.  Returns [start, end) offsets into the spoken text.
const ABBREV = /\b(Fig|Figs|Thm|Eq|Sec|Sect|Lem|Def|Cor|App|i\.e|e\.g|cf|vs|resp|al|Prop)\.$/;
function phraseBounds(text) {
  const out = [];
  let start = 0, m;
  const re = /[.!?;:,](?=\s)/g;
  while ((m = re.exec(text))) {
    const end = m.index + 1;
    const piece = text.slice(start, end).trim();
    if (m[0] === '.' && ABBREV.test(piece)) continue;
    if (m[0] === ',' && piece.length < 60) continue;
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
  try { html = katex.renderToString(body, { output: 'mathml', throwOnError: false, macros: { ...DOC.macros }, strict: false }); }
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
    const seg = ORDER.filter((x) => x.kind === 'para' && x.edit && !x.edit.classList.contains('quiet'))[40];
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

load(false).then(() => {
  TTS.loadServerVoices();
  if (new URLSearchParams(location.search).has('edittest')) editTest(); AUXVER = DOC.auxver; TTS.fillVoices(); poll(); });

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
  commit();
  const cur = Object.fromEntries(Object.entries(FILES).map(([n, f]) => [n, f.text]));
  let texts = from.pop();
  while (texts && Object.keys(texts).every((n) => texts[n] === cur[n])) texts = from.pop();
  if (!texts) return;
  to.push(cur);
  for (const [n, t] of Object.entries(texts)) FILES[n].text = t;
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
  const r = selRange();
  if (!editableAt(r)) return;
  snapshot();
  const e = el(tag);
  e.dataset.prefix = prefix;
  if (r.collapsed) e.append(document.createTextNode('text'));
  else e.append(r.extractContents());
  r.insertNode(e);
  const nr = document.createRange(); nr.selectNodeContents(e);
  const s = getSelection(); s.removeAllRanges(); s.addRange(nr);
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

// A heading at the caret: the paragraph is split there, and the text after
// the caret goes under the new heading.
function headingAtCaret(level) {
  const seg = segOf(editableAt(selRange()) || document.body);
  if (!seg || seg.kind !== 'para') return;
  const src = level === 'paragraph' ? '\\paragraph{' + PLACEHOLDER + '}\n' : '\\' + level + '{' + PLACEHOLDER + '}';
  const nodes = level === 'paragraph'
    ? [chip('parbreak', '\n\n', ''), chip('src', src, src)]
    : [chip('parbreak', '\n\n', ''), chip('src', src, src), chip('parbreak', '\n\n', '')];
  if (!insertNodes(nodes)) return;
  structural(() => PLACEHOLDER);
}

function insertMath(display) {
  const m = display ? mathChip('\\[\n  \n\\]', true) : mathChip('$ $', false);
  const nodes = display ? [chip('nl', '\n', ' '), m, chip('nl', '\n', ' ')] : [m];
  if (insertNodes(nodes)) openDrawer(m, null, display ? 'New displayed equation' : 'New inline maths');
}

function insertLatex(src, title) {
  const c = chip('src', src, src);
  if (insertNodes([c])) openDrawer(c, null, title);
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

// Bindings available anywhere on the page.
const GLOBAL_KEYS = {
  'C-s': save, 'C-S': save,
  'C-z': undo, 'C-Z': redo, 'C-y': redo,
  'M-r': () => TTS.play(), 'M-R': () => TTS.play(),
  'Escape': () => { $('#helpbox').hidden = true; $('#menu').hidden = true; },
};
// Bindings inside the text of the paper.
const TEXT_KEYS = {
  'C-b': () => wrap('\\textbf{', 'strong'),
  'C-i': () => wrap('\\emph{', 'em'),
  'C-I': () => wrap('\\textit{', 'em'),
  'C-m': () => insertMath(false), 'C-M': () => insertMath(true),
  '$': () => insertMath(false),
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
  if (inField && !['C-s', 'C-S', 'C-f'].includes(k)) return;   // a field keeps its own keys (undo, Escape)
  if (GLOBAL_KEYS[k]) { e.preventDefault(); GLOBAL_KEYS[k](); return; }
  const inText = e.target.isContentEditable && segOf(e.target);
  if (!inText) return;
  if (TEXT_KEYS[k]) { e.preventDefault(); TEXT_KEYS[k](); return; }
  const seg = segOf(e.target);
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (seg.kind === 'para') insertNodes([chip('parbreak', '\n\n', '')]);
    return;
  }
  if (e.key === 'Backspace' && !e.ctrlKey && seg.kind === 'para' && caretAtStart(seg.edit)) {
    snapshot();
    if (joinWithPrevious(seg)) e.preventDefault();
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

function closePalette() { $('#palette').hidden = true; PAL.opts = null; }

function refreshPalette() {
  clearTimeout(PAL.timer);
  PAL.timer = setTimeout(async () => {
    const seq = ++PAL.seq;
    const items = await PAL.opts.search($('#pal-q').value);
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
    search: async (q) => {
      if (!q.trim()) return [];
      if (online) {
        const r = await fetch('/api/online?q=' + encodeURIComponent(q));
        if (!r.ok) { banner((await r.json()).error); return []; }
        return (await r.json()).map((h) => ({ ...h, online: true }));
      }
      return (await fetch('/api/bib?q=' + encodeURIComponent(q))).json();
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
  math: () => insertMath(false),
  display: () => insertMath(true),
  cite: citePalette,
  ref: refPalette,
  latex: () => insertLatex('\\cref{}', 'Insert LaTeX'),
  section: () => headingAtCaret('section'),
  subsection: () => headingAtCaret('subsection'),
  paragraph: () => headingAtCaret('paragraph'),
  newpara: () => insertNodes([chip('parbreak', '\n\n', '')]),
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
