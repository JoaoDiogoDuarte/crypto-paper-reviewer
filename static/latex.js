// Parsing and serialization of the paper's LaTeX for the reading editor.
//
// Every segment and every token keeps its exact source text, so that
// serialize(parse(text)) === text for any file, and saving a paragraph that
// was not edited writes back exactly what was read.  Shared by the browser
// (global LatexDoc) and the Node round-trip test (module.exports).
(function (root) {
  'use strict';

  const MATH_ENVS = new Set(['align', 'align*', 'equation', 'equation*', 'gather', 'gather*',
    'multline', 'multline*', 'eqnarray', 'eqnarray*', 'displaymath']);
  const THM_ENVS = new Set(['theorem', 'lemma', 'corollary', 'definition', 'proposition']);
  const VERBATIM_ENVS = new Set(['lstlisting', 'verbatim', 'tikzpicture', 'games', 'algorithmic',
    'tabular', 'tabular*']);
  const FMT_CMDS = new Set(['emph', 'textbf', 'textit', 'paragraph']);
  const TEXT_ESCAPES = '%&_#${}';

  // ------------------------------------------------------------------ helpers

  // Index just past the group that opens at s[i] ('{' or '['), or -1.
  function groupEnd(s, i) {
    const open = s[i];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let k = i; k < s.length; k++) {
      const c = s[k];
      if (c === '\\') { k++; continue; }
      if (c === '%') { const e = s.indexOf('\n', k); if (e < 0) return -1; k = e; continue; }
      if (open === '[' && c === '{') { const e = groupEnd(s, k); if (e < 0) return -1; k = e - 1; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return k + 1;
    }
    return -1;
  }

  // Index just past the \end{name} that closes the \begin{name} at s[i].
  function envEnd(s, i, name) {
    const esc = name.replace(/[*]/g, '\\*');
    const re = new RegExp('\\\\(begin|end)\\{' + esc + '\\}', 'g');
    re.lastIndex = i;
    let depth = 0, m;
    while ((m = re.exec(s))) {
      if (inComment(s, m.index)) continue;
      depth += m[1] === 'begin' ? 1 : -1;
      if (depth === 0) return m.index + m[0].length;
    }
    return -1;
  }

  // True when position p lies after an unescaped % on its line.
  function inComment(s, p) {
    const lineStart = s.lastIndexOf('\n', p - 1) + 1;
    for (let k = lineStart; k < p; k++) {
      if (s[k] === '\\') { k++; continue; }
      if (s[k] === '%') return true;
    }
    return false;
  }

  // Decoding and encoding of plain text tokens.  A text token contains no
  // backslash other than the escapes below, and none of the characters that
  // the tokenizer turns into tokens, so encode(decode(s)) === s.
  function decodeText(s) { return s.replace(/\\([%&_#${}])/g, '$1'); }
  function encodeText(t) {
    return t.replace(/\u00a0/g, ' ').replace(/\\/g, '\\textbackslash{}')
      .replace(/[%&_#${}]/g, '\\$&').replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}');
  }

  // ---------------------------------------------------------------- tokenizer

  // Tokens: text, nl (a line break and the indentation after it), tie (~),
  // comment, math {display}, env {mode: begin|end, env, opt}, fmt {name,
  // prefix, children}, cmd {name}, group {children}.  Each has .s, its
  // source, except fmt and group, which are rebuilt from their children.
  function tokenize(s) {
    const out = [];
    let i = 0, buf = '';
    const flush = () => { if (buf) { out.push({ t: 'text', s: buf }); buf = ''; } };
    const push = (tok) => { flush(); out.push(tok); };

    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        if (n === undefined) { push({ t: 'cmd', name: '', s: c }); i++; continue; }
        if (TEXT_ESCAPES.includes(n)) { buf += c + n; i += 2; continue; }
        if (n === '(' || n === '[') {
          const closer = n === '(' ? '\\)' : '\\]';
          const e = s.indexOf(closer, i + 2);
          const end = e < 0 ? s.length : e + 2;
          push({ t: 'math', display: n === '[', s: s.slice(i, end) });
          i = end; continue;
        }
        if (/[A-Za-z@]/.test(n)) {
          let k = i + 1;
          while (k < s.length && /[A-Za-z@]/.test(s[k])) k++;
          const name = s.slice(i + 1, k);
          if ((name === 'begin' || name === 'end') && s[k] === '{') {
            const ge = groupEnd(s, k);
            const env = s.slice(k + 1, ge - 1);
            if (name === 'begin' && (MATH_ENVS.has(env) || VERBATIM_ENVS.has(env))) {
              const ee = envEnd(s, i, env);
              const end = ee < 0 ? s.length : ee;
              push(MATH_ENVS.has(env) ? { t: 'math', display: true, s: s.slice(i, end) }
                : { t: 'cmd', name: 'verbatim', env, s: s.slice(i, end) });
              i = end; continue;
            }
            let end = ge, opt = null;
            if (name === 'begin' && s[end] === '[') {
              const oe = groupEnd(s, end);
              if (oe > 0) { opt = s.slice(end + 1, oe - 1); end = oe; }
            }
            push({ t: 'env', mode: name, env, opt, s: s.slice(i, end) });
            i = end; continue;
          }
          if (FMT_CMDS.has(name)) {
            let k2 = k;
            while (s[k2] === ' ') k2++;
            if (s[k2] === '{') {
              const ge = groupEnd(s, k2);
              if (ge > 0) {
                push({ t: 'fmt', name, prefix: s.slice(i, k2 + 1), children: tokenize(s.slice(k2 + 1, ge - 1)) });
                i = ge; continue;
              }
            }
          }
          // a generic command: name, optional star, then every group that
          // follows immediately (without spaces)
          let end = k;
          if (s[end] === '*') end++;
          while (s[end] === '{' || s[end] === '[') {
            const ge = groupEnd(s, end);
            if (ge < 0) break;
            end = ge;
          }
          push({ t: 'cmd', name, s: s.slice(i, end) });
          i = end; continue;
        }
        // a control symbol: \\, \,, \ , \; ...
        let end = i + 2;
        if (n === '\\' && s[end] === '[') { const ge = groupEnd(s, end); if (ge > 0) end = ge; }
        push({ t: 'cmd', name: n, s: s.slice(i, end) });
        i = end; continue;
      }
      if (c === '$') {
        const dbl = s[i + 1] === '$';
        // the closing $ is at brace depth 0: a $ inside \text{...} opens
        // a nested formula, as in $\Pr[\text{bad at $t$}]$
        let k = i + (dbl ? 2 : 1), depth = 0;
        while (k < s.length) {
          if (s[k] === '\\') { k += 2; continue; }
          if (s[k] === '{') depth++;
          else if (s[k] === '}') depth--;
          else if (s[k] === '$' && depth <= 0) break;
          k++;
        }
        const end = Math.min(s.length, k + (dbl ? 2 : 1));
        push({ t: 'math', display: dbl, s: s.slice(i, end) });
        i = end; continue;
      }
      if (c === '%') {
        let e = s.indexOf('\n', i);
        if (e < 0) e = s.length;
        push({ t: 'comment', s: s.slice(i, e) });
        i = e; continue;
      }
      if (c === '~') { push({ t: 'tie', s: '~' }); i++; continue; }
      if (c === '\n') {
        let k = i + 1;
        while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
        push({ t: 'nl', s: s.slice(i, k) });
        i = k; continue;
      }
      if (c === '{') {
        const ge = groupEnd(s, i);
        if (ge > 0) { push({ t: 'group', children: tokenize(s.slice(i + 1, ge - 1)) }); i = ge; continue; }
        push({ t: 'cmd', name: '{', s: c }); i++; continue;
      }
      if ('}^_&#'.includes(c)) { push({ t: 'cmd', name: c, s: c }); i++; continue; }
      buf += c; i++;
    }
    flush();
    return out;
  }

  function serializeTokens(tokens) {
    let out = '';
    for (const tok of tokens) {
      if (tok.t === 'fmt') out += tok.prefix + serializeTokens(tok.children) + '}';
      else if (tok.t === 'group') out += '{' + serializeTokens(tok.children) + '}';
      else out += tok.s;
    }
    return out;
  }

  // ----------------------------------------------------------------- segments

  // Segments: para (editable text), heading, code (a listing, optionally in
  // ecblock), figure, table, gap (the blank lines between, kept verbatim).
  // Code environments are shown as editable boxes; the list can be extended
  // per paper (setCodeEnvs), e.g. with a wrapper environment around listings.
  let CODE_ENVS = ['lstlisting', 'minted', 'verbatim', 'Verbatim', 'ecblock'];
  let BLOCK_RE;
  function buildBlockRe() {
    const code = CODE_ENVS.map((e) => e.replace(/[*]/g, '\\*')).join('|');
    BLOCK_RE = new RegExp('\\\\begin\\{(figure\\*?|table\\*?|' + code + ')\\}|' +
      '\\\\(part|chapter|section|subsection|subsubsection)\\*?(?=[\\[{])', 'g');
  }
  buildBlockRe();
  function setCodeEnvs(envs) { CODE_ENVS = [...new Set([...CODE_ENVS, ...(envs || [])])]; buildBlockRe(); }

  function segment(text) {
    const segs = [];
    let i = 0, m;
    BLOCK_RE.lastIndex = 0;
    while ((m = BLOCK_RE.exec(text))) {
      if (inComment(text, m.index)) continue;
      // a block starts at the beginning of its line
      const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
      if (text.slice(lineStart, m.index).trim() !== '') continue;
      let end;
      let kind;
      if (m[1]) {
        end = envEnd(text, m.index, m[1]);
        if (end < 0) continue;
        kind = m[1].startsWith('figure') ? 'figure' : m[1].startsWith('table') ? 'table' : 'code';
      } else {
        let k = m.index + 1 + m[2].length;
        if (text[k] === '*') k++;
        while (text[k] === '[' || text[k] === '{') { const ge = groupEnd(text, k); if (ge < 0) break; k = ge; }
        const lab = /^[ \t]*\\label\{[^}]*\}/.exec(text.slice(k));
        end = k + (lab ? lab[0].length : 0);
        kind = 'heading';
      }
      splitParas(text.slice(i, lineStart), segs);
      segs.push({ kind, src: text.slice(lineStart, end) });
      i = end;
      BLOCK_RE.lastIndex = end;
    }
    splitParas(text.slice(i), segs);
    return segs;
  }

  function splitParas(text, segs) {
    if (!text) return;
    const re = /\n[ \t]*\n\s*/g;
    let i = 0, m;
    const lead = /^\s*/.exec(text)[0];
    if (lead) { segs.push({ kind: 'gap', src: lead }); i = lead.length; }
    re.lastIndex = i;
    while ((m = re.exec(text))) {
      if (m.index > i) segs.push(paraSeg(text.slice(i, m.index)));
      segs.push({ kind: 'gap', src: m[0] });
      i = m.index + m[0].length;
    }
    if (i < text.length) {
      const rest = text.slice(i);
      const body = rest.replace(/\s+$/, '');
      if (body) segs.push(paraSeg(body));
      if (body.length < rest.length) segs.push({ kind: 'gap', src: rest.slice(body.length) });
    }
  }

  function paraSeg(src) {
    const lines = src.split('\n').filter((l) => l.trim());
    const allComment = lines.every((l) => /^\s*%/.test(l));
    return { kind: allComment ? 'gap' : 'para', src };
  }

  function serializeSegments(segs) { return segs.map((s) => s.src).join(''); }

  // Split a code segment into the part before the listing body, the body
  // and the part after, so that only the body is shown for editing.
  function splitCode(src) {
    // the innermost verbatim-like environment holds the code; a wrapper
    // environment around it stays in pre and post
    const m = /^([\s\S]*\\begin\{(lstlisting|minted|verbatim|Verbatim)\}(?:\[[^\]]*\])?(?:\{[^}]*\})?\n?)([\s\S]*?)(\\end\{\2\}[\s\S]*)$/.exec(src);
    return m ? { pre: m[1], body: m[3], post: m[4] } : { pre: '', body: src, post: '' };
  }

  // The \input order of main.tex: returns pieces of main.tex text (with
  // their offsets) interleaved with the names of the files it inputs.
  function documentPieces(mainText) {
    const pieces = [];
    const re = /\\(?:input|include|subfile)\s*\{([^}]*)\}/g;
    let i = 0, m;
    while ((m = re.exec(mainText))) {
      if (inComment(mainText, m.index)) continue;
      pieces.push({ text: mainText.slice(i, m.index) });
      pieces.push({ text: m[0], input: m[1].trim() });
      i = m.index + m[0].length;
    }
    pieces.push({ text: mainText.slice(i) });
    return pieces;
  }

  // House formatting for an edited paragraph: a tie before \cite and \ref,
  // as everywhere in the paper.  Returns [text, warnings].
  function houseRules(text, rules) {
    rules = rules || { tie_before: ['cite', 'ref'], flag_bracketed_cref: true };
    const warnings = [];
    if (rules.tie_before && rules.tie_before.length) {
      const cmds = rules.tie_before.map((c) => c.replace(/[^A-Za-z]/g, '')).join('|');
      text = text.replace(new RegExp('([A-Za-z0-9.]) +\\\\(' + cmds + ')\\{', 'g'), '$1~\\$2{');
    }
    if (rules.flag_bracketed_cref && /\(\s*\\[cC]ref\{/.test(text)) warnings.push('bracketed \\cref: refer in prose instead');
    if (/  +/.test(text.replace(/\n[ \t]*/g, '\n'))) {
      text = text.replace(/([^\n ]) {2,}/g, '$1 ');
    }
    return [text, warnings];
  }

  // The title of a heading segment: prefix (up to and including the brace
  // that opens the title), title source and the rest (closing brace, label).
  function headingParts(src) {
    const m = /^\\(part|chapter|section|subsection|subsubsection)(\*?)(\[[^\]]*\])?\{/.exec(src);
    if (!m) return null;
    const open = m[0].length - 1;
    const end = groupEnd(src, open);
    if (end < 0) return null;
    return { level: m[1], star: m[2], prefix: src.slice(0, open + 1),
      title: src.slice(open + 1, end - 1), suffix: src.slice(end - 1) };
  }

  // The caption of a figure or table segment, split the same way.
  function captionParts(src) {
    const re = /\\caption(\[[^\]]*\])?\{/g;
    let m;
    while ((m = re.exec(src))) {
      if (inComment(src, m.index)) continue;
      const open = m.index + m[0].length - 1;
      const end = groupEnd(src, open);
      if (end < 0) return null;
      return { prefix: src.slice(0, open + 1), caption: src.slice(open + 1, end - 1), suffix: src.slice(end - 1) };
    }
    return null;
  }

  // Typography for text typed into the editor (never produced by decoding
  // the source, so the round trip is unaffected).
  function typeset(t) {
    return t.replace(/\u2014/g, '---').replace(/\u2013/g, '--')
      .replace(/\u201c/g, '``').replace(/\u201d/g, "''")
      .replace(/\u2018/g, '`').replace(/\u2019/g, "'").replace(/\u2026/g, '\\dots{}');
  }

  const api = { tokenize, serializeTokens, segment, serializeSegments, splitCode, documentPieces,
    decodeText, encodeText, houseRules, headingParts, captionParts, typeset, setCodeEnvs, groupEnd, envEnd, inComment, THM_ENVS, MATH_ENVS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LatexDoc = api;
})(this);
