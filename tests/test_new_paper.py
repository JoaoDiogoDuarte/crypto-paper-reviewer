"""New papers: the main file of every venue, anonymous and named, with full
and with empty metadata, builds with latexmk; the editor reads its metadata
as the named version.  Run: python3 -m unittest tests.test_new_paper"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import convert  # noqa: E402

FULL = {'title': 'A Test Paper', 'abstract': 'We test.', 'keywords': ['a', 'b'], 'license': 'CC-by',
        'authors': [{'name': 'Ada Lovelace', 'email': 'ada@x.org', 'affiliation': 'University of Porto',
                     'country': 'Portugal', 'city': 'Porto'},
                    {'name': 'Bob Babbage', 'affiliation': 'INESC TEC', 'country': 'Portugal'}]}


class NewPaper(unittest.TestCase):
    def test_metadata_read_as_named(self):
        for t in convert.TARGETS:
            md = convert.extract(convert.new_main(FULL, t, True))
            self.assertEqual(md['title'], 'A Test Paper', t)
            self.assertTrue(any('Ada Lovelace' in a['name'] for a in md['authors']), t)
            self.assertIn('\\ifanon\\else\n', convert.new_main(FULL, t, True), t)

    @unittest.skipUnless(shutil.which('latexmk'), 'needs latexmk')
    def test_every_venue_builds(self):
        env = dict(os.environ)
        env['TEXINPUTS'] = env['BSTINPUTS'] = os.path.join(ROOT, 'classes') + '//:'
        with tempfile.TemporaryDirectory() as tmp:
            for t in convert.TARGETS:
                for label, md in (('full', FULL), ('empty', {})):
                    for anon in (True, False):
                        with self.subTest(venue=t, metadata=label, anonymous=anon):
                            d = os.path.join(tmp, f'{t}-{label}-{anon}')
                            os.makedirs(os.path.join(d, 'sections'))
                            with open(os.path.join(d, 'main.tex'), 'w') as f:
                                f.write(convert.new_main(md, t, anon))
                            for n, text in convert.NEW_SECTIONS.items():
                                extra = 'See~\\cref{sec:intro} and~\\cite{k}.\n\\begin{lemma}x\\end{lemma}\n' if 'intro' in n else ''
                                with open(os.path.join(d, n), 'w') as f:
                                    f.write(text + extra)
                            with open(os.path.join(d, 'references.bib'), 'w') as f:
                                f.write('@misc{k, author={A B}, title={T}, year={2020}}\n')
                            r = subprocess.run(['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
                                               cwd=d, env=env, capture_output=True, text=True, errors='replace', timeout=300)
                            log = open(os.path.join(d, 'main.log'), errors='replace').read() if os.path.exists(os.path.join(d, 'main.log')) else r.stdout
                            self.assertEqual(r.returncode, 0, '\n'.join(l for l in log.split('\n') if l.startswith('!'))[:500])


if __name__ == '__main__':
    unittest.main()
