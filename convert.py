"""Metadata of a paper and conversion between venue classes.

The converted paper is a new main file next to the old one: the target
class's front matter written from the metadata, the old preamble with what
the target cannot take removed or shimmed, and the old body (its \\input
files unchanged).  See docs/styles.md for the differences handled here.
"""
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
        m = re.search(r'\\author\s*\{', t)
        if m:
            body = group(t, m.end() - 1)[0]
            names = [name_of(group(body, x.end() - 1)[0]) for x in re.finditer(r'\\IEEEauthorblockN\s*\{', body)]
            addrs = [group(body, x.end() - 1)[0] for x in re.finditer(r'\\IEEEauthorblockA\s*\{', body)]
            for i, n in enumerate(names):
                if n.lower().startswith('anonymous'):
                    continue
                a = addrs[i] if i < len(addrs) else ''
                email = re.search(r'[\w.+-]+@[\w.-]+', a)
                lines = [clean(x) for x in re.split(r'\\\\', a) if clean(x) and '@' not in x]
                md['authors'].append({'name': n, 'email': email.group(0) if email else '', 'orcid': '',
                                      'affiliations': [aff(', '.join(lines))] if lines else []})
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
            a, _ = args_after(t, m.end() - 1, 5)
            if len(a) >= 2:
                orcid = re.search(r'\d{4}-\d{4}-\d{4}-\d{3}[\dX]', a[3] if len(a) > 3 else '')
                md['authors'].append({'name': name_of(a[0]), 'email': a[2] if len(a) > 2 else '',
                                      'orcid': orcid.group(0) if orcid else '', 'affiliations': [aff(a[1])]})
        m = re.search(r'\\Copyright\s*\{([^}]*)\}', t)
        md['license'] = 'CC-BY-4.0' if m else ''
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
    m = re.search(r'\\keywords\s*\{', t)
    if m:
        kw = group(t, m.end() - 1)[0]
        md['keywords'] = [clean(k) for k in re.split(r'\\and\b|,', kw) if clean(k)]
    m = re.search(r'\\begin\{IEEEkeywords\}(.*?)\\end\{IEEEkeywords\}', t, re.S)
    if m:
        md['keywords'] = [clean(k) for k in m.group(1).split(',') if clean(k)]
    m = re.search(r'\\begin\{(abstract|textabstract)\}(.*?)\\end\{\1\}', t, re.S)
    if m:
        md['abstract'] = re.sub(r'\\keywords\s*\{[^}]*\}', '', m.group(2)).strip()
    m = re.search(r'\\begin\{(acks|acknowledgements?)\}(.*?)\\end\{\1\}', t, re.S) or \
        re.search(r'\\section\*\{Acknowledge?ments?[^}]*\}(.*?)(?=\\section|\\bibliography|\\printbibliography|\\appendix|\\end\{document\})', t, re.S)
    if m:
        md['acknowledgements'] = m.group(m.lastindex).strip()
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
        pre.append(f"\\license{{{md.get('license') or 'CC-by'}}}")
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


def convert(main_text, md, target, anonymous, theorems_used):
    """The new main file, and warnings."""
    warnings = []
    _, cls_line, cls_anon, bibstyle = TARGETS[target]
    t = main_text
    begin = t.index('\\begin{document}')
    preamble = t[:begin]
    body = t[begin + len('\\begin{document}'):]
    # preamble: drop the class line and the old front matter
    preamble = re.sub(r'^[^%\n]*\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]*\}[^\n]*\n?', '', preamble, count=1, flags=re.M)
    preamble = remove_cmds(preamble, FRONT_CMDS)
    shims = []
    if target in NO_CLEVEREF:
        if re.search(r'\\usepackage(\[[^\]]*\])?\{[^}]*cleveref', preamble):
            preamble = re.sub(r'\\usepackage(\[[^\]]*\])?\{cleveref\}\n?', '', preamble)
            preamble = re.sub(r'\\(crefname|Crefname|creflabelformat)\{[^}]*\}(\{[^}]*\}){0,2}\n?', '', preamble)
        shims.append('% cleveref does not load with this class: \\cref falls back to hyperref\'s \\autoref')
        shims.append('\\providecommand{\\cref}[1]{\\autoref{#1}}\n\\providecommand{\\Cref}[1]{\\autoref{#1}}')
        warnings.append('\\cref and \\Cref become \\autoref (one label each): check references to several labels.')
    if target in PREDEFINED_THEOREMS:
        pre_defd = PREDEFINED_THEOREMS[target]
        for env in sorted(pre_defd):
            preamble = re.sub(r'\\(?:sp)?newtheorem\*?\{' + env + r'\}(\[[^\]]*\])?\{[^}]*\}(\[[^\]]*\])?\n?', '', preamble)
        if target != 'llncs':
            preamble = re.sub(r'\\usepackage(\[[^\]]*\])?\{amsthm\}\n?', '', preamble)
    if target == 'ieee':
        defined = set(re.findall(r'\\newtheorem\*?\{([^}]*)\}', preamble))
        need = [e for e in theorems_used if e not in defined and e != 'proof']
        if need:
            shims.append('\\usepackage{amsthm}')
            first = need[0]
            for e in need:
                shared = '' if e == first else f'[{first}]'
                shims.append(f'\\newtheorem{{{e}}}{shared}{{{e.capitalize()}}}')
    if target == 'llncs':
        defined = set(re.findall(r'\\(?:sp)?newtheorem\*?\{([^}]*)\}', preamble))
        for e in theorems_used:
            if e not in PREDEFINED_THEOREMS['llncs'] and e not in defined:
                shims.append(f'\\spnewtheorem{{{e}}}{{{e.capitalize()}}}{{\\bfseries}}{{\\itshape}}')
    shims.append('\\providecommand{\\appendices}{\\appendix}')
    # body: old front matter out, new in
    body = remove_cmds(body, FRONT_CMDS + ['maketitle'])
    body = re.sub(r'\\begin\{(abstract|textabstract)\}.*?\\end\{\1\}\s*', '', body, count=1, flags=re.S)
    body = re.sub(r'\\begin\{IEEEkeywords\}.*?\\end\{IEEEkeywords\}\s*', '', body, count=1, flags=re.S)
    if anonymous:
        body, n1 = re.subn(r'\\begin\{(acks|acknowledgements?)\}.*?\\end\{\1\}\s*', '', body, flags=re.S)
        body, n2 = re.subn(r'\\section\*\{Acknowledge?ments?[^}]*\}.*?(?=\\section|\\bibliography|\\printbibliography|\\appendix|\\end\{document\})',
                           '', body, flags=re.S | re.I)
        if n1 + n2:
            warnings.append('Acknowledgements removed for the anonymous version.')
        warnings.append('Anonymous: check the text itself for self-citations in the first person, links to your repositories, and funding notes in other files.')
    if bibstyle:
        body = re.sub(r'\\bibliographystyle\{[^}]*\}', r'\\bibliographystyle{' + bibstyle + '}', body)
        if '\\bibliography{' in body and '\\bibliographystyle' not in body:
            body = body.replace('\\bibliography{', '\\bibliographystyle{' + bibstyle + '}\n\\bibliography{', 1)
    if target == 'acmart' and '\\bibliographystyle' not in body and '\\printbibliography' not in body:
        warnings.append('acmart expects \\bibliographystyle{ACM-Reference-Format}.')
    if target == 'ieee':
        body = body.replace('\\appendix\n', '\\appendices\n')
    pre_fm, post_fm = front_matter(md, target, anonymous)
    out = (('% Converted by paper-editor from ' + md.get('source_class', '?') + ' (anonymous)\n' if anonymous else
            '% Converted by paper-editor from ' + md.get('source_class', '?') + '\n') +
           (cls_anon if anonymous else cls_line) + '\n' + preamble.strip('\n') + '\n' +
           '\n'.join(shims) + '\n' + pre_fm + '\n\\begin{document}\n' + post_fm + '\n' + body.lstrip('\n'))
    return out, warnings
