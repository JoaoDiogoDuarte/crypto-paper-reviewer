#!/usr/bin/env python3
"""Fast conversion contracts for every fixture/source and target class."""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
import convert  # noqa: E402
from convert_matrix import fill  # noqa: E402

SOURCES = ('acm-ccs', 'adversarial-article', 'adversarial-bibliography', 'adversarial-comments',
           'adversarial-layout', 'adversarial-structure', 'iacrcc-cic', 'iacrtrans-tosc',
           'ieee-conf', 'lipics-itp', 'llncs-splncs04')
THEM = r'theorem|lemma|corollary|proposition|definition|claim|assumption|remark|example|conjecture|thm|fact'


def main_path(source):
    root = os.path.join(HERE, 'fixtures', source)
    return next(os.path.join(root, name) for name in ('main.tex', os.path.join('paper', 'main.tex'))
                if os.path.exists(os.path.join(root, name)))


class ConversionContractTest(unittest.TestCase):
    def test_all_sources_and_targets(self):
        for source in SOURCES:
            main = main_path(source)
            directory = os.path.dirname(main)
            with open(main, encoding='utf-8-sig') as f:
                original = f.read()
            everything = ''
            used = set()
            for root, _, files in os.walk(directory):
                for name in files:
                    if not name.endswith('.tex'):
                        continue
                    with open(os.path.join(root, name), encoding='utf-8', errors='replace') as f:
                        text = f.read()
                    if os.path.join(root, name) != main:
                        everything += text
                    used.update(re.findall(r'\\begin\{(' + THEM + r')\}', text))

            def resolve(name):
                for candidate in (name, name + '.tex'):
                    path = os.path.join(directory, candidate)
                    if os.path.isfile(path):
                        with open(path, encoding='utf-8', errors='replace') as f:
                            return f.read()
                return None

            for target, (_, normal, anonymous, _) in convert.TARGETS.items():
                for anon in (False, True):
                    with self.subTest(source=source, target=target, anonymous=anon):
                        metadata = fill(convert.extract(original), target)
                        output, _ = convert.convert(original, metadata, target, anon, sorted(used), resolve, everything)
                        expected = anonymous if anon else normal
                        self.assertIn(expected, output)
                        self.assertEqual(output.count('\\documentclass'), 1)
                        self.assertIn('\\begin{document}', output)
                        self.assertIn('\\end{document}', output)


if __name__ == '__main__':
    unittest.main()
