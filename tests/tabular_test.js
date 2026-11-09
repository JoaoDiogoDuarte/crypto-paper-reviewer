// Table cells: what must stay one cell, and byte-exact round trips.
//   node tests/tabular_test.js
const L = require('../static/latex.js');
const assert = require('assert');

const cases = [
  [String.raw`\begin{tabular}{lll}
a & \verb|x&y| & c \\
\end{tabular}`, [['a', '\\verb|x&y|', 'c'], []]],
  [String.raw`\begin{tabular}{ll}
\begin{tabular}{@{}c@{}}in\\ner\end{tabular} & b \\
\end{tabular}`, [['\\begin{tabular}{@{}c@{}}in\\\\ner\\end{tabular}', 'b'], []]],
  [String.raw`\begin{tabular}{ll}
a & b % c & d \\ e
\\
\end{tabular}`, [['a', 'b % c & d \\\\ e'], []]],
  [String.raw`\begin{tabular}{|l|c|}
\hline
\multicolumn{2}{|c|}{Head} \\ \cline{1-2}
{\small a \\ b} & 100\% \\
\end{tabular}`, [['\\multicolumn{2}{|c|}{Head}'], ['{\\small a \\\\ b}', '100\\%'], []]],
  [String.raw`\begin{tabular}{ll}
x & \verb+a\\b+ \\
\end{tabular}`, [['x', '\\verb+a\\\\b+'], []]],
];

let n = 0;
for (const [src, want] of cases) {
  const [t] = L.parseTabulars(src);
  assert.deepStrictEqual(t.rows.map((r) => r.cells.map((c) => c.content)), want, src);
  assert.strictEqual(src.slice(0, t.bodyStart) + L.tabularBody(t) + src.slice(t.bodyEnd), src, 'round trip: ' + src);
  n++;
}
console.log(`tabular: ${n} cases passed`);
