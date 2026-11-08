"""Metadata of a paper and conversion between venue classes.

The converted paper is a new main file (by default under converted/<venue>/): the target
class's front matter written from the metadata, the old preamble with what
the target cannot take removed or shimmed, and the old body (its \\input
files unchanged).  See docs/styles.md for the differences handled here.
"""
import difflib
import hashlib
import json
import os
import re

TARGETS = {
    # name: (label, \documentclass line, anonymous variant, bibliography style or None to keep)
    'ieee': ('IEEEtran conference (S&P, CSF, EuroS&P)', r'\documentclass[conference]{IEEEtran}',
             r'\documentclass[conference]{IEEEtran}', 'IEEEtran'),
    'llncs': ('LNCS (Eurocrypt, Crypto, Asiacrypt, TCC, PKC)', r'\documentclass[runningheads]{llncs}',
              r'\documentclass[runningheads]{llncs}', 'splncs04'),
    'iacrcc': ('IACR Communications in Cryptology', r'\documentclass[version=preprint]{iacrcc}',
               r'\documentclass[version=submission]{iacrcc}', None),
    'iacrtrans': ('IACR Transactions (ToSC, TCHES)', r'\documentclass[journal=tosc,final]{iacrtrans}',
                  r'\documentclass[journal=tosc,submission]{iacrtrans}', 'alpha'),
    'acmart': ('ACM sigconf (CCS)', r'\documentclass[sigconf]{acmart}',
               r'\documentclass[sigconf,anonymous,review]{acmart}', 'ACM-Reference-Format'),
    'lipics': ('LIPIcs (ITP)', r'\documentclass[a4paper,UKenglish,cleveref,autoref,thm-restate]{lipics-v2021}',
               r'\documentclass[a4paper,UKenglish,cleveref,autoref,thm-restate,anonymous]{lipics-v2021}', 'plainurl'),
    'article': ('Plain article (preprint)', r'\documentclass[11pt]{article}',
                r'\documentclass[11pt]{article}', 'alpha'),
}

# Fields each target needs (author-level and paper-level); the editor asks for them.
REQUIRED = {
    'ieee': {'author': ['name'], 'affiliation': ['name'], 'paper': ['title']},
    'llncs': {'author': ['name'], 'affiliation': ['name'], 'paper': ['title']},
    'iacrcc': {'author': ['name', 'email'], 'affiliation': ['name', 'country'], 'paper': ['title', 'license']},
    'iacrtrans': {'author': ['name'], 'affiliation': ['name'], 'paper': ['title']},
    'acmart': {'author': ['name', 'email'], 'affiliation': ['name', 'city', 'country'], 'paper': ['title']},
    'lipics': {'author': ['name'], 'affiliation': ['name'], 'paper': ['title', 'license']},
    'article': {'author': ['name'], 'affiliation': [], 'paper': ['title']},
}

# Theorem environments each class predefines (redefining them is an error).
PREDEFINED_THEOREMS = {
    'llncs': {'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'example', 'remark', 'note',
              'claim', 'conjecture', 'exercise', 'problem', 'property', 'question', 'solution', 'case', 'proof'},
    'iacrcc': {'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'example', 'remark', 'proof'},
    'iacrtrans': {'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'example', 'remark', 'proof'},
    'lipics': {'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'example', 'remark', 'proof',
               'claim', 'conjecture', 'observation', 'exercise', 'note'},
    'acmart': {'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'example', 'conjecture', 'proof'},
}
NO_CLEVEREF = {'iacrcc', 'iacrtrans'}           # svjour3 too (not a target here)


def group(t, i):
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


def args_after(t, m_end, n):
    """n brace groups (skipping an optional [..]) after position m_end."""
    out, k = [], m_end
    for _ in range(n):
        while k < len(t) and t[k] in ' \n\t':
            k += 1
        if k < len(t) and t[k] == '[':
            k = t.index(']', k) + 1
            while t[k] in ' \n\t':
                k += 1
        if k >= len(t) or t[k] != '{':
            break
        a, k = group(t, k)
        out.append(a)
    return out, k


def strip_comments(t):
    return re.sub(r'(?<!\\)%.*', '', t)


def name_of(t):
    """An author or affiliation as LaTeX, without the structural commands
    around it (\\inst, \\orcidID, \\thanks, line breaks); accents and
    other LaTeX in the name are kept, since it goes back into LaTeX."""
    t = re.sub(r'\\(thanks|footnote|orcidID|inst|IEEEauthorrefmark|email)\s*\{[^{}]*\}', '', t)
    t = re.sub(r'\\\\(\[[^\]]*\])?', ' ', t)
    return re.sub(r'\s+', ' ', t).strip(' ,;')


def clean(t):
    """LaTeX to plain text, for metadata fields."""
    t = re.sub(r'\\(thanks|footnote|orcidID|inst|IEEEauthorrefmark)\{[^{}]*\}', '', t)
    t = re.sub(r'\\(textbf|textit|emph|textsc|mbox)\{([^{}]*)\}', r'\2', t)
    t = t.replace('\\\\', ' ').replace('~', ' ')
    t = re.sub(r'\\[a-zA-Z]+\*?', ' ', t)
    return re.sub(r'\s+', ' ', t.replace('{', '').replace('}', '')).strip(' ,;')


def opt_fields(opts):
    return {k.strip(): v.strip().strip('{}') for k, v in re.findall(r'(\w+)\s*=\s*(\{[^}]*\}|[^,]+)', opts or '')}


def doc_class(text):
    m = re.search(r'^[^%\n]*\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}', text, re.M)
    return m.group(1) if m else 'article'


def extract(text):
    """Metadata from the front matter of a main file, whatever its class."""
    t = strip_comments(text)
    cls = doc_class(t)
    md = {'title': '', 'running_title': '', 'authors': [], 'affiliations': [], 'keywords': [],
          'abstract': '', 'acknowledgements': '', 'license': '', 'source_class': cls}
    m = re.search(r'\\title\s*(\[([^\]]*)\])?\s*\{', t)
    if m:
        md['title'] = group(t, m.end() - 1)[0].replace('\\\\', ' ').strip()
        f = opt_fields(m.group(2))
        md['running_title'] = f.get('running', m.group(2) if m.group(2) and '=' not in m.group(2) else '')
    m = re.search(r'\\titlerunning\s*\{', t)
    if m:
        md['running_title'] = group(t, m.end() - 1)[0]
    affs = []

    def aff(name, **kw):
        name = name_of(name)
        for i, a in enumerate(affs):
            if a['name'] == name:
                return i
        affs.append({'name': name, 'department': '', 'city': kw.get('city', ''), 'country': kw.get('country', ''),
                     'ror': kw.get('ror', '')})
        return len(affs) - 1

    if cls == 'iacrcc':
        for m in re.finditer(r'\\addaffiliation\s*(\[[^\]]*\])?\s*\{', t):
            f = opt_fields((m.group(1) or '')[1:-1])
            aff(group(t, m.end() - 1)[0], country=f.get('country', ''), ror=f.get('ror', ''))
        for m in re.finditer(r'\\addauthor\s*(\[[^\]]*\])?\s*\{', t):
            f = opt_fields((m.group(1) or '')[1:-1])
            insts = [int(x) - 1 for x in re.findall(r'\d+', f.get('inst', ''))]
            md['authors'].append({'name': name_of(group(t, m.end() - 1)[0]), 'email': f.get('email', ''),
                                  'orcid': f.get('orcid', ''), 'affiliations': insts})
        m = re.search(r'\\license\s*\{([^}]*)\}', t)
        md['license'] = m.group(1) if m else ''
    elif cls == 'IEEEtran':
        # Metadata must use real authors even when the anonymous review branch
        # is active. Parse all \author blocks, ignoring anonymous placeholders.
        for m in re.finditer(r'\\author\s*\{', t):
            body = group(t, m.end() - 1)[0]
            names = [name_of(group(body, x.end() - 1)[0])
                     for x in re.finditer(r'\\IEEEauthorblockN\s*\{', body)]
            addrs = [group(body, x.end() - 1)[0]
                     for x in re.finditer(r'\\IEEEauthorblockA\s*\{', body)]
            if not names and clean(body):
                names = [name_of(body)]
            for i, n in enumerate(names):
                if not n or n.lower().startswith(('anonymous', 'blinded')):
                    continue
                a = addrs[i] if i < len(addrs) else ''
                email = re.search(r'[\w.+-]+@[\w.-]+', a)
                lines = [clean(x) for x in re.split(r'\\\\', a) if clean(x) and '@' not in x]
                city, country = '', ''
                if lines and ',' in lines[-1]:
                    city, country = [v.strip() for v in lines.pop().rsplit(',', 1)]
                organization = ', '.join(lines)
                ids = [aff(organization, city=city, country=country)] if organization else []
                md['authors'].append({'name': n, 'email': email.group(0) if email else '',
                                      'orcid': '', 'affiliations': ids})
    elif cls == 'acmart':
        for m in re.finditer(r'\\author\s*\{', t):
            name, k = group(t, m.end() - 1)
            rest = t[k:k + 600]
            inst = re.search(r'\\institution\{([^}]*)\}', rest)
            city = re.search(r'\\city\{([^}]*)\}', rest)
            country = re.search(r'\\country\{([^}]*)\}', rest)
            email = re.search(r'\\email\{([^}]*)\}', rest)
            md['authors'].append({'name': name_of(name), 'email': email.group(1) if email else '', 'orcid': '',
                                  'affiliations': [aff(inst.group(1), city=city.group(1) if city else '',
                                                       country=country.group(1) if country else '')] if inst else []})
    elif cls.startswith('lipics'):
        for m in re.finditer(r'\\author\s*\{', t):
            args, _ = args_after(t, m.end() - 1, 5)
            if len(args) >= 2:
                orcid = re.search(r'\d{4}-\d{4}-\d{4}-\d{3}[\dX]', args[3] if len(args) > 3 else '')
                md['authors'].append({'name': name_of(args[0]), 'email': args[2] if len(args) > 2 else '',
                                      'orcid': orcid.group(0) if orcid else '',
                                      'affiliations': [aff(args[1])]})
        md['license'] = 'CC-BY-4.0' if re.search(r'\\Copyright\s*\{', t) else ''
    else:   # llncs, iacrtrans, svjour3, article: \author{A\inst{1} \and B}, \institute{X \and Y}
        m = re.search(r'\\author\s*(\[[^\]]*\])?\s*\{', t)
        inst = re.search(r'\\institute\s*\{', t)
        institutes = []
        if inst:
            for part in re.split(r'\\and\b', group(t, inst.end() - 1)[0]):
                if re.search(r'\\at\b', part):          # svjour3: Author \at Institution
                    part = re.split(r'\\at\b', part, maxsplit=1)[1]
                email = re.search(r'\\email\{([^}]*)\}', part)
                institutes.append((aff(re.sub(r'\\email\{[^}]*\}', '', part)), email.group(1) if email else ''))
        if m:
            body = group(t, m.end() - 1)[0]
            for k, part in enumerate(re.split(r'\\and\b', body)):
                if not clean(part):
                    continue
                insts = [int(x) - 1 for x in re.findall(r'\\inst\{([\d,\s]+)\}', part) for x in x.split(',')]
                if not insts and k < len(institutes) and not re.search(r'\\inst\b', body):
                    insts = [k]
                orcid = re.search(r'\\orcidID\{([^}]*)\}', part)
                emails = [institutes[i][1] for i in insts if i < len(institutes) and institutes[i][1]]
                md['authors'].append({'name': name_of(part), 'email': emails[0] if emails else '',
                                      'orcid': orcid.group(1) if orcid else '',
                                      'affiliations': [institutes[i][0] for i in insts if i < len(institutes)]})
    md['affiliations'] = affs

    # Generic fields, including keywords in either preamble or document body.
    kw = re.search(r'\\keywords\s*\{', t)
    if kw:
        body = group(t, kw.end() - 1)[0]
        md['keywords'] = [clean(v) for v in re.split(r'\\and\b|,', body) if clean(v)]
    kw = re.search(r'\\begin\{(?:IEEEkeywords|keywords)\}(.*?)\\end\{(?:IEEEkeywords|keywords)\}', t, re.S)
    if kw:
        md['keywords'] = [clean(v) for v in kw.group(1).split(',') if clean(v)]
    abstract = re.search(r'\\begin\{(abstract|textabstract)\}(.*?)\\end\{\1\}', t, re.S)
    if abstract:
        md['abstract'] = re.sub(r'\\keywords\s*\{[^}]*\}', '', abstract.group(2)).strip()
    ack = re.search(r'\\begin\{(acks|acknowledgements?)\}(.*?)\\end\{\1\}', t, re.S) or \
          re.search(r'\\section\*\{Acknowledge?ments?[^}]*\}(.*?)(?=\\section|\\bibliography|\\printbibliography|\\appendix|\\end\{document\})', t, re.S)
    if ack:
        md['acknowledgements'] = re.sub(r'\\(?:fi|else)\s*$', '', ack.group(ack.lastindex).strip()).strip()
    lic = re.search(r'\\(?:license|licence)\s*\{', t)
    if lic and not md['license']:
        md['license'] = group(t, lic.end() - 1)[0].strip()
    if not md['running_title']:
        short = re.search(r'\\(?:shorttitle|runningtitle|markboth)\s*\{', t)
        if short:
            md['running_title'] = clean(group(t, short.end() - 1)[0])
    return md


def missing(md, target):
    """The fields the target needs that the metadata lacks: [(where, field)]."""
    req = REQUIRED[target]
    out = [('paper', f) for f in req['paper'] if not md.get(f)]
    for i, a in enumerate(md['authors']):
        out += [(f'author {i + 1} ({a.get("name") or "?"})', f) for f in req['author'] if not a.get(f)]
        if req['affiliation'] and not a.get('affiliations'):
            out.append((f'author {i + 1} ({a.get("name") or "?"})', 'affiliation'))
    for i, af in enumerate(md['affiliations']):
        out += [(f'affiliation {i + 1} ({af.get("name") or "?"})', f) for f in req['affiliation'] if not af.get(f)]
    if not md['authors']:
        out.append(('paper', 'authors'))
    return out

# ---------------------------------------------------------------- writing

def front_matter(md, target, anonymous):
    """(before \\begin{document}, after it) for the target class."""
    title = md['title'] or 'Untitled'
    authors, affs = md['authors'], md['affiliations']
    kws = md['keywords']
    abstract = md['abstract']
    pre, post = [], []
    if target == 'ieee':
        post.append(f'\\title{{{title}}}')
        if anonymous:
            post.append('\\author{\\IEEEauthorblockN{Anonymous submission}}')
        else:
            blocks = []
            for a in authors:
                addr = ' \\\\ '.join(affs[i]['name'] + (f", {affs[i]['country']}" if affs[i].get('country') else '')
                                     for i in a['affiliations'] if i < len(affs))
                email = f" \\\\ {a['email']}" if a.get('email') else ''
                blocks.append(f"\\IEEEauthorblockN{{{a['name']}}}\n\\IEEEauthorblockA{{{addr}{email}}}")
            post.append('\\author{' + '\n\\and\n'.join(blocks) + '}')
        post.append('\\maketitle')
        post.append(f'\\begin{{abstract}}\n{abstract}\n\\end{{abstract}}')
        if kws:
            post.append('\\begin{IEEEkeywords}\n' + ', '.join(kws) + '\n\\end{IEEEkeywords}')
    elif target in ('llncs', 'iacrtrans'):
        if target == 'iacrtrans':
            pre.append(f'\\title{{{title}}}')
        else:
            post.append(f'\\title{{{title}}}')
            if md.get('running_title'):
                post.append(f"\\titlerunning{{{md['running_title']}}}")
        if anonymous and target == 'llncs':
            names, insts = 'Anonymous Submission', 'Anonymous'
        else:
            names = ' \\and '.join(a['name'] + (f"\\inst{{{','.join(str(i + 1) for i in a['affiliations'])}}}" if a['affiliations'] else '')
                                   + (f"\\orcidID{{{a['orcid']}}}" if a.get('orcid') and target == 'llncs' else '') for a in authors)
            insts = ' \\and '.join(af['name'] + (f", {af['country']}" if af.get('country') else '') +
                                   ''.join(f" \\email{{{a['email']}}}" for a in authors if a.get('email') and a['affiliations'][:1] == [i])
                                   for i, af in enumerate(affs))
        (pre if target == 'iacrtrans' else post).append(f'\\author{{{names}}}\n\\institute{{{insts}}}')
        post.append('\\maketitle')
        if target == 'iacrtrans' and kws:
            post.append('\\keywords{' + ' \\and '.join(kws) + '}')
        kw = ('\n\\keywords{' + ' \\and '.join(kws) + '}') if kws and target == 'llncs' else ''
        post.append(f'\\begin{{abstract}}\n{abstract}{kw}\n\\end{{abstract}}')
    elif target == 'iacrcc':
        lic = md.get('license') or 'CC-by'
        if re.match(r'(?i)cc[- ]?by(?!-?(nc|nd|sa))', lic):
            lic = 'CC-by'               # the only spelling iacrcc accepts
        pre.append(f"\\license{{{lic}}}")
        rt = f"[running = {{{md['running_title']}}}]" if md.get('running_title') else ''
        pre.append(f'\\title{rt}{{{title}}}')
        for a in authors:
            opts = [f"inst = {{{','.join(str(i + 1) for i in a['affiliations'])}}}"] if a['affiliations'] else []
            opts += [f"email = {{{a['email']}}}"] if a.get('email') else []
            opts += [f"orcid = {{{a['orcid']}}}"] if a.get('orcid') else []
            pre.append(f"\\addauthor[{', '.join(opts)}]{{{a['name']}}}")
        for af in affs:
            opts = [f"country = {{{af['country']}}}"] if af.get('country') else []
            opts += [f"ror = {{{af['ror']}}}"] if af.get('ror') else []
            pre.append(f"\\addaffiliation[{', '.join(opts)}]{{{af['name']}}}")
        post.append('\\maketitle')
        if kws:
            post.append('\\keywords{' + ', '.join(kws) + '}')
        post.append(f'\\begin{{textabstract}}\n{abstract}\n\\end{{textabstract}}')
    elif target == 'acmart':
        post.append(f'\\title{{{title}}}')
        for a in authors:
            post.append(f"\\author{{{a['name']}}}")
            for i in a['affiliations']:
                af = affs[i]
                post.append(f"\\affiliation{{\\institution{{{af['name']}}}\\city{{{af.get('city') or ''}}}\\country{{{af.get('country') or ''}}}}}")
            if a.get('email'):
                post.append(f"\\email{{{a['email']}}}")
        post.append(f'\\begin{{abstract}}\n{abstract}\n\\end{{abstract}}')
        if kws:
            post.append('\\keywords{' + ', '.join(kws) + '}')
        post.append('\\maketitle')
    elif target == 'lipics':
        pre.append(f'\\title{{{title}}}')
        if md.get('running_title'):
            pre.append(f"\\titlerunning{{{md['running_title']}}}")
        for a in authors:
            aff = '; '.join(affs[i]['name'] + (f", {affs[i]['country']}" if affs[i].get('country') else '') for i in a['affiliations'])
            orcid = f"https://orcid.org/{a['orcid']}" if a.get('orcid') else ''
            pre.append(f"\\author{{{a['name']}}}{{{aff}}}{{{a.get('email', '')}}}{{{orcid}}}{{}}")
        pre.append('\\authorrunning{' + ', '.join(a['name'] for a in authors) + '}')
        pre.append('\\Copyright{' + ', '.join(a['name'] for a in authors) + '}')
        pre.append('\\ccsdesc[500]{Security and privacy~Formal methods and theory of security}')
        pre.append('\\keywords{' + ', '.join(kws) + '}')
        post.append('\\maketitle')
        post.append(f'\\begin{{abstract}}\n{abstract}\n\\end{{abstract}}')
    else:   # article
        post.append(f'\\title{{{title}}}')
        post.append('\\author{' + ('Anonymous' if anonymous else ' \\and '.join(
            a['name'] + (''.join(f" \\\\ {affs[i]['name']}" for i in a['affiliations'])) for a in authors)) + '}')
        post.append('\\maketitle')
        post.append(f'\\begin{{abstract}}\n{abstract}\n\\end{{abstract}}')
    return '\n'.join(pre), '\n'.join(post)


FRONT_CMDS = ['title', 'titlerunning', 'author', 'authorrunning', 'institute', 'addauthor', 'addaffiliation',
              'affiliation', 'email', 'orcidID', 'license', 'keywords', 'Copyright', 'ccsdesc', 'date',
              'journalname', 'thanks', 'EventEditors', 'EventNoEds', 'EventLongTitle', 'EventShortTitle',
              'EventAcronym', 'EventYear', 'EventDate', 'EventLocation', 'EventLogo', 'SeriesVolume',
              'ArticleNo', 'smartqed']


def remove_cmds(text, names):
    """Remove \\name[opt]{...}... commands (all their brace groups) from text."""
    out, i = [], 0
    pat = re.compile(r'\\(' + '|'.join(names) + r')(?![A-Za-z])\*?')
    while True:
        m = pat.search(text, i)
        if not m:
            out.append(text[i:])
            return ''.join(out)
        out.append(text[i:m.start()])
        k = m.end()
        while True:
            j = k
            while j < len(text) and text[j] in ' \t\n':
                j += 1
            if j < len(text) and text[j] == '[':
                k = text.index(']', j) + 1
                continue
            if j < len(text) and text[j] == '{':
                _, k = group(text, j)
                continue
            break
        i = k


CLASS_LOADS_HYPERREF = {'lipics', 'iacrcc', 'iacrtrans', 'acmart'}
CREF_FALLBACK = r"""\makeatletter
\newcommand{\pe@crefs}[1]{\def\pe@sep{}\@for\pe@x:=#1\do{\pe@sep\expandafter\autoref\expandafter{\pe@x}\def\pe@sep{, }}}
\@ifundefined{cref}{\DeclareRobustCommand{\cref}[1]{\pe@crefs{#1}}}{}
\@ifundefined{Cref}{\DeclareRobustCommand{\Cref}[1]{\pe@crefs{#1}}}{}
\makeatother"""
# robust: \cref in a \caption (written to the .aux) must not expand there
# packages a body may rely on because its old class loaded them
PACKAGE_NEEDS = [
    ('amsmath', r'\\begin\{(align|gather|multline|alignat|flalign)\*?\}|\\eqref\b|\\text\{|\\tfrac|\\dfrac|\\binom'),
    ('amssymb', r'\\mathbb\{|\\leqslant|\\geqslant|\\nleq|\\varnothing|\\blacksquare'),
    ('booktabs', r'\\(toprule|midrule|bottomrule|cmidrule)\b'),
    ('multirow', r'\\multirow\b'),
    ('graphicx', r'\\includegraphics\b|\\(rotatebox|scalebox|resizebox)\b'),
    ('xcolor', r'\\(textcolor|colorbox|color)\{'),
    ('url', r'\\url\{'),
]
THEOREM_GUARD = r"""% paper-editor: \newtheorem skips environments the class already defines
\makeatletter
\let\pe@newtheorem\newtheorem
\def\newtheorem{\@ifstar{\pe@nt{*}}{\pe@nt{}}}
\def\pe@nt#1#2{\@ifundefined{#2}{\pe@newtheorem#1{#2}}{\pe@skip}}
\def\pe@skip{\@ifnextchar[{\pe@skipa}{\pe@skipb}}
\def\pe@skipa[#1]#2{}
\def\pe@skipb#1{\@ifnextchar[{\pe@skipc}{}}
\def\pe@skipc[#1]{}
\makeatother"""



def drop_class_theorems(preamble, names):
    r"""Remove theorem/counter declarations already provided by the target class.

    In particular, aliascnt's \newaliascnt defines \c@lemma *before* a
    subsequent guarded \newtheorem can skip it.  Both commands must go.
    Only declarations of class-owned environments are removed: user-defined
    theorem environments remain intact.
    """
    if not names:
        return preamble
    pattern = '|'.join(re.escape(n) for n in sorted(names, key=len, reverse=True))
    # \newaliascnt{lemma}{theorem} and \aliascntresetthe{lemma}
    preamble = re.sub(r'\\newaliascnt\s*\{(?:' + pattern + r')\}\s*\{[^{}]*\}[ \t]*(?:\n|$)',
                      '', preamble)
    preamble = re.sub(r'\\aliascntresetthe\s*\{(?:' + pattern + r')\}[ \t]*(?:\n|$)',
                      '', preamble)
    # \newtheorem{lemma}[theorem]{Lemma}, \newtheorem*{...}{...},
    # \spnewtheorem{...}{...}{\bfseries}{\itshape}, and section counters.
    decl = re.compile(r'\\(?:sp)?newtheorem\*?\s*\{(?:' + pattern + r')\}')
    out, pos = [], 0
    for m in decl.finditer(preamble):
        if m.start() < pos:
            continue
        k = m.end()
        for _ in range(5):
            while k < len(preamble) and preamble[k] in ' \t\r\n':
                k += 1
            if k < len(preamble) and preamble[k] == '[':
                end = preamble.find(']', k + 1)
                if end < 0:
                    break
                k = end + 1
            elif k < len(preamble) and preamble[k] == '{':
                try:
                    _, k = group(preamble, k)
                except (IndexError, AssertionError):
                    break
            else:
                break
        # Only remove when followed by the next command, comment or newline.
        # Preserve unrelated inline text.
        out.append(preamble[pos:m.start()])
        pos = k
    out.append(preamble[pos:])
    return ''.join(out)


def inline_inputs(text, resolve, depth=0):
    r"""Replace \input{x} by the contents of x, recursively (preamble only)."""
    if depth > 6 or resolve is None:
        return text

    def sub(m):
        if text.rfind('%', text.rfind('\n', 0, m.start()) + 1, m.start()) >= 0:
            return m.group(0)
        content = resolve(m.group(1))
        if content is None:
            return m.group(0)
        return f'% --- {m.group(1)} (inlined) ---\n' + inline_inputs(content, resolve, depth + 1).rstrip('\n') + \
            f'\n% --- end of {m.group(1)} ---'
    return re.sub(r'\\input\s*\{([^}]*)\}', sub, text)


ACMART_FONTS = ('inconsolata', 'zi4', 'libertine', 'libertinus', 'libertinust1math', 'newtxtext', 'newtxmath',
                'mathptmx', 'times', 'txfonts', 'pxfonts', 'lmodern', 'charter', 'mathpazo', 'palatino')


def relocate_bibliography(text, rel):
    r"""\bibliography and \addbibresource entries relative to a folder rel
    (for a file written into converted/<venue>/: '../..').  BibTeX looks a
    name with a folder (cryptobib/crypto) up only from where it runs, never
    along BIBINPUTS."""
    if not rel or rel == '.':
        return text
    def fix(name):
        name = name.strip()
        if not name or os.path.isabs(name) or name.startswith('~'):
            return name
        return rel.rstrip('/') + '/' + name
    text = re.sub(r'(?m)^([^%\n]*\\bibliography\{)([^}]*)\}',
                  lambda m: m.group(1) + ','.join(fix(n) for n in m.group(2).split(',')) + '}', text)
    return re.sub(r'(?m)^([^%\n]*\\addbibresource(?:\[[^\]]*\])?\{)([^}]*)\}', lambda m: m.group(1) + fix(m.group(2)) + '}', text)


def drop_package(preamble, name):
    r"""Remove a package from \usepackage lines, also from lists."""
    def sub(m):
        pkgs = [p.strip() for p in m.group(2).split(',')]
        keep = [p for p in pkgs if p != name]
        if len(keep) == len(pkgs):
            return m.group(0)
        return '' if not keep else f'\\usepackage{m.group(1) or ""}{{{",".join(keep)}}}'
    return re.sub(r'\\usepackage(\[[^\]]*\])?\{([^}]*)\}[ \t]*\n?', sub, preamble)


def _convert(main_text, md, target, anonymous, theorems_used, resolve=None, all_text=''):
    r"""The new main file, and warnings.  resolve(name) gives the text of an
    \input file (or None); all_text is every file of the paper, to scan for
    the commands the body uses."""
    warnings = []
    _, cls_line, cls_anon, bibstyle = TARGETS[target]
    t = main_text
    begin = t.index('\\begin{document}')
    preamble = inline_inputs(t[:begin], resolve)
    body = t[begin + len('\\begin{document}'):]
    everything = preamble + body + all_text
    # the preamble: no class line, no old front matter
    preamble = re.sub(r'^[^%\n]*\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]*\}[^\n]*\n?', '', preamble, count=1, flags=re.M)
    preamble = remove_cmds(preamble, FRONT_CMDS)
    pre_shims, shims = [], []
    # packages the target loads, forbids or replaces
    if target in CLASS_LOADS_HYPERREF:
        # iacrcc and iacrtrans load hyperref at \begin{document}: set it up then
        late = target in ('iacrcc', 'iacrtrans')
        preamble = re.sub(r'\\usepackage\[([^\]]*)\]\{hyperref\}',
                          (r'\\AtBeginDocument{\\hypersetup{\1}}' if late else r'\\hypersetup{\1}'), preamble)
        preamble = drop_package(preamble, 'hyperref')
        if late:
            preamble = re.sub(r'(?<!\{)\\hypersetup(\{(?:[^{}]|\{[^{}]*\})*\})', r'\\AtBeginDocument{\\hypersetup\1}', preamble)
            # other hyperref commands of the preamble wait for it too
            preamble = re.sub(r'(?<!\{)\\pdfstringdefDisableCommands(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})',
                              lambda m: '\\AtBeginDocument{\\pdfstringdefDisableCommands' + m.group(1) + '}', preamble)
    pre_class = []
    if target == 'acmart':
        # acmart sets its fonts (libertine, inconsolata, newtx maths): a second
        # font package redefines them ("\\zifour@default already defined")
        for p in ('amssymb', 'amsfonts') + ACMART_FONTS:
            if p not in ('amssymb', 'amsfonts') and re.search(r'\\usepackage(\[[^\]]*\])?\{[^}]*\b' + re.escape(p) + r'\b', preamble):
                warnings.append(f'{p} dropped: acmart sets its own fonts.')
            preamble = drop_package(preamble, p)
    if target == 'lipics':
        # the class loads cleveref itself (class option cleveref): its options go first
        m = re.search(r'\\usepackage\[([^\]]*)\]\{cleveref\}', preamble)
        if m:
            pre_class.append('\\PassOptionsToPackage{' + m.group(1) + '}{cleveref}')
        preamble = drop_package(re.sub(r'\\usepackage\[[^\]]*\]\{cleveref\}[ \t]*\n?', '', preamble), 'cleveref')
    if target in PREDEFINED_THEOREMS:
        preamble = drop_class_theorems(preamble, PREDEFINED_THEOREMS[target])
    if target == 'llncs':
        preamble = drop_package(preamble, 'amsthm')
        pre_shims.append('\\providecommand{\\theoremstyle}[1]{}\\providecommand{\\newtheoremstyle}[9]{}'
                         '\\providecommand{\\qedhere}{}')
    if target in PREDEFINED_THEOREMS:
        pre_shims.append(THEOREM_GUARD)
    # cross-references
    uses_cref = bool(re.search(r'\\[cC]ref\b', everything))
    preamble = re.sub(r'\\usepackage(\[[^\]]*\])?\{cleveref\}[ \t]*\n?', '', preamble) if target in NO_CLEVEREF else preamble
    if target in NO_CLEVEREF:
        preamble = re.sub(r'\\(crefname|Crefname|creflabelformat)\{[^}]*\}(\{[^}]*\}){0,2}[ \t]*\n?', '', preamble)
        if uses_cref:
            shims.append("% cleveref does not load with this class: \\cref falls back to hyperref's \\autoref")
            shims.append(CREF_FALLBACK)
            warnings.append('\\cref and \\Cref become hyperref\'s \\autoref, label by label ("Theorem 1, Lemma 2").')
    elif uses_cref and target != 'lipics' and not re.search(r'\\usepackage(\[[^\]]*\])?\{[^}]*cleveref', preamble):
        shims.append('\\usepackage{cleveref}')
    # theorems for classes that define none
    if target in ('ieee', 'article'):
        defined = set(re.findall(r'\\(?:sp)?newtheorem\*?\{([^}]*)\}', preamble))
        need = [e for e in theorems_used if e not in defined and e != 'proof']
        if need:
            for k, e in enumerate(need):
                shims.append(f'\\newtheorem{{{e}}}{"" if k == 0 else "[" + need[0] + "]"}{{{e.capitalize()}}}')
    if target == 'llncs':
        defined = set(re.findall(r'\\(?:sp)?newtheorem\*?\{([^}]*)\}', preamble))
        for e in theorems_used:
            if e not in PREDEFINED_THEOREMS['llncs'] and e not in defined:
                shims.append(f'\\spnewtheorem{{{e}}}{{{e.capitalize()}}}{{\\bfseries}}{{\\itshape}}')
    # citations from natbib
    if target != 'acmart' and re.search(r'\\cite[tp]\b', everything) and not re.search(r'\{[^}]*natbib', preamble):
        shims.append('\\providecommand{\\citet}{\\cite}\\providecommand{\\citep}{\\cite}')
        warnings.append('\\citet and \\citep (natbib) become \\cite: "Author [1]" reads as "[1]".')
    # packages the old class loaded and the body relies on
    loaded = set()
    for m in re.finditer(r'\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}', preamble):
        loaded |= {p.strip() for p in m.group(1).split(',')}
    for pkg, pat in PACKAGE_NEEDS:
        if pkg in loaded or (pkg == 'amssymb' and target == 'acmart'):
            continue
        if re.search(pat, everything):
            pre_shims.append(f'\\usepackage{{{pkg}}}')
    if target in ('ieee', 'article') and ('\\begin{proof}' in everything or theorems_used) and 'amsthm' not in loaded:
        pre_shims.append('\\usepackage{amsthm}')        # before any \\newtheorem
    shims.append('\\providecommand{\\appendices}{\\appendix}')
    if target == 'ieee' and '\\part' in everything:
        shims.append('\\providecommand{\\part}[1]{\\section{#1}}')
        warnings.append('\\part is mapped to \\section for IEEEtran.')
    # the body: old front matter out
    body = remove_cmds(body, FRONT_CMDS + ['maketitle'])
    body = re.sub(r'\\begin\{(abstract|textabstract)\}.*?\\end\{\1\}\s*', '', body, count=1, flags=re.S)
    body = re.sub(r'\\begin\{IEEEkeywords\}.*?\\end\{IEEEkeywords\}\s*', '', body, count=1, flags=re.S)
    # bibliography: exactly one style, the target's (none for iacrcc or biblatex)
    preamble = re.sub(r'\\bibliographystyle\{[^}]*\}[ \t]*\n?', '', preamble)
    body = re.sub(r'\\bibliographystyle\{[^}]*\}[ \t]*\n?', '', body)
    biblatex = '\\printbibliography' in everything or re.search(r'\{[^}]*biblatex', preamble)
    if bibstyle and not biblatex and '\\bibliography{' in body:
        body = body.replace('\\bibliography{', '\\bibliographystyle{' + bibstyle + '}\n\\bibliography{', 1)
    if target == 'ieee':
        body = re.sub(r'\\appendix\b(?!\w)', r'\\appendices', body)
    # anonymous
    if anonymous:
        md = dict(md, title=re.sub(r'\\thanks\s*\{[^{}]*\}', '', md.get('title', '')), running_title='',
                  authors=[{'name': 'Anonymous', 'email': '', 'orcid': '', 'affiliations': [0]}],
                  affiliations=[{'name': 'Anonymous', 'department': '', 'city': 'Anonymous', 'country': 'Anonymous', 'ror': ''}])
        shims.append('\\AtBeginDocument{\\ifdefined\\hypersetup\\hypersetup{pdfauthor={}}\\fi}')
        body, n1 = re.subn(r'\\begin\{(acks|acknowledgements?)\}.*?\\end\{\1\}\s*', '', body, flags=re.S)
        body, n2 = re.subn(r'\\section\*?\{Acknowledge?ments?[^}]*\}.*?(?=\\section|\\bibliography|\\printbibliography|\\appendix|\\end\{document\})',
                           '', body, flags=re.S | re.I)
        if n1 + n2:
            warnings.append('Acknowledgements removed from the main file.')
        if re.search(r'acknowledg|\\thanks|funded by|grant', all_text, re.I):
            warnings.append('Other files mention acknowledgements, \\thanks, funding or grants: check them, they are not changed.')
        warnings.append('Also check the text for self-citations in the first person and links to your repositories.')
    pre_fm, post_fm = front_matter(md, target, anonymous)
    out = ('% Converted by paper-editor from ' + md.get('source_class', '?') + (' (anonymous)' if anonymous else '') + '\n' +
           ''.join(line + '\n' for line in pre_class) + (cls_anon if anonymous else cls_line) + '\n' + '\n'.join(pre_shims) + '\n' + preamble.strip('\n') + '\n' +
           '\n'.join(shims) + '\n' + pre_fm + '\n\\begin{document}\n' + post_fm + '\n' + body.lstrip('\n'))
    return out, warnings


# ------------------------------------------------------------------ round trips
#
# A converted main file ends, after \end{document} (where LaTeX stops
# reading), with a comment record of the main file it came from:
#
#   %@paper-editor origin class=IEEEtran sha1=<of the original> (...)
#   %|<each line of the original main file>
#   %=<a> <b>           the converted text as written: lines a..b-1 of the original,
#   %+<line>            or a line of its own
#
# Converting back to the original's class gives the original byte for byte;
# edits made since in the converted text are carried over where they fall on
# lines that were copied from the original (the body), and a chain of
# conversions always starts again from the original, so shims never pile up.

ORIGIN_TAG = '%@paper-editor origin '


def _sha(t):
    return hashlib.sha1(t.encode('utf-8', 'surrogatepass')).hexdigest()


def _lines(t):
    """Lines with their ends, so that ''.join(_lines(t)) == t, for any line ends."""
    return re.findall(r'[^\n]*\n|[^\n]+$', t)


def class_of_target(target):
    return re.search(r'\{([^}]*)\}\s*$', TARGETS[target][1]).group(1)


def origin_record(origin, converted):
    """The record appended to a converted file (converted: the text before it)."""
    o, c = _lines(origin), _lines(converted)
    out = [f'{ORIGIN_TAG}class={doc_class(strip_comments(origin))} sha1={_sha(origin)} '
           f'(the main file this was converted from, so that converting back restores it exactly)\n']
    # the original, one line per line: '%|' + the line without its '\n'
    out += ['%|' + line + '\n' for line in origin.split('\n')]
    sm = difflib.SequenceMatcher(None, o, c, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            out.append(f'%={i1} {i2}\n')
        elif j2 > j1:
            out += ['%+' + line.rstrip('\n') + '\n' if line.endswith('\n') else '%-' + line + '\n' for line in c[j1:j2]]
    return out


def split_origin(text):
    """(the text before the record, origin, the converted text as written,
    alignment: for each line of it, the line of the origin it copies or None);
    origin is None when there is no intact record."""
    i = text.rfind('\n' + ORIGIN_TAG)
    if i < 0:
        return text, None, None, None
    head, rec = text[:i + 1], text[i + 1:].split('\n')
    m = re.match(re.escape(ORIGIN_TAG) + r'class=\S+ sha1=([0-9a-f]{40})', rec[0])
    if not m:
        return text, None, None, None
    rows = rec[1:]
    if rows and rows[-1] == '':
        rows = rows[:-1]
    k = 0
    while k < len(rows) and rows[k].startswith('%|'):
        k += 1
    origin = '\n'.join(r[2:] for r in rows[:k])
    if _sha(origin) != m.group(1):
        return text, None, None, None
    o = _lines(origin)
    conv, align = [], []
    for r in rows[k:]:
        if r.startswith('%='):
            a, b = map(int, r[2:].split())
            if not 0 <= a <= b <= len(o):
                return text, None, None, None
            conv += o[a:b]
            align += list(range(a, b))
        elif r.startswith('%+'):
            conv.append(r[2:] + '\n')
            align.append(None)
        elif r.startswith('%-'):         # a last line without '\n'
            conv.append(r[2:])
            align.append(None)
        else:
            return text, None, None, None
    return head, origin, ''.join(conv), align


def restore(text):
    """The original main file a converted one came from, with the edits made
    to the converted text since carried over; None when there is no record or
    an edit cannot be placed in the original (front matter, preamble)."""
    head, origin, conv, align = split_origin(text)
    if origin is None:
        return None
    if head == conv:
        return origin
    o, c, h = _lines(origin), _lines(conv), _lines(head)
    edits = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, c, h, autojunk=False).get_opcodes():
        if tag == 'equal':
            continue
        if i2 > i1:
            span = align[i1:i2]
            if None in span or span != list(range(span[0], span[0] + len(span))):
                return None
            a, b = span[0], span[-1] + 1
        elif i1 > 0 and align[i1 - 1] is not None:
            a = b = align[i1 - 1] + 1
        elif i1 < len(align) and align[i1] is not None:
            a = b = align[i1]
        else:
            return None
        edits.append((a, b, h[j1:j2]))
    for a, b, new in sorted(edits, reverse=True):
        o[a:b] = new
    return ''.join(o)


def convert(main_text, md, target, anonymous, theorems_used, resolve=None, all_text='', rel=None):
    r"""The new main file, and warnings (rel: where the original's folder is,
    from the folder the new file goes to, e.g. '../..').  A file converted before is converted
    from the main file it came from (with the edits made since); converting it
    back to that file's class gives that file again, exactly."""
    warnings = []
    head, origin, _, _ = split_origin(main_text)
    source = main_text
    if origin is not None:
        root = restore(main_text)
        if root is None:
            warnings.append('Edits to the converted front matter or preamble cannot be carried back to the '
                            'original; converted from this file instead.')
            source = head
        else:
            source = root
            if class_of_target(target) == doc_class(strip_comments(root)) and not anonymous:
                return root, warnings + ['Restored the original main file, with the edits made since' +
                                         (': its bibliography paths are relative to the original folder.' if rel and rel != '.' else '.')]
    md = dict(md, source_class=doc_class(strip_comments(source)))
    out, more = _convert(source, md, target, anonymous, theorems_used, resolve, all_text)
    out = relocate_bibliography(out, rel)
    if not out.endswith('\n'):
        out += '\n'
    return out + ''.join(origin_record(source, out)), warnings + more
