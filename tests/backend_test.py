#!/usr/bin/env python3
"""Backend regression tests for save, document switching, builds and launching."""
import json
import os
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

    def test_missing_class_does_not_write_converted_file(self):
        with mock.patch('server.shutil.which', return_value=None):
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
