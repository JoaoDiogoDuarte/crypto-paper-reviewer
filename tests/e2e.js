#!/usr/bin/env node
// End-to-end tests of the editor page: a real server on a throwaway paper,
// a real (headless) Chrome driven through the DevTools protocol, real key
// presses, typing and pasting, and the bytes on disk checked after saving.
// No dependencies beyond Node 22 (built-in WebSocket) and Chrome/Chromium.
//
//   node tests/e2e.js               # every test
//   node tests/e2e.js paste wrap    # only tests whose name contains a word
//   CHROME=/path/to/chrome node tests/e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.dirname(__dirname);
const PY = fs.existsSync(path.join(ROOT, '.venv/bin/python')) ? path.join(ROOT, '.venv/bin/python') : 'python3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = {};   // the browser, for tests that open another tab

// ------------------------------------------------------------ the paper

const MAIN = String.raw`\documentclass{article}
\usepackage{amsmath}
\newcommand{\Adv}{\mathsf{Adv}}
\begin{document}
\section{Introduction}\label{sec:intro}
The quick brown fox jumps over the lazy dog.
We study $x^2 + y^2$ here.

A second paragraph about encryption schemes.

\section{Related work}
Other papers exist.

\input{sections/body}

\begin{figure}[t]
\centering
\fbox{box}
\caption{A caption here.}\label{fig:one}
\end{figure}

\begin{lstlisting}
code line
\end{lstlisting}

\section{Conclusion}
\begin{quote}
A quoted sentence from another paper.
\end{quote}

Final words of the paper.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;
const BIB = String.raw`@inproceedings{GM84,
  author = {Shafi Goldwasser and Silvio Micali},
  title = {Probabilistic Encryption},
  year = {1984},
}
`;
const BODY = String.raw`\section{Body}\label{sec:body}
Body text with a formula $\Adv$ and more words.

\subsection{Details}
Detail text lives here.
`;
const OTHER = '\\documentclass{article}\n\\begin{document}\nThe other document.\n\\end{document}\n';
const FILES = { 'main.tex': MAIN, 'sections/body.tex': BODY, 'other.tex': OTHER, 'refs.bib': BIB };

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function waitHttp(url, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return r; } catch (e) { /* not yet */ }
    await sleep(100);
  }
  throw new Error('no answer from ' + url);
}

// ------------------------------------------------------------ DevTools

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      } else if (m.method) for (const h of this.handlers) h(m);
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(h) { this.handlers.push(h); }
}

function findChrome() {
  const cands = [process.env.CHROME, 'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
  for (const c of cands) {
    if (!c) continue;
    try { execFileSync('which', [c], { stdio: 'ignore' }); return c; } catch (e) { /* next */ }
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// One page of the editor, with helpers that act as a user would.
class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp; this.sid = sessionId; this.dialogs = []; this.dialogAnswer = true; this.errors = []; this.consoleErrors = [];
    cdp.on((m) => {
      if (m.sessionId !== this.sid) return;
      if (m.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(m.params.message);
        this.send('Page.handleJavaScriptDialog', { accept: this.dialogAnswer }).catch(() => {});
      }
      if (m.method === 'Fetch.requestPaused') {
        const id = m.params.requestId;
        if (m.params.request.url.includes('__probe')) {
          this.probed = true;
          this.send('Fetch.fulfillRequest', { requestId: id, responseCode: 204 }).catch(() => {});
        } else if (this.saveMode === 'fail') {
          this.send('Fetch.fulfillRequest', { requestId: id, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            body: Buffer.from(JSON.stringify({ error: 'disk on fire' })).toString('base64') }).catch(() => {});
        } else if (this.saveMode === 'drop') {
          this.send('Fetch.failRequest', { requestId: id, errorReason: 'ConnectionReset' }).catch(() => {});
        } else this.held.push(id);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
        this.consoleErrors.push(m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
  }
  send(method, params) { return this.cdp.send(method, params, this.sid); }
  // saves on their way to the server: 'hold' them (release() lets them go),
  // 'fail' them with a 500, 'drop' the connection; null: normal
  async interceptSaves(mode) {
    this.saveMode = mode; this.held = this.held || [];
    if (mode) {
      await this.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/save*', requestStage: 'Request' }] });
      // under load Chrome can answer Fetch.enable before the interception is
      // in place, and the next save would reach the server: wait until a
      // probe request is caught (one that slips through gets a 403: no token)
      this.probed = false;
      for (let i = 0; i < 50 && !this.probed; i++) {
        await this.eval(`fetch('/api/save?__probe', { method: 'POST' }).catch(() => {}).then(() => 0)`);
        if (!this.probed) await sleep(50);
      }
      if (!this.probed) throw new Error('save interception never became active');
    } else { await this.release(); await this.send('Fetch.disable'); }
  }
  async release() {
    const held = this.held || []; this.held = [];
    for (const id of held) await this.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  in ' + expr.slice(0, 200));
    return r.result.value;
  }
  async waitFor(expr, timeout = 8000, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(expr)) return;
      } catch (e) {
        // asked while the page is reloading: ask again once it is back
        if (!/navigated or closed|context was destroyed|Cannot find context|not found/i.test(String(e.message))) throw e;
      }
      await sleep(50);
    }
    throw new Error('timed out waiting for ' + (what || expr));
  }
  // a key press; mods: ctrl, alt, shift
  async key(key, mods = {}) {
    const m = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
    const named = { Enter: [13, 'Enter', '\r'], Backspace: [8, 'Backspace', ''], Escape: [27, 'Escape', ''],
      ArrowLeft: [37, 'ArrowLeft', ''], ArrowRight: [39, 'ArrowRight', ''], ArrowUp: [38, 'ArrowUp', ''], ArrowDown: [40, 'ArrowDown', ''], Delete: [46, 'Delete', ''] };
    let code, vk, text;
    if (named[key]) [vk, code, text] = named[key];
    else {
      const shifted = { '$': ['Digit4', 52], '(': ['Digit9', 57], ')': ['Digit0', 48], '{': ['BracketLeft', 219],
        '}': ['BracketRight', 221], '"': ['Quote', 222], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
        "'": ['Quote', 222], '`': ['Backquote', 192], '*': ['Digit8', 56], '_': ['Minus', 189] };
      if (shifted[key]) [code, vk] = shifted[key];
      else if (/^[a-z]$/i.test(key)) {
        code = 'Key' + key.toUpperCase(); vk = key.toUpperCase().charCodeAt(0);
        if (mods.shift) key = key.toUpperCase();
      }
      else if (/^[0-9]$/.test(key)) { code = 'Digit' + key; vk = key.charCodeAt(0); }
      else { code = ''; vk = 0; }
      text = mods.ctrl || mods.alt ? '' : key;
    }
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: m };
    await this.send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text });
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }
  // a real mouse click in the middle of an element (CSS selector, or a JS
  // expression giving the element when it starts with "js:")
  async click(sel, opts = {}) {
    const expr = sel.startsWith('js:') ? sel.slice(3) : `document.querySelector(${JSON.stringify(sel)})`;
    // scroll it into view, then measure once the blocks around it have their
    // real sizes (off screen they are estimated: the first frame lies)
    // a control in a menu (☰, ⋯, Heading): the menu is opened first, as a user would
    await this.eval(`(() => { const e = ${expr}; if (e && typeof revealControl === 'function') revealControl(e); if (e && !e.closest('#chrome')) e.scrollIntoView({ block: 'center' }); })()`);
    await this.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const box = await this.eval(`(() => { const e = ${expr}; if (!e) return null;
      const r = e.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) { e.scrollIntoView({ block: 'center' }); }
      const r2 = e.getBoundingClientRect();
      // a block's tools show when the mouse is over the block: come from there
      const seg = e.closest('.tools') && e.closest('.seg');
      const s = seg && seg.firstChild.getBoundingClientRect();
      return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, w: r2.width, from: s ? { x: s.left + 10, y: s.top + Math.min(8, s.height / 2) } : null }; })()`);
    if (!box || !box.w) throw new Error('nothing to click: ' + sel);
    const base = { x: box.x, y: box.y, button: 'left', clickCount: opts.count || 1, modifiers: opts.ctrl ? 2 : 0 };
    if (box.from) {
      // over the block, then sideways and down to the button, as a hand would
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.from.x, y: box.from.y });
      // in small steps: a gap on the way (where the tools would vanish) shows
      for (let k = 1; k <= 24; k++) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
          x: box.from.x + (box.x - box.from.x) * Math.min(1, k / 12), y: box.from.y + (box.y - box.from.y) * Math.max(0, (k - 12) / 12) });
      }
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    for (let c = 1; c <= (opts.count || 1); c++) {
      await this.send('Input.dispatchMouseEvent', { ...base, clickCount: c, type: 'mousePressed' });
      await this.send('Input.dispatchMouseEvent', { ...base, clickCount: c, type: 'mouseReleased' });
    }
    await sleep(30);
  }
  async type(text) { await this.send('Input.insertText', { text }); }
  async typeKeys(text) { for (const c of text) await this.key(c); }
  // select the text `needle` (its n-th occurrence) in the editable text of
  // the page; collapse: 'start' | 'end' to put the caret there instead
  async select(needle, collapse = null, n = 0) {
    const ok = await this.eval(`(() => {
      const needle = ${JSON.stringify(needle)}; let n = ${n};
      for (const ed of document.querySelectorAll('#doc [contenteditable=true]')) {
        const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
        let t;
        while ((t = w.nextNode())) {
          let i = t.data.indexOf(needle);
          while (i >= 0) {
            if (n-- === 0) {
              ed.focus();
              const r = document.createRange();
              r.setStart(t, i); r.setEnd(t, i + needle.length);
              ${collapse === 'start' ? 'r.collapse(true);' : collapse === 'end' ? 'r.collapse(false);' : ''}
              const s = getSelection(); s.removeAllRanges(); s.addRange(r);
              return true;
            }
            i = t.data.indexOf(needle, i + 1);
          }
        }
      }
      return false;
    })()`);
    if (!ok) throw new Error('text not on the page: ' + needle);
  }
  async paste(text, extra = {}) {
    await this.eval(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(text)});
      for (const [k, v] of Object.entries(${JSON.stringify(extra)})) dt.setData(k, v);
      const target = getSelection().anchorNode;
      const el = target.nodeType === 1 ? target : target.parentElement;
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
  }
  // what a copy of the current selection puts on the clipboard
  async copy(kind = 'copy') {
    return this.eval(`(() => {
      const dt = new DataTransfer();
      const target = getSelection().anchorNode;
      const el = target.nodeType === 1 ? target : target.parentElement;
      el.dispatchEvent(new ClipboardEvent(${JSON.stringify(kind)}, { clipboardData: dt, bubbles: true, cancelable: true }));
      return Object.fromEntries(dt.types.map((t) => [t, dt.getData(t)]));
    })()`);
  }
  async save() {
    await this.key('s', { ctrl: true });
    await sleep(150);
    await this.waitFor("typeof SAVING === 'undefined' || !SAVING", 8000, 'the save to finish');
  }
  pageText() { return this.eval(`document.querySelector('#doc').innerText`); }
  banner() { return this.eval(`$('#banner').hidden ? '' : $('#banner').textContent`); }
}

// ------------------------------------------------------------ fixture

class Env {
  async start(chrome) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-e2e-'));
    this.paper = path.join(this.dir, 'paper');
    this.state = path.join(this.dir, 'state');
    for (const [n, t] of Object.entries(FILES)) this.write(n, t);
    fs.mkdirSync(this.state, { recursive: true });
    // a build that always succeeds at once, so that every save is followed
    // by a new .aux version and a reload of the page, as with latexmk
    fs.writeFileSync(path.join(this.state, 'config.json'), JSON.stringify({ build: 'true' }));
    this.port = await freePort();
    this.log = '';
    // HOME: keyboard shortcuts are saved in the user's config, never the real one
    this.spawnServer();
    await waitHttp(`http://127.0.0.1:${this.port}/api/state`);
    this.page = await this.openPage(chrome);
    return this.page;
  }
  spawnServer() {
    this.srv = spawn(PY, [path.join(ROOT, 'server.py'), path.join(this.paper, 'main.tex'), '--port', String(this.port),
      '--no-open', '--state', this.state], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: this.dir, XDG_CONFIG_HOME: path.join(this.dir, 'config'), PE_NO_RELOAD: '1',
        PE_CRYPTOBIB_URL: path.join(this.dir, 'cryptobib-src'),
        PE_CODE_PROBE: path.join(this.dir, 'code-probe') } });
    this.srv.stdout.on('data', (d) => { this.log += d; });
    this.srv.stderr.on('data', (d) => { this.log += d; });
  }
  async stopServer() {
    if (!this.srv) return;
    const srv = this.srv; this.srv = null;
    srv.kill();
    await new Promise((r) => (srv.exitCode !== null ? r() : srv.once('exit', r)));
  }
  async startServer() {
    this.spawnServer();
    await waitHttp(`http://127.0.0.1:${this.port}/api/state`);
  }
  // another tab of the editor on the same server
  async openPage(chrome) {
    const t = await chrome.cdp.send('Target.createTarget', { url: 'about:blank' });
    (this.targets = this.targets || []).push(t.targetId);
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const page = new Page(chrome.cdp, sessionId);
    (this.pages = this.pages || []).push(page);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: `http://127.0.0.1:${this.port}/` });
    await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0 && typeof AUXVER !== 'undefined' && AUXVER > 0`, 15000, 'the page to load');
    return page;
  }
  write(name, text) {
    const p = path.join(this.paper, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  read(name) { return fs.readFileSync(path.join(this.paper, name), 'utf8'); }
  async stop(chrome) {
    for (const p of this.pages || []) { p.dialogAnswer = true; await p.interceptSaves(null).catch(() => {}); }
    for (const id of this.targets || []) await chrome.cdp.send('Target.closeTarget', { targetId: id }).catch(() => {});
    await this.stopServer();
    try { fs.chmodSync(this.paper, 0o755); } catch (e) { /* gone */ }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ checks

function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}:\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
}
function has(text, piece, what) {
  if (!text.includes(piece)) throw new Error(`${what}: ${JSON.stringify(piece)} not in\n    ${JSON.stringify(text)}`);
}
function hasNot(text, piece, what) {
  if (text.includes(piece)) throw new Error(`${what}: ${JSON.stringify(piece)} unexpectedly in\n    ${JSON.stringify(text)}`);
}
// the file is the original with exactly one replacement
function onlyChange(env, name, from, to) {
  const want = FILES[name].replace(from, () => to);   // a function: no $-patterns in `to`
  if (want === FILES[name]) throw new Error(`test bug: ${JSON.stringify(from)} not in ${name}`);
  eq(env.read(name), want, `${name} after saving`);
}
async function waitDiffMarks(page, count, what) {
  try {
    await page.waitFor('DIFF.marks.length === ' + count, 15000, what);
  } catch (e) {
    const state = await page.eval("JSON.stringify({diffOn:DIFF.on,baseline:$('#diffbase').value,marks:DIFF.marks.length,dirtyFiles:Object.keys(FILES).filter(n=>FILES[n].segs&&FILES[n].text!==FILES[n].disk),files:Object.keys(FILES).filter(n=>FILES[n].segs).map(n=>({name:n,currentEqualsDisk:FILES[n].text===FILES[n].disk,segments:FILES[n].segs.filter(s=>s.el&&!s.removed).length}))})");
    throw new Error(e.message + '; diff state: ' + state);
  }
}
function untouched(env, ...names) {
  for (const n of names) eq(env.read(n), FILES[n], `${n} must be unchanged`);
}
const dirty = (page) => page.eval(`editedFiles().length`);

// ------------------------------------------------------------ tests


// A speech engine that never talks: phrases are recorded, and finish() ends
// the one being spoken.  Installed before the page loads, which is reloaded.
async function fakeSpeech(page) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const fake = { spoken: [], cur: null, paused: false, onvoiceschanged: null };
    fake.voices = [];   // a real SpeechSynthesisVoice cannot be made up
    const synth = {
      getVoices: () => fake.voices,
      speak: (u) => { fake.spoken.push(u.text); fake.cur = u; },
      cancel: () => { fake.cur = null; },
      pause: () => { fake.paused = true; }, resume: () => { fake.paused = false; },
    };
    fake.finish = () => { const u = fake.cur; fake.cur = null; if (u && u.onend) u.onend({}); };
    window.__fake = fake;
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    // server voices would arrive late and re-fill the voice list behind the
    // test's back, mid-reading (edge takes seconds to answer); say there are none
    const realfetch = window.fetch;
    window.fetch = (u, o) => String(u).startsWith('/api/voices') ? Promise.resolve(new Response('[]')) : realfetch(u, o);
  })()` });
  await page.eval(`window.__old = true`);
  await page.send('Page.reload');
  await page.waitFor(`!window.__old`, 15000, 'the old page to go');
  await page.waitFor(`typeof TTS !== 'undefined' && typeof ORDER !== 'undefined' && ORDER.length > 0 && typeof AUXVER !== 'undefined' && AUXVER > 0`, 15000, 'the page to reload');
  await page.eval(`TTS.fillVoices(); $('#voice').append(new Option('Fake', 'browser|Fake')); $('#voice').value = 'browser|Fake'`);
  eq(await page.eval(`$('#voice').value`), 'browser|Fake', 'fake voice selected');
}

// Merging headings: a paper from these files, a merge asked for, the question answered.
async function mergeFresh(env, page, files) {
  for (const [n, t] of Object.entries(files)) env.write(n, t);
  await page.eval('load(true)');
  const first = Object.values(files).map((t) => /\\(?:sub)*section\{([^}]*)\}/.exec(t)).find(Boolean);
  await page.waitFor(`ORDER.some((s) => s.kind === 'heading' && s.src.includes(${JSON.stringify(first[1])}))`, 8000, 'the headings');
}
async function mergeStart(page, title, question = true) {
  await page.eval(`(mergeHeading(ORDER.find((s) => s.kind === 'heading' && !s.removed && (L.headingParts(s.src) || {}).title === ${JSON.stringify(title)})), 0)`);
  if (question) await page.waitFor(`!$('#askbox').hidden`, 3000, 'the question');
  else await sleep(200);
}
async function mergeAnswer(page, label, keepAsSub = false) {
  await page.eval(`(() => { $('#ask-check').checked = ${keepAsSub}; [...$('#ask-actions').children].find((b) => b.textContent === ${JSON.stringify(label)}).click(); })()`);
  await sleep(150);
}

const TESTS = {
  async 'load: nothing edited, save writes nothing'(env, page) {
    eq(await dirty(page), 0, 'edited files after load');
    await page.save();
    untouched(env, 'main.tex', 'sections/body.tex');
    has(await page.pageText(), 'The quick brown fox', 'page text');
  },

  async 'typing then saving writes exactly the edit'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' Indeed');
    await page.waitFor('editedFiles().length === 1');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog Indeed.');
    untouched(env, 'sections/body.tex');
    eq(await dirty(page), 0, 'edited files after saving');
  },

  async 'two saves in a row both reach the disk'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' one');
    await page.save();
    await page.select('lazy dog one', 'end');
    await page.type(' two');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog one two.');
    eq(await page.banner(), '', 'banner after two saves');
  },

  async 'pressing save twice quickly does not conflict with itself'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' X');
    await page.key('s', { ctrl: true });
    await page.key('s', { ctrl: true });
    await page.waitFor("typeof SAVING === 'undefined' || !SAVING");
    await sleep(300);
    await page.waitFor("typeof SAVING === 'undefined' || !SAVING");
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog X.');
    hasNot(await page.banner(), 'changed on disk', 'banner');
    eq(await page.eval(`$('#external').hidden`), true, 'conflict dialog hidden');
  },

  async 'edits in an input file save to that file only'(env, page) {
    await page.select('Detail text', 'end');
    await page.type(' extra');
    await page.save();
    onlyChange(env, 'sections/body.tex', 'Detail text', 'Detail text extra');
    untouched(env, 'main.tex');
  },

  async 'no self-conflict after a save and the rebuild that follows'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' Z');
    await page.save();
    await sleep(4500);   // build + several polls
    eq(await page.eval(`$('#external').hidden`), true, 'the external-change dialog must not open for our own save');
    eq(await dirty(page), 0, 'edited files');
    has(await page.pageText(), 'lazy dog Z', 'page text');
  },

  async 'edits typed after a save survive the reload after the build'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' A');
    await page.save();
    await page.select('Final words', 'end');
    await page.type(' kept');
    await page.eval(`lastTyping = 0`);     // let the poller reload now
    await sleep(4500);
    has(await page.pageText(), 'Final words kept', 'unsaved edit after the reload');
    await page.save();
    eq(env.read('main.tex'), MAIN.replace('lazy dog.', 'lazy dog A.').replace('Final words', 'Final words kept'), 'main.tex');
  },

  async 'a new build reloads the numbers'(env, page) {
    const v = await page.eval('AUXVER');
    await page.select('lazy dog', 'end');
    await page.type(' B');
    await page.save();
    await page.waitFor(`AUXVER > ${v}`, 8000, 'the page to see the new build');
    await page.waitFor(`DOC.auxver === AUXVER`, 8000, 'the page to reload after the build');
  },

  async 'maths: \\displaylimits puts the limits below in a display and beside inline'(env, page) {
    env.write('sections/body.tex', BODY.replace('Detail text lives here.', String.raw`Inline $\mathop{\Pr}\displaylimits_{x}[a]$ and
\[
  \mathop{\Pr}\displaylimits_{y}[b]
\]
done.`));
    await page.waitFor(`document.querySelector('#doc').innerText.includes('done.')`, 8000, 'the page to reload');
    const r = await page.eval(`[...document.querySelectorAll('#doc .math')].filter((m) => /displaylimits/.test(m.dataset.src || ''))
      .map((m) => ({ under: !!m.querySelector('munder'), sub: !!m.querySelector('msub') }))`);
    eq(JSON.stringify(r), JSON.stringify([{ under: false, sub: true }, { under: true, sub: false }]), 'inline, then display');
  },

  async 'external change to an unedited file reloads silently'(env, page) {
    env.write('sections/body.tex', BODY.replace('Detail text', 'Changed outside'));
    await page.waitFor(`document.querySelector('#doc').innerText.includes('Changed outside')`, 8000, 'the page to reload');
    eq(await page.eval(`$('#external').hidden`), true, 'no dialog when nothing is edited');
    eq(await dirty(page), 0, 'edited files');
  },

  async 'external change to an edited file asks, and Reload takes the disk version'(env, page) {
    await page.select('Detail text', 'end');
    await page.type(' mine');
    await page.eval(`lastTyping = 0`);
    env.write('sections/body.tex', BODY.replace('Detail text', 'Theirs'));
    await page.waitFor(`!$('#external').hidden`, 8000, 'the conflict dialog');
    has(await page.eval(`$('#external-files').textContent`), 'sections/body.tex', 'dialog lists the file');
    await page.eval(`$('#external-reload').click()`);
    await page.waitFor(`document.querySelector('#doc').innerText.includes('Theirs')`);
    eq(await dirty(page), 0, 'edited files after reload');
  },

  async 'external change to an edited file: Overwrite writes my version'(env, page) {
    await page.select('Detail text', 'end');
    await page.type(' mine');
    await page.eval(`lastTyping = 0`);
    env.write('sections/body.tex', BODY.replace('Detail text', 'Theirs'));
    await page.waitFor(`!$('#external').hidden`, 8000, 'the conflict dialog');
    await page.eval(`$('#external-overwrite').click()`);
    await page.waitFor(`(typeof SAVING === 'undefined' || !SAVING) && $('#external').hidden`);
    await page.waitFor(`editedFiles().length === 0`);
    onlyChange(env, 'sections/body.tex', 'Detail text', 'Detail text mine');
  },

  async 'external change to an edited file: Later keeps my edits through reloads'(env, page) {
    await page.select('Detail text', 'end');
    await page.type(' mine');
    await page.eval(`lastTyping = 0`);
    env.write('sections/body.tex', BODY.replace('Detail text', 'Theirs'));
    await page.waitFor(`!$('#external').hidden`, 8000, 'the conflict dialog');
    await page.eval(`$('#external-later').click()`);
    // another file changes on disk: the page reloads, my edit must stay
    env.write('main.tex', MAIN.replace('Final words', 'Last words'));
    await page.waitFor(`document.querySelector('#doc').innerText.includes('Last words')`, 8000, 'the reload');
    has(await page.pageText(), 'Detail text mine', 'my unsaved edit');
    // saving it must not silently overwrite the other version: it asks
    await page.save();
    eq(env.read('sections/body.tex'), BODY.replace('Detail text', 'Theirs'), 'the disk version is kept until I choose');
    await page.waitFor(`!$('#external').hidden`, 8000, 'the conflict dialog after a refused save');
  },

  async 'render: multline and text accents keep their original LaTeX'(env, page) {
    const src = String.raw`\begin{multline*}x=1\\y=2\end{multline*}`;
    const accented = String.raw`\c{C}`;
    const result = await page.eval(`(() => {
      const m = mathChip(${JSON.stringify(src)}, true);
      const c = renderChip(L.tokenize(${JSON.stringify(accented)})[0], {});
      return { bad: m.classList.contains('bad'), katex: !!m.querySelector('.katex'),
        original: m.dataset.src, accent: c.textContent, accentSource: c.dataset.src };
    })()`);
    eq(result.bad, false, 'multline must render without a KaTeX error');
    eq(result.katex, true, 'multline must contain typeset KaTeX');
    eq(result.original, src, 'math source must be unchanged');
    eq(result.accent, 'Ç', 'text accent must be typeset');
    eq(result.accentSource, accented, 'accent source must be unchanged');
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  async 'render: Portuguese acknowledgments keep accents and exact LaTeX'(env, page) {
    const source = 'Funda\\c{c}\\~ao para a Ci\\^encia e a Tecnologia (\\protect\\url{https://doi.org/10.54499/UID/50014/2025})';
    const expression = [
      '(() => {',
      'const source = ' + JSON.stringify(source) + ';',
      'const tokens = L.tokenize(source);',
      'const host = document.createElement("div");',
      'host.className = "para"; host.style.width = "240px"; document.body.append(host);',
      'renderTokens(tokens, host, {});',
      'const url = host.querySelector(".chip.ec");',
      'const result = {',
      ' visible: host.textContent, raw: L.serializeTokens(tokens), source: ser(host),',
      ' protect: [...host.querySelectorAll(".chip.hidden")].filter((c) => c.dataset.src === "\\\\protect").length,',
      ' accents: [...host.querySelectorAll(".chip.char")].map((c) => [c.textContent, c.dataset.src]),',
      ' wrap: url ? getComputedStyle(url).overflowWrap : ""',
      '};',
      'host.remove(); return result;',
      '})()',
    ].join('\n');
    const view = await page.eval(expression);
    has(view.visible, 'Fundação', 'cedilla and unbraced tilde render as Portuguese');
    has(view.visible, 'Ciência', 'unbraced circumflex renders as Portuguese');
    eq(view.visible.includes('\\protect'), false, 'protect command must not be visible');
    eq(view.protect, 1, 'protect must remain in the original source');
    eq(view.raw, source, 'tokens round-trip exactly');
    eq(view.source, source, 'DOM round-trips exactly');
    eq(view.wrap, 'anywhere', 'the DOI should be allowed to wrap');
    eq(view.accents.some(([shown, raw]) => shown === 'ã' && raw === '\\~a'), true,
      'the unbraced accent keeps its exact LaTeX in data-src');
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  async 'render: a quote environment is a block quote, edited in place and saved exactly'(env, page) {
    const view = await page.eval(`(() => {
      const seg = ORDER.find((s) => s.kind === 'quote');
      if (!seg) return { seg: false };
      const bq = seg.el.querySelector('blockquote');
      const cs = bq ? getComputedStyle(bq) : null;
      return { seg: true, tag: bq && bq.tagName, editable: bq && bq.contentEditable, text: bq && bq.textContent,
        marginLeft: cs && parseFloat(cs.marginLeft), border: cs && (cs.borderLeftWidth + ' ' + cs.borderLeftStyle),
        inPara: !!ORDER.find((s) => s.kind === 'para' && s.src.includes('A quoted sentence')) };
    })()`);
    eq(view.seg, true, 'a quote segment exists');
    eq(view.tag, 'BLOCKQUOTE', 'rendered as a blockquote element');
    eq(view.editable, 'true', 'the quote is editable in place');
    has(view.text, 'A quoted sentence from another paper.', 'the quote text is shown');
    eq(view.inPara, false, 'the quote is not inline in a paragraph');
    if (!(view.marginLeft > 0)) throw new Error('the quote is not indented: margin-left=' + view.marginLeft);
    eq(view.border, '3px solid', 'a left rule marks the quote');
    await page.select('A quoted sentence', 'end');
    await page.typeKeys(' (edited)');
    await page.save();
    onlyChange(env, 'main.tex', 'A quoted sentence from another paper.', 'A quoted sentence (edited) from another paper.');
  },

  async 'wrap: $ around a selection makes it maths and keeps the text'(env, page) {
    await page.select('brown');
    await page.key('$', { shift: true });
    await page.save();
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick $brown$ fox');
  },

  async 'wrap: brackets, braces and quotes around a selection'(env, page) {
    await page.select('quick');
    await page.key('(', { shift: true });
    await page.select('lazy');
    await page.key(']');
    await page.select('fox');
    await page.key('{', { shift: true });
    await page.select('jumps');
    await page.key('"', { shift: true });
    await page.save();
    onlyChange(env, 'main.tex', 'The quick brown fox jumps over the lazy dog.',
      "The (quick) brown \\{fox\\} ``jumps'' over the [lazy] dog.");
  },

  async 'wrap: the closing key wraps too, and the selection stays on the text'(env, page) {
    await page.select('quick');
    await page.key(')', { shift: true });
    eq(await page.eval(`getSelection().toString()`), 'quick', 'selection after wrapping');
    await page.key('[');
    await page.save();
    onlyChange(env, 'main.tex', 'The quick brown', 'The ([quick]) brown');
  },

  async 'wrap: a selection with maths inside'(env, page) {
    await page.eval(`(() => {
      const seg = ORDER.find((s) => s.kind === 'para' && s.src.includes('We study'));
      const m = seg.edit.querySelector('.chip.math');
      const r = document.createRange();
      r.setStart(m.previousSibling, m.previousSibling.data.indexOf('study'));
      r.setEnd(m.nextSibling, m.nextSibling.data.indexOf('here') + 4);
      seg.edit.focus(); getSelection().removeAllRanges(); getSelection().addRange(r);
    })()`);
    await page.key('(', { shift: true });
    await page.save();
    onlyChange(env, 'main.tex', 'We study $x^2 + y^2$ here.', 'We (study $x^2 + y^2$ here).');
  },

  async 'no selection: brackets, quotes and $ type normally or open maths'(env, page) {
    await page.select('lazy dog', 'end');
    await page.typeKeys(' (a) [b] "c"');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog (a) [b] "c".');
  },

  async '$ with no selection types a dollar sign'(env, page) {
    await page.select('lazy dog', 'end');
    await page.key('$', { shift: true });
    await sleep(100);
    eq(await page.eval(`$('#drawer').hidden`), true, 'no formula editor');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog\\$.');
  },

  async 'Ctrl+M with no selection opens a new formula'(env, page) {
    await page.select('lazy dog', 'end');
    await page.key('m', { ctrl: true });
    await page.waitFor(`!$('#drawer').hidden`);
    await page.eval(`$('#drawer-src').value = '$z$'; $('#drawer-src').dispatchEvent(new Event('input'))`);
    await page.key('Enter', { ctrl: true });
    await page.waitFor(`$('#drawer').hidden`);
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog$z$.');
  },

  async 'paste: $...$ becomes maths'(env, page) {
    const before = await page.eval(`document.querySelectorAll('#doc .chip.math').length`);
    await page.select('lazy dog', 'end');
    await page.paste(' where $a_1 + b$ and $$c^2$$ and \\(d\\) hold');
    eq(await page.eval(`document.querySelectorAll('#doc .chip.math').length`), before + 3, 'maths chips on the page');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog where $a_1 + b$ and $$c^2$$ and \\(d\\) hold.');
  },

  async 'paste: text with special characters is escaped, a lone $ stays a dollar'(env, page) {
    await page.select('lazy dog', 'end');
    await page.paste(' costs 5$ or 50% & a_b');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog costs 5\\$ or 50\\% \\& a\\_b.');
  },

  async 'paste: zero-width spaces from web pages are dropped'(env, page) {
    await page.select('lazy dog', 'end');
    await page.paste(' under $\\pi_1$​, on﻿ it');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog under $\\pi_1$, on it.');
  },

  async 'text characters: \\textless shows as <, a saved \\textbackslash made maths is a backslash'(env, page) {
    env.write('main.tex', FILES['main.tex'].replace('lazy dog.', 'lazy dog \\textless{} \\textbackslash{}G1 end.'));
    await page.eval('load(true)');
    await page.waitFor(`ORDER.some((s) => s.src && s.src.includes('textless'))`, 8000, 'the reloaded text');
    has(await page.eval(`ORDER.find((s) => s.src.includes('textless')).edit.textContent`), 'lazy dog < \\G1 end', 'shown as the characters');
    await page.eval(`(() => {
      const ed = ORDER.find((s) => s.src.includes('textless')).edit;
      const c = [...ed.querySelectorAll('.chip.char')].find((x) => x.textContent === '\\\\');
      const r = document.createRange(); r.setStartBefore(c); r.setEnd(c.nextSibling, 2);
      ed.focus(); getSelection().removeAllRanges(); getSelection().addRange(r);
    })()`);
    await page.key('$'); await sleep(100);
    await page.save();
    has(env.read('main.tex'), 'lazy dog \\textless{} $\\G1$ end.', 'maths with a backslash');
  },

  async 'paste over a selection replaces it'(env, page) {
    await page.select('brown');
    await page.paste('$\\beta$');
    await page.save();
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick $\\beta$ fox');
  },

  async 'copy and paste inside the editor keeps maths and references'(env, page) {
    await page.eval(`(() => {
      const seg = ORDER.find((s) => s.kind === 'para' && s.src.includes('We study'));
      const m = seg.edit.querySelector('.chip.math');
      const r = document.createRange();
      r.setStart(m.previousSibling, m.previousSibling.data.indexOf('We'));
      r.setEnd(m.nextSibling, m.nextSibling.data.length);
      seg.edit.focus(); getSelection().removeAllRanges(); getSelection().addRange(r);
    })()`);
    const clip = await page.copy();
    has(clip['text/plain'] || '', '$x^2 + y^2$', 'plain text of a copy');
    await page.select('Final words', 'end');
    await page.paste(clip['text/plain'], Object.fromEntries(Object.entries(clip).filter(([k]) => k !== 'text/plain')));
    await page.save();
    onlyChange(env, 'main.tex', 'Final words', 'Final wordsWe study $x^2 + y^2$ here.');
  },

  async 'paste: LaTeX commands and a tie in plain text become chips'(env, page) {
    await page.select('lazy dog', 'end');
    await page.paste(' see Section~\\ref{sec:body} and \\textbf{bold}');
    const r = await page.eval(`(() => {
      const seg = ORDER.find((s) => s.kind === 'para' && s.src.includes('lazy dog'));
      const ref = seg.edit.querySelector('.chip.ref');
      const tie = seg.edit.querySelector('.chip.tie');
      const strong = seg.edit.querySelector('strong');
      return { ref: ref && ref.dataset.src, tie: tie && tie.dataset.src,
        strong: strong && strong.dataset.prefix, refText: ref && ref.textContent,
        want: labelValue('sec:body') || '??' };
    })()`);
    eq(r.ref, String.raw`\ref{sec:body}`, 'the pasted \\ref is a reference chip');
    eq(r.tie, '~', 'the pasted ~ is a tie chip');
    eq(r.strong, String.raw`\textbf{`, 'the pasted \\textbf wraps its text');
    eq(r.refText, r.want, 'the chip shows the section number from the .aux');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog see Section~\\ref{sec:body} and \\textbf{bold}.');
  },

  async 'typing $...$ makes the typed text maths when the closing $ is typed'(env, page) {
    await page.select('lazy dog', 'end');
    await page.key('$', { shift: true });
    await page.type('x^2');
    await page.key('$', { shift: true });
    const src = await page.eval(`(() => {
      const seg = ORDER.find((s) => s.kind === 'para' && s.src.includes('lazy dog'));
      const m = seg.edit.querySelector('.chip.math');
      return m && m.dataset.src;
    })()`);
    eq(src, '$x^2$', 'the dollars and the text between them are one maths chip');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog$x^2$.');
  },

  async 'typing $ around a price stays a dollar sign'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' costs 5');
    await page.key('$', { shift: true });
    await page.type(' or 10');
    await page.key('$', { shift: true });
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog costs 5\\$ or 10\\$.');
  },

  async 'Enter splits a paragraph, and editing after the save still works'(env, page) {
    await page.select('jumps', 'start');
    await page.key('Enter');
    await page.save();
    onlyChange(env, 'main.tex', 'fox jumps', 'fox \n\njumps');
    eq(await page.eval(`document.querySelectorAll('#doc .chip.parbreak').length`), 0, 'the page is parsed again');
    await page.select('lazy dog', 'end');
    await page.type('s');
    await page.save();
    onlyChange(env, 'main.tex', 'fox jumps over the lazy dog', 'fox \n\njumps over the lazy dogs');
    eq(await page.banner(), '', 'banner');
  },

  async 'Backspace at the start of a paragraph joins it to the one before'(env, page) {
    await page.select('A second', 'start');
    await page.key('Backspace');
    await page.save();
    onlyChange(env, 'main.tex', 'here.\n\nA second', 'here.\nA second');
  },

  async 'adding a paragraph with the + menu'(env, page) {
    await page.eval(`ORDER.find((s) => s.kind === 'para' && s.src.includes('Other papers')).el.querySelector('.tools button').click()`);
    await page.eval(`[...$('#menu').querySelectorAll('button')].find((b) => b.textContent === 'Paragraph').click()`);
    eq(await page.eval(`getSelection().toString()`), 'Write here.', 'the placeholder is selected');
    await page.type('Brand new.');
    await page.save();
    onlyChange(env, 'main.tex', 'Other papers exist.\n', 'Other papers exist.\n\nBrand new.\n');
  },

  async 'find and replace all'(env, page) {
    await page.key('h', { ctrl: true });
    await page.eval(`$('#find-q').value = 'Final'; $('#find-q').dispatchEvent(new Event('input')); $('#find-r').value = 'Last'`);
    await page.eval(`$('#find-all').click()`);
    await page.save();
    onlyChange(env, 'main.tex', 'Final words', 'Last words');
  },

  async 'cut removes the selection and keeps its LaTeX'(env, page) {
    await page.eval(`(() => {
      const seg = ORDER.find((s) => s.kind === 'para' && s.src.includes('We study'));
      const m = seg.edit.querySelector('.chip.math');
      const r = document.createRange();
      r.setStart(m.previousSibling, m.previousSibling.data.indexOf('study'));
      r.setEnd(m.nextSibling, 0);
      seg.edit.focus(); getSelection().removeAllRanges(); getSelection().addRange(r);
    })()`);
    const clip = await page.copy('cut');
    eq(clip['text/plain'], 'study $x^2 + y^2$', 'plain text');
    await page.save();
    onlyChange(env, 'main.tex', 'We study $x^2 + y^2$ here.', 'We here.');   // the house rules take out the double space
  },

  async 'figure caption edits save'(env, page) {
    await page.select('A caption here', 'end');
    await page.type(' and more');
    await page.save();
    onlyChange(env, 'main.tex', 'A caption here.', 'A caption here and more.');
  },

  async 'deleting a whole middle sentence leaves no blank line'(env, page) {
    env.write('main.tex', [
      '\\documentclass{article}', '\\begin{document}',
      'First line.', 'Middle line.', 'Last line.', '',
      '\\begin{figure}[t]', '\\fbox{box}', '\\caption{One here.', 'Two here.', 'Three here.}', '\\end{figure}',
      '\\end{document}', ''].join('\n'));
    await page.eval('load(true)');
    await page.waitFor(`ORDER.some((s) => s.kind === 'figure' && s.edit)`, 8000, 'the figure');
    for (const s of ['Middle line.', 'Two here.']) {
      await page.select(s);
      await page.key('Backspace');
    }
    await page.save();
    const text = env.read('main.tex');
    has(text, 'First line.\nLast line.', 'the paragraph keeps one line break');
    has(text, '\\caption{One here.\nThree here.}', 'the caption keeps one line break');
  },

  async 'frontmatter: no deletion takes \\begin{abstract} or \\end{abstract} alone'(env, page) {
    const src = ['\\documentclass{article}', '\\begin{document}', '', '\\maketitle', '',
      'A visible paragraph before.', '', '\\keywords{K}', '', '\\begin{abstract}', 'First abstract sentence.', 'Second abstract sentence.', '\\end{abstract}', '',
      'After the abstract.', '', '\\end{document}', ''].join('\n');
    const fresh = async () => { env.write('main.tex', src); await page.eval('load(true)'); await page.waitFor(`document.querySelector('#doc .chip.runin')`, 8000, 'the abstract'); };
    const nodeOf = (t) => `(() => { for (const ed of document.querySelectorAll('#doc [contenteditable=true]')) { const w = document.createTreeWalker(ed, 4); let n; while ((n = w.nextNode())) if (n.data.includes(${JSON.stringify(t)})) return n; } })()`;
    // Backspace at the start of the abstract: the hidden line break and \begin stay
    await fresh();
    await page.select('First abstract', 'start');
    for (let i = 0; i < 3; i++) await page.key('Backspace');
    await page.save();
    eq(env.read('main.tex'), src, 'Backspace at the start of the abstract');
    // Delete at its end: \end stays
    await page.select('Second abstract sentence.', 'end');
    for (let i = 0; i < 3; i++) await page.key('Delete');
    await page.save();
    eq(env.read('main.tex'), src, 'Delete at the end of the abstract');
    // a selection from the paragraph above into the abstract: the paragraph
    // goes, \keywords (not shown) and \begin{abstract} stay
    await page.eval(`(() => { const r = document.createRange(); r.setStart(${nodeOf('A visible')}, 0); r.setEnd(${nodeOf('First abstract')}, 0); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await page.key('Backspace');
    await page.save();
    eq(env.read('main.tex'), src.replace('A visible paragraph before.\n\n', ''), 'selection into the abstract');
    // typing over "Abstract. First": the text goes inside the abstract
    await fresh();
    await page.eval(`(() => { const c = document.querySelector('#doc .chip.runin'); const r = document.createRange(); r.setStartBefore(c); r.setEnd(${nodeOf('First abstract')}, 5); c.parentElement.focus(); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await page.key('x');
    await page.save();
    eq(env.read('main.tex'), src.replace('\\begin{abstract}\nFirst', '\\begin{abstract}\nx'), 'typing over the start of the abstract');
    // a selection from the abstract into the next paragraph keeps \end
    await fresh();
    await page.eval(`(() => { const r = document.createRange(); r.setStart(${nodeOf('Second abstract')}, 0); r.setEnd(${nodeOf('After the')}, 5); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await page.key('Backspace');
    await page.save();
    const text = env.read('main.tex');
    has(text, '\\begin{abstract}\nFirst abstract sentence.\n', 'the abstract keeps its first sentence');
    has(text, '\\end{abstract}', 'the abstract keeps its end');
    hasNot(text, 'Second abstract', 'the selected text goes');
  },

  async 'frontmatter: an edit that takes a hidden \\maketitle is undone'(env, page) {
    const src = ['\\documentclass{article}', '\\begin{document}', '', 'Some text \\maketitle more text.', '', 'Plain words here.', '', '\\end{document}', ''].join('\n');
    env.write('main.tex', src);
    await page.eval('load(true)');
    await page.waitFor(`[...document.querySelectorAll('#doc [contenteditable=true]')].some((e) => e.textContent.includes('Some text'))`, 8000, 'the paragraph');
    const nodeOf = (t) => `(() => { for (const ed of document.querySelectorAll('#doc [contenteditable=true]')) { const w = document.createTreeWalker(ed, 4); let n; while ((n = w.nextNode())) if (n.data.includes(${JSON.stringify(t)})) return n; } })()`;
    // a selection over the hidden \maketitle, deleted by the browser
    await page.eval(`(() => { const a = ${nodeOf('Some text')}, b = ${nodeOf('more text')}; const r = document.createRange(); r.setStart(a, 5); r.setEnd(b, 4); a.parentElement.closest('[contenteditable=true]').focus(); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await page.key('Backspace');
    await page.save();
    eq(env.read('main.tex'), src, 'the deletion is undone');
    // a deletion that keeps the balance goes through
    await page.select('here.', 'end');
    for (let i = 0; i < 6; i++) await page.key('Backspace');
    await page.save();
    has(env.read('main.tex'), 'Plain words\n', 'a plain deletion is kept');
    has(env.read('main.tex'), '\\maketitle', 'the title stays');
  },

  async 'merge: two sections of one file, then undo'(env, page) {
    const src = ['\\documentclass{article}', '\\begin{document}', '',
      '\\section{Alpha}\\label{sec:a}', 'Alpha text.', '', '\\subsection{A one}', 'A one text.', '',
      '\\section{Beta}\\label{sec:b}', 'Beta text.', '', '\\subsection{B one}', 'B one text.', '',
      'See \\Cref{sec:b}.', '', '\\end{document}', ''].join('\n');
    await mergeFresh(env, page, { 'main.tex': src });
    await mergeStart(page, 'Beta');
    has(await page.eval(`$('#ask-text').textContent`), '1 reference to sec:b', 'the question names the reference');
    await mergeAnswer(page, 'Merge');
    await page.save();
    let text = env.read('main.tex');
    has(text, '\\section{Alpha}\\label{sec:a}\\label{sec:b}\n', 'the label moves to the first heading');
    hasNot(text, '\\section{Beta}', 'the heading goes');
    if (!/A one text\.\n\nBeta text\.\n\n\\subsection\{B one\}/.test(text)) throw new Error('the text does not follow in order:\n' + text);
    await page.select('Alpha text.', 'end');
    await page.key('z', { ctrl: true });
    await page.save();
    eq(env.read('main.tex'), src, 'one undo restores the file');
    // kept as a subsection: everything under it goes one level down
    await mergeStart(page, 'Beta');
    await mergeAnswer(page, 'Merge', true);
    await page.save();
    text = env.read('main.tex');
    has(text, '\\subsection{Beta}\\label{sec:b}\nBeta text.\n\n\\subsubsection{B one}', 'one level down');
    has(text, '\\section{Alpha}\\label{sec:a}\n', 'the first heading keeps its own label only');
  },

  async 'merge: refused for the first heading of a level'(env, page) {
    const src = ['\\documentclass{article}', '\\begin{document}', '', '\\section{Alpha}', 'Alpha text.', '',
      '\\section{Beta}', 'Beta text.', '', '\\subsection{B one}', 'B one text.', '', '\\end{document}', ''].join('\n');
    await mergeFresh(env, page, { 'main.tex': src });
    await mergeStart(page, 'Alpha', false);
    await mergeStart(page, 'B one', false);
    eq(await page.eval(`$('#askbox').hidden`), true, 'no question');
    eq(await page.eval(`FILES['main.tex'].text`), src, 'nothing changes');
  },

  async 'merge: sections in their own files'(env, page) {
    const main = ['\\documentclass{article}', '\\begin{document}', '', '\\input{sections/a}', '\\input{sections/b}', '', '\\end{document}', ''].join('\n');
    const a = '\\section{Ay}\nAy text.\n', b = '\\section{Bee}\\label{sec:b}\nBee text.\n';
    const files = { 'main.tex': main, 'sections/a.tex': a, 'sections/b.tex': b };
    await mergeFresh(env, page, files);
    await mergeStart(page, 'Bee');
    await mergeAnswer(page, 'Also merge the files');
    // undo before saving brings all of it back
    await page.select('Ay text.', 'end');
    await page.key('z', { ctrl: true });
    await page.save();
    for (const [n, t] of Object.entries(files)) eq(env.read(n), t, `undo: ${n}`);
    await mergeStart(page, 'Bee');
    await mergeAnswer(page, 'Also merge the files');
    await page.save();
    await page.waitFor(`!FILES['sections/b.tex']`, 6000, 'b.tex trashed');
    eq(env.read('sections/a.tex'), '\\section{Ay}\\label{sec:b}\nAy text.\n\nBee text.\n', 'a.tex has both texts');
    hasNot(env.read('main.tex'), 'sections/b', 'main.tex no longer reads b.tex');
    eq(fs.existsSync(path.join(env.paper, 'sections/b.tex')), false, 'b.tex moved away');
    if (!fs.readdirSync(path.join(env.state, 'trash')).some((f) => f.endsWith('b.tex'))) throw new Error('b.tex is not in the trash');
    // keep the files: only the heading line goes
    await mergeFresh(env, page, files);
    await mergeStart(page, 'Bee');
    await mergeAnswer(page, 'Keep the files');
    await page.save();
    eq(env.read('main.tex'), main, 'main.tex unchanged');
    eq(env.read('sections/a.tex'), '\\section{Ay}\\label{sec:b}\nAy text.\n', 'the label moves');
    eq(env.read('sections/b.tex').trim(), 'Bee text.', 'b.tex keeps its text');
    // the previous section in the file that reads b.tex: b.tex's text goes in its place
    const main2 = main.replace('\\input{sections/a}\n', a + '\n');
    await mergeFresh(env, page, { 'main.tex': main2, 'sections/b.tex': b });
    await mergeStart(page, 'Bee');
    await mergeAnswer(page, 'Also merge the files');
    await page.save();
    await page.waitFor(`!FILES['sections/b.tex']`, 6000, 'b.tex trashed');
    has(env.read('main.tex'), '\\section{Ay}\\label{sec:b}\nAy text.\n\nBee text.\n\n\\end{document}', 'the text is inlined');
    // a file with two sections: only "Keep the files"
    await mergeFresh(env, page, { ...files, 'sections/b.tex': b + '\n\\section{Cee}\nCee text.\n' });
    await mergeStart(page, 'Bee');
    eq(await page.eval(`[...$('#ask-actions').children].map((x) => x.textContent).join('|')`), 'Keep the files|Cancel', 'only keep');
    await mergeAnswer(page, 'Cancel');
  },

  async 'keys: C-g cancels, M-g goes to a line, the text is checked in en-GB'(env, page) {
    eq(await page.eval(`$('#doc').lang`), 'en-GB', 'the spelling language');
    // C-g drops a selection in the paper
    await selectSpan(page, 'quick', 'brown');
    await page.key('g', { ctrl: true });
    eq(await page.eval(`getSelection().isCollapsed`), true, 'the selection is dropped');
    // and closes the find bar, from its field
    await page.key('f', { ctrl: true });
    await page.waitFor(`!$('#findbar').hidden`, 2000, 'the find bar');
    await page.key('g', { ctrl: true });
    await page.waitFor(`$('#findbar').hidden`, 2000, 'the find bar closed');
    // in the source view: M-g goes to a line, C-g drops the selection and stays
    await page.eval('toggleSource(true)');
    await page.waitFor(`SRC.on && $('#srcta') && $('#srcta').value.length > 0`, 4000, 'the source view');
    await page.eval(`(() => { window.prompt = () => '3'; const ta = $('#srcta'); ta.focus(); ta.setSelectionRange(0, 5); })()`);
    await page.key('g', { ctrl: true });
    eq(await page.eval(`(() => { const ta = $('#srcta'); return JSON.stringify([SRC.on, ta.selectionStart === ta.selectionEnd]); })()`), '[true,true]', 'C-g stays in the source view');
    await page.key('g', { alt: true });
    eq(await page.eval(`(() => { const ta = $('#srcta'); return ta.value.slice(0, ta.selectionStart).split('\\n').length; })()`), 3, 'M-g went to line 3');
    await page.eval('toggleSource(false)');
  },

  async 'keys: a chord shows what can follow, and runs its action'(env, page) {
    await page.eval(`(() => { USER_KEYS = { save: ['C-c C-s'], undo: ['C-c u'] }; applyKeymap(); })()`);
    try {
      await typeAt(page, 'lazy dog.', ' Chord');
      await page.key('c', { ctrl: true });
      await page.waitFor(`!$('#whichkey').hidden`, 2000, 'the hint');
      const hint = await page.eval(`$('#whichkey').textContent`);
      has(hint, 'Ctrl+S', 'the next key');
      has(hint, 'Save', 'what it does');
      has(hint, 'Undo', 'the other action');
      await page.key('s', { ctrl: true });
      await page.waitFor(`$('#whichkey').hidden`, 2000, 'the hint closed');
      await page.waitFor(`FILES['main.tex'].disk.includes('lazy dog. Chord')`, 6000, 'the save');
      has(env.read('main.tex'), 'lazy dog. Chord', 'saved by the chord');
      // C-g in the middle of a chord drops it
      await page.key('c', { ctrl: true });
      await page.waitFor(`!$('#whichkey').hidden`, 2000, 'the hint');
      await page.key('g', { ctrl: true });
      eq(await page.eval(`JSON.stringify([$('#whichkey').hidden, PREFIX])`), '[true,null]', 'the chord is dropped');
      // Keys… records two presses less than a second apart as a chord
      await page.eval(`(() => { openKeys(); [...document.querySelectorAll('#keys-list .keyrow')].find((r) => r.firstChild.textContent === 'Find').querySelector('button').click(); })()`);
      await page.key('x', { ctrl: true });
      await page.key('f', { ctrl: true });
      await page.waitFor(`!RECORDING`, 3000, 'the recording to end');
      eq(await page.eval(`JSON.stringify(KEYS_DRAFT.find)`), '["C-x C-f"]', 'the chord recorded');
      await page.eval(`$('#keys-close').click()`);
    } finally {
      await page.eval(`(() => { USER_KEYS = {}; applyKeymap(); })()`);
    }
  },

  async 'sidebar: contents, filter, a jump there and back'(env, page) {
    try {
      await page.key('o', { alt: true });
      await page.waitFor(`!$('#sidebar').hidden && document.activeElement === $('#sb-filter')`, 3000, 'the sidebar and its filter');
      const rows = await page.eval(`JSON.stringify([...document.querySelectorAll('#sb-list .sb-item')].map((r) => [r.className.match(/l\\d/)[0], r.querySelector('.sb-text').textContent]))`);
      eq(rows, JSON.stringify([['l0', 'Introduction'], ['l0', 'Related work'], ['l0', 'Body'], ['l1', 'Details'], ['l0', 'Conclusion']]), 'the headings, by level');
      await page.type('det');
      eq(await page.eval(`document.querySelectorAll('#sb-list .sb-item').length`), 1, 'the filter');
      await page.key('Enter');
      await page.waitFor(`caretSeg() && caretSeg().src.includes('Details')`, 3000, 'the caret in the heading');
      eq(await page.eval(`NAV.back.length > 0`), true, 'the way back is kept');
      // the section in view is marked
      const current = `(document.querySelector('#sb-list .sb-item.current .sb-text') || {}).textContent`;
      await page.eval(`(() => { toggleSidebar(true, false); $('#sb-filter').value = ''; drawSidebar(); scrollTo(0, 0); markCurrentSection(); })()`);
      eq(await page.eval(current), 'Introduction', 'the current section at the top');
      await page.eval(`(() => { ORDER.find((s) => s.kind === 'heading' && s.src.includes('Details')).el.scrollIntoView({ block: 'start' }); markCurrentSection(); })()`);
      eq(await page.eval(current), 'Details', 'the current section further down');
    } finally {
      await page.eval(`toggleSidebar(false)`);
    }
  },

  async 'sidebar: results with their numbers, titles and labels, and the source view'(env, page) {
    env.write('main.tex', ['\\documentclass{article}', '\\usepackage{amsthm}', '\\newtheorem{lemma}{Lemma}', '\\newtheorem{theorem}{Theorem}', '\\begin{document}', '',
      '\\section{Games}', 'Text.', '', '\\begin{lemma}[Hybrid two]\\label{lem:h2}', 'A claim.', '\\end{lemma}', '',
      '\\subsection{Main}', '\\begin{theorem}', 'Another claim.', '\\end{theorem}', '', '\\end{document}', ''].join('\n'));
    await page.eval('load(true)');
    await page.waitFor(`document.querySelector('#doc .chip.thmhead')`, 8000, 'the lemma');
    try {
      await page.eval(`(() => { toggleSidebar(true); $('#sb-tab-results').click(); })()`);
      const rows = await page.eval(`JSON.stringify([...document.querySelectorAll('#sb-list .sb-item')].map((r) => [r.querySelector('.sb-text').textContent, (r.querySelector('.sb-key') || {}).textContent || '']))`);
      eq(rows, JSON.stringify([['Lemma 1 (Hybrid two)', 'lem:h2'], ['Theorem 1', '']]), 'the results');
      await page.eval(`$('#sb-filter').value = 'h2'; $('#sb-filter').dispatchEvent(new Event('input'))`);
      await page.key('Enter');
      await page.waitFor(`caretSeg() && caretSeg().src.includes('A claim.')`, 3000, 'the caret in the lemma');
      // the source view: the headings of the file, and their lines
      await page.eval(`(() => { toggleSidebar(true, false); $('#sb-filter').value = ''; $('#sb-tab-contents').click(); toggleSource(true); })()`);
      await page.waitFor(`SRC.on && $('#srcta') && $('#srcta').value.includes('Games')`, 4000, 'the source view');
      await page.waitFor(`SIDEBAR.all.length === 2 && SIDEBAR.all.every((it) => it.line)`, 3000, 'the two headings of the file');
      await page.eval(`[...document.querySelectorAll('#sb-list .sb-item')].find((r) => r.textContent.includes('Main')).click()`);
      eq(await page.eval(`(() => { const ta = $('#srcta'); return ta.value.slice(0, ta.selectionStart).split('\\n').length; })()`), 14, 'the line of Main');
      await page.eval('toggleSource(false)');
    } finally {
      await page.eval(`toggleSidebar(false)`);
    }
  },

  async 'label rename: from the sidebar, in every file and reference, undone at once'(env, page) {
    const main = ['\\documentclass{article}', '\\usepackage{amsthm}', '\\usepackage{cleveref}', '\\newtheorem{lemma}{Lemma}', '\\begin{document}', '',
      '\\section{Games}\\label{sec:games}', 'Text.', '', '\\begin{lemma}[Hybrid two]\\label{lem:h2}', 'A claim.', '\\end{lemma}', '',
      '\\begin{lemma}\\label{lem:h22}', 'Another.', '\\end{lemma}', '',
      'By \\cref{lem:h2} and \\Cref{lem:h22, lem:h2}, \\crefrange{sec:games}{lem:h2}, \\hyperref[lem:h2]{this} and \\ref{lem:h22}.', '',
      '\\input{more}', '', '\\end{document}', ''].join('\n');
    const more = 'See \\eqref{lem:h2} and \\pageref{lem:h2}.\n';
    env.write('main.tex', main);
    env.write('more.tex', more);
    await page.eval('load(true)');
    await page.waitFor(`!!(document.querySelector('#doc .chip.thmhead') && FILES['more.tex'])`, 8000, 'the paper');
    const field = `document.querySelector('#sb-list .sb-keyedit')`;
    const rename = async (from, to) => {
      await page.eval(`(() => { toggleSidebar(true); $('#sb-tab-results').click(); const row = [...document.querySelectorAll('#sb-list .sb-item')].find((r) => (r.querySelector('.sb-key') || {}).textContent === ${JSON.stringify(from)}); row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
      await page.waitFor(`!!${field}`, 2000, 'the field');
      await page.eval(`(() => { const f = ${field}; f.value = ${JSON.stringify(to)}; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    };
    try {
      // refused: a space, or a key in use; nothing changes
      await rename('lem:h2', 'lem h2');
      await rename('lem:h2', 'lem:h22');
      eq(await page.eval(`FILES['main.tex'].text`), main, 'refused keys change nothing');
      await page.eval(`(() => { const f = ${field}; if (f) f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
      await rename('lem:h2', 'lem:hybrid2');
      await page.save();
      eq(env.read('main.tex'), main.replace('\\label{lem:h2}', '\\label{lem:hybrid2}').replace('\\cref{lem:h2}', '\\cref{lem:hybrid2}')
        .replace('\\Cref{lem:h22, lem:h2}', '\\Cref{lem:h22, lem:hybrid2}').replace('{sec:games}{lem:h2}', '{sec:games}{lem:hybrid2}')
        .replace('\\hyperref[lem:h2]', '\\hyperref[lem:hybrid2]'), 'main.tex');
      eq(env.read('more.tex'), 'See \\eqref{lem:hybrid2} and \\pageref{lem:hybrid2}.\n', 'more.tex');
      // one undo restores both files
      await page.select('A claim.', 'end');
      await page.key('z', { ctrl: true });
      await page.save();
      eq(env.read('main.tex'), main, 'undo: main.tex');
      eq(env.read('more.tex'), more, 'undo: more.tex');
    } finally {
      await page.eval(`toggleSidebar(false)`);
    }
  },

  async 'find: maths between $…$, by token, whole formula or any, and replaced'(env, page) {
    const src = ['\\documentclass{article}', '\\begin{document}', '',
      'Say hello $x_1 + y$ and $\\max$ and $\\exp$ and $\\mathsf{x}$, then Hello world $z$.', '', '\\end{document}', ''].join('\n');
    env.write('main.tex', src);
    await page.eval('load(true)');
    await page.waitFor(`!!document.querySelector('#doc .chip.math')`, 8000, 'the formulas');
    const count = async (q) => {
      await page.eval(`(() => { $('#find-q').value = ${JSON.stringify(q)}; $('#find-q').dispatchEvent(new Event('input')); })()`);
      return page.eval('FIND.matches.length');
    };
    await page.key('f', { ctrl: true });
    await page.waitFor(`!$('#findbar').hidden`, 2000, 'the find bar');
    eq(await count('$x$'), 2, '$x$: the token x, not \\max or \\exp');
    eq(await page.eval(`$('#find-lit').checked`), true, 'a $ turns maths on');
    eq(await count('$X$'), 0, 'maths keep their case');
    eq(await count('$=z$'), 1, '$=z$: the formula z');
    eq(await count('$= x_1+y $'), 1, 'spaces do not count');
    eq(await count('hello $$'), 1, 'hello followed by a formula, in either case');
    eq(await count('world $z$'), 1, 'text then maths');
    has(await page.eval(`$('#find-list').children[0].textContent`), 'Hello world $z$.', 'the context shows the maths as LaTeX');
    // replaced: the formula z becomes w
    await count('$=z$');
    await page.eval(`(() => { $('#find-r').value = '$w$'; })()`);
    await page.eval('replaceAllMatches()');
    await page.save();
    has(env.read('main.tex'), 'Hello world $w$.', 'the formula replaced');
    // with maths off, only the text is searched, as before
    await page.eval(`(() => { $('#find-lit').checked = false; })()`);
    eq(await count('hello'), 2, 'text only');
    // one row per match with its context; the arrows move, Enter stays there
    eq(await page.eval(`JSON.stringify([...$('#find-list').children].map((r) => r.querySelector('mark').textContent))`), '["hello","Hello"]', 'the list');
    has(await page.eval(`$('#find-list').children[0].textContent`), 'Say hello … and', 'the context (formulas as … with maths off)');
    await page.eval(`$('#find-q').focus()`);
    await page.key('ArrowDown');
    await page.key('ArrowDown');
    await page.key('Enter');
    await page.waitFor(`$('#findbar').hidden`, 2000, 'the bar closed');
    eq(await page.eval(`getSelection().toString().toLowerCase()`), 'hello', 'the match is selected');
  },

  async 'find: Ctrl+Shift+F searches the source of every .tex and .bib file'(env, page) {
    await page.select('lazy dog');
    await page.key('F', { ctrl: true, shift: true });
    await page.waitFor(`!$('#palette').hidden`, 3000, 'the palette');
    const rows = async (q) => {
      await page.eval(`(() => { $('#pal-q').value = ${JSON.stringify(q)}; $('#pal-q').dispatchEvent(new Event('input')); })()`);
      await sleep(300);
      return page.eval(`[...document.querySelectorAll('#pal-list .pal-item .main')].map((m) => m.textContent).join('|')`);
    };
    eq(await rows('dog lazy'), 'main.tex:6', 'words in any order, in main.tex');
    eq(await rows('detail text'), 'sections/body.tex:5', 'in an \\input file');
    eq(await rows('goldwasser'), 'refs.bib:2', 'in the .bib');
    await page.key('Enter');
    await page.waitFor(`SRC.on && SRC.name === 'refs.bib'`, 5000, 'the source view at the .bib');
    eq(await page.eval(`(() => { const ta = $('#srcta'); return ta.value.slice(0, ta.selectionStart).split('\\n').length; })()`), 2, 'at its line');
    await page.eval('toggleSource(false)');
  },

  async 'a caption or heading never gets a blank line'(env, page) {
    env.write('main.tex', [
      '\\documentclass{article}', '\\begin{document}',
      '\\section{A title}', '',
      '\\begin{figure}[t]', '\\fbox{box}', '\\caption{One here.', 'Two here.}', '\\end{figure}',
      '\\end{document}', ''].join('\n'));
    await page.eval('load(true)');
    await page.waitFor(`ORDER.some((s) => s.kind === 'figure' && s.edit)`, 8000, 'the figure');
    // what Chrome may leave after deleting across a line break: a <br>
    // beside the line break chip, a break typed into a heading
    await page.eval(`(() => {
      const fig = ORDER.find((s) => s.kind === 'figure').edit;
      fig.insertBefore(document.createElement('br'), fig.querySelector('.nl'));
      const h = ORDER.find((s) => s.kind === 'heading').edit;
      h.append(document.createElement('br'), document.createTextNode('more'));
      for (const s of ORDER) if (s.kind === 'figure' || s.kind === 'heading') s.touched = true;
    })()`);
    await page.save();
    const text = env.read('main.tex');
    has(text, '\\caption{One here.\nTwo here.}', 'the caption keeps one line break');
    has(text, '\\section{A title\nmore}', 'the heading keeps one line break');
  },

  async 'heading numbers come from the .aux only while it matches'(env, page) {
    env.write('main.tex', [
      '\\documentclass{article}', '\\begin{document}',
      '\\section{One}', '', '\\subsection{Gone}', '', '\\section{Two}', '', '\\subsection{Kept}', '',
      '\\appendix', '', '\\section{App}', '', '\\end{document}', ''].join('\n'));
    await page.eval('load(true)');
    await page.waitFor(`ORDER.filter((s) => s.kind === 'heading').length === 5`, 8000, 'the headings');
    const nums = () => page.eval(`ORDER.filter((s) => s.kind === 'heading').map((s) => (s.el.querySelector('.num') || {}).textContent || '').join(' ')`);
    // the .aux of a build with a References entry and custom numbers
    const aux = [['section', 'I'], ['subsection', 'I.a'], ['section', 'II'], ['subsection', 'II.a'], ['section', ''], ['section', 'Z']];
    // set again until no reload after the first build replaces it
    const heads = JSON.stringify(aux.map(([level, num]) => ({ level, num, title: '' })));
    await page.waitFor(`(DOC.aux.heads = ${heads}, render(), ORDER.find((s) => s.kind === 'heading').el.querySelector('.num').textContent === 'I.')`, 8000, 'the .aux numbers');
    eq(await nums(), 'I. I.a. II. II.a. Z.', 'the numbers of the .aux, References left out');
    // the subsection deleted before the next build: counted on the page
    await page.eval(`(() => { const t = FILES['main.tex']; t.text = t.text.replace('\\\\subsection{Gone}\\n\\n', ''); render(); })()`);
    eq(await nums(), '1. 2. 2.1. A.', 'counted while the .aux is stale');
  },

  async 'layout declarations are not shown'(env, page) {
    env.write('main.tex', [
      '\\documentclass{article}', '\\begin{document}',
      '{\\raggedright', '\\begin{itemize}', '  \\item An item.', '\\end{itemize}', '}', '',
      '\\end{document}', ''].join('\n'));
    await page.eval('load(true)');
    await page.waitFor(`document.querySelector('#doc').innerText.includes('An item')`, 8000, 'the list');
    hasNot(await page.eval(`document.querySelector('#doc').innerText`), 'raggedright', 'the page');
  },

  async 'a listing and a figure can be deleted, and undo brings them back'(env, page) {
    page.dialogAnswer = true;
    const before = env.read('main.tex');
    // the listing: its ✕ button
    await page.click(`js:ORDER.find((s) => s.kind === 'code').el.querySelector('.tools .deltool')`);
    await page.waitFor(`!ORDER.some((s) => s.kind === 'code' && !s.removed)`, 4000, 'the listing gone');
    // the figure: Ctrl+Alt+X with the cursor in its caption
    await page.select('A caption here');
    await page.key('x', { ctrl: true, alt: true });
    await page.waitFor(`!ORDER.some((s) => s.kind === 'figure' && !s.removed)`, 4000, 'the figure gone');
    await page.save();
    let text = env.read('main.tex');
    hasNot(text, 'code line', 'the listing');
    hasNot(text, 'A caption here', 'the figure');
    hasNot(text, '\n\n\n', 'a run of blank lines');
    has(page.dialogs.join('\n'), 'Delete this listing?', 'the question for the listing');
    has(page.dialogs.join('\n'), 'Delete this figure?', 'the question for the figure');
    await page.key('z', { ctrl: true });
    await page.key('z', { ctrl: true });
    await page.save();
    eq(env.read('main.tex'), before, 'the file after two undos');
  },

  async 'Ctrl+Alt+X in a listing deletes it; declining keeps it'(env, page) {
    page.dialogAnswer = false;
    await page.eval(`(() => { const ta = ORDER.find((s) => s.kind === 'code').edit; ta.focus(); ta.setSelectionRange(0, 0); })()`);
    await page.key('x', { ctrl: true, alt: true });
    has(page.dialogs.join('\n'), 'Delete this listing?', 'the question');
    eq(await page.eval(`ORDER.some((s) => s.kind === 'code' && !s.removed)`), true, 'the listing kept');
    page.dialogAnswer = true;
    await page.key('x', { ctrl: true, alt: true });
    await page.save();
    hasNot(env.read('main.tex'), 'code line', 'the listing');
  },

  async 'code block edits save'(env, page) {
    await page.eval(`(() => { const ta = ORDER.find((s) => s.kind === 'code').edit; ta.focus(); ta.setSelectionRange(ta.value.indexOf('line') + 4, ta.value.indexOf('line') + 4); })()`);
    await page.type(' two');
    await page.save();
    onlyChange(env, 'main.tex', 'code line', 'code line two');
  },

  async 'Ctrl+M on a selection makes maths from typed text'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' with x^2_i here');
    await page.select('x^2_i');
    await page.key('m', { ctrl: true });
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog with $x^2_i$ here.');
  },

  async 'undo restores the text'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' oops');
    await page.waitFor('editedFiles().length === 1');
    await page.key('z', { ctrl: true });
    await page.waitFor(`!document.querySelector('#doc').innerText.includes('oops')`, 4000, 'undo');
    eq(await dirty(page), 0, 'edited files after undo');
    await page.key('z', { ctrl: true, shift: true });
    await page.waitFor(`document.querySelector('#doc').innerText.includes('oops')`, 4000, 'redo');
  },

  async 'Ctrl+B and Ctrl+I wrap the selection'(env, page) {
    await page.select('quick');
    await page.key('b', { ctrl: true });
    await page.select('lazy');
    await page.key('i', { ctrl: true });
    await page.save();
    onlyChange(env, 'main.tex', 'The quick brown fox jumps over the lazy dog.',
      'The \\textbf{quick} brown fox jumps over the \\emph{lazy} dog.');
  },

  async 'house rules: declining saves the text as typed'(env, page) {
    page.dialogAnswer = false;
    await page.select('lazy dog', 'end');
    await page.type(' see Section ');
    await page.eval(`(() => { const r = getSelection().getRangeAt(0); const c = chip('ref', '\\\\ref{sec:body}', '2'); r.insertNode(c); setCaretAfter(c); })()`);
    await page.save();
    has(page.dialogs.join('\n'), 'House rules', 'the question');
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog see Section \\ref{sec:body}.');
    eq(await dirty(page), 0, 'edited files after saving');
  },

  async 'house rules: accepting adds the tie'(env, page) {
    page.dialogAnswer = true;
    await page.select('lazy dog', 'end');
    await page.type(' see Section ');
    await page.eval(`(() => { const r = getSelection().getRangeAt(0); const c = chip('ref', '\\\\ref{sec:body}', '2'); r.insertNode(c); setCaretAfter(c); })()`);
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog see Section~\\ref{sec:body}.');
    eq(await dirty(page), 0, 'edited files after saving');
  },

  async 'house rules: one sentence per line splits the changed line only'(env, page) {
    env.write('main.tex', [
      '\\documentclass{article}', '\\begin{document}',
      'Old one. Old two.', 'The lazy dog.', '',
      '\\end{document}', ''].join('\n'));
    await page.eval('load(true)');
    await page.waitFor(`document.querySelector('#doc').innerText.includes('lazy dog')`, 8000, 'the paragraph');
    await page.eval(`DOC.config.house_rules = { ...(DOC.config.house_rules || {}), one_sentence_per_line: true }`);
    page.dialogAnswer = true;
    await page.select('lazy dog', 'end');
    await page.type(' sleeps. Then e.g. Smith reads. And c.f. this');
    await page.save();
    const text = env.read('main.tex');
    has(text, 'Old one. Old two.\nThe lazy dog sleeps.\nThen e.g. Smith reads.\nAnd c.f. this.\n', 'the split');
    has(page.dialogs.join('\n'), 'one sentence per line', 'the question');
    has(await page.eval(`document.querySelector('#banner') ? document.querySelector('#banner').innerText : ''`), 'c.f. (cf.)', 'the misspelling named');
  },

  async 'house rules: declining one sentence per line keeps the line'(env, page) {
    env.write('main.tex', ['\\documentclass{article}', '\\begin{document}', 'The lazy dog.', '', '\\end{document}', ''].join('\n'));
    await page.eval('load(true)');
    await page.waitFor(`document.querySelector('#doc').innerText.includes('lazy dog')`, 8000, 'the paragraph');
    await page.eval(`DOC.config.house_rules = { ...(DOC.config.house_rules || {}), one_sentence_per_line: true }`);
    page.dialogAnswer = false;
    await page.select('lazy dog', 'end');
    await page.type(' sleeps. Then it wakes');
    await page.save();
    has(env.read('main.tex'), 'The lazy dog sleeps. Then it wakes.\n', 'the line as typed');
  },

  async 'move a section down and up keeps blank lines'(env, page) {
    const click = (title, button) => page.click(headBtn(title, button));
    await click('Introduction', 'Move this section down');
    await page.save();
    const t = env.read('main.tex');
    has(t, '\\begin{document}\n\\section{Related work}\nOther papers exist.\n\n\\section{Introduction}', 'the sections swapped');
    has(t, 'encryption schemes.\n\n\\input{sections/body}', 'the input stays, after a blank line');
    await click('Introduction', 'Move this section up');
    await page.save();
    eq(env.read('main.tex'), MAIN, 'moving it back gives the original file');
  },

  async 'moving a section never carries the end of the document; a section file moves as its input'(env, page) {
    const click = (title, button) => page.click(headBtn(title, button));
    await click('Conclusion', 'Move this section up');          // holds \end{document}
    has(await page.banner(), 'end of the document', 'banner');
    await click('Related work', 'Move this section down');      // next is \input{sections/body}, a whole section
    await page.save();
    const main = env.read('main.tex');
    if (!(main.indexOf('\\input{sections/body}') < main.indexOf('\\section{Related work}'))) throw new Error('the section file did not move:\n' + main);
    has(main, '\\end{document}', 'end of the document kept');
    untouched(env, 'sections/body.tex');
  },

  async 'undo and redo keep the text on screen where it was'(env, page) {
    // a paper long enough to scroll, with numbered paragraphs
    const paras = Array.from({ length: 60 }, (_, i) => `Paragraph number ${i} has enough words to wrap over a couple of lines in the editor, so that its height matters when the page is drawn again after a change.`);
    env.write('main.tex', '\\documentclass{article}\n\\begin{document}\n\\section{Long}\n' + paras.join('\n\n') + '\n\\end{document}\n');
    await page.eval('load(true)');
    await page.waitFor(`/Paragraph number 59/.test($('#doc').textContent)`, 8000, 'the long paper');
    // the server also notices the file changed and the page reloads it once
    // more: let that settle before placing the view
    await sleep(2500);
    const top = (n) => page.eval(`(() => { const s = ORDER.find((x) => x.kind === 'para' && x.src.startsWith('Paragraph number ${n} ')); return Math.round(s.el.getBoundingClientRect().top); })()`);
    const caret = (n, where) => page.eval(`(() => { const s = ORDER.find((x) => x.kind === 'para' && x.src.startsWith('Paragraph number ${n} ')); s.edit.focus({ preventScroll: true });
      const w = document.createTreeWalker(s.edit, NodeFilter.SHOW_TEXT); const t = w.nextNode(); const i = t.data.indexOf(${JSON.stringify(where)}) + ${where.length};
      const r = document.createRange(); r.setStart(t, i); r.collapse(true); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); })()`);
    // as a wheel would: the view held after the reload lets go
    await page.eval(`(() => { if (anchorHold) anchorHold(); const s = ORDER.find((x) => x.kind === 'para' && x.src.startsWith('Paragraph number 30 ')); window.scrollBy(0, s.el.getBoundingClientRect().top - 420); })()`);
    await sleep(300);
    const check = async (what) => {
      if (process.env.UNDO_DEBUG) console.log(what, JSON.stringify(await page.eval(`[scrollY, ...[27,28,29,30,31,32].map((n) => { const s = ORDER.find((x) => x.kind === 'para' && x.src.startsWith('Paragraph number ' + n + ' ')); return n + ':' + Math.round(s.el.getBoundingClientRect().top) + '/' + Math.round(s.el.getBoundingClientRect().height) + '/' + s.el.parentNode.dataset.page; })]`)));
      const y = await top(31);
      if (Math.abs(y - base) > 3) throw new Error(`${what}: paragraph 31 moved from ${base} to ${y}`);
    };
    // typing, a split and a join, each undone and redone, in paragraph 30 (on screen)
    await caret(30, 'enough words');
    const before = await top(30);
    await page.type(' extra');
    await sleep(300);
    const typed = await top(30);
    if (Math.abs(typed - before) > 3) throw new Error(`typing moved the paragraph from ${before} to ${typed}`);
    await sleep(300);
    const base = await top(31);
    if (process.env.UNDO_DEBUG) { const c = check; await c('before').catch(() => {}); }
    await page.key('z', { ctrl: true }); await sleep(500); await check('undo typing');
    await page.key('z', { ctrl: true, shift: true }); await sleep(500); await check('redo typing');
    await caret(29, 'drawn again');
    await page.key('Enter'); await sleep(500);
    const split = await top(31);
    await page.key('z', { ctrl: true }); await sleep(500);
    const y1 = await top(31);
    if (Math.abs(y1 - base) > 3 && Math.abs(y1 - split) > 3) throw new Error(`undo split: paragraph 31 jumped to ${y1} (was ${base}, ${split} after the split)`);
    await page.key('z', { ctrl: true, shift: true }); await sleep(500);
    const y2 = await top(31);
    if (Math.abs(y2 - split) > 3 && Math.abs(y2 - base) > 3) throw new Error(`redo split: paragraph 31 jumped to ${y2}`);
  },

  async 'files: To file moves a section into sections/, Undo takes it back, save writes it'(env, page) {
    await page.click(headBtn('Related work', 'Move this section into a file'));
    await page.waitFor(`!!FILES['sections/related-work.tex']`, 4000, 'the new file');
    has(await page.pageText(), 'Other papers exist.', 'the text still shows');
    await page.key('z', { ctrl: true });
    await page.waitFor(`editedFiles().length === 0`, 4000, 'undo to leave nothing to save');
    await page.click(headBtn('Related work', 'Move this section into a file'));
    await page.save();
    const main = env.read('main.tex');
    has(main, '\\input{sections/related-work}', 'the input');
    hasNot(main, 'Other papers exist.', 'the text left main.tex');
    eq(env.read('sections/related-work.tex'), '\\section{Related work}\nOther papers exist.\n', 'the section file');
    untouched(env, 'sections/body.tex');
  },

  async 'files: one file per section, named after labels and titles'(env, page) {
    await page.eval(`(window.confirm = () => true, splitAllSections())`);
    await page.save();
    const main = env.read('main.tex');
    has(main, '\\input{sections/intro}', 'named after its label');
    has(main, '\\input{sections/conclusion}', 'named after its title');
    has(main, '\\bibliography{refs}\n\\end{document}', 'the bibliography stays in main.tex');
    has(env.read('sections/intro.tex'), 'quick brown fox', 'the intro file');
    hasNot(env.read('sections/conclusion.tex'), 'bibliography', 'the conclusion file');
    untouched(env, 'sections/body.tex');
  },

  async 'house rules: the banner shows where, and closes'(env, page) {
    await page.eval(`(() => { const s = ORDER.find((x) => x.kind === 'para' && x.src.includes('Other papers')); s.edit.append(' See (', chip('ref', '\\\\cref{sec:intro}', 'Section 1'), ').'); s.touched = true; markEdited(); })()`);
    await page.eval(`window.confirm = () => true`);
    await page.save();
    await page.waitFor(`/bracketed/.test($('#banner').textContent)`, 4000, 'the warning');
    await page.eval(`[...$('#banner').querySelectorAll('.banner-act')].find((b) => /Show/.test(b.textContent)).click()`);
    await page.waitFor(`!!document.querySelector('#doc .seg.house-flag')`, 2000, 'the block flagged');
    await page.eval(`$('#banner .banner-close').click()`);
    await page.waitFor(`$('#banner').hidden`, 2000, 'the banner closed');
  },

  async 'source view: a new file, read by the document, saved with its input'(env, page) {
    await page.eval(`(() => { window.prompt = () => 'sections/extra.tex'; window.confirm = () => true; })()`);
    await page.select('Other papers exist.', 'end');
    await page.eval('toggleSource(true)');
    await page.waitFor(`SRC.on && SRC.name`, 4000, 'the source view');
    await page.eval('srcNewFile()');
    await page.waitFor(`SRC.name === 'sections/extra.tex'`, 6000, 'the new file open');
    eq(env.read('sections/extra.tex'), '% extra.tex\n', 'made on disk at once');
    if (process.env.SRC_DEBUG) console.log(await page.eval(`JSON.stringify({ main: FILES['main.tex'].text.includes('extra'), at: SRC.paperAt && SRC.paperAt.src.slice(0, 30), doc: !!DOC.files['sections/extra.tex'], files: SRC.files.filter((f) => f.name.includes('extra')) })`));
    // typed in the source view, then saved with the paper
    await page.eval(`(() => { const ta = $('#srcta'); ta.value = 'Extra words.\\n'; ta.dispatchEvent(new Event('input')); })()`);
    await sleep(600);
    await page.save();
    eq(env.read('sections/extra.tex'), 'Extra words.\n', 'its text');
    has(env.read('main.tex'), 'Other papers exist.\n\n\\input{sections/extra}', 'read after the block the cursor was in');
  },

  async 'source view: open in your editor; preview only follows the file on disk'(env, page) {
    const out = path.join(env.dir, 'editor-called');
    fs.writeFileSync(path.join(env.state, 'config.json'), JSON.stringify({ build: 'true',
      external_editor: ['sh', '-c', 'printf "%s:%s" "$1" "$2" > "$3"', 'sh', '{file}', '{line}', out] }));
    await env.stopServer(); await env.startServer();
    await page.select('lazy dog', 'end');
    await page.eval('toggleSource(true)');
    await page.waitFor(`SRC.on && SRC.name === 'main.tex'`, 4000, 'the source view');
    await page.eval('setSourcePreview(true)');
    eq(await page.eval(`$('#srcta').readOnly`), true, 'read only in preview');
    await page.click('#srcext');
    await page.waitFor(`true`, 100);
    for (let k = 0; k < 40 && !fs.existsSync(out); k++) await sleep(100);
    const called = fs.readFileSync(out, 'utf8');
    has(called, path.join(env.paper, 'main.tex') + ':', 'the editor got the file');
    const want = FILES['main.tex'].split('\n').findIndex((l) => l.includes('lazy dog')) + 1;
    eq(called.split(':').pop(), String(want), 'at the cursor\'s line');
    // the user's editor saves: the preview shows it
    env.write('main.tex', env.read('main.tex').replace('lazy dog.', 'lazy dog, edited outside.'));
    await page.waitFor(`$('#srcta').value.includes('edited outside')`, 15000, 'the preview following the disk');
    await page.eval('setSourcePreview(false)');
    eq(await page.eval(`$('#srcta').readOnly`), false, 'editable again');
  },

  async 'source view: opens at the place the paper shows, and goes back to the place it shows'(env, page) {
    const paras = Array.from({ length: 90 }, (_, i) => `Paragraph number ${i} has some words in it, enough to fill a line or two of the page here.`);
    env.write('main.tex', '\\documentclass{article}\n\\begin{document}\n' + paras.join('\n\n') + '\n\\end{document}\n');
    await page.eval('toggleSource(false)');
    await page.eval('load(true)');
    await page.waitFor(`ORDER.some((s) => s.src.includes('number 89'))`, 8000, 'the long text');
    const lineOf = (n) => 3 + 2 * n;      // paragraph n is on this line of main.tex
    // the paper with paragraph 40 at the top, the caret elsewhere (off screen)
    // (a wheel, as the reader's own scroll, ends the hold on the place after the reload)
    await page.eval(`(() => { dispatchEvent(new WheelEvent('wheel')); getSelection().removeAllRanges(); const s = ORDER.find((x) => x.src.includes('number 40 ')); window.scrollBy(0, s.el.getBoundingClientRect().top - chromeBottom() - 30); })()`);
    const y0 = await page.eval(`Math.round(ORDER.find((x) => x.src.includes('number 40 ')).el.getBoundingClientRect().top)`);
    await page.eval('toggleSource(true)');
    await page.waitFor(`SRC.on && SRC.name === 'main.tex'`, 4000, 'the source view');
    const r = await page.eval(`(() => { const ta = $('#srcta'); return { top: srcTopLine(), y: Math.round(ta.getBoundingClientRect().top + srcLineTop(${lineOf(40)}) - ta.scrollTop) }; })()`);
    if (Math.abs(r.top - lineOf(40)) > 2) throw new Error(`source opened at line ${r.top}, the paper showed line ${lineOf(40)}`);
    const taTop = await page.eval(`Math.round($('#srcta').getBoundingClientRect().top)`);
    if (Math.abs(r.y - Math.max(y0, taTop)) > 40) throw new Error(`line ${lineOf(40)} at ${r.y}px, its block was at ${y0}px (text box from ${taTop}px)`);
    // scrolled to paragraph 70 in the source: back in the paper, paragraph 70 is there
    await page.eval(`(() => { const ta = $('#srcta'); ta.blur(); ta.scrollTop = srcLineTop(${lineOf(70)}) - 50; ta.dispatchEvent(new Event('scroll')); })()`);
    const y1 = await page.eval(`Math.round($('#srcta').getBoundingClientRect().top + srcLineTop(${lineOf(70)}) - $('#srcta').scrollTop)`);
    await page.eval('toggleSource(false)');
    await sleep(100);
    const y2 = await page.eval(`Math.round(ORDER.find((x) => x.src.includes('number 70 ')).el.getBoundingClientRect().top)`);
    if (Math.abs(y2 - y1) > 40) throw new Error(`paragraph 70 at ${y2}px in the paper, its line was at ${y1}px`);
  },

  async 'source view: rename a document file and a bibliography; their readers follow'(env, page) {
    env.write('main.tex', env.read('main.tex'));
    await page.eval('toggleSource(true)');
    await page.waitFor(`SRC.on && SRC.name`, 4000, 'the source view');
    await page.eval(`openSourceFile('sections/body.tex')`);
    await page.eval(`(() => { window.prompt = () => 'sections/the-body.tex'; window.confirm = () => true; })()`);
    await page.eval('srcRename()');
    await page.waitFor(`SRC.name === 'sections/the-body.tex'`, 6000, 'the renamed file open');
    has(env.read('main.tex'), '\\input{sections/the-body}', 'the input follows');
    eq(fs.existsSync(path.join(env.paper, 'sections/body.tex')), false, 'the old name is gone');
    has(env.read('sections/the-body.tex'), '\\section{Body}', 'the text moved');
    await page.eval(`openSourceFile('refs.bib')`);
    await page.eval(`window.prompt = () => 'library.bib'`);
    await page.eval('srcRename()');
    await page.waitFor(`SRC.name === 'library.bib'`, 6000, 'the renamed bibliography');
    has(env.read('main.tex'), '\\bibliography{library}', '\\bibliography follows');
  },

  async 'source view: delete an unused file, and a file the document reads'(env, page) {
    await page.eval(`window.confirm = () => true`);
    await page.eval('toggleSource(true)');
    await page.waitFor(`SRC.on && SRC.name`, 4000, 'the source view');
    await page.eval(`openSourceFile('other.tex')`);
    await page.eval('srcDelete()');
    await page.waitFor(`SRC.name === DOC.main`, 6000, 'back on the main file');
    eq(fs.existsSync(path.join(env.paper, 'other.tex')), false, 'other.tex moved away');
    const trash = path.join(env.state, 'trash');
    if (!fs.readdirSync(trash).some((f) => f.endsWith('other.tex'))) throw new Error('other.tex is not in the trash');
    await page.eval(`openSourceFile('sections/body.tex')`);
    await page.eval('srcDelete()');
    await page.waitFor(`SRC.name === DOC.main && !FILES['sections/body.tex']`, 8000, 'body.tex deleted');
    hasNot(env.read('main.tex'), '\\input{sections/body}', 'its input taken out');
    eq(fs.existsSync(path.join(env.paper, 'sections/body.tex')), false, 'body.tex moved away');
    // the main file is never deleted or renamed here
    eq(await page.eval(`$('#srcdelete').disabled && $('#srcrename').disabled`), true, 'main file buttons off');
  },

  async 'drafts: unsaved edits survive a reload and come back on Restore'(env, page) {
    await page.select('brown');
    await page.type('red');
    await sleep(3500);                                  // a draft is kept every 3 s
    await page.send('Page.reload');                     // (the leave warning is accepted)
    await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0 && /Unsaved edits from/.test($('#banner').textContent)`, 15000, 'the offer');
    // textContent: just after a reload, blocks not laid out yet have no innerText
    has(await page.eval(`$('#doc').textContent`), 'quick brown fox', 'the page shows the file as on disk');
    await page.eval(`[...$('#banner').querySelectorAll('.banner-act')].find((b) => b.textContent === 'Restore').click()`);
    await page.waitFor(`/quick red fox/.test($('#doc').textContent)`, 4000, 'the edit back');
    await page.save();
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick red fox');
    eq(await page.eval(`Object.keys(localStorage).filter((k) => k.startsWith('draft:')).length`), 0, 'no draft left after saving');
  },

  async 'drafts: a file changed on disk since is not overwritten by a restored draft'(env, page) {
    await page.select('brown');
    await page.type('red');
    await sleep(3500);
    env.write('main.tex', MAIN.replace('lazy dog', 'sleepy dog'));
    await page.send('Page.reload');
    await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0 && /changed on disk since/.test($('#banner').textContent)`, 15000, 'the offer, with the warning');
    await page.eval(`[...$('#banner').querySelectorAll('.banner-act')].find((b) => b.textContent === 'Restore').click()`);
    await page.waitFor(`/quick red fox/.test($('#doc').textContent)`, 4000, 'the edit back');
    await page.key('s', { ctrl: true });
    await page.waitFor(`!$('#external').hidden`, 6000, 'the conflict choice');
    has(env.read('main.tex'), 'sleepy dog', 'the other version is still on disk');
    hasNot(env.read('main.tex'), 'quick red fox', 'not overwritten');
  },

  async 'drafts: Discard forgets them'(env, page) {
    await page.select('brown');
    await page.type('red');
    await sleep(3500);
    await page.send('Page.reload');
    await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0 && /Unsaved edits from/.test($('#banner').textContent)`, 15000, 'the offer');
    await page.eval(`[...$('#banner').querySelectorAll('.banner-act')].find((b) => b.textContent === 'Discard').click()`);
    eq(await page.eval(`Object.keys(localStorage).filter((k) => k.startsWith('draft:')).length`), 0, 'forgotten');
    await page.send('Page.reload');
    await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0`, 15000, 'reload');
    await sleep(500);
    hasNot(await page.eval(`$('#banner').hidden ? '' : $('#banner').textContent`), 'Unsaved edits', 'no offer again');
  },

  async 'a11y: every panel has a × that closes it'(env, page) {
    await page.eval('openFind(false)');
    await page.click('#find-close');
    eq(await page.eval(`$('#findbar').hidden`), true, 'find closed by ×');
    await page.eval(`$('#help').click()`);
    await page.waitFor(`!$('#helpbox').hidden`);
    await page.click('#helpclose');
    eq(await page.eval(`$('#helpbox').hidden`), true, 'help closed by ×');
    for (const [open, box, x] of [['openFiles()', '#filesbox', '#files-close'], [`$('#historybtn').click()`, '#historybox', '#history-close'], [`$('#keysbtn').click()`, '#keysbox', '#keys-close']]) {
      await page.eval(open);
      await page.waitFor(`!$('${box}').hidden`, 4000, box);
      eq(await page.eval(`!!$('${x}').querySelector('use') && $('${x}').getAttribute('aria-label').startsWith('Close')`), true, `${x} is a labelled ×`);
      await page.click(x);
      await page.waitFor(`$('${box}').hidden`, 2000, `${box} closed`);
    }
    await page.select('lazy dog', 'end');
    await page.eval('citePalette()');
    await page.waitFor(`!$('#palette').hidden`, 4000, 'the palette');
    await page.click(`js:document.querySelector('#palette .xclose')`);
    eq(await page.eval(`$('#palette').hidden`), true, 'palette closed by ×');
    await page.eval(`banner('A message')`);
    await page.click(`js:document.querySelector('#banner .xclose')`);
    eq(await page.eval(`$('#banner').hidden`), true, 'banner closed by ×');
  },

  async 'a11y: focus goes into a dialog, stays in it with Tab, and comes back'(env, page) {
    await page.select('lazy dog', 'end');
    await page.eval('openFiles()');
    await page.waitFor(`$('#filesbox').contains(document.activeElement)`, 2000, 'focus in Files');
    for (let i = 0; i < 25; i++) await page.key('Tab');
    eq(await page.eval(`$('#filesbox').contains(document.activeElement)`), true, 'Tab stays inside');
    for (let i = 0; i < 5; i++) await page.key('Tab', { shift: true });
    eq(await page.eval(`$('#filesbox').contains(document.activeElement)`), true, 'Shift+Tab stays inside');
    await page.key('Escape');
    await page.waitFor(`$('#filesbox').hidden`, 2000, 'closed');
    await sleep(100);
    eq(await page.eval(`!!segOf(document.activeElement)`), true, 'focus back in the text');
  },

  async 'a11y: skip link, and the keyboard steps from block to block and heading to heading'(env, page) {
    eq(await page.eval(`$('#skiplink').getAttribute('href')`), '#doc', 'skip link');
    eq(await page.eval(`$('#doc').getAttribute('aria-label')`), 'The paper', 'the paper is labelled');
    await page.select('quick brown fox', 'start');
    await page.key('ArrowDown', { alt: true });
    has(await page.eval(`caretSeg().src`), 'A second paragraph', 'next block');
    await page.key('PageDown', { ctrl: true, alt: true });
    has(await page.eval(`caretSeg().src`), '\\section{Related work}', 'next heading');
    await page.key('ArrowUp', { alt: true });
    has(await page.eval(`caretSeg().src`), 'A second paragraph', 'previous block');
    await sleep(100);
    has(await page.eval(`$('#sr-live').textContent`), 'Paragraph: A second paragraph', 'announced');
    await page.key('PageUp', { ctrl: true, alt: true });
    has(await page.eval(`caretSeg().src`), '\\section{Introduction}', 'previous heading');
  },

  async 'trace: Report a problem keeps what was pressed and done, and flags a jump'(env, page) {
    await page.select('brown');
    await page.type('red');
    await page.key('z', { ctrl: true });
    await page.click('#diffbtn'); await sleep(300); await page.click('#diffbtn');
    // a scroll nobody asked for: the page grows above the view and the browser moves it
    await page.eval(`(() => { document.body.style.minHeight = '5000px'; window.scrollTo(0, 400); })()`);
    await sleep(700);
    await page.eval(`(() => { document.documentElement.scrollTop = 1400; })()`);   // not through scrollBy/scrollTo
    await sleep(700);
    await page.eval(`window.prompt = () => 'the view jumped after undo'`);
    await page.eval('REC.report()');
    await page.waitFor(`/Problem report kept in/.test($('#banner').textContent)`, 8000, 'the report');
    const dir = path.join(env.state, 'debug');
    const file = fs.readdirSync(dir).find((f) => f.startsWith('report-'));
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    eq(lines[0].note, 'the view jumped after undo', 'the note first');
    const kinds = new Set(lines.map((l) => l.k));
    for (const k of ['key', 'press', 'typed', 'do', 'jump']) if (!kinds.has(k)) throw new Error(`no ${k} in the report: ${[...kinds].join(', ')}`);
    if (!lines.some((l) => l.k === 'key' && l.key === 'C-z')) throw new Error('Ctrl+Z not recorded');
    if (!lines.some((l) => l.k === 'press' && /diffbtn/.test(l.on))) throw new Error('the Diff click not recorded');
    if (!lines.some((l) => l.k === 'do' && l.fn === 'restore')) throw new Error('the undo not recorded');
    if (lines.some((l) => JSON.stringify(l).includes('"red"'))) throw new Error('typed text was kept');
  },

  async 'new code: the page reloads itself where it was, with its unsaved edits'(env, page) {
    await page.select('brown');
    await page.type('red');
    await page.eval(`(() => { openFind(false); $('#find-q').value = 'paper'; $('#find-q').dispatchEvent(new Event('input')); })()`);
    await page.eval(`(() => { const s = ORDER.find((x) => x.src.includes('Related work')); window.scrollBy(0, s.el.getBoundingClientRect().top - 300); if (anchorHold) anchorHold(); })()`);
    await sleep(300);
    const before = await page.eval(`Math.round(ORDER.find((x) => x.src.includes('Related work')).el.getBoundingClientRect().top)`);
    await page.eval(`window.__marker = 1`);
    fs.writeFileSync(path.join(env.dir, 'code-probe'), String(Date.now()));   // "new code"
    await sleep(3200);    // the next status poll, then a quiet moment
    await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0 && !window.__marker && /new version/.test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join())`, 15000, 'the reload and its toast');
    has(await page.pageText(), 'quick red fox', 'the unsaved edit is back');
    eq(await page.eval(`editedFiles().length`), 1, 'still unsaved');
    eq(await page.eval(`!$('#findbar').hidden && $('#find-q').value`), 'paper', 'the find bar with its query');
    const after = await page.eval(`Math.round(ORDER.find((x) => x.src.includes('Related work')).el.getBoundingClientRect().top)`);
    if (Math.abs(after - before) > 4) throw new Error(`the view moved: ${before} -> ${after}`);
    hasNot(await page.eval(`$('#banner').hidden ? '' : $('#banner').textContent`), 'Unsaved edits from', 'no offer: they came back by themselves');
    await page.save();
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick red fox');
  },

  async 'Open: recent papers, the system dialog\'s folder, and opening another document'(env, page) {
    await page.key('o', { ctrl: true });
    await page.waitFor(`!$('#openbox').hidden && document.querySelector('#open-recent .open-paper')`, 4000, 'the Open window with the recent list');
    has(await page.eval(`$('#open-recent').textContent`), 'open now', 'the paper open now is in the list');
    const scrim = await page.eval(`(() => { const c = getComputedStyle(document.body, '::before'); return c.content !== 'none' && c.position === 'fixed' && c.backgroundColor; })()`);
    if (!scrim || /rgba\(0, 0, 0, 0\)/.test(scrim)) throw new Error('no dimmed backdrop behind the dialog: ' + scrim);
    eq(await page.eval(`!!document.querySelector('#open-dirs, #open-browse-head')`), false, 'no folder browser');
    // the system dialog chose the paper's folder, which has two documents: a button each
    await page.eval(`offerMains(${JSON.stringify(env.paper)}, ['main.tex', 'other.tex'])`);
    eq(await page.eval(`[...document.querySelectorAll('#open-mains button')].map((b) => b.textContent).sort().join()`), 'Open main.tex,Open other.tex', 'a button per document');
    await page.click(`js:[...document.querySelectorAll('#open-mains button')].find((b) => b.textContent === 'Open other.tex')`);
    await page.waitFor(`DOC && DOC.main === 'other.tex' && $('#openbox').hidden`, 8000, 'the other document open');
    has(await page.pageText(), 'The other document.', 'its text');
    await page.key('o', { ctrl: true });
    await page.waitFor(`document.querySelectorAll('#open-recent .open-paper').length === 2`, 4000, 'two recent papers now');
    await page.key('2');
    await page.waitFor(`DOC && DOC.main === 'main.tex'`, 8000, 'back to main.tex with its number');
  },

  async 'Open: Delete takes a recent paper off the list, and its files stay'(env, page) {
    // other.tex on the list, then main.tex open again
    await page.key('o', { ctrl: true });
    await page.waitFor(`!$('#openbox').hidden && document.querySelector('#open-recent .open-paper')`, 4000, 'the Open window');
    await page.eval(`offerMains(${JSON.stringify(env.paper)}, ['main.tex', 'other.tex'])`);
    await page.click(`js:[...document.querySelectorAll('#open-mains button')].find((b) => b.textContent === 'Open other.tex')`);
    await page.waitFor(`DOC && DOC.main === 'other.tex' && $('#openbox').hidden`, 8000, 'other.tex open');
    await page.key('o', { ctrl: true });
    await page.waitFor(`document.querySelectorAll('#open-recent .open-paper').length >= 2`, 4000, 'two recent papers');
    await page.key('2');
    await page.waitFor(`DOC && DOC.main === 'main.tex'`, 8000, 'main.tex open again');
    await page.key('o', { ctrl: true });
    await page.waitFor(`!$('#openbox').hidden && document.querySelectorAll('#open-recent .open-paper').length >= 2`, 4000, 'the list again');
    const before = await page.eval(`document.querySelectorAll('#open-recent .open-paper').length`);
    eq(await page.eval(`!!document.querySelector('#open-recent .open-paper.current').parentNode.querySelector('.open-forget')`), false, 'no × on the paper open now');
    // Delete on the paper open now does nothing
    await page.eval(`document.querySelector('#open-recent .open-paper.current').focus()`);
    await page.key('Delete');
    await new Promise((r) => setTimeout(r, 300));
    eq(await page.eval(`document.querySelectorAll('#open-recent .open-paper').length`), before, 'the open paper stays');
    // Delete on other.tex takes it off, and the focus stays in the list
    await page.eval(`[...document.querySelectorAll('#open-recent .open-paper')].find((b) => /other\.tex/.test(b.title)).focus()`);
    await page.key('Delete');
    await page.waitFor(`document.querySelectorAll('#open-recent .open-paper').length === ${before - 1}`, 4000, 'one fewer recent paper');
    hasNot(await page.eval(`$('#open-recent').textContent`), 'other.tex', 'other.tex is off the list');
    eq(await page.eval(`!!document.activeElement.closest('#open-recent')`), true, 'the focus stays in the list');
    const saved = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'paper-editor', 'recent.json'), 'utf8'));
    eq(saved.recent.some((e) => e.path.endsWith('other.tex')), false, 'off the list on disk');
    eq(fs.existsSync(path.join(env.paper, 'other.tex')), true, 'its file stays');
    await page.key('Escape');
  },

  async 'New paper: a venue, anonymous, metadata, sections and cryptobib as a submodule'(env, page) {
    // a local stand-in for cryptobib (PE_CRYPTOBIB_URL): a repository with the two files
    const cb = path.join(env.dir, 'cryptobib-src');
    fs.mkdirSync(cb);
    fs.writeFileSync(path.join(cb, 'abbrev3.bib'), '@string{ec = "EUROCRYPT"}\n');
    fs.writeFileSync(path.join(cb, 'crypto.bib'), '@misc{EC:Test, author = {A}, title = {T}, year = {2020}}\n');
    const git = (args, cwd) => require('child_process').execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git(['init', '-q'], cb); git(['add', '.'], cb); git(['commit', '-qm', 'bib'], cb);
    const parent = path.join(env.dir, 'papers');
    fs.mkdirSync(parent);
    await page.key('o', { ctrl: true });
    await page.waitFor(`!$('#openbox').hidden`, 4000, 'Open');
    await page.click('#open-new');
    await page.waitFor(`!$('#newbox').hidden && $('#new-venue').options.length > 3`, 4000, 'the New paper dialog');
    await page.eval(`(() => {
      $('#new-parent').value = ${JSON.stringify(parent)}; $('#new-name').value = 'fresh';
      $('#new-venue').value = 'llncs'; $('#new-anon').checked = true;
      document.querySelector('input[name=new-cb][value=submodule]').checked = true;
      $('#new-ptitle').value = 'A Fresh Paper'; $('#new-keywords').value = 'one, two'; $('#new-abstract').value = 'We begin.';
      const r = document.querySelector('#new-authors .new-author');
      const v = { name: 'Ada Lovelace', email: 'ada@x.org', affiliation: 'University of Porto', country: 'Portugal' };
      for (const i of r.querySelectorAll('input')) i.value = v[i.dataset.k];
    })()`);
    await page.click('#new-create');
    await page.waitFor(`DOC && DOC.path && DOC.path.includes('fresh') && $('#newbox').hidden`, 30000, 'the new paper open');
    const dir = path.join(parent, 'fresh');
    const main = fs.readFileSync(path.join(dir, 'main.tex'), 'utf8');
    has(main, '\\anontrue', 'anonymous');
    has(main, '\\documentclass[runningheads]{llncs}', 'the venue\'s class');
    has(main, '\\title{A Fresh Paper}', 'the title');
    has(main, 'Ada Lovelace', 'the author, in the named version');
    has(main, '\\input{sections/01-introduction}', 'the sections');
    has(main, '\\bibliography{cryptobib/abbrev3,cryptobib/crypto,references}', 'cryptobib and references.bib');
    for (const f of ['sections/01-introduction.tex', 'sections/02-conclusion.tex', 'references.bib', 'cryptobib/crypto.bib', '.gitmodules', '.gitignore'])
      eq(fs.existsSync(path.join(dir, f)), true, f);
    has(await page.pageText(), 'Introduction', 'the paper on the page');
    // a folder that is not empty is refused, with a message
    await page.key('o', { ctrl: true });
    await page.click('#open-new');
    await page.waitFor(`!$('#newbox').hidden`, 4000, 'the dialog again');
    await page.eval(`(() => { $('#new-parent').value = ${JSON.stringify(parent)}; $('#new-name').value = 'fresh'; document.querySelector('input[name=new-cb][value=none]').checked = true; })()`);
    await page.click('#new-create');
    await page.waitFor(`/not empty/.test($('#new-status').textContent)`, 6000, 'the refusal');
  },

  async 'selection: pressing inside it starts a new one; it survives a redraw'(env, page) {
    await page.select('quick brown fox');
    eq(await page.eval(`getSelection().toString()`), 'quick brown fox', 'selected');
    await page.eval('load(true)');
    await sleep(300);
    eq(await page.eval(`getSelection().toString()`), 'quick brown fox', 'the same text after a redraw');
    const at = await page.eval(`(() => { const r = getSelection().getRangeAt(0).getClientRects()[0]; return { x: r.left + 12, y: r.top + r.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    eq(await page.eval(`getSelection().isCollapsed`), true, 'a press inside the selection puts the caret there');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    eq(await page.eval(`(() => { const e = new DragEvent('dragstart', { bubbles: true, cancelable: true }); ORDER.find((s) => s.kind === 'para').edit.firstChild.parentElement.dispatchEvent(e); return e.defaultPrevented; })()`), true, 'no dragging of text');
  },

  async 'game editor: colours, \\BeginBox bands, comments typeset, two-way macros as printed'(env, page) {
    env.write('main.tex', String.raw`\documentclass{article}
\usepackage{xcolor,tikz,algpseudocodex}
\definecolor{gone}{RGB}{0,158,115}
\newcommand{\gc}[2]{\textcolor{g#1}{#2}}
\tikzset{gbox/.style={draw=g#1,line width=.6pt}}
\newcommand{\G}[1]{\mathsf{G}_{#1}}
\newif\ifmobile
\newcommand{\layoutchoice}[2]{\ifmobile#1\else#2\fi}
\newenvironment{gameenv}[1]{\textbf{#1}\begin{algorithmic}[1]}{\end{algorithmic}}
\begin{document}
Text.

\begin{figure}[t]
\begin{gameenv}{Game $\G0$/\gc{one}{$\G1$}}
\State $x\gets 0$ \Comment{$\G0$--$\G1$}
\BeginBox[gbox=one]
\State $y\gets 1$\layoutchoice{\Statex\hfill phone}{ \Comment{$\G1$}}
\EndBox
\end{gameenv}
\caption{Games.}\label{fig:g}
\end{figure}
\end{document}
`);
    await page.eval('load(true)');
    await page.waitFor(`ORDER.some((s) => s.kind === 'figure' && /BeginBox/.test(s.src))`, 8000, 'the figure');
    await page.eval(`(() => { openFigure(ORDER.find((s) => s.kind === 'figure')); showFigTab('games'); })()`);
    await page.waitFor(`document.querySelector('#fv-body .gline')`, 4000, 'the game');
    const r = await page.eval(`(() => ({
      title: [...document.querySelectorAll('#fv-body .tcolor')].map((e) => getComputedStyle(e).color),
      banded: document.querySelectorAll('#fv-body .gline.in-gbox:not(.gbox-begin):not(.gbox-end)').length,
      band: getComputedStyle(document.querySelector('#fv-body .gline.in-gbox')).getPropertyValue('--gbox').trim(),
      label: (document.querySelector('#fv-body .gbox-label') || {}).textContent,
      comments: [...document.querySelectorAll('#fv-body .gcomment')].map((e) => e.textContent),
      raw: [...document.querySelectorAll('#fv-body .gline')].map((e) => e.textContent).join(' | '),
    }))()`);
    eq(r.title[0], 'rgb(0, 158, 115)', 'G1 in its colour in the title');
    eq(r.banded, 1, 'one line in the box');
    eq(r.band, '#009e73', 'the box in the colour of gbox=one');
    eq(r.label, 'one', 'the box labelled');
    if (r.comments.some((c) => c.includes('--'))) throw new Error('a dash left as --: ' + r.comments);
    eq(r.comments.length, 2, 'both comments, the one inside \\layoutchoice too');
    hasNot(r.raw, 'layoutchoice', 'no raw \\layoutchoice');
    hasNot(r.raw, 'BeginBox', 'no raw \\BeginBox');
  },

  async 'game editor: a statement followed by \\layoutchoice can be edited'(env, page) {
    env.write('main.tex', String.raw`\documentclass{article}
\usepackage{algpseudocodex}
\newif\ifmobile
\newcommand{\layoutchoice}[2]{\ifmobile#1\else#2\fi}
\newcommand{\sw}[3]{#1_{#2#3}}
\begin{document}
Text.

\begin{figure}[t]
\begin{algorithmic}[1]
\State $L\gets\sw{\theta}{a}{t}$\layoutchoice{\Statex\hfill phone}{ \Comment{$G_1$}}
\State $x\gets 0$
\end{algorithmic}
\caption{Games.}\label{fig:g}
\end{figure}
\end{document}
`);
    await page.eval('load(true)');
    await page.waitFor(`ORDER.some((s) => s.kind === 'figure' && /layoutchoice/.test(s.src))`, 8000, 'the figure');
    await page.eval(`(() => { openFigure(ORDER.find((s) => s.kind === 'figure')); showFigTab('games'); })()`);
    await page.waitFor(`document.querySelector('#fv-body .gline')`, 4000, 'the game');
    const line = `[...document.querySelectorAll('#fv-body .gline')].find((r) => /theta|θ/.test(r.innerHTML) && r.querySelector('.gtext[contenteditable=true]'))`;
    eq(await page.eval(`!!(${line})`), true, 'the statement is editable');
    await page.eval(`(() => { const t = (${line}).querySelector('.gtext[contenteditable=true]'); t.append(document.createTextNode(' now')); t.dispatchEvent(new Event('input')); })()`);
    await page.click('#fv-apply');
    await page.waitFor(`$('#figview').hidden`);
    await page.save();
    has(env.read('main.tex'), '\\State $L\\gets\\sw{\\theta}{a}{t}$ now\\layoutchoice{\\Statex\\hfill phone}{ \\Comment{$G_1$}}', 'statement edited, macro kept');
  },

  async 'game editor: a % continued \\layoutchoice, boxes and line keys'(env, page) {
    env.write('main.tex', String.raw`\documentclass{article}
\usepackage{xcolor,tikz,algpseudocodex}
\newif\ifmobile
\newcommand{\layoutchoice}[2]{\ifmobile#1\else#2\fi}
\begin{document}
Text.

\begin{figure}[t]
\begin{algorithmic}[1]
\BeginBox[gbox=one]
\State $L\gets L\cup\{t\}$%
  \layoutchoice{\Statex\hfill$\triangleright$ $G_1$}{\Comment{$G_1$, $G_3$}}
\EndBox
\BeginBox[gbox=two]
\State $a\gets 1$ \Comment{$G_2$}
\EndBox
\State $b\gets 2$
\State $c\gets 3$
\end{algorithmic}
\caption{Games.}\label{fig:g}
\end{figure}
\end{document}
`);
    await page.eval('load(true)');
    await page.waitFor(`ORDER.some((s) => s.kind === 'figure' && /layoutchoice/.test(s.src))`, 8000, 'the figure');
    await page.eval(`(() => { openFigure(ORDER.find((s) => s.kind === 'figure')); showFigTab('games'); })()`);
    await page.waitFor(`document.querySelector('#fv-body .gline')`, 4000, 'the game');
    const raw = await page.eval(`[...document.querySelectorAll('#fv-body .gline')].map((e) => e.textContent).join(' | ')`);
    hasNot(raw, 'layoutchoice', 'the continued \\layoutchoice shown as printed');
    eq(await page.eval(`[...document.querySelectorAll('#fv-body .gcomment')].length`), 2, 'its comment shown');
    const lineOf = (re) => `[...document.querySelectorAll('#fv-body .gline')].find((r) => r.querySelector('.gtext[contenteditable=true]') && ${re}.test(r.querySelector('.gtext').textContent))`;
    const src = () => page.eval('figureWithEdits()');
    // put b in a new box of style two, then take it out again
    await page.eval(`(() => { const s = (${lineOf('/^b/')}).querySelector('select.g-box'); s.value = 'in:gbox=two'; s.onchange(); })()`);
    has(await src(), '\\BeginBox[gbox=two]\n\\State $b\\gets 2$\n\\EndBox', 'b boxed');
    await page.eval(`(() => { const s = (${lineOf('/^b/')}).querySelector('select.g-box'); s.value = 'out'; s.onchange(); })()`);
    hasNot(await src(), '\\BeginBox[gbox=two]\n\\State $b', 'b out of its box');
    // Down on a moves it out of its box, which then goes (empty) on Remove
    await page.eval(`[...(${lineOf('/^a/')}).querySelectorAll('.gtools button')].find((b) => b.textContent === 'Down').click()`);
    has(await src(), '\\EndBox\n\\State $a\\gets 1$ \\Comment{$G_2$}', 'a moved out of the box');
    // the edge of a box: restyle, then remove it with Delete
    await page.eval(`(() => { const r = document.querySelectorAll('#fv-body .gline.gbox-begin')[0]; const s = r.querySelector('select'); s.value = 'gbox=two'; s.onchange(); })()`);
    has(await src(), '\\BeginBox[gbox=two]\n\\State $L', 'box restyled');
    await page.eval(`document.querySelectorAll('#fv-body .gline.gbox-begin')[0].focus()`);
    await page.key('Delete');
    hasNot(await src(), '\\BeginBox[gbox=two]\n\\State $L', 'box removed');
    has(await src(), '\\State $L\\gets L\\cup\\{t\\}$%\n  \\layoutchoice', 'its line kept, with the macro');
    // Enter makes a new line, Backspace on it deletes it; Ctrl+Shift+K deletes c
    await page.eval(`(() => { const t = (${lineOf('/^c/')}).querySelector('.gtext'); t.focus(); })()`);
    await page.key('Enter');
    has(await src(), '\\State $c\\gets 3$\n\\State \n', 'a new statement');
    await page.key('Backspace');
    hasNot(await src(), '\\State \n', 'the empty statement deleted');
    await page.key('k', { ctrl: true, shift: true });
    hasNot(await src(), '$c\\gets 3$', 'c deleted in one step');
    // the comment of a is edited in place
    await page.eval(`(() => { const t = (${lineOf('/^a/')}).querySelector('.gcomment-edit'); t.append(document.createTextNode(' x')); t.dispatchEvent(new Event('input')); })()`);
    has(await src(), '\\Comment{$G_2$ x}', 'comment edited');
  },

  async 'drawer: editing a formula'(env, page) {
    await page.eval(`document.querySelector('#doc .chip.math').click()`);
    await page.waitFor(`!$('#drawer').hidden`);
    await page.eval(`$('#drawer-src').value = '$x^3$'`);
    await page.eval(`$('#drawer-apply').click()`);
    await page.save();
    onlyChange(env, 'main.tex', '$x^2 + y^2$', '$x^3$');
  },

  async 'heading tools stay off a long heading title'(env, page) {
    // a title that runs to the end of the line: its buttons must not cover it
    await page.eval(`(() => { const s = ORDER.find((s) => s.kind === 'heading' && s.src.includes('Related work'));
      s.el.querySelector('.htitle').textContent = 'Related work on oracle games and their many long winding variants'; })()`);
    const r = JSON.parse(await page.eval(`(() => { const s = ORDER.find((s) => s.kind === 'heading' && s.src.includes('Related work'));
      const t = s.el.querySelector('.tools'); t.style.opacity = 1;
      const a = s.el.querySelector('.htitle').getBoundingClientRect(), b = t.getBoundingClientRect();
      return JSON.stringify({ toolsBottom: b.bottom, titleTop: a.top, w: b.width }); })()`));
    if (!(r.w > 0)) throw new Error('tools not laid out: ' + JSON.stringify(r));
    if (r.toolsBottom > r.titleTop + 1) throw new Error('heading tools overlap the title: ' + JSON.stringify(r));
  },

  async 'heading edits save'(env, page) {
    await page.select('Conclusion', 'end');
    await page.type('s');
    await page.save();
    onlyChange(env, 'main.tex', '\\section{Conclusion}', '\\section{Conclusions}');
  },

  async 'switching documents drops the old undo history'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' gone');
    await page.waitFor('editedFiles().length === 1');
    await page.eval(`$('#mainsel').value = 'other.tex'; $('#mainsel').dispatchEvent(new Event('change'))`);
    await page.waitFor(`document.querySelector('#doc').innerText.includes('The other document')`, 8000, 'the other document');
    has(page.dialogs.join('\n'), 'unsaved edits', 'the question before discarding edits');
    await page.key('z', { ctrl: true });
    await page.select('other document.', 'end');
    await page.type(' Yes.');
    await page.save();
    onlyChange(env, 'other.tex', 'other document.', 'other document. Yes.');
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  async 'no script errors'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' x');
    await page.save();
    await sleep(2500);
    if (page.errors.length) throw new Error('script errors: ' + page.errors.join('\n'));
    hasNot(env.log, 'JSERROR', 'server log');
  },
};

// ------------------------------------------------------------ more tests:
// every button, the dialogs, and the combinations people actually hit

const tb = (act) => `#chrome button[data-act="${act}"]`;
const headBtn = (title, button) => `js:ORDER.find((s) => s.kind === 'heading' && s.src.includes(${JSON.stringify(title)})).el.querySelector('button[title^="${button}"]')`;
const paraPlus = (text) => `js:ORDER.find((s) => s.kind === 'para' && s.src.includes(${JSON.stringify(text)})).el.querySelector('.tools button')`;
const menuItem = (label) => `js:[...$('#menu').querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)})`;
const visible = (sel) => `!document.querySelector(${JSON.stringify(sel)}).hidden`;
// a selection from one piece of text to another (possibly in other blocks)
async function selectSpan(page, from, to) {
  await page.eval(`(() => {
    const find = (needle) => {
      for (const ed of document.querySelectorAll('#doc [contenteditable=true]')) {
        const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let t;
        while ((t = w.nextNode())) { const i = t.data.indexOf(needle); if (i >= 0) return [ed, t, i]; }
      }
      throw new Error('not on the page: ' + needle);
    };
    const [ed, a, i] = find(${JSON.stringify(from)});
    const [, b, j] = find(${JSON.stringify(to)});
    const r = document.createRange(); r.setStart(a, i); r.setEnd(b, j + ${JSON.stringify(to)}.length);
    ed.focus(); getSelection().removeAllRanges(); getSelection().addRange(r);
  })()`);
}
const unsaved = (page) => page.eval(`editedFiles().length`);

Object.assign(TESTS, {
  // ---- header buttons
  async 'the Save button saves'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' saved');
    await page.click('#save');
    await page.waitFor(`!SAVING && editedFiles().length === 0`, 8000, 'the save');
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog saved.');
  },

  async 'layout: remembered two-column mode opens in a fresh tab'(env, page) {
    await page.click('#cols');
    const fresh = await env.openPage(CHROME);
    eq(await fresh.eval('document.body.classList.contains("two")'), true, 'two-column preference restored');
    eq(await fresh.eval('ORDER.length > 0'), true, 'document loads with stored two-column mode');
    await fresh.click('#cols');
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  async 'layout: table preview cannot overflow a narrow review column'(env, page) {
    await page.click('#cols');
    eq(await page.eval('document.body.classList.contains("two")'), true, 'two columns active');
    const bounds = await page.eval('(async () => {' +
      ' const host = document.querySelector("#doc .page");' +
      ' const box = document.createElement("div"); box.className = "seg table";' +
      ' const inner = document.createElement("div"); const img = document.createElement("img");' +
      ' img.setAttribute("width", "2400"); img.setAttribute("height", "600");' +
      ' img.src = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%222400%22 height=%22600%22/%3E";' +
      ' inner.append(img); box.append(inner); host.append(box);' +
      ' await img.decode(); await new Promise(requestAnimationFrame);' +
      ' const outer = box.getBoundingClientRect().width;' +
      ' const width = img.getBoundingClientRect().width;' +
      ' const label = host.querySelector(".pagemark").textContent;' +
      ' const columns = getComputedStyle(host).columnCount;' +
      ' box.remove(); return { outer, width, label, columns }; })()');
    eq(bounds.columns, '2', 'CSS columns applied');
    has(bounds.label, 'review spread', 'two-column view uses reading-flow spreads');
    eq(bounds.width > 0 && bounds.width <= bounds.outer + 2, true, 'large raster scales inside the column: ' + JSON.stringify(bounds));
    await page.click('#cols');
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  async 'two columns, then editing and saving still work'(env, page) {
    await page.click('#cols');
    eq(await page.eval(`document.body.classList.contains('two')`), true, 'two columns');
    await page.select('Detail text', 'end');
    await page.type(' two');
    await page.save();
    onlyChange(env, 'sections/body.tex', 'Detail text', 'Detail text two');
    await page.click('#cols');
    eq(await page.eval(`document.body.classList.contains('two')`), false, 'one column again');
  },

  async 'theme button cycles, help opens and Escape closes it'(env, page) {
    const seen = [];
    for (let i = 0; i < 3; i++) { await page.click('#theme'); seen.push(await page.eval(`document.documentElement.dataset.theme || 'auto'`)); }
    eq(seen.join(','), 'light,dark,auto', 'themes');
    await page.click('#help');
    await page.waitFor(visible('#helpbox'));
    await page.key('Escape');
    await page.waitFor(`$('#helpbox').hidden`, 2000, 'help to close');
  },

  async 'reading controls never throw, with or without a voice'(env, page) {
    await page.select('lazy dog', 'start');
    for (const b of ['#play', '#tts-next', '#tts-prev', '#pause', '#pause', '#stop', '#play', '#stop']) {
      if (await page.eval(`document.querySelector('${b}').disabled || !document.querySelector('${b}').getClientRects().length`)) continue;
      await page.click(b);
    }
    await page.key('r', { alt: true }); await page.key('p', { alt: true }); await page.key('s', { alt: true });
    await page.key('ArrowRight', { ctrl: true, alt: true }); await page.key('ArrowLeft', { ctrl: true, alt: true });
    await page.key('s', { alt: true });
    await sleep(300);
    eq(await unsaved(page), 0, 'reading edits nothing');
  },

  // ---- reader, driven by a fake speech engine that finishes phrases on demand
  async 'reader: pause and stop are enabled whenever reading, after play, prev, next and a re-render'(env, page) {
    await fakeSpeech(page);
    await page.select('lazy dog', 'start');
    const st = () => page.eval(`({ pause: !$('#pause').disabled, stop: !$('#stop').disabled, state: $('#tts-state').textContent })`);
    const idle = await st();
    eq(idle.pause || idle.stop, false, 'idle: pause and stop disabled');
    await page.click('#play');
    let s = await st();
    eq(s.pause && s.stop && s.state, 'Reading', 'after play');
    await page.click('#tts-next');
    s = await st(); eq(s.pause && s.stop, true, 'after next');
    await page.click('#tts-prev');
    s = await st(); eq(s.pause && s.stop, true, 'after prev');
    await page.click('#pause');
    eq((await st()).state, 'Paused', 'paused');
    eq(await page.eval(`$('#pause').getAttribute('aria-pressed')`), 'true', 'pause pressed');
    eq(await page.eval(`$('#pause .label').textContent`), 'Resume', 'pause reads Resume');
    eq(await page.eval(`$('#play').classList.contains('reading')`), false, 'read not marked while paused');
    await page.click('#play');   // play while paused resumes the same phrase, it does not restart from the caret
    eq((await st()).state, 'Reading', 'play resumes');
    eq(await page.eval(`$('#play').classList.contains('reading')`), true, 'read marked while reading');
    const said = await page.eval(`__fake.spoken`);
    eq(said.length, 4, 'a browser voice reads the phrase again on resume');
    eq(said[3], said[2], 'the same phrase');
    // the page re-renders (a save, a rebuild) while reading: still controllable
    await page.eval(`render()`);
    s = await st(); eq(s.pause && s.stop, true, 'after a re-render');
    await page.click('#stop');
    s = await st(); eq(s.pause || s.stop, false, 'stopped: disabled again');
    eq(s.state, 'Stopped', 'state after stop');
  },

  async 'reader: starts at the phrase with the caret, not the top of the paragraph'(env, page) {
    await fakeSpeech(page);
    await page.select('We study', 'start');
    await page.click('#play');
    has(await page.eval(`__fake.spoken[0]`), 'We study', 'second sentence first');
    await page.click('#stop');
    // caret at the end of the first sentence: that sentence
    await page.select('lazy dog', 'end');
    await page.click('#play');
    has(await page.eval(`__fake.spoken[1]`), 'The quick brown fox', 'first sentence');
    await page.click('#stop');
    // caret in another paragraph: reading starts there, not at the top
    await page.select('encryption schemes', 'end');
    await page.click('#play');
    has(await page.eval(`__fake.spoken[2]`), 'A second paragraph', 'other paragraph');
  },

  async 'reader: with nothing selected or clicked, reading starts at the top of the paper'(env, page) {
    await fakeSpeech(page);
    await page.select('Final words', 'start');
    await page.click('#play');
    await page.click('#stop');
    const n = await page.eval(`__fake.spoken.length`);
    await page.eval(`TTS.reset()`);                    // forgets the caret and the place last clicked
    await page.eval(`getSelection().removeAllRanges()`);
    await page.click('#play');
    const spoken = await page.eval(`__fake.spoken`);
    eq(spoken.length, n + 1, 'spoke one phrase');
    has(spoken[n], 'Introduction', 'started at the first heading');
    await page.click('#stop');
  },

  async 'reader: the phrase is one bar per line, as tall as the text, over its formulas'(env, page) {
    await fakeSpeech(page);
    await page.select('We study', 'start');
    await page.click('#play');
    await page.waitFor(`$('#ttsmark') && $('#ttsmark').children.length > 0`, 5000, 'the phrase bar');
    const g = await page.eval(`(() => {
      const bars = [...$('#ttsmark').children].map((d) => d.getBoundingClientRect());
      const m = [...document.querySelectorAll('.math')].find((e) => /x\\^2/.test(e.dataset.src || ''));
      const r = m.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(m.closest('.seg')).fontSize);
      return { n: bars.length, h: bars[0].height, lh, covers: bars[0].left <= r.left + 1 && bars[0].right >= r.right - 1 };
    })()`);
    eq(g.n, 1, 'one bar for a phrase on one line');
    eq(g.h < g.lh * 1.6, true, `bar as tall as a line of text (${g.h} for a ${g.lh}px font)`);
    eq(g.covers, true, 'the bar spans the formula');
    await page.click('#stop');
    eq(await page.eval(`$('#ttsmark').children.length`), 0, 'stop removes the bar');
  },

  async 'reader: an utterance whose end is lost does not wedge the reader'(env, page) {
    await fakeSpeech(page);
    await page.select('Detail text lives here', 'start');
    await page.click('#play');                         // the fake never fires the utterance's onend
    const n = await page.eval(`__fake.spoken.length`);
    await page.waitFor(`__fake.spoken.length > ${n} || $('#tts-state').textContent === 'Stopped'`,
      30000, 'a lost utterance to be noticed');
    has(await page.eval(`$('#tts-state').textContent`), 'Reading', 'still reading after moving on');
    await page.click('#stop');
  },

  async 'reader: read from here, from the section start, and from the beginning'(env, page) {
    await fakeSpeech(page);
    const last = () => page.eval(`__fake.spoken[__fake.spoken.length - 1]`);
    await page.select('Other papers exist', 'start');
    await page.click('#readhere');
    has(await last(), 'Other papers exist', 'read from here');
    await page.click('#stop');
    await page.select('Final words', 'start');            // inside the Conclusion section
    await page.click('#readsection');
    has(await last(), 'Conclusion', 'read from the section start');
    await page.click('#stop');
    await page.select('lazy dog', 'end');
    await page.click('#readtop');
    has(await last(), 'Introduction', 'read from the beginning');
    await page.click('#stop');
  },

  async 'reader: the speed slider takes any value, and the choice survives'(env, page) {
    await fakeSpeech(page);
    await page.eval(`$('#rate').value = '1.1';
      $('#rate').dispatchEvent(new Event('input')); $('#rate').dispatchEvent(new Event('change'))`);
    eq(await page.eval(`localStorage.getItem('rate')`), '1.1', 'the speed is remembered');
    eq(await page.eval(`$('#rateval').textContent`), '1.1×', 'the slider reads out its value');
    await page.select('lazy dog', 'start');
    await page.click('#play');
    const spokenAt = await page.eval(`__fake.cur.rate`);
    eq(Math.abs(spokenAt - 1.1) < 0.001, true, 'the phrase is spoken at the chosen rate');
    await page.click('#stop');
  },

  async 'reader: reading keeps going to the end, then stops by itself'(env, page) {
    await fakeSpeech(page);
    await page.select('Final words', 'start');
    await page.click('#play');
    for (let i = 0; i < 5 && await page.eval(`!$('#stop').disabled`); i++) await page.eval(`__fake.finish()`);
    eq(await page.eval(`$('#tts-state').textContent`), 'Stopped', 'stopped at the end');
    eq(await page.eval(`$('#stop').disabled`), true, 'controls idle at the end');
  },

  async 'css: dark chrome, compact bars, nothing overflows, bars do not overlap'(env, page) {
    const lum = (c) => { const m = c.match(/\d+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    for (const theme of ['light', 'dark']) {
      await page.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      const m = await page.eval(`(() => {
        const cs = (q, p) => getComputedStyle(document.querySelector(q))[p];
        return { bg: cs('body', 'backgroundColor'), fg: cs('body', 'color'), bar: cs('#title', 'fontSize'),
          tool: cs('#toolbar', 'fontSize'), body: cs('body', 'fontSize') };
      })()`);
      const dark = theme === 'dark';
      if (dark && lum(m.bg) > 0.12) throw new Error('dark background not dark enough: ' + m.bg);   // dark, not black
      if (!dark && lum(m.bg) > 0.9) throw new Error('light background too bright: ' + m.bg);
      if (Math.abs(lum(m.fg) - lum(m.bg)) < 0.6) throw new Error(`${theme}: text/background contrast too low (${m.fg} on ${m.bg})`);
      eq(m.bar, '12.5px', 'bar font'); eq(m.tool, '12px', 'toolbar font'); eq(m.body, '16px', 'body font');
    }
    const g = await page.eval(`(() => {
      const r = (q) => document.querySelector(q).getBoundingClientRect();
      return { barBottom: r('#bar').bottom, toolTop: r('#toolbar').top, barH: r('#bar').height,
        toolH: r('#toolbar').height, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    })()`);
    if (g.barH > 76) throw new Error('top bar too tall: ' + g.barH);
    if (g.toolH > 30) throw new Error('toolbar too tall: ' + g.toolH);
    if (Math.abs(g.barBottom - g.toolTop) > 1.5) throw new Error(`bars overlap or gap: ${g.barBottom} vs ${g.toolTop}`);
    if (g.overflow > 0) throw new Error('page scrolls horizontally by ' + g.overflow);
    await page.eval(`window.scrollTo(0, 400)`);
    const sticky = await page.eval(`(() => { const r = (q) => document.querySelector(q).getBoundingClientRect();
      return [r('#bar').top, r('#toolbar').top - r('#bar').bottom]; })()`);
    if (Math.abs(sticky[0]) > 1 || Math.abs(sticky[1]) > 1.5) throw new Error('bars not stuck together when scrolled: ' + sticky);
  },

  async 'render: tabular preview keeps LaTeX source'(env, page) {
    const src = String.raw`\begin{tabular}{lr} A&B\\ C&D\end{tabular}`;
    const result = await page.eval(`(() => {
      const src = ${JSON.stringify(src)};
      const table = previewTabular(src);
      const token = L.tokenize(src)[0];
      const node = renderChip(token, {});
      return { rows: table.querySelectorAll('tr').length,
        cells: table.querySelectorAll('td').length,
        html: !!node.querySelector('table'), source: node.dataset.src };
    })()`);
    eq(result.rows, 2, 'two HTML table rows');
    eq(result.cells, 4, 'four HTML cells');
    eq(result.html, true, 'standalone tabular is not raw LaTeX');
    eq(result.source, src, 'tabular source is preserved');
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  async 'Keys dialog: a new shortcut works, is saved in the config, and the old one stops'(env, page) {
    await page.click('#keysbtn');
    await page.waitFor(visible('#keysbox'));
    await page.click(`js:[...document.querySelectorAll('#keys-list .keyrow')].find((r) => r.textContent.startsWith('Bold')).querySelector('button')`);
    await page.key('k', { ctrl: true });
    await page.click('#keys-save');
    await page.waitFor(`$('#keysbox').hidden`);
    const cfg = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'paper-editor', 'keys.json'), 'utf8'));
    eq(JSON.stringify(cfg.bold), '["C-k"]', 'saved shortcut');
    await page.select('quick');
    await page.key('k', { ctrl: true });
    await page.select('lazy');
    await page.key('b', { ctrl: true });
    await page.save();
    onlyChange(env, 'main.tex', 'The quick', 'The \\textbf{quick}');
  },

  async 'keys: chrome, block and dialog actions all have working shortcuts'(env, page) {
    // ☰ menu
    await page.key('m', { ctrl: true, alt: true });
    eq(await page.eval(`!$('#mainmenu').hidden`), true, 'Ctrl+Alt+M opens the menu');
    await page.key('Escape');
    eq(await page.eval(`$('#mainmenu').hidden`), true, 'Escape closes the menu');
    // columns and theme
    await page.key('w', { ctrl: true, alt: true });
    eq(await page.eval(`document.body.classList.contains('two')`), true, 'Ctrl+Alt+W: two columns on');
    await page.key('w', { ctrl: true, alt: true });
    eq(await page.eval(`document.body.classList.contains('two')`), false, 'Ctrl+Alt+W: off again');
    const t0 = await page.eval(`document.documentElement.dataset.theme || 'auto'`);
    await page.key('g', { ctrl: true, alt: true });
    eq(await page.eval(`document.documentElement.dataset.theme || 'auto'`) !== t0, true, 'Ctrl+Alt+G cycles the theme');
    // paper text size
    await page.key('-', { ctrl: true, alt: true });
    eq(await page.eval(`$('#textsize').textContent`) === '100%', false, 'Ctrl+Alt+- shrinks the paper text');
    await page.key('=', { ctrl: true, alt: true });
    await page.key('0', { ctrl: true, alt: true });
    eq(await page.eval(`$('#textsize').textContent`), '100%', 'Ctrl+Alt+0 resets the text size');
    // diff on and off
    await page.key('v', { ctrl: true, alt: true });
    eq(await page.eval(`DIFF.on`), true, 'Ctrl+Alt+V shows the diff');
    await page.key('v', { ctrl: true, alt: true });
    eq(await page.eval(`DIFF.on`), false, 'Ctrl+Alt+V leaves the diff');
    // Keys… lists the new shortcuts
    await page.key(',', { ctrl: true, alt: true });
    await page.waitFor(`!$('#keysbox').hidden`);
    const rows = await page.eval(`[...document.querySelectorAll('#keys-list .keyrow')].map((r) => r.textContent)`);
    for (const k of ['Ctrl+Alt+M', 'Ctrl+Alt+W', 'Ctrl+Alt+V', 'Ctrl+Alt+S', 'Ctrl+Alt+A', 'Ctrl+Alt+X', 'Ctrl+Alt+B', 'Ctrl+Alt+ArrowUp'])
      if (!rows.some((r) => r.includes(k))) throw new Error('Keys… misses ' + k);
    await page.key('Escape');
    eq(await page.eval(`$('#keysbox').hidden`), true, 'Escape closes Keys…');
    // block actions in the text: split, add after, move, delete
    await page.select('We study', 'start');
    await page.key('s', { ctrl: true, alt: true });
    await page.type('Split');
    await page.save();
    has(env.read('main.tex'), '\\section{Split}', 'Ctrl+Alt+S split the section at the cursor');
    await page.select('We study', 'start');
    await page.key('a', { ctrl: true, alt: true });
    eq(await page.eval(`!$('#menu').hidden`), true, 'Ctrl+Alt+A opens the add menu');
    await page.click(`js:[...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'Paragraph')`);
    await page.type('Added');
    await page.save();
    has(env.read('main.tex'), 'Added', 'Ctrl+Alt+A added a paragraph after the block');
    // move the heading we just made up with Ctrl+Alt+Up
    await page.select('Split', 'start');
    await page.key('ArrowUp', { ctrl: true, alt: true });
    await page.save();
    const t2 = env.read('main.tex');
    if (t2.indexOf('\\section{Split}') > t2.indexOf('Added')) throw new Error('Ctrl+Alt+Up did not move the section up');
    // delete the heading with Ctrl+Alt+X (the confirm is auto-accepted)
    await page.select('Split', 'start');
    await page.key('x', { ctrl: true, alt: true });
    await page.save();
    hasNot(env.read('main.tex'), '\\section{Split}', 'Ctrl+Alt+X deleted the heading');
  },

  async 'Paper dialog opens, saves metadata outside the paper, and closes'(env, page) {
    const before = fs.readdirSync(env.paper).sort().join(',');
    await page.click('#paperbtn');
    await page.waitFor(visible('#paperbox'), 8000, 'the paper dialog');
    await page.click('#md-save');
    await sleep(500);
    await page.click('#md-close');
    await page.waitFor(`$('#paperbox').hidden`);
    eq(fs.readdirSync(env.paper).sort().join(','), before, 'files in the paper folder');
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  // ---- toolbar
  async 'toolbar B and I on a selection'(env, page) {
    await page.select('quick');
    await page.click(tb('bold'));
    await page.select('lazy');
    await page.click(tb('emph'));
    await page.save();
    onlyChange(env, 'main.tex', 'The quick brown fox jumps over the lazy dog.', 'The \\textbf{quick} brown fox jumps over the \\emph{lazy} dog.');
  },

  async 'toolbar B with no selection: a placeholder that typing replaces'(env, page) {
    await page.select('lazy dog', 'end');
    await page.click(tb('bold'));
    eq(await page.eval(`getSelection().toString()`), 'text', 'the placeholder is selected');
    await page.type('loud');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog\\textbf{loud}.');
  },

  async 'toolbar $x$ on a selection'(env, page) {
    await page.select('brown');
    await page.click(tb('math'));
    await page.save();
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick $brown$ fox');
  },

  async 'toolbar equation: the drawer, then Apply'(env, page) {
    await page.select('brown', 'end');
    await page.click(tb('display'));
    await page.waitFor(visible('#drawer'));
    await page.eval(`$('#drawer-src').value = '\\\\[\\n  E = mc^2\\n\\\\]'`);
    await page.click('#drawer-apply');
    await page.save();
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick brown\n\\[\n  E = mc^2\n\\]\n fox');
  },

  async 'toolbar equation at the end of a line adds no blank line'(env, page) {
    await page.select('lazy dog.', 'end');
    await page.click(tb('display'));
    await page.waitFor(visible('#drawer'));
    await page.eval(`$('#drawer-src').value = '\\\\[ y \\\\]'`);
    await page.click('#drawer-apply');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.\nWe', 'lazy dog.\n\\[ y \\]\nWe');
  },

  async 'toolbar equation, Cancel leaves no empty formula'(env, page) {
    await page.select('brown', 'end');
    await page.click(tb('display'));
    await page.waitFor(visible('#drawer'));
    await page.click('#drawer-cancel');
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'a new formula applied with Ctrl+Enter: typing goes on after it'(env, page) {
    await page.select('lazy dog', 'end');
    await page.key('m', { ctrl: true });
    await page.waitFor(visible('#drawer'));
    await page.type('z');
    await page.key('Enter', { ctrl: true });
    await page.waitFor(`$('#drawer').hidden`);
    await page.type(' more');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog$z$ more.');
  },

  async 'Ctrl+M with no selection, then Escape, leaves no empty formula'(env, page) {
    await page.select('brown', 'end');
    await page.key('m', { ctrl: true });
    await page.waitFor(visible('#drawer'));
    await page.key('Escape');
    await page.waitFor(`$('#drawer').hidden`);
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'toolbar \\… inserts any LaTeX'(env, page) {
    await page.select('lazy dog', 'end');
    await page.click(tb('latex'));
    await page.waitFor(visible('#drawer'));
    eq(await page.eval(`$('#drawer-src').value`), '\\cref{}', 'the drawer starts with');
    await page.eval(`$('#drawer-src').value = '\\\\footnote{A note.}'`);
    await page.key('Enter', { ctrl: true });
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog\\footnote{A note.}.');
  },

  async 'Cite…: search the .bib, Enter inserts the citation with a tie'(env, page) {
    await page.select('lazy dog', 'end');
    await page.click(tb('cite'));
    await page.waitFor(visible('#palette'));
    await page.type('goldwasser');
    await page.waitFor(`PAL.items.length > 0`, 8000, 'search results');
    await page.key('Enter');
    await page.waitFor(`$('#palette').hidden`);
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog~\\cite{GM84}.');
  },

  async 'Ref…: search the labels, Enter inserts the reference'(env, page) {
    await page.select('Final words', 'end');
    await page.click(tb('ref'));
    await page.waitFor(visible('#palette'));
    await page.type('body');
    await page.waitFor(`PAL.items.length > 0`, 4000, 'labels');
    await page.key('Enter');
    await page.save();
    onlyChange(env, 'main.tex', 'Final words', 'Final words \\cref{sec:body}');   // the house rules tie \\cite and \\ref only
  },

  async 'Cite… then Escape inserts nothing'(env, page) {
    await page.select('lazy dog', 'end');
    await page.key('c', { ctrl: true, alt: true });
    await page.waitFor(visible('#palette'));
    await page.type('goldwasser');
    await page.key('Escape');
    await page.waitFor(`$('#palette').hidden`);
    await page.save();
    untouched(env, 'main.tex');
  },

  async '§ Section at the cursor splits the paragraph cleanly'(env, page) {
    await page.select('We study', 'start');
    await page.click(tb('section'));
    eq(await page.eval(`getSelection().toString()`), 'Write here.', 'placeholder selected');
    await page.type('Middle');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.\nWe study', 'lazy dog.\n\n\\section{Middle}\n\nWe study');
  },

  async 'Ctrl+Alt+2 and ¶ Heading insert a subsection and a \\paragraph'(env, page) {
    await page.select('jumps', 'start');
    await page.key('2', { ctrl: true, alt: true });
    await page.type('Sub');
    await page.select('A second', 'start');
    await page.click(tb('paragraph'));
    await page.type('Run-in');
    await page.save();
    const t = env.read('main.tex');
    has(t, '\\subsection{Sub}', 'subsection');
    has(t, '\\paragraph{Run-in}\nA second', 'paragraph heading');
    hasNot(t, 'Write here', 'placeholders');
  },

  async 'Split section uses the level of the section it is in'(env, page) {
    await page.select('Detail text', 'end');
    await page.type(' Before.');
    await page.select(' lives here', 'start');
    await page.click(tb('splitsection'));
    await page.type('Second details');
    await page.save();
    has(env.read('sections/body.tex'), '\\subsection{Second details}', 'a subsection, like Details');
  },

  async '¶ New splits the paragraph at the cursor'(env, page) {
    await page.select('We study', 'start');
    await page.click(tb('newpara'));
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.\nWe study', 'lazy dog.\n\nWe study');
  },

  async 'undo and redo buttons, across a section insert'(env, page) {
    await page.select('We study', 'start');
    await page.click(tb('section'));
    await page.type('Middle');
    await page.waitFor(`editedFiles().length === 1`);
    for (let i = 0; i < 4 && await page.eval(`editedFiles().length`); i++) { await page.click(tb('undo')); await sleep(100); }
    eq(await unsaved(page), 0, 'everything undone');
    hasNot(await page.pageText(), 'Middle', 'page text');
    await page.click(tb('redo'));
    await page.save();
    has(env.read('main.tex'), '\\section{', 'redo brings the heading back');
  },

  // ---- find bar
  async 'Find: next, previous, Replace one'(env, page) {
    await page.click(tb('find'));
    await page.waitFor(visible('#findbar'));
    await page.type('the');
    await page.waitFor(`FIND.matches.length > 0`);
    const n = await page.eval(`FIND.matches.length`);
    await page.click('#find-next'); await page.click('#find-next'); await page.click('#find-prev');
    has(await page.eval(`$('#find-count').textContent`), `of ${n}`, 'count');
    await page.eval(`$('#find-r').value = 'THE'`);
    await page.click('#find-one');
    await page.save();
    const all = env.read('main.tex') + env.read('sections/body.tex');
    eq((all.match(/THE/g) || []).length, 1, 'exactly one replacement');
  },

  async 'Find: regular expression groups, whole words, case'(env, page) {
    await page.key('h', { ctrl: true });
    await page.waitFor(visible('#findbar'));
    await page.eval(`$('#find-re').checked = true; $('#find-q').value = '(\\\\w+) fox'; $('#find-q').dispatchEvent(new Event('input')); $('#find-r').value = 'fox $1'`);
    await page.click('#find-all');
    await page.eval(`$('#find-re').checked = false; $('#find-word').checked = true; $('#find-case').checked = true; $('#find-q').value = 'The'; $('#find-q').dispatchEvent(new Event('input')); $('#find-r').value = 'A'`);
    eq(await page.eval(`FIND.matches.length`), 1, '"The" as a whole word, with its case (not "the")');
    await page.click('#find-all');
    await page.save();
    onlyChange(env, 'main.tex', 'The quick brown fox jumps', 'A quick fox brown jumps');
  },

  async 'Find never matches inside maths, and Replace keeps the formula'(env, page) {
    await page.key('f', { ctrl: true });
    await page.type('y');
    await page.waitFor(`FIND.matches !== undefined`);
    const inMath = await page.eval(`FIND.matches.some((r) => r.startContainer.parentElement && r.startContainer.parentElement.closest('.chip'))`);
    eq(inMath, false, 'no match inside a formula');
    await page.eval(`$('#find-q').value = 'study'; $('#find-q').dispatchEvent(new Event('input')); $('#find-r').value = 'see'`);
    await page.click('#find-all');
    await page.save();
    onlyChange(env, 'main.tex', 'We study $x^2', 'We see $x^2');
  },

  // ---- headings and blocks
  async 'Delete a heading keeps the paragraphs apart'(env, page) {
    await page.click(headBtn('Related work', 'Delete this heading'));
    await page.save();
    onlyChange(env, 'main.tex', 'encryption schemes.\n\n\\section{Related work}\nOther papers exist.', 'encryption schemes.\n\nOther papers exist.');
  },

  async 'Delete a heading, merge a section: Ctrl+Z brings each back'(env, page) {
    await page.click(headBtn('Related work', 'Delete this heading'));
    await page.key('z', { ctrl: true });
    await page.save();
    untouched(env, 'main.tex');
    // the section before it is in sections/body.tex: only the heading can go
    await page.click(headBtn('Conclusion', 'Merge with the previous'));
    await page.waitFor(`!$('#askbox').hidden`, 3000, 'the question');
    await mergeAnswer(page, 'Keep the files');
    await page.key('z', { ctrl: true });
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'Merge with the previous section, and Cancel changes nothing'(env, page) {
    await page.click(headBtn('Related work', 'Merge with the previous'));
    await page.waitFor(`!$('#askbox').hidden`, 3000, 'the question');
    await mergeAnswer(page, 'Cancel');
    await page.save();
    untouched(env, 'main.tex');
    await page.click(headBtn('Related work', 'Merge with the previous'));
    await page.waitFor(`!$('#askbox').hidden`, 3000, 'the question');
    await mergeAnswer(page, 'Merge');
    await page.save();
    hasNot(env.read('main.tex'), 'Related work', 'the heading is gone');
    has(env.read('main.tex'), 'Other papers exist.', 'its text stays');
  },

  async '+ menu: section heading, displayed maths, EasyCrypt listing'(env, page) {
    await page.click(paraPlus('Other papers'));
    await page.click(menuItem('Section heading'));
    await page.type('Added');
    await page.click(paraPlus('Other papers'));
    await page.click(menuItem('Displayed maths'));
    await page.click(paraPlus('Other papers'));
    await page.click(menuItem('EasyCrypt listing'));
    await page.save();
    const t = env.read('main.tex');
    has(t, 'Other papers exist.\n\n\\begin{ecblock}', 'listing right after');
    has(t, '\\end{ecblock}\n\n\\[\n  x\n\\]\n\n\\section{Added}\n\n\\input{sections/body}', 'then the maths, then the heading');
  },

  async 'in a narrow window the block tools can still be reached and clicked'(env, page) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
    const left = await page.eval(`ORDER.find((s) => s.kind === 'para').el.querySelector('.tools button').getBoundingClientRect().left`);
    if (left < 0) throw new Error('the + button is off screen: left ' + left);
    await page.click(paraPlus('Other papers'));
    await page.click(menuItem('Paragraph'));
    await page.type('Narrow.');
    await page.click(headBtn('Conclusion', 'Delete this heading'));
    await page.save();
    const t = env.read('main.tex');
    has(t, 'Other papers exist.\n\nNarrow.', 'the new paragraph');
    hasNot(t, '\\section{Conclusion}', 'the deleted heading');
    await page.send('Emulation.clearDeviceMetricsOverride');
  },

  async 'the + menu closes when clicking elsewhere'(env, page) {
    await page.click(paraPlus('Other papers'));
    await page.waitFor(visible('#menu'));
    await page.click('#title');
    await page.waitFor(`$('#menu').hidden`);
  },

  // ---- diff view
  async 'Diff: switch between last save and last commit'(env, page) {
    await page.select('brown');
    await page.type('red');
    await page.save();
    await page.select('second');
    await page.type('third');
    await page.click('#diffbtn');
    await waitDiffMarks(page, 1, 'one change since last save');
    eq(await page.eval(`$('#diffbase').value`), 'save', 'default diff baseline is last save');
    await page.eval(`$('#diffbase').value = 'head'; $('#diffbase').dispatchEvent(new Event('change'))`);
    await waitDiffMarks(page, 2, 'two changes since last commit');
    await page.click('#diffbtn');
    await page.save();
    has(env.read('main.tex'), 'quick red fox', 'saved edit remains');
    has(env.read('main.tex'), 'A third paragraph', 'unsaved edit saved after leaving diff');
  },

  async 'Diff: reload reads a commit made outside the editor'(env, page) {
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: env.paper, stdio: 'ignore' });
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'first');
    await page.select('brown');
    await page.type('red');
    await page.save();
    await page.click('#diffbtn');
    await page.eval(`$('#diffbase').value = 'head'; $('#diffbase').dispatchEvent(new Event('change'))`);
    await waitDiffMarks(page, 1, 'one change since the first commit');
    eq(await page.eval(`$('#diffcommits').children.length`), 0, 'no earlier commit yet');
    git('commit', '-qam', 'second');
    await page.click('#diffreload');
    await waitDiffMarks(page, 0, 'no change since the new commit');
    eq(await page.eval(`$('#diffcommits').children.length`), 1, 'the first commit is now an earlier one');
    eq(await page.eval(`$('#diffbase').value`), 'head', 'still compared with the last commit');
    await page.eval(`$('#diffbase').value = $('#diffcommits').children[0].value; $('#diffbase').dispatchEvent(new Event('change'))`);
    await waitDiffMarks(page, 1, 'one change since the first commit');
    await page.click('#diffreload');
    await sleep(300);
    eq(await page.eval(`$('#diffbase').value`), await page.eval(`$('#diffcommits').children[0].value`), 'reload keeps the chosen commit');
    await waitDiffMarks(page, 1, 'one change since the first commit, after reload');
  },

  async 'Diff: saving while it is shown writes the document, not the diff'(env, page) {
    await page.select('brown');
    await page.type('red');
    await page.click('#diffbtn');
    await page.waitFor(`!$('#diffnav').hidden && /change/.test($('#diffcount').textContent)`, 8000, 'the diff');
    await page.key('s', { ctrl: true });
    await sleep(200);
    await page.waitFor('!SAVING');
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick red fox');
    eq(await page.eval(`document.querySelectorAll('#doc .d-del, #doc .d-ins, #doc .diff-ghost').length`), 0, 'no diff marks left');
    await page.waitFor(`DIFF.on && DIFF_SHOWN && /no changes/.test($('#diffcount').textContent)`, 8000, 'still in the diff, with nothing changed since the save');
    await page.click('#diffbtn');
    await page.waitFor(`!DIFF.on`);
    await page.select('red', 'end');
    await page.type('dish');
    await page.save();
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick reddish fox');
  },

  async 'Diff: Revert puts one change back and leaves the others'(env, page) {
    await page.select('brown');
    await page.type('red');
    await page.select('encryption');
    await page.type('signature');
    await page.click('#diffbtn');
    await page.waitFor(`!$('#diffnav').hidden && /2 changes/.test($('#diffcount').textContent)`, 8000, 'two changes');
    // revert the first change (the fox)
    await page.eval(`[...document.querySelectorAll('#doc .diff-revert')].find((b) => /red/.test(b.parentNode.textContent)).click()`);
    await page.waitFor(`/1 change/.test($('#diffcount').textContent)`, 8000, 'one change left');
    await page.click('#diffbtn');
    await page.waitFor(`$('#diffnav').hidden`);
    await page.save();
    onlyChange(env, 'main.tex', 'encryption schemes', 'signature schemes');
  },

  async 'Diff: waiting through a build, then leaving, keeps the document'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' one');
    await page.save();
    await page.select('lazy dog one', 'end');
    await page.type(' two');
    await page.click('#diffbtn');
    await sleep(4500);
    await page.click('#diffbtn');
    await page.waitFor(`$('#diffnav').hidden`);
    has(await page.pageText(), 'lazy dog one two', 'the unsaved edit');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog one two.');
  },

  async 'Diff: a structure button leaves it, undo stays in it, neither corrupts'(env, page) {
    await page.select('brown');
    await page.type('red');
    await page.click('#diffbtn');
    await page.waitFor(`/change/.test($('#diffcount').textContent)`, 8000, 'the diff');
    await page.click(paraPlus('Other papers'));
    await page.click(menuItem('Paragraph'));
    await page.waitFor(`!DIFF.on`, 3000, 'leaving the diff');
    await page.save();
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick red fox');
    await page.click('#diffbtn');
    await page.waitFor(`/change/.test($('#diffcount').textContent)`, 8000, 'the diff');
    await page.key('z', { ctrl: true });            // undoes, and draws the diff again
    await page.waitFor(`DIFF.on && DIFF_SHOWN && !DIFF.busy && DIFF.marks.length === 1`, 8000, 'the undone edit, as a change since the save');
    // the caret is at the undone change, so that block is the one being edited
    has(await page.eval(`diffEditSeg() ? diffEditSeg().edit.textContent : ''`), 'quick brown fox', 'the fox is brown again, in the edited block');
    await page.click('#diffbtn');
    await page.waitFor(`!DIFF.on`);
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'Diff: typing is blocked outside the block being edited'(env, page) {
    await page.click('#diffbtn');
    await page.waitFor(`!$('#diffnav').hidden`, 8000);
    await page.eval(`(() => { const seg = ORDER.find((s) => s.kind === 'para' && s.src.includes('lazy dog')); const r = document.createRange();
      r.selectNodeContents(seg.edit); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await page.type('XYZ');
    await page.key('$', { shift: true });
    await page.paste('pasted');
    await page.click('#diffbtn');
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'Diff: a click edits a block, and leaving it draws its changes'(env, page) {
    await page.select('brown');
    await page.type('red');
    await page.click('#diffbtn');
    await waitDiffMarks(page, 1, 'one change since the save');
    // an unchanged block: the click puts the caret in it, and typing works
    await page.click(`js:ORDER.find((s) => s.kind === 'para' && s.src.includes('encryption schemes')).edit`);
    await page.waitFor(`!DIFF.busy && diffEditSeg() && diffEditSeg().src.includes('encryption schemes') && document.activeElement === diffEditSeg().edit`, 8000, 'the block being edited');
    await page.eval(`(() => { const e = diffEditSeg().edit, r = document.createRange(); r.selectNodeContents(e); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await page.type(' Again');
    has(await page.eval(`diffEditSeg().edit.textContent`), 'Again', 'typed into the block');
    eq(await page.eval(`document.querySelectorAll('#doc .d-ins').length > 0`), true, 'the other change keeps its marks');
    // Esc leaves the block: its change is drawn as well
    await page.key('Escape');
    await waitDiffMarks(page, 2, 'two changes after leaving the block');
    eq(await page.eval(`!!diffEditSeg()`), false, 'no block edited');
    // a changed block: the caret goes into the new text, not the deleted one
    await page.click(`js:[...document.querySelectorAll('#doc .d-ins')].find((x) => /red/.test(x.textContent))`);
    await page.waitFor(`!DIFF.busy && diffEditSeg() && document.activeElement === diffEditSeg().edit`, 8000, 'the changed block being edited');
    eq(await page.eval(`diffEditSeg().edit.querySelectorAll('.d-del, .d-ins').length`), 0, 'drawn without marks while edited');
    await page.type('X');
    has(await page.eval(`diffEditSeg().edit.textContent`), 'quick ', 'the block text');
    const word = await page.eval(`diffEditSeg().edit.textContent.match(/quick (\\S+) fox/)[1]`);
    if (!/^r?e?X?r?e?d?$/.test(word) || !word.includes('X') || word.replace('X', '') !== 'red') throw new Error('the caret was not in "red": ' + word);
    // a save keeps the diff view and the block being edited
    await page.save();
    await page.waitFor(`DIFF.on && DIFF_SHOWN && !DIFF.busy && DIFF.marks.length === 0`, 8000, 'no change since the save');
    has(env.read('main.tex'), 'encryption schemes. Again', 'the edit in the diff view is saved');
    has(env.read('main.tex'), `quick ${word} fox`, 'the edit of the changed block is saved');
    await page.click('#diffbtn');
    await page.waitFor(`!DIFF.on`);
    eq(await page.eval(`document.querySelectorAll('#doc [contenteditable="false"][data-diff-edit]').length`), 0, 'every block editable again');
  },

  async 'Diff: a paragraph break while editing, then the focus leaves the text'(env, page) {
    await page.click('#diffbtn');
    await page.waitFor(`DIFF_SHOWN && !$('#diffnav').hidden`, 8000, 'the diff');
    await page.click(`js:ORDER.find((s) => s.kind === 'para' && s.src.includes('encryption schemes')).edit`);
    await page.waitFor(`!DIFF.busy && diffEditSeg() && document.activeElement === diffEditSeg().edit`, 8000, 'the block being edited');
    await page.select('encryption', 'end');
    await page.key('Enter');
    await page.type('Split');
    await page.waitFor(`!DIFF.busy && DIFF_SHOWN`, 8000, 'the diff again');
    // the focus leaving the text (a click beside it) leaves the block
    await page.eval(`(() => { const a = document.activeElement; if (a && a.blur) a.blur(); })()`);
    await page.waitFor(`!DIFF.busy && !diffEditSeg() && DIFF.marks.length >= 1`, 8000, 'the change drawn');
    await page.click('#diffbtn');
    await page.waitFor(`!DIFF.on`);
    await page.save();
    has(env.read('main.tex'), 'encryption\n\nSplit schemes', 'the paragraph break and the text after it');
  },

  // ---- figure viewer
  async 'figure viewer: edit the LaTeX, Apply, save'(env, page) {
    await page.click(`js:ORDER.find((s) => s.kind === 'figure').el.querySelector('div.small, img')`, { count: 2 });
    await page.waitFor(visible('#figview'), 8000, 'the figure viewer');
    await page.click(`.fv-tabs button[data-tab="latex"]`);
    await page.eval(`(() => { const ta = $('#fv-body textarea'); ta.value = ta.value.replace('fbox{box}', 'fbox{boxed}'); ta.dispatchEvent(new Event('input')); })()`);
    await page.click('#fv-apply');
    await page.save();
    onlyChange(env, 'main.tex', '\\fbox{box}', '\\fbox{boxed}');
  },

  async 'figure viewer: a LaTeX edit survives switching tabs, then Apply writes it'(env, page) {
    await page.click(`js:ORDER.find((s) => s.kind === 'figure').el.querySelector('div.small, img')`, { count: 2 });
    await page.waitFor(visible('#figview'), 8000, 'the figure viewer');
    await page.click(`.fv-tabs button[data-tab="latex"]`);
    await page.eval(`(() => { const ta = $('#fv-body textarea'); ta.value = ta.value.replace('fbox{box}', 'fbox{boxed}'); ta.dispatchEvent(new Event('input')); })()`);
    await page.click(`.fv-tabs button[data-tab="text"]`);          // leave the LaTeX tab
    await page.click(`.fv-tabs button[data-tab="latex"]`);
    has(await page.eval(`$('#fv-body textarea').value`), 'fbox{boxed}', 'the edit is still there');
    await page.click(`.fv-tabs button[data-tab="text"]`);
    await page.click('#fv-apply');                                   // Apply from another tab
    await page.save();
    onlyChange(env, 'main.tex', '\\fbox{box}', '\\fbox{boxed}');
  },

  async 'figure viewer keeps a caption edit made before it opened'(env, page) {
    await page.select('A caption here', 'end');
    await page.type(' edited');
    await page.eval(`lastTyping = 0`);
    await page.click(`js:ORDER.find((s) => s.kind === 'figure').el.querySelector('div.small, img')`, { count: 2 });
    await page.waitFor(visible('#figview'));
    await page.click(`.fv-tabs button[data-tab="latex"]`);
    has(await page.eval(`$('#fv-body textarea').value`), 'A caption here edited.', 'the viewer shows the edited caption');
    await page.eval(`(() => { const ta = $('#fv-body textarea'); ta.value = ta.value.replace('fbox{box}', 'fbox{boxed}'); ta.dispatchEvent(new Event('input')); })()`);
    await page.click('#fv-apply');
    await page.save();
    eq(env.read('main.tex'), MAIN.replace('fbox{box}', 'fbox{boxed}').replace('A caption here.', 'A caption here edited.'), 'main.tex');
  },

  async 'figure viewer: Close and Escape change nothing'(env, page) {
    await page.click(`js:ORDER.find((s) => s.kind === 'figure').el.querySelector('div.small, img')`, { count: 2 });
    await page.waitFor(visible('#figview'));
    await page.key('Escape');
    await page.waitFor(`$('#figview').hidden`);
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'game editor: loops colours undo and game blocks'(env, page) {
    await page.click("js:ORDER.find((s) => s.kind === 'figure').el.querySelector('div.small, img')", { count: 2 });
    await page.waitFor(visible('#figview'));
    const src = ['\\begin{figure}', '\\begin{gameenv}{Game A}', '  \\State $x \\gets y$',
      '\\end{gameenv}', '\\begin{gameenv}{Game B}', '  \\State $z \\gets w$',
      '\\end{gameenv}', '\\end{figure}'].join('\n');
    const state = await page.eval('(() => { const src = ' + JSON.stringify(src) +
      '; FV.src = src; FV.games = parseGames(src); FV.tables = L.parseTabulars(src);' +
      ' showFigTab("games"); return { count: FV.games.length, spans: FV.games.map((g) => [g.start, g.end]) }; })()');
    eq(state.count, 2, 'both gameenv blocks parsed');
    eq(state.spans.every(([a, b]) => b > a), true, 'whole game spans available');
    await page.eval('(() => { const menu = document.querySelector("#fv-body .g-insert");' +
      ' menu.value = "While"; menu.parentElement.querySelector("button").click(); })()');
    has(await page.eval('figureWithEdits()'), '\\While{$c$}', 'inserted while block');
    has(await page.eval('figureWithEdits()'), '\\EndWhile', 'while loop has an end');
    await page.click('#fv-undo');
    eq(await page.eval('figureWithEdits()'), src, 'undo restores exact source');
    await page.click('#fv-redo');
    has(await page.eval('figureWithEdits()'), '\\While{$c$}', 'redo restores while block');
    await page.eval('(() => { FILES[DOC.main].text += String.fromCharCode(92) + "usepackage{xcolor}";' +
      ' const menu = document.querySelector("#fv-body select.g-mark:not(:disabled)");' +
      ' menu.value = "yellow!20"; menu.dispatchEvent(new Event("change")); })()');
    has(await page.eval('figureWithEdits()'), '\\colorbox{yellow!20}', 'colour mark emits LaTeX');
    await page.eval('gameMove(0, 1)');
    eq(await page.eval('FV.games[0].title'), 'Game B', 'game blocks were reordered');
    await page.click('#fv-undo');
    eq(await page.eval('FV.games[0].title'), 'Game A', 'reorder can be undone');
    await page.click('#fv-add-game');
    eq(await page.eval('FV.games.length'), 3, 'game created');
    await page.click('#fv-undo');
    eq(await page.eval('FV.games.length'), 2, 'creation undone');
    await page.click('#fv-close');
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  async 'game editor: games arranged in a grid of cells, written as minipages'(env, page) {
    await page.click("js:ORDER.find((s) => s.kind === 'figure').el.querySelector('div.small, img')", { count: 2 });
    await page.waitFor(visible('#figview'));
    const game = (t) => ['\\begin{gameenv}{' + t + '}', '  \\State $x \\gets y$', '\\end{gameenv}'].join('\n');
    const src = ['\\begin{figure}', '\\begin{multicols}{1}', game('Circuit'), game('Oracle'), game('Adversary'),
      '\\end{multicols}', '\\caption{C.}', '\\end{figure}'].join('\n');
    await page.eval('(() => { const src = ' + JSON.stringify(src) +
      '; FV.src = src; FV.games = parseGames(src); FV.tables = L.parseTabulars(src); FV.undo = []; showFigTab("games"); })()');
    eq(await page.eval(`document.querySelectorAll('#fv-body .gcell').length`), 3, 'one column: a cell per game');
    await page.click("js:[...document.querySelectorAll('#fv-body .games-layout button')].find((b) => b.textContent === '2')");
    const out = await page.eval('figureWithEdits()');
    has(out, '\\begin{minipage}[t]{.48\\linewidth}', 'minipages of half the width');
    has(out, '\\begin{multicols}{1}', 'the wrapper keeps one column');
    const lay = () => page.eval('(() => { const s = figureWithEdits(); const l = L.gameLayout(s, parseGames(s), []); return JSON.stringify(l.rows.map((r) => r.map((c) => c.map((g) => parseGames(s)[g].title)))); })()');
    eq(await lay(), JSON.stringify([[['Circuit'], ['Oracle']], [['Adversary'], []]]), 'oracle beside the circuit, adversary below');
    // the adversary goes under the circuit, in the same cell
    await page.eval('stepGame(2, -1, 0)');
    eq(await lay(), JSON.stringify([[['Circuit', 'Adversary'], ['Oracle']]]), 'stacked in a cell');
    await page.eval('stepGame(1, 0, 1)');   // the adversary (second in the source now) to the right
    eq(await lay(), JSON.stringify([[['Circuit'], ['Oracle', 'Adversary']]]), 'moved right, at the same height in the stack');
    await page.click('#fv-undo');
    eq(await lay(), JSON.stringify([[['Circuit', 'Adversary'], ['Oracle']]]), 'undo');
    await page.click("js:[...document.querySelectorAll('#fv-body .games-layout button')].find((b) => b.textContent === '1')");
    eq(await page.eval('figureWithEdits().includes("minipage")'), false, 'one column: no minipages');
    await page.click('#fv-close');
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  async 'menus: every item of the ☰ menu takes its own clicks; back and forward'(env, page) {
    await page.click('#menubtn');
    const hits = await page.eval(`(() => [...$('#mainmenu').querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => {
      const r = b.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return (h && h.closest('button') || {}).id === b.id ? '' : b.id; }).filter(Boolean))()`);
    eq(hits.join(), '', 'items covered by something else');
    await page.key('Escape');
    eq(await page.eval(`$('#mainmenu').hidden`), true, 'Escape closes the menu');
    eq(await page.eval(`$('#navback').disabled`), true, 'nothing to go back to');
    await page.eval(`window.scrollTo(0, 0); jumpTo(ORDER.filter((x) => x.el && x.el.isConnected).pop().el, 'End')`);
    await sleep(200);
    const far = await page.eval(`scrollY`);
    await page.click('#navback');
    await sleep(200);
    eq(await page.eval(`scrollY < ${far}`), true, 'back');
    await page.click('#navfwd');
    await sleep(200);
    eq(await page.eval(`Math.abs(scrollY - ${far}) < 40`), true, 'forward');
  },

  async 'rendering: \\lstinline, \\qedhere and maths in a theorem title'(env, page) {
    const r = await page.eval(String.raw`(() => {
      const d = document.createElement('div');
      renderTokens(L.tokenize('use \\lstinline|x <$ d| and \\lstinline{y}; \\begin{lemma}[At $r$]x $a\\qedhere$\\end{lemma}'), d, {});
      return { text: d.textContent, bad: d.querySelectorAll('.bad').length, title: d.querySelector('.thmtitle .katex') !== null };
    })()`);
    has(r.text, 'use x <$ d and y', 'verbatim text shown, not its source');
    eq(r.bad, 0, 'qedhere typesets');
    eq(r.title, true, 'the title maths is typeset');
  },

  async 'rendering: a proof\'s optional title is typeset, the reference resolved'(env, page) {
    const r = await page.eval(String.raw`(() => {
      const d = document.createElement('div');
      renderTokens(L.tokenize('\\begin{proof}[Proof of Theorem~\\ref{sec:intro}]Body.\\end{proof}'), d, {});
      const runin = d.querySelector('.chip.runin');
      const ref = runin.querySelector('.chip.ref');
      const end = [...d.querySelectorAll('.chip')].find((c) => c.dataset.src.includes('\\end{proof}'));
      return { text: runin.textContent, hasRef: !!ref, ref: ref && ref.textContent,
        want: labelValue('sec:intro') || '??', raw: runin.dataset.src, end: end.textContent, back: ser(d) };
    })()`);
    eq(r.hasRef, true, 'the \\ref in the proof title is a reference chip');
    eq(r.ref, r.want, 'it shows the number from the .aux');
    has(r.text, 'Proof of Theorem', 'the title reads as text');
    eq(r.text.includes('\\ref'), false, 'no raw \\ref in the shown title');
    eq(r.raw, String.raw`\begin{proof}[Proof of Theorem~\ref{sec:intro}]`, 'the whole \\begin..[..] stays as the chip source');
    eq(r.end, ' ∎', 'the end mark is still there');
    eq(r.back, String.raw`\begin{proof}[Proof of Theorem~\ref{sec:intro}]Body.\end{proof}`, 'the DOM round-trips to the exact source');
    // a proof without a title keeps the plain run-in
    const plain = await page.eval(String.raw`(() => {
      const d = document.createElement('div');
      renderTokens(L.tokenize('\\begin{proof}Body.\\end{proof}'), d, {});
      return d.querySelector('.chip.runin').textContent;
    })()`);
    eq(plain, 'Proof. ', 'no optional title: plain Proof.');
    untouched(env, 'main.tex');
  },

  async 'reader: edits are read as they are now; a redraw does not restart the phrase'(env, page) {
    await fakeSpeech(page);
    await page.select('lazy dog', 'start');
    await page.click('#play');
    has(await page.eval(`__fake.spoken[0]`), 'The quick brown fox', 'first phrase');
    // the next phrase is edited while the first is read
    await page.select('We study', 'start');
    await page.type('Here ');
    await page.eval(`__fake.finish()`);
    has(await page.eval(`__fake.spoken[1]`), 'Here We study', 'the edited text is read');
    // a redraw (a save) while reading: the phrase goes on
    await page.eval(`commit(); render()`);
    eq(await page.eval(`__fake.spoken.length`), 2, 'not read again after a redraw');
    eq(await page.eval(`$('#tts-state').textContent`), 'Reading', 'still reading');
    // paused, the phrase is edited: resume reads it as it is now
    await page.click('#pause');
    await page.select('Here We', 'start');
    await page.type('So ');
    await page.click('#pause');
    has(await page.eval(`__fake.spoken[__fake.spoken.length - 1]`), 'So Here We study', 'resumed with the edit');
    await page.click('#stop');
  },

  // ---- combinations
  async 'a selection across two paragraphs: ( wraps nothing and deletes nothing'(env, page) {
    await selectSpan(page, 'lazy', 'A second');
    await page.key('(', { shift: true });
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'a selection across two paragraphs: paste, Ctrl+B, $ change nothing'(env, page) {
    await selectSpan(page, 'lazy', 'A second');
    await page.paste('pasted');
    await selectSpan(page, 'lazy', 'A second');
    await page.key('$', { shift: true });
    await selectSpan(page, 'lazy', 'A second');
    await page.key('b', { ctrl: true });
    await page.save();
    untouched(env, 'main.tex', 'sections/body.tex');
    has(await page.pageText(), 'A second paragraph', 'page text');
  },

  async 'a selection across two paragraphs: typing replaces it and joins them'(env, page) {
    await selectSpan(page, 'lazy', 'A second');
    await page.type('x');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.\nWe study $x^2 + y^2$ here.\n\nA second paragraph', 'x paragraph');
  },

  async 'a selection across two paragraphs: Backspace deletes it, undo brings it back'(env, page) {
    await selectSpan(page, 'lazy', 'A second');
    await page.key('Backspace');
    eq(await unsaved(page), 1, 'edited after Backspace');
    await page.key('z', { ctrl: true });
    eq(await unsaved(page), 0, 'edited after undo');
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'a selection across two paragraphs: cut copies both and joins them'(env, page) {
    await selectSpan(page, 'lazy', 'A second');
    const got = await page.copy('cut');
    has(got['text/plain'], 'lazy dog.', 'plain text of the first');
    has(got['text/plain'], 'A second', 'plain text of the second');
    has(got['application/x-paper-editor-latex'], '$x^2 + y^2$', 'LaTeX of the first');
    await page.save();
    onlyChange(env, 'main.tex', 'the lazy dog.\nWe study $x^2 + y^2$ here.\n\nA second paragraph', 'the paragraph');
  },

  async 'a selection from a heading into its text: nothing is merged'(env, page) {
    await selectSpan(page, 'Conclusion', 'Final');
    await page.type('x');
    await page.key('Backspace');
    await page.save();
    untouched(env, 'main.tex');
  },

  async '$ on a selection in a heading'(env, page) {
    await page.select('Details');
    await page.key('$', { shift: true });
    await page.save();
    onlyChange(env, 'sections/body.tex', '\\subsection{Details}', '\\subsection{$Details$}');
  },

  async 'Enter in a heading or a caption adds no paragraph'(env, page) {
    await page.select('Conclusion', 'end');
    await page.key('Enter');
    await page.select('A caption', 'end');
    await page.key('Enter');
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'typing LaTeX special characters escapes them'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' 100% & #1 a_b {x} ~ ^ \\');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog 100\\% \\& \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}.');
  },

  async 'pasting several lines into a heading keeps it one line'(env, page) {
    await page.select('Conclusion', 'end');
    await page.paste(' and\n\nmore\r\nlines');
    await page.save();
    onlyChange(env, 'main.tex', '\\section{Conclusion}', '\\section{Conclusion and more lines}');
  },

  async 'pasting with no plain text does nothing'(env, page) {
    await page.select('lazy dog', 'end');
    await page.eval(`(() => { const dt = new DataTransfer(); dt.setData('text/html', '<b>x</b>');
      getSelection().anchorNode.parentElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'wrap the whole paragraph, and wrap inside emphasis'(env, page) {
    await page.eval(`(() => { const seg = ORDER.find((s) => s.kind === 'para' && s.src.startsWith('Other papers'));
      const r = document.createRange(); r.selectNodeContents(seg.edit); seg.edit.focus(); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await page.key('[');
    await page.select('lazy dog');
    await page.key('i', { ctrl: true });
    await page.select('lazy');
    await page.key('(', { shift: true });
    await page.save();
    eq(env.read('main.tex'), MAIN.replace('Other papers exist.', '[Other papers exist.]').replace('lazy dog', '\\emph{(lazy) dog}'), 'main.tex');
  },

  async 'wrapping a formula alone, and $ on an existing formula'(env, page) {
    await page.eval(`(() => { const m = document.querySelector('#doc .chip.math'); const r = document.createRange(); r.selectNode(m);
      m.parentElement.focus(); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await page.key('(', { shift: true });
    await page.key('$', { shift: true });
    await page.save();
    onlyChange(env, 'main.tex', 'We study $x^2 + y^2$ here.', 'We study ($x^2 + y^2$) here.');
  },

  async '$ over text with %, #, & and a lone brace keeps the file valid'(env, page) {
    await page.select('Details', 'end');
    await page.type(' 5%% #1 & {');
    await page.select('Details 5%% #1 & {');
    await page.key('$', { shift: true });
    await page.save();
    onlyChange(env, 'sections/body.tex', '\\subsection{Details}', '\\subsection{$Details 5\\%\\% \\#1 \\& \\{$}');
  },

  async 'quote keys over a selection give TeX quotes'(env, page) {
    await page.select('quick');
    await page.key("'");
    await page.select('lazy');
    await page.key('`');
    await page.save();
    onlyChange(env, 'main.tex', 'The quick brown fox jumps over the lazy dog.', "The `quick' brown fox jumps over the `lazy' dog.");
  },

  async 'Ctrl+P duplicates the selection'(env, page) {
    await page.select('brown');
    await page.key('p', { ctrl: true });
    await page.save();
    onlyChange(env, 'main.tex', 'quick brown fox', 'quick brown brown fox');
  },

  async 'Backspace join, then undo gives the two paragraphs back'(env, page) {
    await page.select('A second', 'start');
    await page.key('Backspace');
    await page.waitFor('editedFiles().length === 1');
    await page.key('z', { ctrl: true });
    await page.waitFor('editedFiles().length === 0', 4000, 'undo');
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'redo is cleared by new typing'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' A');
    await sleep(1300);
    await page.key('z', { ctrl: true });
    await page.waitFor(`!document.querySelector('#doc').innerText.includes('lazy dog A')`);
    await page.select('lazy dog', 'end');
    await page.type(' B');
    await page.key('z', { ctrl: true, shift: true });
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog B.');
  },

  async 'undo after a save and the reload that follows the build'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' A');
    const v = await page.eval('AUXVER');
    await page.save();
    await page.waitFor(`AUXVER > ${v} && DOC.auxver === AUXVER`, 8000, 'the reload');
    await page.key('z', { ctrl: true });
    await page.waitFor('editedFiles().length === 1', 4000, 'undo after reload');
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'the drawer open: an outside change waits, and the drawer keeps its text'(env, page) {
    await page.eval(`document.querySelector('#doc .chip.math').click()`);
    await page.waitFor(visible('#drawer'));
    await page.eval(`$('#drawer-src').value = '$x^9$'`);
    env.write('sections/body.tex', BODY.replace('Detail text', 'Changed outside'));
    await sleep(3000);
    eq(await page.eval(`$('#drawer-src').value`), '$x^9$', 'the drawer text');
    await page.click('#drawer-apply');
    await page.waitFor(`document.querySelector('#doc').innerText.includes('Changed outside')`, 8000, 'the reload after the drawer');
    await page.save();
    onlyChange(env, 'main.tex', '$x^2 + y^2$', '$x^9$');
  },

  async 'Ctrl+S with the drawer open saves the rest and keeps the drawer'(env, page) {
    await page.select('lazy dog', 'end');
    await page.type(' kept');
    await page.eval(`document.querySelector('#doc .chip.math').click()`);
    await page.waitFor(visible('#drawer'));
    await page.key('s', { ctrl: true });
    await sleep(200);
    await page.waitFor('!SAVING');
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog kept.');
    eq(await page.eval(`$('#drawer').hidden`), false, 'the drawer is still open');
  },

  async 'a click on a citation opens it; Delete removes it'(env, page) {
    await page.select('lazy dog', 'end');
    await page.click(tb('latex'));
    await page.eval(`$('#drawer-src').value = '\\\\cite{GM84}'`);
    await page.click('#drawer-apply');
    await page.save();
    await page.click('#doc .chip.cite');
    await page.waitFor(visible('#drawer'));
    eq(await page.eval(`$('#drawer-src').value`), '\\cite{GM84}', 'drawer source');
    await page.click('#drawer-delete');
    await page.save();
    untouched(env, 'main.tex');
  },

  async 'a code edit survives a structure edit elsewhere'(env, page) {
    await page.eval(`(() => { const ta = ORDER.find((s) => s.kind === 'code').edit; ta.focus(); ta.setSelectionRange(ta.value.indexOf('line') + 4, ta.value.indexOf('line') + 4); })()`);
    await page.type(' two');
    await page.click(headBtn('Related work', 'Delete this heading'));
    await page.save();
    has(env.read('main.tex'), 'code line two', 'the code edit');
    hasNot(env.read('main.tex'), 'Related work', 'the heading');
  },

  async 'typing into a block, Ctrl+Z, typing elsewhere, save: only the second edit'(env, page) {
    await page.select('Detail text', 'end');
    await page.type(' first');
    await sleep(1300);
    await page.key('z', { ctrl: true });
    await page.waitFor('editedFiles().length === 0');
    await page.select('lazy dog', 'end');
    await page.type(' second');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog second.');
    untouched(env, 'sections/body.tex');
  },

  async 'Enter twice, then Backspace twice, gives the paragraph back'(env, page) {
    await page.select('jumps', 'start');
    await page.key('Enter');
    await page.key('Enter');
    await page.key('Backspace');
    await page.key('Backspace');
    await page.save();
    untouched(env, 'main.tex');
  },
});

// ------------------------------------------------------------ saving, hard:
// failures, races, other tabs, odd files, and the history of every save

const historyLog = (env) => {
  const p = path.join(env.state, 'history', 'log.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const blob = (env, id) => fs.readFileSync(path.join(env.state, 'history', 'blobs', id), 'utf8');
const tmpLeft = (env) => {
  const out = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.editor-|\.tmp$/.test(f)) out.push(p); } };
  walk(env.paper);
  return out;
};
async function typeAt(page, needle, text) { await page.select(needle, 'end'); await page.type(text); }

Object.assign(TESTS, {
  async 'save: every save is in the history, with the text before and after'(env, page) {
    await typeAt(page, 'lazy dog', ' one');
    await page.save();
    await typeAt(page, 'Detail text', ' two');
    await typeAt(page, 'lazy dog one', ' three');
    await page.save();
    const log = historyLog(env);
    eq(log.length, 3, 'history lines (one per file written)');
    eq(blob(env, log[0].before), MAIN, 'before the first save');
    eq(blob(env, log[0].after), MAIN.replace('lazy dog.', 'lazy dog one.'), 'after the first save');
    eq(log[1].batch, log[2].batch, 'files saved together are one entry');
    eq(blob(env, log[2].after) === env.read(log[2].name), true, 'the last version is the file on disk');
    has(fs.readFileSync(path.join(env.state, '.gitignore'), 'utf8'), 'history/', 'the history is not tracked by git');
  },

  async 'History UI: delete selected and clear all without touching the manuscript'(env, page) {
    await typeAt(page, 'lazy dog', ' one');
    await page.save();
    await typeAt(page, 'lazy dog one', ' two');
    await page.save();
    const paperBefore = env.read('main.tex');
    await page.click('#historybtn');
    await page.waitFor(`document.querySelectorAll('#history-list .hist-item').length === 2`);
    await page.click('#history-list .hist-item:last-child');
    await page.click('#history-delete');
    await page.waitFor(`document.querySelectorAll('#history-list .hist-item').length === 1`);
    eq(historyLog(env).length, 1, 'one snapshot remains');
    await page.click('#history-clear');
    await page.waitFor(`document.querySelectorAll('#history-list .hist-item').length === 0`);
    eq(historyLog(env).length, 0, 'all snapshots removed');
    eq(env.read('main.tex'), paperBefore, 'paper content was not affected');
    await page.click('#history-close');
  },

  async 'History dialog: shows the saves, restores before a save, and that save is recorded too'(env, page) {
    await typeAt(page, 'lazy dog', ' one');
    await page.save();
    await typeAt(page, 'lazy dog one', ' two');
    await page.save();
    await page.click('#historybtn');
    await page.waitFor(`document.querySelectorAll('#history-list .hist-item').length === 2`, 4000, 'two saves listed');
    await page.click('#history-list .hist-item:last-child');            // the older save
    await page.waitFor(`document.querySelector('#history-detail pre.hist-diff .ins')`, 4000, 'its diff');
    has(await page.eval(`$('#history-detail').textContent`), 'lazy dog one.', 'the diff shows the change');
    await page.click(`js:[...document.querySelectorAll('#history-detail button')].find((b) => b.textContent.includes('before'))`);
    await page.waitFor(`$('#historybox').hidden`);
    eq(await page.eval(`editedFiles().join()`), 'main.tex', 'restored as an unsaved edit');
    eq(env.read('main.tex'), MAIN.replace('lazy dog.', 'lazy dog one two.'), 'nothing written by restoring');
    await page.save();
    eq(env.read('main.tex'), MAIN, 'saved: the original is back');
    eq(historyLog(env).length, 3, 'the restore is in the history too');
    // and undoing the restore brings the newer text back
    await page.key('z', { ctrl: true });
    await page.save();
    eq(env.read('main.tex'), MAIN.replace('lazy dog.', 'lazy dog one two.'), 'undo of the restore');
  },

  async 'History: restoring a save of several files restores them all'(env, page) {
    await typeAt(page, 'lazy dog', ' A');
    await typeAt(page, 'Detail text', ' B');
    await page.save();
    await page.click('#historybtn');
    await page.waitFor(`document.querySelectorAll('#history-list .hist-item').length === 1`);
    await page.click('#history-list .hist-item');
    await page.click(`js:[...document.querySelectorAll('#history-detail button')].find((b) => b.textContent.includes('before'))`);
    await page.save();
    untouched(env, 'main.tex', 'sections/body.tex');
  },

  async 'History: restoring over unsaved edits asks, and No keeps them'(env, page) {
    await typeAt(page, 'lazy dog', ' saved');
    await page.save();
    await typeAt(page, 'lazy dog saved', ' unsaved');
    await page.click('#historybtn');
    await page.waitFor(`document.querySelectorAll('#history-list .hist-item').length === 1`);
    await page.click('#history-list .hist-item');
    page.dialogAnswer = false;
    await page.click(`js:[...document.querySelectorAll('#history-detail button')].find((b) => b.textContent.includes('before'))`);
    page.dialogAnswer = true;
    has(page.dialogs.join('\n'), 'unsaved edits', 'the question');
    has(await page.pageText(), 'lazy dog saved unsaved', 'the edits are kept');
  },

  async 'History survives a restart of the editor'(env, page) {
    await typeAt(page, 'lazy dog', ' one');
    await page.save();
    await env.stopServer();
    await env.startServer();
    const page2 = await env.openPage(CHROME);
    await page2.click('#historybtn');
    await page2.waitFor(`document.querySelectorAll('#history-list .hist-item').length === 1`, 4000, 'the save after a restart');
  },

  async 'Overwrite keeps the version it overwrote in the history'(env, page) {
    await typeAt(page, 'Detail text', ' mine');
    await page.eval(`lastTyping = 0`);
    const theirs = BODY.replace('Detail text', 'Theirs');
    env.write('sections/body.tex', theirs);
    await page.waitFor(`!$('#external').hidden`, 8000, 'the conflict dialog');
    await page.click('#external-overwrite');
    await page.waitFor(`!SAVING && editedFiles().length === 0`);
    const log = historyLog(env);
    eq(blob(env, log[log.length - 1].before), theirs, 'the other version is recoverable');
  },

  async 'a save the server refuses (500) keeps the edits, and the next save works'(env, page) {
    await typeAt(page, 'lazy dog', ' kept');
    await page.interceptSaves('fail');
    await page.save();
    await page.waitFor(`!$('#banner').hidden`, 5000, 'the error banner');
    has(await page.banner(), 'disk on fire', 'the error is shown');
    eq(await page.eval(`editedFiles().join()`), 'main.tex', 'still edited');
    untouched(env, 'main.tex');
    await page.interceptSaves(null);
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog kept.');
    eq(await page.eval(`$('#external').hidden`), true, 'no conflict');
  },

  async 'a save whose connection drops keeps the edits'(env, page) {
    await typeAt(page, 'lazy dog', ' kept');
    await page.interceptSaves('drop');
    await page.save();
    has(await page.banner(), 'still here', 'the error is shown');
    eq(await page.eval(`editedFiles().join()`), 'main.tex', 'still edited');
    await page.interceptSaves(null);
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog kept.');
  },

  async 'the editor server down: save fails safely, and works when it is back'(env, page) {
    await typeAt(page, 'lazy dog', ' offline');
    await env.stopServer();
    await page.save();
    has(await page.banner(), 'still here', 'the error');
    eq(await page.eval(`editedFiles().length`), 1, 'still edited');
    await env.startServer();
    await sleep(2500);       // a poll on the server that came back
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog offline.');
    eq(await page.eval(`$('#external').hidden`), true, 'no conflict');
    hasNot(await page.banner(), 'failed', 'the old failure is not shown after the save worked');
  },

  async 'typing while a save is on its way: the typing stays an edit and the next save writes it'(env, page) {
    await typeAt(page, 'lazy dog', ' first');
    await page.interceptSaves('hold');
    await page.key('s', { ctrl: true });
    await page.waitFor(`SAVING`);
    await typeAt(page, 'lazy dog first', ' second');
    await typeAt(page, 'Detail text', ' third');
    await page.interceptSaves(null);         // releases the save
    await page.waitFor('!SAVING');
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog first.');
    has(await page.pageText(), 'lazy dog first second', 'the typing during the save');
    eq(await page.eval(`editedFiles().sort().join()`), 'main.tex,sections/body.tex', 'still edited');
    await page.save();
    eq(env.read('main.tex'), MAIN.replace('lazy dog.', 'lazy dog first second.'), 'main.tex');
    onlyChange(env, 'sections/body.tex', 'Detail text', 'Detail text third');
  },

  async 'Enter (a re-render after saving) while a save is on its way keeps everything'(env, page) {
    await page.select('jumps', 'start');
    await page.key('Enter');
    await page.interceptSaves('hold');
    await page.key('s', { ctrl: true });
    await page.waitFor(`SAVING`);
    await typeAt(page, 'lazy dog', ' during');
    await page.interceptSaves(null);
    await page.waitFor('!SAVING');
    has(await page.pageText(), 'lazy dog during', 'typing during the save survives the re-render');
    await page.save();
    eq(env.read('main.tex'), MAIN.replace('fox jumps', 'fox \n\njumps').replace('lazy dog.', 'lazy dog during.'), 'main.tex');
  },

  async 'Ctrl+S three times while a save is on its way: one more save, no conflict'(env, page) {
    await typeAt(page, 'lazy dog', ' a');
    await page.interceptSaves('hold');
    await page.key('s', { ctrl: true });
    await page.waitFor(`SAVING`);
    await typeAt(page, 'lazy dog a', ' b');
    for (let i = 0; i < 3; i++) await page.key('s', { ctrl: true });
    await page.interceptSaves(null);
    await sleep(300);
    // the follow-up save is held too until interception is off: release again
    await page.release();
    await page.waitFor('!SAVING', 8000);
    eq(env.read('main.tex'), MAIN.replace('lazy dog.', 'lazy dog a b.'), 'main.tex');
    eq(await page.eval(`$('#external').hidden`), true, 'no conflict');
    eq(historyLog(env).length, 2, 'two saves');
  },

  async 'a file deleted on disk: saving asks, and Overwrite writes it again'(env, page) {
    await typeAt(page, 'Detail text', ' rescued');
    fs.unlinkSync(path.join(env.paper, 'sections/body.tex'));
    await page.save();
    await page.waitFor(`!$('#external').hidden`, 4000, 'the dialog');
    await page.click('#external-overwrite');
    await page.waitFor(`!SAVING && editedFiles().length === 0`, 8000, 'the save');
    eq(env.read('sections/body.tex'), BODY.replace('Detail text', 'Detail text rescued'), 'the file is back, with the edit');
  },

  async 'a folder that cannot be written: the save fails, the edits stay, nothing is left behind'(env, page) {
    if (process.getuid && process.getuid() === 0) return;       // root writes anywhere
    await typeAt(page, 'lazy dog', ' blocked');
    fs.chmodSync(env.paper, 0o555);
    await page.save();
    fs.chmodSync(env.paper, 0o755);
    has(await page.banner(), 'main.tex', 'the error names the file');
    untouched(env, 'main.tex');
    eq(tmpLeft(env).join(), '', 'temporary files');
    eq(await page.eval(`editedFiles().length`), 1, 'still edited');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog blocked.');
  },

  async 'CRLF line endings, a byte-order mark, tabs and no final newline survive an edit'(env, page) {
    const odd = '﻿\\section{Body}\\label{sec:body}\r\nBody\ttext with a formula $\\Adv$ and more words.\r\n\r\n\\subsection{Details}\r\nDetail text lives here.';
    env.write('sections/body.tex', odd);
    await page.waitFor(`document.querySelector('#doc').innerText.includes('Body\\ttext')`, 8000, 'the reload');
    await typeAt(page, 'Detail text', ' edited');
    await page.save();
    eq(env.read('sections/body.tex'), odd.replace('Detail text', 'Detail text edited'), 'byte for byte, but the edit');
  },

  async 'two tabs editing the same file: the second save asks instead of overwriting'(env, page) {
    const other = await env.openPage(CHROME);
    await typeAt(page, 'Detail text', ' from A');
    await typeAt(other, 'Detail text', ' from B');
    await page.save();
    onlyChange(env, 'sections/body.tex', 'Detail text', 'Detail text from A');
    await other.save();
    await other.waitFor(`!$('#external').hidden`, 4000, 'the conflict dialog in tab B');
    onlyChange(env, 'sections/body.tex', 'Detail text', 'Detail text from A');
    await other.click('#external-overwrite');
    await other.waitFor(`!SAVING && editedFiles().length === 0`);
    onlyChange(env, 'sections/body.tex', 'Detail text', 'Detail text from B');
    const log = historyLog(env);
    eq(blob(env, log[log.length - 1].before), BODY.replace('Detail text', 'Detail text from A'), "A's version is in the history");
  },

  async 'two tabs editing different files: both saves land'(env, page) {
    const other = await env.openPage(CHROME);
    await typeAt(page, 'lazy dog', ' A');
    await typeAt(other, 'Detail text', ' B');
    await page.save();
    await other.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog A.');
    onlyChange(env, 'sections/body.tex', 'Detail text', 'Detail text B');
    eq(await other.eval(`$('#external').hidden`), true, 'no conflict in B');
    await other.waitFor(`document.querySelector('#doc').innerText.includes('lazy dog A')`, 8000, "B sees A's save");
  },

  async 'leaving the page with unsaved edits asks first; with none, it does not'(env, page) {
    page.dialogAnswer = false;
    await typeAt(page, 'lazy dog', ' unsaved');
    await page.waitFor('editedFiles().length === 1');
    await page.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
    await sleep(500);
    has(await page.eval(`location.href`), '127.0.0.1', 'still on the editor');
    await page.save();
    page.dialogAnswer = true;
    const before = page.dialogs.length;
    await page.send('Page.navigate', { url: 'about:blank' });
    await sleep(500);
    eq(page.dialogs.length, before, 'no question once saved');
  },

  async 'after saving, a fresh page shows the saved text and reads every block back exactly'(env, page) {
    await typeAt(page, 'lazy dog', ' $x$ and 50%');
    await page.select('brown'); await page.key('$', { shift: true });
    await page.select('Conclusion', 'end'); await page.type('s');
    await page.save();
    const fresh = await env.openPage(CHROME);
    eq(await fresh.eval(`editedFiles().length`), 0, 'nothing edited on a fresh page');
    eq(await fresh.eval(`ORDER.filter((s) => s.edit && segSource(s, []) !== s.src).length`), 0, 'blocks that do not read back');
    eq(await fresh.pageText(), await page.pageText(), 'the same page');
  },

  async 'Ctrl+S from the find bar, the palette and the drawer saves'(env, page) {
    await typeAt(page, 'lazy dog', ' 1');
    await page.key('f', { ctrl: true });
    await page.key('s', { ctrl: true });
    await sleep(150); await page.waitFor('!SAVING');
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog 1.');
    await page.key('Escape');
    await typeAt(page, 'lazy dog 1', '2');
    await page.key('c', { ctrl: true, alt: true });
    await page.waitFor(visible('#palette'));
    await page.key('s', { ctrl: true });
    await sleep(150); await page.waitFor('!SAVING');
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog 12.');
    await page.key('Escape');
    await typeAt(page, 'lazy dog 12', '3');
    await page.eval(`document.querySelector('#doc .chip.math').click()`);
    await page.waitFor(visible('#drawer'));
    await page.key('s', { ctrl: true });
    await sleep(150); await page.waitFor('!SAVING');
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog 123.');
  },

  async 'undo back to the saved text: nothing to save, nothing in the history'(env, page) {
    await typeAt(page, 'lazy dog', ' oops');
    await page.waitFor('editedFiles().length === 1');
    await page.key('z', { ctrl: true });
    await page.waitFor('editedFiles().length === 0');
    await page.save();
    untouched(env, 'main.tex');
    eq(historyLog(env).length, 0, 'history');
  },

  async 'citation search: slow broad queries never hide the results of the last one'(env, page) {
    // a big bibliography: every short query matches thousands of entries
    let big = BIB;
    for (let i = 0; i < 20000; i++) big += `@misc{K${i},\n  author = {Alice Author${i % 97} and Bob}, title = {A study of thing ${i}}, year = {${1990 + (i % 30)}},\n}\n`;
    env.write('refs.bib', big);
    await page.select('lazy dog', 'end');
    await page.key('c', { ctrl: true, alt: true });
    await page.waitFor(visible('#palette'));
    // type it as a person: a keystroke at a time, with typos fixed
    for (const c of 'gpldw') { await page.key(c); await sleep(40); }
    for (let i = 0; i < 4; i++) { await page.key('Backspace'); await sleep(40); }
    for (const c of 'oldwasser') { await page.key(c); await sleep(40); }
    await page.waitFor(`PAL.items.length === 1 && PAL.items[0].key === 'GM84'`, 6000, 'the result for the last query');
    await page.eval(`$('#pal-q').select()`);
    for (const c of 'a') await page.key(c);
    await page.waitFor(`PAL.items.length > 10`, 6000, 'results for a broad query');
    await page.eval(`$('#pal-q').select()`);
    for (const c of 'zzzz') await page.key(c);
    await page.waitFor(`PAL.items.length === 0 && /Nothing/.test($('#pal-list').textContent)`, 6000, 'no results, said so');
    for (let i = 0; i < 4; i++) await page.key('Backspace');
    for (const c of 'micali') await page.key(c);
    await page.waitFor(`PAL.items.length === 1`, 6000, 'results again after nothing was found');
    await page.key('Enter');
    await page.save();
    onlyChange(env, 'main.tex', 'lazy dog.', 'lazy dog~\\cite{GM84}.');
  },
});

// ------------------------------------------------------------ save torture:
// random sequences of real actions (seeded, so a failure replays), with the
// invariants of saving checked after every save.
//   E2E_SEEDS=1,2,3 E2E_OPS=60 node tests/e2e.js torture

function rng(seed) {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  return { f: next, int: (n) => Math.floor(next() * n), pick: (a) => a[Math.floor(next() * a.length)] };
}

// unescaped braces balance and dollars pair up, outside comments and code
function balanced(text) {
  const t = text.replace(/\\begin\{lstlisting\}[^]*?\\end\{lstlisting\}/g, '')
    .replace(/\\\\/g, '').replace(/\\[{}$%]/g, '').replace(/%.*$/gm, '');
  let depth = 0;
  for (const c of t) { if (c === '{') depth++; if (c === '}') depth--; if (depth < 0) return 'a } closes nothing'; }
  if (depth) return `${depth} unclosed {`;
  const dollars = (t.replace(/\$\$/g, '').match(/\$/g) || []).length;
  return dollars % 2 ? 'an odd number of $' : null;
}

async function tortureRun(env, page, seed, ops) {
  const R = rng(seed);
  const trace = [];
  const external = [];      // [time, file] of every outside write
  const say = (s) => { trace.push(s); };
  const files = ['main.tex', 'sections/body.tex'];
  const words = ['alpha', 'x', 'β', '50%', 'a_b', '{c}', '~', 'R&D', '#1', '\\', 'q^2', '“quoted”', '—', 'the', ' ', '  '];
  const pastes = ['$a_1 + b$', ' and $$c$$ ', '\\(d\\)', 'plain 5$ text', 'two\nlines', '$\\alpha$ then $\\beta$', '%', ''];
  // a random caret (or selection of `len`) in a random editable text node
  const place = async (len = 0) => page.eval(`(() => {
    const nodes = [];
    for (const ed of document.querySelectorAll('#doc [contenteditable=true]')) {
      const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let t;
      while ((t = w.nextNode())) if (!t.parentElement.closest('.chip') && t.data.length) nodes.push([ed, t]);
    }
    if (!nodes.length) return false;
    const [ed, t] = nodes[Math.floor(${R.f()} * nodes.length)];
    const a = Math.floor(${R.f()} * (t.data.length + 1));
    const b = Math.min(t.data.length, a + ${len});
    ed.focus();
    const r = document.createRange(); r.setStart(t, a); r.setEnd(t, b);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    return true;
  })()`);
  const settleDialogs = async () => {
    if (!(await page.eval(`$('#external').hidden`))) {
      const b = R.pick(['#external-reload', '#external-overwrite', '#external-later', '#external-backup']);
      say('dialog ' + b);
      await page.click(b);
      await sleep(150);
      await page.waitFor('!SAVING', 8000);
    }
    for (const box of ['#drawer', '#palette', '#menu', '#figview', '#historybox']) {
      if (!(await page.eval(`$('${box}').hidden`))) await page.key('Escape');
    }
    if (await page.eval(`DIFF.on`)) await page.click('#diffbtn');
  };
  const check = async (when) => {
    await page.waitFor('!SAVING', 8000);
    const st = await page.eval(`JSON.stringify(Object.fromEntries(Object.entries(FILES).map(([n, f]) => [n, { disk: f.disk, base: f.base, pending: !!(PENDING_EXTERNAL || []).find((p) => p[0] === n), ignored: n in IGNORED_EXTERNAL }])))`);
    for (const [n, f] of Object.entries(JSON.parse(st))) {
      if (!fs.existsSync(path.join(env.paper, n))) continue;
      const disk = env.read(n);
      const bad = balanced(disk);
      if (bad) throw new Error(`${when}: ${n} on disk: ${bad}\n${disk}`);
      const sha = require('crypto').createHash('sha1').update(disk).digest('hex');
      // what the page believes is on disk is on disk (unless it knows otherwise)
      if (f.base === sha && f.disk !== disk) throw new Error(`${when}: ${n}: the page's copy of the disk is wrong`);
      if (f.base !== sha && !f.pending && !f.ignored && !external.some(([, e]) => e === n)) {
        throw new Error(`${when}: ${n} on disk is not what the page saved, and no one else wrote it`);
      }
    }
    // the history has no gap: each save starts from the text the one before wrote
    const log = historyLog(env);
    const last = {};
    for (const e of log) {
      if (last[e.name] && last[e.name].after !== e.before && !external.some(([t, n]) => n === e.name && t > last[e.name].t * 1000 - 1000)) {
        throw new Error(`${when}: history gap in ${e.name}: a save started from a text no save wrote`);
      }
      last[e.name] = e;
    }
    if (page.errors.length) throw new Error(`${when}: script errors: ${page.errors.join('\n')}`);
  };

  for (let i = 0; i < ops; i++) {
    const op = R.pick(['type', 'type', 'type', 'enter', 'backspace', 'delete', 'wrap', 'format', 'paste', 'undo', 'redo',
      'save', 'save', 'plus', 'move', 'external', 'diff', 'dollar', 'join']);
    say(`${i} ${op}`);
    try {
      if (op === 'type') { if (await place()) await page.type(R.pick(words)); }
      else if (op === 'enter') { if (await place()) await page.key('Enter'); }
      else if (op === 'backspace' || op === 'delete') { if (await place()) for (let k = R.int(3) + 1; k; k--) await page.key(op === 'delete' ? 'Delete' : 'Backspace'); }
      else if (op === 'wrap') { if (await place(R.int(8) + 1)) await page.key(R.pick(['(', ')', '[', '{', '}', '"', "'"]), { shift: true }); }
      else if (op === 'dollar') { if (await place(R.int(6) + 1)) await page.key('$', { shift: true }); }
      else if (op === 'format') { if (await place(R.int(8))) await page.key(R.pick(['b', 'i']), { ctrl: true }); }
      else if (op === 'paste') { if (await place(R.int(3))) await page.paste(R.pick(pastes)); }
      else if (op === 'undo') await page.key('z', { ctrl: true });
      else if (op === 'redo') await page.key('z', { ctrl: true, shift: true });
      else if (op === 'join') {
        await page.eval(`(() => { const ps = ORDER.filter((s) => s.kind === 'para' && s.edit && !s.edit.classList.contains('quiet'));
          const s = ps[Math.floor(${R.f()} * ps.length)]; const r = document.createRange(); r.selectNodeContents(s.edit); r.collapse(true);
          s.edit.focus(); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
        await page.key('Backspace');
      } else if (op === 'plus') {
        const n = await page.eval(`ORDER.filter((s) => s.kind === 'para' && s.el).length`);
        const k = R.int(n);
        await page.click(`js:ORDER.filter((s) => s.kind === 'para' && s.el)[${k}].el.querySelector('.tools button')`);
        await page.click(menuItem(R.pick(['Paragraph', 'Section heading', 'Displayed maths'])));
        await page.type(R.pick(['New text.', 'Heading', 'x']));
      } else if (op === 'move') {
        const n = await page.eval(`ORDER.filter((s) => s.kind === 'heading' && s.el).length`);
        if (n) await page.click(`js:ORDER.filter((s) => s.kind === 'heading' && s.el)[${R.int(n)}].el.querySelector('button[title^="${R.pick(['Move this section up', 'Move this section down'])}"]')`);
      } else if (op === 'external') {
        const n = R.pick(files);
        if (fs.existsSync(path.join(env.paper, n))) {
          env.write(n, env.read(n) + `% outside ${i}\n`);
          external.push([Date.now(), n]);
          await page.eval(`lastTyping = 0`);
          await sleep(2300);       // a poll
        }
      } else if (op === 'diff') {
        await page.click('#diffbtn');
        await sleep(200);
        if (R.f() < 0.5) await page.key('s', { ctrl: true });
        await sleep(100);
      } else if (op === 'save') {
        await page.save();
        await settleDialogs();
        await check(`after op ${i}`);
      }
      await settleDialogs();
    } catch (e) {
      e.message = `seed ${seed}, op ${i} (${op}): ${e.message}\n     trace: ${trace.slice(-12).join(' | ')}`;
      throw e;
    }
  }
  // the end: save everything (mine wins), then a fresh tab must show the same page
  await page.save();
  await settleDialogs();
  if (await page.eval(`editedFiles().length`)) { await page.save(); await settleDialogs(); }
  await check('at the end');
  await sleep(2500);
  if (!(await page.eval(`editedFiles().length`)) && (await page.eval(`$('#external').hidden`))) {
    const fresh = await env.openPage(CHROME);
    eq(await fresh.eval(`ORDER.filter((s) => s.edit && segSource(s, []) !== s.src).length`), 0, `seed ${seed}: blocks that do not read back`);
    // the text of every block (not the figure images, which a newer tab may have)
    const texts = `[...document.querySelectorAll('#doc [contenteditable=true], #doc textarea')].map((e) => (e.value !== undefined ? e.value : e.innerText).replace(/\\s+/g, ' ').trim()).join('\\n')`;
    eq(await fresh.eval(texts), await page.eval(texts), `seed ${seed}: a fresh tab shows the same page\n${files.map((n) => fs.existsSync(path.join(env.paper, n)) ? '--- ' + n + '\n' + env.read(n) : '').join('\n')}`);
  }
}

Object.assign(TESTS, {
  async 'word diff: a rewritten sentence is one change, not alternating words'(env, page) {
    const runs = (a, b) => page.eval(`JSON.stringify(wordDiffRuns(${JSON.stringify(a)}, ${JSON.stringify(b)}).map((r) => r.eq ? '=' + r.b.map((u) => u.tok.s || '').join('') : '-' + r.a.map((u) => u.tok.s || '').join('') + '+' + r.b.map((u) => u.tok.s || '').join('')))`).then(JSON.parse);
    eq(JSON.stringify(await runs('The quick brown fox jumps.', 'The quick red fox jumps.')), JSON.stringify(['=The quick ', '-brown+red', '= fox jumps.']), 'one word');
    const r = await runs('Theorem 10 is the separation at one length and two steps relate it to the definition.',
      'The reduction accesses the finder only through the adversary, which submits only tagged copies of the circuits.');
    eq(r.filter((x) => x[0] === '-').length, 1, `a rewritten sentence is a single change: ${JSON.stringify(r)}`);
    eq(await page.eval(`diffSimilarity('the quick brown fox jumps over the dog', 'the quick red fox jumps over the dog') > 0.8`), true, 'a small edit is alike');
    eq(await page.eval(`diffSimilarity('Theorem 10 is the separation at one length', 'The reduction accesses the finder only through it') < 0.5`), true, 'a rewrite is not alike');
  },

  async 'peek: hovering the change bar of an edited block shows the change, and Revert takes it back'(env, page) {
    await page.select('brown'); await page.type('red'); await sleep(600);
    const at = await page.eval(`(() => { const s = ORDER.find((x) => x.el && x.el.classList.contains('edited')); const b = s.el.getBoundingClientRect(); return { x: b.left - 7, y: b.top + 8 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await sleep(300);
    eq(await page.eval(`!!document.getElementById('peek') && !$('#peek').hidden`), false, 'not open after a short pass');
    await page.waitFor(`document.getElementById('peek') && !$('#peek').hidden`, 3000, 'the peek after resting');
    eq(await page.eval(`[...$('#peek').querySelectorAll('.d-del')].map((e) => e.textContent).join()`), 'brown', 'deleted word');
    eq(await page.eval(`[...$('#peek').querySelectorAll('.d-ins')].map((e) => e.textContent).join()`), 'red', 'inserted word');
    await page.click('js:$("#peek button")');
    await sleep(200);
    eq(await dirty(page), 0, 'nothing edited after revert');
    await page.key('z', { ctrl: true }); await sleep(200);
    eq(await dirty(page), 1, 'undo brings the edit back');
  },
  async 'find: replace one and replace all say what they did, and undo'(env, page) {
    await page.key('h', { ctrl: true }); await sleep(150);
    await page.type('paper');
    await page.eval(`$('#find-r').focus()`); await page.type('essay');
    await page.click('#find-one'); await sleep(200);
    has(await page.eval(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|')`), 'Replaced 1', 'toast after one');
    await page.click('#find-all'); await sleep(200);
    has(await page.eval(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|')`), 'Replaced', 'toast after all');
    await page.save();
    hasNot(env.read('main.tex'), 'paper', 'every match replaced');
    has(env.read('main.tex'), 'Final words of the essay.', 'replacement written');
  },
});

Object.assign(TESTS, {
  async 'game editor: underlined title, paper numbering, its formula editor keeps Ctrl+Z, Apply previews the game'(env, page) {
    await page.click("js:ORDER.find((s) => s.kind === 'figure').el.querySelector('div.small, img')", { count: 2 });
    await page.waitFor(visible('#figview'));
    const src = ['\\begin{figure}', '\\begin{algorithmic}[1]', '\\Statex \\underline{$G_0$}', '\\State $x \\gets 1$',
      '\\If{$x = 0$}', '  \\State \\Return $1$', '\\EndIf', '\\end{algorithmic}', '\\caption{A caption here.}\\label{fig:one}', '\\end{figure}'].join('\n');
    await page.eval('(() => { const src = ' + JSON.stringify(src) + '; FV.src = src; FV.orig = src; FV.games = parseGames(src); FV.tables = L.parseTabulars(src); showFigTab("games"); })()');
    eq(await page.eval(`!!document.querySelector('#fv-body .gline .chip.uline .chip.math')`), true, 'the title is underlined maths, not raw LaTeX');
    eq(await page.eval(`[...document.querySelectorAll('#fv-body .gline .gno')].map((n) => n.textContent).join(',')`), ',1,2,3,4', 'numbered as in the paper');
    // a formula of a game line: typing then Ctrl+Z undoes in the formula, the drawer stays
    await page.click(`js:document.querySelectorAll('#fv-body .gline')[1].querySelector('.gtext .chip')`);
    await page.waitFor(visible('#drawer'));
    await page.type('+y'); await sleep(50);
    await page.key('z', { ctrl: true }); await sleep(100);
    eq(await page.eval(`$('#drawer').hidden`), false, 'the formula editor stays open');
    eq(await page.eval(`FV.undo.length`), 0, 'the game draft was not undone');
    await page.key('Escape'); await page.waitFor(`$('#drawer').hidden`);
    // add a line, undo: the line goes, a toast says so; redo brings it back
    await page.click(`js:document.querySelectorAll('#fv-body .gline')[1].querySelector('.gtext')`);
    await page.click(`js:document.querySelectorAll('#fv-body .gline')[1].querySelector('.gtools button')`);
    const n = await page.eval(`document.querySelectorAll('#fv-body .gline').length`);
    await page.click('#fv-undo'); await sleep(50);
    eq(await page.eval(`document.querySelectorAll('#fv-body .gline').length`), n - 1, 'undo');
    await page.click('#fv-redo'); await sleep(50);
    eq(await page.eval(`document.querySelectorAll('#fv-body .gline').length`), n, 'redo');
    has(await page.eval(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|')`), 'Redone', 'said');
    await page.click('#fv-apply');
    await page.waitFor(`$('#figview').hidden`);
    const fig = `ORDER.find((s) => s.kind === 'figure').el`;
    eq(await page.eval(`!!${fig}.querySelector('.game-preview')`), true, 'the paper previews the edited game');
    eq(await page.eval(`${fig}.querySelectorAll('.game-preview .gp-line').length`), n, 'every line but the blank ones');
  },

  async 'table cells: Ctrl+Z keeps the cursor in the cell'(env, page) {
    await page.click("js:ORDER.find((s) => s.kind === 'figure').el.querySelector('div.small, img')", { count: 2 });
    await page.waitFor(visible('#figview'));
    const src = ['\\begin{table}', '\\begin{tabular}{lc}', 'Setting & Bound \\\\', 'Both & maybe \\\\', '\\end{tabular}', '\\end{table}'].join('\n');
    await page.eval('(() => { const src = ' + JSON.stringify(src) + '; FV.src = src; FV.orig = src; FV.games = []; FV.tables = L.parseTabulars(src); showFigTab("cells"); })()');
    await page.click(`js:document.querySelectorAll('#fv-body td[contenteditable=true]')[3]`);
    await page.type('X'); await sleep(50);
    await page.key('z', { ctrl: true }); await sleep(50);
    eq(await page.eval(`document.querySelectorAll('#fv-body td[contenteditable=true]')[3].textContent`), 'maybe', 'undone');
    eq(await page.eval(`document.activeElement === document.querySelectorAll('#fv-body td[contenteditable=true]')[3]`), true, 'the cursor stays in the cell');
  },

  async 'displayed equation: the cursor is on the empty line, the preview keeps its height'(env, page) {
    await page.select('lazy dog', 'end');
    await page.key('m', { ctrl: true, shift: true });
    await page.waitFor(visible('#drawer'));
    await page.type('\\frac{a}{b}'); await sleep(50);
    eq(await page.eval(`$('#drawer-src').value`), '\\[\n  \\frac{a}{b}\n\\]', 'typed on the middle line');
    const h = await page.eval(`$('#drawer-preview').getBoundingClientRect().height`);
    await page.key('Backspace'); await page.key('Backspace'); await page.key('Backspace'); await sleep(50);
    eq(await page.eval(`$('#drawer-preview').getBoundingClientRect().height`), h, 'the preview does not shrink');
    await page.key('Escape');
  },

  async 'Ctrl+click a reference goes to its label, Alt+Left comes back'(env, page) {
    env.write('main.tex', MAIN.replace('Final words of the paper.', 'Final words, see \\cref{sec:body}.'));
    await page.send('Page.reload');
    await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0 && document.querySelector('#doc .chip.ref')`, 15000, 'reload');
    await page.eval(`scrollTo(0, document.body.scrollHeight)`);
    await page.click(`js:document.querySelector('#doc .chip.ref')`, { ctrl: true });
    await sleep(100);
    eq(await page.eval(`$('#drawer').hidden`), true, 'no editor opened');
    const body = await page.eval(`(() => { const r = ORDER.find((s) => s.src.includes('\\\\label{sec:body}')).el.getBoundingClientRect(); return r.top > 0 && r.top < innerHeight; })()`);
    eq(body, true, 'the labelled heading is on screen');
    const mid = await page.eval(`scrollY`);
    const before2 = await page.eval(`NAV.back[0].y`);   // (the click scrolls the reference into view first)
    await page.key('ArrowLeft', { alt: true }); await sleep(800);
    const now = await page.eval(`scrollY`);
    eq(Math.abs(now - before2) < 5, true, `back where it was (${before2} -> ${mid} -> ${now})`);
  },

  async 'saving far down the page keeps the place'(env, page) {
    await page.eval(`document.documentElement.style.setProperty('--doc-size', '30px')`);
    const seg = `ORDER.find((s) => s.src.includes('Final words'))`;
    await page.eval(`${seg}.el.scrollIntoView({ block: 'start' }); scrollBy(0, -200)`);
    await page.select('Final words', 'end'); await page.type(' more');
    const top = await page.eval(`${seg}.el.getBoundingClientRect().top`);
    await page.save(); await sleep(2500);       // the build and the reload after it
    const after = await page.eval(`${seg}.el.getBoundingClientRect().top`);
    eq(Math.abs(after - top) < 4, true, `the block stays put (${top} -> ${after})`);
  },

  async 'text size changes the paper, not the toolbar'(env, page) {
    const ui = await page.eval(`getComputedStyle($('#save')).fontSize`);
    const p = `getComputedStyle(ORDER.find((s) => s.kind === 'para').edit).fontSize`;
    const t0 = await page.eval(p);
    await page.click('#textbigger'); await page.click('#textbigger');
    eq(await page.eval(`getComputedStyle($('#save')).fontSize`), ui, 'toolbar unchanged');
    eq(parseFloat(await page.eval(p)) > parseFloat(t0), true, 'paper text larger');
    await page.click('#textsize');
    eq(await page.eval(p), t0, 'reset');
  },

  async 'text size, width, columns and diff base are kept per paper'(env, page) {
    await page.click('#textbigger'); await page.click('#textbigger');
    await page.eval(`(() => { const w = $('#docwidth'); w.value = 70; w.dispatchEvent(new Event('input')); })()`);
    await page.click('#cols');
    await page.eval(`(() => { const s = $('#diffbase'); s.value = 'head'; s.dispatchEvent(new Event('change')); })()`);
    const kept = JSON.parse(await page.eval(`localStorage.getItem('view:' + DOC.path)`));
    eq(JSON.stringify(kept), JSON.stringify({ docsize: 18, docwidth: 70, cols: '2', diff: 'head' }), 'kept under the paper');
    await page.eval(`window.beforeReload = 1`);
    await page.send('Page.reload', {});
    await page.waitFor(`!window.beforeReload && typeof DOC !== 'undefined' && DOC && ORDER.length > 0`);
    eq(await page.eval(`$('#textsize').textContent`), '113%', 'text size back');
    eq(await page.eval(`$('#docwidth').value`), '70', 'width back');
    eq(await page.eval(`document.body.classList.contains('two')`), true, 'two columns back');
    eq(await page.eval(`$('#diffbase').value`), 'head', 'diff base back');
    // a paper never opened before starts from the last choices (made in
    // another paper, here)
    await page.eval(`(() => { localStorage.setItem('docsize', '16'); localStorage.setItem('docwidth', '50'); localStorage.setItem('cols', '1'); localStorage.removeItem('view:' + DOC.path); })()`);
    await page.eval(`window.beforeReload = 1`);
    await page.send('Page.reload', {});
    await page.waitFor(`!window.beforeReload && typeof DOC !== 'undefined' && DOC && ORDER.length > 0`);
    eq(await page.eval(`$('#textsize').textContent`), '100%', 'start text size');
    eq(await page.eval(`$('#docwidth').value`), '50', 'start width');
    eq(await page.eval(`document.body.classList.contains('two')`), false, 'start columns');
  },
});

const SEEDS = (process.env.E2E_SEEDS || '1,2,3,4').split(',').map(Number);
for (const seed of SEEDS) {
  TESTS[`save torture: seed ${seed}`] = async (env, page) => { await tortureRun(env, page, seed, Number(process.env.E2E_OPS || 40)); };
}

// ------------------------------------------------------------ runner

// ------------------------------------------------------------ rendering:
// block tools from the margin, formulas KaTeX writes oddly, listings in colour

Object.assign(TESTS, {
  async 'block tools: the + shows when the mouse comes in from the margin'(env, page) {
    const r = await page.eval(`(() => { const s = ORDER.find((x) => x.kind === 'para' && x.src.includes('lazy dog'));
      s.el.scrollIntoView({ block: 'center' }); const b = s.el.getBoundingClientRect(); return { l: b.left, t: b.top }; })()`);
    const shown = () => page.eval(`getComputedStyle(ORDER.find((x) => x.kind === 'para' && x.src.includes('lazy dog')).el.querySelector(':scope > .tools')).opacity`);
    const move = (x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await move(r.l - 300, r.t + 8); await sleep(80);
    eq(await shown(), '0', 'tools far from the block');
    for (let x = r.l - 300; x <= r.l - 12; x += 6) await move(x, r.t + 8);
    await sleep(80);
    eq(await shown(), '1', 'tools with the mouse in the margin beside the block');
    await move(r.l + 40, r.t + 8); await sleep(80);
    eq(await shown(), '1', 'tools with the mouse over the text');
  },

  async 'a braced multline with \\sample in a \\substack renders'(env, page) {
    // cryptocode-like \sample, as papers define it: KaTeX nests an <mo> in an <mo> for it
    env.write('main.tex', MAIN.replace('\\begin{document}', '\\newcommand{\\sample}{\\mathrel{\\leftarrow\\!\\!\\mathrel{\\$}}}\n\\begin{document}'));
    env.write('sections/body.tex', BODY.replace('Detail text lives here.', String.raw`Detail text lives here, if
{\setlength{\multlinegap}{0pt}%
\begin{multline}\label{eq:bb}
  \Pr\left[x\middle|\,\substack{\sigma\leftarrow\mathsf{Gen}\\x\sample\Adv(\sigma)}\right]\ge\tfrac12\\
  \implies y
\end{multline}}
for every adversary.`));
    await page.waitFor(`document.querySelector('#doc').innerText.includes('for every adversary')`, 8000, 'the page to reload');
    const got = await page.eval(`(() => { const s = ORDER.find((x) => x.src.includes('multlinegap'));
      const m = s.el.querySelector('.chip.math.display'), h = m && m.querySelector('.katex-html');
      return { html: !!h, inMathml: !!(h && h.closest('.katex-mathml')), height: m ? m.getBoundingClientRect().height : 0,
        raw: [...s.el.querySelectorAll('.chip.src')].map((c) => c.dataset.src) }; })()`);
    eq(got.html && !got.inMathml, true, 'the visible formula outside the MathML');
    eq(got.height > 30, true, 'the formula has its two lines (' + got.height + 'px)');
    eq(got.raw.length, 0, 'no raw LaTeX shown (\\setlength prints nothing)');
    eq(await dirty(page), 0, 'edited files');
  },

  async 'a listing written in the paper is coloured with the paper\'s language'(env, page) {
    env.write('main.tex', MAIN.replace('\\begin{document}', String.raw`\usepackage{listings}
\lstdefinelanguage{easycrypt}{morekeywords={proc,var,lemma},morecomment=[n]{(*}{*)}}
\lstset{language=easycrypt}
\begin{document}`).replace('code line', 'lemma foo (* why *) : proc var.'));
    await page.waitFor(`document.querySelector('.seg.code .code-hl .lst-kw')`, 8000, 'a highlighted listing');
    const got = await page.eval(`(() => { const hl = document.querySelector('.seg.code .code-hl');
      return { kw: [...hl.querySelectorAll('.lst-kw')].map((k) => k.textContent), comment: (hl.querySelector('.lst-comment') || {}).textContent }; })()`);
    eq(got.kw.join(','), 'lemma,proc,var', 'keywords');
    eq(got.comment, '(* why *)', 'comment');
    // typing in the code repaints the colours, and saves as typed
    await page.eval(`(() => { const ta = document.querySelector('.seg.code textarea'); ta.focus(); ta.setSelectionRange(ta.value.indexOf('foo'), ta.value.indexOf('foo')); })()`);
    await page.type('var ');
    await page.waitFor(`document.querySelectorAll('.seg.code .code-hl .lst-kw').length === 4`, 4000, 'the new keyword coloured');
    await page.save();
    has(env.read('main.tex'), 'lemma var foo (* why *) : proc var.', 'the edit on disk');
  },
});

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) { console.log('SKIP: no Chrome/Chromium (set CHROME=...)'); process.exit(0); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-chrome-'));
  const dport = await freePort();
  const proc = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  const chrome = CHROME;
  try {
    const ver = await (await waitHttp(`http://127.0.0.1:${dport}/json/version`)).json();
    chrome.cdp = await CDP.connect(ver.webSocketDebuggerUrl);
    if (process.env.E2E_PROBE) TESTS['probe'] = require(path.resolve(process.env.E2E_PROBE));
    const filters = process.env.E2E_PROBE ? ['probe'] : process.argv.slice(2);
    const names = Object.keys(TESTS).filter((n) => !filters.length || filters.some((f) => n.includes(f)));
    let failed = 0;
    for (const name of names) {
      const env = new Env();
      const t0 = Date.now();
      try {
        const page = await env.start(chrome);
        await TESTS[name](env, page);
        if (page.errors.length) throw new Error('script errors: ' + page.errors.join('\n'));
        console.log(`ok   ${name} (${Date.now() - t0} ms)`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${name}\n     ${String(e.message).replace(/\n/g, '\n     ')}`);
        if (process.env.E2E_LOG) console.log(env.log);
      } finally {
        await env.stop(chrome);
      }
    }
    console.log(`${names.length - failed}/${names.length} passed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    proc.kill();
    if (chrome.cdp) chrome.cdp.ws.close();
    await sleep(200);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
module.exports = { TESTS, main, CDP, Page, Env, findChrome, freePort, waitHttp, sleep, eq, has };
