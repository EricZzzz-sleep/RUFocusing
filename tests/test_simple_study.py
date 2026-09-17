"""Study-period contracts and durable gaze setup using synthetic camera data."""
from dataclasses import replace
import copy
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from apps.vision.gaze import GazeTracker, TARGETS
from core.analytics.study_patterns import analyze_session
from core.features.feature_engine import Observation
from core.session import SessionController
from database.store import Store
from test_gaze import DISPLAY, features, observation
from test_phase1 import Clock, FakeCamera
from test_study_patterns import session


class StudyPeriodTests(unittest.TestCase):
    def test_threshold_reclassifies_whole_continuous_period(self):
        for seconds, state in ((599.999, 'normal'), (600, 'deep'), (600.001, 'deep')):
            result = analyze_session(session(('present', seconds)))['study_periods']
            self.assertEqual(result['intervals'], [{'start': 0, 'end': seconds, 'state': state}])
            self.assertEqual(result['totals'][state], seconds)
        result = analyze_session(session(('present', 300), ('present', 300)))['study_periods']
        self.assertEqual(result['totals']['deep'], 600)

    def test_gaps_interrupt_and_never_count_as_normal_or_distracted(self):
        result = analyze_session(session(('present', 600), ('away', 20), ('unknown', 5),
                                         ('present', 599), ('break', 60), ('present', 601)),
                                 [{'start': 1400, 'end': 1450, 'kind': 'calibration'}])['study_periods']
        self.assertEqual(result['totals'], {'deep': 600, 'normal': 1150, 'distracted': 20})
        self.assertIn('diagnostic', [row['state'] for row in result['intervals']])
        for state, total in result['totals'].items():
            self.assertEqual(total, sum(row['end'] - row['start'] for row in result['intervals'] if row['state'] == state))

    def test_empty_missing_and_legacy_evidence_are_unavailable(self):
        for value, reason in ((session(), None), (session(('unknown', 800)), None),
                              (session(('present', 800)), 'historical_diagnostic_boundaries_missing')):
            result = analyze_session(value, provenance_reason=reason)['study_periods']
            self.assertFalse(result['available'])
            self.assertEqual(sum(result['totals'].values()), 0)
            self.assertFalse(any(row['state'] in ('normal', 'deep', 'distracted') for row in result['intervals']))

    def test_live_saved_and_analysis_use_identical_periods(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'study.db')
            try:
                store.create('s', 'Study', 'Reading', '2026-09-12', True)
                store.append('s', 0, 599, 'present', '2026-09-12')
                self.assertEqual(store.get('s')['study_periods']['totals']['normal'], 599)
                store.append('s', 599, 600, 'present', '2026-09-12')
                live = store.get('s')['study_periods']
                store.set_status('s', 'completed', '2026-09-12')
                self.assertEqual(live, store.get('s')['study_periods'])
                self.assertEqual(live, store.analysis('s')['study_periods'])
                self.assertEqual(live, store.history()[0]['study_periods'])
            finally:
                store.close()


class PersistentSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'setup.db'
        self.clock = Clock()
        self.camera = FakeCamera(self.clock)
        self.config = (0, 640, 480)
        self.camera.snapshot = lambda: replace(observation(self.clock()), camera_config=self.config) if self.camera.started else Observation(self.clock())
        self.c = SessionController(self.path, self.camera, self.clock, self.clock.wall)
        self.c.start_preview()
        self.complete_setup()
        self.saved = self.c.store.gaze_profile()

    def tearDown(self):
        self.c.close()
        self.temp.cleanup()

    def complete_setup(self, bad=False):
        self.c.calibration_action('start', {'display': DISPLAY})
        self.c.gaze.camera_config = self.config
        self.c.gaze.samples = {i: np.array([features(1 - x if bad and i >= 9 else x, y)] * 12)
                               for i, (x, y) in enumerate(TARGETS)}
        return self.c.calibration_action('complete', {'calibration_id': self.c.gaze.identifier})

    def test_restart_requires_display_confirmation_and_fresh_compatible_frame(self):
        self.c.close()
        self.c = SessionController(self.path, self.camera, self.clock, self.clock.wall)
        self.assertEqual(self.c.gaze.identifier, self.saved['id'])
        self.assertFalse(self.c.gaze.latest.valid)
        self.c.start_preview()
        self.clock.value += .2
        self.assertFalse(self.c.gaze_snapshot()['observation']['valid'])
        self.c.calibration_action('display', {'display': DISPLAY})
        self.clock.value += .2
        self.assertTrue(self.c.gaze_snapshot()['observation']['valid'])

    def test_preview_close_expiry_break_toggle_and_multiple_sessions_keep_setup(self):
        self.c.stop_preview()
        self.assertEqual(self.c.gaze.identifier, self.saved['id'])
        self.c.start_preview()
        self.clock.value += 9
        self.c.snapshot()
        self.assertEqual(self.c.gaze.identifier, self.saved['id'])
        sessions = []
        for _ in range(2):
            self.c.start('Study', 'Math', True)
            self.clock.value += .2
            self.c.gaze_snapshot()
            self.clock.value += 1
            self.c.snapshot()
            self.c.pause()
            self.c.resume()
            self.c.set_camera(False)
            self.c.set_camera(True)
            sessions.append(self.c.finish()['id'])
            self.assertEqual(self.c.gaze.identifier, self.saved['id'])
        for identifier in sessions:
            self.assertEqual(self.c.gaze_details(identifier)['calibrations'][0]['id'], self.saved['id'])
        # The reusable model is independent of any one session's lifetime.
        self.assertIsNone(self.c.store.connection.execute('SELECT session_id FROM calibrations WHERE id=?', (self.saved['id'],)).fetchone()[0])

    def test_changed_display_camera_and_seating_suspend_without_erasing(self):
        self.c.calibration_action('display', {'display': {**DISPLAY, 'width': 1920}})
        self.clock.value += .2
        self.assertFalse(self.c.gaze_snapshot()['observation']['valid'])
        self.c.calibration_action('display', {'display': DISPLAY})
        self.config = (1, 1280, 720)
        self.clock.value += .2
        self.assertEqual(self.c.gaze_snapshot()['observation']['reason'], 'camera_config_changed_recalibrate')
        self.config = (0, 640, 480)
        self.clock.value += .2
        self.assertTrue(self.c.gaze_snapshot()['observation']['valid'])
        self.assertEqual(self.c.store.gaze_profile(), self.saved)

    def test_stale_gaze_never_extends_intervals_or_erases_setup(self):
        self.c.start('Freshness', 'Math', True)
        self.clock.value += .2
        frame = replace(observation(self.clock()), camera_config=self.config)
        self.camera.snapshot = lambda: frame if self.camera.started else Observation(self.clock())
        self.c.gaze_snapshot()
        self.assertTrue(self.c.gaze.latest.valid)
        for _ in range(10):
            self.clock.value += .2
            self.c.snapshot()
        self.assertFalse(self.c.gaze.latest.valid)
        saved = self.c.finish()
        intervals = self.c.gaze_details(saved['id'])['intervals']
        tracked = [row for row in intervals if row['state'] not in ('unknown', 'break')]
        self.assertTrue(tracked)
        self.assertTrue(all(row['end'] <= .2 + .75 for row in tracked))
        self.assertEqual(self.c.store.gaze_profile(), self.saved)

    def test_cancel_failed_replacement_and_abandonment_restore_previous_profile(self):
        for mode in ('cancel', 'fail', 'abandon'):
            with self.subTest(mode=mode):
                if mode == 'fail':
                    with self.assertRaisesRegex(ValueError, 'another try'):
                        self.complete_setup(bad=True)
                else:
                    self.c.calibration_action('start', {'display': DISPLAY})
                    token = self.c.gaze.identifier
                    if mode == 'cancel':
                        self.c.calibration_action('reset', {'calibration_id': token})
                    else:
                        self.clock.value += 4
                        self.c.gaze_snapshot(token)
                self.assertEqual(self.c.gaze.identifier, self.saved['id'])
                self.assertEqual(self.c.store.gaze_profile(), self.saved)

    def test_storage_failure_rolls_back_profile_and_model_then_success_replaces(self):
        before = self.c.store.connection.execute('SELECT COUNT(*) FROM calibrations').fetchone()[0]
        self.c.store.connection.execute("CREATE TRIGGER reject_profile BEFORE UPDATE ON gaze_profile BEGIN SELECT RAISE(ABORT, 'disk error'); END")
        with self.assertRaisesRegex(ValueError, 'could not be saved'):
            self.complete_setup()
        self.assertEqual(self.c.store.gaze_profile(), self.saved)
        self.assertEqual(self.c.gaze.identifier, self.saved['id'])
        self.assertEqual(self.c.store.connection.execute('SELECT COUNT(*) FROM calibrations').fetchone()[0], before)
        self.c.store.connection.execute('DROP TRIGGER reject_profile')
        self.complete_setup()
        self.assertNotEqual(self.c.gaze.identifier, self.saved['id'])
        self.assertEqual(self.c.store.gaze_profile()['id'], self.c.gaze.identifier)

    def test_explicit_reset_is_durable_and_preserves_historical_model(self):
        with patch.object(self.c.store, 'reset_gaze_profile', side_effect=sqlite3.OperationalError('busy')):
            with self.assertRaises(sqlite3.OperationalError):
                self.c.calibration_action('reset', {})
        self.assertEqual(self.c.store.gaze_profile(), self.saved)
        self.c.calibration_action('reset', {})
        self.assertIsNone(self.c.store.gaze_profile())
        self.assertEqual(self.c.gaze.status, 'uncalibrated')
        self.assertIsNotNone(self.c.store.connection.execute('SELECT id FROM calibrations WHERE id=?', (self.saved['id'],)).fetchone())
        self.c.close()
        self.c = SessionController(self.path, self.camera, self.clock, self.clock.wall)
        self.assertEqual(self.c.gaze.status, 'uncalibrated')

    def test_incompatible_or_corrupt_saved_models_are_rejected(self):
        cases = []
        for key, value in [('model_version', 'future'), ('features', []), ('validation', {'accepted': False}), ('parameters', {})]:
            cases.append({**self.saved, key: value})
        bad = copy.deepcopy(self.saved)
        bad['parameters']['scale'][0] = 0
        cases.append(bad)
        for record in cases:
            tracker = GazeTracker()
            self.assertFalse(tracker.restore(record))
            self.assertEqual(tracker.status, 'uncalibrated')
        self.c.store.connection.execute("UPDATE gaze_profile SET model_json='broken'")
        self.c.store.connection.commit()
        self.assertIsNone(self.c.store.gaze_profile())

    def test_v4_migration_keeps_history_without_promoting_old_calibrations(self):
        path = Path(self.temp.name) / 'old.db'
        db = sqlite3.connect(path)
        for filename in ('schema.sql', 'gaze_v2.sql', 'diagnostics_v3.sql', 'study_patterns_v4.sql'):
            db.executescript((Path('database') / filename).read_text())
        db.execute("INSERT INTO sessions (id,task,mode,started_at,checkpoint_at,status,camera_enabled,elapsed) VALUES ('old','Study','Math','2026-09-12','2026-09-12','completed',1,600)")
        db.execute("INSERT INTO timeline (session_id,start,end,state) VALUES ('old',0,600,'present')")
        db.commit()
        db.close()
        store = Store(path)
        try:
            self.assertEqual(store.get('old')['elapsed'], 600)
            self.assertIsNone(store.gaze_profile())
            self.assertEqual(store.connection.execute('PRAGMA user_version').fetchone()[0], 5)
        finally:
            store.close()
