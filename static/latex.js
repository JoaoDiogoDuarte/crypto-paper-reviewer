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
    'tabular', 'tabular*', 'tabularx']);
  const FMT_CMDS = new Set(['emph', 'textbf', 'textit', 'paragraph']);
  const TEXT_ESCAPES = '%&_#${}';
  // TeX accent commands accept either a braced argument (\\~{a}) or a single
  // unbraced character (\\~ao means an accented 'a' followed by 'o').
  // Keep the accent and its argument together so a preview chip retains the
  // original bytes when neighbouring prose is edited.
  const SYMBOL_ACCENTS = new Set(["'", '`', '"', '^', '~', '=', '.']);
  const WORD_ACCENTS = new Set(['c', 'u', 'v', 'H', 'r', 'k']);
  const ACCENT_LETTER = /[A-Za-zÀ-ÿ]/;


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
  // one pass, so that an escape is never escaped again
  const ENC = { '%': '\\%', '&': '\\&', '_': '\\_', '#': '\\#', '$': '\\$', '{': '\\{', '}': '\\}',
    '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '\u00a0': ' ',
    // pdfLaTeX/OT1 prints raw < and > as ¡ and ¿: escape them so they print as
    // themselves.  A raw " is fine: OT1 prints it as ”, T1 as "
    '<': '\\textless{}', '>': '\\textgreater{}' };
  function encodeText(t) { return t.replace(/[%&_#${}\\~^\u00a0<>]/g, (c) => ENC[c]); }

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
            // A user may be halfway through typing \\begin{...}. Do not
            // move the cursor backwards (ge === -1), which loops forever.
            if (ge < 0) {
              push({ t: 'cmd', name, s: s.slice(i, k) });
              i = k; continue;
            }
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
          if ((name === 'verb' || name === 'lstinline' || name === 'mintinline') && s[k] !== '{') {
            // \verb|...|: everything up to the next delimiter is literal
            let k2 = k;
            if (s[k2] === '*') k2++;
            if (name === 'mintinline' && s[k2] === '{') k2 = groupEnd(s, k2);
            while (s[k2] === '[') { const e = groupEnd(s, k2); if (e < 0) break; k2 = e; }
            const delim = s[k2];
            const close = delim === undefined ? -1 : s.indexOf(delim, k2 + 1);
            const end = close < 0 ? s.length : close + 1;
            push({ t: 'cmd', name: 'verb', s: s.slice(i, end) });
            i = end; continue;
          }
          // Control words swallow separating spaces in TeX.  For example,
          // \\c c has the same result as \\c{c}; do not emit a raw chip.
          if (WORD_ACCENTS.has(name) && /[ \t]/.test(s[k] || '')) {
            let j = k;
            while (s[j] === ' ' || s[j] === '\t') j++;
            if (ACCENT_LETTER.test(s[j] || '')) {
              push({ t: 'cmd', name, s: s.slice(i, j + 1), accentBase: s[j] });
              i = j + 1; continue;
            }
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
            const empty = ge === end + 2 && s[end] === '{';
            end = ge;
            if (empty) break;   // \cmd{} ends the command: what follows is text
          }
          push({ t: 'cmd', name, s: s.slice(i, end) });
          i = end; continue;
        }
        // a control symbol: \\, \,, \ , \; ...
        let end = i + 2;
        if (SYMBOL_ACCENTS.has(n) && ACCENT_LETTER.test(s[end] || '')) {
          push({ t: 'cmd', name: n, s: s.slice(i, end + 1), accentBase: s[end] });
          i = end + 1; continue;
        }
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
      if (c === '\n' || (c === '\r' && s[i + 1] === '\n')) {
        // a line break (\n or \r\n) and the indentation after it
        let k = i + (c === '\r' ? 2 : 1);
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

  // Segments: para (editable text), heading, quote (a quote or quotation
  // environment, shown as a block quote), code (a listing, optionally in
  // ecblock), figure, table, gap (the blank lines between, kept verbatim).
  // Code environments are shown as editable boxes; the list can be extended
  // per paper (setCodeEnvs), e.g. with a wrapper environment around listings.
  let CODE_ENVS = ['lstlisting', 'minted', 'verbatim', 'Verbatim', 'ecblock'];
  let BLOCK_RE;
  function buildBlockRe() {
    const code = CODE_ENVS.map((e) => e.replace(/[*]/g, '\\*')).join('|');
    BLOCK_RE = new RegExp('\\\\begin\\{(figure\\*?|table\\*?|quote|quotation|' + code + ')\\}|' +
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
        kind = m[1].startsWith('figure') ? 'figure' : m[1].startsWith('table') ? 'table'
          : (m[1] === 'quote' || m[1] === 'quotation') ? 'quote' : 'code';
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
    const re = /\r?\n[ \t\r]*\n\s*/g;
    let i = 0, m;
    // blank lines inside these environments do not end a paragraph
    const keep = [];
    const envRe = /\\begin\{([A-Za-z]+\*?)\}/g;
    let em;
    while ((em = envRe.exec(text))) {
      if (!(MATH_ENVS.has(em[1]) || VERBATIM_ENVS.has(em[1]) || /^(algorithm|algorithmic|tabularx?|array|cases|minipage|center)\*?$/.test(em[1]))) continue;
      if (inComment(text, em.index)) continue;
      const e = envEnd(text, em.index, em[1]);
      if (e > 0) { keep.push([em.index, e]); envRe.lastIndex = e; }
    }
    const kept = (p) => keep.some(([a, b]) => p > a && p < b);
    const lead = /^\s*/.exec(text)[0];
    if (lead) { segs.push({ kind: 'gap', src: lead }); i = lead.length; }
    re.lastIndex = i;
    while ((m = re.exec(text))) {
      if (kept(m.index)) continue;
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
  // House rules for edited text.  With the block's original source given,
  // a match that is already there (the author's own style) is left alone.
  function houseRules(text, rules, original) {
    rules = rules || { tie_before: ['cite', 'ref'], flag_bracketed_cref: true };
    const warnings = [];
    if (rules.tie_before && rules.tie_before.length) {
      const cmds = rules.tie_before.map((c) => c.replace(/[^A-Za-z]/g, '')).join('|');
      text = text.replace(new RegExp('(\\S*[A-Za-z0-9.]) +\\\\(' + cmds + ')\\{([^}]*)\\}', 'g'),
        (all, w, cmd, arg) => (original && original.includes(all) ? all : `${w}~\\${cmd}{${arg}}`));
    }
    if (rules.flag_bracketed_cref && /\(\s*\\[cC]ref\{/.test(text)) warnings.push('bracketed \\cref: refer in prose instead');
    if (rules.one_sentence_per_line) {
      text = text.replace(/([.!?])\s+(?=[A-Z\\])/g, '$1\n');
    }
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

  const ARG_CMDS = new Set(['If', 'ElsIf', 'For', 'ForAll', 'While', 'Until', 'Procedure', 'Function']);
  // algorithmicx blocks: [{start, end, title, lines:[{prefix, content, suffix, kind, raw}]}]
  function parseGames(src, envs) {
      envs = envs || ['gameenv', 'algorithmic'];
    const out = [];
    const re = new RegExp('\\\\begin\\{(' + envs.join('|') + ')\\}', 'g');
    let m;
    while ((m = re.exec(src))) {
      if (inComment(src, m.index)) continue;
      const end = envEnd(src, m.index, m[1]);
      if (end < 0) continue;
      let bodyStart = m.index + m[0].length, title = null, titleRange = null;
      while (src[bodyStart] === '[' || (src[bodyStart] === '{' && m[1] === 'gameenv' && title === null)) {
        const ge = groupEnd(src, bodyStart);
        if (src[bodyStart] === '{') { title = src.slice(bodyStart + 1, ge - 1); titleRange = [bodyStart + 1, ge - 1]; }
        bodyStart = ge;
      }
      const bodyEnd = end - ('\\end{' + m[1] + '}').length;
      const body = src.slice(bodyStart, bodyEnd);
      out.push({ kind: 'algo', env: m[1], start: m.index, end, bodyStart, bodyEnd, title, titleRange, lines: body.split('\n').map(parseGameLine) });
      re.lastIndex = end;
    }
    // cryptocode: \procedure[opts]{title}{body}
    const pre = /\\(procedure|pseudocode)\*?\s*(\[[^\]]*\])?\s*\{/g;
    while ((m = pre.exec(src))) {
      if (inComment(src, m.index)) continue;
      let i = m.index + m[0].length - 1;
      let title = null, titleRange = null;
      if (m[1] === 'procedure') {
        const te = groupEnd(src, i);
        title = src.slice(i + 1, te - 1); titleRange = [i + 1, te - 1];
        i = te;
        while (src[i] === ' ' || src[i] === '\n') i++;
      }
      if (src[i] !== '{') continue;
      const be = groupEnd(src, i);
      const body = src.slice(i + 1, be - 1);
      // lines end at a top-level \\ (the separator stays with its line)
      const lines = [];
      let depth = 0, last = 0;
      for (let k = 0; k < body.length; k++) {
        const c = body[k];
        if (c === '\\' && body[k + 1] === '\\' && depth === 0) {
          let e = k + 2;
          while (e < body.length && /[ \t\r\n]/.test(body[e])) e++;
          lines.push({ content: body.slice(last, k), suffix: body.slice(k, e), prefix: '' });
          last = e; k = e - 1; continue;
        }
        if (c === '\\') { k++; continue; }
        if (c === '{') depth++; else if (c === '}') depth--;
      }
      lines.push({ content: body.slice(last), suffix: '', prefix: '' });
      out.push({ kind: 'proc', start: m.index, end: be, bodyStart: i + 1, bodyEnd: be - 1, title, titleRange, lines });
      pre.lastIndex = be;
    }
    return out.sort((a, b) => a.bodyStart - b.bodyStart);
  }

  function parseGameLine(line) {
    const m = /^(\s*)\\(State|Statex|If|ElsIf|Else|EndIf|For|ForAll|EndFor|While|EndWhile|Repeat|Until|Loop|EndLoop|Procedure|EndProcedure|Function|EndFunction|Require|Ensure|Return)(?![A-Za-z])(\s*)/.exec(line);
    if (!m) return { kind: 'raw', prefix: line, content: '', suffix: '', raw: true };
    const kind = m[2];
    let i = m[0].length;
    let prefix = line.slice(0, i), content, suffix;
    if (ARG_CMDS.has(kind) && line[i] === '{') {
      const ge = groupEnd(line, i);
      prefix += '{';
      content = line.slice(i + 1, ge - 1);
      suffix = line.slice(ge - 1);
      if (kind === 'Procedure' || kind === 'Function') { // \Procedure{name}{args}: edit the args, keep the name
        const ge2 = line[ge] === '{' ? groupEnd(line, ge) : -1;
        if (ge2 > 0) { prefix = line.slice(0, ge + 1); content = line.slice(ge + 1, ge2 - 1); suffix = line.slice(ge2 - 1); }
      }
    } else {
      // the statement, up to a trailing \Comment{...}
      const rest = line.slice(i);
      const c = rest.search(/\\Comment\s*\{/);
      content = c >= 0 ? rest.slice(0, c) : rest;
      suffix = c >= 0 ? rest.slice(c) : '';
      // keep trailing spaces out of the editable part
      const tr = /\s*$/.exec(content)[0];
      if (tr) { content = content.slice(0, content.length - tr.length); suffix = tr + suffix; }
    }
    const ret = /^\\Return\b\s*/.exec(content);
    return { kind: ret ? 'Return' : kind, cmd: kind, prefix: ret ? prefix + ret[0] : prefix,
      content: ret ? content.slice(ret[0].length) : content, suffix };
  }

  function gameLineSrc(l) { return l.prefix + l.content + l.suffix; }


  // A tabular split for cell editing: [{start, end, specRange, rows}] where a
  // row is {lead (rules, spaces), cells:[{lead, content, trail}], sep (\\, its
  // optional [..] and the spaces after)}.  Rebuilt with tabularSrc.
  // In a tabular body, the index of the last character of a unit that must
  // not be split at & or \\: \verb|...| (any delimiter), a nested
  // \begin{x}...\end{x}, a % comment to the end of its line. -1 otherwise.
  function tabularAtomEnd(t, i) {
    if (t[i] === '%') { const e = t.indexOf('\n', i); return e < 0 ? t.length - 1 : e; }
    if (t[i] !== '\\') return -1;
    let m = /^\\verb\*?([^a-zA-Z\s*])/.exec(t.slice(i, i + 8));
    if (m) { const e = t.indexOf(m[1], i + m[0].length); return e < 0 ? -1 : e; }
    m = /^\\begin\{([^}]+)\}/.exec(t.slice(i, i + 60));
    if (m) { const e = envEnd(t, i, m[1]); return e < 0 ? -1 : e - 1; }
    return -1;
  }

  function parseTabulars(src) {
    const out = [];
    const re = /\\begin\{(tabular\*?|tabularx)\}/g;
    let m;
    while ((m = re.exec(src))) {
      if (inComment(src, m.index)) continue;
      const end = envEnd(src, m.index, m[1]);
      if (end < 0) continue;
      let k = m.index + m[0].length;
      while (src[k] === '[') k = groupEnd(src, k);
      if (m[1] !== 'tabular' && src[k] === '{') k = groupEnd(src, k);   // width
      if (src[k] !== '{') continue;
      const specEnd = groupEnd(src, k);
      const specRange = [k + 1, specEnd - 1];
      const bodyStart = specEnd, bodyEnd = end - ('\\end{' + m[1] + '}').length;
      const body = src.slice(bodyStart, bodyEnd);
      // split rows at top-level \\
      const rows = [];
      let depth = 0, last = 0;
      const pushRow = (text, sep) => {
        const lead = /^(\s*(\\(toprule|midrule|bottomrule|hline|cmidrule|cline)\s*(\([^)]*\))?\s*(\{[^}]*\})?\s*|%[^\n]*\n\s*)*)/.exec(text)[0];
        const rest = text.slice(lead.length);
        const cells = [];
        let d = 0, c0 = 0;
        for (let i = 0; i <= rest.length; i++) {
          const ch = rest[i];
          const atom = tabularAtomEnd(rest, i);
          if (atom >= 0) { i = atom; continue; }
          if (ch === '\\') { i++; continue; }
          if (ch === '{') d++; else if (ch === '}') d--;
          if ((ch === '&' && d === 0) || i === rest.length) {
            const raw = rest.slice(c0, i);
            const l = /^\s*/.exec(raw)[0], t = /\s*$/.exec(raw.slice(l.length))[0];
            cells.push({ lead: l, content: raw.slice(l.length, raw.length - t.length), trail: t });
            c0 = i + 1;
          }
        }
        rows.push({ lead, cells: rest.trim() === '' && cells.length === 1 ? [] : cells, empty: rest.trim() === '', sep, rawRest: rest });
      };
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '\\' && body[i + 1] === '\\' && depth === 0) {
          let e = i + 2;
          if (body[e] === '[') e = groupEnd(body, e);
          while (e < body.length && /[ \t\r\n]/.test(body[e])) e++;
          pushRow(body.slice(last, i), body.slice(i, e));
          last = e; i = e - 1; continue;
        }
        const atom = tabularAtomEnd(body, i);
        if (atom >= 0) { i = atom; continue; }
        if (ch === '\\') { i++; continue; }
        if (ch === '{') depth++; else if (ch === '}') depth--;
      }
      pushRow(body.slice(last), '');
      out.push({ env: m[1], start: m.index, bodyStart, bodyEnd, specRange, spec: src.slice(specRange[0], specRange[1]), rows });
      re.lastIndex = end;
    }
    return out;
  }

  // ------------------------------------------------------------ game layout
  //
  // The games of a figure as a grid: rows of cells, a cell a stack of games
  // (indexes into parseGames).  Read from minipages side by side (a row ends
  // at \par, \\, a blank line or a skip), from multicols columns split at
  // \columnbreak (or \gamebreak), or from games one under the other.  Written
  // as rows of top-aligned minipages.
  const MINI_BEGIN = /\\begin\{minipage\}(?:\s*\[[^\]]*\])*\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/y;
  const LAYOUT_TOKENS = [
    ['space', /\s+/y], ['comment', /%[^\n]*\n?/y], ['mini', MINI_BEGIN], ['end', /\\end\{minipage\}/y],
    ['colbreak', /\\(?:columnbreak|gamebreak)(?![A-Za-z])/y],
    ['skip', /\\vspace\*?\s*\{0pt\}/y],      // tops of minipages aligned
    ['break', /\\(?:par|medskip|smallskip|bigskip|newline)(?![A-Za-z])|\\vspace\*?\s*\{[^{}]*\}|\\\\(?:\s*\[[^\]]*\])?/y],
    ['skip', /\\(?:hfill|quad|qquad|noindent|centering|null)(?![A-Za-z])|\\hspace\*?\s*\{[^{}]*\}|\\mbox\{\}/y],
  ];
  // the tokens a layout region may begin or end with
  const EDGE = new Set(['space', 'comment', 'mini', 'end', 'skip']);

  function layoutTokens(src, games) {
    const toks = [];
    let i = 0, gi = 0;
    while (i < src.length) {
      if (gi < games.length && i === games[gi].start) { toks.push({ t: 'game', g: gi, a: i, b: games[gi].end }); i = games[gi++].end; continue; }
      let hit = null;
      for (const [t, re] of LAYOUT_TOKENS) {
        re.lastIndex = i;
        const m = re.exec(src);
        if (m && m[0].length) { hit = { t, a: i, b: i + m[0].length, s: m[0], w: m[1] }; break; }
      }
      if (hit && gi < games.length && hit.b > games[gi].start) hit = null;
      if (!hit) {
        const next = gi < games.length ? games[gi].start : src.length;
        const last = toks[toks.length - 1];
        if (last && last.t === 'other') { last.b = i + 1; } else toks.push({ t: 'other', a: i, b: i + 1 });
        i++;
        if (i > next) i = next;
        continue;
      }
      if (hit.t === 'space' && /\n[ \t]*\n/.test(hit.s)) hit.t = 'blank';
      toks.push(hit);
      i = hit.b;
    }
    return toks;
  }

  const widthOf = (w) => { const m = /^\s*([\d.]+)\s*\\(?:line|text|column)width\s*$/.exec(w || ''); return m ? parseFloat(m[1]) : null; };

  // multicolEnvs: environments that open multicols (as \begin{env}{n}).
  function gameLayout(src, games, multicolEnvs) {
    const fail = (reason) => ({ ok: false, reason });
    if (!games.length) return fail('no games');
    if (games.some((g) => !(g.end > g.start))) return fail('a game has no clear extent');
    for (let k = 1; k < games.length; k++) if (games[k].start < games[k - 1].end) return fail('nested games');
    const toks = layoutTokens(src, games);
    const first = toks.findIndex((t) => t.t === 'game');
    let lastG = -1;
    toks.forEach((t, k) => { if (t.t === 'game') lastG = k; });
    let lo = first, hi = lastG;
    while (lo > 0 && EDGE.has(toks[lo - 1].t)) lo--;
    while (hi < toks.length - 1 && EDGE.has(toks[hi + 1].t)) hi++;
    // keep the whitespace and comments around the region as they are
    while (lo < first && (toks[lo].t === 'space' || toks[lo].t === 'comment')) lo++;
    while (hi > lastG && (toks[hi].t === 'space' || toks[hi].t === 'comment')) hi--;
    const region = toks.slice(lo, hi + 1);
    if (region.some((t) => t.t === 'other')) return fail('text or commands between the games');
    // minipages must open and close inside the region
    let depth = 0;
    for (const t of region) {
      if (t.t === 'mini') depth++;
      if (t.t === 'end' && --depth < 0) return fail('unbalanced minipages');
      if (t.t === 'mini' && depth > 1) return fail('nested minipages');
    }
    if (depth) return fail('unbalanced minipages');
    // a multicols wrapper around the games: \begin{multicols}{n}, \begin{games}{n}
    let wrapper = null;
    const envs = new Set(['multicols', ...(multicolEnvs || [])]);
    const wre = /\\begin\{([A-Za-z*]+)\}\s*\{\s*(\d+)\s*\}/g;
    for (let m; (m = wre.exec(src)) && m.index < region[0].a;) {
      if (!envs.has(m[1]) || inComment(src, m.index)) continue;
      const e = envEnd(src, m.index, m[1]);
      if (e >= region[region.length - 1].b) {
        const at = m.index + m[0].lastIndexOf(m[2]);
        wrapper = { env: m[1], n: +m[2], argRange: [at, at + m[2].length] };
      }
    }
    const rows = [];
    let cols = 1;
    const hasMini = region.some((t) => t.t === 'mini');
    if (wrapper && wrapper.n > 1 && !hasMini) {
      // columns of a multicols: split at \columnbreak, else as balanced by
      // length (as multicols would, roughly)
      const columns = [[]];
      for (const t of region) {
        if (t.t === 'colbreak') columns.push([]);
        if (t.t === 'game') columns[columns.length - 1].push(t.g);
      }
      if (columns.length === 1 && wrapper.n > 1) {
        const all = columns[0], size = all.map((g) => games[g].lines.length + 2);
        const total = size.reduce((x, y) => x + y, 0);
        columns.length = 0;
        let acc = 0, col = [];
        all.forEach((g, k) => {
          if (col.length && acc + size[k] / 2 > total * (columns.length + 1) / wrapper.n && columns.length < wrapper.n - 1) { columns.push(col); col = []; }
          col.push(g); acc += size[k];
        });
        columns.push(col);
      }
      cols = Math.max(wrapper.n, columns.length);
      rows.push(columns);
    } else {
      let row = null, cell = null, width = 1;
      const close = () => { if (row && row.length) rows.push(row); row = null; };
      for (const t of region) {
        if (t.t === 'mini') { cell = []; row = row || []; const w = widthOf(t.w); if (w) width = Math.min(width, w); }
        else if (t.t === 'end') { row.push(cell); cell = null; }
        else if (t.t === 'game') { if (cell) cell.push(t.g); else { close(); rows.push([[t.g]]); } }
        else if (!cell && (t.t === 'break' || t.t === 'blank' || t.t === 'colbreak')) close();
      }
      close();
      cols = Math.max(1, ...rows.map((r) => r.length), hasMini && width < 1 ? Math.min(4, Math.floor(1 / width + 0.05)) : 1);
    }
    for (const r of rows) while (r.length < cols) r.push([]);
    return { ok: true, cols, rows, region: [region[0].a, region[region.length - 1].b], wrapper };
  }

  const cellWidth = (cols) => Math.floor((1 - 0.03 * (cols - 1)) / cols * 100) / 100;

  // The figure with its games laid out as `rows` (cells of game indexes) in
  // `cols` columns; `layout` is what gameLayout read from the same source.
  function writeGameLayout(src, games, layout, cols, rows) {
    const text = (g) => src.slice(games[g].start, games[g].end);
    rows = rows.map((r) => r.map((c) => c.slice())).filter((r) => r.some((c) => c.length));
    let out;
    if (cols <= 1) {
      out = rows.flat(2).map(text).join('\n');
    } else {
      const w = String(cellWidth(cols)).replace(/^0/, '');
      out = rows.map((r) => {
        while (r.length < cols) r.push([]);
        return '\\noindent\n' + r.slice(0, cols).map((c) => `\\begin{minipage}[t]{${w}\\linewidth}\\vspace{0pt}\n` +
          (c.length ? c.map(text).join('\n') : '\\mbox{}') + '\n\\end{minipage}').join('\\hfill\n');
      }).join('\n\\par\\medskip\n');
    }
    const [a, b] = layout.region;
    let res = src.slice(0, a) + out + src.slice(b);
    // the games are now in minipages: a multicols wrapper keeps one column
    const wr = layout.wrapper;
    if (wr && wr.n !== 1) res = res.slice(0, wr.argRange[0]) + '1' + res.slice(wr.argRange[1]);
    return res;
  }

  function tabularBody(t) {
    return t.rows.map((r) => r.lead + (r.empty ? r.rawRest : r.cells.map((c, i) => c.lead + c.content + c.trail + (i < r.cells.length - 1 ? '&' : '')).join('')) + r.sep).join('');
  }

  const api = { tokenize, serializeTokens, segment, serializeSegments, splitCode, documentPieces,
    decodeText, encodeText, houseRules, headingParts, captionParts, typeset, setCodeEnvs, parseGames, parseGameLine, gameLineSrc, gameLayout, writeGameLayout, parseTabulars, tabularBody, groupEnd, envEnd, inComment, THM_ENVS, MATH_ENVS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LatexDoc = api;
})(this);
