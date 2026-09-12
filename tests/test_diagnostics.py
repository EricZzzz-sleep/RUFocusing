"""Diagnostic protocol tests use synthetic eyes and clocks, never a webcam."""
from dataclasses import replace
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
import urllib.request
import urllib.error

import numpy as np

from apps.vision.diagnostics import Diagnostics, conditions, errors_summary
from apps.vision.gaze import GazeTracker
from apps.vision.worker import make_handler
from core.features.feature_engine import Observation
from core.session import SessionController
from database.store import Store
from test_gaze import DISPLAY, calibrate, observation
from test_phase1 import Clock, FakeCamera


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tracker = GazeTracker()
        self.now = calibrate(self.tracker)
        self.d = Diagnostics()

    def sample(self, x=.5, y=.5, invalid=False, stamp=None, delta=.2):
        self.now += delta
        obs = observation(self.now if stamp is None else stamp, x, y)
        if invalid:
            obs = replace(obs, gaze_features=None, gaze_quality='eyes_closed')
        self.tracker.update(obs, self.now)
        self.d.heartbeat(self.d.check['id'] if self.d.check else None, self.now)
        self.d.update(obs, self.tracker.snapshot(self.now)['observation'], self.tracker, self.now, self.now, 'session', 'running', True)

    def check(self, invalid=False, wrong=False):
        run = self.d.start_check('session', self.tracker, self.now, self.now)
        for i, (x, y) in enumerate(run['target_order']):
            self.d.target(run['id'], i, self.now)
            for _ in range(18):
                self.sample(.5 if wrong else x, .5 if wrong else y, invalid)
        return self.d.complete(run['id'], self.now)

    def test_fixed_windows_use_production_estimator_without_training(self):
        before = {key: value.copy() for key, value in self.tracker.model.items()}
        run = self.check()
        self.assertEqual(run['status'], 'passed')
        self.assertEqual(len(set(map(tuple, run['target_order']))), 9)
        self.assertAlmostEqual(sum(run['durations'].values()), 27)
        self.assertGreater(run['coverage'], .9)
        self.assertTrue(all(10 <= target['valid_count'] <= 15 for target in run['targets']))
        for key, value in before.items():
            np.testing.assert_array_equal(value, self.tracker.model[key])
        self.assertEqual(self.d.complete(run['id'], self.now)['id'], run['id'])

    def test_all_missing_still_finishes_fixed_windows_as_incomplete(self):
        run = self.check(invalid=True)
        self.assertEqual(run['status'], 'incomplete')
        self.assertEqual(run['valid_count'], 0)
        self.assertIsNone(run['median_error'])
        self.assertEqual(run['coverage'], 0)
        self.assertAlmostEqual(run['durations']['eyes_closed'], 27)
        self.assertEqual(self.tracker.status, 'ready')

    def test_large_errors_fail_and_percentiles_have_exact_boundaries(self):
        run = self.check(wrong=True)
        self.assertEqual(run['status'], 'failed')
        self.assertGreater(run['median_error'], .1)
        self.assertEqual(errors_summary([]), {'median_error': None, 'p90_error': None})
        self.assertAlmostEqual(errors_summary([0, .1, .2])['p90_error'], .18)

    def test_settling_duplicates_and_ownership(self):
        run = self.d.start_check('session', self.tracker, self.now, self.now, request_id='once')
        self.assertIs(self.d.start_check('session', self.tracker, self.now, self.now, request_id='once'), run)
        with self.assertRaises(ValueError): self.d.target('old-id', 0, self.now)
        with self.assertRaises(ValueError): self.d.target(run['id'], True, self.now)
        with self.assertRaises(ValueError): self.d.target(run['id'], 1, self.now)
        with self.assertRaises(ValueError): self.d.complete(run['id'], self.now)
        self.d.target(run['id'], 0, self.now)
        beginning = self.d.window_start
        self.sample(delta=.2)
        self.assertEqual(self.d.window_times, [])
        self.d.target(run['id'], 0, self.now)
        self.assertEqual(self.d.window_start, beginning)
        self.sample(delta=.4)
        stamp = self.now
        for _ in range(5): self.sample(stamp=stamp, delta=.05)
        self.assertEqual(len(self.d.window_times), 1)
        self.d.heartbeat(None, self.now + 4)
        self.assertIsNone(self.d.check)
        self.assertEqual(run['status'], 'interrupted')
        self.assertEqual(self.d.cancel(run['id'], self.now)['id'], run['id'])

    def test_trial_coverage_buckets_exclusions_reminders_and_final_check(self):
        trial = self.d.start_trial('session', self.tracker, self.now, self.now)
        self.assertIsNone(trial['coverage'])
        initial = self.check()
        self.assertEqual(initial['checkpoint'], 'initial')
        self.assertEqual(trial['status'], 'running')
        self.assertEqual(trial['study_seconds'], 0)
        self.sample()
        # A long observation gap remains in the denominator and is mostly stale.
        self.sample(delta=601)
        self.assertGreater(trial['study_seconds'], 600)
        self.assertLess(trial['coverage'], .01)
        self.assertEqual(self.d.snapshot()['trial']['reminder'], 'mid')
        self.assertGreaterEqual(len(trial['buckets']), 3)
        before = trial['study_seconds']
        self.now += 60
        obs = observation(self.now)
        self.d.update(obs, self.tracker.snapshot(self.now)['observation'], self.tracker, self.now, self.now, 'session', 'break', True)
        self.assertEqual(trial['study_seconds'], before)
        middle = self.check()
        self.assertEqual(middle['checkpoint'], 'mid')
        self.assertAlmostEqual(trial['study_seconds'], before)
        self.sample(delta=900)
        final = self.check()
        self.assertEqual(final['checkpoint'], 'final')
        self.assertIsNone(self.d.trial)
        self.assertEqual(trial['status'], 'completed')
        self.assertEqual(trial['checkpoints']['final']['status'], 'passed')
        self.assertEqual(len(trial['windows']), 3)
        self.assertTrue(all(window['end'] is not None for window in trial['windows']))
        self.assertAlmostEqual(sum(trial['durations'].values()), trial['study_seconds'])

    def test_calibration_invalidation_interrupts_trial_without_fabricated_check(self):
        trial = self.d.start_trial('session', self.tracker, self.now, self.now)
        self.tracker.reset('display_changed_recalibrate')
        self.sample()
        self.assertEqual(trial['status'], 'interrupted')
        self.assertEqual(trial['checkpoints']['initial']['status'], 'missed')
        self.assertIsNone(trial['coverage'])

    def test_suspension_is_unknown_study_time_and_cancellation_keeps_partial_target(self):
        trial = self.d.start_trial('session', self.tracker, self.now, self.now)
        self.check()
        self.sample()
        before = trial['study_seconds']
        self.now += .2
        obs = observation(self.now)
        self.tracker.update(obs, self.now)
        self.d.update(obs, self.tracker.snapshot(self.now)['observation'], self.tracker, self.now, self.now + 100, 'session', 'running', True)
        self.assertAlmostEqual(trial['study_seconds'] - before, 100.2)
        self.assertAlmostEqual(trial['durations']['timing_gap'], 100)
        run = self.d.start_check('session', self.tracker, self.now, self.now)
        self.d.target(run['id'], 0, self.now)
        for _ in range(8): self.sample()
        self.d.cancel(run['id'], self.now)
        self.assertEqual(run['status'], 'cancelled')
        self.assertTrue(run['targets'][0]['partial'])
        self.assertGreater(run['valid_count'], 0)
        self.assertLess(sum(run['durations'].values()), 3)

    def test_metadata_rejects_unexpected_or_unbounded_input(self):
        for value in ([], {'lighting': 'invented'}, {'notes': 'x' * 501}, {'frames': []}):
            with self.assertRaises(ValueError): conditions(value)


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'sessions.sqlite3'
        self.clock = Clock()
        self.camera = FakeCamera(self.clock)
        self.xy = [.5, .5]
        self.camera.snapshot = lambda: observation(self.clock(), *self.xy) if self.camera.started else Observation(self.clock())
        self.c = SessionController(self.path, self.camera, self.clock, self.clock.wall)
        self.c.start('Reliability test', 'Math', True)
        self.clock.value = calibrate(self.c.gaze, self.clock())
        self.c.store.save_calibration(self.c.gaze.record(), self.c.active_id, '2026-09-10T12:00:00+00:00')

    def tearDown(self):
        self.c.close()
        self.temp.cleanup()

    def start_check(self, request_id='check'):
        return self.c.diagnostic_action('checks', 'start', {'request_id': request_id, 'display': DISPLAY})['check']

    def run_check(self, wrong=False):
        run = self.start_check()
        for index, xy in enumerate(run['target_order']):
            self.xy[:] = [.5, .5] if wrong else xy
            self.c.diagnostic_action('checks', 'target', {'id': run['id'], 'target_index': index})
            for _ in range(18):
                self.clock.value += .2
                self.c.diagnostic_state(run['id'])
        self.c.diagnostic_action('checks', 'complete', {'id': run['id']})
        return self.c.diagnostic_records(identifier=run['id'])

    def test_failed_check_suppresses_point_and_preserves_session_and_history(self):
        identifier = self.c.active_id
        result = self.run_check(wrong=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(self.c.gaze.reason, 'accuracy_check_failed_recalibrate')
        self.assertFalse(self.c.gaze_snapshot()['observation']['valid'])
        self.assertEqual(self.c.active_id, identifier)
        self.assertTrue(self.camera.started)
        saved = self.c.finish()
        self.assertAlmostEqual(sum(i['end'] - i['start'] for i in saved['timeline']), saved['elapsed'])
        self.assertEqual(self.c.diagnostic_records(session_id=identifier)[0]['id'], result['id'])
        exported = json.dumps(result)
        for field in ('coefficients', 'gaze_features', 'landmarks', 'image'):
            self.assertNotIn(field, exported)

    def test_duplicate_start_and_camera_toggle_preserve_identity(self):
        run = self.start_check()
        repeated = self.start_check()
        self.assertEqual(run['id'], repeated['id'])
        self.c.set_camera(False)
        self.c.diagnostic_state()
        result = self.c.diagnostic_records(identifier=run['id'])
        self.assertEqual(result['status'], 'interrupted')
        self.assertIsNotNone(self.c.active_id)
        self.assertEqual(self.c.gaze.status, 'ready')

    def test_trial_survives_breaks_toggles_and_interrupts_on_retry(self):
        state = self.c.diagnostic_action('trials', 'start', {'request_id': 'trial', 'display': DISPLAY})
        trial_id = state['trial']['id']
        self.run_check()
        identifier = self.c.active_id
        self.clock.value += 1
        before = self.c.diagnostic_state()['trial']['study_seconds']
        self.c.pause()
        self.clock.value += 30
        during_break = self.c.diagnostic_state()['trial']
        self.assertAlmostEqual(during_break['study_seconds'], before)
        self.c.set_camera(False)
        self.c.resume()
        self.clock.value += 3
        off = self.c.diagnostic_state()['trial']
        self.assertEqual(off['id'], trial_id)
        self.assertAlmostEqual(off['durations']['camera_off'], 3)
        self.c.set_camera(True)
        self.c.diagnostic_state()
        self.c._start_camera(invalidate_gaze=True)
        self.assertIsNone(self.c.diagnostic_state()['trial'])
        self.assertEqual(self.c.diagnostic_records(identifier=trial_id)['status'], 'interrupted')
        self.assertEqual(self.c.active_id, identifier)

    def test_diagnostic_checkpoint_failure_does_not_stop_session_updates(self):
        self.start_check()
        self.clock.value += 1.1
        with patch.object(self.c.store, 'save_diagnostic', side_effect=sqlite3.OperationalError('disk busy')):
            self.c.diagnostics.touch(self.c.diagnostics.check, self.clock())
            self.c._update_gaze()
            self.assertIsNotNone(self.c.diagnostic_error)
            self.assertTrue(self.c.diagnostics.dirty)
        self.clock.value += 1.1
        self.c._update_gaze()
        self.assertIsNone(self.c.diagnostic_error)
        self.assertFalse(self.c.diagnostics.dirty)
        self.assertIsNotNone(self.c.active_id)

    def test_calibration_cancellation_and_failure_are_saved(self):
        self.c.gaze.reset()
        self.c.calibration_action('start', {'display': DISPLAY})
        self.clock.value += .2
        self.c.calibration_action('reset', {'calibration_id': self.c.gaze.identifier})
        self.assertEqual(self.c.diagnostic_records()[0]['status'], 'cancelled')
        self.assertEqual(self.c.diagnostic_records()[0]['kind'], 'calibration')

    def test_request_security_lifecycle_and_export(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.c))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def send(path, data=None, headers=None):
            request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}' + path,
                data=json.dumps(data).encode() if data is not None else None,
                headers=headers or {'Content-Type': 'application/json', 'X-RUFocusing': '1'})
            with urllib.request.urlopen(request) as response: return json.load(response)
        try:
            for body, headers, code in (({'request_id': 'x', 'display': DISPLAY}, {'Content-Type': 'application/json'}, 403),
                                        ({'request_id': 'x', 'display': DISPLAY}, {'Content-Type': 'application/json', 'X-RUFocusing': '1', 'Origin': 'https://example.com'}, 403),
                                        ({'request_id': 'x', 'display': DISPLAY, 'conditions': {'notes': 'x' * 5000}}, None, 400)):
                with self.assertRaises(urllib.error.HTTPError) as error: send('/api/gaze/checks/start', body, headers)
                self.assertEqual(error.exception.code, code)
                error.exception.close()
            run = send('/api/gaze/checks/start', {'request_id': 'api', 'display': DISPLAY})['check']
            with self.assertRaises(urllib.error.HTTPError) as failure: send('/api/gaze/checks/target', {'id': 'wrong', 'target_index': 0})
            failure.exception.close()
            self.assertEqual(send('/api/gaze/diagnostics/state')['check']['id'], run['id'])
            send('/api/gaze/checks/cancel', {'id': run['id']})
            result = send('/api/gaze/diagnostics/' + run['id'])
            self.assertEqual(result['status'], 'cancelled')
            self.assertEqual(send('/api/gaze/diagnostics?session_id=' + self.c.active_id)[0]['id'], run['id'])
        finally:
            server.shutdown(); server.server_close(); thread.join()


class MigrationTests(unittest.TestCase):
    def test_populated_v2_upgrade_and_reopening_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'v2.sqlite3'
            connection = sqlite3.connect(path)
            connection.executescript(Path('database/schema.sql').read_text() + Path('database/gaze_v2.sql').read_text())
            connection.execute("INSERT INTO sessions (id,task,mode,started_at,checkpoint_at,status,camera_enabled) VALUES ('saved','Old task','Math','2026-09-01','2026-09-01','completed',0)")
            connection.commit(); connection.close()
            store = Store(path)
            self.assertEqual(store.get('saved')['task'], 'Old task')
            self.assertEqual(store.connection.execute('PRAGMA user_version').fetchone()[0], 4)
            tracker = GazeTracker(); tracker.start(DISPLAY, 0)
            collector = Diagnostics(); collector.begin_calibration('saved', tracker, 0, 0)
            store.save_diagnostic(collector.calibration); identifier = collector.calibration['id']
            store.close()
            reopened = Store(path)
            self.assertEqual(reopened.diagnostic(identifier)['status'], 'interrupted')
            self.assertEqual(reopened.diagnostic(identifier)['reason'], 'application_restarted')
            reopened.close()

    def test_v3_migration_failure_rolls_back(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'v2.sqlite3'
            connection = sqlite3.connect(path)
            connection.executescript(Path('database/schema.sql').read_text() + Path('database/gaze_v2.sql').read_text())
            connection.close()
            original = Path.read_text
            def broken(file, *args, **kwargs):
                return original(file, *args, **kwargs) + '\nINVALID SQL;' if file.name == 'diagnostics_v3.sql' else original(file, *args, **kwargs)
            with patch.object(Path, 'read_text', broken), self.assertRaises(sqlite3.OperationalError): Store(path)
            connection = sqlite3.connect(path)
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0], 2)
            self.assertIsNone(connection.execute("SELECT name FROM sqlite_master WHERE name='diagnostic_runs'").fetchone())
            connection.close()
