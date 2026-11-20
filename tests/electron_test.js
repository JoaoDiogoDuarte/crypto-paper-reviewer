#!/usr/bin/env node
// The browser tests of tests/e2e.js, run in the Electron window (the daily
// one) instead of headless Chrome: the shell's own key handling, its
// prompt, and the keys Chrome keeps for itself all take part.  The window is
// never shown (shell/main.js --test-window: hidden, drawn offscreen), so
// nothing appears on the screen or takes the focus.
//
//   node tests/electron_test.js              # every test that fits one window
//   node tests/electron_test.js multi keys   # those whose names contain these
//   E2E_FROM=layout node tests/electron_test.js   # from the first test whose name has this
//
// It skips (and says so) when shell/node_modules has no Electron.  Tests that
// open a second tab, or answer a prompt, need what one hidden window does not
// have, and are left out (ONE_WINDOW_ONLY).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const E = require('./e2e.js');
const { CDP, Page, Env, freePort, waitHttp, sleep } = E;

const ROOT = path.dirname(__dirname);
let ELECTRON = null;
try { ELECTRON = require(path.join(ROOT, 'shell', 'node_modules', 'electron')); } catch (e) { /* not installed */ }

// tests that need a second tab, a prompt answered, or the browser's own dialog
const ONE_WINDOW_ONLY = /another tab|two tabs|second tab|fresh tab|prompt|beforeunload|leave the page|leaving the page/i;

const ELX = {};   // the Electron process: its CDP connection and its window's target
class ElectronEnv extends Env {
  async openPage() {
    const { sessionId } = await ELX.cdp.send('Target.attachToTarget', { targetId: ELX.target, flatten: true });
    this.sessions = [...(this.sessions || []), sessionId];
    const page = new Page(ELX.cdp, sessionId);
    (this.pages = this.pages || []).push(page);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // a hidden window has no focus of its own: the page behaves as focused
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.send('Page.navigate', { url: `http://127.0.0.1:${this.port}/` });
    await page.waitFor(`typeof ORDER !== 'undefined' && ORDER.length > 0 && typeof AUXVER !== 'undefined' && AUXVER > 0`, 15000, 'the page to load');
    // (for the report of a failure: every redraw and what asked for it, and where the focus went)
    if (process.env.E2E_TRACE) await page.eval(`(() => { window.__rlog = []; const r0 = render; render = function () { __rlog.push(Math.round(performance.now()) + ' render ' + new Error().stack.split('\\n').slice(2, 5).map((l) => l.trim().replace(/^at /, '').replace(/ \\(.*/, '')).join(' < ')); return r0.apply(this, arguments); };
      addEventListener('focusout', (e) => { if (!e.relatedTarget) __rlog.push(Math.round(performance.now()) + ' focus lost from ' + (e.target.className || e.target.tagName) + (e.target.isConnected ? '' : ' (removed)')); }, true); })()`);
    return page;
  }
  // the window stays (Electron would quit without it): it goes to a blank page
  async stop() {
    for (const p of this.pages || []) { p.dialogAnswer = true; await p.interceptSaves(null).catch(() => {}); }
    for (const p of this.pages || []) await p.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
    for (const s of this.sessions || []) await ELX.cdp.send('Target.detachFromTarget', { sessionId: s }).catch(() => {});
    await this.stopServer();
    try { fs.chmodSync(this.paper, 0o755); } catch (e) { /* gone */ }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

async function main() {
  if (!ELECTRON || !fs.existsSync(ELECTRON)) { console.log('SKIP: no Electron in shell/node_modules (npm install there)'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-electron-'));
  const dport = await freePort();
  const proc = spawn(ELECTRON, [path.join(ROOT, 'shell'), '--test-window', `--remote-debugging-port=${dport}`], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, XDG_CONFIG_HOME: path.join(home, 'config') } });
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  // stopped from outside (Ctrl+C, a timeout): Electron goes too, not left running
  process.on('exit', () => proc.kill());
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { proc.kill(); process.exit(130); });
  try {
    const ver = await (await waitHttp(`http://127.0.0.1:${dport}/json/version`)).json();
    ELX.cdp = await CDP.connect(ver.webSocketDebuggerUrl);
    for (let i = 0; i < 100 && !ELX.target; i++) {
      const { targetInfos } = await ELX.cdp.send('Target.getTargets');
      const t = targetInfos.find((x) => x.type === 'page');
      if (t) ELX.target = t.targetId; else await sleep(100);
    }
    if (!ELX.target) throw new Error('no window in Electron');
    console.log(`Electron ${ver.Browser}`);
    if (process.env.E2E_PROBE) E.TESTS['probe'] = require(path.resolve(process.env.E2E_PROBE));
    const filters = process.env.E2E_PROBE ? ['probe'] : process.argv.slice(2);
    let names = Object.keys(E.TESTS).filter((n) => (!filters.length || filters.some((f) => n.includes(f))) && !ONE_WINDOW_ONLY.test(n));
    // E2E_FROM=<part of a name>: start at that test (to go on after a stop)
    if (process.env.E2E_FROM) { const i = names.findIndex((n) => n.includes(process.env.E2E_FROM)); if (i > 0) names = names.slice(i); }
    let failed = 0;
    for (const name of names) {
      const env = new ElectronEnv();
      const t0 = Date.now();
      try {
        // a test that waits on something a hidden window never does would wait for ever
        let timer;
        const page = await Promise.race([(async () => { const p = await env.start(); await E.TESTS[name](env, p); return p; })(),
          new Promise((res, rej) => { timer = setTimeout(() => rej(new Error('timed out after 120 s')), 120000); })]).finally(() => clearTimeout(timer));
        if (page.errors.length) throw new Error('script errors: ' + page.errors.join('\n'));
        console.log(`ok   ${name} (${Date.now() - t0} ms)`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${name}\n     ${String(e.message).replace(/\n/g, '\n     ')}`);
        const p = env.pages && env.pages[env.pages.length - 1];
        if (p) console.log('     page: ' + await Promise.race([sleep(5000).then(() => 'no answer'), p.eval(`JSON.stringify({ focus: document.hasFocus(), active: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName), toasts: [...document.querySelectorAll('#toasts > *')].map((t) => t.textContent), banner: $('#banner').hidden ? '' : $('#banner').textContent, prefix: PREFIX, mc: MC.cursors.length, log: window.__rlog })`).catch((x) => x.message)]));
        if (process.env.E2E_LOG) console.log(env.log);
      } finally {
        await Promise.race([env.stop(), sleep(20000)]);
      }
    }
    console.log(`${names.length - failed}/${names.length} passed in Electron`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error(e, log.slice(-2000));
    process.exitCode = 2;
  } finally {
    if (ELX.cdp) ELX.cdp.ws.close();
    proc.kill();
    await sleep(300);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}
if (require.main === module) main();
module.exports = { main };
