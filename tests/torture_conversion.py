#!/usr/bin/env python3
"""Seeded metadata and venue-conversion torture tests. No TeX installation needed.

  TORTURE_CONVERSION_CASES=60 python3 -m unittest tests.torture_conversion -v
All generated papers live only in strings and the current test process.
"""
import os
import random
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
import convert  # noqa: E402
from convert_matrix import fill  # noqa: E402


SOURCE_CLASSES = ('article', 'IEEEtran', 'llncs', 'acmart',
                  'iacrcc', 'iacrtrans', 'lipics-v2021')


def paper(source_class, title, author, seed):
    """Valid front-matter idioms for seven supported source classes."""
    if source_class == 'IEEEtran':
        byline = (r'\ifanon\author{\IEEEauthorblockN{Anonymous authors}}'
                  + '\n' + r'\else\author{\IEEEauthorblockN{' + author + '}'
                  + r'\IEEEauthorblockA{\textit{University of Porto}\\Porto, Portugal}}\fi')
        keywords = r'\begin{IEEEkeywords}cryptography, games\end{IEEEkeywords}'
    elif source_class == 'acmart':
        byline = (r'\author{' + author + '}'
                  + r'\affiliation{\institution{University of Porto}'
                  + r'\city{Porto}\country{Portugal}}'
                  + r'\email{paper@example.org}')
        keywords = r'\keywords{cryptography, games}'
    elif source_class == 'iacrcc':
        byline = (r'\license{CC-by}'
                  + r'\addauthor[inst={1},email={paper@example.org}]{' + author + '}'
                  + r'\addaffiliation[country={Portugal}]{University of Porto}')
        keywords = r'\keywords{cryptography, games}'
    elif source_class == 'lipics-v2021':
        byline = r'\author{' + author + r'}{University of Porto}{paper@example.org}{}{}'
        keywords = r'\keywords{cryptography, games}'
    elif source_class in ('llncs', 'iacrtrans'):
        byline = (r'\author{' + author + r'\inst{1}}'
                  + r'\institute{University of Porto \email{paper@example.org}}')
        keywords = r'\keywords{cryptography, games}'
    else:
        byline = r'\author{' + author + '}'
        keywords = r'\keywords{cryptography, games}'
    # The suffix identifies body content independently of any front-matter rewrite.
    marker = 'KEEP-BODY-' + str(seed)
    return ('\\documentclass{' + source_class + '}\n'
            + '\\title{' + title + '}\n'
            + r'\shorttitle{Short ' + str(seed) + '}\n'
            + byline + '\n'
            + '\\begin{document}\n'
            + '\\begin{abstract}Abstract seed ' + str(seed) + '.\\end{abstract}\n'
            + keywords + '\n'
            + '\\section{Results}\n'
            + marker + ' Theorem references $q^2/N$ and '
            + r'\cite{source:key} remain unchanged.' + '\n'
            + r'\begin{acks}Grant seed ' + str(seed) + r'.\end{acks}' + '\n'
            + '\\end{document}\n')


class MetadataTortureTest(unittest.TestCase):
    def test_metadata_autodetection_random_sources(self):
        n = int(os.environ.get('TORTURE_CONVERSION_CASES', '14'))
        self.assertGreater(n, 0)
        randomizer = random.Random(91827)
        names = ('João Diogo Duarte', 'Alice Nascimento', 'Émile Test',
                 'Bob-the-Reviewer', 'César Pinto')
        for i in range(n):
            title = 'Article title ' + str(i) + ' - ' + str(randomizer.randrange(100000))
            author = randomizer.choice(names)
            for cls in SOURCE_CLASSES:
                with self.subTest(seed=i, source=cls):
                    source = paper(cls, title, author, i)
                    data = convert.extract(source)
                    self.assertEqual(data['source_class'], cls)
                    self.assertEqual(data['title'], title)
                    self.assertEqual(data['running_title'], 'Short ' + str(i))
                    self.assertEqual(data['keywords'], ['cryptography', 'games'])
                    self.assertEqual(data['abstract'], 'Abstract seed ' + str(i) + '.')
                    self.assertEqual(data['acknowledgements'], 'Grant seed ' + str(i) + '.')
                    self.assertEqual([a['name'] for a in data['authors']], [author])
                    if cls != 'article':
                        self.assertEqual(len(data['affiliations']), 1)
                    if cls == 'IEEEtran':
                        self.assertEqual(data['affiliations'][0]['city'], 'Porto')
                        self.assertEqual(data['affiliations'][0]['country'], 'Portugal')

    def test_conversion_randomized_all_source_and_target_pairs(self):
        n = int(os.environ.get('TORTURE_CONVERSION_CASES', '14'))
        randomizer = random.Random(14478)
        for i in range(n):
            cls = randomizer.choice(SOURCE_CLASSES)
            author = 'João Case ' + str(i)
            source = paper(cls, 'Source title ' + str(i), author, i)
            original = source
            for target, (_, normal, anonymous, _) in convert.TARGETS.items():
                for anon in (False, True):
                    with self.subTest(seed=i, source=cls, target=target, anonymous=anon):
                        metadata = fill(convert.extract(source), target)
                        result, warnings = convert.convert(
                            source, metadata, target, anon, [], None, '')
                        self.assertEqual(source, original, 'conversion mutated the input')
                        self.assertIsInstance(warnings, list)
                        self.assertIn(anonymous if anon else normal, result)
                        self.assertEqual(result.count(r'\documentclass'), 1)
                        self.assertEqual(result.count(r'\begin{document}'), 1)
                        self.assertEqual(result.count(r'\end{document}'), 1)
                        self.assertEqual(result.count('KEEP-BODY-' + str(i)), 1)
                        self.assertIn(r'\cite{source:key}', result)
                        self.assertEqual(result.count('Abstract seed ' + str(i)), 1)
                        self.assertIn('Source title ' + str(i), result)

    def test_predefined_theorem_counters_removed_only_when_target_owns_them(self):
        source = (r'\documentclass{article}' + '\n'
                  + r'\newaliascnt{lemma}{theorem}' + '\n'
                  + r'\newtheorem{lemma}[lemma]{Lemma}' + '\n'
                  + r'\aliascntresetthe{lemma}' + '\n'
                  + r'\newtheorem{custom}{Custom}' + '\n'
                  + r'\begin{document}\begin{lemma}One.\end{lemma}'
                  + r'\begin{custom}Two.\end{custom}\end{document}')
        for target in convert.TARGETS:
            with self.subTest(target=target):
                md = fill(convert.extract(source), target)
                output, _ = convert.convert(source, md, target, False,
                                            ['lemma', 'custom'], None, '')
                if 'lemma' in convert.PREDEFINED_THEOREMS.get(target, ()):
                    self.assertNotIn(r'\newaliascnt{lemma}', output)
                    self.assertNotIn(r'\newtheorem{lemma}', output)
                    self.assertNotIn(r'\aliascntresetthe{lemma}', output)
                self.assertIn(r'\begin{lemma}', output)
                self.assertIn(r'\begin{custom}', output)
                self.assertEqual(output.count(r'\begin{document}'), 1)


if __name__ == '__main__':
    unittest.main()
