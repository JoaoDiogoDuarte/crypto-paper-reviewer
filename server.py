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
import html
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
import unicodedata
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
    # the editor that "Open in your editor" runs: a list of arguments where
    # {file}, {line} and {col} are replaced, e.g. ["code", "-g", "{file}:{line}:{col}"]
    # (default: emacsclient, else VS Code, else the system's opener)
    'external_editor': None,
    # the language the browser checks the spelling of the paper's text in
    'spell_lang': 'en-GB',
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


def expanded_source(folder, name, seen=None):
    """A .tex file of `folder` with the local files it \\input or \\include
    spliced in (comments removed), so that a main file whose \\documentclass
    sits in an \\input{preamble}, or a wrapper that only sets a flag and
    \\inputs main.tex, still reads as a document."""
    seen = set() if seen is None else seen
    path = os.path.normpath(os.path.join(folder, name))
    if path in seen or len(seen) > 200 or not os.path.isfile(path):
        return ''
    seen.add(path)
    try:
        with open(path, encoding='utf-8', errors='replace') as source:
            text = strip_comments(source.read())
    except OSError:
        return ''

    def splice(m):
        arg = m.group(1).strip()
        for cand in (arg, arg + '.tex'):
            if os.path.isfile(os.path.join(folder, cand)):
                return expanded_source(folder, cand, seen)
        return ''
    return INPUT_RE.sub(splice, text)


def find_mains(folder):
    """The .tex files of a folder that are documents (\\documentclass and
    \\begin{document}, directly or through files they \\input), the most
    recently built first; a wrapper that only \\inputs another document
    (a second edition of the same paper) comes after the documents."""
    out = []
    for f in sorted(os.listdir(folder)):
        p = os.path.join(folder, f)
        if f.endswith('.tex') and os.path.isfile(p):
            t = expanded_source(folder, f)
            if re.search(r'\\documentclass', t) and re.search(r'\\begin\s*\{document\}', t):
                built = [os.path.getmtime(os.path.join(folder, f[:-4] + e)) for e in ('.aux', '.pdf')
                         if os.path.exists(os.path.join(folder, f[:-4] + e))]
                own = strip_comments(read_path(p))
                wrapper = not re.search(r'\\begin\s*\{document\}', own)
                out.append((wrapper, -(max(built) if built else 0), f != 'main.tex', f))
    out.sort()
    return [x[-1] for x in out]


def read_path(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as source:
            return source.read()
    except OSError:
        return ''


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


def spliced_preamble(whole=False):
    """The main file up to \\begin{document}, with the local files it \\input
    or \\include spliced in where they stand (comments removed): a wrapper's
    \\def before its \\input{main} comes before the preamble that tests it,
    as in TeX.  Files after \\begin{document} are not read, unless whole:
    then it is the whole document."""
    seen, out = set(), []
    begin = re.compile(r'\\begin\s*\{document\}')

    def splice(name, depth):
        """False once \\begin{document} is reached."""
        if name in seen or depth > 12:
            return True
        seen.add(name)
        text, pos = strip_comments(read(name)), 0
        for m in INPUT_RE.finditer(text):
            b = None if whole else begin.search(text, pos, m.start())
            if b:
                out.append(text[pos:b.start()])
                return False
            out.append(text[pos:m.start()])
            pos = m.end()
            f = resolve_input(m.group(1))
            if not (f and f.endswith('.tex')):
                out.append(m.group(0))
            elif not splice(f, depth + 1):
                return False
        b = None if whole else begin.search(text, pos)
        out.append(text[pos:b.start()] if b else text[pos:])
        return not b
    splice(MAIN, 0)
    return ''.join(out)


def preamble_text():
    """Everything before \\begin{document}, with local files it inputs spliced
    in, the branches of decidable conditionals TeX would skip left out
    (convert.active_tex), and .sty files of the paper's directory it loads
    appended."""
    pre = convert.active_tex(spliced_preamble())
    out, seen = [pre], set()

    def expand(text):
        for m in INPUT_RE.finditer(strip_comments(text)):
            f = resolve_input(m.group(1))
            if f and f not in seen and not f.endswith('.tex'):
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
    """The class, with its options after a slash (IEEEtran/conference), as
    LaTeX would load it: a \\documentclass in an \\input file or in one
    branch of an \\if counts."""
    m = re.search(r'\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}', preamble_text())
    if not m:
        return 'article'
    return m.group(2).strip() + ('/' + m.group(1) if m.group(1) else '')


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
            # without cleveref the kind is the counter of hyperref's anchor
            # ({1}{2}{title}{theorem.1}{}), which is what \autoref names
            parts = []
            try:
                i = 0
                while i < len(body) and body[i] == '{' and len(parts) < 4:
                    g, i = group(body, i)
                    parts.append(g)
            except (IndexError, AssertionError):
                parts = []
            a = re.match(r'([A-Za-z*]+)\.', parts[3]) if len(parts) > 3 else None
            if a:
                kind = a.group(1).rstrip('*')
                kind = {'Item': 'enumi', 'AMS': 'equation'}.get(kind, kind)
                labels[key].setdefault('anchor', kind)
    for lab in labels.values():
        if 'anchor' in lab:
            if not lab.get('type'):
                lab['type'] = lab['anchor']
            del lab['anchor']
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
        # numeric styles: biber writes no labelnumber (and, without
        # defernumbers, biblatex writes no \abx@aux@number): the number is the
        # entry's place in the sorted list, the refcontext's datalist (else the
        # first one), counting only entries that get a label
        lists = re.findall(r'\\datalist\[entry\]\{([^}]*)\}(.*?)\\enddatalist', btext, re.S)
        ctx = re.search(r'\\abx@aux@refcontext\{([^}]*)\}', aux)
        sorted_list = next((b for n, b in lists if ctx and n == ctx.group(1)), lists[0][1] if lists else '')
        n = 0
        for m in re.finditer(r'\\entry\{([^}]*)\}(.*?)\\endentry', sorted_list, re.S):
            if re.search(r'\\field\{labelalpha\}', m.group(2)):
                break             # an alphabetic style: labels come from labelalpha below
            if re.search(r'\\field\{options\}\{[^}]*\bskip(?:lab|biblist)\b', m.group(2)):
                continue
            n += 1
            cites.setdefault(m.group(1), str(n))
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
    if docclass().split('/')[0] in ('llncs', 'svjour', 'svjour3', 'lncs') or not th:
        for env, name in THEOREM_DEFAULTS.items():
            th.setdefault(env, {'name': name, 'counter': 'theorem' if env != 'definition' else env})
    return th


XCOLOR_BASE = {'red': (255, 0, 0), 'green': (0, 255, 0), 'blue': (0, 0, 255), 'black': (0, 0, 0), 'white': (255, 255, 255),
               'gray': (128, 128, 128), 'darkgray': (64, 64, 64), 'lightgray': (191, 191, 191), 'cyan': (0, 255, 255),
               'magenta': (255, 0, 255), 'yellow': (255, 255, 0), 'orange': (255, 128, 0), 'violet': (128, 0, 128),
               'purple': (191, 0, 64), 'brown': (191, 128, 64), 'teal': (0, 128, 128), 'olive': (128, 128, 0),
               'lime': (191, 255, 0), 'pink': (255, 191, 191)}


def color_value(expr, known):
    """An xcolor expression (name, name!pct, name!pct!other …) as RGB, or None."""
    parts = [p.strip() for p in expr.split('!')]
    if not parts or parts[0] not in known:
        return None
    rgb = known[parts[0]]
    i = 1
    while i < len(parts):
        try:
            pct = float(parts[i]) / 100
        except ValueError:
            return None
        other = known.get(parts[i + 1], None) if i + 1 < len(parts) else (255, 255, 255)
        if other is None:
            return None
        rgb = tuple(round(a * pct + b * (1 - pct)) for a, b in zip(rgb, other))
        i += 2
    return rgb


def paper_colors():
    """The colours the preamble defines (\\definecolor, \\colorlet), as #rrggbb,
    and the TikZ styles that draw in a colour picked by their argument
    (\\tikzset{gbox/.style={draw=g#1}}: gbox=one draws in gone)."""
    pre = strip_comments(preamble_text())
    known = dict(XCOLOR_BASE)
    out = {}
    for m in re.finditer(r'\\(definecolor|colorlet)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}(?:\s*\{([^}]*)\})?', pre):
        kind, name, a, b = m.group(1), m.group(2).strip(), m.group(3).strip(), (m.group(4) or '').strip()
        rgb = None
        try:
            if kind == 'colorlet':
                rgb = color_value(a, known)
            elif a.lower() == 'html':
                rgb = tuple(int(b[k:k + 2], 16) for k in (0, 2, 4))
            elif a == 'RGB':
                rgb = tuple(int(float(x)) for x in b.split(','))
            elif a == 'rgb':
                rgb = tuple(round(float(x) * 255) for x in b.split(','))
            elif a == 'gray':
                rgb = (round(float(b) * 255),) * 3
            elif a == 'cmyk':
                c, m_, y, k = (float(x) for x in b.split(','))
                rgb = tuple(round(255 * (1 - v) * (1 - k)) for v in (c, m_, y))
        except (ValueError, IndexError):
            rgb = None
        if rgb and len(rgb) == 3:
            known[name] = rgb
            out[name] = '#%02x%02x%02x' % rgb
    styles = {}
    for m in re.finditer(r'([A-Za-z][\w ]*)/\.style\s*=\s*\{([^{}]*)\}', pre):
        d = re.search(r'(?:draw|color|fill)\s*=\s*([^,]+)', m.group(2))
        if d:
            styles[m.group(1).strip()] = d.group(1).strip()
    return {'colors': out, 'styles': styles}


def uses_graphicx():
    """Whether \\includegraphics is available: graphicx (or graphics) in the
    preamble, or a class that loads it."""
    if docclass().split('/')[0] in ('iacrcc', 'iacrtrans', 'acmart', 'lipics-v2021', 'lipics-v2019', 'beamer'):
        return True
    return bool(re.search(r'\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\bgraphicx?\b',
                          strip_comments(preamble_text())))


def cref_config():
    """How cleveref names references in this paper: its package options, the
    \\crefname / \\Crefname of the preamble (and of local .sty files, such as
    iacrcc's after-hyperref.sty), and the figure name of the captions."""
    texts = [strip_comments(preamble_text())]
    try:
        for f in sorted(os.listdir(PAPER)):
            if f.endswith('.sty'):
                texts.append(strip_comments(read(f)))
    except OSError:
        pass
    text = '\n'.join(texts)
    opts = []
    for m in re.finditer(r'\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}', text):
        if 'cleveref' in [p.strip() for p in m.group(2).split(',')] and m.group(1):
            opts += [o.strip() for o in m.group(1).split(',') if o.strip()]
    names, caps = {}, {}
    for m in re.finditer(r'\\(c|C)refname\s*\{([^}]*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}', text):
        (names if m.group(1) == 'c' else caps)[m.group(2).strip()] = [m.group(3).replace('~', ' '), m.group(4).replace('~', ' ')]
    fig = 'Fig.' if docclass().split('/')[0] in ('llncs', 'lncs', 'svjour', 'svjour3', 'IEEEtran') else 'Figure'
    m = re.search(r'\\(?:renewcommand\s*\{?\\figurename\}?|def\\figurename)\s*\{([^}]*)\}', text)
    if m:
        fig = m.group(1).replace('~', ' ').strip()
    return {'options': opts, 'names': names, 'Names': caps, 'figurename': fig}


# ------------------------------------------------------------------ listings
#
# \lstinputlisting[opts]{file} and the paper's own macros around it (the
# threshold paper's \ecsnippet{TSGame.ec}{name} reads ../TSGame.ec between the
# markers (*> name *) and (*< name *)) are shown as the code they typeset.

def lst_options(s):
    """listings key=value options as (key, value) pairs, in order (a key may
    repeat: morekeywords=..., morekeywords=[2]{...}); braces are removed."""
    out, i, n = [], 0, len(s)
    while i < n:
        while i < n and s[i] in ' \t\r\n,':
            i += 1
        k = i
        while i < n and s[i] not in '=,':
            i += 1
        key = s[k:i].strip()
        val = ''
        if i < n and s[i] == '=':
            i += 1
            v = i
            depth = 0
            while i < n and not (s[i] == ',' and depth == 0):
                if s[i] == '\\':
                    i += 2
                    continue
                depth += {'{': 1, '}': -1}.get(s[i], 0)
                i += 1
            val = s[v:i].strip()
            # a value ending in a control space keeps it: rangebeginprefix=(*>\ ,
            if val.endswith('\\') and s[v:i].rstrip() != s[v:i]:
                val += ' '
            if val.startswith('{') and val.endswith('}'):
                try:
                    inner, end = group(val, 0)
                    if end == len(val):
                        val = inner
                except (IndexError, AssertionError):
                    pass
        if key:
            out.append((key, val))
    return out


def lst_word_list(v):
    """morekeywords={a,b} or morekeywords=[2]{a,b}: (class, words)."""
    cls = 1
    m = re.match(r'\s*\[(\d+)\]\s*', v)
    if m:
        cls, v = int(m.group(1)), v[m.end():]
        if v.startswith('{') and v.endswith('}'):
            v = v[1:-1]
    return cls, [w.strip() for w in v.split(',') if w.strip()]


def lst_definitions(pre):
    """\\lstdefinelanguage and \\lstdefinestyle bodies: (languages, styles), and
    the options of the global \\lstset calls."""
    langs, styles, sets = {}, {}, []
    for m in re.finditer(r'\\lstdefine(language|style)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}\s*(?:\[[^\]]*\]\s*\{[^}]*\}\s*)?(?=\{)', pre):
        try:
            body, _ = group(pre, m.end())
        except (IndexError, AssertionError):
            continue
        (langs if m.group(1) == 'language' else styles)[m.group(2).strip().lower()] = lst_options(body)
    for m in re.finditer(r'\\lstset\s*(?=\{)', pre):
        try:
            sets.append(lst_options(group(pre, m.end())[0]))
        except (IndexError, AssertionError):
            continue
    return langs, styles, sets


def lst_effective(opts, langs, styles, depth=0):
    """Options with style= and language= expanded (theirs first, then these)."""
    out = []
    for k, v in opts:
        if k == 'style' and depth < 8 and v.strip().lower() in styles:
            out += lst_effective(styles[v.strip().lower()], langs, styles, depth + 1)
        elif k == 'language' and depth < 8:
            name = re.sub(r'^\[[^\]]*\]', '', v).strip().lower()
            out.append((k, name))
            if name in langs:
                out += lst_effective(langs[name], langs, styles, depth + 1)
        else:
            out.append((k, v))
    return out


def lst_language(eff):
    """Keywords by class, comment and string delimiters, for highlighting."""
    kws, comments, line_comments, strings = {}, [], [], []
    for k, v in eff:
        if k in ('morekeywords', 'keywords', 'morendkeywords', 'ndkeywords', 'emph', 'moreemph'):
            cls, words = lst_word_list(v)
            if k in ('morendkeywords', 'ndkeywords'):
                cls = 2
            if k in ('keywords', 'ndkeywords') and cls in kws:
                kws[cls] = []
            kws.setdefault(cls, [])
            kws[cls] += [w for w in words if w not in kws[cls]]
        elif k in ('morecomment', 'comment'):
            m = re.match(r'\s*\[([a-z]+)\]\s*\{([^{}]*)\}(?:\s*\{([^{}]*)\})?', v)
            if m and m.group(1) == 'l':
                line_comments.append(m.group(2))
            elif m and m.group(3) is not None:
                comments.append([m.group(2), m.group(3), m.group(1) == 'n'])
        elif k in ('morestring', 'string'):
            m = re.match(r'\s*\[[a-z]+\]\s*\{?([^{}])\}?', v)
            if m:
                strings.append(m.group(1))
    # a word listed in a higher class is shown in that class
    for c in sorted(kws):
        for d in kws:
            if d > c:
                kws[c] = [w for w in kws[c] if w not in kws[d]]
    uniq = lambda xs: [x for i, x in enumerate(xs) if x not in xs[:i]]
    return {'keywords': {str(c): w for c, w in kws.items()}, 'comments': uniq(comments),
            'line_comments': uniq(line_comments), 'strings': uniq(strings)}


def lst_value(eff, key, default=None):
    for k, v in reversed(eff):
        if k == key:
            return v
    return default


def listing_macros(pre=None):
    """The paper's macros whose body reads a file with \\lstinputlisting:
    name -> (number of arguments, body)."""
    pre = strip_comments(preamble_text()) if pre is None else pre
    out = {}
    for m in re.finditer(r'\\(?:re|provide)?newcommand\*?\s*(?:\{\\([A-Za-z@]+)\}|\\([A-Za-z@]+))'
                         r'\s*(?:\[(\d)\])?\s*(?=\{)', pre):
        try:
            body, _ = group(pre, m.end())
        except (IndexError, AssertionError):
            continue
        if '\\lstinputlisting' in body:
            out[m.group(1) or m.group(2)] = (int(m.group(3) or 0), body)
    return out


def listing_root():
    """Listings may read files of the project (its git work tree), or of the
    folder above the paper (a paper in note/ beside its .ec files)."""
    return os.path.realpath(ROOT if ROOT and ROOT != PAPER else os.path.dirname(PAPER))


def tex_unescape_title(t):
    t = re.sub(r'\\detokenize\s*\{([^{}]*)\}', r'{\1}', t)
    return bib_plain(t)


def read_listing(opts_text, path_arg, pre=None):
    """The code an \\lstinputlisting typesets: {title, file, code} or {error}."""
    pre = strip_comments(preamble_text()) if pre is None else pre
    langs, styles, sets = lst_definitions(pre)
    base = []
    for s in sets:
        base += s
    eff = lst_effective(base + lst_options(opts_text or ''), langs, styles)
    name = path_arg.strip()
    path = os.path.realpath(os.path.join(PAPER, name))
    root = listing_root()
    if not (path == root or path.startswith(root + os.sep)):
        return {'error': f'{name} is outside the project'}
    if not os.path.isfile(path):
        for d in (lst_value(eff, 'inputpath'),):
            if d and os.path.isfile(os.path.realpath(os.path.join(PAPER, d, name))):
                path = os.path.realpath(os.path.join(PAPER, d, name))
                break
        else:
            return {'error': f'{name} not found'}
    if os.path.getsize(path) > 4_000_000:
        return {'error': f'{name} is too large to show'}
    lines = read_path(path).split('\n')
    sel = None
    rng = lst_value(eff, 'linerange')
    if rng:
        sp = lambda k, d='': (lst_value(eff, k, d) or '').replace('\\ ', ' ').replace('\\', '')
        bp, bs, ep, es = sp('rangebeginprefix', sp('rangeprefix')), sp('rangebeginsuffix', sp('rangesuffix')), \
            sp('rangeendprefix', sp('rangeprefix')), sp('rangeendsuffix', sp('rangesuffix'))
        include = (lst_value(eff, 'includerangemarker', 'true') or 'true').strip() != 'false'
        sel = []
        for part in rng.split(','):
            a, _, b = part.strip().partition('-')
            a, b = a.strip(), (b.strip() or a.strip())
            if re.fullmatch(r'\d*', a) and re.fullmatch(r'\d*', b):
                lo = int(a) if a else 1
                hi = int(b) if b else len(lines)
                sel += lines[lo - 1:hi]
                continue
            start = next((i for i, ln in enumerate(lines) if (bp + a + bs).strip() in ln), None)
            if start is None:
                return {'error': f'no marker {bp + a + bs!r} in {name}', 'file': name}
            end = next((i for i in range(start + 1, len(lines)) if (ep + b + es).strip() in lines[i]), len(lines) - 1)
            sel += lines[start:end + 1] if include else lines[start + 1:end]
    else:
        first = int(lst_value(eff, 'firstline', '1') or 1)
        last = lst_value(eff, 'lastline')
        sel = lines[first - 1:int(last) if last else None]
    # common indentation off, as gobble would
    code = '\n'.join(sel).rstrip('\n')
    title = lst_value(eff, 'title') or lst_value(eff, 'caption')
    return {'title': tex_unescape_title(title) if title else '', 'file': os.path.relpath(path, PAPER),
            'code': code, 'language': lst_language(eff)}


def expand_listing(src, pre=None):
    """Every listing a piece of source typesets, in order: a direct
    \\lstinputlisting or one of the paper's macros around it."""
    pre = strip_comments(preamble_text()) if pre is None else pre
    macros = listing_macros(pre)
    out = []
    names = '|'.join(re.escape(n) for n in sorted(macros, key=len, reverse=True))
    pat = re.compile(r'\\(lstinputlisting' + ('|' + names if names else '') + r')(?![A-Za-z@])')
    for m in pat.finditer(src):
        i = m.end()
        try:
            if m.group(1) == 'lstinputlisting':
                body = src[m.start():]
                opts = ''
                j = len('\\lstinputlisting')
                while j < len(body) and body[j] in ' \t\n':
                    j += 1
                if j < len(body) and body[j] == '[':
                    k = body.index(']', j)
                    opts, j = body[j + 1:k], k + 1
                while body[j] in ' \t\n':
                    j += 1
                arg, _ = group(body, j)
                out.append(read_listing(opts, arg, pre))
                continue
            n, body = macros[m.group(1)]
            args = []
            for _ in range(n):
                while src[i] in ' \t\n':
                    i += 1
                a, i = group(src, i)
                args.append(a)
            for k, a in enumerate(args, 1):
                body = body.replace('#%d' % k, a)
            for r in expand_listing(body, pre):
                out.append(r)
        except (IndexError, AssertionError, ValueError):
            out.append({'error': 'could not read ' + src[m.start():m.start() + 60]})
    return out


def inline_lst_languages():
    """Highlighting for listings written in the paper (lstlisting, a wrapper
    such as ecblock around one): the global \\lstset ('base'), and each
    \\lstdefinelanguage and \\lstdefinestyle on top of it, by lower-case name,
    for a listing that picks one with language= or style=."""
    try:
        langs, styles, sets = lst_definitions(strip_comments(preamble_text()))
    except Exception:
        return {'base': lst_language([]), 'languages': {}, 'styles': {}}
    base = [kv for s in sets for kv in s]
    return {'base': lst_language(lst_effective(base, langs, styles)),
            'languages': {n: lst_language(lst_effective(base + [('language', n)], langs, styles)) for n in langs},
            'styles': {n: lst_language(lst_effective(base + [('style', n)], langs, styles)) for n in styles}}


def all_listings():
    """The listings of every listing command of the paper, by source text."""
    pre = strip_comments(preamble_text())
    macros = listing_macros(pre)
    names = ['lstinputlisting'] + list(macros)
    pat = re.compile(r'\\(?:' + '|'.join(re.escape(n) for n in names) + r')(?![A-Za-z@])')
    out = {}
    for name in paper_files():
        text = read(name)
        body = text.find('\\begin{document}') if name == MAIN else -1
        for m in pat.finditer(text):
            line = text[text.rfind('\n', 0, m.start()) + 1:m.start()]
            if m.start() < body or re.search(r'(?<!\\)%', line):
                continue      # the preamble that defines it, or a comment
            # the command with its arguments, as written
            j, nargs = m.end(), macros.get(text[m.start() + 1:m.end()], (1, ''))[0]
            try:
                if text[m.start() + 1:m.end()] == 'lstinputlisting':
                    while text[j] in ' \t\n':
                        j += 1
                    if text[j] == '[':
                        j = text.index(']', j) + 1
                    while text[j] in ' \t\n':
                        j += 1
                    _, j = group(text, j)
                else:
                    for _ in range(nargs):
                        while text[j] in ' \t\n':
                            j += 1
                        _, j = group(text, j)
            except (IndexError, AssertionError, ValueError):
                continue
            src = text[m.start():j]
            if src not in out:
                out[src] = expand_listing(src, pre)
    return out


BIB_ACCENTS = {"'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304',
               '.': '\u0307', 'H': '\u030b', 'c': '\u0327', 'v': '\u030c', 'u': '\u0306', 'k': '\u0328',
               'r': '\u030a'}
BIB_LETTERS = {'ss': 'ß', 'o': 'ø', 'O': 'Ø', 'ae': 'æ', 'AE': 'Æ', 'oe': 'œ', 'OE': 'Œ', 'aa': 'å', 'AA': 'Å',
               'l': 'ł', 'L': 'Ł', 'i': 'ı', 'j': 'ȷ', 'dh': 'ð', 'th': 'þ', 'textendash': '–', 'textemdash': '—',
               'etalchar': '', 'and': 'and', 'ldots': '…', 'dots': '…'}


def bib_plain(t):
    """A .bbl entry as plain readable text: accents as letters, dashes and
    ties as printed, links as their text, no LaTeX left, one line."""
    t = re.sub(r'(?<!\\)%[^\n]*\n\s*', '', t)
    t = re.sub(r'\\newblock\b', ' ', t)
    t = re.sub(r'\\BIBentry(?:ALT|STD)interwordspacing|\\BIBdecl[A-Za-z]*', '', t)
    t = re.sub(r'\\(?:showDOI|showISBNx|showISSN|showURL|urldef)\s*\{([^{}]*)\}', r'{\1}', t)
    t = re.sub(r'\\bib(?:field|info)\s*\{[^{}]*\}', '', t)
    # \href{url}{text} -> text; \url{u}, \path{u}, \nolinkurl{u} -> u; \doi{x} -> doi:x
    t = re.sub(r'\\href\s*\{[^{}]*\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}', r'{\1}', t)
    t = re.sub(r'\\(?:url|path|nolinkurl|texttt)\s*\{([^{}]*)\}', r'{\1}', t)
    t = re.sub(r'\\doi\s*\{([^{}]*)\}', r'{doi:\1}', t)
    t = re.sub(r'\\etalchar\s*\{([^{}]*)\}', r'{\1}', t)

    def accent(m):
        base = m.group(2) or m.group(3)
        base = {'\\i': 'i', '\\j': 'j'}.get(base, base)
        return unicodedata.normalize('NFC', base + BIB_ACCENTS[m.group(1)])
    # \'e, \'{e}, {\'e}, \'\i, \c{c}, \v s
    t = re.sub(r'\\([\'`^"~=.])\s*(?:\{\s*(\\?[A-Za-z])\s*\}|(\\[ij](?![A-Za-z])|[A-Za-z]))', accent, t)
    t = re.sub(r'\\([Hcvukr])(?:\s*\{\s*(\\?[A-Za-z])\s*\}|\s+(\\[ij](?![A-Za-z])|[A-Za-z]))', accent, t)
    t = re.sub(r'\\([A-Za-z]+)(?![A-Za-z])\s*(?:\{\})?', lambda m: BIB_LETTERS.get(m.group(1), m.group(0)), t)
    t = t.replace('---', '\u2014').replace('--', '\u2013').replace('``', '\u201c').replace("''", '\u201d')
    t = re.sub(r'(?<!\\)~', '\u00a0', t)
    t = re.sub(r'\\([&%$#_{}])', r'\1', t)
    # any other command: keep what it is applied to
    t = re.sub(r'\\[A-Za-z]+\*?\s*', '', t)
    t = re.sub(r'\\\\|\\[ ,;:!/]', ' ', t)
    t = t.replace('{', '').replace('}', '')
    return re.sub(r'[ \t\r\n]+', ' ', t).strip()


def load_bib():
    """Short entries for the reference list, from main.bbl, as plain text."""
    path = os.path.join(PAPER, stem() + '.bbl')
    if not os.path.exists(path):
        return {}
    bbl = open(path, encoding='utf-8', errors='replace').read()
    out = {}
    # \bibitem{key}, natbib's \bibitem[Author et~al.(2023)]%\n{key}, or an
    # alpha label with nested braces: \bibitem[BCK{\etalchar{+}}22]{key}
    label = r'\[(?:[^\[\]{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\]'
    for m in re.finditer(r'\\bibitem\s*(?:' + label + r')?\s*%?\s*\{([^}]*)\}(.*?)(?=\\bibitem|\\end\{thebibliography\})', bbl, re.S):
        out[m.group(1)] = bib_plain(m.group(2))
    # biblatex
    for m in re.finditer(r'\\entry\{([^}]*)\}(.*?)\\endentry', bbl, re.S):
        title = re.search(r'\\field\{title\}\{(.*?)\}\s*$', m.group(2), re.M)
        names = re.findall(r'family=\{([^}]*)\}', m.group(2))
        year = re.search(r'\\field\{year\}\{(\d+)\}', m.group(2))
        out[m.group(1)] = bib_plain((', '.join(names) + '. ' if names else '') + (title.group(1) if title else '') +
                                    ('. ' + year.group(1) if year else ''))
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
        # run where the main build runs, so paths relative to it (an
        # \lstinputlisting{../x.ec}, which TEXINPUTS cannot find) still resolve
        cmd = ['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-outdir=' + tmp, tex]

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
            # \ps@empty is what \pagestyle{empty} runs; iacrcc redefines
            # \pagestyle to an error, so call it directly
            doc.extend([r'\ps@empty', r'\makeatother', r'\begin{document}',
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
            r = subprocess.run(cmd, cwd=PAPER, env=env, capture_output=True, text=True, errors='replace', timeout=600)
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


# ----------------------------------------------------------------- snippets
#
# A command or picture in running text that the page cannot draw itself
# (\intlongdivision{230}{17}, an inline tikzpicture) is typeset by LaTeX with
# the paper's preamble, one tight page each, and shown as a picture the size
# of the text around it.  The page asks for them (/api/snippets); the cache
# keeps the picture and its size by the source, the preamble and the numbers
# of the labels it references.

SNIP_PENDING = {}            # key -> source, waiting for the builder
SNIP_LOCK = threading.Lock()


def snip_preamble():
    main = read(MAIN)
    cut = main.find('\\begin{document}')
    return main[:cut] if cut >= 0 else None


def snip_key(src, preamble, labels):
    return fig_key('%snippet-v1 ' + sha(preamble or '') + '\n' + src, labels)


def snip_meta(key):
    p = os.path.join(CACHE, key + '.json')
    try:
        with open(p, encoding='utf-8') as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return None
    if meta.get('state') == 'ok':
        meta['url'] = '/fig/' + key + '.png'
    return meta


def snip_put(key, meta):
    tmp = os.path.join(CACHE, key + '.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(meta, f)
    os.replace(tmp, os.path.join(CACHE, key + '.json'))


def snippets_lookup(srcs):
    """What is known of each source; unknown ones are queued for the builder."""
    preamble = snip_preamble()
    labels = load_aux()['labels']
    out, queued = {}, False
    for src in srcs:
        if preamble is None:
            out[src] = {'state': 'error', 'err': 'the main file has no \\begin{document}'}
            continue
        k = snip_key(src, preamble, labels)
        meta = snip_meta(k)
        if meta:
            out[src] = meta
            continue
        with SNIP_LOCK:
            SNIP_PENDING[k] = src
        out[src] = {'state': 'pending'}
        queued = True
    return out, queued


def build_snippets(log):
    """Typeset the waiting snippets; the number settled (drawn, blank or failed)."""
    with SNIP_LOCK:
        todo = list(SNIP_PENDING.items())
        SNIP_PENDING.clear()
    if not todo:
        return 0
    os.makedirs(CACHE, exist_ok=True)
    preamble = snip_preamble()
    labels = load_aux()['labels']
    # the key again: the preamble or a number may have changed since
    todo = [(snip_key(src, preamble, labels), src) for _, src in todo]
    todo = [(k, src) for k, src in todo if not snip_meta(k)]
    if preamble is None or not todo:
        return 0
    env = tex_env(PAPER, os.path.dirname(PAPER), source_root())
    done = 0
    with tempfile.TemporaryDirectory() as tmp:
        tex = os.path.join(tmp, 'snips.tex')
        cmd = ['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-outdir=' + tmp, tex]
        deadline = time.time() + 120
        while True:            # each failed run takes out the snippet that failed
            if not todo:
                break
            if time.time() > deadline:
                # left for the next time the page asks, not taken for failed
                log('snippets: %d left for later' % len(todo))
                return done
            doc = [preamble, r'\makeatletter'] + aux_label_lines() + [
                r'\makeatother', r'\usepackage[active,tightpage]{preview}', r'\setlength\PreviewBorder{0pt}',
                r'\makeatletter\ps@empty\makeatother', r'\begin{document}',
                r'\makeatletter\@ifpackageloaded{lineno}{\nolinenumbers}{}\makeatother',
                r'\newsavebox\pesnipbox', r'\typeout{PE-EM=\the\fontdimen6\font}']
            spans = []
            for _, src in todo:
                first = sum(x.count('\n') + 1 for x in doc) + 1
                doc.append('\\begin{preview}\\sbox\\pesnipbox{%\n' + src + '%\n}\\typeout{PE-SIZE=\\the\\ht\\pesnipbox+'
                           '\\the\\dp\\pesnipbox x\\the\\wd\\pesnipbox}\\usebox\\pesnipbox\\end{preview}')
                spans.append((first, first + src.count('\n') + 2))
            doc.append(r'\end{document}')
            with open(tex, 'w', encoding='utf-8') as out:
                out.write('\n'.join(doc) + '\n')
            for stale in ('snips.pdf', 'snips.aux', 'snips.fdb_latexmk'):
                if os.path.exists(os.path.join(tmp, stale)):
                    os.remove(os.path.join(tmp, stale))
            r = subprocess.run(cmd, cwd=PAPER, env=env, capture_output=True, text=True, errors='replace', timeout=600)
            debug_capture('snippets', cmd, r, [tex, os.path.join(tmp, 'snips.log')], log)
            try:
                with open(os.path.join(tmp, 'snips.log'), encoding='utf-8', errors='replace') as f:
                    tex_log = f.read()
            except OSError:
                tex_log = ''
            if r.returncode == 0 and os.path.exists(os.path.join(tmp, 'snips.pdf')):
                break
            # which snippet stopped LaTeX: the line of the first error
            err = re.search(r'^! (.*)$', tex_log, re.M)
            at = re.search(r'^l\.(\d+)', tex_log[err.end():], re.M) if err else None
            bad = None
            if at:
                line = int(at.group(1))
                bad = next((i for i, (a, b) in enumerate(spans) if a <= line <= b), None)
            message = err.group(1).strip() if err else tex_error(r)
            if bad is None:
                for k, _ in todo:
                    snip_put(k, {'state': 'error', 'err': message})
                log('snippets: ' + message)
                return done + len(todo)
            snip_put(todo[bad][0], {'state': 'error', 'err': message})
            del todo[bad]
            done += 1
        if not todo:
            return done
        em = re.search(r'PE-EM=([\d.]+)pt', tex_log)
        em = float(em.group(1)) if em else 10.0
        sizes = {n: tuple(float(x) for x in m) for n, m in enumerate(
            re.findall(r'PE-SIZE=(-?[\d.]+)pt\+(-?[\d.]+)ptx(-?[\d.]+)pt', tex_log), 1)}
        pdf = os.path.join(tmp, 'snips.pdf')
        for n, (k, src) in enumerate(todo, 1):
            h, d, w = sizes.get(n, (0, 0, 0))
            done += 1
            if w <= 0 or h + d <= 0:
                snip_put(k, {'state': 'blank'})
                continue
            out = os.path.join(CACHE, k)
            png = subprocess.run(['pdftocairo', '-png', '-transp', '-r', '300', '-singlefile', '-f', str(n), '-l', str(n), pdf, out],
                                 capture_output=True, timeout=120)
            if png.returncode != 0 or not os.path.isfile(out + '.png'):
                snip_put(k, {'state': 'error', 'err': 'PNG conversion failed'})
                continue
            snip_put(k, {'state': 'ok', 'w': round(w / em, 3), 'h': round(h / em, 3), 'd': round(d / em, 3)})
    log(f'snippets: {done} settled')
    return done


# ------------------------------------------------------------------ builder

class Builder:
    """Runs latexmk after saves (debounced) and figure rendering."""

    def __init__(self):
        self.lock = threading.Lock()
        self.wanted = threading.Event()
        self.state = {'state': 'idle', 'message': '', 'at': 0}
        self.aux = load_aux()
        self.auxver = 1
        self.figver = 1     # counts the figure cuts: they finish after the PDF build
        self.clean = False
        self.need_build = False
        threading.Thread(target=self.loop, daemon=True).start()

    def log(self, msg):
        print(time.strftime('%H:%M:%S'), msg, flush=True)

    def request(self, clean=False):
        if clean:
            self.clean = True
        self.need_build = True
        self.wanted.set()

    def request_snippets(self):
        self.wanted.set()

    # what LaTeX, BibTeX and latexmk write beside the main file; a clean
    # build starts without them (they are kept in the cache, not deleted)
    BUILD_FILES = ('.aux', '.out', '.fdb_latexmk', '.fls', '.toc', '.lof', '.lot', '.bbl', '.blg',
                   '.bcf', '.run.xml', '.nav', '.snm', '.synctex.gz')

    def clean_files(self):
        backup = os.path.join(CACHE, 'clean', str(time.time_ns()))
        moved = 0
        for suffix in self.BUILD_FILES:
            path = os.path.join(PAPER, stem() + suffix)   # stem() keeps MAIN's subfolder
            if os.path.isfile(path):
                os.makedirs(backup, exist_ok=True)
                shutil.move(path, os.path.join(backup, os.path.basename(path)))
                moved += 1
        self.log(f'build: clean build, {moved} build file(s) moved to {backup}')

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
            # \@writefile, \@newl@bel, \@@BOOKMARK, \abx@aux@... : any of them
            # truncated in the .aux/.out ends the run.  A missing brace in the
            # .tex gives the same message; one retry without the .aux is then
            # merely wasted time, and the error is shown as before.
            recoverable = re.search(r'File ended while scanning use of \\[@A-Za-z]', output)
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

    def figures(self):
        try:
            build_figures(self.log)
        except Exception as e:  # figures are a nicety; never stop the server
            self.log(f'figures: {e}')
        self.figver += 1

    def snippets(self):
        try:
            if build_snippets(self.log):
                self.figver += 1
        except Exception as e:  # a nicety too
            self.log(f'snippets: {e}')
            self.figver += 1

    def loop(self):
        self.figures()
        while True:
            self.wanted.wait()
            # let several saves in a row share one build
            time.sleep(1.5 if self.need_build else 0.3)
            self.wanted.clear()
            if self.need_build:
                self.need_build = False
                if self.clean:
                    self.clean = False
                    try:
                        self.clean_files()
                    except OSError as e:
                        self.log(f'build: clean failed: {e}')
                self.build_once()
                self.figures()
            self.snippets()


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
        base_put(f['text'])
    pages = synctex_pages()
    return {'pages': pages, 'pdftext': [] if pages else pdf_page_texts(), 'docclass': docclass(),
            'main': MAIN, 'path': os.path.join(PAPER, MAIN), 'root': source_root(), 'mains': find_mains(PAPER), 'resolve': input_map(), 'files': files, 'aux': BUILDER.aux, 'auxver': BUILDER.auxver,
            'macros': load_macros(), 'theorems': load_theorems(), 'cref': cref_config(), 'listings': all_listings(), 'listing_macros': sorted(listing_macros()), 'lst_languages': inline_lst_languages(), 'disk_files': source_files(), 'colors': paper_colors(), 'graphicx': uses_graphicx(), 'config': CONFIG,
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


CODE_FILES = ('server.py', 'convert.py')


def code_version():
    """The editor's own code as it is on disk now: a page that sees this
    change reloads itself (where it was), so a new version needs no restart
    by hand."""
    stamps = []
    for name in CODE_FILES:
        try:
            stamps.append(os.path.getmtime(os.path.join(HERE, name)))
        except OSError:
            pass
    for f in sorted(os.listdir(STATIC)):
        if f.endswith(('.js', '.css', '.html', '.svg')):
            try:
                stamps.append(os.path.getmtime(os.path.join(STATIC, f)))
            except OSError:
                pass
    probe = os.environ.get('PE_CODE_PROBE')      # tests: a file of their own stands for the code
    if probe and os.path.exists(probe):
        stamps.append(os.path.getmtime(probe))
    return sha(repr(stamps))[:12]


def state_payload():
    return {'hashes': {n: sha(read(n)) for n in paper_files()}, 'auxver': BUILDER.auxver, 'figver': BUILDER.figver,
            'build': BUILDER.state, 'boxes': box_warnings(), 'code': code_version()}


def watch_own_code(port):
    """When server.py (or convert.py) changes and still compiles, start the
    new version in this process's place: same paper, same port, no new
    window; the page reconnects by itself.  Never during a build."""
    def stamps():
        out = {}
        for name in CODE_FILES:
            try:
                out[name] = os.path.getmtime(os.path.join(HERE, name))
            except OSError:
                pass
        return out
    seen = stamps()
    while True:
        time.sleep(1)
        now = stamps()
        if now == seen:
            continue
        time.sleep(0.5)        # an editor may write in several steps
        now = stamps()
        bad = None
        for name in CODE_FILES:
            r = subprocess.run([sys.executable, '-m', 'py_compile', os.path.join(HERE, name)], capture_output=True, text=True)
            if r.returncode != 0:
                bad = (r.stderr or r.stdout).strip().splitlines()[-1:] or ['does not compile']
        if bad:
            print(f'new code does not compile, still running the old one: {bad[0]}', flush=True)
            seen = now
            continue
        while BUILDER and (BUILDER.state.get('state') == 'running' or BUILDER.wanted.is_set()):
            time.sleep(0.5)
        print('the editor\'s code changed: restarting it on the same port', flush=True)
        argv = [a for a in sys.argv[1:]]
        # the same port, and the paper open now (it may have been opened since)
        for flag in ('--port',):
            while flag in argv:
                i = argv.index(flag)
                del argv[i:i + 2]
        argv = [a for a in argv if not a.startswith('--port=')]
        os.environ['PE_REEXEC'] = '1'
        os.environ['PE_PAPER'] = os.path.join(PAPER, MAIN)
        os.environ['PE_CWD'] = PAPER
        os.environ['PE_STATE'] = STATE
        sys.stdout.flush()
        os.execv(sys.executable, [sys.executable, os.path.abspath(sys.argv[0])] + argv + ['--port', str(port)])


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


def source_files():
    """The .tex and .bib files of the project folder, for the source view:
    hidden folders, the editor's state and build caches are left out."""
    out = []
    skip = {'node_modules', '__pycache__', 'auto', '_minted'}
    state = os.path.realpath(STATE) if STATE else None
    for root, dirs, files in os.walk(PAPER):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in skip
                         and os.path.realpath(os.path.join(root, d)) != state)
        for f in sorted(files):
            if f.endswith(('.tex', '.bib')) and not f.startswith('.'):
                out.append(os.path.relpath(os.path.join(root, f), PAPER))
                if len(out) >= 400:
                    return out
    return out


def bib_target():
    """The .bib file that receives new entries."""
    if CONFIG.get('bib_add_to'):
        return CONFIG['bib_add_to']
    files = bib_files()
    if not files:
        return 'references.bib'
    return min(files, key=lambda b: os.path.getsize(os.path.join(PAPER, b)))
_bib_lock = threading.Lock()
_bib_add_lock = threading.Lock()   # check+write of one /api/bibadd must be atomic


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
        if len(val) >= 2 and (val[0], val[-1]) in (('{', '}'), ('"', '"')) and re.search(r'[&<>"]', val[1:-1]):
            # doi.org serves &amp; &lt; &#x27; …; escape inside the delimiters only
            inner = html.unescape(val[1:-1])
            inner = re.sub(r'(?<!\\)&', r'\\&', inner)
            inner = re.sub(r'(?<!\\)<', r'\\textless{}', inner)
            inner = re.sub(r'(?<!\\)>', r'\\textgreater{}', inner)
            if val[0] == '"':   # a bare " would end the value
                inner = re.sub(r'(?<!\\)"', r'\\textquotedbl{}', inner)
            val = val[0] + inner + val[-1]
        i = k
        if name not in ('url', 'timestamp', 'biburl', 'bibsource', 'issn', 'isbn', 'month'):
            fields.append(f'  {name} = {val},')
    return f'@{typ}{{{key},\n' + '\n'.join(fields) + '\n}'


def online_add(source, ident, key):
    """Fetch the BibTeX of a DOI or arXiv id and append it to references.bib."""
    if not re.fullmatch(r'[A-Za-z0-9:_+.-]+', key or ''):
        raise ValueError('bad key')
    with _bib_add_lock:   # the exists-check and the write are one step
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
        _bib.update(entries=None, stamp=None)   # the index is stale now
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
            # the network stream can stall without erroring: a phrase that
            # never arrives must not hang the reader on that sentence
            audio = asyncio.run(asyncio.wait_for(run(), timeout=30))
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
    """The text of a file at the last git commit (ref 'head'), at any commit
    (its hash), or when the editor opened ('session').  None when there is no
    such version (a new file, or not in git)."""
    if ref == 'session':
        return SESSION_START.get(name)
    rev = 'HEAD' if ref in ('head', '', None) else ref
    if not re.fullmatch(r'[0-9a-f]{7,40}|HEAD', rev):
        return None
    try:
        prefix = subprocess.run(['git', 'rev-parse', '--show-prefix'], cwd=PAPER, capture_output=True,
                                text=True, timeout=10)
        if prefix.returncode != 0:
            return SESSION_START.get(name)
        r = subprocess.run(['git', 'show', rev + ':' + prefix.stdout.strip() + name], cwd=PAPER,
                           capture_output=True, text=True, errors='replace', timeout=20)
        return r.stdout if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def baselines(names, ref):
    """The texts of several files at one version, as baseline() gives them,
    read with one git process for all of them."""
    if ref == 'session':
        return {n: SESSION_START.get(n) for n in names}
    rev = 'HEAD' if ref in ('head', '', None) else ref
    if not re.fullmatch(r'[0-9a-f]{7,40}|HEAD', rev):
        return {n: None for n in names}
    try:
        prefix = subprocess.run(['git', 'rev-parse', '--show-prefix'], cwd=PAPER, capture_output=True,
                                text=True, timeout=10)
        if prefix.returncode != 0:
            return {n: SESSION_START.get(n) for n in names}
        pre = prefix.stdout.strip()
        query = ''.join(f'{rev}:{pre}{n}\n' for n in names).encode()
        r = subprocess.run(['git', 'cat-file', '--batch'], cwd=PAPER, input=query, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return {n: None for n in names}
    out, i, texts = r.stdout, 0, {}
    for n in names:
        # each answer is "<oid> <type> <size>\n<content>\n", or "<query> missing\n"
        j = out.find(b'\n', i)
        if j < 0:
            texts[n] = None
            continue
        head = out[i:j].split()
        if len(head) == 3 and head[1] == b'blob' and head[2].isdigit():
            size = int(head[2])
            texts[n] = out[j + 1:j + 1 + size].decode('utf-8', errors='replace')
            i = j + 1 + size + 1
        else:
            texts[n] = None
            i = j + 1
    return texts


def git_commits(limit=200):
    """The commits that touched the paper's folder, newest first: hash,
    short hash, time, subject, author."""
    try:
        r = subprocess.run(['git', 'log', '-n', str(limit), '--format=%H%x1f%h%x1f%ct%x1f%s%x1f%an', '--', '.'],
                           cwd=PAPER, capture_output=True, text=True, errors='replace', timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if r.returncode != 0:
        return []
    out = []
    for line in r.stdout.splitlines():
        parts = line.split('\x1f')
        if len(parts) == 5:
            out.append({'hash': parts[0], 'short': parts[1], 't': int(parts[2]), 'subject': parts[3], 'author': parts[4]})
    return out


_pages = {'stamp': None, 'map': {}}


_pdftext = {'stamp': None, 'pages': []}


def pdf_page_texts():
    """The text of every page of the built PDF (pdftotext), letters only and
    lower case, for placing blocks on pages when there is no SyncTeX (a
    Makefile build without -synctex)."""
    pdf = os.path.join(PAPER, stem() + '.pdf')
    if not os.path.isfile(pdf):
        return []
    stamp = os.path.getmtime(pdf)
    if _pdftext['stamp'] == stamp:
        return _pdftext['pages']
    # kept on disk too: reading the PDF's text is most of the time of the
    # first page load of a paper built without SyncTeX
    disk = os.path.join(CACHE, 'pdftext.json') if CACHE else None
    try:
        with open(disk, encoding='utf-8') as f:
            c = json.load(f)
        if c.get('stamp') == stamp and isinstance(c.get('pages'), list):
            _pdftext.update(stamp=stamp, pages=c['pages'])
            return c['pages']
    except (OSError, ValueError, TypeError):
        pass
    try:
        r = subprocess.run(['pdftotext', '-enc', 'UTF-8', pdf, '-'], capture_output=True, timeout=60)
        text = r.stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.TimeoutExpired):
        return []
    import unicodedata
    pages = []
    for page in text.split('\f'):
        page = unicodedata.normalize('NFKC', page)
        page = re.sub(r'-\n', '', page)          # words hyphenated at the end of a line
        pages.append(re.sub(r'[^a-z]', '', page.lower()))
    while pages and not pages[-1]:
        pages.pop()
    _pdftext.update(stamp=stamp, pages=pages)
    if disk:
        try:
            os.makedirs(CACHE, exist_ok=True)
            with open(disk + '.tmp', 'w', encoding='utf-8') as f:
                json.dump({'stamp': stamp, 'pages': pages}, f)
            os.replace(disk + '.tmp', disk)
        except OSError:
            pass
    return pages


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
    restored = convert.restore(text)
    if restored:
        return restored
    # front matter and the class may sit in \\input files, and in branches of
    # an \\if: what LaTeX would read (comments are gone)
    whole = spliced_preamble(whole=True)
    cut = re.search(r'\\begin\s*\{document\}', whole)
    return convert.active_tex(whole[:cut.start()]) + whole[cut.start():] if cut else convert.active_tex(whole)


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
    if not re.search(r'\\begin\s*\{document\}', strip_comments(read(MAIN))):
        inner = [resolve_input(m.group(1)) for m in INPUT_RE.finditer(strip_comments(read(MAIN)))]
        inner = [f for f in inner if f and f in find_mains(PAPER)] if os.path.isdir(PAPER) else []
        raise ValueError(f'{MAIN} only sets options and \\inputs the paper'
                         + (f' ({inner[0]})' if inner else '') + ': open '
                         + (inner[0] if inner else 'the file with \\begin{document}') + ' and convert that')
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

    def parse_request(self):
        # Answer only requests addressed to this machine by name.  A web page
        # whose domain is made to resolve to 127.0.0.1 (DNS rebinding) sends
        # its own domain as the Host, and must not read the paper or get the
        # page's token.
        if not super().parse_request():
            return False
        host = (self.headers.get('Host') or '').strip().lower()
        host = host[1:host.find(']')] if host.startswith('[') else host.rsplit(':', 1)[0]
        # APP_HOST: browsers resolve *.localhost to this machine themselves, so
        # no outside domain can be made to send it
        if host not in ('127.0.0.1', 'localhost', '::1', APP_HOST):
            self.send_error(403, 'Forbidden host')
            return False
        return True

    def send(self, code, body, ctype='application/json', cache='no-store'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
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
        LIFE['last'] = time.time()
        url = urllib.parse.urlparse(self.path)
        p = url.path
        if p == '/':
            html = open(os.path.join(STATIC, 'index.html'), encoding='utf-8').read()
            return self.send(200, html.replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8')
        if p == '/api/doc':
            d = doc_payload()
            if START['pick']:
                # once: the first page asks for the start list, a reload does not
                START['pick'] = False
                d = {**d, 'startPick': True}
            return self.send(200, d)
        if p == '/api/state':
            c = urllib.parse.parse_qs(url.query).get('c', [''])[0][:40]
            if c:
                CLIENTS[c] = time.time()
                LIFE['seen'] = True
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
        if p in ('/api/recent', '/api/browse'):
            if self.headers.get('X-Token') != TOKEN:
                return self.send(403, {'error': 'bad token'})
            if p == '/api/recent':
                out = []
                for e in recent_papers():
                    folder, main = os.path.split(e['path'])
                    out.append({'path': folder, 'main': main, 'title': e.get('title') or '', 't': e.get('t'),
                                'current': os.path.normpath(e['path']) == os.path.normpath(os.path.join(PAPER, MAIN))})
                return self.send(200, out)
            return self.send(200, browse_dir(urllib.parse.parse_qs(url.query).get('path', [''])[0]))
        if p == '/api/commits':
            return self.send(200, git_commits())
        if p == '/api/baseline':
            q = urllib.parse.parse_qs(url.query)
            name, ref = q.get('name', [''])[0], q.get('ref', ['head'])[0]
            if name not in paper_files():
                return self.send(400, {'error': 'unknown file'})
            return self.send(200, {'text': baseline(name, ref)})
        if p == '/api/baselines':
            # every file of the paper at one version, for the diff view
            ref = urllib.parse.parse_qs(url.query).get('ref', ['head'])[0]
            return self.send(200, baselines(paper_files(), ref))
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
        if p == '/api/venues':
            return self.send(200, {'venues': [{'id': k, 'label': v[0], 'anonClass': v[1] != v[2]} for k, v in convert.TARGETS.items()],
                                   'home': os.path.expanduser('~'),
                                   'parent': os.path.dirname(os.path.dirname(os.path.join(PAPER, MAIN))) if PAPER else os.path.expanduser('~')})
        if p == '/api/srcfiles':
            docs = set(paper_files())
            return self.send(200, [{'name': n, 'doc': n in docs} for n in source_files()])
        if p == '/api/srcfile':
            name = urllib.parse.parse_qs(url.query).get('name', [''])[0]
            if name not in source_files():
                return self.send(400, {'error': 'not a .tex or .bib file of this folder'})
            if os.path.getsize(os.path.join(PAPER, name)) > 4_000_000:
                # a huge file (cryptobib's crypto.bib) is shown in part, for reading
                with open(os.path.join(PAPER, name), encoding='utf-8', errors='replace', newline='') as f:
                    head = f.read(2_000_000)
                return self.send(200, {'text': head[:head.rfind('\n') + 1], 'hash': None, 'truncated': True})
            text = read(name)
            return self.send(200, {'text': text, 'hash': sha(text)})
        if p.startswith('/static/'):
            # static/ and its vendor/ folder (KaTeX, served here so that the
            # editor needs no network); nothing outside static/
            rel = os.path.normpath(urllib.parse.unquote(p[len('/static/'):]))
            f = os.path.realpath(os.path.join(STATIC, rel))
            if f.startswith(os.path.realpath(STATIC) + os.sep) and os.path.isfile(f):
                ext = os.path.splitext(f)[1]
                ctype = {'.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
                         '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png'}.get(ext, 'text/plain; charset=utf-8')
                # vendored files never change for a given version: cached a day
                cache = 'max-age=86400' if rel.startswith('vendor' + os.sep) else 'no-store'
                with open(f, 'rb') as src:
                    return self.send(200, src.read(), ctype, cache)
        self.send(404, {'error': 'not found'})

    def do_POST(self):
        LIFE['last'] = time.time()
        if urllib.parse.urlparse(self.path).path == '/api/bye':
            # sent by navigator.sendBeacon, which cannot set headers: the token is in the body
            req = self.json_body() or {}
            if req.get('token') != TOKEN:
                return self.send(403, {'error': 'bad token'})
            CLIENTS.pop(str(req.get('c', ''))[:40], None)
            return self.send(200, {})
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
        if urllib.parse.urlparse(self.path).path == '/api/build':
            req = self.json_body() or {}
            BUILDER.request(clean=bool(req.get('clean')))
            BUILDER.state = {'state': 'running', 'message': 'clean build queued' if req.get('clean') else 'build queued',
                             'at': time.time()}
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
        if urllib.parse.urlparse(self.path).path == '/api/recent/forget':
            req = self.json_body()
            if not isinstance(req, dict) or not isinstance(req.get('path'), str) or not isinstance(req.get('main'), str):
                return self.send(400, {'error': 'expected {path, main}'})
            target = os.path.join(req['path'], req['main'])
            if os.path.normpath(target) == os.path.normpath(os.path.join(PAPER, MAIN)):
                return self.send(400, {'error': 'the paper open now stays on the list'})
            try:
                forget_paper(target)
            except OSError as e:
                return self.send(500, {'error': f'could not write the list of recent papers: {e}'})
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
        if urllib.parse.urlparse(self.path).path == '/api/external-edit':
            req = self.json_body()
            if not isinstance(req, dict):
                return self.send(400, {'error': 'expected a JSON object'})
            name = req.get('name')
            if not isinstance(name, str) or (name not in paper_files() and name not in source_files()):
                return self.send(400, {'error': 'not a file of this paper'})
            try:
                line, col = int(req.get('line') or 1), int(req.get('col') or 1)
            except (TypeError, ValueError):
                return self.send(400, {'error': 'bad line or column'})
            err = open_in_editor(name, line, col)
            return self.send(500 if err else 200, {'error': err} if err else {'cmd': external_editor_cmd(name, line, col)[0]})
        if urllib.parse.urlparse(self.path).path == '/api/trace':
            req = self.json_body()
            n = trace_append((req or {}).get('entries') if isinstance(req, dict) else None, (req or {}).get('client') if isinstance(req, dict) else None)
            return self.send(200, {'kept': n})
        if urllib.parse.urlparse(self.path).path == '/api/trace/report':
            req = self.json_body()
            name = trace_report(req.get('note') if isinstance(req, dict) else '')
            BUILDER.log(f'problem report: {name}')
            return self.send(200, {'file': name})
        if urllib.parse.urlparse(self.path).path == '/api/file/rename':
            req = self.json_body()
            if not isinstance(req, dict):
                return self.send(400, {'error': 'expected a JSON object'})
            with PROJECT_LOCK:
                src = project_path(req.get('from'), ('.tex', '.bib'))
                dst = project_path(req.get('to'), ('.tex', '.bib'))
                if not src or not dst or os.path.splitext(src)[1] != os.path.splitext(dst)[1]:
                    return self.send(400, {'error': 'names must be .tex (or .bib) files inside the paper\'s folder, keeping their kind'})
                if src == MAIN:
                    return self.send(400, {'error': 'the main file cannot be renamed here'})
                if not os.path.isfile(os.path.join(PAPER, src)):
                    return self.send(400, {'error': f'{src} is not a file of this folder'})
                if os.path.exists(os.path.join(PAPER, dst)):
                    return self.send(409, {'error': f'{dst} already exists'})
                try:
                    changed = rename_file(src, dst, req.get('batch'))
                except OSError as e:
                    return self.send(500, {'error': f'could not rename: {e.strerror or e}'})
            BUILDER.log(f'renamed {src} to {dst}' + (f' (updated {", ".join(changed)})' if changed else ''))
            BUILDER.request()
            return self.send(200, {'name': dst, 'changed': changed})
        if urllib.parse.urlparse(self.path).path == '/api/file/trash':
            req = self.json_body()
            with PROJECT_LOCK:
                name = project_path(req.get('name') if isinstance(req, dict) else None, ('.tex', '.bib'))
                if not name or not os.path.isfile(os.path.join(PAPER, name)):
                    return self.send(400, {'error': 'not a .tex or .bib file of this folder'})
                if name in paper_files() or name == MAIN:
                    return self.send(400, {'error': f'{name} is still read by the document: take its \\input out first'})
                if name in bib_files():
                    return self.send(400, {'error': f'{name} is still named by \\bibliography or \\addbibresource'})
                try:
                    dest = trash_file(name, req.get('batch'))
                except OSError as e:
                    return self.send(500, {'error': f'could not move it: {e.strerror or e}'})
            BUILDER.log(f'moved {name} to {dest}')
            return self.send(200, {'trash': dest})
        if urllib.parse.urlparse(self.path).path == '/api/upload':
            req = self.json_body()
            if not isinstance(req, dict) or not isinstance(req.get('data'), str):
                return self.send(400, {'error': 'expected a name and base64 data'})
            try:
                import base64
                data = base64.b64decode(req['data'], validate=True)
            except ValueError:
                return self.send(400, {'error': 'the data is not base64'})
            if len(data) > 40_000_000:
                return self.send(413, {'error': 'images up to 40 MB'})
            try:
                with PROJECT_LOCK:
                    path = save_upload(req.get('name'), data)
            except (ValueError, OSError) as e:
                return self.send(400, {'error': str(e)})
            BUILDER.log(f'added {path}')
            return self.send(200, {'path': path, 'graphicx': uses_graphicx()})
        if urllib.parse.urlparse(self.path).path == '/api/listing':
            req = self.json_body()
            src = req.get('src') if isinstance(req, dict) else None
            if not isinstance(src, str) or len(src) > 20000:
                return self.send(400, {'error': 'expected the source of a listing command'})
            return self.send(200, {'listings': expand_listing(src)})
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
        if urllib.parse.urlparse(self.path).path == '/api/snippets':
            req = self.json_body() or {}
            srcs = [x for x in (req.get('srcs') or []) if isinstance(x, str) and 0 < len(x) <= 4000][:300]
            out, queued = snippets_lookup(srcs)
            if queued:
                BUILDER.request_snippets()
            return self.send(200, out)
        if urllib.parse.urlparse(self.path).path == '/api/merge':
            # the page's edits of a file that changed on disk, merged with it
            req = self.json_body() or {}
            name, base, text = req.get('name'), req.get('base'), req.get('text')
            if not isinstance(name, str) or not isinstance(text, str) or name not in paper_files():
                return self.send(400, {'error': 'not a file of this document'})
            with PROJECT_LOCK:
                disk = read(name)
            start = base_get(base) if isinstance(base, str) else None
            if start is None and isinstance(req.get('base_text'), str) and sha(req['base_text']) == base:
                start = req['base_text']
            if start is None:
                return self.send(404, {'error': 'the version your edits started from is no longer known'})
            try:
                merged, conflicts = merge3(text, start, disk)
            except (OSError, RuntimeError) as e:
                return self.send(500, {'error': f'could not merge: {e}'})
            return self.send(200, {'merged': merged, 'conflicts': conflicts, 'disk': disk, 'hash': sha(disk)})
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
            req = self.json_body()
            title = req.get('title') if isinstance(req, dict) and isinstance(req.get('title'), str) else ''
            directory = choose_directory(re.sub(r'[^\w .,:()-]', '', title)[:80] or 'Open paper directory')
            if not directory:
                return self.send(204, b'', 'text/plain')
            return self.send(200, {'path': directory, 'mains': find_mains(directory)})
        if urllib.parse.urlparse(self.path).path == '/api/new-project':
            req = self.json_body()
            if not isinstance(req, dict):
                return self.send(400, {'error': 'expected a JSON object'})
            with PROJECT_LOCK:
                try:
                    main, warnings = create_project(req)
                except ValueError as e:
                    return self.send(400, {'error': str(e)})
                open_paper(main)
                ensure_state()
                BUILDER.aux = load_aux()
                BUILDER.auxver += 1
                BUILDER.log(f'new paper {main}')
                return self.send(200, {'main': MAIN, 'path': PAPER, 'warnings': warnings})
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
            safe = name.endswith(('.tex', '.bib')) and not os.path.isabs(name) and norm != '..' and not norm.startswith('..' + os.sep)
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
            if name not in paper_files() and name not in source_files():
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


# ------------------------------------------------------------------ trace
#
# What the page did and what was pressed, kept on this machine only
# (.paper-editor/debug/trace.jsonl, the last few MB), so that a problem can be
# looked into afterwards; Report a problem copies its last minutes aside.

TRACE_MAX = 4_000_000
_trace_lock = threading.Lock()


def trace_path():
    return os.path.join(STATE, 'debug', 'trace.jsonl')


def trace_append(entries, client):
    if not isinstance(entries, list):
        return 0
    lines = []
    for e in entries[:5000]:
        if isinstance(e, dict):
            e = dict(e)
            e['c'] = str(client or '')[:16]
            lines.append(json.dumps(e, ensure_ascii=False)[:4000] + '\n')
    if not lines:
        return 0
    path = trace_path()
    with _trace_lock:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'a', encoding='utf-8') as f:
            f.writelines(lines)
        if os.path.getsize(path) > TRACE_MAX:
            # keep the newer half
            with open(path, encoding='utf-8', errors='replace') as f:
                f.seek(os.path.getsize(path) - TRACE_MAX // 2)
                f.readline()
                rest = f.read()
            with open(path + '.tmp', 'w', encoding='utf-8') as f:
                f.write(rest)
            os.replace(path + '.tmp', path)
    return len(lines)


def trace_report(note, minutes=10):
    """The last minutes of the trace, with a note, in a file of their own."""
    since = (time.time() - minutes * 60) * 1000
    keep = []
    with _trace_lock:
        try:
            with open(trace_path(), encoding='utf-8', errors='replace') as f:
                for line in f:
                    try:
                        if json.loads(line).get('t', 0) >= since:
                            keep.append(line)
                    except ValueError:
                        continue
        except OSError:
            pass
    name = os.path.join(STATE, 'debug', time.strftime('report-%Y%m%d-%H%M%S.jsonl'))
    os.makedirs(os.path.dirname(name), exist_ok=True)
    head = {'t': time.time() * 1000, 'k': 'report', 'note': str(note or '')[:4000], 'paper': os.path.join(PAPER, MAIN),
            'build': dict(BUILDER.state) if BUILDER else None}
    with open(name, 'w', encoding='utf-8') as f:
        f.write(json.dumps(head, ensure_ascii=False) + '\n')
        f.writelines(keep)
        log = os.path.join(PAPER, stem() + '.log')
        if os.path.isfile(log):
            f.write(json.dumps({'k': 'latex-log-tail', 'text': read_path(log)[-6000:]}) + '\n')
    return name


# ------------------------------------------------------------------ files

def project_path(name, exts=('.tex',)):
    """A path of the paper's folder given relative to it, normalised, or None
    when it leaves the folder, is hidden or has another extension."""
    if not isinstance(name, str) or not name or os.path.isabs(name) or '\0' in name:
        return None
    norm = os.path.normpath(name)
    if norm == '..' or norm.startswith('..' + os.sep) or any(p.startswith('.') for p in norm.split(os.sep)):
        return None
    if exts and not norm.lower().endswith(tuple(exts)):
        return None
    full = os.path.realpath(os.path.join(PAPER, norm))
    if not full.startswith(os.path.realpath(PAPER) + os.sep):
        return None
    return norm


def input_arg_for(old_arg, new_name):
    """The \\input argument naming new_name, written as old_arg was (with or
    without .tex, relative to the same base)."""
    keep_ext = old_arg.strip().endswith('.tex')
    return new_name if keep_ext else new_name[:-4]


def rename_file(src, dst, batch):
    """Rename a .tex file of the document and every \\input/\\include of it.
    Returns the files whose text changed."""
    old_text = read(src)
    texts = {n: read(n) for n in paper_files() if n != src}
    changed = {}
    for n, text in texts.items():
        def fix(m):
            arg = m.group(1)
            if resolve_input(arg) == src:
                return m.group(0).replace('{' + arg + '}', '{' + input_arg_for(arg, dst) + '}')
            return m.group(0)
        new = INPUT_RE.sub(fix, text) if src.endswith('.tex') else text
        if src.endswith('.bib'):
            # \bibliography{a,refs} (names without .bib) and \addbibresource{refs.bib}
            def fix_bib(m):
                names = m.group(2).split(',')
                out = []
                for b in names:
                    s = b.strip()
                    full = s if s.endswith('.bib') else s + '.bib'
                    out.append(b.replace(s, dst if s.endswith('.bib') else dst[:-4]) if os.path.normpath(full) == src else b)
                return m.group(1) + ','.join(out) + '}'
            new = re.sub(r'(\\bibliography\s*\{)([^}]*)\}', fix_bib, new)
            new = re.sub(r'(\\addbibresource(?:\[[^\]]*\])?\s*\{)([^}]*)\}', fix_bib, new)
        if new != text:
            changed[n] = (text, new)
    os.makedirs(os.path.dirname(os.path.join(PAPER, dst)) or PAPER, exist_ok=True)
    history_put(old_text)
    os.rename(os.path.join(PAPER, src), os.path.join(PAPER, dst))
    history_record(batch, src, old_text, '')
    history_record(batch, dst, '', old_text)
    for n, (before, after) in changed.items():
        history_record(batch, n, before, after)
        path = os.path.join(PAPER, n)
        tmp = path + '.editor-rename.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(after)
        os.chmod(tmp, stat.S_IMODE(os.stat(path).st_mode))
        os.replace(tmp, path)
    return sorted(changed)


def trash_file(name, batch):
    """Move a file the document no longer reads to the editor's trash."""
    text = read(name)
    d = os.path.join(STATE, 'trash')
    os.makedirs(d, exist_ok=True)
    dest = os.path.join(d, time.strftime('%Y%m%d-%H%M%S-') + name.replace(os.sep, '__'))
    history_record(batch, name, text, '')
    shutil.move(os.path.join(PAPER, name), dest)
    return os.path.relpath(dest, PAPER)


IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg')


def save_upload(name, data):
    """Write an added image under figures/ (beside the main file), never over
    another file: returns its path relative to the paper's folder."""
    base = re.sub(r'[^A-Za-z0-9._-]+', '-', os.path.basename(name or '')).strip('-.') or 'image.png'
    stem_, ext = os.path.splitext(base)
    if ext.lower() not in IMAGE_EXTS:
        raise ValueError('only images can be added (%s)' % ', '.join(IMAGE_EXTS))
    folder = os.path.join(os.path.dirname(MAIN), 'figures')
    os.makedirs(os.path.join(PAPER, folder), exist_ok=True)
    n, cand = 1, os.path.join(folder, stem_ + ext.lower())
    while os.path.exists(os.path.join(PAPER, cand)):
        n += 1
        cand = os.path.join(folder, '%s-%d%s' % (stem_, n, ext.lower()))
    with open(os.path.join(PAPER, cand), 'xb') as f:
        f.write(data)
    return os.path.normpath(cand)


RECENT_FILE = os.path.join(os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config')), 'paper-editor', 'recent.json')


def paper_title(path):
    """The \\title of a main file, as plain text (for the list of recent papers)."""
    text = strip_comments(read_path(path))[:200000]
    m = re.search(r'\\title\s*(?:\[[^\]]*\])?\s*(?=\{)', text)
    if not m:
        return ''
    try:
        title, _ = group(text, m.end())
    except (IndexError, AssertionError):
        return ''
    return bib_plain(title.replace('\\\\', ' '))[:200]


def recent_papers():
    try:
        data = json.load(open(RECENT_FILE))
    except (OSError, ValueError):
        return []
    out = []
    for e in data.get('recent') or ([{'path': data['last']}] if data.get('last') else []):
        if isinstance(e, dict) and isinstance(e.get('path'), str) and os.path.isfile(e['path']):
            out.append(e)
    return out


def write_recent(last, recent):
    os.makedirs(os.path.dirname(RECENT_FILE), exist_ok=True)
    tmp = RECENT_FILE + '.tmp'
    with open(tmp, 'w') as out:
        json.dump({'last': last, 'recent': recent}, out)
    os.replace(tmp, RECENT_FILE)


def remember_paper(path):
    """The paper just opened goes first in the list of recent papers (ten)."""
    try:
        entry = {'path': path, 't': time.time(), 'title': paper_title(path)}
        rest = [e for e in recent_papers() if os.path.normpath(e['path']) != os.path.normpath(path)]
        write_recent(path, [entry] + rest[:9])
    except OSError:
        pass


def forget_paper(path):
    """Take a paper off the list of recent papers (its files stay).  When it
    was the last one opened, the next one on the list becomes the last."""
    norm = os.path.normpath(path)
    rest = [e for e in recent_papers() if os.path.normpath(e['path']) != norm]
    last = last_paper()
    if last and os.path.normpath(last) == norm:
        last = rest[0]['path'] if rest else None
    write_recent(last, rest)


def browse_dir(path):
    """A folder's subfolders, and its main documents, for the Open window."""
    path = os.path.abspath(os.path.expanduser(path or '~'))
    if not os.path.isdir(path):
        path = os.path.expanduser('~')
    dirs = []
    try:
        with os.scandir(path) as it:
            for e in it:
                if e.name.startswith('.') or e.name in ('node_modules', '__pycache__'):
                    continue
                try:
                    if e.is_dir():
                        dirs.append(e.name)
                except OSError:
                    continue
    except OSError:
        pass
    dirs.sort(key=str.lower)
    has_tex = False
    try:
        has_tex = any(f.endswith('.tex') for f in os.listdir(path))
    except OSError:
        pass
    return {'path': path, 'parent': os.path.dirname(path) if os.path.dirname(path) != path else None,
            'home': os.path.expanduser('~'), 'dirs': dirs[:800], 'mains': find_mains(path) if has_tex else []}


def external_editor_cmd(path, line=1, col=1):
    """The command that opens path at line and column in the user's editor."""
    cmd = CONFIG.get('external_editor')
    if isinstance(cmd, str) and cmd.strip():
        cmd = cmd.split()
    if not (isinstance(cmd, list) and cmd and all(isinstance(a, str) for a in cmd)):
        if shutil.which('emacsclient'):
            # a running Emacs server takes the file; without one, -a starts Emacs itself
            cmd = ['emacsclient', '-n', '-a', 'emacs', '+{line}:{col}', '{file}']
        elif shutil.which('code'):
            cmd = ['code', '-g', '{file}:{line}:{col}']
        else:
            cmd = ['xdg-open' if sys.platform.startswith('linux') else 'open', '{file}']
    has_file = any('{file}' in a for a in cmd)
    out = [a.replace('{file}', path).replace('{line}', str(line)).replace('{col}', str(col)) for a in cmd]
    return out if has_file else out + [path]


def open_in_editor(name, line=1, col=1):
    """Run the user's editor on a file of the project (detached: the editor
    outlives the request and the server).  Returns an error text or None."""
    full = os.path.join(PAPER, name)
    if not os.path.isfile(full):
        return f'no such file: {name}'
    cmd = external_editor_cmd(os.path.abspath(full), max(1, int(line or 1)), max(1, int(col or 1)))
    try:
        subprocess.Popen(cmd, cwd=PAPER, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError as e:
        return f'could not run {cmd[0]}: {e.strerror or e} (set "external_editor" in .paper-editor/config.json)'
    BUILDER.log(f'opened {name}:{line} in {cmd[0]}')
    return None


NEW_GITIGNORE = '''*.aux
*.bbl
*.blg
*.fdb_latexmk
*.fls
*.log
*.out
*.synctex.gz
*.toc
.paper-editor/cache/
'''


def _git(args, cwd, timeout=600):
    try:
        r = subprocess.run(['git'] + args, cwd=cwd, capture_output=True, text=True, errors='replace', timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    return r.returncode == 0, (r.stderr or r.stdout).strip()


def create_project(req):
    """A new paper folder: main.tex for the venue (\\ifanon switch), sections/,
    references.bib and, if asked, cryptobib (a clone, or a submodule of a new or
    the enclosing Git repository).  Returns (main file, warnings)."""
    parent = os.path.abspath(os.path.expanduser(str(req.get('parent') or '')))
    name = str(req.get('name') or '').strip()
    target = req.get('venue') or 'article'
    cryptobib = req.get('cryptobib') or 'none'
    if not os.path.isdir(parent):
        raise ValueError(f'no such folder: {parent}')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._ -]{0,80}', name) or '..' in name:
        raise ValueError('the folder name may have letters, digits, spaces, dots, dashes and underscores')
    if target not in convert.TARGETS:
        raise ValueError(f'unknown venue {target}')
    if cryptobib not in ('none', 'clone', 'submodule'):
        raise ValueError('cryptobib: none, clone or submodule')
    folder = os.path.join(parent, name)
    if os.path.exists(folder) and (not os.path.isdir(folder) or os.listdir(folder)):
        raise ValueError(f'{folder} already exists and is not empty')
    md = req.get('metadata') if isinstance(req.get('metadata'), dict) else {}
    warnings = []
    os.makedirs(os.path.join(folder, 'sections'), exist_ok=True)
    for n, text in convert.NEW_SECTIONS.items():
        with open(os.path.join(folder, n), 'w') as f:
            f.write(text)
    with open(os.path.join(folder, 'references.bib'), 'w') as f:
        f.write('% Entries of your own; ' + ('cryptobib/ has the IACR ones (crypto.bib).\n' if cryptobib != 'none' else 'the editor adds the ones it finds on Crossref and arXiv here.\n'))
    have_bib = False
    if cryptobib == 'clone':
        ok, out = _git(['clone', '--depth', '1', convert.CRYPTOBIB_URL, 'cryptobib'], folder)
        have_bib = ok
        if not ok:
            warnings.append('Could not clone cryptobib: ' + out[-300:])
    elif cryptobib == 'submodule':
        inside, _ = _git(['rev-parse', '--show-toplevel'], folder, 30)
        if not inside:
            ok, out = _git(['init'], folder, 60)
            if not ok:
                warnings.append('Could not make a Git repository: ' + out[-300:])
            else:
                with open(os.path.join(folder, '.gitignore'), 'w') as f:
                    f.write(NEW_GITIGNORE)
        ok, out = _git(['-c', 'protocol.file.allow=always', 'submodule', 'add', convert.CRYPTOBIB_URL, 'cryptobib'], folder)
        have_bib = ok
        if not ok:
            warnings.append('Could not add cryptobib as a submodule: ' + out[-300:])
    bibs = (['cryptobib/abbrev3', 'cryptobib/crypto'] if have_bib else []) + ['references']
    # a new paper keeps one sentence per line from the start
    with open(os.path.join(folder, '.paper-editor.json'), 'w') as f:
        json.dump({'house_rules': {'one_sentence_per_line': True}}, f, indent=2)
        f.write('\n')
    main = os.path.join(folder, 'main.tex')
    with open(main, 'w') as f:
        f.write(convert.new_main(md, target, bool(req.get('anonymous')), bibs))
    return main, warnings


def last_paper():
    try:
        last = json.load(open(RECENT_FILE)).get('last')
        return last if last and os.path.isfile(last) else None
    except (OSError, ValueError, AttributeError):
        return None


# The pages open on this server: each polls /api/state with its id and says
# goodbye when it closes.  When the server opens its own window (and not
# --keep-running), it stops once no page is left.
CLIENTS = {}
START = {'pick': False}    # started without a paper: the page opens on the recent papers
LIFE = {'last': time.time(), 'seen': False}


def watch_clients(srv):
    tick = time.time()
    while True:
        time.sleep(1)
        now = time.time()
        # the computer slept (or the clock was set): the pages slept too and
        # were not gone; count their silence from now, not from before
        if now - tick > 30 or now < tick:
            for c in CLIENTS:
                CLIENTS[c] = now
            LIFE['last'] = now
            print(time.strftime('%H:%M:%S'), 'woke after %.0f s: keeping the open pages' % (now - tick), flush=True)
        tick = now
        # a page not heard from for long is gone (a throttled background
        # window still polls about once a minute)
        for c, t in list(CLIENTS.items()):
            if now - t > 900:
                CLIENTS.pop(c, None)
        if not LIFE['seen'] or CLIENTS or now - LIFE['last'] < 5:
            continue
        # never in the middle of a build: a cut-off LaTeX run leaves a damaged .aux
        if BUILDER and (BUILDER.state.get('state') == 'running' or BUILDER.wanted.is_set()):
            continue
        print('the editor window was closed: stopping', flush=True)
        srv.shutdown()
        return


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
            for k, v in json.load(open(cfg)).items():
                # a file that sets one house rule keeps the defaults of the others
                if k == 'house_rules' and isinstance(v, dict):
                    CONFIG[k] = {**CONFIG[k], **v}
                else:
                    CONFIG[k] = v
    _bib.update(entries=None, stamp=None)
    remember_paper(path)


def load_token():
    """The key a page sends with every write: kept beside the list of recent
    papers (one for the user, not one per paper), so that a page left open
    across a restart of the editor can still save, also after it switched to
    another paper (a key per paper refused every write and the recent list)."""
    global TOKEN
    p = os.path.join(os.path.dirname(RECENT_FILE), 'token')
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        # the first time: the key the paper's cache had (a page open on it now keeps working)
        old = os.path.join(CACHE, 'token')
        if not os.path.exists(p) and os.path.isfile(old):
            shutil.copyfile(old, p)
            os.chmod(p, 0o600)
    except OSError:
        pass
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


# Every version of a file the page was given, by hash: edits made on one of
# them can later be merged with the file as it is on disk (a draft kept from
# before a restart, a file changed by another program).  Kept 60 days.
BASES_KEEP = 60 * 86400


def base_put(text):
    try:
        d = os.path.join(CACHE, 'bases')
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, sha(text))
        if os.path.exists(p):
            os.utime(p)
            return
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
        os.replace(tmp, p)
        now = time.time()
        for b in os.listdir(d):
            q = os.path.join(d, b)
            if now - os.path.getmtime(q) > BASES_KEEP:
                os.unlink(q)
    except OSError:
        pass


def base_get(h):
    if not re.fullmatch(r'[0-9a-f]{40}', h or ''):
        return None
    for p in (os.path.join(CACHE, 'bases', h), os.path.join(history_dir(), 'blobs', h)):
        if os.path.exists(p):
            with open(p, encoding='utf-8', newline='') as f:
                return f.read()
    return None


def merge3(mine, base, disk):
    """Three-way merge of the page's edits and the file on disk (git merge-file).

    Returns (merged text or None, the lines of the file on disk where both
    changed the same place)."""
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for n, t in (('mine', mine), ('base', base), ('disk', disk)):
            paths.append(os.path.join(tmp, n))
            with open(paths[-1], 'w', encoding='utf-8', newline='') as f:
                f.write(t)
        r = subprocess.run(['git', 'merge-file', '-p', '-L', 'mine', '-L', 'base', '-L', 'disk'] + paths,
                           capture_output=True)
    if r.returncode < 0 or r.returncode > 127:
        raise RuntimeError((r.stderr or b'').decode(errors='replace').strip() or 'git merge-file failed')
    out = r.stdout.decode('utf-8', errors='replace')
    if r.returncode == 0:
        return out, []
    # the line on disk where each conflict starts
    lines, where, line, part = out.splitlines(), [], 1, None
    for x in lines:
        if x.startswith('<<<<<<< mine'):
            part = 'mine'
            where.append(line)
        elif part == 'mine' and x.startswith('||||||| base'):
            part = 'base'     # merge.conflictStyle diff3
        elif part in ('mine', 'base') and x.startswith('======='):
            part = 'disk'
        elif part == 'disk' and x.startswith('>>>>>>> disk'):
            part = None
        elif part not in ('mine', 'base'):
            line += 1
    return None, where


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


# The app window's address.  On Wayland, Chrome ignores --class and names an
# app window after its host and profile (chrome-<host>__-Default): a host of
# its own and a profile of its own give a name that is the same on every
# port, which the desktop entry's StartupWMClass matches, so the window shows
# under the editor's own icon and name in the dock (not as "run").
APP_HOST = 'paper-reviewer.localhost'
APP_WAYLAND_ID = 'chrome-' + APP_HOST + '__-Default'


def app_profile():
    base = os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))
    return os.path.join(base, 'paper-editor', 'chrome-profile')


def carry_zoom(profile=None, sources=None):
    """The app window's profile starts at 100%: give it the zoom the editor
    had in the user's own Chrome (for 127.0.0.1), once.  Only while that
    profile is not running (Chrome writes its preferences back on exit)."""
    profile = profile or app_profile()
    prefs = os.path.join(profile, 'Default', 'Preferences')
    if os.path.lexists(os.path.join(profile, 'SingletonLock')):
        return None
    try:
        mine = json.load(open(prefs, encoding='utf-8')) if os.path.isfile(prefs) else {}
    except (OSError, ValueError):
        return None
    zooms = mine.setdefault('partition', {}).setdefault('per_host_zoom_levels', {}).setdefault('x', {})
    if APP_HOST in zooms:
        return None
    base = os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))
    sources = sources or [os.path.join(base, d, 'Default', 'Preferences') for d in ('google-chrome', 'chromium', 'google-chrome-beta')]
    for src in sources:
        try:
            theirs = json.load(open(src, encoding='utf-8'))
        except (OSError, ValueError):
            continue
        for hosts in ((theirs.get('partition') or {}).get('per_host_zoom_levels') or {}).values():
            entry = hosts.get('127.0.0.1') or hosts.get('localhost')
            if isinstance(entry, dict) and isinstance(entry.get('zoom_level'), (int, float)):
                zooms[APP_HOST] = dict(entry)
                os.makedirs(os.path.dirname(prefs), exist_ok=True)
                tmp = prefs + '.editor.tmp'
                with open(tmp, 'w', encoding='utf-8') as out:
                    json.dump(mine, out)
                os.replace(tmp, prefs)
                return entry['zoom_level']
    return None


def chrome_zoom_level():
    """The zoom the editor has in the Chrome app window (else in the user's
    own Chrome, for 127.0.0.1), as a Chrome zoom level (0 is 100%), or None."""
    base = os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))
    sources = [(os.path.join(app_profile(), 'Default', 'Preferences'), (APP_HOST,))]
    sources += [(os.path.join(base, d, 'Default', 'Preferences'), ('127.0.0.1', 'localhost'))
                for d in ('google-chrome', 'chromium', 'google-chrome-beta')]
    for prefs, hosts in sources:
        try:
            data = json.load(open(prefs, encoding='utf-8'))
        except (OSError, ValueError):
            continue
        for zooms in ((data.get('partition') or {}).get('per_host_zoom_levels') or {}).values():
            for host in hosts:
                entry = zooms.get(host)
                if isinstance(entry, dict) and isinstance(entry.get('zoom_level'), (int, float)):
                    return entry['zoom_level']
    return None


def electron_binary():
    """The Electron of shell/ (npm install there), or None."""
    dist = os.path.join(HERE, 'shell', 'node_modules', 'electron', 'dist')
    for name in ('electron', 'electron.exe', os.path.join('Electron.app', 'Contents', 'MacOS', 'Electron')):
        if os.path.isfile(os.path.join(dist, name)):
            return os.path.join(dist, name)
    return None


def open_browser(url, browser):
    if browser == 'electron':
        # the default: a window in which every key reaches the page (Chrome
        # keeps Ctrl+W, Ctrl+Tab and others for itself)
        found = electron_binary()
        if found:
            app_url = url.replace('://127.0.0.1:', '://' + APP_HOST + ':', 1)
            zoom = chrome_zoom_level()
            refresh_desktop_entry()
            subprocess.Popen([found, os.path.join(HERE, 'shell'), app_url]
                             + ([f'--chrome-zoom={zoom}'] if zoom is not None else []),
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        print('Electron is not installed (run: npm install --prefix shell, then node shell/node_modules/electron/install.js '
              'if npm skipped the download); opening the Chrome app window.', flush=True)
        browser = 'chrome-app'
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
                    # --class names the window on X11; on Wayland the host and
                    # the profile do (APP_WAYLAND_ID).  A profile of its own also
                    # keeps the window out of a Chrome already running.
                    app_url = url.replace('://127.0.0.1:', '://' + APP_HOST + ':', 1)
                    refresh_desktop_entry()
                    os.makedirs(app_profile(), exist_ok=True)
                    try:
                        carry_zoom()
                    except Exception:      # a nicety: never stop the window opening
                        pass
                    subprocess.Popen([found, '--app=' + app_url, '--class=crypto-paper-reviewer',
                                      '--user-data-dir=' + app_profile(), '--no-first-run',
                                      '--no-default-browser-check'],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    webbrowser.BackgroundBrowser(found).open(url)
                return
        print('Chrome/Chromium was not found; opening the system browser.', flush=True)
    webbrowser.open(url)




def desktop_entry_text(run):
    return ('[Desktop Entry]\nType=Application\nName=Crypto Paper Reviewer\n'
            'Comment=Read, listen to and edit a LaTeX paper\n'
            f'Exec="{run}" %f\nIcon=crypto-paper-reviewer\nTerminal=false\n'
            'Categories=Office;\nMimeType=text/x-tex;\n'
            'StartupWMClass=crypto-paper-reviewer\nStartupNotify=false\n')


def x11_alias_text(run):
    # The Electron window (its desktopName, and --class on X11) matches the
    # main entry; a hidden entry gives the Chrome app window the same icon.
    return ('[Desktop Entry]\nType=Application\nName=Crypto Paper Reviewer\n'
            f'Exec="{run}" %f\nIcon=crypto-paper-reviewer\nTerminal=false\nNoDisplay=true\n'
            f'StartupWMClass={APP_WAYLAND_ID}\n')


def refresh_desktop_entry():
    """An entry installed by an older version names the window as Wayland
    never does: bring it up to date (only if it is installed)."""
    data = os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share'))
    entry = os.path.join(data, 'applications', 'crypto-paper-reviewer.desktop')
    try:
        if os.path.isfile(entry) and read_path(entry) != desktop_entry_text(os.path.join(HERE, 'run')):
            install_desktop(quiet=True)
    except OSError:
        pass


def install_desktop(quiet=False):
    """An entry in the applications menu that runs ./run (the last paper, else a folder chooser)."""
    data = os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share'))
    icon = os.path.join(data, 'icons', 'hicolor', 'scalable', 'apps', 'crypto-paper-reviewer.svg')
    entry = os.path.join(data, 'applications', 'crypto-paper-reviewer.desktop')
    os.makedirs(os.path.dirname(icon), exist_ok=True)
    os.makedirs(os.path.dirname(entry), exist_ok=True)
    shutil.copyfile(os.path.join(STATIC, 'icon.svg'), icon)
    run = os.path.join(HERE, 'run')
    with open(entry, 'w') as out:
        out.write(desktop_entry_text(run))
    with open(os.path.join(os.path.dirname(entry), 'crypto-paper-reviewer-x11.desktop'), 'w') as out:
        out.write(x11_alias_text(run))
    for cmd in (['update-desktop-database', os.path.dirname(entry)], ['gtk-update-icon-cache', '-q', os.path.join(data, 'icons', 'hicolor')]):
        if shutil.which(cmd[0]):
            subprocess.run(cmd, capture_output=True)
    if not quiet:
        print(f'added {entry}')
    return 0


def choose_directory(title='Open paper directory'):
    commands = []
    if sys.platform == 'darwin':
        commands.append(['osascript', '-e', f'POSIX path of (choose folder with prompt "{title}")'])
    elif os.name == 'nt':
        script = ('Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; '
                  'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }')
        commands.append(['powershell', '-NoProfile', '-Command', script])
    else:
        commands += [
            ['zenity', '--file-selection', '--directory', f'--title={title}'],
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
    ap.add_argument('path', nargs='?', help='a project folder, or its main .tex file '
                    '(default: the paper opened last, else a folder chooser)')
    ap.add_argument('--main', help='the main file, when the folder has several documents')
    ap.add_argument('--cwd', help='the directory LaTeX runs in (default: the main file\'s directory)')
    ap.add_argument('--state', help='where to keep settings and caches (default: <project>/.paper-editor)')
    ap.add_argument('--port', type=int, help='port (default: 8765, or a free one when it is taken)')
    ap.add_argument('--browser', choices=('electron', 'chrome-app', 'chrome', 'system'), default='electron',
                    help='browser to open (default: the Electron window in shell/, after npm install --prefix shell, '
                    'else the standalone Chrome app window)')
    ap.add_argument('--no-open', action='store_true', help='do not open a browser')
    ap.add_argument('--keep-running', action='store_true',
                    help='keep the server running when its window is closed (the default with --no-open)')
    ap.add_argument('--install-desktop', action='store_true',
                    help='add the editor to the applications menu (Linux, freedesktop), then exit')
    args = ap.parse_args()
    if args.install_desktop:
        return install_desktop()
    if os.environ.get('PE_REEXEC') and os.environ.get('PE_PAPER'):
        # restarted for new code: the paper open at that moment, as it was open
        args.path, args.main = os.environ.pop('PE_PAPER'), None
        args.cwd, args.state = os.environ.pop('PE_CWD', None), os.environ.pop('PE_STATE', None)
    if not args.path:
        # the last paper is loaded behind the list of recent papers, which the
        # page shows first (as an editor's start page): pick one, or Esc
        START['pick'] = bool(last_paper())
        args.path = last_paper() or choose_directory()
        if not args.path:
            ap.error('no paper given, none opened before, and no folder chosen')
    path = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.exists(path):
        ap.error(f'{args.path}: no such file or folder')
    if os.path.isdir(path):
        if args.main:
            mains = [args.main]
            if not os.path.isfile(os.path.join(path, args.main)):
                found = find_mains(path)
                ap.error(f'--main {args.main}: no such file in {args.path}'
                         + (f' (documents there: {", ".join(found)})' if found else ''))
        else:
            mains = find_mains(path)
        if not mains:
            tex = sorted(f for f in os.listdir(path) if f.endswith('.tex'))
            if not tex:
                ap.error(f'{args.path}: no .tex files in this folder; give the folder that holds the main file, '
                         'or the main .tex file itself')
            ap.error(f'{args.path}: none of its .tex files ({", ".join(tex[:8])}{", ..." if len(tex) > 8 else ""}) '
                     'is a whole document: no \\documentclass and \\begin{document}, directly or through '
                     '\\input. Give the main file: ./run <folder>/<main>.tex, or --main <file>')
        if len(mains) > 1 and not args.main:
            print(f'documents in {args.path}: {", ".join(mains)}; opening {mains[0]} (switch in the page, or --main)')
        path = os.path.join(path, mains[0])
    elif not path.endswith('.tex'):
        ap.error(f'{args.path}: not a .tex file or a folder')
    open_paper(path, args.cwd, args.state)
    ensure_state()
    load_token()
    BUILDER = Builder()
    threading.Thread(target=bib_entries, daemon=True).start()   # index the .bib files now, not at the first search
    try:
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', args.port or 8765), Handler)
    except OSError as e:
        if args.port:
            ap.error(f'--port {args.port}: cannot listen there ({e.strerror or e}); leave out --port to take a free one')
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)   # another editor has 8765
    port = srv.server_address[1]
    url = f'http://127.0.0.1:{port}/'
    if not args.no_open and not args.keep_running:
        threading.Thread(target=watch_clients, args=(srv,), daemon=True).start()
    print(f'Crypto Paper Reviewer for {os.path.join(PAPER, MAIN)} on {url}  (Ctrl+C to stop)', flush=True)
    # the first page load's slow parts (the PDF's text, the bibliography
    # index) are read while the window opens, not when it asks
    def warm():
        try:
            doc_payload()
            bib_entries()
        except Exception:
            pass
    threading.Thread(target=warm, daemon=True).start()
    # a restart after a change of the editor's code: the window is already open
    reexec = os.environ.pop('PE_REEXEC', None)
    if not args.no_open and not reexec:
        threading.Thread(target=open_browser, args=(url, args.browser), daemon=True).start()
    if not os.environ.get('PE_NO_RELOAD'):
        threading.Thread(target=watch_own_code, args=(port,), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    sys.exit(main())
