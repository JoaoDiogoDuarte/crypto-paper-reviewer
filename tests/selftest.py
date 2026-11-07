#!/usr/bin/env python3
"""Run the editor's in-page self-test on real papers, in headless Firefox.

    tests/selftest.py PAPER [PAPER ...]          # project folders or main files
    tests/selftest.py                            # the papers listed in tests/papers.local

For each paper: start the editor on a free port, load ?selftest, wait for the
page to post its report, stop the editor.  The page re-serializes every block
from the DOM and compares it with the source (nothing is saved), checks that
every formula renders, and reports references that do not resolve.

tests/papers.local is not tracked: keep the paths of your own papers there.
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = os.path.join(ROOT, '.venv', 'bin', 'python')
if not os.path.exists(PY):
    PY = sys.executable


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def run(paper, mode='selftest', timeout=60, key=None):
    port = free_port()
    log = tempfile.NamedTemporaryFile('w+', suffix='.log', delete=False)
    state = tempfile.mkdtemp(prefix='pe-state-')   # never write into the paper's folder
    srv = subprocess.Popen([PY, os.path.join(ROOT, 'server.py'), paper, '--port', str(port), '--no-open',
                            '--state', state],
                           stdout=log, stderr=subprocess.STDOUT)
    profile = tempfile.mkdtemp(prefix='pe-ff-')
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state', timeout=2)
                break
            except OSError:
                if srv.poll() is not None:
                    break
                time.sleep(0.3)
        else:
            return 'server did not start'
        if srv.poll() is not None:
            log.seek(0)
            return 'server failed: ' + log.read()[-400:]
        ff = subprocess.Popen(['firefox', '--headless', '--no-remote', '--profile', profile,
                               f'http://127.0.0.1:{port}/?{mode}'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + timeout
        report = None
        while time.time() < deadline:
            log.seek(0)
            text = log.read()
            k = key or ('SELFTEST' if mode == 'selftest' else mode.upper())
            if 'page: JSERROR' in text and 'page: ' + k not in text:
                time.sleep(1)
                log.seek(0)
                report = 'JSERROR ' + log.read().split('page: JSERROR', 1)[1].split('\n')[0]
                break
            if 'page: ' + k in text:
                time.sleep(0.5)
                log.seek(0)
                report = log.read().split('page: ' + k, 1)[1]
                report = (k + report) if k == 'SELFTEST' else report.strip()
                break
            time.sleep(0.5)
        ff.kill()
        return report or 'no report from the page (timeout)'
    finally:
        srv.kill()
        srv.wait()
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(state, ignore_errors=True)
        os.unlink(log.name)


def main():
    papers = sys.argv[1:]
    if not papers:
        local = os.path.join(HERE, 'papers.local')
        if not os.path.exists(local):
            print(__doc__)
            return 2
        papers = [l.strip() for l in open(local) if l.strip() and not l.startswith('#')]
    failed = 0
    for p in papers:
        report = run(os.path.expanduser(p))
        lines = [l for l in report.splitlines() if not l.strip().startswith(('SAY', 'MARK'))]
        ok = lines and lines[0].startswith('SELFTEST OK')
        failed += not ok
        print(('OK   ' if ok else 'FAIL ') + p)
        for l in lines[:12]:
            print('     ' + l)
    print(f'{len(papers) - failed}/{len(papers)} papers pass')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
