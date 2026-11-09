#!/usr/bin/env python3
"""A local reading editor for a LaTeX paper.

    ./run path/to/main.tex [--port 8765] [--browser chrome-app] [--no-open]

Serves the editor on http://127.0.0.1:8765 only.  It reads the main file and
everything it \\inputs, writes a file back when you save in the editor, then
rebuilds the PDF (latexmk by default); numbers shown in the editor come from
the rebuilt .aux.  Settings that cannot be read from the document go in an
optional .paper-editor.json beside the main file; see README.md.
"""
import argparse
import hashlib
import http.server
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

import convert

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, 'static')
# LaTeX classes and bibliography styles TeX Live does not ship (iacrcc, iacrtrans,
# lipics, svjour3, sn-jnl): found by every build after the paper's own files
CLASSES = os.path.join(HERE, 'classes')
TOKEN = secrets.token_hex(16)

# Set by main(): the directory of the main file (LaTeX's working directory),
# the main file's name, a cache directory for this paper, and the settings.
PAPER = None         # LaTeX's working directory (the main file's directory, or --cwd)
MAIN = None          # the main file, relative to PAPER
ROOT = None          # the project root (git top level), for inputs outside PAPER
STATE = None         # <project>/.paper-editor: config.json, metadata.json, cache/
CACHE = None
CONFIG = {}
SESSION_START = {}   # file -> text when the editor first read it (diff baseline)
PROJECT_LOCK = threading.RLock()

DEFAULT_CONFIG = {
    # house rules applied to edited text when saving
    'house_rules': {'tie_before': ['cite', 'ref'], 'flag_bracketed_cref': True,
                    'one_sentence_per_line': False},
    # key style for bibliography entries added from Crossref/arXiv
    'key_style': 'cryptobib',
    # .bib file that receives new entries (default: the smallest listed one)
    'bib_add_to': None,
    # build command, run in the main file's directory
    'build': None,
    # environments shown as editable code boxes, besides lstlisting/minted/verbatim
    'code_envs': ['ecblock'],
}


def sha(text):
    return hashlib.sha1(text.encode()).hexdigest()


INPUT_RE = re.compile(r'(?<!\\)\\(?:input|include|subfile)\s*\{([^}]*)\}')


def strip_comments(text):
    return re.sub(r'(?<!\\)%.*', '', text)


def source_root():
    """The folder of the paper a converted main file belongs to: for
    <root>/converted/<venue>/x.tex, <root>; otherwise the main file's folder.
    Its \\input files, figures and bibliography stay there."""
    d = os.path.normpath(os.path.join(PAPER, os.path.dirname(MAIN)))
    parts = d.split(os.sep)
    for i in range(1, len(parts) - 1):
        if parts[i] == 'converted' and parts[i + 1] in convert.TARGETS:
            return os.sep.join(parts[:i]) or os.sep
    return d


def tex_env(*dirs):
    """The environment for a LaTeX run: the given folders (searched with their
    subfolders), the editor's bundled classes, then TeX's own path."""
    env = dict(os.environ)
    paths = [d for d in dirs if d] + [CLASSES]
    for k in ('TEXINPUTS', 'BIBINPUTS', 'BSTINPUTS'):
        env[k] = ':'.join(p + '//' for p in paths) + ':' + env.get(k, '')
    return env


def build_env():
    """A build of the main file: a converted one also finds the original's files."""
    root = source_root()
    return tex_env(root) if root != os.path.normpath(PAPER) else tex_env()


def resolve_input(name):
    """The file an \\input refers to, as a path relative to PAPER, or None.
    LaTeX looks in its working directory; a document compiled from the
    project root is found by also trying the root."""
    name = name.strip()
    bases, d = [PAPER], PAPER
    while ROOT and d != ROOT and d.startswith(ROOT) and os.path.dirname(d) != d:
        d = os.path.dirname(d)
        bases.append(d)
    if source_root() not in bases:
        bases.append(source_root())
    for base in bases:
        for cand in (name, name + '.tex'):
            f = os.path.join(base, cand)
            if os.path.isfile(f):
                return os.path.normpath(os.path.relpath(f, PAPER))
    return None


def input_map():
    """Every \\input argument in the paper, mapped to the file it resolves to."""
    out = {}
    for name in paper_files():
        for m in INPUT_RE.finditer(strip_comments(read(name))):
            f = resolve_input(m.group(1))
            if f:
                out[m.group(1).strip()] = f
    return out


def find_mains(folder):
    """The .tex files of a folder that are documents (\\documentclass and
    \\begin{document}), the most recently built first."""
    out = []
    for f in sorted(os.listdir(folder)):
        p = os.path.join(folder, f)
        if f.endswith('.tex') and os.path.isfile(p):
            with open(p, encoding='utf-8', errors='replace') as source:
                t = source.read()
            if re.search(r'^[^%\n]*\\documentclass', t, re.M) and '\\begin{document}' in t:
                built = [os.path.getmtime(os.path.join(folder, f[:-4] + e)) for e in ('.aux', '.pdf')
                         if os.path.exists(os.path.join(folder, f[:-4] + e))]
                out.append((max(built) if built else 0, f != 'main.tex', f))
    out.sort(key=lambda x: (-x[0], x[1], x[2]))
    return [f for _, _, f in out]


def paper_files():
    """The main file and every file it inputs, recursively, in input order."""
    seen, order = set(), []

    def visit(name):
        if name in seen:
            return
        seen.add(name)
        order.append(name)
        for m in INPUT_RE.finditer(strip_comments(read(name))):
            f = resolve_input(m.group(1))
            if f and f.endswith('.tex'):
                visit(f)
    visit(MAIN)
    return order


def preamble_text():
    """Everything before \\begin{document}, with local files it inputs or loads
    (\\input, \\usepackage of a .sty in the paper's directory) appended."""
    main = read(MAIN)
    pre = main[:main.find('\\begin{document}')] if '\\begin{document}' in main else main
    out, seen = [pre], set()

    def expand(text):
        for m in INPUT_RE.finditer(strip_comments(text)):
            f = resolve_input(m.group(1))
            if f and f not in seen:
                seen.add(f)
                t = read(f)
                out.append(t)
                expand(t)
        for m in re.finditer(r'\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}', strip_comments(text)):
            for pkg in m.group(1).split(','):
                f = pkg.strip() + '.sty'
                if os.path.isfile(os.path.join(PAPER, f)) and f not in seen:
                    seen.add(f)
                    t = read(f)
                    out.append(t)
                    expand(t)
    expand(pre)
    return '\n'.join(out)


def read(name):
    # newline='': keep \r\n exactly as it is in the file
    with open(os.path.join(PAPER, name), encoding='utf-8', errors='replace', newline='') as f:
        return f.read()


def docclass():
    m = re.search(r'^[^%\n]*\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}', read(MAIN), re.M)
    if not m:
        m = re.search(r'\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}', preamble_text())
        return m.group(2) if m else 'article'
    opts = re.search(r'\\documentclass\s*\[([^\]]*)\]', read(MAIN))
    return m.group(1) + ('/' + opts.group(1) if opts else '')


def stem():
    return os.path.splitext(MAIN)[0]


# ------------------------------------------------------------------ main.aux

def group(t, i):
    """Content of the balanced {...} at t[i], and the index after it."""
    depth, k = 0, i
    while True:
        c = t[k]
        if c == '\\':
            k += 2
            continue
        depth += {'{': 1, '}': -1}.get(c, 0)
        k += 1
        if depth == 0:
            return t[i + 1:k - 1], k


def aux_text():
    path = os.path.join(PAPER, stem() + '.aux')
    if not os.path.exists(path):
        return ''
    text = open(path, encoding='utf-8', errors='replace').read()
    # an \include'd file's .aux is read where it is \@input, not at the end:
    # its headings come in document order (they were numbered after the rest)
    def splice(t, depth=0):
        def one(m):
            p = os.path.join(PAPER, m.group(1))
            if depth > 4 or not os.path.exists(p):
                return ''
            return splice(open(p, encoding='utf-8', errors='replace').read(), depth + 1)
        return re.sub(r'\\@input\{([^}]*)\}', one, t)
    return splice(text)


def load_aux():
    """Label values and types, citation numbers and heading numbers."""
    labels, cites, heads, citeinfo = {}, {}, [], {}
    aux = aux_text()
    for m in re.finditer(r'\\newlabel\{([^}]*)\}', aux):
        key = m.group(1)
        try:
            body, _ = group(aux, m.end())
            val, _ = group(body, 0)
        except (IndexError, AssertionError):
            continue
        if key.endswith('@cref'):
            t = re.match(r'\[([^\]]*)\]', val)
            labels.setdefault(key[:-5], {})['type'] = t.group(1) if t else ''
        else:
            v = re.sub(r'\\mbox\s*', '', val).replace('{', '').replace('}', '').strip()
            labels.setdefault(key, {})['v'] = v
    # \bibcite{key}{1}, or natbib's \bibcite{key}{{1}{2023}{{Author and Writer}}{{}}}
    plain = lambda t: re.sub(r'\\[a-zA-Z]+\s*|[{}]', '', t.replace('~', ' ')).strip()
    for m in re.finditer(r'\\bibcite\{([^}]*)\}', aux):
        try:
            body, _ = group(aux, m.end())
        except (IndexError, AssertionError):
            continue
        if body.startswith('{'):
            parts, i = [], 0
            while i < len(body) and body[i] == '{' and len(parts) < 4:
                g, i = group(body, i)
                parts.append(g)
            cites[m.group(1)] = plain(parts[0]) if parts else ''
            citeinfo[m.group(1)] = {'year': plain(parts[1]) if len(parts) > 1 else '',
                                    'author': plain(parts[2]) if len(parts) > 2 else ''}
        else:
            cites[m.group(1)] = body
    # headings, in order, with the number LaTeX printed
    for m in re.finditer(r'\\contentsline\s*\{(part|chapter|section|subsection|subsubsection)\}', aux):
        try:
            body, _ = group(aux, m.end())
        except (IndexError, AssertionError):
            continue
        num = ''
        nl = re.match(r'\\numberline\s*', body)
        if nl:
            n, end = group(body, nl.end())
            num, title = n, body[end:]
        else:
            title = body
            a = re.match(r'(Appendix)\s*(?:\\nobreakspace\s*|~|\s)+(\w+)\s*:\s*', title)
            if a:
                num, title = a.group(1) + ' ' + a.group(2), title[a.end():]
        num = re.sub(r'\\mbox\s*', '', num).replace('{', '').replace('}', '').strip()
        heads.append({'level': m.group(1), 'num': num, 'title': title})
    # biblatex writes no \bibcite: numbers are \abx@aux@number in the .aux,
    # alphabetic labels (Aut19) and names/years are in the .bbl
    for m in re.finditer(r'\\abx@aux@number\{[^}]*\}\{([^}]*)\}\{[^}]*\}\{[^}]*\}\{([^}]*)\}', aux):
        cites.setdefault(m.group(1), m.group(2))
    bbl = os.path.join(PAPER, stem() + '.bbl')
    if os.path.exists(bbl) and '\\entry{' in (btext := open(bbl, encoding='utf-8', errors='replace').read()):
        for m in re.finditer(r'\\entry\{([^}]*)\}(.*?)\\endentry', btext, re.S):
            k, e = m.group(1), m.group(2)
            f = lambda name: (re.search(r'\\field\{%s\}\{([^}]*)\}' % name, e) or [None, ''])[1]
            if k not in cites:
                label = f('labelalpha') + f('extraalpha') or f('labelnumber')
                if label:
                    cites[k] = label
            fam = re.findall(r'family=\{([^}]*)\}', e)
            if k not in citeinfo:
                who = fam[0] + ' et al.' if len(fam) > 2 else ' and '.join(fam)
                citeinfo[k] = {'year': f('year'), 'author': who}
    return {'labels': labels, 'cites': cites, 'heads': heads, 'citeinfo': citeinfo}


def load_macros():
    """Macro definitions of the preamble, as KaTeX macros.  Covers \\newcommand,
    \\renewcommand, \\providecommand, \\def, \\DeclareMathOperator and
    \\NewDocumentCommand with mandatory arguments; KaTeX knows the standard
    packages' macros itself."""
    pre = strip_comments(preamble_text())
    macros = {}
    for m in re.finditer(r'\\(?:re|provide)?newcommand\*?\s*(?:\{(\\[A-Za-z@]+)\}|(\\[A-Za-z@]+))'
                         r'\s*(?:\[(\d)\])?\s*(\[[^\]]*\])?\s*(?=\{)', pre):
        try:
            body, _ = group(pre, m.end())
        except (IndexError, AssertionError):
            continue
        n, default = int(m.group(3) or 0), m.group(4)
        if default is not None and n:
            # KaTeX has no optional arguments: use the default, shift the rest
            body = body.replace('#1', default[1:-1])
            for k in range(2, n + 1):
                body = body.replace('#%d' % k, '#%d' % (k - 1))
        macros[m.group(1) or m.group(2)] = body
    for m in re.finditer(r'\\def\s*(\\[A-Za-z@]+)((?:#\d)*)\s*(?=\{)', pre):
        try:
            body, _ = group(pre, m.end())
        except (IndexError, AssertionError):
            continue
        macros.setdefault(m.group(1), body)
    for m in re.finditer(r'\\DeclareMathOperator(\*?)\s*\{(\\[A-Za-z]+)\}\s*(?=\{)', pre):
        body, _ = group(pre, m.end())
        macros[m.group(2)] = '\\operatorname' + m.group(1) + '{' + body + '}'
    for m in re.finditer(r'\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?(\\[A-Za-z]+)\}?\s*\{([^}]*)\}\s*(?=\{)', pre):
        body, _ = group(pre, m.end())
        macros[m.group(1)] = body
    return {k: katexify(v) for k, v in macros.items() if '@' not in k}


def katexify(body):
    """A display-only version of a macro body for KaTeX: unwrap boxes that
    KaTeX lacks or that switch to text mode around maths (\\rotatebox,
    \\scalebox, \\raisebox, \\resizebox, \\mbox{...$x$...}), and drop the
    inner dollars and size commands.  The document is not changed."""
    UNESC = r'(?<!\\)\$'          # a dollar that is not \$
    if not re.search(UNESC, body) and not re.search(r'\\(rotatebox|scalebox|raisebox|resizebox|reflectbox)', body):
        return body
    out, i = [], 0
    pat = re.compile(r'\\(rotatebox|scalebox|raisebox|resizebox|reflectbox|mbox|hbox|text)\s*(\[[^\]]*\])?\s*(?=\{)')
    while True:
        m = pat.search(body, i)
        if not m:
            out.append(body[i:])
            break
        out.append(body[i:m.start()])
        k = m.end()
        args = []
        nargs = {'rotatebox': 2, 'scalebox': 2, 'raisebox': 2, 'resizebox': 3}.get(m.group(1), 1)
        try:
            for _ in range(nargs):
                while k < len(body) and body[k] in ' \n':
                    k += 1
                a, k = group(body, k)
                args.append(a)
        except (IndexError, AssertionError):
            out.append(body[m.start():])
            break
        inner = args[-1]
        if m.group(1) in ('mbox', 'hbox', 'text') and not re.search(UNESC, inner):
            out.append(body[m.start():k])          # ordinary text: keep it
        else:
            inner = re.sub(r'\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|displaystyle)\b', '', inner)
            out.append('{' + re.sub(UNESC, '', katexify(inner)) + '}')
        i = k
    return re.sub(UNESC, '', ''.join(out))



THEOREM_DEFAULTS = {
    # amsthm and llncs/svjour defaults; \newtheorem in the document adds more
    'theorem': 'Theorem', 'lemma': 'Lemma', 'corollary': 'Corollary', 'proposition': 'Proposition',
    'definition': 'Definition', 'remark': 'Remark', 'example': 'Example', 'claim': 'Claim',
    'conjecture': 'Conjecture', 'fact': 'Fact', 'observation': 'Observation', 'assumption': 'Assumption',
    'problem': 'Problem', 'question': 'Question', 'note': 'Note', 'property': 'Property',
}


def load_theorems():
    """Theorem-like environments: env -> {name, counter}."""
    pre = strip_comments(preamble_text())
    th = {}
    for m in re.finditer(r'\\(?:sp)?newtheorem(\*?)\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}', pre):
        env, shared, name = m.group(2).strip(), m.group(3), m.group(4)
        th[env] = {'name': name, 'counter': None if m.group(1) else (shared or env)}
    for m in re.finditer(r'\\declaretheorem\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}', pre):
        opts, env = m.group(1) or '', m.group(2).strip()
        name = re.search(r'name\s*=\s*\{?([^,}]*)', opts)
        shared = re.search(r'(?:sibling|numberlike|sharenumber)\s*=\s*\{?([^,}]*)', opts)
        th[env] = {'name': name.group(1).strip() if name else env.capitalize(),
                   'counter': shared.group(1).strip() if shared else env}
    if re.search(r'\\documentclass(\[[^\]]*\])?\{(llncs|svjour3?|lncs)\}', read(MAIN)) or not th:
        for env, name in THEOREM_DEFAULTS.items():
            th.setdefault(env, {'name': name, 'counter': 'theorem' if env != 'definition' else env})
    return th


def load_bib():
    """Short entries for the reference list, from main.bbl."""
    path = os.path.join(PAPER, stem() + '.bbl')
    if not os.path.exists(path):
        return {}
    bbl = open(path, encoding='utf-8', errors='replace').read()
    out = {}
    # \bibitem{key}, or natbib's \bibitem[Author et~al.(2023)]%\n{key}
    for m in re.finditer(r'\\bibitem\s*(?:\[(?:[^\[\]{}]|\{[^{}]*\})*\])?\s*%?\s*\{([^}]*)\}(.*?)(?=\\bibitem|\\end\{thebibliography\})', bbl, re.S):
        t = re.sub(r'\\BIBentry(ALT|STD)interwordspacing|\\BIBdecl[A-Za-z]*', '', m.group(2))
        # ACM-Reference-Format: \bibfield{author}{...}, \bibinfo{person}{...}: keep the values
        t = re.sub(r'\\bib(?:field|info)\s*\{[^{}]*\}', '', t)
        t = re.sub(r'\\(?:showDOI|showISBNx|showISSN|showURL|urldef|href)\s*\{[^{}]*\}', '', t)
        out[m.group(1)] = t.replace('\\newblock', ' ').strip()
    # biblatex
    for m in re.finditer(r'\\entry\{([^}]*)\}(.*?)\\endentry', bbl, re.S):
        title = re.search(r'\\field\{title\}\{(.*?)\}\s*$', m.group(2), re.M)
        names = re.findall(r'family=\{([^}]*)\}', m.group(2))
        year = re.search(r'\\field\{year\}\{(\d+)\}', m.group(2))
        out[m.group(1)] = (', '.join(names) + '. ' if names else '') + (title.group(1) if title else '') + \
            ('. ' + year.group(1) if year else '')
    return out


# ------------------------------------------------------------------ figures

FIG_RE = re.compile(r'\\begin\{(figure\*?|table\*?)\}.*?\\end\{\1\}', re.S)


def strip_cmd(t, cmd):
    out, i = '', 0
    while True:
        j = t.find('\\' + cmd + '{', i)
        if j < 0:
            return out + t[i:]
        out += t[i:j]
        _, i = group(t, j + len(cmd) + 1)


def figure_sources():
    found = []
    for name in paper_files():
        text = read(name)
        for m in FIG_RE.finditer(text):
            found.append(m.group(0))
    return found


def fig_key(src, labels=None):
    """Cache key: the source plus the numbers of the labels it references."""
    if labels is None:
        labels = load_aux()['labels']
    keys = sorted({k.strip() for g in re.findall(r'\\[a-zA-Z]*ref\*?\{([^}]*)\}', src) for k in g.split(',')})
    nums = ''.join(k + '=' + str(labels.get(k, {}).get('v', '')) + ';' for k in keys)
    cite_keys = sorted({k.strip() for g in re.findall(
        r'\\(?:cite|citep|citet|Cite)\*?(?:\[[^]]*\])*\{([^}]*)\}', src) for k in g.split(',')})
    if cite_keys:
        cites = load_aux()['cites']
        nums += ''.join('cite:' + k + '=' + str(cites.get(k, '')) + ';' for k in cite_keys)
    # Invalidate cached images made with the previous broken reference loader.
    return sha('figures-v2:' + src + nums)[:16]


def aux_label_lines():
    """Copy complete aux definitions; they need not occupy a single line.

    A truncated ``\\newlabel`` copied into figs.tex used to produce
    ``File ended while scanning use of \\@newl@bel``.  Ignore incomplete
    definitions rather than poisoning an otherwise independent figure build.
    """
    aux, definitions = aux_text(), []
    for m in re.finditer(r'\\(?:newlabel|bibcite)\s*(?=\{)', aux):
        try:
            _, end = group(aux, m.end())
            _, end = group(aux, end)
        except (IndexError, AssertionError):
            continue
        definitions.append(aux[m.start():end])
    return definitions


def tex_error(result):
    """Show the TeX error instead of only saying 'LaTeX failed'."""
    lines = ((result.stdout or '') + '\n' + (result.stderr or '')).splitlines()
    errors = [line.strip() for line in lines if line.lstrip().startswith('!')]
    return ' '.join(errors[:3]) if errors else ('latexmk failed (exit %s)' % result.returncode)


def debug_capture(kind, command, result, files=(), log=None):
    """Opt-in local evidence: PAPER_EDITOR_DEBUG=1, outside tracked sources."""
    if os.environ.get('PAPER_EDITOR_DEBUG', '').lower() in ('', '0', 'false', 'no'):
        return
    root = os.path.join(STATE, 'debug')
    os.makedirs(root, exist_ok=True)
    folder = tempfile.mkdtemp(prefix=time.strftime('%Y%m%d-%H%M%S-') + kind + '-', dir=root)
    for name, content in (('command.txt', repr(command) + '\n'),
                          ('stdout.log', result.stdout or ''),
                          ('stderr.log', result.stderr or '')):
        with open(os.path.join(folder, name), 'w', encoding='utf-8') as out:
            out.write(content)
    for path in files:
        if os.path.isfile(path):
            shutil.copy2(path, os.path.join(folder, os.path.basename(path)))
    if log:
        log('debug: %s logs in %s' % (kind, folder))


def build_figures(log):
    """Render figures as in-place boxes: no float placement or blank float pages."""
    os.makedirs(CACHE, exist_ok=True)
    labels = load_aux()['labels']
    todo = [s for s in figure_sources() if not os.path.exists(os.path.join(CACHE, fig_key(s, labels) + '.png'))]
    if not todo:
        return
    with tempfile.TemporaryDirectory() as tmp:
        main = read(MAIN)
        cut = main.find('\\begin{document}')
        if cut < 0:
            log('figures: main document has no \\begin{document}')
            return
        tex = os.path.join(tmp, 'figs.tex')
        env = tex_env(PAPER, os.path.dirname(PAPER), source_root())
        cmd = ['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', 'figs.tex']

        def figs_document(tight):
            # Preserve the two-column width before switching to a predictable
            # single-column page; otherwise figure* float placement shifts pages.
            doc = [main[:cut], r'\newlength{\pefloatcolumnwidth}', r'\makeatletter']
            doc += aux_label_lines()
            # tight: one page per figure, sized to it, with no header, footer,
            # line numbers or draft notice (acmart review, iacrtrans submission,
            # LIPIcs number lines; pdfcrop kept those and a small table became a
            # tall, mostly empty picture)
            if tight:
                doc += [r'\makeatother', r'\usepackage[active,tightpage]{preview}',
                        r'\setlength\PreviewBorder{2pt}', r'\makeatletter']
            doc.extend([r'\makeatother', r'\pagestyle{empty}', r'\begin{document}',
                        r'\makeatletter\@ifpackageloaded{lineno}{\nolinenumbers}{}\makeatother',
                        r'\setlength{\pefloatcolumnwidth}{\columnwidth}', r'\onecolumn'])
            for src in todo:
                kind = re.match(r'\\begin\{(figure\*?|table\*?)\}', src).group(1)
                body = src[src.index('}') + 1:src.rindex('\\end{')]
                body = re.sub(r'^\[[^\]]*\]', '', body)
                body = strip_cmd(strip_cmd(body, 'caption'), 'label')
                width = r'\textwidth' if kind.endswith('*') else r'\pefloatcolumnwidth'
                box = [r'\noindent\begin{minipage}{%s}' % width, body, r'\end{minipage}']
                doc.extend(([r'\begin{preview}'] + box + [r'\end{preview}'] if tight else box) + [r'\par\clearpage'])
            doc.append(r'\end{document}')
            return '\n'.join(doc)

        for tight in (True, False):
            with open(tex, 'w', encoding='utf-8') as out:
                out.write(figs_document(tight))
            for stale in ('figs.pdf', 'figs.aux', 'figs.fdb_latexmk'):
                if os.path.exists(os.path.join(tmp, stale)):
                    os.remove(os.path.join(tmp, stale))
            r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True, errors='replace', timeout=600)
            debug_capture('figures', cmd, r, [tex, os.path.join(tmp, 'figs.log'),
                                              os.path.join(tmp, 'figs.aux')], log)
            if r.returncode == 0 and os.path.exists(os.path.join(tmp, 'figs.pdf')):
                break
            if tight:
                log('figures: tight pages failed, trying plain pages: ' + tex_error(r))
        if r.returncode != 0 or not os.path.exists(os.path.join(tmp, 'figs.pdf')):
            log('figures: ' + tex_error(r))
            return
        crop = subprocess.run(['pdfcrop', '--margins', '6', 'figs.pdf', 'crop.pdf'], cwd=tmp,
                              capture_output=True, timeout=300)
        pdf = os.path.join(tmp, 'crop.pdf')
        if crop.returncode != 0 or not os.path.exists(pdf):
            log('figures: pdfcrop failed, using uncropped pages')
            pdf = os.path.join(tmp, 'figs.pdf')
        rendered = 0
        for n, src in enumerate(todo, 1):
            out = os.path.join(CACHE, fig_key(src, labels))
            png = subprocess.run(['pdftoppm', '-r', '200', '-png', '-singlefile', '-f', str(n), '-l', str(n),
                                  pdf, out], capture_output=True, timeout=120)
            if png.returncode != 0 or not os.path.isfile(out + '.png'):
                log('figures: PNG conversion failed for figure %s: %s' %
                    (n, (png.stderr or b'').decode(errors='replace')[-250:]))
                continue
            rendered += 1
            # the figure's text, for reading it in the viewer
            subprocess.run(['pdftotext', '-layout', '-f', str(n), '-l', str(n), os.path.join(tmp, 'figs.pdf'),
                            out + '.txt'], capture_output=True, timeout=120)
    log(f'figures: rendered {rendered}/{len(todo)}')


# ------------------------------------------------------------------ builder

class Builder:
    """Runs latexmk after saves (debounced) and figure rendering."""

    def __init__(self):
        self.lock = threading.Lock()
        self.wanted = threading.Event()
        self.state = {'state': 'idle', 'message': '', 'at': 0}
        self.aux = load_aux()
        self.auxver = 1
        threading.Thread(target=self.loop, daemon=True).start()

    def log(self, msg):
        print(time.strftime('%H:%M:%S'), msg, flush=True)

    def request(self):
        self.wanted.set()

    def build_command(self):
        if CONFIG.get('build'):
            return CONFIG['build']
        if os.path.isfile(os.path.join(PAPER, 'Makefile')):
            return ['make']
        # LaTeX writes beside where it runs: a main file in a subfolder
        # (converted/llncs/x.tex) keeps its .aux and .pdf beside it
        out = ['-outdir=' + os.path.dirname(MAIN)] if os.path.dirname(MAIN) else []
        return ['latexmk', '-pdf', '-synctex=1', '-interaction=nonstopmode', '-halt-on-error', *out, MAIN]

    def build_once(self):
        cmd = self.build_command()
        self.state = {'state': 'running', 'message': 'make' if cmd == ['make'] else 'latexmk', 'at': time.time()}
        log_files = [os.path.join(PAPER, stem() + suffix) for suffix in ('.log', '.aux', '.out', '.fdb_latexmk')]
        try:
            r = subprocess.run(cmd, cwd=PAPER, capture_output=True, text=True, errors='replace', timeout=600,
                               shell=isinstance(cmd, str), env=build_env())
            debug_capture('pdf-build', cmd, r, log_files, self.log)
            output = (r.stdout or '') + '\n' + (r.stderr or '')
            # Hyperref's .out is just as vulnerable to partial writes as .aux.
            # Keep the damaged files, and remove latexmk's stale status before
            # retrying.  Do not delete any manuscript .tex/.bib files.
            recoverable = re.search(
                r'File ended while scanning use of \\(?:@newl@bel|@@BOOKMARK|pgfsys@pdfmark)',
                output)
            nontext = any(os.path.isfile(p) and b'\x00' in open(p, 'rb').read()
                          for p in log_files if p.endswith(('.aux', '.out')))
            if (r.returncode != 0 and isinstance(cmd, list) and cmd
                    and os.path.basename(cmd[0]) == 'latexmk' and (recoverable or nontext)):
                backup_dir = os.path.join(CACHE, 'bad-aux', str(time.time_ns()))
                os.makedirs(backup_dir, exist_ok=True)
                for suffix in ('.aux', '.out', '.fdb_latexmk', '.fls'):
                    path = os.path.join(PAPER, stem() + suffix)
                    if os.path.isfile(path):
                        backup = os.path.join(backup_dir, os.path.basename(path))
                        shutil.copy2(path, backup)
                        os.unlink(path)
                self.log('build: saved damaged aux/out/build state in %s; rebuilding once' % backup_dir)
                retry = cmd + ['-g']
                r = subprocess.run(retry, cwd=PAPER, capture_output=True, text=True, errors='replace', timeout=600, env=build_env())
                debug_capture('pdf-retry', retry, r, log_files, self.log)
            if r.returncode == 0:
                self.aux = load_aux()
                self.auxver += 1
                self.state = {'state': 'ok', 'message': 'PDF rebuilt', 'at': time.time()}
            else:
                self.state = {'state': 'error', 'message': tex_error(r), 'at': time.time()}
        except subprocess.TimeoutExpired:
            self.state = {'state': 'error', 'message': 'latexmk timed out after 600 seconds', 'at': time.time()}
        except OSError as e:
            self.state = {'state': 'error', 'message': f'could not run build: {e}', 'at': time.time()}
        except Exception as e:
            self.state = {'state': 'error', 'message': f'build failed: {e}', 'at': time.time()}
        self.log('build: ' + self.state['message'])

    def loop(self):
        try:
            build_figures(self.log)
        except Exception as e:  # figures are a nicety; never stop the server
            self.log(f'figures: {e}')
        while True:
            self.wanted.wait()
            time.sleep(1.5)  # let several saves in a row share one build
            self.wanted.clear()
            self.build_once()
            try:
                build_figures(self.log)
            except Exception as e:
                self.log(f'figures: {e}')


BUILDER = None


def doc_payload():
    files = {}
    for name in paper_files():
        text = read(name)
        files[name] = {'text': text, 'hash': sha(text)}
    figs = {}
    labels = load_aux()['labels']
    for src in figure_sources():
        k = fig_key(src, labels)
        if os.path.exists(os.path.join(CACHE, k + '.png')):
            figs[src] = '/fig/' + k + '.png'
    for name, f in files.items():
        SESSION_START.setdefault(name, f['text'])
    return {'pages': synctex_pages(), 'docclass': docclass(),
            'main': MAIN, 'path': os.path.join(PAPER, MAIN), 'root': source_root(), 'mains': find_mains(PAPER), 'resolve': input_map(), 'files': files, 'aux': BUILDER.aux, 'auxver': BUILDER.auxver,
            'macros': load_macros(), 'theorems': load_theorems(), 'config': CONFIG,
            'bib': load_bib(), 'figs': figs, 'build': BUILDER.state,
            'tts': {}}


# ------------------------------------------------------------------ box warnings
#
# Overfull and underfull boxes from the last build's .log, with the source
# file and lines TeX reports, so the page can mark the blocks concerned.

BOX_RE = re.compile(r'^(Overfull|Underfull) \\([hv]box) \((.*?)\) (in paragraph|in alignment|detected|has occurred)'
                    r'(?: at lines? (\d+)(?:--(\d+))?)?')
FILE_RE = re.compile(r'\(((?:\.{0,2}/|/)?[^\s()]+?\.(?:tex|ltx))(?=[\s()]|$)')


def parse_box_warnings(text, root=None):
    """[{kind, box, amount, file, from, to}] from LaTeX log text. The file is
    found from the log's ( ... ) nesting; lines wrapped at 79 columns are joined."""
    lines, buf = [], ''
    for line in text.split('\n'):
        buf += line
        if len(line) != 79:
            lines.append(buf); buf = ''
    if buf:
        lines.append(buf)
    stack, out, skip = [], [], False
    for line in lines:
        if skip:                      # the box contents shown after a warning
            if not line.strip():
                skip = False
            continue
        m = BOX_RE.match(line)
        if m:
            f = next((x for x in reversed(stack) if x), None)
            if f:
                f = os.path.normpath(f[2:] if f.startswith('./') else f)
                if root and os.path.isabs(f):
                    f = os.path.relpath(f, root)
            a = int(m.group(5)) if m.group(5) else None
            out.append({'kind': m.group(1).lower(), 'box': m.group(2), 'amount': m.group(3),
                        'file': f, 'from': a, 'to': int(m.group(6)) if m.group(6) else a})
            skip = True
            continue
        i = 0
        while i < len(line):
            c = line[i]
            if c == '(':
                fm = FILE_RE.match(line, i)
                if fm:
                    stack.append(fm.group(1)); i = fm.end(); continue
                stack.append(None)
            elif c == ')' and stack:
                stack.pop()
            i += 1
    return out


_boxes = {'stamp': None, 'list': []}


def box_warnings():
    """The last build's box warnings, re-read only when the .log changes."""
    path = os.path.join(PAPER, stem() + '.log')
    try:
        st = os.stat(path)
    except OSError:
        return []
    stamp = (st.st_mtime_ns, st.st_size)
    if _boxes['stamp'] != stamp:
        try:
            text = open(path, encoding='utf-8', errors='replace').read()
            _boxes['list'] = parse_box_warnings(text, PAPER)[:300]
        except OSError:
            _boxes['list'] = []
        _boxes['stamp'] = stamp
    return _boxes['list']


def state_payload():
    return {'hashes': {n: sha(read(n)) for n in paper_files()}, 'auxver': BUILDER.auxver,
            'build': BUILDER.state, 'boxes': box_warnings()}


# ------------------------------------------------------------------ bibliography
#
# An index of the .bib files of the paper (key, title, authors,
# year), cached in .cache/bibindex.json while the files are unchanged, and an
# online lookup (Crossref, arXiv) that appends a new entry to references.bib
# with a key in the cryptobib style (VENUE:AutAut24).

_bib = {'entries': None, 'stamp': None}


def bib_files():
    """The .bib files named by \\bibliography or \\addbibresource."""
    out = []
    for name in paper_files():
        t = strip_comments(read(name))
        for m in re.finditer(r'\\bibliography\s*\{([^}]*)\}', t):
            out += [b.strip() + ('' if b.strip().endswith('.bib') else '.bib') for b in m.group(1).split(',')]
        for m in re.finditer(r'\\addbibresource(?:\[[^\]]*\])?\s*\{([^}]*)\}', t):
            out.append(m.group(1).strip())
    return [b for b in dict.fromkeys(out) if os.path.isfile(os.path.join(PAPER, b))]


def bib_target():
    """The .bib file that receives new entries."""
    if CONFIG.get('bib_add_to'):
        return CONFIG['bib_add_to']
    files = bib_files()
    if not files:
        return 'references.bib'
    return min(files, key=lambda b: os.path.getsize(os.path.join(PAPER, b)))
_bib_lock = threading.Lock()


def parse_bib(text, source):
    """[key, title, authors, year, type, source] for every entry."""
    out = []
    for m in re.finditer(r'^@(\w+)\s*\{\s*([^,\s]+)\s*,', text, re.M):
        typ, key = m.group(1).lower(), m.group(2)
        if typ in ('string', 'preamble', 'comment'):
            continue
        end = text.find('\n}', m.end())
        body = text[m.end():end if end > 0 else len(text)]
        fields = {}
        for f in re.finditer(r'(\w+)\s*=\s*', body):
            name = f.group(1).lower()
            if name not in ('title', 'author', 'year'):
                continue
            i = f.end()
            if i >= len(body):
                continue
            if body[i] in '{"':
                close = '}' if body[i] == '{' else '"'
                depth, k = 0, i
                while k < len(body):
                    c = body[k]
                    if c == '{':
                        depth += 1
                    elif c == '}':
                        depth -= 1
                    if (close == '}' and depth == 0 and c == '}') or (close == '"' and c == '"' and k > i and depth == 0):
                        break
                    k += 1
                val = body[i + 1:k]
            else:
                val = re.match(r'[^,\s]*', body[i:]).group(0)
            fields[name] = re.sub(r'\s+', ' ', val.replace('{', '').replace('}', '')).strip()
        authors = fields.get('author', '')
        last = ', '.join(a.strip().split(',')[0].split()[-1] if ',' not in a else a.split(',')[0].strip()
                         for a in re.split(r'\s+and\s+', authors) if a.strip())
        out.append([key, fields.get('title', ''), last, fields.get('year', ''), typ, source])
    return out


def bib_entries():
    paths = [os.path.join(PAPER, f) for f in bib_files()]
    stamp = [os.path.getmtime(p) for p in paths if os.path.exists(p)]
    with _bib_lock:
        if _bib['entries'] is not None and _bib['stamp'] == stamp:
            return _bib['entries']
        cache = os.path.join(CACHE, 'bibindex.json')
        if os.path.exists(cache):
            try:
                c = json.load(open(cache))
                if c['stamp'] == stamp:
                    _bib.update(entries=c['entries'], stamp=stamp)
                    return c['entries']
            except (ValueError, KeyError):
                pass
        t = time.time()
        entries = []
        for f in bib_files():
            p = os.path.join(PAPER, f)
            if os.path.exists(p):
                entries += parse_bib(open(p, encoding='utf-8', errors='replace').read(), f)
        os.makedirs(CACHE, exist_ok=True)
        json.dump({'stamp': stamp, 'entries': entries}, open(cache, 'w'))
        print(f'bib index: {len(entries)} entries in {time.time() - t:.1f}s', flush=True)
        _bib.update(entries=entries, stamp=stamp)
        return entries


def bib_search(q, limit=40):
    words = [w for w in re.split(r'\s+', q.lower().strip()) if w]
    if not words:
        return []
    cited = set(load_aux()['cites'])
    # once per search: bib_target() reads every file of the paper, and a short
    # query matches tens of thousands of cryptobib entries
    target = bib_target()
    hits = []
    for key, title, authors, year, typ, src in bib_entries():
        hay = f'{key} {title} {authors} {year}'.lower()
        if all(w in hay for w in words):
            k = key.lower()
            score = (key in cited) * 4 + (src == target) * 2 + k.startswith(words[0]) * 3
            score += sum(w in k for w in words)
            hits.append((score, year, key, title, authors, src))
    hits.sort(key=lambda h: (-h[0], -(int(h[1]) if str(h[1]).isdigit() else 0)))
    return [{'key': k, 'title': t, 'authors': a, 'year': y, 'source': s, 'local': s == target, 'cited': k in cited}
            for _, y, k, t, a, s in hits[:limit]]


# Online lookup: Crossref (anything with a DOI) and arXiv.  DBLP's API sits
# behind a browser challenge and cannot be scripted.
VENUES = [('crypto', 'C'), ('eurocrypt', 'EC'), ('asiacrypt', 'AC'), ('theory of cryptography', 'TCC'),
          ('public key cryptography', 'PKC'), ('pkc', 'PKC'), ('ches', 'CHES'), ('cryptographic hardware', 'CHES'),
          ('fast software encryption', 'FSE'), ('computer security foundations', 'CSF'),
          ('computer and communications security', 'CCS'), ('security and privacy', 'SP'),
          ('usenix security', 'USENIX'), ('principles of programming languages', 'POPL'),
          ('computer aided verification', 'CAV'), ('interactive theorem proving', 'ITP'),
          ('theory of computing', 'STOC'), ('foundations of computer science', 'FOCS'),
          ('discrete algorithms', 'SODA'), ('automata, languages', 'ICALP'), ('journal of cryptology', 'JC'),
          ('siam journal on computing', 'SICOMP'), ('journal of the acm', 'JACM'),
          ('transactions on programming languages', 'TOPLAS'), ('esorics', 'ESORICS'),
          ('applied cryptography and network security', 'ACNS'), ('network and distributed system', 'NDSS')]


def venue_code(container):
    c = (container or '').lower()
    for pat, code in VENUES:
        if pat in c:
            return code
    words = [w for w in re.findall(r'[A-Za-z]+', container or '') if w[0].isupper() and w.lower() not in ('of', 'on', 'the', 'and', 'in')]
    return ''.join(w[0] for w in words)[:6].upper() or 'MISC'


def house_key(venue, authors, year):
    """A key in the cryptobib style: one author EC:Shamir84, two or three C:BelRog93, more C:ABCDE24."""
    last = [re.sub(r'[^A-Za-z]', '', a.split()[-1]) or 'X' for a in authors if a.strip()] or ['Anon']
    if len(last) == 1:
        names = last[0]
    elif len(last) <= 3:
        names = ''.join(n[:3] for n in last)
    else:
        names = ''.join(n[0] for n in last[:6]) + ('+' if len(last) > 6 else '')
    key = f'{venue}:{names}{str(year)[-2:]}'
    existing = {e[0] for e in bib_entries()}
    base, n = key, 0
    while key in existing:  # cryptobib appends a, b, ... to a clash
        key = base + 'abcdefghij'[n]
        n += 1
    return key


STOP = {'to', 'the', 'of', 'a', 'an', 'and', 'on', 'in', 'for', 'with', 'then', 'from', 'by', 'is', 'or',
        'do', 'at', 'as', 'be', 'are', 'its', 'via', 'how'}


def norm_title(t):
    return re.sub(r'[^a-z0-9]', '', (t or '').lower())


def online_search(q):
    out = []
    url = 'https://api.crossref.org/works?' + urllib.parse.urlencode(
        {'query.bibliographic': q, 'rows': 12, 'select': 'DOI,title,author,issued,container-title,type'})
    req = urllib.request.Request(url, headers={'User-Agent': 'paper-editor'})
    for it in json.load(urllib.request.urlopen(req, timeout=20))['message']['items']:
        authors = [f"{a.get('given', '')} {a.get('family', '')}".strip() for a in it.get('author', [])]
        year = str((it.get('issued', {}).get('date-parts') or [[None]])[0][0] or '')
        containers = it.get('container-title') or ['']
        # proceedings list their series too; the venue is the specific title
        specific = [c for c in containers if 'lecture notes' not in c.lower()] or containers
        venue = specific[-1]
        out.append({'source': 'crossref', 'id': it['DOI'], 'title': (it.get('title') or [''])[0],
                    'authors': ', '.join(authors), 'year': year, 'venue': venue,
                    'key': house_key(venue_code(' '.join(specific)), authors, year)})
    try:
        url = 'https://export.arxiv.org/api/query?' + urllib.parse.urlencode(
            {'search_query': ' AND '.join('all:' + w for w in re.findall(r'[A-Za-z0-9]+', q)
                                          if w.lower() not in STOP and len(w) > 1), 'max_results': 5})
        atom = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'paper-editor'}),
                                      timeout=20).read().decode()
        for e in re.findall(r'<entry>(.*?)</entry>', atom, re.S):
            aid = re.search(r'<id>https?://arxiv.org/abs/([^<v]+)', e).group(1)
            title = re.sub(r'\s+', ' ', re.search(r'<title>(.*?)</title>', e, re.S).group(1)).strip()
            authors = re.findall(r'<name>(.*?)</name>', e)
            year = re.search(r'<published>(\d{4})', e).group(1)
            out.append({'source': 'arxiv', 'id': aid, 'title': title, 'authors': ', '.join(authors),
                        'year': year, 'venue': 'arXiv', 'key': house_key('ARXIV', authors, year)})
    except Exception as e:
        print('arxiv:', e, flush=True)
    # mark the ones already in references.bib or cryptobib
    titles = {}
    for e in bib_entries():
        titles.setdefault(norm_title(e[1]), e[0])
    for h in out:
        h['have'] = titles.get(norm_title(h['title']))
    return out


def format_bib(bib, key):
    """One field per line, the house key, no URL noise."""
    m = re.match(r'\s*@(\w+)\s*\{[^,]*,(.*)\}\s*$', bib, re.S)
    if not m:
        raise ValueError('unexpected BibTeX')
    typ, body = m.group(1).lower(), m.group(2)
    fields, i = [], 0
    for f in re.finditer(r'(\w+)\s*=\s*', body):
        if f.start() < i:
            continue
        k = f.end()
        if body[k] == '{':
            depth = 0
            while True:
                depth += {'{': 1, '}': -1}.get(body[k], 0)
                k += 1
                if depth == 0:
                    break
        else:
            k = re.match(r'[^,]*', body[k:]).end() + k
        name, val = f.group(1).lower(), body[f.end():k].strip().replace('\u2013', '--').replace('\u2014', '---')
        i = k
        if name not in ('url', 'timestamp', 'biburl', 'bibsource', 'issn', 'isbn', 'month'):
            fields.append(f'  {name} = {val},')
    return f'@{typ}{{{key},\n' + '\n'.join(fields) + '\n}'


def online_add(source, ident, key):
    """Fetch the BibTeX of a DOI or arXiv id and append it to references.bib."""
    if not re.fullmatch(r'[A-Za-z0-9:_+.-]+', key or ''):
        raise ValueError('bad key')
    if any(e[0] == key for e in bib_entries()):
        raise ValueError(f'{key} already exists')
    if source == 'crossref':
        req = urllib.request.Request('https://doi.org/' + urllib.parse.quote(ident),
                                     headers={'Accept': 'application/x-bibtex', 'User-Agent': 'paper-editor'})
    elif source == 'arxiv':
        req = urllib.request.Request('https://arxiv.org/bibtex/' + urllib.parse.quote(ident),
                                     headers={'User-Agent': 'paper-editor'})
    else:
        raise ValueError('unknown source')
    bib = format_bib(urllib.request.urlopen(req, timeout=20).read().decode(), key)
    path = os.path.join(PAPER, bib_target())
    text = open(path, encoding='utf-8', newline='').read() if os.path.exists(path) else ''
    nl = '\r\n' if '\r\n' in text else '\n'
    bib = bib.replace('\n', nl)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text.rstrip('\n') + '\n\n' + bib + '\n')
    return bib


# ------------------------------------------------------------------ speech
#
# Server-side voices, all optional:
#   azure  Azure AI Speech (Microsoft's neural voices, official API): set
#          AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.  Free tier: 500k
#          characters a month.
#   edge   the Edge "Read Aloud" voices through the edge-tts package
#          (unofficial endpoint; may stop working): pip install edge-tts
#   google Google Cloud Text-to-Speech (Chirp 3 HD voices): set
#          GOOGLE_TTS_API_KEY.
#   kokoro, piper  local neural voices, offline: get_voices.py.
# The text of the paper is sent to Microsoft by azure and edge.  Audio is
# cached in .cache/tts by engine, voice and text.

class TTSError(Exception):
    pass


def have_edge():
    try:
        import edge_tts  # noqa: F401
        return True
    except ImportError:
        return False


def azure_conf():
    key, region = os.environ.get('AZURE_SPEECH_KEY'), os.environ.get('AZURE_SPEECH_REGION')
    return (key, region) if key and region else None


VOICES = None


def server_voices():
    """English voices of every configured engine, best first."""
    global VOICES
    if VOICES is not None:
        return VOICES
    out = []
    conf = azure_conf()
    if conf:
        try:
            req = urllib.request.Request(
                f'https://{conf[1]}.tts.speech.microsoft.com/cognitiveservices/voices/list',
                headers={'Ocp-Apim-Subscription-Key': conf[0]})
            for v in json.load(urllib.request.urlopen(req, timeout=20)):
                if v.get('Locale', '').startswith('en-'):
                    out.append({'engine': 'azure', 'voice': v['ShortName'],
                                'label': f"Azure: {v.get('DisplayName', v['ShortName'])} ({v['Locale']})"})
        except Exception as e:
            print('azure voices:', e, flush=True)
    if have_edge():
        try:
            import asyncio
            import edge_tts
            for v in asyncio.run(edge_tts.list_voices()):
                if v['Locale'].startswith('en-'):
                    out.append({'engine': 'edge', 'voice': v['ShortName'],
                                'label': f"Edge: {v['ShortName'].split('-')[-1].replace('Neural', '')} ({v['Locale']})"})
        except Exception as e:
            print('edge voices:', e, flush=True)
    gkey = os.environ.get('GOOGLE_TTS_API_KEY')
    if gkey:
        try:
            req = urllib.request.Request(f'https://texttospeech.googleapis.com/v1/voices?languageCode=en&key={gkey}')
            for v in json.load(urllib.request.urlopen(req, timeout=20)).get('voices', []):
                if 'Chirp3-HD' in v['name'] or 'Studio' in v['name'] or 'Neural2' in v['name']:
                    out.append({'engine': 'google', 'voice': v['name'], 'label': 'Google: ' + v['name']})
        except Exception as e:
            print('google voices:', e, flush=True)
    for name, label in local_voices():
        out.append({'engine': name.split(':')[0], 'voice': name.split(':', 1)[1], 'label': label})
    # natural-sounding multilingual and US/GB voices first
    out.sort(key=lambda v: (v['engine'] != 'azure' and v['engine'] != 'edge',
                            'Multilingual' not in v['voice'], not v['voice'].startswith(('en-US', 'en-GB')), v['label']))
    VOICES = out
    return out


def speak(engine, voice, text):
    key = hashlib.sha1(f'{engine}\0{voice}\0{text}'.encode()).hexdigest()
    cache = os.path.join(CACHE, 'tts', key)
    ctype = 'audio/wav' if engine in ('piper', 'kokoro') else 'audio/mpeg'
    if os.path.exists(cache):
        return open(cache, 'rb').read(), ctype
    if engine == 'azure':
        conf = azure_conf()
        if not conf:
            raise TTSError('set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION')
        lang = '-'.join(voice.split('-')[:2])
        ssml = (f"<speak version='1.0' xml:lang='{lang}'><voice name='{voice}'>"
                f"{html_escape(text)}</voice></speak>").encode()
        req = urllib.request.Request(
            f'https://{conf[1]}.tts.speech.microsoft.com/cognitiveservices/v1', data=ssml, method='POST',
            headers={'Ocp-Apim-Subscription-Key': conf[0], 'Content-Type': 'application/ssml+xml',
                     'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
                     'User-Agent': 'paper-editor'})
        try:
            audio = urllib.request.urlopen(req, timeout=30).read()
        except Exception as e:
            raise TTSError(f'azure: {e}')
    elif engine == 'edge':
        if not have_edge():
            raise TTSError('pip install edge-tts')
        import asyncio
        import edge_tts

        async def run():
            buf = b''
            async for chunk in edge_tts.Communicate(text, voice).stream():
                if chunk['type'] == 'audio':
                    buf += chunk['data']
            return buf
        try:
            audio = asyncio.run(run())
        except Exception as e:
            raise TTSError(f'edge: {e}')
    elif engine == 'google':
        gkey = os.environ.get('GOOGLE_TTS_API_KEY')
        if not gkey:
            raise TTSError('set GOOGLE_TTS_API_KEY')
        lang = '-'.join(voice.split('-')[:2])
        body = json.dumps({'input': {'text': text}, 'voice': {'languageCode': lang, 'name': voice},
                           'audioConfig': {'audioEncoding': 'MP3'}}).encode()
        req = urllib.request.Request(f'https://texttospeech.googleapis.com/v1/text:synthesize?key={gkey}',
                                     data=body, headers={'Content-Type': 'application/json'}, method='POST')
        try:
            import base64
            audio = base64.b64decode(json.load(urllib.request.urlopen(req, timeout=30))['audioContent'])
        except Exception as e:
            raise TTSError(f'google: {e}')
    elif engine in ('piper', 'kokoro'):
        audio = local_speak(engine, voice, text)
    else:
        raise TTSError('unknown engine')
    if not audio:
        raise TTSError(f'{engine}: no audio returned')
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, 'wb') as f:
        f.write(audio)
    return audio, ctype


# Local neural voices, run in-process: Piper voices are .onnx files in
# .cache/voices/piper, Kokoro is .cache/voices/kokoro/{kokoro-v1.0.onnx,
# voices-v1.0.bin}.  `python3 tools/paper-editor/get_voices.py` downloads them.
VOICE_DIR = os.path.join(HERE, '.cache', 'voices')
KOKORO_VOICES = {'af_heart': 'Heart (US, f)', 'af_bella': 'Bella (US, f)', 'am_michael': 'Michael (US, m)',
                 'am_fenrir': 'Fenrir (US, m)', 'bf_emma': 'Emma (GB, f)', 'bm_george': 'George (GB, m)',
                 'bm_fable': 'Fable (GB, m)'}
_local = {}


def local_voices():
    out = []
    kdir = os.path.join(VOICE_DIR, 'kokoro')
    if os.path.exists(os.path.join(kdir, 'kokoro-v1.0.onnx')):
        try:
            import kokoro_onnx  # noqa: F401
            out += [(f'kokoro:{v}', f'Kokoro: {label}') for v, label in KOKORO_VOICES.items()]
        except ImportError:
            pass
    pdir = os.path.join(VOICE_DIR, 'piper')
    if os.path.isdir(pdir):
        try:
            import piper  # noqa: F401
            for f in sorted(os.listdir(pdir)):
                if f.endswith('.onnx'):
                    out.append((f'piper:{f[:-5]}', f'Piper: {f[:-5]}'))
        except ImportError:
            pass
    return out


def local_speak(engine, voice, text):
    import io
    import wave
    if engine == 'kokoro':
        from kokoro_onnx import Kokoro
        import soundfile
        if 'kokoro' not in _local:
            kdir = os.path.join(VOICE_DIR, 'kokoro')
            _local['kokoro'] = Kokoro(os.path.join(kdir, 'kokoro-v1.0.onnx'), os.path.join(kdir, 'voices-v1.0.bin'))
        lang = 'en-gb' if voice.startswith('b') else 'en-us'
        samples, rate = _local['kokoro'].create(text, voice=voice, speed=1.0, lang=lang)
        buf = io.BytesIO()
        soundfile.write(buf, samples, rate, format='WAV')
        return buf.getvalue()
    from piper import PiperVoice
    key = 'piper:' + voice
    if key not in _local:
        _local[key] = PiperVoice.load(os.path.join(VOICE_DIR, 'piper', voice + '.onnx'))
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        _local[key].synthesize_wav(text, w)
    return buf.getvalue()


def baseline(name, ref):
    """The text of a file at the last git commit, or when the editor opened.
    None when there is no such version (a new file, or not in git)."""
    if ref == 'session':
        return SESSION_START.get(name)
    try:
        prefix = subprocess.run(['git', 'rev-parse', '--show-prefix'], cwd=PAPER, capture_output=True,
                                text=True, timeout=10)
        if prefix.returncode != 0:
            return SESSION_START.get(name)
        r = subprocess.run(['git', 'show', 'HEAD:' + prefix.stdout.strip() + name], cwd=PAPER,
                           capture_output=True, text=True, errors='replace', timeout=20)
        return r.stdout if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


_pages = {'stamp': None, 'map': {}}


def synctex_pages():
    """From <main>.synctex.gz: for every source file, the first PDF page of
    each line that produced output, as {file: [[line, page], ...]}."""
    import gzip
    path = os.path.join(PAPER, stem() + '.synctex.gz')
    if not os.path.exists(path):
        return {}
    stamp = os.path.getmtime(path)
    if _pages['stamp'] == stamp:
        return _pages['map']
    inputs, best = {}, {}
    page = 0
    try:
        with gzip.open(path, 'rt', encoding='utf-8', errors='replace') as f:
            for line in f:
                c = line[:1]
                if c == '{':
                    page = int(line[1:].strip() or 0)
                elif line.startswith('Input:'):
                    tag, _, name = line[6:].rstrip('\n').partition(':')
                    full = os.path.normpath(os.path.join(PAPER, name))
                    inputs[tag] = os.path.relpath(full, PAPER)
                elif page and c in 'xhvkg$([':
                    m = re.match(r'.(\d+),(\d+)', line)
                    if m:
                        key = (m.group(1), int(m.group(2)))
                        if key not in best:
                            best[key] = page
    except (OSError, EOFError, ValueError):
        return {}
    out = {}
    for (tag, ln), pg in best.items():
        name = inputs.get(tag)
        if name:
            out.setdefault(name, []).append([ln, pg])
    for v in out.values():
        v.sort()
    _pages.update(stamp=stamp, map=out)
    return out


KEYS_FILE = os.path.join(os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config')), 'paper-editor', 'keys.json')


def load_keys():
    """Your key bindings (action -> list of keys), shared by every paper."""
    try:
        return json.load(open(KEYS_FILE))
    except (OSError, ValueError):
        return {}


def metadata():
    """Metadata: what the front matter says, overridden by your edits
    (saved in .paper-editor/metadata.json)."""
    extracted = convert.extract(original_main())
    saved = {}
    path = os.path.join(STATE, 'metadata.json')
    if os.path.exists(path):
        try:
            saved = json.load(open(path))
        except ValueError:
            saved = {}
    merged = {**extracted, **{k: v for k, v in saved.items() if k != 'source_class'}}
    return {'metadata': merged, 'extracted': extracted, 'saved': bool(saved),
            'targets': {k: v[0] for k, v in convert.TARGETS.items()},
            'missing': {t: convert.missing(merged, t) for t in convert.TARGETS}}


# Every save of the metadata first keeps the version it replaces, so a wrong
# click (Restore detected fields, a deleted author) is never final.
MD_HISTORY_KEEP = 50
MD_HISTORY_NAME = re.compile(r'^\d{8}-\d{6}(?:-\d+)?\.json$')


def metadata_history_dir():
    return os.path.join(STATE, 'metadata-history')


def backup_metadata(new=None):
    """Keep the current effective metadata before a save replaces it with
    something different (no backup for a save that changes nothing, no repeats)."""
    current = metadata()['metadata']
    strip = lambda m: {k: v for k, v in (m or {}).items() if k != 'source_class'}
    if new is not None and strip(new) == strip(current):
        return
    d = metadata_history_dir()
    os.makedirs(d, exist_ok=True)
    names = sorted(n for n in os.listdir(d) if MD_HISTORY_NAME.match(n))
    if names:
        try:
            if json.load(open(os.path.join(d, names[-1])))['metadata'] == current:
                return
        except (ValueError, KeyError, OSError):
            pass
    stamp = time.strftime('%Y%m%d-%H%M%S')
    k = 0     # same width, so names sort in the order they were made
    while os.path.exists(os.path.join(d, name := f'{stamp}-{k:03d}.json')):
        k += 1
    with open(os.path.join(d, name), 'w') as f:
        json.dump({'at': time.time(), 'metadata': current}, f, indent=2, ensure_ascii=False)
    for old in names[:max(0, len(names) + 1 - MD_HISTORY_KEEP)]:
        os.remove(os.path.join(d, old))


def metadata_history():
    d = metadata_history_dir()
    out = []
    if os.path.isdir(d):
        for n in sorted((n for n in os.listdir(d) if MD_HISTORY_NAME.match(n)), reverse=True):
            try:
                v = json.load(open(os.path.join(d, n)))
                md = v['metadata']
                out.append({'name': n, 'at': v.get('at'), 'title': md.get('title', ''),
                            'authors': len(md.get('authors') or []),
                            'affiliations': len(md.get('affiliations') or [])})
            except (ValueError, KeyError, OSError):
                continue
    return out


def original_main():
    """The main file's text; for a converted file, the original it came from
    (its front matter is where metadata lives: a converted one is lossy)."""
    text = read(MAIN)
    return convert.restore(text) or text


def theorems_used():
    names = set(load_theorems()) | set(convert.PREDEFINED_THEOREMS['llncs'])
    used = set()
    for f in paper_files():
        used |= {e for e in re.findall(r'\\begin\{([A-Za-z]+)\}', strip_comments(read(f))) if e in names}
    return sorted(used - {'proof'})


def run_convert(target, anonymous, name, overwrite, root=False):
    if target not in convert.TARGETS:
        raise ValueError('unknown target')
    if not re.fullmatch(r'[A-Za-z0-9._-]+\.tex', name or ''):
        raise ValueError('the file name must end in .tex, without folders')
    # A missing class is an installation problem, not a failed conversion.
    # Fail before writing an unusable .tex file.
    target_class = {'ieee': 'IEEEtran', 'llncs': 'llncs', 'iacrcc': 'iacrcc',
                    'iacrtrans': 'iacrtrans', 'acmart': 'acmart',
                    'lipics': 'lipics-v2021', 'article': 'article'}.get(target, target)
    class_name = target_class + '.cls'
    found = shutil.which('kpsewhich')
    installed = subprocess.run(['kpsewhich', class_name], capture_output=True, text=True, errors='replace').stdout.strip() if found else ''
    if not installed and not any(os.path.isfile(os.path.join(d, class_name)) for d in (PAPER, source_root(), CLASSES)):
        raise ValueError(f'{class_name} is not installed. Install that LaTeX class (check with '
                         f'`kpsewhich {class_name}`), then retry conversion.')
    # from a converted file too: next to the original, never converted/x/converted/y/
    base_dir = source_root()
    out_dir = base_dir if root else os.path.join(base_dir, 'converted', target)
    path = os.path.join(out_dir, name)
    if os.path.exists(path) and not overwrite:
        raise FileExistsError(os.path.relpath(path, PAPER))
    md = metadata()['metadata']
    def resolve_text(item):
        f = resolve_input(item)
        return read(f) if f else None
    everything = '\n'.join(read(f) for f in paper_files() if f != MAIN)
    text, warnings = convert.convert(read(MAIN), md, target, anonymous, theorems_used(), resolve_text, everything,
                                     rel=os.path.relpath(base_dir, out_dir))
    # bibliography files that do not exist: say which (a broken link to a
    # shared cryptobib is the usual reason for "undefined citations")
    for m in re.finditer(r'(?m)^[^%\n]*\\bibliography\{([^}]*)\}', convert.split_origin(text)[0]):
        for bib in m.group(1).split(','):
            bib = bib.strip()
            f = os.path.normpath(os.path.join(out_dir, bib if bib.endswith('.bib') else bib + '.bib'))
            if bib and not os.path.exists(f):
                link = next((p for p in [os.path.dirname(f), f] if os.path.islink(p)), None)
                warnings.append(f'Bibliography file not found: {os.path.relpath(f, base_dir)}' +
                                (f' ({os.path.relpath(link, base_dir)} is a broken link to {os.readlink(link)})' if link else '') +
                                '; its citations stay undefined.')
    os.makedirs(out_dir, exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    # Resolve source-relative includes, bibliography and styles from the paper root.
    env = tex_env(base_dir)
    r = subprocess.run(['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', name], cwd=out_dir,
                       env=env, capture_output=True, text=True, errors='replace', timeout=600)
    logfile = os.path.join(out_dir, name[:-4] + '.log')
    log = open(logfile, errors='replace').read() if os.path.exists(logfile) else ''  # noqa: SIM115
    errors = [l for l in log.splitlines() if l.startswith('!')][:5]
    if r.returncode and not errors:
        errors = [tex_error(r)]
    undefined = len(re.findall(r'(Citation|Reference) .* undefined', log))
    return {'file': os.path.relpath(path, PAPER), 'built': r.returncode == 0, 'errors': errors,
            'undefined': undefined, 'warnings': warnings, 'missing': convert.missing(md, target)}


def html_escape(t):
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


# ------------------------------------------------------------------ HTTP

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def json_body(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            return json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            return None

    def do_HEAD(self):
        if urllib.parse.urlparse(self.path).path == '/pdf':
            ok = os.path.isfile(os.path.join(PAPER, stem() + '.pdf'))
            self.send_response(200 if ok else 404)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(405)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        p = url.path
        if p == '/':
            html = open(os.path.join(STATIC, 'index.html'), encoding='utf-8').read()
            return self.send(200, html.replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8')
        if p == '/api/doc':
            return self.send(200, doc_payload())
        if p == '/api/state':
            return self.send(200, state_payload())
        if p.startswith('/fig/') and re.fullmatch(r'/fig/[0-9a-f]{16}\.png', p):
            f = os.path.join(CACHE, p[5:])
            if os.path.exists(f):
                return self.send(200, open(f, 'rb').read(), 'image/png')
            return self.send(404, {'error': 'no figure'})
        if p == '/pdf':
            pdf = os.path.join(PAPER, stem() + '.pdf')
            if os.path.isfile(pdf):
                return self.send(200, open(pdf, 'rb').read(), 'application/pdf')
            return self.send(404, {'error': 'no PDF yet: save to build it'})
        if p == '/api/tts':
            return self.tts(urllib.parse.parse_qs(url.query))
        if p == '/api/bib':
            q = urllib.parse.parse_qs(url.query).get('q', [''])[0]
            return self.send(200, bib_search(q))
        if p == '/api/online':
            q = urllib.parse.parse_qs(url.query).get('q', [''])[0]
            try:
                return self.send(200, online_search(q))
            except Exception as e:
                return self.send(503, {'error': f'lookup failed: {e}'})
        if p == '/api/history':
            return self.send(200, history_list())
        if p == '/api/history/text':
            text = history_get(urllib.parse.parse_qs(url.query).get('id', [''])[0])
            return self.send(404, {'error': 'no such version'}) if text is None else self.send(200, {'text': text})
        if p == '/api/baseline':
            q = urllib.parse.parse_qs(url.query)
            name, ref = q.get('name', [''])[0], q.get('ref', ['head'])[0]
            if name not in paper_files():
                return self.send(400, {'error': 'unknown file'})
            return self.send(200, {'text': baseline(name, ref)})
        if p.startswith('/figtext/') and re.fullmatch(r'/figtext/[0-9a-f]{16}', p):
            f = os.path.join(CACHE, p[9:] + '.txt')
            return self.send(200, {'text': open(f).read() if os.path.exists(f) else ''})
        if p == '/api/keys':
            return self.send(200, load_keys())
        if p == '/api/metadata':
            return self.send(200, metadata())
        if p == '/api/metadata/history':
            return self.send(200, metadata_history())
        if p.startswith('/api/metadata/history/'):
            name = p.rsplit('/', 1)[1]
            f = os.path.join(metadata_history_dir(), name)
            if not MD_HISTORY_NAME.match(name) or not os.path.isfile(f):
                return self.send(404, {'error': 'no such metadata backup'})
            return self.send(200, json.load(open(f)))
        if p == '/api/voices':
            return self.send(200, server_voices())
        if p.startswith('/static/'):
            name = os.path.basename(p)
            f = os.path.join(STATIC, name)
            if os.path.exists(f):
                ctype = {'.js': 'text/javascript', '.css': 'text/css'}.get(os.path.splitext(f)[1], 'text/plain')
                return self.send(200, open(f, 'rb').read(), ctype + '; charset=utf-8')
        self.send(404, {'error': 'not found'})

    def do_POST(self):
        if self.headers.get('X-Token') != TOKEN:
            return self.send(403, {'error': 'bad token'})
        if urllib.parse.urlparse(self.path).path == '/api/log':
            n = int(self.headers.get('Content-Length', 0))
            msg = self.rfile.read(n).decode(errors='replace')[:200000]
            BUILDER.log('page: ' + msg)
            # errors of the page are kept (the console of an app window is
            # rarely open): <state>/debug/page-errors.log, last 1 MB
            if msg.startswith('JSERROR'):
                try:
                    os.makedirs(os.path.join(STATE, 'debug'), exist_ok=True)
                    f = os.path.join(STATE, 'debug', 'page-errors.log')
                    if os.path.exists(f) and os.path.getsize(f) > 1 << 20:
                        os.replace(f, f + '.1')
                    with open(f, 'a', encoding='utf-8') as out:
                        out.write(time.strftime('%Y-%m-%d %H:%M:%S ') + msg.replace('\n', '\n    ') + '\n')
                except OSError:
                    pass
            return self.send(200, {})
        if urllib.parse.urlparse(self.path).path == '/api/history/delete':
            req = self.json_body()
            if not isinstance(req, dict):
                return self.send(400, {'error': 'expected an object'})
            if req.get('all') is True and 'batch' not in req:
                batch = None
            elif isinstance(req.get('batch'), str) and 0 < len(req['batch']) <= 40 and not req.get('all'):
                batch = req['batch']
            else:
                return self.send(400, {'error': 'specify all:true or an existing save batch'})
            try:
                removed = history_delete(batch)
            except OSError as e:
                return self.send(500, {'error': str(e)})
            BUILDER.log(f'history: deleted {removed} snapshot(s)')
            return self.send(200, {'removed': removed, 'saves': history_list()})
        if urllib.parse.urlparse(self.path).path == '/api/metadata':
            md = self.json_body()
            if not isinstance(md, dict):
                return self.send(400, {'error': 'expected a JSON object'})
            ensure_state()
            backup_metadata(md)
            # Save only explicit differences; new metadata from LaTeX remains discoverable.
            extracted = convert.extract(original_main())
            overrides = {k: v for k, v in md.items() if k != 'source_class'
                         and v != extracted.get(k)}
            with open(os.path.join(STATE, 'metadata.json'), 'w') as f:
                json.dump(overrides, f, indent=2, ensure_ascii=False)
            return self.send(200, metadata())
        if urllib.parse.urlparse(self.path).path == '/api/convert':
            req = self.json_body()
            if not isinstance(req, dict):
                return self.send(400, {'error': 'expected a JSON object'})
            try:
                res = run_convert(req.get('target'), bool(req.get('anonymous')), req.get('name'), bool(req.get('overwrite')), bool(req.get('root')))
            except FileExistsError as e:
                return self.send(409, {'error': f'{e} exists'})
            except Exception as e:
                return self.send(400, {'error': str(e)})
            BUILDER.log(f"converted to {req.get('target')}: {res['file']} ({'built' if res['built'] else 'build failed'})")
            return self.send(200, res)
        if urllib.parse.urlparse(self.path).path == '/api/keys':
            keys = self.json_body()
            if not isinstance(keys, dict):
                return self.send(400, {'error': 'expected an object'})
            os.makedirs(os.path.dirname(KEYS_FILE), exist_ok=True)
            with open(KEYS_FILE, 'w') as f:
                json.dump(keys, f, indent=2, sort_keys=True)
            return self.send(200, {})
        if urllib.parse.urlparse(self.path).path == '/api/open':
            req = self.json_body()
            if not isinstance(req, dict):
                return self.send(400, {'error': 'expected a JSON object'})
            with PROJECT_LOCK:
                name = req.get('main', '')
                if not isinstance(name, str):
                    return self.send(400, {'error': 'invalid main document'})
                norm = os.path.normpath(name)
                if os.path.isabs(name) or norm.startswith('..') or not name.endswith('.tex'):
                    return self.send(400, {'error': 'invalid main document'})
                folder = os.path.dirname(norm)
                if os.path.basename(norm) not in find_mains(os.path.join(PAPER, folder)):
                    return self.send(400, {'error': 'not a document of this project'})
                open_paper(os.path.join(PAPER, norm), cwd=PAPER, state=STATE)
                ensure_state()
                BUILDER.aux = load_aux()
                BUILDER.auxver += 1
                return self.send(200, {'main': MAIN})
        if urllib.parse.urlparse(self.path).path == '/api/bibadd':
            req = self.json_body()
            if not isinstance(req, dict):
                return self.send(400, {'error': 'expected a JSON object'})
            try:
                bib = online_add(req.get('source', ''), req.get('id', ''), req.get('key', ''))
            except Exception as e:
                return self.send(400, {'error': str(e)})
            BUILDER.log(f"added {req.get('key')} to references.bib")
            return self.send(200, {'bib': bib})
        if urllib.parse.urlparse(self.path).path == '/api/backup':
            req = self.json_body()
            if not isinstance(req, dict) or not isinstance(req.get('text'), str):
                return self.send(400, {'error': 'expected a JSON object with text'})
            name, text = req.get('name'), req['text']
            with PROJECT_LOCK:
                if name not in paper_files():
                    return self.send(400, {'error': 'unknown file'})
                path = os.path.join(PAPER, name)
                stamp = time.strftime('%Y%m%d-%H%M%S')
                with tempfile.NamedTemporaryFile('w', encoding='utf-8', newline='',
                                                 dir=os.path.dirname(path),
                                                 prefix=os.path.basename(path) + '.editor-backup-' + stamp + '-',
                                                 delete=False) as f:
                    f.write(text)
                    backup = f.name
            return self.send(200, {'backup': os.path.relpath(backup, PAPER)})
        if urllib.parse.urlparse(self.path).path == '/api/pick-directory':
            directory = choose_directory()
            if not directory:
                return self.send(204, b'', 'text/plain')
            return self.send(200, {'path': directory, 'mains': find_mains(directory)})
        if urllib.parse.urlparse(self.path).path == '/api/open-project':
            req = self.json_body()
            if not isinstance(req, dict):
                return self.send(400, {'error': 'expected a JSON object'})
            directory, main = os.path.abspath(req.get('path', '')), req.get('main', '')
            with PROJECT_LOCK:
                mains = find_mains(directory) if os.path.isdir(directory) else []
                if main not in mains:
                    return self.send(400, {'error': 'main file is not in that paper directory'})
                open_paper(os.path.join(directory, main))
                ensure_state()
                BUILDER.aux = load_aux()
                BUILDER.auxver += 1
                return self.send(200, {'main': MAIN, 'path': PAPER})
        if urllib.parse.urlparse(self.path).path != '/api/save':
            return self.send(404, {'error': 'not found'})
        req = self.json_body()
        if not isinstance(req, dict):
            return self.send(400, {'error': 'expected a JSON object'})
        name, base, text = req.get('name'), req.get('base'), req.get('text')
        with PROJECT_LOCK:
            if not isinstance(name, str) or not isinstance(text, str):
                return self.send(400, {'error': 'expected a name and a text'})
            norm = os.path.normpath(name)
            safe = name.endswith('.tex') and not os.path.isabs(name) and norm != '..' and not norm.startswith('..' + os.sep)
            if not os.path.isfile(os.path.join(PAPER, name)) and safe:
                # deleted (or renamed) since the editor read it: only on request
                # (the Overwrite button) is it written again
                if not req.get('create'):
                    return self.send(409, {'error': 'the file is gone from disk', 'hash': None, 'gone': True})
                os.makedirs(os.path.dirname(os.path.join(PAPER, norm)) or PAPER, exist_ok=True)
                with open(os.path.join(PAPER, norm), 'x', encoding='utf-8', newline='') as f:
                    f.write(text)
                try:
                    history_record(req.get('batch'), norm, '', text)
                except OSError as e:
                    BUILDER.log(f'history: {e}')
                BUILDER.log(f'saved {norm} (created again)')
                BUILDER.request()
                return self.send(200, {'hash': sha(text)})
            if name not in paper_files():
                return self.send(400, {'error': 'not a file of this document'})
            current = read(name)
            if sha(current) != base:
                return self.send(409, {'error': 'changed on disk', 'hash': sha(current)})
            path = os.path.join(PAPER, name)
            if text == current:
                return self.send(200, {'hash': sha(text)})
            try:
                history_put(current)
            except OSError as e:
                # no history, no save: the version on disk must stay recoverable
                return self.send(500, {'error': f'could not keep the previous version ({e}); nothing was written'})
            tmp = None
            try:
                with tempfile.NamedTemporaryFile('w', encoding='utf-8', newline='',
                                                 dir=os.path.dirname(path), prefix='.editor-', suffix='.tmp',
                                                 delete=False) as f:
                    tmp = f.name
                    f.write(text)
                    f.flush()
                    os.fsync(f.fileno())
                # the temporary file is private (0600): give it the file's own mode
                os.chmod(tmp, stat.S_IMODE(os.stat(path).st_mode))
                os.replace(tmp, path)
            except OSError as e:
                return self.send(500, {'error': f'could not write {name}: {e.strerror or e}'})
            finally:
                if tmp and os.path.exists(tmp):
                    os.unlink(tmp)
            try:
                history_record(req.get('batch'), name, current, text)
            except OSError as e:
                BUILDER.log(f'history: {e}')
        BUILDER.log(f'saved {name}')
        BUILDER.request()
        self.send(200, {'hash': sha(text)})

    def tts(self, query):
        engine = query.get('engine', [''])[0]
        voice = query.get('voice', [''])[0]
        text = query.get('text', [''])[0]
        if not text:
            return self.send(400, {'error': 'no text'})
        try:
            audio, ctype = speak(engine, voice, text)
        except TTSError as e:
            return self.send(503, {'error': str(e)})
        self.send(200, audio, ctype)


def open_paper(path, cwd=None, state=None):
    """Point the editor at a main file (path relative to PAPER or absolute)."""
    global PAPER, MAIN, ROOT, STATE, CACHE, CONFIG, VOICES
    path = os.path.abspath(path)
    PAPER = os.path.abspath(cwd) if cwd else os.path.dirname(path)
    MAIN = os.path.relpath(path, PAPER)
    r = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=os.path.dirname(path),
                       capture_output=True, text=True, errors='replace')
    ROOT = r.stdout.strip() if r.returncode == 0 else PAPER
    STATE = os.path.abspath(state) if state else os.path.join(os.path.dirname(path), '.paper-editor')
    CACHE = os.path.join(STATE, 'cache')
    CONFIG = json.loads(json.dumps(DEFAULT_CONFIG))
    for cfg in (os.path.join(os.path.dirname(path), '.paper-editor.json'), os.path.join(STATE, 'config.json')):
        if os.path.exists(cfg):
            CONFIG.update(json.load(open(cfg)))
    _bib.update(entries=None, stamp=None)


def load_token():
    """The key a page sends with every write: kept in the project's cache, so
    that a page left open across a restart of the editor can still save."""
    global TOKEN
    p = os.path.join(CACHE, 'token')
    try:
        with open(p) as f:
            t = f.read().strip()
        if re.fullmatch(r'[0-9a-f]{32}', t):
            TOKEN = t
            return
    except OSError:
        pass
    try:
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(TOKEN)
    except OSError:
        pass        # a new key at every start, then


def ensure_state():
    """Create <project>/.paper-editor; generated data stays untracked."""
    os.makedirs(CACHE, exist_ok=True)
    gi = os.path.join(STATE, '.gitignore')
    if not os.path.exists(gi):
        with open(gi, 'w') as f:
            f.write('# written by paper-editor: generated data is not worth tracking\ncache/\nhistory/\ndebug/\n')
    else:
        with open(gi) as f:
            lines = f.read().splitlines()
        missing = [name for name in ('cache/', 'history/', 'debug/') if name not in lines]
        if missing:
            with open(gi, 'a') as f:
                f.write(('' if not lines or lines[-1] == '' else '\n') + '\n'.join(missing) + '\n')


# ------------------------------------------------------------------ save history
#
# Every save keeps the text it replaced and the text it wrote, so that any
# earlier version can be brought back: <state>/history/blobs/<sha1> (each
# text once) and <state>/history/log.jsonl, one line per file saved:
# {"batch", "t", "name", "before", "after"}.  A batch is one press of Save.

HISTORY_KEEP = 3000          # log lines kept; texts no line refers to are deleted
_history_lock = threading.Lock()


def history_dir():
    return os.path.join(STATE, 'history')


def history_put(text):
    h = sha(text)
    d = os.path.join(history_dir(), 'blobs')
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, h)
    if not os.path.exists(p):
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
        os.replace(tmp, p)
    return h


def history_get(h):
    if not re.fullmatch(r'[0-9a-f]{40}', h or ''):
        return None
    p = os.path.join(history_dir(), 'blobs', h)
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8', newline='') as f:
        return f.read()


def history_entries():
    p = os.path.join(history_dir(), 'log.jsonl')
    out = []
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue          # a line cut short by a crash: skip it
                if isinstance(e, dict) and e.get('name') and e.get('before') and e.get('after'):
                    out.append(e)
    return out


def history_record(batch, name, before, after):
    """Keep both texts of a save; called before the file is written."""
    with _history_lock:
        entry = {'batch': str(batch or secrets.token_hex(6))[:40], 't': time.time(), 'name': name,
                 'before': history_put(before), 'after': history_put(after)}
        os.makedirs(history_dir(), exist_ok=True)
        log = os.path.join(history_dir(), 'log.jsonl')
        with open(log, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry) + '\n')
            f.flush()
            os.fsync(f.fileno())
        entries = history_entries()
        if len(entries) > HISTORY_KEEP:
            keep = entries[-HISTORY_KEEP:]
            tmp = log + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                f.writelines(json.dumps(e) + '\n' for e in keep)
            os.replace(tmp, log)
            used = {e['before'] for e in keep} | {e['after'] for e in keep}
            d = os.path.join(history_dir(), 'blobs')
            for b in os.listdir(d):
                if b not in used:
                    os.unlink(os.path.join(d, b))


def history_delete(batch=None):
    """Discard a save batch, or all save snapshots; never touches paper files.

    Retained content blobs are garbage-collected after the log is updated.
    Serialize with history_record so a concurrent save cannot be lost.
    """
    with _history_lock:
        entries = history_entries()
        keep = [e for e in entries if e['batch'] != batch] if batch is not None else []
        removed = len(entries) - len(keep)
        if not removed:
            return 0
        directory = history_dir()
        os.makedirs(directory, exist_ok=True)
        log = os.path.join(directory, 'log.jsonl')
        tmp = log + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as out:
            out.writelines(json.dumps(e) + '\n' for e in keep)
        os.replace(tmp, log)
        used = {e['before'] for e in keep} | {e['after'] for e in keep}
        blobs = os.path.join(directory, 'blobs')
        if os.path.isdir(blobs):
            for name in os.listdir(blobs):
                if name not in used and re.fullmatch(r'[0-9a-f]{40}', name):
                    os.unlink(os.path.join(blobs, name))
        return removed


def history_list(limit=300):
    """The saves, newest first: {batch, t, files: [{name, before, after}]}."""
    batches = {}
    order = []
    for e in history_entries():
        b = batches.get(e['batch'])
        if b is None:
            b = batches[e['batch']] = {'batch': e['batch'], 't': e['t'], 'files': []}
            order.append(b)
        b['files'].append({'name': e['name'], 'before': e['before'], 'after': e['after']})
        b['t'] = max(b['t'], e['t'])
    return order[::-1][:limit]


def open_browser(url, browser):
    if browser in ('chrome', 'chrome-app'):
        executables = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
        if sys.platform == 'darwin':
            executables += [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
            ]
        elif os.name == 'nt':
            for root in (os.environ.get('PROGRAMFILES'), os.environ.get('PROGRAMFILES(X86)'), os.environ.get('LOCALAPPDATA')):
                if root:
                    executables += [
                        os.path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                        os.path.join(root, 'Chromium', 'Application', 'chrome.exe'),
                    ]
        for executable in executables:
            found = executable if os.path.isfile(executable) else shutil.which(executable)
            if found:
                if browser == 'chrome-app':
                    subprocess.Popen([found, '--app=' + url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    webbrowser.BackgroundBrowser(found).open(url)
                return
        print('Chrome/Chromium was not found; opening the system browser.', flush=True)
    webbrowser.open(url)


def choose_directory():
    commands = []
    if sys.platform == 'darwin':
        commands.append(['osascript', '-e', 'POSIX path of (choose folder with prompt "Open paper directory")'])
    elif os.name == 'nt':
        script = ('Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; '
                  'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }')
        commands.append(['powershell', '-NoProfile', '-Command', script])
    else:
        commands += [
            ['zenity', '--file-selection', '--directory', '--title=Open paper directory'],
            ['kdialog', '--getexistingdirectory', os.path.expanduser('~')],
        ]
    for command in commands:
        if not shutil.which(command[0]):
            continue
        try:
            result = subprocess.run(command, capture_output=True, text=True, errors='replace', timeout=300)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0 and result.stdout.strip():
            return os.path.abspath(result.stdout.strip())
    return None


def main():
    global BUILDER
    ap = argparse.ArgumentParser(description='A local reading editor for a LaTeX paper.')
    ap.add_argument('path', help='a project folder, or its main .tex file')
    ap.add_argument('--main', help='the main file, when the folder has several documents')
    ap.add_argument('--cwd', help='the directory LaTeX runs in (default: the main file\'s directory)')
    ap.add_argument('--state', help='where to keep settings and caches (default: <project>/.paper-editor)')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--browser', choices=('chrome-app', 'chrome', 'system'), default='chrome-app',
                    help='browser to open (default: standalone Chrome app window)')
    ap.add_argument('--no-open', action='store_true', help='do not open a browser')
    args = ap.parse_args()
    path = os.path.abspath(args.path)
    if os.path.isdir(path):
        mains = [args.main] if args.main else find_mains(path)
        if not mains:
            ap.error(f'{args.path}: no LaTeX document (\\documentclass ... \\begin{{document}}) in this folder')
        if len(mains) > 1 and not args.main:
            print(f'documents in {args.path}: {", ".join(mains)}; opening {mains[0]} (switch in the page, or --main)')
        path = os.path.join(path, mains[0])
    if not os.path.isfile(path):
        ap.error(f'{args.path}: no such file')
    open_paper(path, args.cwd, args.state)
    ensure_state()
    load_token()
    BUILDER = Builder()
    threading.Thread(target=lambda: bib_entries(), daemon=True).start()   # index the .bib files now, not at the first search
    threading.Thread(target=bib_entries, daemon=True).start()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://127.0.0.1:{args.port}/'
    print(f'Crypto Paper Reviewer for {os.path.join(PAPER, MAIN)} on {url}  (Ctrl+C to stop)', flush=True)
    if not args.no_open:
        threading.Timer(0.5, lambda: open_browser(url, args.browser)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    sys.exit(main())
