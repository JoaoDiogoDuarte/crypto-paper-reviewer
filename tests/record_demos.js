#!/usr/bin/env node
// Records the demo GIFs of docs/demos.md: the editor in headless Chrome on a
// built copy of tests/fixtures/ieee-conf, driven as a user would, with a
// drawn pointer. Needs Node 22, Chrome, latexmk and ffmpeg.
//
//   node tests/record_demos.js                 # every demo
//   node tests/record_demos.js game-editor     # the demos whose name contains a word
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { CDP, Page, findChrome, freePort, waitHttp, sleep } = require('./e2e.js');

const ROOT = path.dirname(__dirname);
const OUT = path.join(ROOT, 'docs', 'demos');
const W = 1280, H = 820;
const PY = fs.existsSync(path.join(ROOT, '.venv/bin/python')) ? path.join(ROOT, '.venv/bin/python') : 'python3';

// ------------------------------------------------------------ the pointer

const POINTER = `(() => {
  if (document.getElementById('rec-pointer')) return;
  const p = document.createElement('div');
  p.id = 'rec-pointer';
  p.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12.5 18.7 L9.6 12 L15.5 12 Z" fill="#111" stroke="#fff" stroke-width="1.4"/></svg>';
  p.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-2px,-1px);';
  document.documentElement.append(p);
})()`;

// every mouse move also moves the drawn pointer
const send = Page.prototype.send;
Page.prototype.send = async function (method, params) {
  if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
    await send.call(this, 'Runtime.evaluate', { expression: `(${POINTER}, (() => { const p = document.getElementById('rec-pointer'); p.style.left = '${params.x}px'; p.style.top = '${params.y}px'; })())` });
  }
  return send.call(this, method, params);
};

// moves the pointer to an element slowly, so a viewer can follow it
async function glide(page, sel) {
  const expr = sel.startsWith('js:') ? sel.slice(3) : `document.querySelector(${JSON.stringify(sel)})`;
  await page.eval(`(() => { const e = ${expr}; const r = e.getBoundingClientRect(); if (r.top < 90 || r.bottom > innerHeight) e.scrollIntoView({ block: 'center' }); })()`);
  await sleep(150);
  const to = await page.eval(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const from = page.at || { x: W / 2, y: H / 2 };
  for (let k = 1; k <= 14; k++) {
    const t = k / 14, e = t * t * (3 - 2 * t);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
    await sleep(22);
  }
  page.at = to;
}
async function click(page, sel, opts = {}) {
  await glide(page, sel);
  await sleep(250);
  await page.click(sel, opts);
  await sleep(opts.wait || 600);
}
async function typeSlowly(page, text, ms = 70) {
  for (const c of text) { await page.type(c); await sleep(ms); }
}
async function key(page, k, mods = {}, wait = 700) { await page.key(k, mods); await sleep(wait); }

// ------------------------------------------------------------ recording

async function record(page, name, fn) {
  const frames = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      frames.push({ t, data });
      const left = 90 - (Date.now() - t);
      if (left > 0) await sleep(left);
    }
  })();
  try { await fn(); await sleep(1200); } finally { on = false; await loop; }
  // the frames, each as long as it was on screen, into a GIF with one palette
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  let list = '';
  frames.forEach((f, i) => {
    const file = path.join(dir, `${String(i).padStart(5, '0')}.png`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    const next = frames[i + 1] ? frames[i + 1].t : f.t + 1500;
    list += `file '${file}'\nduration ${((next - f.t) / 1000).toFixed(3)}\n`;
  });
  list += `file '${path.join(dir, String(frames.length - 1).padStart(5, '0') + '.png')}'\n`;
  fs.writeFileSync(path.join(dir, 'list.txt'), list);
  const out = path.join(OUT, name + '.gif');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
    '-vf', 'scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-r', '12', out]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`ok   ${name}.gif (${frames.length} frames, ${Math.round(fs.statSync(out).size / 1024)} KB)`);
}

// ------------------------------------------------------------ the demos

const segWith = (text) => `ORDER.find((s) => s.el && s.src.includes(${JSON.stringify(text)}))`;
const gameLine = (gi, n) => `js:[...document.querySelectorAll('#fv-body .game')[${gi}].querySelectorAll('.gline')][${n}]`;

const DEMOS = {
  async 'game-editor-editing'(page) {
    await page.eval(`${segWith('\\begin{algorithmic}')}.el.scrollIntoView({ block: 'center' })`);
    await sleep(800);
    await click(page, `js:${segWith('\\begin{algorithmic}')}.el.querySelector('img')`, { count: 2, wait: 1200 });
    // a while block after the sampling line
    await click(page, `js:${gameLine(0, 1).slice(3)}.querySelector('.gtext')`, { wait: 500 });
    await page.eval(`${gameLine(0, 1).slice(3)}.querySelector('select.g-insert').value = 'While'`);
    await sleep(500);
    await click(page, `js:${gameLine(0, 1).slice(3)}.querySelector('.gtools button')`, { wait: 1000 });
    // colour the sampling line
    await click(page, `js:${gameLine(0, 1).slice(3)}.querySelector('.gtext')`, { wait: 400 });
    await glide(page, `js:${gameLine(0, 1).slice(3)}.querySelector('select.g-mark')`);
    await page.eval(`(() => { const m = ${gameLine(0, 1).slice(3)}.querySelector('select.g-mark'); m.value = 'yellow!20'; m.dispatchEvent(new Event('change')); })()`);
    await sleep(1200);
    // Apply: the paper shows the edited game at once, then the build after a save
    await click(page, '#fv-apply', { wait: 2500 });
    await key(page, 's', { ctrl: true }, 500);
    await page.waitFor(`${segWith('\\begin{algorithmic}')}.el.querySelector('img') && !${segWith('\\begin{algorithmic}')}.el.querySelector('.game-preview')`, 120000, 'the rebuilt picture');
    await sleep(2000);
  },

  async 'subeditor-undo'(page) {
    // game editor: two edits, undone and redone
    await page.eval(`${segWith('\\begin{algorithmic}')}.el.scrollIntoView({ block: 'center' })`);
    await sleep(600);
    await click(page, `js:${segWith('\\begin{algorithmic}')}.el.querySelector('img')`, { count: 2, wait: 1000 });
    for (const [line, what] of [[1, 'While'], [0, 'Return']]) {
      await click(page, `js:${gameLine(0, line).slice(3)}.querySelector('.gtext')`, { wait: 300 });
      await page.eval(`${gameLine(0, line).slice(3)}.querySelector('select.g-insert').value = '${what}'`);
      await click(page, `js:${gameLine(0, line).slice(3)}.querySelector('.gtools button')`, { wait: 900 });
    }
    for (const b of ['undo', 'undo', 'redo', 'redo']) await click(page, '#fv-' + b, { wait: 1100 });
    page.dialogAnswer = true;
    await click(page, '#fv-close', { wait: 1000 });
    // table cells: type, Ctrl+Z, Ctrl+Shift+Z
    await page.eval(`${segWith('\\begin{tabular}')}.el.scrollIntoView({ block: 'center' })`);
    await sleep(600);
    await click(page, `js:${segWith('\\begin{tabular}')}.el.querySelector('img, .tabular-preview')`, { count: 2, wait: 1000 });
    const cell = `js:[...document.querySelectorAll('#fv-body td[contenteditable=true]')].find((t) => t.textContent.trim() === 'maybe')`;
    await click(page, cell, { wait: 300 });
    await page.eval(`getSelection().selectAllChildren(document.activeElement)`);
    await typeSlowly(page, 'surely');
    await sleep(600);
    await key(page, 'z', { ctrl: true }, 1200);
    await key(page, 'z', { ctrl: true, shift: true }, 1200);
    await click(page, '#fv-close', { wait: 1000 });
    // the formula editor: its own undo
    await click(page, `js:[...${segWith('Imaginary oracles answer')}.el.querySelectorAll('.chip.math')][2]`, { wait: 800 });
    await page.eval(`$('#drawer-src').setSelectionRange($('#drawer-src').value.length - 1, $('#drawer-src').value.length - 1)`);
    await typeSlowly(page, '+B', 200);
    await sleep(600);
    await key(page, 'z', { ctrl: true }, 1200);
    await key(page, 'z', { ctrl: true }, 1200);
    await click(page, '#drawer-cancel', { wait: 800 });
  },

  async 'displayed-equation'(page) {
    await page.eval(`(() => { const seg = ${segWith('After the list')}; seg.el.scrollIntoView({ block: 'center' }); })()`);
    await page.select('in verbatim.', 'end');
    await sleep(700);
    await key(page, 'm', { ctrl: true, shift: true }, 900);
    await typeSlowly(page, '\\Pr[E] \\le \\frac{q^2}{2^{n+1}}', 90);
    await sleep(900);
    await click(page, '#drawer-apply', { wait: 1500 });
  },

  async 'inline-maths'(page) {
    await page.eval(`${segWith('After the list')}.el.scrollIntoView({ block: 'center' })`);
    await page.select('in verbatim', 'end');
    await sleep(600);
    await typeSlowly(page, ', costing ');
    await key(page, 'm', { ctrl: true }, 800);
    await typeSlowly(page, 'q^2', 120);
    await sleep(600);
    await key(page, 'Enter', { ctrl: true }, 800);
    await typeSlowly(page, ' for 5$ each');
    await sleep(900);
    // $ over a selection: it becomes maths
    await page.select('verbatim');
    await sleep(700);
    await key(page, '$', { shift: true }, 1400);
  },

  async 'reference-jump'(page) {
    await page.eval(`scrollTo(0, 0)`);
    await sleep(600);
    await click(page, `js:[...${segWith('Imaginary oracles answer')}.el.querySelectorAll('.chip.ref')][0]`, { ctrl: true, wait: 2200 });
    await key(page, 'ArrowLeft', { alt: true }, 1500);
    await click(page, `js:[...${segWith('Imaginary oracles answer')}.el.querySelectorAll('.chip.cite')][0]`, { ctrl: true, wait: 2200 });
    await key(page, 'ArrowLeft', { alt: true }, 1500);
  },

  async 'text-size'(page) {
    await page.eval(`scrollTo(0, 0)`);
    await click(page, '#textbigger', { wait: 900 });
    await click(page, '#textbigger', { wait: 900 });
    await click(page, '#textbigger', { wait: 1200 });
    await click(page, '#textsmaller', { wait: 900 });
    await click(page, '#textsize', { wait: 1200 });
  },
};

// ------------------------------------------------------------ main

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) throw new Error('no Chrome (set CHROME=...)');
  const filters = process.argv.slice(2);
  const names = Object.keys(DEMOS).filter((n) => !filters.length || filters.some((f) => n.includes(f)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-paper-'));
  const paper = path.join(dir, 'paper'), state = path.join(dir, 'state');
  fs.cpSync(path.join(ROOT, 'tests/fixtures/ieee-conf'), paper, { recursive: true });
  fs.mkdirSync(state);
  // the PDF first (numbers, references), then the server, which cuts the figures
  console.log('building the paper…');
  execFileSync('latexmk', ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: paper, stdio: 'ignore' });
  const port = await freePort(), dport = await freePort();
  let log = '';
  const srv = spawn(PY, [path.join(ROOT, 'server.py'), path.join(paper, 'main.tex'), '--port', String(port), '--no-open', '--state', state],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config') } });
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  const profile = path.join(dir, 'chrome');
  const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  try {
    await waitHttp(`http://127.0.0.1:${port}/api/state`);
    for (let i = 0; ; i++) {
      const d = await (await fetch(`http://127.0.0.1:${port}/api/doc`)).json();
      if (Object.keys(d.figs || {}).length >= 2) break;
      if (i > 300) throw new Error('no figures from the server:\n' + log);
      await sleep(1000);
    }
    const ver = await (await waitHttp(`http://127.0.0.1:${dport}/json/version`)).json();
    const cdp = await CDP.connect(ver.webSocketDebuggerUrl);
    const pristine = Object.fromEntries(fs.readdirSync(paper, { recursive: true }).filter((f) => f.endsWith('.tex'))
      .map((f) => [f, fs.readFileSync(path.join(paper, f), 'utf8')]));
    for (const name of names) {
      // each demo on the untouched paper, built
      for (const [f, t] of Object.entries(pristine)) fs.writeFileSync(path.join(paper, f), t);
      const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const page = new Page(cdp, sessionId);
      await page.send('Page.enable'); await page.send('Runtime.enable');
      await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
      await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0 && AUXVER > 0 && document.querySelectorAll('.seg.figure img, .seg.table img').length >= 2`,
        180000, 'the built paper').catch(async (e) => {
        throw new Error(e.message + ': ' + JSON.stringify(await page.eval(`({ order: typeof ORDER !== 'undefined' && ORDER.length, aux: typeof AUXVER !== 'undefined' && AUXVER, imgs: document.querySelectorAll('.seg.figure img, .seg.table img').length, build: $('#build') && $('#build').textContent })`)));
      });
      await page.eval(`try { localStorage.clear(); } catch (e) {} document.documentElement.style.removeProperty('--doc-size')`);
      await page.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
      await sleep(800);
      await page.eval(POINTER);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: W / 2, y: H / 2 });
      page.at = { x: W / 2, y: H / 2 };
      try { await record(page, name, () => DEMOS[name](page)); }
      catch (e) { console.log(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
      await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    }
    cdp.ws.close();
  } finally {
    srv.kill(); chrome.kill();
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
