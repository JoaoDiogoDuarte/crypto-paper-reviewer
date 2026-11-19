#!/usr/bin/env node
// One sentence per line (house_rules.one_sentence_per_line): where the
// splitter breaks a line and where it must not, and that it changes nothing
// but spaces.  Run: node tests/sentences.js
'use strict';
const assert = require('node:assert/strict');
const L = require('../static/latex.js');

const split = (text, original) => L.splitSentences(text, original, {});
let failed = 0, passed = 0;
function check(what, got, want) {
  try { assert.equal(got, want); passed++; } catch (e) {
    failed++;
    console.log(`FAIL ${what}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
  }
}

// [input, output]: a line that changes
const SPLIT = [
  ['One. Two.', 'One.\nTwo.'],
  ['One! Two? Three.', 'One!\nTwo?\nThree.'],
  ['Let $x$ be fixed. Then $y$ follows.', 'Let $x$ be fixed.\nThen $y$ follows.'],
  ['as in~\\cite{a}. Then', 'as in~\\cite{a}.\nThen'],
  ['Done.\'\' Then', 'Done.\'\'\nThen'],
  ['(see the lemma.) Then', '(see the lemma.)\nThen'],
  ['\\emph{One. Two.} Three.', '\\emph{One.\nTwo.}\nThree.'],
  ['It holds. \\Cref{thm:a} shows it.', 'It holds.\n\\Cref{thm:a} shows it.'],
  ['It holds. \\emph{This} is it.', 'It holds.\n\\emph{This} is it.'],
  ['so on\\dots. Then', 'so on\\dots.\nThen'],
  ['wait.... Then', 'wait....\nThen'],
  ['It is PKE. Then', 'It is PKE.\nThen'],
  ['A X\\@. Then', 'A X\\@.\nThen'],
  ['One.  Two.', 'One.\nTwo.'],
  ['  \\item One. Two.', '  \\item One.\n  Two.'],
  ['One. ``Two.\'\'', 'One.\n``Two.\'\''],
  ['One. (Two.)', 'One.\n(Two.)'],
  ['{\\raggedright One. Two.}', '{\\raggedright One.\nTwo.}'],
  ['\\begin{itemize}\n\\item One. Two.\n\\end{itemize}', '\\begin{itemize}\n\\item One.\nTwo.\n\\end{itemize}'],
  ['Its id. The', 'Its id.\nThe'],
  ['A. B. One. Two.', 'A. B. One.\nTwo.'],
  ['\\begin{lemma}A. B.\\end{lemma}', '\\begin{lemma}A.\nB.\\end{lemma}'],
];

// lines that stay as they are
const KEEP = [
  '$x. Y$ and $a. B$',
  '\\(x. Y\\)',
  'e.g. Smith', 'e.g.\\ Smith', 'e.g. \\cite{a}', 'eg. Smith', 'e. g. Smith', 'E.g. Smith',
  'i.e. The', 'ie. The', 'i. e. The',
  'cf. Lemma 1', 'c.f. Lemma 1', 'Cf. Lemma 1',
  'and so on, etc. The', 'e.t.c. The', 'ect. The',
  'Bellare et al. Show', 'Bellare et. al. Show', 'Bellare et.al. Show', 'Bellare etal. Show',
  'A vs. B', 'A v.s. B', 'resp. The', 'viz. The', 'N.B. The', 'n.b. The', 'ca. The', 'approx. The',
  'ibid. The', 'op. cit. The', 'loc. cit. The',
  'w.r.t. The', 'wrt. The', 'w.l.o.g. We', 'wlog. We', 'w.h.p. The', 'whp. The', 'i.i.d. Samples', 'iid. Samples', 'u.a.r. The',
  'Fig.~\\ref{f}', 'Fig. \\ref{f}', 'Fig. 3', 'see Fig. A', 'Sec. A', 'Sect. B', 'Eq. A', 'Thm. A', 'Def. A', 'Lem. A',
  'Prop. A', 'Cor. A', 'App. A', 'Ch. A', 'Tab. A', 'Alg. A', 'Hyb. A', 'Exp. A',
  'No. A', 'Vol. A', 'pp. A', 'Proc. A', 'Conf. A', 'Univ. A', 'Dept. A', 'Tech. Rep. A',
  'Dr. Smith', 'Prof. Smith', 'Mr. Smith', 'Mrs. Smith', 'Ms. Smith', 'St. Andrews', 'Jr. And',
  'Jan. The', 'Sept. The', 'Dec. The', 'a.k.a. The', 'aka. The',
  'J. Smith', 'D. J. Bernstein', '(J. Smith)',
  '3.2 Then', 'v1.0 Then', 'ePrint 2024/123. then',
  'wait... Then', 'wait.. Then', 'and \\dots Then', 'and … Then',
  'One.~Two', 'One.\\ Two',
  'One. two', 'One. $x$ is', 'One. 3 is',
  '% A comment. With two.',
  'text % A comment. With two.',
  '\\verb|a. B|', '\\url{a. B}', '\\texttt{a. B}', '\\footnote{One. Two.}',
  '\\begin{tabular}{l}A. B\\end{tabular}',
  '\\begin{tikzpicture}A. B\\end{tikzpicture}',
  '\\[ x. Y \\]',
  '\\begin{equation}x. Y\\end{equation}',
];

for (const [input, want] of SPLIT) check(`split ${JSON.stringify(input)}`, split(input), want);
for (const input of KEEP) check(`keep ${JSON.stringify(input)}`, split(input), input);

// only the changed lines: an untouched line keeps two sentences
check('untouched line', split('Old one. Old two.\nNew one. New two.', 'Old one. Old two.\nNew.'),
  'Old one. Old two.\nNew one.\nNew two.');
check('every line untouched', split('Aa. Bb.\nCc. Dd.', 'Aa. Bb.\nCc. Dd.'), 'Aa. Bb.\nCc. Dd.');
check('a moved line is not changed', split('Cc. Dd.\nAa. Bb.', 'Aa. Bb.\nCc. Dd.'), 'Cc. Dd.\nAa. Bb.');
check('a new block has every line changed', split('One. Two.'), 'One.\nTwo.');
// the same line twice in the text, once in the original: the second is new
check('a line copied', split('Aa. Bb.\nAa. Bb.', 'Aa. Bb.'), 'Aa. Bb.\nAa.\nBb.');
// abbreviations of the paper's own
check('house_rules.abbreviations', L.splitSentences('Constr. A', undefined, { abbreviations: ['Constr.'] }), 'Constr. A');

// misspelt forms: named, never changed
const bad = (text, original) => L.misspeltAbbreviations(text, original).join('; ');
check('misspelt c.f.', bad('see c.f. Lemma 1 and eg. that'), 'c.f. (cf.); eg. (e.g.)');
check('misspelt et. al.', bad('Bellare et. al. show'), 'et. al. (et al.)');
check('misspelt bare e.g', bad('e.g, the case'), 'e.g (e.g.)');
check('correct forms', bad('e.g. and i.e. and cf. and etc. and et al. and w.r.t. and Ex. and Conf.'), '');
check('misspelt in maths', bad('$c.f. x$ and \\verb|eg.|'), '');
check('misspelt on an untouched line', bad('c.f. A\nnew', 'c.f. A'), '');
check('houseRules warns', L.houseRules('see c.f. Lemma. Then', { one_sentence_per_line: true })[1].join(),
  'check c.f. (cf.)');
check('houseRules splits', L.houseRules('One. Two.', { one_sentence_per_line: true })[0], 'One.\nTwo.');
check('houseRules off', L.houseRules('One. Two.', { one_sentence_per_line: false })[0], 'One. Two.');

// the splitter changes spaces only: a fuzz over sentence pieces
const PIECES = ['One.', 'two', 'Three!', 'e.g.', 'J.', '$x. Y$', '\\cite{a}.', 'et al.', '~', '\\emph{A. B.}', '...',
  'Fig.', '(C.)', '``D.\'\'', '\\dots.', 'c.f.', '\\Cref{x}', '%c. D', '\\verb|a. B|', '{E. F.}', 'G?', '\\item', 'Mr.'];
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let k = 0; k < 3000; k++) {
  const n = 2 + rnd(8);
  const parts = [];
  for (let j = 0; j < n; j++) parts.push(PIECES[rnd(PIECES.length)]);
  let text = parts.join([' ', '  ', ' '][rnd(3)]);
  if (text.includes('%')) text += '\nAfter. Line.';
  const out = split(text);
  const squash = (t) => t.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]+/g, ' ');
  if (squash(out) !== squash(text) || /\n[ \t]*\n/.test(out) && !/\n[ \t]*\n/.test(text)) {
    check(`fuzz ${JSON.stringify(text)}`, out, '(only spaces changed)');
    break;
  }
  // a comment never swallows text: no split may land inside a comment
  for (const line of out.split('\n')) {
    const c = line.indexOf('%');
    if (c >= 0 && !text.includes(line.slice(c))) { check(`fuzz comment ${JSON.stringify(text)}`, out, text); break; }
  }
  passed++;
}

console.log(`sentences: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
