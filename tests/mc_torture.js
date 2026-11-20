#!/usr/bin/env node
// Multiple cursors, driven at random as a person would: cursors made with
// Ctrl+>, the chords, Ctrl+Shift+click and the find bar, then typing,
// deleting, moving, copying and pasting, undo, Esc, in the paper view and
// in the source view.
//
//   node tests/mc_torture.js            # 8 seeds of 70 steps in each view
//   MC_SEEDS=30 MC_STEPS=120 node tests/mc_torture.js
//   MC_SEED=17 node tests/mc_torture.js # one seed (to replay a failure)
//   MC_ELECTRON=1 node tests/mc_torture.js  # in the Electron window
//
// After every step: no script or console error; every cursor in a block on
// the page (or in the source text), inside it, none overlapping; one caret
// drawn for each cursor but the real one that has no selection, and none
// left when there is one cursor.  For the steps whose effect is plain (typing, Backspace and
// Delete over letters, arrows over letters), the text and the cursors are
// also compared with a model.  After each run: saved, read back from disk,
// and every block reads back to its exact source.
'use strict';
const E = require('./e2e.js');
const { sleep } = E;

const SEEDS = +(process.env.MC_SEEDS || 8), STEPS = +(process.env.MC_STEPS || 70);
const ONLY = process.env.MC_SEED !== undefined ? [+process.env.MC_SEED] : null;

const BODY = String.raw`\section{Body}\label{sec:body}
One alpha and alpha with $x+y$ here.
Then \emph{alpha beta} again, see \cref{sec:intro}.

\subsection{Details}
An alpha here, alphabet not, and gamma.

Last alpha paragraph with beta and gamma and delta.
A list follows:
\begin{itemize}
\item first alpha item
\item second beta item\footnote{A note with gamma.}
\end{itemize}
And \textbf{bold alpha} closes it.
`;

function rng(seed) {
  let s = seed * 2654435761 >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// the state as the page has it: cursors as [block index, anchor, focus],
// the text of each block with a cursor
const PAPER_STATE = `(() => {
  const eds = mcEditables();
  const cs = mcSorted().map((c) => [eds.indexOf(c.ed), c.a, c.f, c === MC.primary]);
  const texts = {};
  for (const [i] of cs) texts[i] = mcText(eds[i]);
  const layer = document.getElementById('mc-layer');
  const s = getSelection();
  const real = MC.primary && s.rangeCount ? mcFromSelection() : null;
  return { cs, texts, active: mcActive(), carets: layer ? layer.children.length : 0,
    hl: !!(CSS.highlights && CSS.highlights.has('mc')), connected: MC.cursors.every((c) => c.ed.isConnected),
    real: real && MC.primary ? [real.ed === MC.primary.ed, real.a, real.f, MC.primary.a, MC.primary.f] : null };
})()`;
const SRC_STATE = `(() => {
  const ta = $('#srcta');
  const cs = smcSorted().map((c) => [0, c.a, c.f, c === SMC.primary]);
  const layer = document.getElementById('mc-layer');
  return { source: true, cs, texts: { 0: ta.value }, active: smcActive(), carets: layer ? layer.children.length : 0,
    hl: !!(CSS.highlights && CSS.highlights.has('mc')), connected: true,
    real: SMC.primary ? [true, ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart, ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd, SMC.primary.a, SMC.primary.f] : null };
})()`;

function checkState(st, where) {
  if (!st.connected) throw new Error(`${where}: a cursor in a block no longer on the page`);
  if (st.active) {
    // (the source view draws only the cursors on the lines in the window)
    // a bar for each cursor but the real one that has no selection
    const bars = st.cs.filter((c) => !c[3] && c[1] === c[2]).length;
    if (st.source ? st.carets > bars : st.carets !== bars) throw new Error(`${where}: ${st.carets} carets drawn for ${bars} cursors without a selection`);
    for (let k = 0; k < st.cs.length; k++) {
      const [i, a, f] = st.cs[k];
      if (i < 0) throw new Error(`${where}: a cursor in a block that takes none`);
      const len = st.texts[i].length;
      if (a < 0 || f < 0 || a > len || f > len) throw new Error(`${where}: cursor ${a},${f} outside its block of ${len}`);
      const n = st.cs[k + 1];
      if (n && n[0] === i && Math.min(n[1], n[2]) < Math.max(a, f)) throw new Error(`${where}: cursors overlap: ${JSON.stringify(st.cs)}`);
    }
    if (st.cs.filter((c) => c[3]).length !== 1) throw new Error(`${where}: not one primary cursor`);
    if (st.real && !(st.real[0] && st.real[1] === st.real[3] && st.real[2] === st.real[4])) throw new Error(`${where}: the real selection is not on the primary cursor: ${JSON.stringify(st.real)}`);
  } else {
    if (st.carets) throw new Error(`${where}: ${st.carets} carets left with one cursor`);
    if (st.hl) throw new Error(`${where}: the highlight left with one cursor`);
  }
}

// the model of a plain step: each cursor's text and place afterwards
const lo = (c) => Math.min(c[1], c[2]), hi = (c) => Math.max(c[1], c[2]);
function model(st, op) {
  const texts = { ...st.texts };
  const cs = st.cs.map((c) => [...c]);
  const plain = (ch) => ch !== undefined && /[A-Za-z0-9]/.test(ch);
  // last first, as the editor does; later cursors in the block move with the text
  for (let k = cs.length - 1; k >= 0; k--) {
    const c = cs[k], t = texts[c[0]];
    let a = lo(c), b = hi(c), nt = t, caret;
    // (a caret between two chips is moved by Chrome before it types: not modelled)
    if (op.type === 'type' && t[a - 1] === '\uFFFC' && t[b] === '\uFFFC') return null;
    if (op.type === 'type') { nt = t.slice(0, a) + op.ch + t.slice(b); caret = [a + op.ch.length, a + op.ch.length]; }
    else if (op.type === 'del') {
      if (a === b) { if (op.back) { if (!plain(t[a - 1])) return null; a--; } else { if (!plain(t[b])) return null; b++; } }
      else if (!/^[A-Za-z0-9 ]*$/.test(t.slice(a, b))) return null;
      nt = t.slice(0, a) + t.slice(b); caret = [a, a];
    } else if (op.type === 'move') {
      if (c[1] !== c[2]) caret = op.back ? [a, a] : [b, b];
      else { const p = op.back ? c[2] - 1 : c[2] + 1; if (!plain(op.back ? t[c[2] - 1] : t[c[2]])) return null; caret = [p, p]; }
    }
    texts[c[0]] = nt;
    const d = nt.length - t.length;
    for (let j = k + 1; j < cs.length && cs[j][0] === c[0]; j++) { cs[j][1] += d; cs[j][2] += d; }
    c[1] = caret[0]; c[2] = caret[1];
  }
  // cursors that meet become one
  const out = [];
  for (const c of cs) {
    const p = out[out.length - 1];
    if (p && p[0] === c[0] && (lo(c) < hi(p) || (lo(c) === hi(p) && (c[1] === c[2] || p[1] === p[2])))) {
      p[1] = Math.min(lo(p), lo(c)); p[2] = Math.max(hi(p), hi(c)); continue;
    }
    out.push(c);
  }
  return { texts, cs: out.length > 1 ? out.map((c) => [c[0], c[1], c[2]]) : null };
}

const WORDS = ['alpha', 'beta', 'gamma', 'here', 'and'];
async function makeCursors(page, r, view) {
  const word = WORDS[Math.floor(r() * WORDS.length)];
  if (view === 'paper') {
    const ok = await page.eval(`(() => { for (const ed of mcEditables()) { const t = mcText(ed), i = t.indexOf(${JSON.stringify(word)}, ${Math.floor(r() * 10)}); if (i < 0) continue;
      ed.focus(); const p = mcPoint(ed, i + 1); getSelection().setBaseAndExtent(p[0], p[1], p[0], p[1]); return true; } return false; })()`);
    if (!ok) return 'no ' + word;
  } else {
    await page.eval(`(() => { const ta = $('#srcta'), i = ta.value.indexOf(${JSON.stringify(word)}); ta.focus(); ta.setSelectionRange(i + 1, i + 1); })()`);
  }
  const how = r();
  if (how < 0.45) { const n = 1 + Math.floor(r() * 4); for (let i = 0; i < n; i++) await page.key('>', { ctrl: true, shift: true }); return `Ctrl+> ×${n} on ${word}`; }
  if (how < 0.6) { await page.key('c', { ctrl: true, shift: true }); await page.key('a', { ctrl: true, shift: true }); return `mark all ${word}`; }
  if (how < 0.75) { await page.key('c', { ctrl: true, shift: true }); await page.key('d', { ctrl: true, shift: true }); return `dwim ${word}`; }
  if (how < 0.85) { await page.key('>', { ctrl: true, shift: true, alt: true }); await page.key('>', { ctrl: true, shift: true }); return `Ctrl+Alt+> then Ctrl+> on ${word}`; }
  // edit lines: a selection over a few lines
  if (view === 'paper') {
    await page.eval(`(() => { const eds = mcEditables().filter((e) => segOf(e).file === 'sections/body.tex' && segOf(e).kind === 'para');
      const a = eds[0], b = eds[1];
      const pa = mcPoint(a, Math.min(3, mcText(a).length)), pb = mcPoint(b, Math.min(2, mcText(b).length)); b.focus(); getSelection().setBaseAndExtent(pa[0], pa[1], pb[0], pb[1]); })()`);
  } else {
    await page.eval(`(() => { const ta = $('#srcta'), i = ta.value.indexOf('\\n') + 3, j = ta.value.indexOf('\\n', ta.value.indexOf('subsection')) + 3; ta.focus(); ta.setSelectionRange(i, j); })()`);
  }
  await page.key('c', { ctrl: true, shift: true }); await page.key('c', { ctrl: true, shift: true });
  return 'edit lines';
}

async function step(page, r, view, log) {
  const st = await page.eval(view === 'paper' ? PAPER_STATE : SRC_STATE);
  if (!st.active) { log.push(await makeCursors(page, r, view)); await sleep(40); return null; }
  const x = r();
  let op = null;
  if (x < 0.3) { const ch = 'abcxyzQ 1,.'[Math.floor(r() * 11)]; await page.key(ch); op = { type: 'type', ch }; log.push(`type ${JSON.stringify(ch)}`); }
  else if (x < 0.42) { const back = r() < 0.6; await page.key(back ? 'Backspace' : 'Delete'); op = { type: 'del', back }; log.push(back ? 'Backspace' : 'Delete'); }
  else if (x < 0.55) { const back = r() < 0.5; await page.key(back ? 'ArrowLeft' : 'ArrowRight'); op = { type: 'move', back }; log.push(back ? 'Left' : 'Right'); }
  else if (x < 0.62) { const k = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'][Math.floor(r() * 4)]; await page.key(k, { shift: true }); log.push('Shift+' + k); }
  else if (x < 0.66) { await page.key(r() < 0.5 ? 'a' : 'e', { ctrl: true }); log.push('Ctrl+A/E'); }
  else if (x < 0.7) { await page.key('Backspace', { ctrl: true }); log.push('Ctrl+Backspace'); }
  else if (x < 0.74) {
    const got = await page.copy();
    const n = st.cs.length;
    await page.paste(r() < 0.5 ? got['text/plain'] || 'P' : Array.from({ length: n }, (_, i) => 'L' + i).join('\n'));
    log.push('copy, paste');
  }
  else if (x < 0.77) { await page.key('b', { ctrl: true }); log.push('Ctrl+B'); }
  else if (x < 0.8) { await page.key('<', { ctrl: true, shift: true }); log.push('Ctrl+<'); }
  else if (x < 0.83) { await page.key('Enter'); log.push('Enter'); }
  else if (x < 0.86) { await page.key('Escape'); log.push('Esc'); }
  else if (x < 0.89) { await page.key('z', { ctrl: true }); log.push('undo'); }
  else if (x < 0.92) { await page.key('>', { ctrl: true, shift: true }); log.push('Ctrl+>'); }
  else if (x < 0.95) { await page.key('c', { ctrl: true, shift: true }); await page.key('n', { ctrl: true, shift: true }); await page.key('Escape'); await page.eval(view === 'paper' ? 'mcNumbers()' : 'smcNumbers()'); log.push('numbers'); }
  else { await page.key('$'); log.push('$'); }
  await sleep(40);
  if (!op) return null;
  const want = model(st, op);
  if (!want) return null;
  const now = await page.eval(view === 'paper' ? PAPER_STATE : SRC_STATE);
  for (const i of Object.keys(want.texts)) {
    // (a space typed at the end of a text is a no-break space there, as with one cursor)
    const sp = (t) => t.replace(/\u00a0/g, ' ');
    if (now.texts[i] !== undefined && sp(now.texts[i]) !== sp(want.texts[i]) && want.cs) throw new Error(`block ${i}: ${JSON.stringify(now.texts[i])}, the model has ${JSON.stringify(want.texts[i])}`);
  }
  const got = now.active ? JSON.stringify(now.cs.map((c) => [c[0], c[1], c[2]])) : 'null';
  if (got !== JSON.stringify(want.cs)) throw new Error(`cursors ${got}, the model has ${JSON.stringify(want.cs)} (before: ${JSON.stringify(st.cs)})`);
  return null;
}

async function run(env, page, seed, view) {
  const r = rng(seed + (view === 'source' ? 1000 : 0));
  env.write('sections/body.tex', BODY);
  await page.eval('load(true)');
  await page.waitFor(`ORDER.some((s) => s.src.includes('bold alpha'))`, 8000, 'the fixture');
  if (view === 'source') {
    await page.eval(`toggleSource(true)`);
    await page.waitFor(`SRC.on && SRC.name`, 4000, 'the source view');
    await page.eval(`openSourceFile('sections/body.tex')`);
    await page.waitFor(`SRC.name === 'sections/body.tex'`, 4000, 'body.tex');
  }
  const log = [];
  for (let i = 0; i < STEPS; i++) {
    try {
      await step(page, r, view, log);
      checkState(await page.eval(view === 'paper' ? PAPER_STATE : SRC_STATE), `step ${i}`);
      if (page.errors.length) throw new Error('script error: ' + page.errors.join('\n'));
      if (page.consoleErrors.length) throw new Error('console error: ' + page.consoleErrors.join('\n'));
    } catch (e) {
      throw new Error(`${view}, seed ${seed}, step ${i}: ${e.message}\n  steps: ${log.slice(-12).join(' | ')}`);
    }
  }
  await page.key('Escape');
  if (view === 'source') { await page.eval('flushSource(); toggleSource(false)'); }
  await page.save();
  await page.eval('load(true)');
  await sleep(200);
  const bad = await page.eval(`ORDER.filter((s) => s.edit && !s.removed && segSource(s, []) !== s.src).map((s) => s.file + ': ' + s.src.slice(0, 60))`);
  if (bad.length) throw new Error(`${view}, seed ${seed}: blocks that do not read back: ${bad.join('; ')}\n  steps: ${log.join(' | ')}`);
}

const seeds = ONLY || Array.from({ length: SEEDS }, (_, i) => i + 1);
for (const view of ['paper', 'source']) {
  E.TESTS[`mc torture: ${view}`] = async (env, page) => { for (const s of seeds) await run(env, page, s, view); };
}
process.argv = [process.argv[0], process.argv[1], 'mc torture'];
// MC_ELECTRON=1: in the Electron window (tests/electron_test.js) instead of headless Chrome
(process.env.MC_ELECTRON ? require('./electron_test.js').main() : E.main()).catch((e) => { console.error(e); process.exit(2); });
