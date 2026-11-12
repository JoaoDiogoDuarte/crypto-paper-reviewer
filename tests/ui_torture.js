#!/usr/bin/env node
// Bug bounty: the editor driven as a person would, on real papers, checking
// what is on the screen rather than what the code believes.
//
//   node tests/ui_torture.js                      # the e2e paper and every fixture
//   node tests/ui_torture.js --real               # also tests/real/* and tests/papers.local
//   node tests/ui_torture.js path/to/paper ...    # these papers only
//   UI_QUICK=1 ...                                # fewer sizes and samples
//
// Nothing is written to a paper: every write request (save, convert, bib,
// metadata, keys, history) is refused at the browser and counted as a bug.
// A paper's .aux/.pdf may be rebuilt as the editor does on load.
//
// What is checked, at several window sizes, zoom factors, both themes and
// one/two columns:
//   - no script error, console error or failed request;
//   - every block reads back to its exact source;
//   - the bars stay one block: no pixel of the page shows between or behind
//     them while scrolling (screenshots), nothing at their height that is not
//     theirs (hit test), no horizontal scrolling, not taller than a third of
//     the window;
//   - every control is inside the window, overlaps no other, has text with a
//     contrast of at least 4.5:1, and a pressed or selected one is filled;
//   - every button answers a click visibly (a toast, a window, a state);
//   - text, headings and captions take a click where they are drawn and the
//     typed text lands in their source, in the right file, and undo restores it;
//   - the figure window: opens on a double click, the page behind it does not
//     scroll, every tab draws, game lines and formulas and table cells edit,
//     Apply writes only that figure;
//   - the reader starts at the caret and its phrase is always visible, below
//     the bars; find shows its match below the bars;
//   - every window opens inside the screen, its buttons take clicks, and it
//     closes with Escape.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const E = require('./e2e.js');
const { CDP, Page, Env, findChrome, freePort, waitHttp, sleep } = E;

const ROOT = path.dirname(__dirname);
const PY = fs.existsSync(path.join(ROOT, '.venv/bin/python')) ? path.join(ROOT, '.venv/bin/python') : 'python3';
const QUICK = !!process.env.UI_QUICK;
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-ui-shots-'));

// ------------------------------------------------------------ papers

function isMain(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return /^[^%\n]*\\documentclass/m.test(t) && t.includes('\\begin{document}');
  } catch (e) { return false; }
}
function findMain(p) {
  if (fs.statSync(p).isFile()) return p.endsWith('.tex') && isMain(p) ? p : null;
  const cands = [];
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'converted' || e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(f, depth + 1);
      else if (e.isFile() && e.name.endsWith('.tex') && isMain(f)) cands.push(f);
    }
  };
  walk(p, 0);
  const score = (f) => (/(^|\/)(main|paper)\.tex$/.test(f) ? 0 : 1) * 10 + f.split('/').length;
  cands.sort((a, b) => score(a) - score(b));
  return cands[0] || null;
}
function papers() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (args.length) return args.map((a) => ({ name: path.basename(a), main: findMain(path.resolve(a)) }));
  const out = [{ name: 'e2e-paper', e2e: true }];
  const fix = path.join(__dirname, 'fixtures');
  for (const d of fs.readdirSync(fix).sort()) {
    const m = findMain(path.join(fix, d));
    if (m) out.push({ name: 'fixture/' + d, main: m, copy: true });
  }
  if (process.argv.includes('--real')) {
    const real = path.join(__dirname, 'real');
    if (fs.existsSync(real)) for (const d of fs.readdirSync(real).sort()) {
      if (d.startsWith('.') || !fs.statSync(path.join(real, d)).isDirectory()) continue;
      const m = findMain(path.join(real, d));
      if (m) out.push({ name: 'real/' + d, main: m });
    }
    const local = path.join(__dirname, 'papers.local');
    if (fs.existsSync(local)) for (const line of fs.readFileSync(local, 'utf8').split('\n')) {
      const p = line.trim();
      if (!p || p.startsWith('#') || !fs.existsSync(p)) continue;
      const m = findMain(p);
      if (m) out.push({ name: 'local/' + path.basename(path.dirname(m)) + '/' + path.basename(m), main: m });
    }
  }
  return out.filter((p) => p.e2e || p.main);
}

// ------------------------------------------------------------ a session on one paper

class Session {
  constructor(chrome, paper) { this.chrome = chrome; this.paper = paper; this.bugs = []; this.notes = []; }
  bug(where, what) { this.bugs.push(`${where}: ${what}`); }
  async start() {
    if (this.paper.e2e) {
      this.env = new Env();
      this.page = await this.env.start(this.chrome);
    } else {
      this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-ui-'));
      let main = this.paper.main;
      if (this.paper.copy) {
        const src = path.dirname(main);
        const dst = path.join(this.tmp, 'paper');
        fs.cpSync(src, dst, { recursive: true });
        main = path.join(dst, path.basename(main));
      }
      this.port = await freePort();
      this.log = '';
      this.srv = spawn(PY, [path.join(ROOT, 'server.py'), main, '--port', String(this.port), '--no-open',
        '--state', path.join(this.tmp, 'state')], { stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: this.tmp, XDG_CONFIG_HOME: path.join(this.tmp, 'config') } });
      this.srv.stdout.on('data', (d) => { this.log += d; });
      this.srv.stderr.on('data', (d) => { this.log += d; });
      await waitHttp(`http://127.0.0.1:${this.port}/api/state`, 300);
      const t = await this.chrome.cdp.send('Target.createTarget', { url: 'about:blank' });
      this.target = t.targetId;
      const { sessionId } = await this.chrome.cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      this.page = new Page(this.chrome.cdp, sessionId);
      await this.page.send('Page.enable');
      await this.page.send('Runtime.enable');
    }
    const page = this.page;
    // writes are refused and counted; failed loads are counted
    this.writes = [];
    page.held = [];   // e2e's own handler keeps paused requests here; ours refuses them
    this.failed = [];
    page.cdp.on((m) => {
      if (m.sessionId !== page.sid) return;
      if (m.method === 'Fetch.requestPaused' && m.params.request.method === 'GET') {
        page.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
      } else if (m.method === 'Fetch.requestPaused') {
        this.writes.push(m.params.request.method + ' ' + m.params.request.url.replace(/^https?:\/\/[^/]+/, ''));
        page.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
      if (m.method === 'Network.loadingFailed' && !/BLOCKED_BY_CLIENT|BlockedByClient|net::ERR_ABORTED/.test(m.params.errorText) && !m.params.canceled)
        this.failed.push(m.params.errorText + ' ' + (this.urls.get(m.params.requestId) || ''));
      if (m.method === 'Network.requestWillBeSent') this.urls.set(m.params.requestId, m.params.request.url);
      if (m.method === 'Network.responseReceived' && m.params.response.status >= 400 && !/\/pdf$|\/figtext\//.test(m.params.response.url))
        this.failed.push(m.params.response.status + ' ' + m.params.response.url);
    });
    this.urls = new Map();
    await page.send('Network.enable');
    await page.send('Fetch.enable', { patterns: ['save', 'convert', 'bibadd', 'metadata', 'keys', 'history/delete', 'history/restore', 'open']
      .map((p) => ({ urlPattern: `*/api/${p}*`, requestStage: 'Request' })) });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_SPEECH });
    await page.send('Page.bringToFront');
    if (!this.paper.e2e) {
      await page.send('Page.navigate', { url: `http://127.0.0.1:${this.port}/` });
      await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0 && typeof AUXVER !== 'undefined'`, 60000, 'the page to load');
    } else {
      // the e2e session navigated before we listened: load it again
      await page.send('Page.reload');
      await sleep(300);
      await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0`, 30000, 'the page to reload');
    }
    await sleep(800);
    await page.eval(`(() => { TTS.fillVoices && TTS.fillVoices(); const o = [...$('#voice').options].find((x) => /Fake/.test(x.value)); if (o) $('#voice').value = o.value; })()`).catch(() => {});
    await page.eval(`window.__toasts = 0; new MutationObserver((ms) => { for (const m of ms) window.__toasts += m.addedNodes.length; }).observe($('#toasts'), { childList: true }); 0`);
  }
  async stop() {
    if (this.env) { await this.env.stop(this.chrome); return; }
    if (this.target) await this.chrome.cdp.send('Target.closeTarget', { targetId: this.target }).catch(() => {});
    if (this.srv) { this.srv.kill(); await new Promise((r) => (this.srv.exitCode !== null ? r() : this.srv.once('exit', r))); }
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
  async size(w, h, dpr = 1) {
    await this.page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
    await sleep(250);
  }
  async settle() {
    await this.page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))`);
  }
  async mouse(type, x, y, extra = {}) {
    await this.page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  }
  async clickAt(x, y, count = 1) {
    await this.mouse('mouseMoved', x, y);
    for (let c = 1; c <= count; c++) {
      await this.mouse('mousePressed', x, y, { clickCount: c });
      await this.mouse('mouseReleased', x, y, { clickCount: c });
    }
  }
}

// ------------------------------------------------------------ in-page helpers

// Installed once per page: colour parsing, contrast, visibility.
const HELPERS = String.raw`(() => {
  if (window.__ui) return;
  const parse = (c) => {
    let m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) { const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; }
    m = /color\(srgb ([^)]+)\)/.exec(c);
    if (m) { const v = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [v[0] * 255, v[1] * 255, v[2] * 255, v.length > 3 ? v[3] : 1]; }
    return [0, 0, 0, 0];
  };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const bgOf = (e) => {
    const layers = [];
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let base = parse(getComputedStyle(document.body).backgroundColor);
    if (base[3] < 1) base = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const contrast = (e) => { const bg = bgOf(e); const fg = over(parse(getComputedStyle(e).color), bg); return { r: ratio(fg, bg), bg: bg.map(Math.round), fg: fg.map(Math.round) }; };
  const shown = (e) => { if (!e || !e.isConnected) return false; const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const label = (e) => (e.id ? '#' + e.id : '') + (e.dataset && e.dataset.act ? '[' + e.dataset.act + ']' : '') + ' "' + (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 24) + '"';
  window.__ui = { parse, bgOf, contrast, shown, label, lum };
})()`;

// ------------------------------------------------------------ checks

async function checkLoad(S) {
  const p = S.page;
  const bad = await p.eval(`ORDER.filter((s) => s.edit && !s.removed && segSource(s, []) !== s.src).map((s) => s.file + ': ' + s.src.slice(0, 60))`);
  for (const b of bad.slice(0, 5)) S.bug('load', 'block does not read back: ' + JSON.stringify(b));
  const counts = await p.eval(`(() => {
    const raw = {}; for (const c of document.querySelectorAll('#doc .chip.src')) { const k = (c.dataset.src.match(/^\\\\[A-Za-z@]+\\*?/) || [c.dataset.src.slice(0, 12)])[0]; raw[k] = (raw[k] || 0) + 1; }
    return { bad: [...document.querySelectorAll('#doc .chip.bad')].slice(0, 8).map((c) => c.dataset.src.slice(0, 50)), raw: Object.entries(raw).sort((a, b) => b[1] - a[1]).slice(0, 10), blocks: ORDER.length };
  })()`);
  if (counts.bad.length) S.notes.push('formulas KaTeX cannot draw: ' + counts.bad.join(' | '));
  if (counts.raw.length) S.notes.push('LaTeX shown raw (most frequent): ' + counts.raw.map(([k, n]) => `${k}×${n}`).join(', '));
  S.notes.push(`${counts.blocks} blocks`);
}

async function chromeShot(S, w) {
  const y = await S.page.eval('scrollY');
  const h = Math.floor(await S.page.eval(`$("#chrome").getBoundingClientRect().bottom`)) + 1;   // the shared pixel row, covered by the band below
  const shot = await S.page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y, width: w, height: Math.max(1, h), scale: 1 } });
  return shot.data;
}

async function checkLayout(S, w, h, dpr, theme, two, find) {
  const p = S.page;
  const where = `layout ${w}x${h}@${dpr} ${theme} ${two ? 'two' : 'one'} column${find ? ' +find' : ''}`;
  await S.size(w, h, dpr);
  await p.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    if (document.body.classList.contains('two') !== ${two}) $('#cols').click();
    if (${find}) openFind(true); else if (!$('#findbar').hidden) closeFind();
    document.activeElement && document.activeElement.blur(); 0`);
  await S.mouse('mouseMoved', w - 2, h - 2);
  await sleep(150);
  await p.eval(HELPERS);
  const g = await p.eval(`(() => {
    const de = document.documentElement, ch = $('#chrome').getBoundingClientRect();
    const out = { over: de.scrollWidth - de.clientWidth, chromeH: ch.height, issues: [], wide: [] };
    if (out.over > 0) for (const e of document.querySelectorAll('body *')) {
      const r = e.getBoundingClientRect();
      if (r.width && r.right > de.clientWidth + 0.5 && !e.closest('.katex-mathml') && getComputedStyle(e).position !== 'fixed' && out.wide.length < 4)
        out.wide.push((e.id || e.className || e.tagName).toString().slice(0, 30) + '→' + Math.round(r.right));
    }
    // controls: inside the window, no overlap, readable
    const ctrls = [...document.querySelectorAll('#chrome button, #chrome select, #chrome input')].filter(__ui.shown);
    const rects = ctrls.map((e) => e.getBoundingClientRect());
    ctrls.forEach((e, i) => {
      const r = rects[i];
      if (r.left < -0.5 || r.right > de.clientWidth + 0.5) out.issues.push('outside the window: ' + __ui.label(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
      for (let j = i + 1; j < ctrls.length; j++) {
        const q = rects[j];
        const ox = Math.min(r.right, q.right) - Math.max(r.left, q.left), oy = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
        if (ox > 1.5 && oy > 1.5 && !e.contains(ctrls[j]) && !ctrls[j].contains(e)) out.issues.push('overlap: ' + __ui.label(e) + ' and ' + __ui.label(ctrls[j]));
      }
      if (!e.disabled && e.tagName !== 'INPUT') {
        const c = __ui.contrast(e);
        if (c.r < 4.5) out.issues.push('contrast ' + c.r.toFixed(2) + ': ' + __ui.label(e) + ' rgb(' + c.fg.slice(0, 3) + ') on rgb(' + c.bg.slice(0, 3) + ')');
      }
      if (e.tagName === 'BUTTON' && e.scrollWidth > e.clientWidth + 2) out.issues.push('text cut off: ' + __ui.label(e));
    });
    // muted text in the bars
    for (const id of ['#tts-state', '#build', '#where', '#dirty', '#find-count']) {
      const e = document.querySelector(id);
      if (e && __ui.shown(e) && e.textContent.trim()) { const c = __ui.contrast(e); if (c.r < 4.5) out.issues.push('contrast ' + c.r.toFixed(2) + ': ' + id); }
    }
    return out;
  })()`);
  if (g.over > 0) S.bug(where, `the page scrolls sideways by ${g.over}px (${g.wide.join(', ')})`);
  if (g.chromeH > h / 3 && w >= 700) S.bug(where, `the bars take ${Math.round(g.chromeH)}px of a ${h}px window`);
  for (const i of [...new Set(g.issues)].slice(0, 8)) S.bug(where, i);
  // nothing at the bars' height that is not theirs, at any scroll position
  const docH = await p.eval('document.documentElement.scrollHeight');
  const ys = [Math.floor(docH * 0.3 / 4) * 4, Math.floor(docH * 0.55 / 4) * 4].filter((y) => y > h);
  for (const y of ys) {
    await p.eval(`window.scrollTo(0, ${y})`); await S.settle();
    const leak = await p.eval(`(() => {
      const ch = $('#chrome'), b = ch.getBoundingClientRect().bottom, W = document.documentElement.clientWidth;
      for (let y = 0; y < b - 0.5; y += 1) for (const f of [0.02, 0.25, 0.5, 0.75, 0.97]) {
        const e = document.elementFromPoint(W * f, y);
        if (e && !ch.contains(e) && !e.closest('#toasts')) return Math.round(W * f) + ',' + y + ' ' + (e.id || e.className || e.tagName);
      }
      return null;
    })()`);
    if (leak) { S.bug(where, 'the page shows through the bars at ' + leak); break; }
  }
  // pixels: the bars look the same whatever is scrolled under them
  if (ys.length === 2) {
    await p.eval(`window.scrollTo(0, ${ys[0]})`); await S.settle(); await sleep(80);
    const a = await chromeShot(S, w);
    await p.eval(`window.scrollTo(0, ${ys[1]})`); await S.settle(); await sleep(80);
    const b = await chromeShot(S, w);
    await p.eval(`window.scrollTo(0, ${ys[0]})`); await S.settle(); await sleep(80);
    const c = await chromeShot(S, w);
    if (a === c && a !== b) {
      const base = path.join(SHOTS, `${S.paper.name.replace(/\W+/g, '_')}-${w}-${dpr}-${theme}-${two}`);
      fs.writeFileSync(base + '-a.png', Buffer.from(a, 'base64'));
      fs.writeFileSync(base + '-b.png', Buffer.from(b, 'base64'));
      S.bug(where, `the bars change with what is scrolled under them (bleed): ${base}-{a,b}.png`);
    }
  }
}

async function checkPressed(S) {
  const p = S.page;
  await p.eval(HELPERS);
  // states, not transitions between them (slow on a long paper)
  await p.eval(`(() => { const st = document.createElement('style'); st.id = '__still'; st.textContent = '* { transition: none !important; animation: none !important; }'; document.head.append(st); })()`);
  for (const theme of ['light', 'dark']) {
    await p.eval(`document.documentElement.dataset.theme = '${theme}'; 0`);
    for (const [sel, cls] of [['#cols', 'two'], ['#diffbtn', 'diffing']]) {
      const was = await p.eval(`document.body.classList.contains('${cls}')`);
      await p.eval(`document.body.classList.add('${cls}'); $('${sel}').setAttribute('aria-pressed', 'true'); 0`);
      await sleep(300);
      const on = await p.eval(`__ui.contrast($('${sel}'))`);
      if (process.env.UI_DEBUG) console.log(await p.eval(`JSON.stringify([getComputedStyle($('${sel}')).backgroundColor, getComputedStyle($('${sel}')).color, document.body.className, $('${sel}').getAttribute('aria-pressed'), document.documentElement.dataset.theme, getComputedStyle(document.body).color])`));
      await p.eval(`document.body.classList.remove('${cls}'); $('${sel}').setAttribute('aria-pressed', 'false'); 0`);
      await sleep(300);
      const off = await p.eval(`__ui.contrast($('${sel}'))`);
      await p.eval(`document.body.classList.toggle('${cls}', ${was}); $('${sel}').setAttribute('aria-pressed', '${was}'); 0`);
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      if (on.r < 4.5) S.bug('pressed state ' + theme, `pressed ${sel} contrast ${on.r.toFixed(2)} (rgb(${on.fg.slice(0, 3)}) on rgb(${on.bg.slice(0, 3)}))`);
      if (Math.abs(lum(on.bg) - lum(off.bg)) < 0.08) S.bug('pressed state ' + theme, `pressed ${sel} looks like unpressed (on rgb(${on.bg.slice(0, 3)}), off rgb(${off.bg.slice(0, 3)}))`);
    }
  }
  await p.eval(`document.getElementById('__still').remove()`);
}

// every button in the bars does something you can see
async function checkFeedback(S) {
  const p = S.page;
  await S.size(1440, 900);
  const ids = await p.eval(`[...document.querySelectorAll('#chrome button')].filter((b) => !b.disabled && b.offsetParent && !['pdfbtn', 'openbtn'].includes(b.id)).map((b, i) => (b.id ? '#' + b.id : '[data-act=' + b.dataset.act + ']'))`);
  for (const sel of ids) {
    // something to act on: the caret in the first paragraph
    await p.eval(`(() => { const s = ORDER.find((x) => x.kind === 'para' && x.edit && x.edit.isContentEditable); if (!s) return;
      const r = document.createRange(); r.selectNodeContents(s.edit); r.collapse(true); s.edit.focus(); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    const before = await p.eval(`JSON.stringify({ t: __toasts, d: [...document.querySelectorAll('[role=dialog], #palette, #findbar, #figview, #helpbox, #drawer, #menu, .popover')].map((e) => e.hidden), a: [...document.querySelectorAll('#chrome [aria-pressed]')].map((e) => e.getAttribute('aria-pressed')), dis: [...document.querySelectorAll('#chrome button')].map((e) => e.disabled), y: Math.round(scrollY), s: $('#tts-state').textContent, th: document.documentElement.dataset.theme || '', two: document.body.classList.contains('two') })`);
    p.dialogAnswer = false;
    await p.click(sel).catch((e) => S.bug('feedback', `${sel} cannot be clicked: ${e.message}`));
    await sleep(500);
    const after = await p.eval(`JSON.stringify({ t: __toasts, d: [...document.querySelectorAll('[role=dialog], #palette, #findbar, #figview, #helpbox, #drawer, #menu, .popover')].map((e) => e.hidden), a: [...document.querySelectorAll('#chrome [aria-pressed]')].map((e) => e.getAttribute('aria-pressed')), dis: [...document.querySelectorAll('#chrome button')].map((e) => e.disabled), y: Math.round(scrollY), s: $('#tts-state').textContent, th: document.documentElement.dataset.theme || '', two: document.body.classList.contains('two') })`);
    if (before === after && !p.dialogs.length) S.bug('feedback', `clicking ${sel} shows nothing`);
    p.dialogs = []; p.dialogAnswer = true;
    // put things back
    await p.eval(`(() => { TTS.stop && TTS.stop(); if (DIFF.on) diffOff(); for (const id of ['paperbox', 'historybox', 'keysbox', 'helpbox', 'palette', 'drawer', 'menu', 'openbox']) { const e = document.getElementById(id); if (e && !e.hidden) { const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }); document.activeElement.dispatchEvent(esc); } }
      for (const id of ['paperbox', 'historybox', 'keysbox', 'helpbox', 'palette', 'drawer', 'menu', 'openbox']) { const e = document.getElementById(id); if (e) e.hidden = true; }
      if (typeof closePopovers === 'function') closePopovers(); if (!$('#findbar').hidden) closeFind(); if (!$('#figview').hidden) closeFigure(true); })()`);
    await sleep(80);
  }
  await p.eval(`(() => { while (UNDO && UNDO.length) undo(); })()`).catch(() => {});
}

// a click where a block is drawn reaches it, and typing lands in its source
async function checkEditing(S, two) {
  const p = S.page;
  const where = `editing (${two ? 'two' : 'one'} column)`;
  await S.size(1280, 860);
  await p.eval(`if (document.body.classList.contains('two') !== ${two}) $('#cols').click(); 0`);
  await sleep(300);
  const n = await p.eval(`ORDER.filter((s) => s.edit && s.edit.isContentEditable && /[a-z]{4}/.test(s.edit.textContent) && ['para', 'heading', 'figure', 'table', 'quote'].includes(s.kind)).length`);
  const want = Math.min(n, QUICK ? 6 : 16);
  const kinds = {};
  for (let k = 0; k < want; k++) {
    const idx = Math.floor((k + 0.5) * n / want);
    const target = await p.eval(`(() => {
      const segs = ORDER.filter((s) => s.edit && s.edit.isContentEditable && /[a-z]{4}/.test(s.edit.textContent) && ['para', 'heading', 'figure', 'table', 'quote'].includes(s.kind));
      const s = segs[${idx}]; window.__seg = s; window.__word = null;
      const w = document.createTreeWalker(s.edit, NodeFilter.SHOW_TEXT);
      let t; while ((t = w.nextNode())) { const m = /[a-z]{4,}/.exec(t.data); if (m && !t.parentElement.closest('.chip')) { window.__word = [t, m.index]; break; } }
      if (!window.__word) return null;
      t.parentElement.scrollIntoView({ block: 'center' });   // lays out blocks around it, then place the word
      const rr = document.createRange(); rr.setStart(t, window.__word[1]); rr.setEnd(t, window.__word[1] + 1);
      const b = rr.getBoundingClientRect(); window.scrollBy(0, b.top - innerHeight / 2);
      return { kind: s.kind, file: s.file, src: s.src };
    })()`);
    if (!target) continue;
    kinds[target.kind] = (kinds[target.kind] || 0) + 1;
    // as revealRange does: place the word again until the blocks around it are measured
    for (let n = 0; n < 6; n++) {
      await S.settle();
      const moved = await p.eval(`(() => { const [t, i] = __word; const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1);
        const b = r.getBoundingClientRect(); const d = b.top - innerHeight / 2; if (Math.abs(d) > 4) { window.scrollBy(0, d); return true; } return false; })()`);
      if (!moved) break;
    }
    const pt = await p.eval(`(() => { const [t, i] = __word; const r = document.createRange(); r.setStart(t, i + 1); r.setEnd(t, i + 2);
      const b = r.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, ok: !!hit && __seg.edit.contains(hit), hit: hit ? (hit.id || hit.className || hit.tagName) : null, under: y < chromeBottom() }; })()`);
    if (pt.under) { S.bug(where, `a ${target.kind} scrolled into view lies under the bars`); continue; }
    if (!pt.ok) { S.bug(where, `a click on a ${target.kind} of ${target.file} lands on ${pt.hit}: ${JSON.stringify(target.src.slice(0, 50))}`); continue; }
    await S.clickAt(pt.x, pt.y);
    await sleep(60);
    const mark = 'zq' + 'abcdefghijklmnop'[k] + 'x';
    await p.typeKeys(mark);
    await sleep(60);
    const r = await p.eval(`(() => { commit(); const now = segSource(__seg, [], null, false); return { has: now.includes(${JSON.stringify(mark)}), active: __seg.edit.contains(document.activeElement) || document.activeElement === __seg.edit, file: FILES[__seg.file].text.includes(${JSON.stringify(mark)}), elsewhere: Object.entries(FILES).filter(([n, f]) => n !== __seg.file && f.text.includes(${JSON.stringify(mark)})).map(([n]) => n) }; })()`);
    if (!r.has) S.bug(where, `typing into a ${target.kind} of ${target.file} did not reach its source (focus ${r.active ? 'in' : 'not in'} it): ${JSON.stringify(target.src.slice(0, 50))}`);
    else if (!r.file) S.bug(where, `a ${target.kind} edit is not in its file ${target.file}`);
    if (r.elsewhere.length) S.bug(where, `a ${target.kind} edit also landed in ${r.elsewhere.join(', ')}`);
    // undo, as a person would
    for (let u = 0; u < 3; u++) {
      const back = await p.eval(`(() => { commit(); return segSource(__seg, [], null, false) === __seg.src || !segSource(__seg, [], null, false).includes(${JSON.stringify(mark)}); })()`);
      if (back) break;
      await p.key('z', { ctrl: true }); await sleep(60);
    }
    const restored = await p.eval(`(() => { commit(); return !Object.values(FILES).some((f) => f.text.includes(${JSON.stringify(mark)})); })()`);
    if (!restored) { S.bug(where, `undo does not take back typing in a ${target.kind}`); await p.eval(`for (const n of Object.keys(FILES)) FILES[n].text = FILES[n].disk; render(); 0`); }
  }
  S.notes.push(`${where}: tried ${JSON.stringify(kinds)}`);
}

async function checkFigures(S) {
  const p = S.page;
  await S.size(1280, 860);
  const figs = await p.eval(`ORDER.map((s, i) => [i, s.kind]).filter(([i, k]) => (k === 'figure' || k === 'table') && ORDER[i].el)`);
  const pick = figs.filter((_, i) => i % Math.max(1, Math.ceil(figs.length / (QUICK ? 3 : 8))) === 0);
  for (const [i, kind] of pick) {
    const where = `figure window (${kind} #${i})`;
    const pt = await p.eval(`(() => { const s = ORDER[${i}]; s.el.scrollIntoView({ block: 'center' }); return null; })()`);
    await sleep(150); await S.settle();
    const box = await p.eval(`(() => { const s = ORDER[${i}]; const t = s.el.querySelector('img, .tabular-preview, .small') || s.el.firstElementChild; const r = t.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + Math.min(20, r.height / 2) }; })()`);
    await S.clickAt(box.x, box.y, 2);
    await sleep(250);
    if (await p.eval(`$('#figview').hidden`)) { S.bug(where, 'a double click on it does not open the figure window'); await p.eval(`openFigure(ORDER[${i}])`); await sleep(200); }
    await p.eval(HELPERS);
    const y0 = await p.eval('scrollY');
    await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 30, y: 400, deltaX: 0, deltaY: 600 });
    await sleep(200);
    if (await p.eval('scrollY') !== y0) S.bug(where, 'the page behind the figure window scrolls');
    const tabs = await p.eval(`[...document.querySelectorAll('.fv-tabs button')].filter((b) => !b.hidden).map((b) => b.dataset.tab)`);
    for (const tab of tabs) {
      const tb = await p.eval(`(() => { const b = document.querySelector('.fv-tabs button[data-tab=${tab}]'); const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; return { x, y, ok: b.contains(document.elementFromPoint(x, y)) }; })()`);
      if (!tb.ok) { S.bug(where, `the ${tab} tab is covered`); continue; }
      await S.clickAt(tb.x, tb.y); await sleep(150);
      const st = await p.eval(`(() => { const b = document.querySelector('.fv-tabs button.on'); const others = [...document.querySelectorAll('.fv-tabs button')].filter((x) => !x.hidden && x !== b);
        const c = __ui.contrast(b); const o = others[0] ? __ui.contrast(others[0]) : null;
        return { on: b && b.dataset.tab, r: c.r, distinct: !o || Math.abs(__ui.lum(c.bg) - __ui.lum(o.bg)) > 0.08, body: $('#fv-body').textContent.length + $('#fv-body').querySelectorAll('img, textarea, table').length }; })()`);
      if (st.on !== tab) S.bug(where, `clicking the ${tab} tab shows ${st.on}`);
      if (st.r < 4.5) S.bug(where, `the selected tab has contrast ${st.r.toFixed(2)}`);
      if (!st.distinct) S.bug(where, 'the selected tab looks like the others');
      if (!st.body) S.bug(where, `the ${tab} tab is empty`);
    }
    // edit: a game line with text, a formula, a cell
    const kindsTried = [];
    if (tabs.includes('games')) {
      await p.eval(`showFigTab('games')`); await sleep(100);
      const t = await p.eval(`(() => { for (const e of document.querySelectorAll('#fv-body .gline .gtext')) { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (/[a-z]{3}/.test(n.data) && !n.parentElement.closest('.chip')) { n.parentElement.scrollIntoView({ block: 'center' }); const r = document.createRange(); const i = n.data.search(/[a-z]{3}/); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } } } return null; })()`);
      if (t) {
        await S.mouse('mouseMoved', t.x, t.y - 30); await sleep(50);
        await S.clickAt(t.x, t.y); await sleep(60);
        await p.type('Qg'); await sleep(60);
        if (!(await p.eval(`figureWithEdits().includes('Qg')`))) S.bug(where, 'typing into a game line does nothing');
        kindsTried.push('game text');
      }
      const c = await p.eval(`(() => { const c = [...document.querySelectorAll('#fv-body .gline .gtext .chip.math')].find((e) => !e.parentElement.closest('.chip')); if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, src: c.dataset.src }; })()`);
      if (c) {
        await S.clickAt(c.x, c.y); await sleep(150);
        if (await p.eval(`$('#drawer').hidden`)) S.bug(where, 'clicking a formula in a game line does not open its editor');
        else {
          const onTop = await p.eval(`(() => { const r = $('#drawer-src').getBoundingClientRect(); return $('#drawer').contains(document.elementFromPoint(r.left + 10, r.top + 10)); })()`);
          if (!onTop) S.bug(where, 'the formula editor opens behind the figure window');
          await p.eval(`$('#drawer-src').value = $('#drawer-src').value.replace(/\\$$/, ' Qf$'); $('#drawer-src').dispatchEvent(new Event('input')); $('#drawer-apply').click()`);
          await sleep(100);
          if (!(await p.eval(`figureWithEdits().includes('Qf')`))) S.bug(where, 'a formula edited in a game line is not kept');
        }
        kindsTried.push('game formula');
      }
    }
    if (tabs.includes('cells')) {
      await p.eval(`showFigTab('cells')`); await sleep(100);
      const td = await p.eval(`(() => { const td = [...document.querySelectorAll('#fv-body table.cells td[contenteditable=true]')].find((e) => /[a-z]{2}/i.test(e.textContent)); if (!td) return null; td.scrollIntoView({ block: 'center' }); const r = td.getBoundingClientRect(); return { x: r.left + Math.min(r.width - 4, 12), y: r.top + r.height / 2 }; })()`);
      if (td) {
        await S.clickAt(td.x, td.y); await sleep(60);
        await p.type('Qc'); await sleep(60);
        if (!(await p.eval(`figureWithEdits().includes('Qc')`))) S.bug(where, 'typing into a table cell does nothing');
        kindsTried.push('cell');
      }
    }
    if (kindsTried.length) {
      const before = await p.eval(`JSON.stringify(Object.fromEntries(Object.entries(FILES).map(([n, f]) => [n, f.text.length])))`);
      await p.click('#fv-apply'); await sleep(200);
      const r = await p.eval(`(() => { commit(); const s = segSource(ORDER[${i}], [], null, false); return { open: !$('#figview').hidden, ok: ['Qg', 'Qf', 'Qc'].some((m) => s.includes(m)), files: Object.keys(FILES).filter((n) => FILES[n].text !== FILES[n].disk) }; })()`);
      if (r.open) S.bug(where, 'Apply leaves the window open');
      if (!r.ok) S.bug(where, `Apply did not write the edits (${kindsTried.join(', ')}) into the figure`);
      const file = await p.eval(`ORDER[${i}].file`);
      if (r.files.some((f) => f !== file)) S.bug(where, 'Apply changed other files: ' + r.files.join(', '));
      await p.eval(`for (const n of Object.keys(FILES)) FILES[n].text = FILES[n].disk; render(); 0`);
    } else {
      await p.key('Escape'); await sleep(150);
      if (!(await p.eval(`$('#figview').hidden`))) { S.bug(where, 'Escape does not close the figure window'); await p.eval(`closeFigure(true)`); }
    }
    if (await p.eval(`document.documentElement.classList.contains('modal-open')`)) S.bug(where, 'the page stays locked after the window closed');
    S.notes.push(`${where}: tabs ${tabs.join('/')}; edited ${kindsTried.join(', ') || 'nothing'}`);
  }
}

// a speech engine that never talks; finish() ends the phrase being spoken
const FAKE_SPEECH = `(() => {
  const fake = { spoken: [], cur: null };
  const synth = { getVoices: () => [{ name: 'Fake', lang: 'en-US' }], speak: (u) => { fake.spoken.push(u.text); fake.cur = u; },
    cancel: () => { fake.cur = null; }, pause: () => {}, resume: () => {}, onvoiceschanged: null };
  fake.finish = () => { const u = fake.cur; fake.cur = null; if (u && u.onend) u.onend({}); };
  window.__fake = fake;
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
})()`;

async function checkReader(S) {
  const p = S.page;
  await p.eval(`TTS.fillVoices && TTS.fillVoices(); const o = [...$('#voice').options].find((x) => /Fake/.test(x.value)); if (o) $('#voice').value = o.value; 0`);
  if (!(await p.eval(`/Fake/.test($('#voice').value)`))) { S.notes.push('reader: could not install the test voice'); return; }
  for (const [w, two] of [[1280, false], [1440, true], [700, false]]) {
    const where = `reader ${w}px ${two ? 'two' : 'one'} column`;
    await S.size(w, 820);
    await p.eval(`if (document.body.classList.contains('two') !== ${two}) $('#cols').click(); 0`);
    await sleep(250);
    const paras = await p.eval(`ORDER.filter((s) => s.kind === 'para' && s.edit && s.edit.isContentEditable && s.edit.textContent.length > 120).length`);
    for (let k = 0; k < Math.min(paras, QUICK ? 2 : 4); k++) {
      const idx = Math.floor((k + 0.5) * paras / Math.min(paras, QUICK ? 2 : 4));
      const want = await p.eval(`(() => { const s = ORDER.filter((s) => s.kind === 'para' && s.edit && s.edit.isContentEditable && s.edit.textContent.length > 120)[${idx}];
        const w = document.createTreeWalker(s.edit, NodeFilter.SHOW_TEXT); let t, last = null; while ((t = w.nextNode())) if (t.data.trim().length > 30 && !t.parentElement.closest('.chip')) last = t;
        if (!last) return null; const i = Math.floor(last.data.length / 2); const r = document.createRange(); r.setStart(last, i); r.collapse(true);
        s.edit.focus(); getSelection().removeAllRanges(); getSelection().addRange(r); return last.data.slice(i - 6, i + 6); })()`);
      if (!want) continue;
      await p.eval(`(() => { const o = [...$('#voice').options].find((x) => /Fake/.test(x.value)); if (o) $('#voice').value = o.value; })()`);
      await p.eval(`window.scrollBy(0, 2000); __fake.spoken = []; 0`);   // the caret is off screen: reading must bring it back
      await p.click('#play'); await sleep(700);
      if (process.env.UI_DEBUG) for (let q = 0; q < 4; q++) { console.log('  t+' + (700 + q * 400), await p.eval(`(() => { const h = CSS.highlights.get('tts'); const range = h && [...h][0]; const b = range && range.getClientRects()[0]; return [scrollY, b && Math.round(b.top), document.documentElement.scrollHeight]; })()`)); await sleep(400); }
      const r = await p.eval(`(() => { const h = CSS.highlights && CSS.highlights.get('tts'); const range = h && [...h][0]; const b = range && (range.getClientRects()[0] || range.getBoundingClientRect());
        return { spoken: __fake.spoken[0] || '', b: b && { top: b.top, bottom: b.bottom, h: b.height }, chrome: chromeBottom(), vh: innerHeight, pause: !$('#pause').disabled, stop: !$('#stop').disabled, state: $('#tts-state').textContent }; })()`);
      if (!r.spoken) { S.bug(where, 'play speaks nothing'); continue; }
      if (process.env.UI_DEBUG) console.log(where, JSON.stringify(r), await p.eval(`(() => { const h = CSS.highlights.get('tts'); const range = h && [...h][0]; return range ? [range.toString().slice(0, 50), [...range.getClientRects()].slice(0, 3).map((x) => [Math.round(x.top), Math.round(x.height)]), range.startContainer.parentElement.closest('.seg').className] : null; })()`));
      if (!r.spoken.replace(/\s+/g, ' ').includes(want.trim().replace(/\s+/g, ' ').slice(0, 6))) S.notes.push(`${where}: started with ${JSON.stringify(r.spoken.slice(0, 60))}, caret at ${JSON.stringify(want)}`);
      if (!r.b) S.bug(where, 'no phrase is highlighted while reading');
      else if (r.b.top < r.chrome - 1 || r.b.bottom > r.vh + 1) S.bug(where, `the phrase being read is not visible (top ${Math.round(r.b.top)}, bars end ${Math.round(r.chrome)}, window ${r.vh})`);
      if (!r.pause || !r.stop) S.bug(where, 'pause/stop are disabled while reading');
      for (let n = 0; n < 4; n++) {
        await p.eval(`__fake.finish()`); await sleep(450);
        const v = await p.eval(`(() => { const h = CSS.highlights.get('tts'); const range = h && [...h][0]; const b = range && (range.getClientRects()[0] || range.getBoundingClientRect()); return b ? [b.top, b.bottom, chromeBottom(), innerHeight] : null; })()`);
        if (v && (v[0] < v[2] - 1 || v[1] > v[3] + 1)) { S.bug(where, `a later phrase is read off screen (top ${Math.round(v[0])}, bars end ${Math.round(v[2])})`); break; }
      }
      // Stop is shown only while reading; the reader may have reached the end
      const st = await p.eval(`({ speaking: !$('#stop').disabled, shown: !!$('#stop').getClientRects().length })`);
      if (st.speaking && !st.shown) S.bug(where, 'reading, but the stop button is hidden');
      if (st.shown) { await p.click('#stop'); await sleep(100); }
      if (await p.eval(`!$('#stop').disabled`)) S.bug(where, 'stop leaves the reader running');
    }
  }
}

// the bars keep their height whatever the status says (edited, building, an error)
async function checkStable(S) {
  const p = S.page;
  for (const w of [1920, 1400, 1100, 760]) {
    await S.size(w, 800);
    const h0 = await p.eval(`$('#chrome').getBoundingClientRect().height`);
    await p.eval(`$('#dirty').textContent = '3 files edited'; $('#save').classList.add('has-changes');
      setBuild({ state: 'error', message: '! LaTeX Error: File \\'sections/01-intro.tex\\' not found. Emergency stop.' }); $('#tts-state').textContent = 'Reading'; 0`);
    await S.settle();
    const h1 = await p.eval(`$('#chrome').getBoundingClientRect().height`);
    await p.eval(`$('#dirty').textContent = ''; $('#save').classList.remove('has-changes'); setBuild({ state: 'idle', message: '' }); $('#tts-state').textContent = 'Ready'; 0`);
    if (Math.abs(h1 - h0) > 0.5) S.bug(`bars at ${w}px`, `change height from ${h0.toFixed(1)} to ${h1.toFixed(1)}px when the status changes (everything below jumps)`);
  }
}

async function checkFind(S) {
  const p = S.page;
  await S.size(1280, 820);
  const word = await p.eval(`(() => { const segs = ORDER.filter((s) => s.kind === 'para' && s.edit && s.edit.isContentEditable);
    for (let k = Math.floor(segs.length * 0.7); k < segs.length; k++) { const w = document.createTreeWalker(segs[k].edit, NodeFilter.SHOW_TEXT); let t;
      while ((t = w.nextNode())) { if (t.parentElement.closest('.chip')) continue; const m = /[A-Za-z]{7,}/.exec(t.data); if (m) return m[0]; } }
    return null; })()`);
  if (!word) return;
  await p.key('f', { ctrl: true }); await sleep(150);
  if (await p.eval(`$('#findbar').hidden`)) { S.bug('find', 'Ctrl+F does not open find'); return; }
  await p.type(word); await sleep(300);
  for (let k = 0; k < 3; k++) {
    await p.key('Enter'); await sleep(250);
    const v = await p.eval(`(() => { const h = CSS.highlights.get('findcur'); const r = h && [...h][0]; const b = r && r.getBoundingClientRect(); return b ? [b.top, b.bottom, chromeBottom(), innerHeight] : null; })()`);
    if (!v) { S.bug('find', `no current match for ${JSON.stringify(word)}`); break; }
    if (v[0] < v[2] - 1 || v[1] > v[3] + 1) { S.bug('find', `the current match is hidden (top ${Math.round(v[0])}, bars end ${Math.round(v[2])})`); break; }
  }
  await p.key('Escape');
  await p.waitFor(`$('#findbar').hidden`, 1500).catch(() => {});
  if (!(await p.eval(`$('#findbar').hidden`))) S.bug('find', 'Escape does not close find; open: ' + await p.eval(`[...['external','openbox','historybox','palette','keysbox','paperbox','figview','drawer','findbar','helpbox','menu']].filter((i) => { const e = document.getElementById(i); return e && !e.hidden; }).join(',')`));
}

async function checkWindows(S) {
  const p = S.page;
  for (const [w, h] of [[1280, 820], [700, 640]]) {
    await S.size(w, h);
    for (const [btn, box] of [['#paperbtn', '#paperbox'], ['#historybtn', '#historybox'], ['#keysbtn', '#keysbox'], ['#help', '#helpbox']]) {
      const where = `window ${box} at ${w}x${h}`;
      await p.click(btn); await sleep(400);
      if (await p.eval(`$('${box}').hidden`)) { S.bug(where, `${btn} does not open it`); continue; }
      await p.eval(HELPERS);
      const r = await p.eval(`(() => { const b = $('${box}'), r = b.getBoundingClientRect(); const out = [];
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push('reaches outside the window ' + [r.left, r.top, r.right, r.bottom].map(Math.round));
        for (const e of [...b.querySelectorAll('button')].filter(__ui.shown).slice(0, 30)) { const q = e.getBoundingClientRect(); const x = q.left + q.width / 2, y = q.top + q.height / 2; if (y < r.top + 2 || y > r.bottom - 2) continue;
          const top = document.elementFromPoint(x, y);
          if (y > 0 && y < innerHeight && top && !e.contains(top) && !(b.contains(top) && top.closest('.fv-head'))) out.push('button covered: ' + __ui.label(e) + ' by ' + (top.id || top.className || top.tagName));
          if (!e.disabled) { const c = __ui.contrast(e); if (c.r < 4.5) out.push('contrast ' + c.r.toFixed(2) + ': ' + __ui.label(e)); } }
        if (!document.documentElement.classList.contains('modal-open')) out.push('the page behind is not locked');
        return out; })()`);
      for (const i of r.slice(0, 5)) S.bug(where, i);
      await p.key('Escape');
      await p.waitFor(`$('${box}').hidden`, 1500).catch(() => {});
      if (!(await p.eval(`$('${box}').hidden`))) { S.bug(where, 'Escape does not close it; open: ' + await p.eval(`[...['external','openbox','historybox','palette','keysbox','paperbox','figview','drawer','findbar','helpbox','menu']].filter((i) => { const e = document.getElementById(i); return e && !e.hidden; }).join(',')`)); await p.eval(`$('${box}').hidden = true`); }
      if (await p.eval(`document.documentElement.classList.contains('modal-open')`)) S.bug(where, 'the page stays locked after closing');
    }
  }
}

// ------------------------------------------------------------ runner

async function runPaper(chrome, paper) {
  const S = new Session(chrome, paper);
  const t0 = Date.now();
  try {
    await S.start();
    const steps = [
      ['load', () => checkLoad(S)],
      ['layout', async () => {
        const sizes = QUICK ? [[1440, 900, 1], [760, 800, 1.5]] : [[1920, 1000, 1], [1440, 900, 1], [1100, 800, 1.25], [760, 800, 1.5], [520, 800, 2]];
        for (const [w, h, dpr] of sizes) for (const theme of ['light', 'dark']) for (const two of w >= 1000 ? [false, true] : [false]) {
          await checkLayout(S, w, h, dpr, theme, two, false);
        }
        await checkLayout(S, 1100, 800, 1, 'dark', true, true);
        await checkLayout(S, 760, 800, 1, 'light', false, true);
        await S.page.eval(`if (document.body.classList.contains('two')) $('#cols').click(); closeFind(); document.documentElement.removeAttribute('data-theme'); 0`);
      }],
      ['pressed', () => checkPressed(S)],
      ['editing', async () => { await checkEditing(S, false); await checkEditing(S, true); }],
      ['figures', () => checkFigures(S)],
      ['reader', () => checkReader(S)],
      ['find', () => checkFind(S)],
      ['stable', () => checkStable(S)],
      ['windows', () => checkWindows(S)],
      ['feedback', () => checkFeedback(S)],
    ];
    const only = (process.env.UI_ONLY || '').split(',').filter(Boolean);
    for (const [name, fn] of steps) {
      if (only.length && !only.includes(name)) continue;
      try { await fn(); } catch (e) { S.bug(name, 'the check itself failed: ' + String(e.message).split('\n')[0]); }
    }
    const p = S.page;
    for (const e of [...new Set(p.errors)].slice(0, 5)) S.bug('script error', e.split('\n')[0]);
    for (const e of [...new Set(p.consoleErrors)].slice(0, 5)) S.bug('console error', e.split('\n')[0]);
    for (const e of [...new Set(S.failed)].slice(0, 5)) S.bug('request failed', e);
    const writes = S.writes.filter((w) => !/\/api\/(keys|metadata)/.test(w) || !/feedback/.test(w));
    if (writes.length) S.notes.push('write requests refused: ' + [...new Set(writes)].join(', '));
    if (/JSERROR|Traceback/.test(S.log || '')) S.bug('server log', (S.log.match(/.*(JSERROR|Traceback).*/) || [''])[0].slice(0, 200));
  } catch (e) {
    S.bug('session', String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  } finally {
    await S.stop().catch(() => {});
  }
  return { S, ms: Date.now() - t0 };
}

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) { console.log('SKIP: no Chrome/Chromium (set CHROME=...)'); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-ui-chrome-'));
  const dport = await freePort();
  const proc = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,900',
    '--hide-scrollbars=false', 'about:blank'], { stdio: 'ignore' });
  let total = 0;
  try {
    const ver = await (await waitHttp(`http://127.0.0.1:${dport}/json/version`)).json();
    const chrome = { cdp: await CDP.connect(ver.webSocketDebuggerUrl) };
    for (const paper of papers()) {
      const { S, ms } = await runPaper(chrome, paper);
      total += S.bugs.length;
      console.log(`${S.bugs.length ? 'BUGS' : 'ok  '} ${paper.name} (${(ms / 1000).toFixed(1)} s, ${S.bugs.length} bugs)`);
      for (const b of S.bugs) console.log('     ✗ ' + b);
      if (process.env.UI_NOTES) for (const n of S.notes) console.log('     · ' + n);
    }
    chrome.cdp.ws.close();
  } finally {
    proc.kill();
    await sleep(200);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
  console.log(`${total} bugs` + (total ? `; screenshots in ${SHOTS}` : ''));
  process.exitCode = total ? 1 : 0;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
