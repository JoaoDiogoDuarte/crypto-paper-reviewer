#!/usr/bin/env python3
"""Test the editor on the synthetic papers in tests/fixtures/.

    tests/fixtures.py [NAME ...] [--rounds N]

For each fixture, on a throwaway copy (with the class and style files of
tests/classes/ beside it):
  1. build it with latexmk, and check that no citation or reference is
     undefined (so the bibliography setup of each class works);
  2. round trip: every .tex parses and re-serializes byte for byte;
  3. the in-page self-test (headless Firefox): every block re-serializes
     from the page exactly, every formula renders;
  4. fuzz: N random edits through the page, each checked for locality,
     fidelity and round trip; then a real save, and a check that the files
     on disk are what the page says it wrote, and that every file the
     fuzzing did not edit is byte for byte the original (line endings and
     byte-order marks included).
"""
import argparse
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import selftest  # noqa: E402

FIX = os.path.join(HERE, 'fixtures')
CLASSES = os.path.join(HERE, 'classes')
STYLE_EXT = ('.cls', '.bst', '.sty', '.bbx', '.cbx', '.clo', '.dbx', '.lbx')


def main_of(root):
    for cand in ('main.tex', 'paper/main.tex'):
        if os.path.exists(os.path.join(root, cand)):
            return os.path.join(root, cand)
    return None


def needed_class_missing(main):
    m = None
    with open(main, encoding='utf-8-sig', errors='replace') as f:
        import re
        m = re.search(r'\\documentclass(?:\[[^\]]*\])?\{([^}]*)\}', f.read())
    if not m:
        return None
    cls = m.group(1) + '.cls'
    have = subprocess.run(['kpsewhich', cls], capture_output=True).returncode == 0
    return None if have or os.path.exists(os.path.join(CLASSES, cls)) else cls


def tex_files(root):
    return sorted(glob.glob(os.path.join(root, '**', '*.tex'), recursive=True))


def sha1(path):
    with open(path, 'rb') as f:
        return hashlib.sha1(f.read()).hexdigest()


def check(name, rounds):
    out = []
    if os.path.isfile(name):
        # a real paper: copy its whole repository, keep the main file's place in it
        mainpath = os.path.abspath(name)
        r = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=os.path.dirname(mainpath),
                           capture_output=True, text=True)
        src = r.stdout.strip() if r.returncode == 0 else os.path.dirname(mainpath)
        rel_main = os.path.relpath(mainpath, src)
        label = os.path.basename(src)
        external = True
    else:
        src, rel_main, label, external = os.path.join(FIX, name), None, name, False
    tmp = tempfile.mkdtemp(prefix=f'pe-fix-{label}-')
    try:
        work = os.path.join(tmp, label)
        shutil.copytree(src, work, ignore=shutil.ignore_patterns('.git'))
        main = os.path.join(work, rel_main) if rel_main else main_of(work)
        missing = needed_class_missing(main)
        if missing:
            return 'SKIP', [f'{missing} not installed; put it in tests/classes/']
        for f in os.listdir(CLASSES) if os.path.isdir(CLASSES) else []:
            if f.endswith(STYLE_EXT):
                shutil.copy(os.path.join(CLASSES, f), os.path.dirname(main))
        # 1. build
        r = subprocess.run(['latexmk', '-pdf', '-synctex=1', '-interaction=nonstopmode', '-halt-on-error',
                            os.path.basename(main)], cwd=os.path.dirname(main), capture_output=True, text=True,
                           timeout=300)
        log = open(main[:-4] + '.log', errors='replace').read() if os.path.exists(main[:-4] + '.log') else ''
        undefined = [l for l in log.splitlines() if 'undefined' in l and ('Citation' in l or 'Reference' in l)]
        ok_build = r.returncode == 0 and not undefined
        out.append(f'build: {"ok" if ok_build else "FAILED"}' + (f' ({len(undefined)} undefined)' if undefined else ''))
        originals = {f: sha1(f) for f in tex_files(work)}
        # 2. round trip
        rt = subprocess.run(['node', os.path.join(HERE, 'roundtrip.js'), work], capture_output=True, text=True)
        ok_rt = rt.returncode == 0
        out.append('round trip: ' + rt.stdout.strip().splitlines()[-1])
        # 3. self-test
        rep = selftest.run(main, 'selftest')
        ok_self = rep.startswith('SELFTEST OK')
        out.append(rep.splitlines()[0] if rep else 'selftest: no report')
        errs = [l for l in rep.splitlines() if l.startswith('MATH ERROR') or l.startswith('HIDDEN')]
        out += ['  ' + e[:150] for e in errs[:5]]
        # 4. reader controls and caret sentence selection
        reader = selftest.run(main, 'readertest', key='READTEST')
        ok_reader = reader.startswith('OK')
        out.append(reader.splitlines()[0] if reader else 'reader test: no report')
        # 5. fuzz, twice with different seeds, each on a fresh copy of the sources
        ok_fuzz = True
        for seed in (1, 7):
            for f, h in originals.items():   # restore the sources between runs
                rel = os.path.relpath(f, work)
                if os.path.exists(os.path.join(src, rel)):
                    shutil.copy(os.path.join(src, rel), f)
            rep = selftest.run(main, f'fuzz={rounds}&seed={seed}', timeout=180, key='FUZZ')
            try:
                res = json.loads(rep.split('\n', 1)[0])
            except ValueError:
                ok_fuzz = False
                out.append(f'fuzz seed {seed}: no result ({rep[:120]})')
                continue
            disk_ok, untouched_ok = True, True
            base = os.path.dirname(main)
            for rel, h in res['hashes'].items():
                p = os.path.normpath(os.path.join(base, rel))
                if os.path.exists(p) and sha1(p) != h:
                    disk_ok = False
                    out.append(f'  disk differs from the page: {rel}')
            for f, h in originals.items():
                rel = os.path.relpath(f, base)
                if os.path.exists(os.path.join(src, os.path.relpath(f, work))) and sha1(f) != sha1(os.path.join(src, os.path.relpath(f, work))) and rel not in res['edited']:
                    untouched_ok = False
                    out.append(f'  file not edited by the fuzzing changed: {rel}')
            good = res['nfails'] == 0 and disk_ok and untouched_ok
            ok_fuzz &= good
            out.append(f'fuzz seed {seed}: {res["rounds"]} edits, {res["nfails"]} failures, '
                       f'{len(res["edited"])} files saved, disk {"=" if disk_ok else "≠"} page, '
                       f'untouched files {"identical" if untouched_ok else "CHANGED"}')
            out += ['  ' + f[:160] for f in res['fails'][:6]]
        # a third-party paper may need tools we lack: its build is reported, not required
        status = 'OK' if ((ok_build or external) and ok_rt and ok_self and ok_reader and ok_fuzz) else 'FAIL'
        return status, out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('names', nargs='*', help='fixture names, or paths to main .tex files of real papers')
    ap.add_argument('--rounds', type=int, default=150)
    args = ap.parse_args()
    names = args.names or sorted(d for d in os.listdir(FIX) if os.path.isdir(os.path.join(FIX, d)))
    bad = 0
    for n in names:
        status, lines = check(n, args.rounds)
        bad += status == 'FAIL'
        print(f'{status:5}{n}')
        for l in lines:
            print('     ' + l)
    print(f'{len(names) - bad}/{len(names)} fixtures pass (SKIP counts as pass)')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
