"""Launcher checks use real loopback servers without starting cameras or sessions."""
from contextlib import redirect_stderr, redirect_stdout
from http.server import ThreadingHTTPServer
import io
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
import webbrowser

from apps.desktop import run
from apps.vision.worker import make_handler


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.frontend = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(None))
        self.port = self.frontend.server_port
        self.frontend.RequestHandlerClass = make_handler(None, self.port)
        self.backend = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(None, self.port))
        self.api_port = self.backend.server_port
        self.threads = []
        for server in (self.frontend, self.backend):
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
            thread.start()
            self.threads.append(thread)
        self.args = ['--port', str(self.port), '--api-port', str(self.api_port)]

    def tearDown(self):
        for server in (self.frontend, self.backend):
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(timeout=2)

    def test_repeat_run_reopens_page_without_starting_or_stopping_servers(self):
        with patch.object(run.webbrowser, 'open', return_value=True) as open_page, patch.object(run.subprocess, 'Popen') as start, patch.object(run.os, 'killpg') as kill, redirect_stdout(io.StringIO()):
            self.assertEqual(run.main(self.args), 0)
        open_page.assert_called_once_with(f'http://127.0.0.1:{self.port}')
        start.assert_not_called()
        kill.assert_not_called()
        self.assertTrue(run.already_running(self.port, self.api_port))

    def test_repeat_run_respects_no_open(self):
        with patch.object(run.webbrowser, 'open') as open_page, redirect_stdout(io.StringIO()):
            self.assertEqual(run.main([*self.args, '--no-open']), 0)
        open_page.assert_not_called()

    def test_different_checkout_is_not_reused_or_stopped(self):
        with patch('apps.vision.worker.ROOT', Path('/another/checkout')), patch.object(run.os, 'killpg') as kill, redirect_stderr(io.StringIO()):
            self.assertFalse(run.already_running(self.port, self.api_port))
            with self.assertRaises(SystemExit) as error:
                run.main(self.args)
            self.assertEqual(error.exception.code, 2)
        kill.assert_not_called()

    def test_mismatched_frontend_is_not_reused(self):
        self.frontend.RequestHandlerClass = make_handler(None, self.port + 1)
        self.assertFalse(run.already_running(self.port, self.api_port))

    def test_older_api_version_is_not_reused(self):
        from http.server import BaseHTTPRequestHandler
        import json
        import hashlib
        class OldHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(handler):
                body = json.dumps({'ok': True, 'app': 'RUFocusing', 'project': hashlib.sha256(str(run.ROOT).encode()).hexdigest(), 'frontend_port': self.port}).encode()
                handler.send_response(200)
                handler.end_headers()
                handler.wfile.write(body)
        self.backend.RequestHandlerClass = OldHandler
        self.assertFalse(run.already_running(self.port, self.api_port))

    def test_incomplete_pair_is_not_reused(self):
        self.backend.shutdown()
        self.backend.server_close()
        self.assertFalse(run.already_running(self.port, self.api_port))

    def test_port_check_allows_immediate_restart_but_rejects_live_server(self):
        self.assertTrue(run.already_running(self.port, self.api_port))
        self.assertFalse(run.port_available(self.api_port))
        self.backend.shutdown()
        self.backend.server_close()
        self.assertTrue(run.port_available(self.api_port))

    def test_browser_failure_keeps_running_app_available(self):
        for failure in (False, OSError('Browser unavailable'), webbrowser.Error('No browser')):
            with self.subTest(failure=failure), patch.object(run.webbrowser, 'open') as open_page, redirect_stdout(io.StringIO()) as output:
                if isinstance(failure, Exception):
                    open_page.side_effect = failure
                else:
                    open_page.return_value = failure
                self.assertEqual(run.main(self.args), 0)
                self.assertIn(f'Open http://127.0.0.1:{self.port}', output.getvalue())
                self.assertTrue(run.already_running(self.port, self.api_port))


if __name__ == '__main__':
    unittest.main()
