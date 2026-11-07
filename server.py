#!/usr/bin/env python3
"""A local reading editor for a LaTeX paper.

    paper-editor path/to/main.tex [--port 8765] [--no-open]

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
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, 'static')
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

DEFAULT_CONFIG = {
    # house rules applied to edited text when saving
    'house_rules': {'tie_before': ['cite', 'ref'], 'flag_bracketed_cref': True},
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


def resolve_input(name):
    """The file an \\input refers to, as a path relative to PAPER, or None.
    LaTeX looks in its working directory; a document compiled from the
    project root is found by also trying the root."""
    name = name.strip()
    bases, d = [PAPER], PAPER
    while ROOT and d != ROOT and d.startswith(ROOT) and os.path.dirname(d) != d:
        d = os.path.dirname(d)
        bases.append(d)
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
            t = open(p, encoding='utf-8', errors='replace').read()
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
    with open(os.path.join(PAPER, name), encoding='utf-8', errors='replace') as f:
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
    for sub in re.findall(r'\\@input\{([^}]*)\}', text):
        p = os.path.join(PAPER, sub)
        if os.path.exists(p):
            text += open(p, encoding='utf-8', errors='replace').read()
    return text


def load_aux():
    """Label values and types, citation numbers and heading numbers."""
    labels, cites, heads = {}, {}, []
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
    for k, n in re.findall(r'\\bibcite\{([^}]*)\}\{([^}]*)\}', aux):
        cites[k] = n
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
    return {'labels': labels, 'cites': cites, 'heads': heads}


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
    return {k: v for k, v in macros.items() if '@' not in k}


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
    for m in re.finditer(r'\\bibitem\{([^}]*)\}(.*?)(?=\\bibitem|\\end\{thebibliography\})', bbl, re.S):
        t = re.sub(r'\\BIBentry(ALT|STD)interwordspacing|\\BIBdecl[A-Za-z]*', '', m.group(2))
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


def fig_key(src):
    return sha(src)[:16]


def build_figures(log):
    """Render every float whose source changed to <cache>/<key>.png."""
    os.makedirs(CACHE, exist_ok=True)
    todo = [s for s in figure_sources() if not os.path.exists(os.path.join(CACHE, fig_key(s) + '.png'))]
    if not todo:
        return
    with tempfile.TemporaryDirectory() as tmp:
        main = read(MAIN)
        cut = main.find('\\begin{document}')
        doc = [main[:cut], r'\pagestyle{empty}', r'\begin{document}']
        for src in todo:
            env = re.match(r'\\begin\{(figure\*?|table\*?)\}', src).group(1)
            body = src[src.index('}') + 1:src.rindex('\\end{')]
            body = re.sub(r'^\[[^\]]*\]', '', body)
            body = strip_cmd(strip_cmd(body, 'caption'), 'label')
            doc.append(r'\begin{%s}[p]%s\end{%s}\clearpage' % (env, body, env))
        doc.append(r'\end{document}')
        tex = os.path.join(tmp, 'figs.tex')
        open(tex, 'w').write('\n'.join(doc))
        env = dict(os.environ, TEXINPUTS=PAPER + '//:' + os.path.dirname(PAPER) + '//:')
        r = subprocess.run(['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', 'figs.tex'],
                           cwd=tmp, env=env, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            log('figures: LaTeX failed')
            return
        subprocess.run(['pdfcrop', '--margins', '6', 'figs.pdf', 'crop.pdf'], cwd=tmp,
                       capture_output=True, timeout=300)
        for n, src in enumerate(todo, 1):
            out = os.path.join(CACHE, fig_key(src))
            subprocess.run(['pdftoppm', '-r', '200', '-png', '-singlefile', '-f', str(n), '-l', str(n),
                            os.path.join(tmp, 'crop.pdf'), out], capture_output=True, timeout=120)
            # the figure's text, for reading it in the viewer
            subprocess.run(['pdftotext', '-layout', '-f', str(n), '-l', str(n), os.path.join(tmp, 'figs.pdf'),
                            out + '.txt'], capture_output=True, timeout=120)
    log(f'figures: rendered {len(todo)}')


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

    def loop(self):
        try:
            build_figures(self.log)
        except Exception as e:  # figures are a nicety; never stop the server
            self.log(f'figures: {e}')
        while True:
            self.wanted.wait()
            time.sleep(1.5)  # let several saves in a row share one build
            self.wanted.clear()
            self.state = {'state': 'running', 'message': 'latexmk', 'at': time.time()}
            cmd = CONFIG.get('build') or ['latexmk', '-pdf', '-synctex=1', '-interaction=nonstopmode',
                                          '-halt-on-error', MAIN]
            r = subprocess.run(cmd, cwd=PAPER, capture_output=True, text=True, timeout=600,
                               shell=isinstance(cmd, str))
            if r.returncode == 0:
                self.aux = load_aux()
                self.auxver += 1
                self.state = {'state': 'ok', 'message': 'PDF rebuilt', 'at': time.time()}
            else:
                err = [l for l in r.stdout.splitlines() if l.startswith('!')][:3]
                self.state = {'state': 'error', 'message': ' '.join(err) or 'latexmk failed', 'at': time.time()}
            self.log('build: ' + self.state['message'])
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
    for src in figure_sources():
        k = fig_key(src)
        if os.path.exists(os.path.join(CACHE, k + '.png')):
            figs[src] = '/fig/' + k + '.png'
    for name, f in files.items():
        SESSION_START.setdefault(name, f['text'])
    return {'pages': synctex_pages(), 'docclass': docclass(),
            'main': MAIN, 'mains': find_mains(PAPER), 'resolve': input_map(), 'files': files, 'aux': BUILDER.aux, 'auxver': BUILDER.auxver,
            'macros': load_macros(), 'theorems': load_theorems(), 'config': CONFIG,
            'bib': load_bib(), 'figs': figs, 'build': BUILDER.state,
            'tts': {}}


def state_payload():
    return {'hashes': {n: sha(read(n)) for n in paper_files()}, 'auxver': BUILDER.auxver,
            'build': BUILDER.state}


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
    hits = []
    for key, title, authors, year, typ, src in bib_entries():
        hay = f'{key} {title} {authors} {year}'.lower()
        if all(w in hay for w in words):
            score = (key in cited) * 4 + (src == bib_target()) * 2 + key.lower().startswith(words[0]) * 3
            score += sum(w in key.lower() for w in words)
            hits.append((score, year, key, title, authors, src))
    hits.sort(key=lambda h: (-h[0], -(int(h[1]) if str(h[1]).isdigit() else 0)))
    target = bib_target()
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
    text = open(path, encoding='utf-8').read() if os.path.exists(path) else ''
    with open(path, 'w', encoding='utf-8') as f:
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
                           capture_output=True, text=True, timeout=20)
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
        if p == '/api/baseline':
            q = urllib.parse.parse_qs(url.query)
            name, ref = q.get('name', [''])[0], q.get('ref', ['head'])[0]
            if name not in paper_files():
                return self.send(400, {'error': 'unknown file'})
            return self.send(200, {'text': baseline(name, ref)})
        if p.startswith('/figtext/') and re.fullmatch(r'/figtext/[0-9a-f]{16}', p):
            f = os.path.join(CACHE, p[9:] + '.txt')
            return self.send(200, {'text': open(f).read() if os.path.exists(f) else ''})
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
            BUILDER.log('page: ' + self.rfile.read(n).decode(errors='replace')[:4000])
            return self.send(200, {})
        if urllib.parse.urlparse(self.path).path == '/api/open':
            n = int(self.headers.get('Content-Length', 0))
            name = json.loads(self.rfile.read(n)).get('main', '')
            if name not in find_mains(os.path.join(PAPER, os.path.dirname(MAIN))):
                return self.send(400, {'error': 'not a document of this project'})
            open_paper(os.path.join(PAPER, os.path.dirname(MAIN), name))
            ensure_state()
            BUILDER.aux = load_aux()
            BUILDER.auxver += 1
            return self.send(200, {'main': MAIN})
        if urllib.parse.urlparse(self.path).path == '/api/bibadd':
            n = int(self.headers.get('Content-Length', 0))
            req = json.loads(self.rfile.read(n))
            try:
                bib = online_add(req.get('source', ''), req.get('id', ''), req.get('key', ''))
            except Exception as e:
                return self.send(400, {'error': str(e)})
            BUILDER.log(f"added {req.get('key')} to references.bib")
            return self.send(200, {'bib': bib})
        if urllib.parse.urlparse(self.path).path != '/api/save':
            return self.send(404, {'error': 'not found'})
        n = int(self.headers.get('Content-Length', 0))
        req = json.loads(self.rfile.read(n))
        name, base, text = req.get('name'), req.get('base'), req.get('text')
        if name not in paper_files() or not isinstance(text, str):
            return self.send(400, {'error': 'unknown file'})
        current = read(name)
        if sha(current) != base:
            return self.send(409, {'error': 'changed on disk', 'hash': sha(current)})
        path = os.path.join(PAPER, name)
        tmp = path + '.editor-tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(tmp, path)
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


def open_paper(path, cwd=None):
    """Point the editor at a main file (path relative to PAPER or absolute)."""
    global PAPER, MAIN, ROOT, STATE, CACHE, CONFIG, VOICES
    path = os.path.abspath(path)
    PAPER = os.path.abspath(cwd) if cwd else os.path.dirname(path)
    MAIN = os.path.relpath(path, PAPER)
    r = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=os.path.dirname(path),
                       capture_output=True, text=True)
    ROOT = r.stdout.strip() if r.returncode == 0 else PAPER
    STATE = os.path.join(os.path.dirname(path), '.paper-editor')
    CACHE = os.path.join(STATE, 'cache')
    CONFIG = json.loads(json.dumps(DEFAULT_CONFIG))
    for cfg in (os.path.join(os.path.dirname(path), '.paper-editor.json'), os.path.join(STATE, 'config.json')):
        if os.path.exists(cfg):
            CONFIG.update(json.load(open(cfg)))
    _bib.update(entries=None, stamp=None)


def ensure_state():
    """Create <project>/.paper-editor with a .gitignore for its cache."""
    os.makedirs(CACHE, exist_ok=True)
    gi = os.path.join(STATE, '.gitignore')
    if not os.path.exists(gi):
        open(gi, 'w').write('# written by paper-editor: the cache is not worth tracking\ncache/\n')


def main():
    global BUILDER
    ap = argparse.ArgumentParser(description='A local reading editor for a LaTeX paper.')
    ap.add_argument('path', help='a project folder, or its main .tex file')
    ap.add_argument('--main', help='the main file, when the folder has several documents')
    ap.add_argument('--cwd', help='the directory LaTeX runs in (default: the main file\'s directory)')
    ap.add_argument('--port', type=int, default=8765)
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
    open_paper(path, args.cwd)
    ensure_state()
    BUILDER = Builder()
    threading.Thread(target=bib_entries, daemon=True).start()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://127.0.0.1:{args.port}/'
    print(f'Paper editor for {os.path.join(PAPER, MAIN)} on {url}  (Ctrl+C to stop)', flush=True)
    if not args.no_open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    sys.exit(main())
