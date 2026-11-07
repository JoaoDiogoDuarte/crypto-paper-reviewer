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

    def test_switch_documents(self):
        code, result = self.post('/api/open', {'main': 'other.tex'})
        self.assertEqual(code, 200)
        self.assertEqual(result['main'], 'other.tex')
        code, result = self.post('/api/open', {'main': 'missing.tex'})
        self.assertEqual(code, 400)

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

    @mock.patch('server.shutil.which', return_value='/usr/bin/google-chrome')
    @mock.patch('server.subprocess.Popen')
    def test_chrome_app_launch(self, popen, which):
        server.open_browser('http://127.0.0.1:8765/', 'chrome-app')
        popen.assert_called_once_with(
            ['/usr/bin/google-chrome', '--app=http://127.0.0.1:8765/'],
            stdout=server.subprocess.DEVNULL, stderr=server.subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
