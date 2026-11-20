// An optional window for the editor: Electron instead of a Chrome app window,
// so that every key reaches the page (Chrome keeps Ctrl+W, Ctrl+Tab, Ctrl+T,
// Ctrl+N for itself).  server.py starts it with the editor's URL:
//
//     electron shell/ http://paper-reviewer.localhost:8765/
//
// With --probe instead of a URL it opens a hidden test page, presses keys the
// browser reserves and prints which of them reached the page, then quits.
// With --test-window (and --remote-debugging-port=N) it opens one window that
// is never shown, drawn offscreen, for tests/electron_test.js to drive: it
// shows no dialog (a prompt is cancelled, leaving with unsaved edits is
// allowed), and has a profile and a process of its own.
'use strict';
const path = require('path');
const os = require('os');
const { app, BrowserWindow, Menu, shell, dialog, session, ipcMain, screen } = require('electron');

const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('--') || a === '--probe');
const probe = args.includes('--probe');
const testWindow = process.argv.includes('--test-window');
const url = args.find((a) => /^https?:\/\//.test(a));

// a profile of its own, apart from the Chrome app window's
const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
app.setPath('userData', path.join(config, 'paper-editor', probe ? 'electron-probe' : testWindow ? 'electron-test' : 'electron-profile'));
app.setName('Crypto Paper Reviewer');

// No application menu: its accelerators (Ctrl+W closes, Ctrl+R reloads,
// Ctrl+Shift+I opens the developer tools) would take the keys from the page.
Menu.setApplicationMenu(null);

// One process per profile: Chromium does not share a profile between two
// processes (the second one's local storage and settings would not hold), so
// a second ./run opens its window in the first process.
// (a test window never joins the user's: its page would open in their editor)
const secondary = !probe && !testWindow && !process.argv.includes('--smoke') && !app.requestSingleInstanceLock({ url });
if (secondary) app.quit();
else {
  app.on('second-instance', (e, argv, cwd, extra) => {
    const u = (extra && extra.url) || argv.find((a) => /^https?:\/\//.test(a));
    if (u) app.whenReady().then(() => makeWindow(u));
  });
}

// The page zoom: the last one set here (Ctrl+wheel), else the one the Chrome
// app window has (server.py passes it), else 100%.  Chrome levels: 0 is 100%,
// each step of 1 is a factor 1.2.
const fs = require('fs');
const zoomFile = () => path.join(app.getPath('userData'), 'zoom.json');
function savedZoom() {
  try { const z = JSON.parse(fs.readFileSync(zoomFile(), 'utf8')).level; if (Number.isFinite(z)) return z; } catch (e) { /* none yet */ }
  const arg = process.argv.find((a) => a.startsWith('--chrome-zoom='));
  const z = arg ? parseFloat(arg.slice(14)) : NaN;
  return Number.isFinite(z) ? z : 0;
}
function saveZoom(level) {
  try { fs.writeFileSync(zoomFile(), JSON.stringify({ level })); } catch (e) { /* a nicety */ }
}

const local = (u) => {
  try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || h.endsWith('.localhost'); } catch (e) { return false; }
};

function makeWindow(target, show = true) {
  const win = new BrowserWindow({
    width: 1400, height: 950, show,
    icon: path.join(__dirname, 'icon.png'),   // made from static/icon.svg: Electron reads no SVG
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, plugins: true,
      preload: path.join(__dirname, 'preload.js'),
      // the test window is never shown, but paints and runs its timers as a shown one
      ...(testWindow ? { offscreen: true, backgroundThrottling: false } : {}) },
  });
  const wc = win.webContents;
  // the PDF opens in a window of its own; other sites in the system browser
  wc.setWindowOpenHandler(({ url: u }) => {
    if (local(u)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 1100, autoHideMenuBar: true } };
    shell.openExternal(u);
    return { action: 'deny' };
  });
  // a file dropped outside the text would navigate to it: the editor stays
  wc.on('will-navigate', (e, u) => {
    if (local(u)) return;
    e.preventDefault();
    if (/^(https?|mailto):/.test(u)) shell.openExternal(u);
  });
  // Electron closes a window with unsaved edits without asking; Chrome asks
  wc.on('will-prevent-unload', (e) => {
    if (testWindow) { e.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1,
      message: 'Leave the editor?', detail: 'Changes you made may not be saved.',
    });
    if (choice === 0) e.preventDefault();
  });
  // the window's own keys, none of which the editor uses: F12 developer
  // tools, F11 full screen, Ctrl+0 page zoom back to the Chrome app window's.
  // (Not Ctrl+Shift+I: the editor's italic.)
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const plain = !input.control && !input.alt && !input.shift && !input.meta;
    if (plain && input.key === 'F12') { wc.toggleDevTools(); e.preventDefault(); }
    else if (plain && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.control && !input.alt && !input.shift && input.key === '0') {
      try { fs.unlinkSync(zoomFile()); } catch (err) { /* none saved */ }
      wc.setZoomLevel(savedZoom()); e.preventDefault();
    }
  });
  // right click: spelling suggestions, cut, copy, paste (Electron has no menu of its own)
  wc.on('context-menu', (e, p) => {
    const items = p.dictionarySuggestions.slice(0, 6).map((s) => ({ label: s, click: () => wc.replaceMisspelling(s) }));
    if (p.misspelledWord) {
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' });
    else if (p.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  // zoom: Chromium keeps it per host, so it holds across reloads; Ctrl+wheel
  // changes it in half steps (Electron reports the wheel but does not zoom)
  wc.on('did-finish-load', () => { if (local(wc.getURL())) wc.setZoomLevel(savedZoom()); });
  wc.on('zoom-changed', (e, way) => {
    const level = Math.max(-3, Math.min(5, wc.getZoomLevel() + (way === 'in' ? 0.5 : -0.5)));
    wc.setZoomLevel(level); saveZoom(level);
  });
  win.loadURL(target);
  return win;
}

// prompt() for the page (preload.js): a small window over the editor with the
// message, a field and OK/Cancel.  The page waits, as with the browser's.
// The answer comes back in the dialog's title ("ok:<text>" or "cancel").
const PROMPT_PAGE = (message, value) => `<!doctype html><meta charset=utf-8><style>
:root{color-scheme:light dark;font:14px system-ui,sans-serif}
body{margin:0;padding:16px 18px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;background:Canvas;color:CanvasText}
p{margin:0;white-space:pre-wrap;line-height:1.4}input{font:inherit;padding:6px 8px;width:100%;box-sizing:border-box}
div{display:flex;justify-content:flex-end;gap:8px}button{font:inherit;padding:5px 16px}</style>
<p id=m></p><input id=v><div><button id=c>Cancel</button><button id=o>OK</button></div><script>
const d=${JSON.stringify({ message, value }).replace(/</g, '\\u003c')};
m.textContent=d.message;v.value=d.value;v.focus();v.select();
const done=(t)=>{document.title=t};
o.onclick=()=>done('ok:'+v.value);c.onclick=()=>done('cancel');
addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();done('ok:'+v.value)}else if(e.key==='Escape'){e.preventDefault();done('cancel')}});
</script>`;
function askText(parent, message, value, done) {
  if (testWindow) { done(null); return; }
  const box = new BrowserWindow({
    parent, modal: true, show: false, width: 560, height: 200, useContentSize: true,
    resizable: false, minimizable: false, maximizable: false, autoHideMenuBar: true, title: 'Crypto Paper Reviewer',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: false },
  });
  let answered = false;
  const answer = (v) => { if (answered) return; answered = true; done(v); if (!box.isDestroyed()) box.destroy(); };
  box.webContents.on('page-title-updated', (e, t) => {
    if (t === 'cancel') answer(null);
    else if (t.startsWith('ok:')) answer(t.slice(3));
  });
  box.on('closed', () => answer(null));
  // the dialog takes the editor's zoom, so its size is measured after zooming:
  // the width grows with the zoom, and the height is that of the content
  box.webContents.on('did-finish-load', async () => {
    const wc = box.webContents;
    wc.setZoomLevel(savedZoom());
    const f = wc.getZoomFactor();
    const area = screen.getDisplayMatching(parent ? parent.getBounds() : box.getBounds()).workArea;
    // the content is laid out at a fixed CSS width, so its height does not
    // depend on when the window and the zoom reach the page
    const cssWidth = Math.floor(Math.min(560, (area.width - 40) / f));
    const h = await wc.executeJavaScript(`document.body.style.width = '${cssWidth}px'; document.body.getBoundingClientRect().height`).catch(() => 200);
    if (box.isDestroyed()) return;
    box.setContentSize(Math.ceil(cssWidth * f), Math.min(Math.ceil(h * f) + 2, area.height - 60));
    if (parent && !parent.isDestroyed()) {
      const p = parent.getBounds(), b = box.getBounds();
      box.setPosition(Math.round(p.x + (p.width - b.width) / 2), Math.round(p.y + Math.max(0, (p.height - b.height) / 3)));
    }
    if (!process.argv.includes('--smoke')) { box.show(); return; }
    // the smoke test answers the dialog itself, in a hidden window, and notes
    // whether the content fits it (no scrolling)
    promptFits.push(await wc.executeJavaScript('document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth').catch(() => false));
    wc.executeJavaScript('v.value="smoke answer";o.click()');
  });
  box.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PROMPT_PAGE(message, value)));
}
const promptFits = [];
ipcMain.on('shell-prompt', (event, message, value) => {
  askText(BrowserWindow.fromWebContents(event.sender), message, value, (v) => { event.returnValue = v; });
});

// Ctrl+F that the editor leaves to the browser (in the source view): Chrome
// has a find bar there, Electron has none.  The same text again goes to the
// next match; an empty one ends the search.
let lastFind = '';
ipcMain.on('shell-find', (event) => {
  const wc = event.sender;
  askText(BrowserWindow.fromWebContents(wc), 'Find in the page (the same text again: the next match):', lastFind, (q) => {
    if (q === null) return;
    if (!q) { wc.stopFindInPage('keepSelection'); lastFind = ''; return; }
    wc.findInPage(q, { findNext: q !== lastFind });
    lastFind = q;
  });
});

// Keys Chrome keeps for itself, pressed into a hidden page: which reach it.
const PROBE_KEYS = [
  ['w', ['control']], ['W', ['control', 'shift']], ['t', ['control']], ['n', ['control']],
  ['N', ['control', 'shift']], ['T', ['control', 'shift']], ['Tab', ['control']],
  ['Tab', ['control', 'shift']], ['PageDown', ['control']], ['PageUp', ['control']],
  ['C', ['control', 'shift']], ['J', ['control', 'shift']], ['q', ['control']],
  ['r', ['control']], ['l', ['control']], ['g', ['alt']], ['>', ['control', 'shift']],
];
async function runProbe() {
  const page = 'data:text/html,<body><input id=i autofocus><script>window.got=[];' +
    'addEventListener("keydown",e=>{got.push((e.ctrlKey?"C-":"")+(e.altKey?"M-":"")+(e.shiftKey?"S-":"")+e.key);e.preventDefault()},true)</script>';
  const win = makeWindow(page, false);
  const wc = win.webContents;
  await new Promise((r) => wc.once('did-finish-load', r));
  wc.focus();
  for (const [keyCode, modifiers] of PROBE_KEYS) {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
  await new Promise((r) => setTimeout(r, 500));
  const got = await wc.executeJavaScript('window.got');
  const closed = win.isDestroyed();
  console.log(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, sent: PROBE_KEYS.length, got, windowStillOpen: !closed }));
  app.quit();
}

// --smoke <URL>: the editor in a hidden window; prints whether the paper
// loaded and what the page logged as errors, then quits.
async function runSmoke(target) {
  const errors = [];
  const win = makeWindow(target, false);
  const wc = win.webContents;
  wc.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await new Promise((r) => wc.once('did-finish-load', r));
  let loaded = false;
  for (let i = 0; i < 60 && !loaded; i++) {
    await new Promise((r) => setTimeout(r, 500));
    loaded = await wc.executeJavaScript('!!(window.DOC || document.querySelector("#doc [contenteditable=true]"))');
  }
  const blocks = await wc.executeJavaScript('document.querySelectorAll("#doc [contenteditable=true]").length');
  const zoom = wc.getZoomLevel();
  // prompt() works (the dialog answers itself here), and so does Report a problem
  const prompted = await wc.executeJavaScript('prompt("Smoke test", "default")').catch((e) => 'threw: ' + e.message);
  const report = await wc.executeJavaScript('REC.report().then(() => document.querySelector("#banner").textContent)').catch((e) => 'threw: ' + e.message);
  // Ctrl+F in the source view reaches the window's own find (answered "smoke answer")
  await wc.executeJavaScript('toggleSource(true); document.querySelector("#srcta").focus()').catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  const found = new Promise((r) => { wc.once('found-in-page', (e, res) => r(res.finalUpdate !== undefined)); setTimeout(() => r(false), 4000); });
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: ['control'] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'f', modifiers: ['control'] });
  const sourceFind = await found;
  console.log(JSON.stringify({ loaded, blocks, zoom, prompted, report, sourceFind, promptFits, errors }));
  app.quit();
}

app.whenReady().then(() => {
  if (secondary) return;
  session.defaultSession.setSpellCheckerLanguages(['en-GB']);
  if (probe) { runProbe(); return; }
  if (testWindow) { makeWindow('about:blank', false); return; }
  if (process.argv.includes('--smoke') && url) { runSmoke(url); return; }
  if (!url) { console.error('usage: electron shell/ <editor URL> | --probe'); app.exit(2); return; }
  makeWindow(url);
});
app.on('window-all-closed', () => app.quit());
