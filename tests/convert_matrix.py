#!/usr/bin/env python3
"""Convert fixture papers into every target class and compile the results.

    tests/convert_matrix.py [SOURCE ...] [--targets ieee,llncs,...] [--anon]

Each conversion runs on a throwaway copy with tests/classes/ beside it;
missing required metadata is filled with placeholders, as the editor's form
would ask for it. Prints a table: built, undefined references, warnings.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import convert  # noqa: E402

FIX = os.path.join(HERE, 'fixtures')
CLASSES = os.path.join(HERE, 'classes')
THM = r'theorem|lemma|corollary|proposition|definition|claim|assumption|remark|example|conjecture|thm|fact'


def fill(md, target):
    """Placeholders for what the target needs."""
    for where, field in convert.missing(md, target):
        if where == 'paper' and field == 'authors':
            md['authors'] = [{'name': 'Placeholder Author', 'email': 'a@example.org', 'orcid': '', 'affiliations': [0]}]
            md['affiliations'] = md['affiliations'] or [{'name': 'Placeholder University', 'city': 'Nowhere',
                                                         'country': 'Nowhere', 'ror': '', 'department': ''}]
    for a in md['authors']:
        a['email'] = a.get('email') or 'a@example.org'
        if not a.get('affiliations'):
            if not md['affiliations']:
                md['affiliations'].append({'name': 'Placeholder University', 'city': '', 'country': '', 'ror': '', 'department': ''})
            a['affiliations'] = [0]
    for af in md['affiliations']:
        af['city'] = af.get('city') or 'Nowhere'
        af['country'] = af.get('country') or 'Nowhere'
    md['license'] = md.get('license') or 'CC-by'
    md['title'] = md.get('title') or 'Untitled'
    return md


def run(source, target, anon):
    tmp = tempfile.mkdtemp(prefix='pe-conv-')
    try:
        work = os.path.join(tmp, source)
        shutil.copytree(os.path.join(FIX, source), work)
        main = os.path.join(work, 'main.tex') if os.path.exists(os.path.join(work, 'main.tex')) else os.path.join(work, 'paper', 'main.tex')
        d = os.path.dirname(main)
        for f in os.listdir(CLASSES):
            if not f.startswith('.'):
                shutil.copy(os.path.join(CLASSES, f), d)
        text = open(main, encoding='utf-8-sig').read()
        md = fill(convert.extract(text), target)
        used = set()
        for root, _, files in os.walk(d):
            for f in files:
                if f.endswith('.tex'):
                    used |= set(re.findall(r'\\begin\{(' + THM + r')\}', open(os.path.join(root, f), errors='replace').read()))
        out, warns = convert.convert(text, md, target, anon, sorted(used))
        name = f'main-{target}{"-anon" if anon else ""}.tex'
        open(os.path.join(d, name), 'w').write(out)
        r = subprocess.run(['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', name], cwd=d,
                           capture_output=True, text=True, timeout=240)
        log = open(os.path.join(d, name[:-4] + '.log'), errors='replace').read() if os.path.exists(os.path.join(d, name[:-4] + '.log')) else ''
        undef = len(re.findall(r'(Citation|Reference) .* undefined', log))
        err = next((l for l in log.splitlines() if l.startswith('!')), '')
        anon_ok = None
        if anon and r.returncode == 0:
            txt = subprocess.run(['pdftotext', name[:-4] + '.pdf', '-'], cwd=d, capture_output=True, text=True).stdout
            names = [a['name'] for a in md['authors'] if a['name'] != 'Placeholder Author']
            anon_ok = not any(n and n in txt for n in names)
        return r.returncode == 0, undef, err, warns, anon_ok
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('sources', nargs='*', default=['ieee-conf', 'llncs-splncs04', 'iacrcc-cic', 'acm-ccs', 'lipics-itp'])
    ap.add_argument('--targets', default=','.join(convert.TARGETS))
    ap.add_argument('--anon', action='store_true', help='also the anonymous versions')
    args = ap.parse_args()
    bad = 0
    for src in args.sources:
        for tgt in args.targets.split(','):
            for anon in ([False, True] if args.anon else [False]):
                ok, undef, err, warns, anon_ok = run(src, tgt, anon)
                good = ok and undef == 0 and anon_ok is not False
                bad += not good
                flag = 'OK  ' if good else 'FAIL'
                extra = f' undefined={undef}' if undef else ''
                extra += ' authors-visible!' if anon_ok is False else ''
                print(f'{flag} {src:16} -> {tgt:9}{" anon" if anon else "     "}{extra} {err[:90]}')
    print(f'{bad} failing conversions')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
