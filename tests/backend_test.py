#!/usr/bin/env python3
"""Backend regression tests for save, document switching, builds and launching."""
import json
import os
import random
from concurrent.futures import ThreadPoolExecutor
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402


class FakeBuilder:
    def __init__(self):
        self.aux = {}
        self.auxver = 1
        self.state = {'state': 'idle', 'message': '', 'at': 0}
        self.logs = []
        self.requests = 0

    def log(self, message):
        self.logs.append(message)

    def request(self):
        self.requests += 1


class BackendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='paper-editor-backend-')
        self.state = os.path.join(self.tmp, '.state')
        self.main = os.path.join(self.tmp, 'main.tex')
        self.other = os.path.join(self.tmp, 'other.tex')
        with open(self.main, 'w') as f:
            f.write('\\documentclass{article}\n\\begin{document}\nMain.\\end{document}\n')
        with open(self.other, 'w') as f:
            f.write('\\documentclass{article}\n\\begin{document}\nOther.\\end{document}\n')
        server.open_paper(self.main, state=self.state)
        server.ensure_state()
        server.BUILDER = FakeBuilder()
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def post(self, path, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method='POST', headers={
            'Content-Type': 'application/json', 'X-Token': server.TOKEN})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read())
            finally:
                error.close()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.url + path) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read())
            finally:
                error.close()

    def test_included_aux_headings_keep_document_order(self):
        stem = os.path.join(server.PAPER, server.stem())
        line = lambda n, t: '\\@writefile{toc}{\\contentsline {section}{\\numberline {%s}%s}{1}{}}\n' % (n, t)
        with open(stem + '.aux', 'w') as f:
            f.write(line(1, 'Top') + '\\@input{appendix.aux}\n' + line(3, 'After'))
        with open(os.path.join(server.PAPER, 'appendix.aux'), 'w') as f:
            f.write(line(2, 'Included'))
        self.assertEqual([h['num'] for h in server.load_aux()['heads']], ['1', '2', '3'])

    def test_citation_numbers_from_natbib_and_biblatex(self):
        stem = os.path.join(server.PAPER, server.stem())
        with open(stem + '.aux', 'w') as f:
            f.write('\\bibcite{AcmA}{{1}{2023}{{Author and Writer}}{{}}}\n\\bibcite{Plain}{7}\n')
        with open(stem + '.bbl', 'w') as f:
            f.write('\\entry{Lit1}{book}{}{}\n family={Author},\n \\field{labelalpha}{Aut19}\n'
                    ' \\field{year}{2019}\n\\endentry\n')
        a = server.load_aux()
        self.assertEqual(a['cites'], {'AcmA': '1', 'Plain': '7', 'Lit1': 'Aut19'})
        self.assertEqual(a['citeinfo']['AcmA'], {'year': '2023', 'author': 'Author and Writer'})
        self.assertEqual(a['citeinfo']['Lit1'], {'year': '2019', 'author': 'Author'})
        with open(stem + '.bbl', 'w') as f:
            f.write('\\begin{thebibliography}{2}\n\\bibitem[Author and Writer(2023)]%\n{AcmA}\n'
                    '\\bibfield{author}{\\bibinfo{person}{Gina Author}}. 2023.\n\\end{thebibliography}\n')
        self.assertIn('Gina Author', server.load_bib()['AcmA'])
        self.assertNotIn('bibinfo', server.load_bib()['AcmA'])

    def test_box_warnings_are_read_from_the_log_with_their_file(self):
        long = ') (./sections/a-very-long-folder-name/and-another-one/that-makes-the-path-wrap-beyond.tex'
        wrapped = long[:79] + '\n' + long[79:]          # TeX breaks log lines at 79 columns
        log = ('This is pdfTeX\n(./main.tex\nLaTeX2e <2024-11-01>\n(/usr/share/texlive/article.cls\n'
               '(/usr/share/texlive/size10.clo)) (./sections/intro.tex\n'
               'Overfull \\hbox (28.80286pt too wide) in paragraph at lines 45--46\n'
               '[][][]\\T1/cmr/m/n/10 (see) [1] (x)\n\n'
               + wrapped + '\nUnderfull \\hbox (badness 10000) in paragraph at lines 3--5\n[]\n\n)\n'
               'Overfull \\vbox (2.0pt too high) detected at line 99\n)\n')
        got = server.parse_box_warnings(log)
        self.assertEqual([(b['kind'], b['file'], b['from'], b['to']) for b in got], [
            ('overfull', 'sections/intro.tex', 45, 46),
            ('underfull', 'sections/a-very-long-folder-name/and-another-one/that-makes-the-path-wrap-beyond.tex', 3, 5),
            ('overfull', 'main.tex', 99, 99)])
        self.assertEqual(got[0]['amount'], '28.80286pt too wide')

    def test_metadata_saves_keep_the_version_they_replace(self):
        """Losing 20 authors to a wrong click is never final: every save keeps the old version."""
        md = server.metadata()['metadata']
        md['authors'] = [{'name': f'Author {i}', 'email': '', 'orcid': '', 'affiliations': []} for i in range(20)]
        self.assertEqual(self.post('/api/metadata', md)[0], 200)
        md2 = server.metadata()['metadata']
        md2['authors'] = []                          # the wrong click
        self.assertEqual(self.post('/api/metadata', md2)[0], 200)
        self.assertEqual(self.post('/api/metadata', md2)[0], 200)   # same again: no new backup
        status, hist = self.get('/api/metadata/history')
        self.assertEqual(status, 200)
        self.assertEqual([h['authors'] for h in hist], [20, 0])     # newest first
        status, back = self.get('/api/metadata/history/' + hist[0]['name'])
        self.assertEqual(status, 200)
        self.assertEqual(len(back['metadata']['authors']), 20)
        for bad in ('../metadata.json', '..%2Fmetadata.json', 'x.json', '20260101-000000.txt'):
            self.assertEqual(self.get('/api/metadata/history/' + bad)[0], 404, bad)

    def test_torture_repeated_saves_conflicts_and_history(self):
        """HTTP saves are atomic and history chains never diverge (seed is reproducible)."""
        seed = int(os.environ.get('TORTURE_BACKEND_SEED', '91731'))
        rng = random.Random(seed)
        expected = open(self.main, encoding='utf-8').read()
        count = int(os.environ.get('TORTURE_BACKEND_OPS', '80'))
        previous_hash = server.sha(expected)
        edits = ('João', r'\~ao', r'\protect\url{https://example.org/a?b=2}',
                 r'\cite{A}', 'A & B', '日本語', ' $\u03b1$ ', '\r\n')
        before_requests = server.BUILDER.requests
        for n in range(count):
            value = rng.choice(edits) + ' seed-' + str(seed) + '-' + str(n)
            new = expected.replace('\\end{document}', value + '\\end{document}')
            status, result = self.post('/api/save', {
                'name': 'main.tex', 'base': previous_hash, 'text': new, 'batch': 'run-' + str(n)})
            self.assertEqual(status, 200, (seed, n, result))
            self.assertEqual(result['hash'], server.sha(new), (seed, n))
            with open(self.main, encoding='utf-8', newline='') as actual:
                self.assertEqual(actual.read(), new, (seed, n))
            # An out-of-date editor must never win or create a history entry.
            stale, _ = self.post('/api/save', {
                'name': 'main.tex', 'base': previous_hash, 'text': expected})
            self.assertEqual(stale, 409, (seed, n))
            expected, previous_hash = new, result['hash']
        log = [e for e in server.history_entries() if e['name'] == 'main.tex']
        self.assertEqual(len(log), count)
        for left, right in zip(log, log[1:]):
            self.assertEqual(left['after'], right['before'], seed)
        self.assertEqual(log[-1]['after'], server.sha(expected))
        self.assertEqual(server.BUILDER.requests, before_requests + count)

    def test_torture_concurrent_saves_one_winner(self):
        """Two simultaneous saves from one base cannot silently overwrite each other."""
        count = int(os.environ.get('TORTURE_CONCURRENT_ROUNDS', '12'))
        rng = random.Random(7254)
        for n in range(count):
            source = open(self.main, encoding='utf-8').read()
            options = [source.replace('\\end{document}', label + '\\end{document}')
                       for label in (f'Writer A {n}-{rng.randrange(100000)}',
                                     f'Writer B {n}-{rng.randrange(100000)}')]
            base = server.sha(source)
            def write(text):
                return self.post('/api/save', {
                    'name': 'main.tex', 'base': base, 'text': text, 'batch': f'parallel-{n}'})
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(write, options))
            self.assertEqual(sorted(r[0] for r in results), [200, 409], (n, results))
            winner = options[next(i for i, r in enumerate(results) if r[0] == 200)]
            with open(self.main, encoding='utf-8') as current:
                self.assertEqual(current.read(), winner)

    def test_torture_save_rejects_outside_files_and_keeps_source(self):
        original = open(self.main, encoding='utf-8').read()
        for path in ('../outside.tex', '../../etc/passwd', '/tmp/outside.tex',
                     'missing.tex', '.paper-editor/history/evil.tex',
                     'main.tex/../../outside.tex', 'other.txt'):
            code, _ = self.post('/api/save', {
                'name': path, 'base': server.sha(original), 'text': 'LOST'})
            self.assertIn(code, (400, 409), path)
        with open(self.main, encoding='utf-8') as current:
            self.assertEqual(current.read(), original)

    def test_torture_failed_history_write_never_writes_manuscript(self):
        original = open(self.main, encoding='utf-8').read()
        # Save is refused if the previous version cannot be backed up safely.
        with mock.patch('server.history_put', side_effect=OSError('read-only archive')):
            status, result = self.post('/api/save', {
                'name': 'main.tex', 'base': server.sha(original), 'text': 'corrupt'})
        self.assertEqual(status, 500)
        self.assertIn('nothing was written', result['error'])
        self.assertEqual(open(self.main, encoding='utf-8').read(), original)

    def test_torture_metadata_saved_overrides_and_source_autodetection(self):
        tex = (r'\documentclass[conference]{IEEEtran}' + '\n'
               + r'\title{First version}\ifanon\author{\IEEEauthorblockN{Anonymous authors}}' + '\n'
               + r'\else\author{\IEEEauthorblockN{João Diogo Duarte}'
               + r'\IEEEauthorblockA{\textit{University of Porto}\\Porto, Portugal}}\fi' + '\n'
               + r'\begin{IEEEkeywords}cryptography, proof games\end{IEEEkeywords}' + '\n'
               + r'\begin{abstract}An initial abstract.\end{abstract}' + '\n'
               + r'\begin{document}\end{document}')
        with open(self.main, 'w', encoding='utf-8') as f:
            f.write(tex)
        info = server.metadata()['metadata']
        self.assertEqual(info['authors'][0]['name'], 'João Diogo Duarte')
        self.assertEqual(info['affiliations'][0]['city'], 'Porto')
        self.assertEqual(info['keywords'], ['cryptography', 'proof games'])
        # An unmodified form must store no overrides; the source stays authoritative.
        status, _ = self.post('/api/metadata', info)
        self.assertEqual(status, 200)
        p = os.path.join(server.STATE, 'metadata.json')
        self.assertEqual(json.load(open(p, encoding='utf-8')), {})
        changed_source = tex.replace('First version', 'Second version')
        with open(self.main, 'w', encoding='utf-8') as f:
            f.write(changed_source)
        self.assertEqual(server.metadata()['metadata']['title'], 'Second version')
        override = server.metadata()['metadata']
        override['running_title'] = 'Manual short title'
        status, _ = self.post('/api/metadata', override)
        self.assertEqual(status, 200)
        saved = json.load(open(p, encoding='utf-8'))
        self.assertEqual(saved, {'running_title': 'Manual short title'})
        with open(self.main, encoding='utf-8') as f:
            self.assertEqual(f.read(), changed_source)
        newer = changed_source.replace('Second version', 'Third version')
        with open(self.main, 'w', encoding='utf-8') as f:
            f.write(newer)
        fetched = server.metadata()['metadata']
        self.assertEqual(fetched['title'], 'Third version')
        self.assertEqual(fetched['running_title'], 'Manual short title')

    def test_save_validation_conflict_and_atomic_write(self):
        with open(self.main) as f:
            original = f.read()
        base = server.sha(original)
        code, result = self.post('/api/save', b'{')
        self.assertEqual(code, 400)
        self.assertIn('JSON', result['error'])

        updated = original.replace('Main', 'Updated')
        code, result = self.post('/api/save', {'name': 'main.tex', 'base': base, 'text': updated})
        self.assertEqual(code, 200)
        with open(self.main) as f:
            self.assertEqual(f.read(), updated)
        self.assertEqual(server.BUILDER.requests, 1)

        code, result = self.post('/api/save', {'name': 'main.tex', 'base': base, 'text': original})
        self.assertEqual(code, 409)
        self.assertIn('changed', result['error'])

        code, result = self.post('/api/backup', {'name': 'main.tex', 'text': updated})
        self.assertEqual(code, 200)
        backup = os.path.join(self.tmp, result['backup'])
        self.assertTrue(os.path.exists(backup))
        with open(backup) as f:
            self.assertEqual(f.read(), updated)

    def test_save_keeps_file_mode(self):
        os.chmod(self.main, 0o644)
        with open(self.main) as f:
            original = f.read()
        code, _ = self.post('/api/save', {'name': 'main.tex', 'base': server.sha(original), 'text': original + '%\n'})
        self.assertEqual(code, 200)
        self.assertEqual(os.stat(self.main).st_mode & 0o777, 0o644)
        self.assertEqual([f for f in os.listdir(self.tmp) if f.startswith('.editor-')], [])

    def test_switch_documents_keeps_state_directory(self):
        code, _ = self.post('/api/open', {'main': 'other.tex'})
        self.assertEqual(code, 200)
        self.assertEqual(server.STATE, os.path.abspath(self.state))
        self.assertEqual(server.PAPER, os.path.abspath(self.tmp))

    def test_switch_documents(self):
        code, result = self.post('/api/open', {'main': 'other.tex'})
        self.assertEqual(code, 200)
        self.assertEqual(result['main'], 'other.tex')
        code, result = self.post('/api/open', {'main': 'missing.tex'})
        self.assertEqual(code, 400)

    @mock.patch('server.choose_directory')
    def test_pick_directory_and_open_project(self, picker):
        picker.return_value = self.tmp
        code, result = self.post('/api/pick-directory', {})
        self.assertEqual(code, 200)
        self.assertEqual(result['path'], self.tmp)
        self.assertEqual(set(result['mains']), {'main.tex', 'other.tex'})
        code, result = self.post('/api/open-project', {'path': self.tmp, 'main': 'other.tex'})
        self.assertEqual(code, 200)
        self.assertEqual(result['main'], 'other.tex')

    def test_ieee_metadata_ignores_anonymous_author_branch(self):
        tex = (r'\documentclass[conference]{IEEEtran}' + '\n' +
               r'\ifanon\author{\IEEEauthorblockN{Anonymous authors}}' + '\n' +
               r'\else\author{\IEEEauthorblockN{João Diogo Duarte}' +
               r'\IEEEauthorblockA{\textit{University of Porto}\\Porto, Portugal}}\fi' + '\n' +
               r'\begin{IEEEkeywords}crypto, proofs\end{IEEEkeywords}')
        md = server.convert.extract(tex)
        self.assertEqual([a['name'] for a in md['authors']], ['João Diogo Duarte'])
        self.assertEqual(md['affiliations'][0]['city'], 'Porto')
        self.assertEqual(md['affiliations'][0]['country'], 'Portugal')
        self.assertEqual(md['keywords'], ['crypto', 'proofs'])

    def test_history_delete_selected_and_all_keeps_paper(self):
        with open(self.main) as f:
            original = f.read()
        server.history_record('one', 'main.tex', 'version one', 'version two')
        server.history_record('two', 'main.tex', 'version two', 'version three')
        self.assertEqual(len(server.history_entries()), 2)
        code, result = self.post('/api/history/delete', {'batch': 'one'})
        self.assertEqual(code, 200)
        self.assertEqual(result['removed'], 1)
        self.assertEqual(len(result['saves']), 1)
        self.assertEqual(result['saves'][0]['batch'], 'two')
        self.assertIsNone(server.history_get(server.sha('version one')))
        self.assertEqual(server.history_get(server.sha('version two')), 'version two')
        code, result = self.post('/api/history/delete', {'all': True})
        self.assertEqual(code, 200)
        self.assertEqual(result['removed'], 1)
        self.assertFalse(server.history_entries())
        self.assertIsNone(server.history_get(server.sha('version two')))
        with open(self.main) as f:
            self.assertEqual(f.read(), original)

    def test_history_delete_rejects_invalid_requests(self):
        for request in ({}, {'all': 'yes'}, {'batch': ''}, {'all': True, 'batch': 'one'}):
            status, _ = self.post('/api/history/delete', request)
            self.assertEqual(status, 400)

    def test_makefile_is_default_build_command(self):
        with open(os.path.join(self.tmp, 'Makefile'), 'w') as f:
            f.write('all:\n\t@true\n')
        builder = server.Builder.__new__(server.Builder)
        old_config = server.CONFIG
        server.CONFIG = {}
        try:
            self.assertEqual(builder.build_command(), ['make'])
            server.CONFIG = {'build': ['custom-build']}
            self.assertEqual(builder.build_command(), ['custom-build'])
        finally:
            server.CONFIG = old_config

    def test_build_failure_is_reported(self):
        builder = server.Builder.__new__(server.Builder)
        builder.aux = {}
        builder.auxver = 1
        builder.state = {'state': 'idle', 'message': '', 'at': 0}
        builder.log = lambda message: None
        old_config = server.CONFIG
        server.CONFIG = {'build': [sys.executable, '-c', 'import sys; sys.exit(1)']}
        try:
            builder.build_once()
        finally:
            server.CONFIG = old_config
        self.assertEqual(builder.state['state'], 'error')
        self.assertIn('failed', builder.state['message'])

    def test_broken_hyperref_bookmarks_get_one_clean_retry(self):
        p = os.path.join(self.tmp, 'main.out')
        with open(p, 'w') as f:
            f.write('\\BOOKMARK{partial')
        builder = server.Builder.__new__(server.Builder)
        builder.aux = {}
        builder.auxver = 1
        builder.state = {'state': 'idle', 'message': '', 'at': 0}
        builder.log = lambda message: None
        config = server.CONFIG
        server.CONFIG = {'build': ['latexmk', '-pdf', 'main.tex']}
        failed = server.subprocess.CompletedProcess([], 12,
            stdout='! File ended while scanning use of \\@@BOOKMARK.', stderr='')
        success = server.subprocess.CompletedProcess([], 0, stdout='', stderr='')
        try:
            with mock.patch('server.subprocess.run', side_effect=[failed, success]) as run:
                builder.build_once()
        finally:
            server.CONFIG = config
        self.assertEqual(builder.state['state'], 'ok')
        self.assertEqual(run.call_count, 2)
        self.assertFalse(os.path.exists(p))
        self.assertTrue(os.listdir(os.path.join(server.CACHE, 'bad-aux')))

    def test_torture_conversion_preflight_output_isolation_and_overwrite(self):
        """A missing class must create no output; conversions go to a subdir."""
        original = server.read('main.tex')
        names = {'ieee': 'IEEEtran.cls', 'llncs': 'llncs.cls',
                 'iacrcc': 'iacrcc.cls', 'iacrtrans': 'iacrtrans.cls',
                 'acmart': 'acmart.cls', 'lipics': 'lipics-v2021.cls',
                 'article': 'article.cls'}
        # no TeX installation and none of the classes the editor bundles
        with mock.patch('server.shutil.which', return_value=None), mock.patch('server.CLASSES', self.tmp + '/no-classes'):
            for target, class_name in names.items():
                with self.subTest(target=target):
                    with self.assertRaisesRegex(ValueError, class_name.replace('.', r'\.')):
                        server.run_convert(target, False, 'output.tex', False)
                    self.assertFalse(os.path.isdir(os.path.join(self.tmp, 'converted', target)))
        calls = []
        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == 'kpsewhich':
                return server.subprocess.CompletedProcess(args, 0, stdout='/fake/latex/class.cls\n', stderr='')
            if args[0] == 'latexmk':
                return server.subprocess.CompletedProcess(args, 0, stdout='Done', stderr='')
            raise AssertionError('unexpected conversion subprocess: ' + repr(args))
        with mock.patch('server.shutil.which', return_value='/usr/bin/kpsewhich'):
            with mock.patch('server.subprocess.run', side_effect=fake_run):
                for target in names:
                    with self.subTest(target=target):
                        name = 'out-' + target + '.tex'
                        result = server.run_convert(target, False, name, False)
                        self.assertEqual(result['file'], os.path.join('converted', target, name))
                        self.assertTrue(result['built'])
                        converted = os.path.join(self.tmp, result['file'])
                        self.assertTrue(os.path.isfile(converted))
                        self.assertIn(r'\begin{document}', open(converted, encoding='utf-8').read())
                        with self.assertRaises(FileExistsError):
                            server.run_convert(target, False, name, False)
                root = server.run_convert('article', True, 'main-article.tex', False, root=True)
        self.assertEqual(root['file'], 'main-article.tex')
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, 'main-article.tex')))
        self.assertEqual(server.read('main.tex'), original)
        latexmk = [(args, kw) for args, kw in calls if args[0] == 'latexmk']
        self.assertEqual(len(latexmk), len(names) + 1)
        for args, kw in latexmk:
            self.assertTrue(kw['env']['TEXINPUTS'].startswith(self.tmp + '//:'))
            self.assertTrue(os.path.isdir(kw['cwd']))

    def test_missing_class_does_not_write_converted_file(self):
        with mock.patch('server.shutil.which', return_value=None), mock.patch('server.CLASSES', self.tmp + '/no-classes'):
            with self.assertRaisesRegex(ValueError, 'iacrcc.cls is not installed'):
                server.run_convert('iacrcc', True, 'conversion.tex', False)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'converted', 'iacrcc', 'conversion.tex')))

    def test_corrupt_aux_is_backed_up_and_retried_once(self):
        aux_path = os.path.join(self.tmp, 'main.aux')
        with open(aux_path, 'w') as out:
            out.write('\\newlabel{bad}{{1}')
        builder = server.Builder.__new__(server.Builder)
        builder.aux = {}
        builder.auxver = 1
        builder.state = {'state': 'idle', 'message': '', 'at': 0}
        builder.log = lambda message: None
        old_config = server.CONFIG
        server.CONFIG = {'build': ['latexmk', '-pdf', 'main.tex']}
        failed = server.subprocess.CompletedProcess([], 1,
            stdout='! File ended while scanning use of \\@newl@bel.', stderr='')
        passed = server.subprocess.CompletedProcess([], 0, stdout='', stderr='')
        try:
            with mock.patch('server.subprocess.run', side_effect=[failed, passed]) as run:
                builder.build_once()
        finally:
            server.CONFIG = old_config
        self.assertEqual(builder.state['state'], 'ok')
        self.assertEqual(builder.auxver, 2)
        self.assertEqual(run.call_count, 2)
        self.assertIn('-g', run.call_args.args[0])
        self.assertTrue(os.listdir(os.path.join(server.CACHE, 'bad-aux')))

    def test_multiline_aux_labels_are_not_truncated(self):
        data = ('\\newlabel{thm:one}{{1}{2}{A long title\ncontinued}{theorem.1}{}}\n'
                '\\bibcite{a}{{12}{2026}}\n'
                '\\newlabel{broken}{{1}{2}')
        with mock.patch('server.aux_text', return_value=data):
            definitions = server.aux_label_lines()
        self.assertEqual(len(definitions), 2)
        self.assertIn('continued}{theorem.1}', definitions[0])
        self.assertIn('\\bibcite{a}{{12}{2026}}', definitions[1])

    @mock.patch('server.shutil.which', return_value='/usr/bin/google-chrome')
    @mock.patch('server.subprocess.Popen')
    def test_chrome_app_launch(self, popen, which):
        server.open_browser('http://127.0.0.1:8765/', 'chrome-app')
        popen.assert_called_once_with(
            ['/usr/bin/google-chrome', '--app=http://127.0.0.1:8765/'],
            stdout=server.subprocess.DEVNULL, stderr=server.subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
