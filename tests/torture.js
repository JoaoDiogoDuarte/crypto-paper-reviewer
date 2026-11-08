#!/usr/bin/env node
// Deterministic, dependency-free parser torture. No manuscript is modified.
// node tests/torture.js --seeds=1,7,42 --cases=500
// TORTURE_SEEDS=9 TORTURE_CASES=10000 node tests/torture.js
'use strict';

const assert = require('node:assert/strict');
const L = require('../static/latex.js');
const option = (key, fallback) => {
  const found = process.argv.find((a) => a.startsWith('--' + key + '='));
  return found ? found.slice(key.length + 3) : fallback;
};
const seeds = option('seeds', process.env.TORTURE_SEEDS || '1,7,42').split(',').map(Number);
const cases = Number(option('cases', process.env.TORTURE_CASES || '500'));
if (!seeds.length || seeds.some((s) => !Number.isSafeInteger(s) || s < 0) ||
    !Number.isSafeInteger(cases) || cases < 1 || cases > 100000) {
  console.error('Usage: node tests/torture.js --seeds=1,7 --cases=500 (max 100000)');
  process.exit(2);
}
function rng(seed) {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
  return { int: (n) => Math.floor(next() * n),
    pick: (a) => a[Math.floor(next() * a.length)] };
}
const FRAGMENTS = [
  'The quick brown fox. ', '  multiple   spaces ', '\n', '\r\n', '\t', '\n\n',
  'João Diogo Duarte. ', 'Fundação para a Ciência e a Tecnologia. ',
  'é à ç ã ê ñ ű ḱ 𝒜 β γ 😀 ', '100\\% of R\\&D and A\\_B. ',
  'a~\\cite{A,B} and \\cref{thm:one} ', '\\protect\\url{https://doi.org/10.54499/UID/50014/2025}',
  '\\c{c}\\~ao e Ci\\^encia ', '\\~ao \\^encia \\c c ',
  "\\'e and \\\"o and \\\"{o} ",
  '\\emph{soft \\textbf{nested}} ', '\\textit{a {b} c} ',
  '\\section{A heading}\\label{sec:a}\n', '\\subsection{Another heading}\n',
  '\\begin{proof}A proof.\\end{proof}', '\\begin{lemma}[Useful]Claim.\\end{lemma}',
  '$a_{b} + \\frac{1}{N}$ ', '$$\\sum_{i=1}^n i$$',
  '\\begin{multline*}a=b\\\\c=d\\end{multline*}',
  '\\begin{align*}x&=y\\\\z&=w\\end{align*}',
  '\\begin{tabular}{lcr}A & $x^2$ & C\\\\\\midrule B & D & E\\end{tabular}',
  '% a line with \\begin{figure} ignored\n', '\\verb|code \\latex {literal}| ',
  '\\\\', '{outer {inner}}', '#', '_', '^', '$', '{', '}', '\\begin{figure}',
  '\\end{figure}', '\\ifanon Anonymous \\else Named \\fi ',
  '\\begin{lstlisting}\n\\textbf{raw $code$}\n\\end{lstlisting}',
  '\\input{sections/body}', '\\bibliography{refs}',
  '\\newcommand{\\X}[1]{\\operatorname{X}(#1)}',
];
const DOCUMENTS = [
  '\\documentclass{article}\n\\begin{document}\nFunda\\c{c}\\~ao e Ci\\^encia.\\protect\\url{https://example.org/doi}\n\\end{document}',
  '\\documentclass{IEEEtran}\n\\begin{document}\n\\section{Hello}\nText\n\\begin{figure}\n\\begin{gameenv}{G}\n\\State $x \\gets y$\n\\While{$b$}\n\\State $x \\gets x+1$\n\\EndWhile\n\\end{gameenv}\n\\caption{Game}\n\\end{figure}\n\\end{document}',
  '\\begin{table}[t]\n\\begin{tabular}{lr}\nOne & $x$\\\\\n\\midrule\nTwo & $y$\\\\\n\\end{tabular}\n\\caption{Data}\n\\end{table}',
  '\\documentclass{article}\n\\begin{document}\n\\begin{figure*}\n\\centering\\fbox{wide}\n\\caption{wide}\n\\end{figure*}\n\\end{document}',
  '\\begin{figure}\n\\procedure{A}{$x$\\\\ \\pcreturn $x$}\n\\end{figure}',
];
function checkTokens(tokens) {
  for (const tok of tokens) {
    if (tok.t === 'text') assert.equal(L.encodeText(L.decodeText(tok.s)), tok.s, 'text encoding');
    if (tok.children) checkTokens(tok.children);
  }
}
function verify(src) {
  const toks = L.tokenize(src);
  assert.equal(L.serializeTokens(toks), src, 'token round-trip');
  checkTokens(toks);
  const segs = L.segment(src);
  assert.equal(L.serializeSegments(segs), src, 'segment round-trip');
  for (const seg of segs) {
    if (seg.kind === 'para' || seg.kind === 'heading') {
      const t = L.tokenize(seg.src);
      assert.equal(L.serializeTokens(t), seg.src, 'segment token round-trip');
      checkTokens(t);
    }
    if (seg.kind === 'code') {
      const c = L.splitCode(seg.src);
      assert.equal(c.pre + c.body + c.post, seg.src, 'code round-trip');
    }
    if (seg.kind === 'heading') {
      const h = L.headingParts(seg.src);
      if (h) assert.equal(h.prefix + h.title + h.suffix, seg.src, 'heading round-trip');
    }
    if (seg.kind === 'figure' || seg.kind === 'table') {
      const cap = L.captionParts(seg.src);
      if (cap) assert.equal(cap.prefix + cap.caption + cap.suffix, seg.src, 'caption round-trip');
      let rebuilt = seg.src;
      for (const g of [...L.parseGames(seg.src)].reverse()) {
        const body = g.kind === 'proc'
          ? g.lines.map(L.gameLineSrc).join('')
          : g.lines.map(L.gameLineSrc).join('\n');
        rebuilt = rebuilt.slice(0, g.bodyStart) + body + rebuilt.slice(g.bodyEnd);
      }
      assert.equal(rebuilt, seg.src, 'game round-trip');
      for (const t of L.parseTabulars(seg.src))
        assert.equal(L.tabularBody(t), seg.src.slice(t.bodyStart, t.bodyEnd), 'tabular round-trip');
    }
  }
}
let total = 0;
for (const seed of seeds) {
  const R = rng(seed);
  for (let index = 0; index < cases; index++) {
    let src = index % 9 === 0 ? R.pick(DOCUMENTS) : '';
    if (!src) for (let n = 1 + R.int(35); n > 0; n--) src += R.pick(FRAGMENTS);
    // Incomplete edits are normal while a user is typing a LaTeX command.
    if (index % 13 === 0 && src.length) src = src.slice(0, R.int(src.length));
    if (index % 17 === 0) src += R.pick(FRAGMENTS);
    try { verify(src); total++; }
    catch (error) {
      console.error('TORTURE FAIL seed=' + seed + ' case=' + index);
      console.error('source=' + JSON.stringify(src));
      console.error(error.stack || error);
      process.exit(1);
    }
  }
  console.log('ok seed=' + seed + ' cases=' + cases);
}
console.log('torture: ' + total + ' parser/serialization properties passed');
