"""Desktop privacy, deletion, authentication and failure-path regression tests."""
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from apps.vision.worker import make_handler
from core.session import SessionController
from test_phase1 import Clock, FakeCamera


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.camera = FakeCamera(self.clock)
        self.controller = SessionController(Path(self.temp.name) / 'sessions.sqlite3', self.camera, self.clock, self.clock.wall)

    def tearDown(self):
        self.controller.close()
        self.temp.cleanup()

    def saved_session(self, task='Private task'):
        session = self.controller.start(task, 'Reading', True)
        self.clock.value += 15
        self.controller.finish()
        return session['id']

    def test_deletion_removes_related_records_and_preserves_other_reports_and_setup(self):
        first = self.saved_session()
        second = self.saved_session('Keep this report')
        store = self.controller.store
        before = store.get(second)
        record = {'id': 'shared', 'model_version': 'v1', 'display': {}, 'validation': {}}
        store.save_gaze_setup(record, first, 'now')
        store.attach_calibration('shared', second)
        store.save_reflection(first, {'concentration': 3, 'distraction': 2, 'flow': 'no'})
        store.connection.execute('INSERT INTO session_annotations VALUES (?,?,?,?,?)', (first, 0, 0, 1, 'focused'))
        store.connection.commit()
        self.controller.storage_action('delete-session', first)
        self.assertIsNone(store.get(first))
        self.assertEqual(store.get(second), before)
        self.assertEqual(store.gaze_profile()['id'], 'shared')
        self.assertFalse(store.connection.execute('PRAGMA foreign_key_check').fetchall())
        for table in ('observations', 'timeline', 'analysis_provenance', 'session_reflections', 'session_annotations'):
            self.assertEqual(store.connection.execute(f'SELECT COUNT(*) FROM {table} WHERE session_id=?', (first,)).fetchone()[0], 0)

    def test_clear_history_keeps_profile_and_reset_keeps_reports(self):
        self.saved_session()
        store = self.controller.store
        store.save_gaze_setup({'id': 'profile', 'model_version': 'v1'}, None, 'now')
        self.controller.storage_action('reset-gaze')
        self.assertEqual(len(store.history()), 1)
        self.assertIsNone(store.gaze_profile())
        store.save_gaze_setup({'id': 'profile-new', 'model_version': 'v1'}, None, 'now')
        result = self.controller.storage_action('clear-history')
        self.assertEqual(result['sessions'], 0)
        self.assertTrue(result['gaze_setup_saved'])
        self.assertFalse(store.connection.execute('PRAGMA foreign_key_check').fetchall())

    def test_deletion_rejects_active_sessions_and_rolls_back_on_failure(self):
        identifier = self.saved_session()
        self.controller.start('Active', 'Math', False)
        with self.assertRaises(ValueError):
            self.controller.storage_action('delete-session', identifier)
        self.controller.finish()
        db = self.controller.store.connection
        db.execute("CREATE TRIGGER prevent_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(Exception):
            self.controller.storage_action('delete-session', identifier)
        self.assertIsNotNone(self.controller.store.get(identifier))
        self.assertEqual(db.execute('SELECT COUNT(*) FROM analysis_provenance WHERE session_id=?', (identifier,)).fetchone()[0], 1)

    def test_compaction_failure_reports_successful_deletion_separately(self):
        identifier = self.saved_session()
        with patch.object(self.controller.store, 'compact', side_effect=OSError('full')):
            result = self.controller.storage_action('delete-session', identifier)
        self.assertIn('could not be reclaimed', result['warning'])
        self.assertIsNone(self.controller.store.get(identifier))

    def test_camera_released_even_when_checkpoint_or_final_save_fails(self):
        for operation in ('finish', 'pause', 'disable', 'suspend'):
            with self.subTest(operation=operation):
                if self.controller.active_id:
                    self.controller.finish()
                self.controller.start('Failure', 'Math', True)
                self.clock.value += 1
                with patch.object(self.controller.store, 'append', side_effect=OSError('disk full')):
                    with self.assertRaises(OSError):
                        if operation == 'disable':
                            self.controller.set_camera(False)
                        else:
                            getattr(self.controller, operation)()
                self.assertFalse(self.camera.started)
                self.assertIsNone(self.controller.preview_frame())

    def test_sleep_is_break_and_requires_explicit_resume(self):
        self.controller.start('Sleep test', 'Math', True)
        self.clock.value += 10
        self.controller.suspend()
        self.clock.value += 3600
        state = self.controller.snapshot()
        self.assertEqual(state['active']['status'], 'break')
        self.assertEqual(state['active']['totals']['break'], 3600)
        self.assertFalse(self.camera.started)
        self.controller.resume()
        self.assertTrue(self.camera.started)

    def test_all_desktop_endpoints_require_secret_and_reject_foreign_origin(self):
        secret = 'a' * 64
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.controller, secret=secret))
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        thread.start()
        try:
            for route in ('health', 'state', 'camera/preview', 'storage'):
                for token in (None, 'wrong'):
                    headers = {'X-RUFocusing': '1'}
                    if token:
                        headers['X-RUFocusing-Token'] = token
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/{route}', headers=headers))
                    self.assertEqual(error.exception.code, 403)
            for origin in (None, 'https://example.com'):
                headers = {'X-RUFocusing-Token': secret}
                if origin:
                    headers['Origin'] = origin
                request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/storage', headers=headers)
                if origin:
                    with self.assertRaises(urllib.error.HTTPError):
                        urllib.request.urlopen(request)
                else:
                    with urllib.request.urlopen(request) as response:
                        self.assertEqual(json.load(response)['sessions'], 0)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_only_database_files_remain_after_session(self):
        self.saved_session()
        self.assertEqual({file.name for file in Path(self.temp.name).iterdir()}, {'sessions.sqlite3'})


if __name__ == '__main__':
    unittest.main()
