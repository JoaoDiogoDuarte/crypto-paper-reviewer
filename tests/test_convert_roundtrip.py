#!/usr/bin/env python3
"""Conversions between venue classes give the original back, byte for byte.

    python -m unittest tests.test_convert_roundtrip          # fast: convert.py only
    ROUNDTRIP_BUILD=1 python -m unittest tests.test_convert_roundtrip   # also real latexmk builds

For every fixture paper S and every pair of targets A, B: S -> A -> S and
S -> A -> B -> S must give S's main file exactly; an edit made to the body
of a converted file is carried back; and converting a converted file again
(llncs -> acmart, llncs -> article: the paper's own bugs) writes next to the
original, finds its \\input files and builds.
"""
import itertools
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
import convert  # noqa: E402
from convert_matrix import fill  # noqa: E402

FIX = os.path.join(HERE, 'fixtures')
SOURCES = sorted(d for d in os.listdir(FIX) if os.path.isdir(os.path.join(FIX, d)))
TARGETS = list(convert.TARGETS)
THEOREMS = ['theorem', 'lemma', 'definition', 'corollary']


def main_path(source):
    root = os.path.join(FIX, source)
    for name in ('main.tex', os.path.join('paper', 'main.tex')):
        if os.path.exists(os.path.join(root, name)):
            return os.path.join(root, name)
    return None


def read(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def step(text, target):
    # as the server does: metadata from the original main file
    md = fill(convert.extract(convert.restore(text) or text), target)
    out, warnings = convert.convert(text, md, target, False, THEOREMS, None, '')
    return out, warnings


def source_target(text):
    cls = convert.doc_class(convert.strip_comments(text))
    return next((t for t in TARGETS if convert.class_of_target(t) == cls), None)


class RoundTripTest(unittest.TestCase):
    def sources(self):
        for s in SOURCES:
            p = main_path(s)
            if p and '\\begin{document}' in read(p):
                yield s, read(p)

    def test_there_and_back(self):
        """S -> A -> S, for every fixture and target."""
        for name, text in self.sources():
            home = source_target(text)
            if not home:
                continue
            for a in TARGETS:
                if convert.class_of_target(a) == convert.class_of_target(home):
                    continue
                with self.subTest(source=name, via=a):
                    there, _ = step(text, a)
                    back, warnings = step(there, home)
                    self.assertEqual(back, text, f'{name} -> {a} -> {home} differs; warnings {warnings}')

    def test_chains_of_three(self):
        """S -> A -> B -> S, for every fixture and pair of targets."""
        for name, text in self.sources():
            home = source_target(text)
            if not home:
                continue
            others = [t for t in TARGETS if convert.class_of_target(t) != convert.class_of_target(home)]
            for a, b in itertools.permutations(others, 2):
                with self.subTest(source=name, chain=(a, b)):
                    x, _ = step(text, a)
                    y, _ = step(x, b)
                    back, warnings = step(y, home)
                    self.assertEqual(back, text, f'{name} -> {a} -> {b} -> {home} differs; warnings {warnings}')

    def test_chain_converts_from_the_original(self):
        """A -> B is S -> B: no shims of A pile up in B."""
        for name, text in self.sources():
            home = source_target(text)
            if not home:
                continue
            for a, b in [('llncs', 'acmart'), ('llncs', 'article'), ('iacrcc', 'lipics')]:
                if home in (a, b):
                    continue
                with self.subTest(source=name, chain=(a, b)):
                    direct, _ = step(text, b)
                    x, _ = step(text, a)
                    via, _ = step(x, b)
                    self.assertEqual(convert.split_origin(via)[0], convert.split_origin(direct)[0])

    def test_body_edits_come_back(self):
        """An edit in the converted body survives the way back (and a chain)."""
        for name, text in self.sources():
            home = source_target(text)
            if not home or '\\end{document}' not in text:
                continue
            for chain in (['llncs'], ['acmart', 'article']):
                if home in chain:
                    continue
                with self.subTest(source=name, chain=chain):
                    cur, _ = step(text, chain[0])
                    line = 'A sentence typed in the converted version.\n'
                    cur = cur.replace('\\end{document}', line + '\\end{document}', 1)
                    for t in chain[1:]:
                        cur, _ = step(cur, t)
                    back, warnings = step(cur, home)
                    want = text.replace('\\end{document}', line + '\\end{document}', 1)
                    self.assertEqual(back, want, f'{name} via {chain}: {warnings}')

    def test_front_matter_edit_falls_back_with_a_warning(self):
        name, text = next((n, t) for n, t in self.sources() if source_target(t) == 'ieee')
        there, _ = step(text, 'llncs')
        there = there.replace('\\documentclass[runningheads]{llncs}', '\\documentclass[runningheads,a4paper]{llncs}', 1)
        back, warnings = step(there, 'ieee')
        self.assertNotEqual(back, text)
        self.assertTrue(any('cannot be carried back' in w for w in warnings), warnings)

    def test_record_is_tamper_evident(self):
        name, text = next((n, t) for n, t in self.sources() if source_target(t) == 'ieee')
        there, _ = step(text, 'llncs')
        broken = there.replace('%|\\begin{document}', '%|\\begin{document} ', 1)
        self.assertIsNone(convert.split_origin(broken)[1])

    def test_line_ends_and_no_final_newline_survive(self):
        name, text = next((n, t) for n, t in self.sources() if source_target(t) == 'ieee')
        for variant in (text.replace('\n', '\r\n'), text.rstrip('\n'), text + '\n\n% trailing comment'):
            with self.subTest(variant=repr(variant[-20:])):
                there, _ = step(variant, 'iacrtrans')
                back, _ = step(there, 'ieee')
                self.assertEqual(back, variant)


class PaperBugsTest(unittest.TestCase):
    """What broke converting a real paper (IEEEtran, \input{preamble}, cryptobib/)."""
    SRC = r"""\documentclass[conference]{IEEEtran}
\usepackage{amsmath}
\usepackage{inconsolata}
\usepackage{hyperref}
\pdfstringdefDisableCommands{\def\\{ }}
\usepackage[nameinlink,capitalize,noabbrev]{cleveref}
\begin{document}
\title{T}
\maketitle
\begin{figure}\caption{See \cref{x}.}\label{y}\end{figure}
\bibliographystyle{IEEEtran}
\bibliography{cryptobib/abbrev0,cryptobib/crypto,references}
\end{document}
"""

    def conv(self, target, rel=None):
        md = fill(convert.extract(self.SRC), target)
        out, warnings = convert.convert(self.SRC, md, target, False, [], None, '', rel=rel)
        return convert.split_origin(out)[0], warnings

    def test_bibliography_relative_to_the_new_folder(self):
        out, _ = self.conv('llncs', rel='../..')
        self.assertIn(r'\bibliography{../../cryptobib/abbrev0,../../cryptobib/crypto,../../references}', out)

    def test_back_home_is_still_exact_with_rel(self):
        out, _ = self.conv('llncs', rel='../..')
        full = out + ''.join(convert.origin_record(self.SRC, out))
        back, _ = convert.convert(full, fill(convert.extract(self.SRC), 'ieee'), 'ieee', False, [], None, '', rel='../..')
        self.assertEqual(back, self.SRC)

    def test_acmart_drops_font_packages(self):
        out, warnings = self.conv('acmart')
        self.assertNotIn('inconsolata', out)
        self.assertTrue(any('inconsolata' in w for w in warnings))

    def test_lipics_passes_cleveref_options(self):
        out, _ = self.conv('lipics')
        self.assertLess(out.index(r'\PassOptionsToPackage{nameinlink,capitalize,noabbrev}{cleveref}'), out.index(r'\documentclass'))
        self.assertNotIn(r'\usepackage[nameinlink', out)

    def test_late_hyperref_commands_wait(self):
        for t in ('iacrcc', 'iacrtrans'):
            out, _ = self.conv(t)
            self.assertIn(r'\AtBeginDocument{\pdfstringdefDisableCommands{\def\\{ }}}', out)
            self.assertIn(r'\DeclareRobustCommand{\cref}', out)


@unittest.skipUnless(os.environ.get('ROUNDTRIP_BUILD') and shutil.which('latexmk'), 'set ROUNDTRIP_BUILD=1 (needs latexmk)')
class ServerChainTest(unittest.TestCase):
    """Through the server, as the Paper window does: open the converted file,
    convert it again; the result goes next to the original and builds."""

    def setUp(self):
        import server
        self.server = server
        self.tmp = tempfile.mkdtemp(prefix='pe-roundtrip-')
        self.paper = os.path.join(self.tmp, 'paper')
        shutil.copytree(os.path.join(FIX, 'ieee-conf'), self.paper)
        subprocess.run(['git', 'init', '-q', self.paper], check=True)
        server.open_paper(os.path.join(self.paper, 'main.tex'), state=os.path.join(self.tmp, 'state'))
        server.ensure_state()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def open_converted(self, rel):
        s = self.server
        s.open_paper(os.path.join(s.PAPER, rel), cwd=s.PAPER, state=s.STATE)

    def test_llncs_then_article_and_acmart(self):
        s = self.server
        first = s.run_convert('llncs', False, 'main-llncs.tex', True)
        self.assertTrue(first['built'], first['errors'])
        self.open_converted(first['file'])
        for target in ('article', 'acmart'):
            with self.subTest(target=target):
                res = s.run_convert(target, False, f'main-{target}.tex', True)
                self.assertEqual(res['file'], os.path.join('converted', target, f'main-{target}.tex'))
                self.assertTrue(res['built'], res['errors'])
        back = s.run_convert('ieee', False, 'main-ieee.tex', True)
        self.assertEqual(read(os.path.join(s.PAPER, back['file'])), read(os.path.join(self.paper, 'main.tex')))

    def test_converted_main_rebuilds_in_place(self):
        """Editing the converted file: its build finds the original's \\input files
        and writes its .aux beside it (where the editor reads numbers)."""
        s = self.server
        first = s.run_convert('llncs', False, 'main-llncs.tex', True)
        self.open_converted(first['file'])
        cmd = s.Builder.build_command(None)
        r = subprocess.run(cmd, cwd=s.PAPER, env=s.build_env(), capture_output=True, text=True, timeout=600)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:])
        self.assertTrue(os.path.exists(os.path.join(s.PAPER, 'converted', 'llncs', 'main-llncs.aux')))
        self.assertFalse(os.path.exists(os.path.join(s.PAPER, 'main-llncs.aux')))


if __name__ == '__main__':
    unittest.main()
