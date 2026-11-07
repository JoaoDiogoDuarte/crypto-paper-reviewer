// Round trip: parsing and serializing a file must give it back byte for byte,
// for segments, tokens, headings, captions and code; and the house rules
// must leave existing text alone.
//
//   node tests/roundtrip.js paper/ other.tex ...     (files or directories)
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('../static/latex.js');

function texFiles(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return p.endsWith('.tex') ? [p] : [];
  return fs.readdirSync(p).flatMap((f) => (f.startsWith('.') || f === 'node_modules' ? [] : texFiles(path.join(p, f))));
}

const args = process.argv.slice(2);
if (!args.length) { console.log('usage: node tests/roundtrip.js FILE_OR_DIR...'); process.exit(2); }
const files = args.flatMap(texFiles);
let failures = 0, blocks = 0, ruleChanges = 0;
const fail = (msg) => { failures++; if (failures <= 20) console.log('FAIL ' + msg); };

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const segs = L.segment(text);
  if (L.serializeSegments(segs) !== text) fail(`${f}: segments do not rebuild the file`);
  for (const seg of segs) {
    if (seg.kind === 'code') {
      const c = L.splitCode(seg.src);
      if (c.pre + c.body + c.post !== seg.src) fail(`${f}: code split`);
    }
    if (seg.kind === 'heading') {
      const h = L.headingParts(seg.src);
      if (h && h.prefix + h.title + h.suffix !== seg.src) fail(`${f}: heading split`);
    }
    if (seg.kind === 'figure' || seg.kind === 'table') {
      const c = L.captionParts(seg.src);
      if (c && c.prefix + c.caption + c.suffix !== seg.src) fail(`${f}: caption split`);
    }
    if (seg.kind !== 'para' && seg.kind !== 'heading') continue;
    blocks++;
    const toks = L.tokenize(seg.src);
    if (L.serializeTokens(toks) !== seg.src) fail(`${f}: tokens: ${JSON.stringify(seg.src.slice(0, 80))}`);
    const walk = (ts) => ts.forEach((t) => {
      if (t.t === 'text' && L.encodeText(L.decodeText(t.s)) !== t.s) fail(`${f}: text re-encode: ${JSON.stringify(t.s.slice(0, 60))}`);
      if (t.children) walk(t.children);
    });
    walk(toks);
    if (seg.kind === 'para' && L.houseRules(seg.src)[0] !== seg.src) ruleChanges++;
  }
}

const [fixed] = L.houseRules('see Section \\ref{sec:x} and \\cite{A}.');
if (fixed !== 'see Section~\\ref{sec:x} and~\\cite{A}.') fail('house rules: ' + fixed);

console.log(`${files.length} files, ${blocks} paragraphs and headings; ` +
  `house rules would change ${ruleChanges} existing paragraphs`);
console.log(failures ? `${failures} FAILURES` : 'round trip OK');
process.exit(failures ? 1 : 0);
