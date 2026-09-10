"""Deterministic gaze tests; synthetic features only, never a physical camera."""
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from apps.vision.worker import make_handler
from unittest.mock import patch

import numpy as np

from apps.vision.gaze import GazeTracker, TARGETS, eye_features
from core.features.feature_engine import Observation
from core.session import SessionController
from database.store import Store
from test_phase1 import Clock, FakeCamera

DISPLAY = {'width': 1440, 'height': 900, 'device_pixel_ratio': 2}


def features(x=.5, y=.5):
    return (.3 * (x - .5), .2 * (y - .5), .3 * (x - .5), .2 * (y - .5), 0., 0., .5, .5, .3)


def observation(now, x=.5, y=.5):
    return Observation(now, True, 1, pitch=0., yaw=0., roll=0., camera_status='ready',
                       gaze_features=features(x, y), gaze_quality='usable')


def calibrate(tracker, now=10., bad_validation=False):
    tracker.start(DISPLAY, now)
    for index, (x, y) in enumerate(TARGETS):
        tracker.target(tracker.identifier, index, now)
        for sample in range(12):
            timestamp = now + .6 + sample * .21
            tracker.last_client_seen = timestamp
            obs = observation(timestamp, 1 - x if bad_validation and index >= 9 else x, y)
            tracker.update(obs, timestamp)
        now += 3
    tracker.complete(tracker.identifier)
    return now


def mesh(width=640, height=480, closed=False, scale=1.):
    # Fixed pixel geometry, then normalize to test different image aspect ratios.
    points = [SimpleNamespace(x=320 / width, y=240 / height) for _ in range(478)]
    points[0] = SimpleNamespace(x=(320 - 100 * scale) / width, y=140 / height)
    points[1] = SimpleNamespace(x=(320 + 100 * scale) / width, y=340 / height)
    for a, b, upper, lower, iris, center in [(33, 133, 159, 145, 468, 280), (362, 263, 386, 374, 473, 360)]:
        for index, x, y in [(a, center - 20, 220), (b, center + 20, 220),
                            (upper, center, 220 if closed else 212), (lower, center, 220 if closed else 228), (iris, center + 3, 222)]:
            points[index] = SimpleNamespace(x=x / width, y=y / height)
    return points


class EyeGeometryTests(unittest.TestCase):
    def test_eye_coordinates_respect_image_aspect_ratio(self):
        pose = {'pitch': 0, 'yaw': 0, 'roll': 0}
        first = eye_features(mesh(), 640, 480, pose)
        second = eye_features(mesh(800, 600), 800, 600, pose)
        self.assertEqual(first['gaze_quality'], 'usable')
        np.testing.assert_allclose(first['gaze_features'][:4], second['gaze_features'][:4])
        self.assertAlmostEqual(first['gaze_features'][0], .075)
        self.assertAlmostEqual(first['eye_openness'][0], .4)

    def test_rejects_closed_small_clipped_and_invalid_faces(self):
        pose = {'pitch': 0, 'yaw': 0, 'roll': 0}
        self.assertEqual(eye_features(mesh(closed=True), 640, 480, pose)['gaze_quality'], 'eyes_closed')
        clipped = mesh()
        clipped[0].x = -.1
        self.assertEqual(eye_features(clipped, 640, 480, pose)['gaze_quality'], 'face_clipped')
        self.assertEqual(eye_features([], 640, 480, pose)['gaze_quality'], 'invalid_landmarks')
        points = mesh()
        points[33].x = float('nan')
        self.assertEqual(eye_features(points, 640, 480, pose)['gaze_quality'], 'invalid_landmarks')
        self.assertEqual(eye_features(mesh(), 640, 480, {**pose, 'yaw': 50})['gaze_quality'], 'extreme_head_angle')
        small = [SimpleNamespace(x=.5 + (p.x - .5) * .2, y=p.y) for p in mesh()]
        self.assertEqual(eye_features(small, 640, 480, pose)['gaze_quality'], 'face_too_small')


class CalibrationTests(unittest.TestCase):
    def test_calibration_fit_and_held_out_validation(self):
        tracker = GazeTracker()
        now = calibrate(tracker)
        self.assertEqual(tracker.status, 'ready')
        self.assertLess(tracker.validation['median_error'], .01)
        self.assertEqual(tracker.samples, {})
        tracker.update(observation(now, .7, .3), now)
        self.assertTrue(tracker.latest.valid)
        self.assertAlmostEqual(tracker.latest.x, .7, delta=.02)
        self.assertAlmostEqual(tracker.latest.y, .3, delta=.02)
        self.assertEqual(tracker.latest.region, 'top_right')
        json.dumps(tracker.record(), allow_nan=False)

    def test_validation_failure_never_outputs_coordinates(self):
        tracker = GazeTracker()
        now = calibrate(tracker, bad_validation=True)
        self.assertEqual(tracker.status, 'failed')
        self.assertIsNone(tracker.model)
        tracker.update(observation(now), now)
        self.assertFalse(tracker.latest.valid)
        self.assertIsNone(tracker.latest.x)
        self.assertIsNotNone(tracker.validation['median_error'])

    def test_target_settling_duplicates_minimum_span_and_timeout(self):
        tracker = GazeTracker()
        tracker.start(DISPLAY, 0)
        tracker.target(tracker.identifier, 0, 0)
        tracker.update(observation(.1), .1)
        self.assertEqual(len(tracker.target_samples), 0)
        tracker.update(observation(.6), .6)
        for _ in range(20): tracker.update(observation(.6), .6)
        self.assertEqual(len(tracker.target_samples), 1)
        tracker.target(tracker.identifier, 0, .7)
        self.assertEqual(tracker.target_started, 0)
        for index in range(11): tracker.update(observation(.7 + index * .01), .7 + index * .01)
        self.assertEqual(len(tracker.samples), 0)
        tracker.last_client_seen = 11
        tracker.snapshot(11)
        self.assertIsNotNone(tracker.target_error)
        tracker.target(tracker.identifier, 0, 11)
        self.assertIsNone(tracker.target_error)
        tracker.snapshot(15)
        self.assertEqual(tracker.reason, 'calibration_abandoned')

    def test_invalid_lifecycle_and_display_values(self):
        tracker = GazeTracker()
        with self.assertRaises(ValueError): tracker.target('missing', 0, 0)
        for display in [{}, {**DISPLAY, 'width': float('nan')}, {**DISPLAY, 'height': True}]:
            with self.assertRaises(ValueError): tracker.start(display, 0)
        tracker.start(DISPLAY, 0)
        with self.assertRaises(ValueError): tracker.target(tracker.identifier, 1, 0)
        with self.assertRaises(ValueError): tracker.target(tracker.identifier, True, 0)
        with self.assertRaises(ValueError): tracker.complete(tracker.identifier)

    def test_stale_blink_and_multiple_faces_clear_point_and_smoothing(self):
        for change in [{'available': False}, {'gaze_quality': 'eyes_closed'}, {'face_count': 2}, {'gaze_features': (float('nan'),) * 9}]:
            with self.subTest(change=change):
                tracker = GazeTracker()
                now = calibrate(tracker)
                tracker.update(observation(now), now)
                tracker.update(replace(observation(now + .2), **change), now + .2)
                self.assertFalse(tracker.latest.valid)
                self.assertIsNone(tracker.smoothed)
                self.assertEqual(tracker.status, 'ready')
                tracker.update(observation(now + .4), now + .4)
                self.assertTrue(tracker.latest.valid)
                self.assertFalse(tracker.snapshot(now + 1.2)['observation']['valid'])

    def test_smoothing_and_outside_estimates(self):
        tracker = GazeTracker()
        now = calibrate(tracker)
        tracker.update(observation(now, .2, .5), now)
        tracker.update(observation(now + .2, .8, .5), now + .2)
        self.assertGreater(tracker.latest.x, .2)
        self.assertLess(tracker.latest.x, .8)
        tracker.update(observation(now + .4, 3, .5), now + .4)
        self.assertFalse(tracker.latest.valid)
        self.assertEqual(tracker.latest.reason, 'outside_calibrated_area')
        self.assertIsNone(tracker.latest.x)

    def test_sustained_geometry_change_and_camera_failure_invalidate(self):
        tracker = GazeTracker()
        now = calibrate(tracker)
        bad = list(features())
        bad[6] = .7
        for delta in [0, .5, 1, 1.5, 2.1]:
            tracker.update(replace(observation(now + delta), gaze_features=tuple(bad)), now + delta)
            self.assertFalse(tracker.latest.valid)
        self.assertEqual(tracker.status, 'uncalibrated')
        self.assertEqual(tracker.reason, 'seating_changed_recalibrate')
        now = calibrate(tracker, now + 5)
        tracker.update(Observation(now, camera_status='unavailable'), now)
        self.assertEqual(tracker.status, 'uncalibrated')


class GazeStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'test.sqlite3'

    def tearDown(self):
        self.temp.cleanup()

    def make_legacy(self):
        db = sqlite3.connect(self.path)
        db.executescript(Path('database/schema.sql').read_text())
        db.execute("INSERT INTO sessions (id,task,mode,started_at,checkpoint_at,status,camera_enabled,elapsed) VALUES ('old','Legacy','Math','2026-01-01','2026-01-01','running',0,10)")
        db.execute("INSERT INTO timeline (session_id,start,end,state) VALUES ('old',0,10,'unknown')")
        db.commit()
        db.close()

    def test_migration_preserves_populated_v1_and_reopens(self):
        self.make_legacy()
        store = Store(self.path)
        self.assertEqual(store.connection.execute('PRAGMA user_version').fetchone()[0], 2)
        old = store.get('old')
        self.assertEqual(old['status'], 'interrupted')
        self.assertEqual(old['elapsed'], 10)
        self.assertEqual(old['totals']['unknown'], 10)
        self.assertIsNone(old['gaze_summary'])
        store.close()
        store = Store(self.path)
        self.assertEqual(store.get('old'), old)
        store.close()

    def test_migration_rolls_back_all_schema_changes_on_failure(self):
        self.make_legacy()
        original = Path.read_text
        with patch.object(Path, 'read_text', lambda path, *a, **k: 'CREATE TABLE partial (id INTEGER); INVALID SQL;' if path.name == 'gaze_v2.sql' else original(path, *a, **k)):
            with self.assertRaises(sqlite3.Error): Store(self.path)
        db = sqlite3.connect(self.path)
        self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
        self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='partial'").fetchone())
        self.assertEqual(db.execute('SELECT elapsed FROM sessions').fetchone()[0], 10)
        db.close()

    def test_session_gaze_intervals_camera_lifetime_and_breaks(self):
        clock = Clock()
        camera = FakeCamera(clock)
        camera.snapshot = lambda: observation(clock()) if camera.started else Observation(clock())
        controller = SessionController(self.path, camera, clock, clock.wall)
        try:
            controller.start('Gaze session', 'Math', True)
            clock.value = calibrate(controller.gaze, clock())
            controller.store.save_calibration(controller.gaze.record(), controller.active_id, datetime.now(timezone.utc).isoformat())
            controller.snapshot()  # A long calibration-clock jump is unknown.
            calibration_id = controller.gaze.identifier
            for _ in range(15):
                clock.value += .2
                controller.gaze_snapshot()
                if _ % 5 == 4: controller.snapshot()
            controller.pause()
            clock.value += 2
            controller.resume()
            self.assertEqual(controller.gaze.identifier, calibration_id)
            controller.set_camera(False)
            clock.value += 1
            controller.set_camera(True)
            self.assertEqual(controller.gaze.identifier, calibration_id)
            clock.value += 1
            saved = controller.finish()
            self.assertGreater(saved['gaze_summary']['tracked'], 0)
            details = controller.gaze_details(saved['id'])
            cursor = 0
            for interval in details['intervals']:
                self.assertAlmostEqual(interval['start'], cursor)
                cursor = interval['end']
            self.assertAlmostEqual(cursor, saved['elapsed'])
            self.assertAlmostEqual(details['summary']['totals']['break'], 2)
            self.assertLessEqual(details['summary']['coverage'], 1)
            self.assertEqual(len(details['calibrations']), 1)
            self.assertNotIn('parameters', details['calibrations'][0])
            controller.start('New session', 'Math', True)
            self.assertEqual(controller.gaze.status, 'uncalibrated')
        finally:
            controller.close()

    def test_real_clock_checkpoints_do_not_overlap_gaze_intervals(self):
        import time
        camera = FakeCamera(time.monotonic)
        controller = SessionController(self.path, camera)
        try:
            controller.start('Real clock', 'Math', False)
            for _ in range(30):
                controller.gaze_snapshot()
                controller.snapshot()
            saved = controller.finish()
            intervals = controller.gaze_details(saved['id'])['intervals']
            cursor = 0
            for interval in intervals:
                self.assertAlmostEqual(interval['start'], cursor, places=8)
                cursor = interval['end']
            self.assertAlmostEqual(sum(i['end'] - i['start'] for i in intervals), saved['elapsed'], places=8)
        finally:
            controller.close()

    def test_setup_transfer_display_change_and_reset(self):
        clock = Clock()
        camera = FakeCamera(clock)
        controller = SessionController(self.path, camera, clock, clock.wall)
        try:
            with self.assertRaises(ValueError): controller.calibration_action('start', {'display': DISPLAY})
            controller.start_preview()
            clock.value = calibrate(controller.gaze, clock())
            controller.preview_until = clock() + 8
            controller.store.save_calibration(controller.gaze.record(), None, datetime.now(timezone.utc).isoformat())
            calibration_id = controller.gaze.identifier
            controller.start('Transferred', 'Reading', True)
            self.assertEqual(controller.gaze.identifier, calibration_id)
            controller.calibration_action('display', {'display': {**DISPLAY, 'width': 1920}})
            self.assertEqual(controller.gaze.reason, 'display_changed_recalibrate')
            self.assertEqual(controller.gaze.status, 'uncalibrated')
        finally:
            controller.close()


class GazeApiTests(unittest.TestCase):
    def test_calibration_endpoints_security_collection_and_saved_report(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = Clock()
            camera = FakeCamera(clock)
            target = [.5, .5]
            camera.snapshot = lambda: observation(clock(), *target) if camera.started else Observation(clock())
            controller = SessionController(Path(directory) / 'api.sqlite3', camera, clock, clock.wall)
            server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(controller))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def send(path, data=None, headers=None):
                request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}' + path,
                    data=json.dumps(data).encode() if data is not None else None,
                    headers=headers or {'Content-Type': 'application/json', 'X-RUFocusing': '1'})
                with urllib.request.urlopen(request) as response: return json.load(response)
            def rejected(path, data, status, headers=None):
                with self.assertRaises(urllib.error.HTTPError) as failure: send(path, data, headers)
                self.assertEqual(failure.exception.code, status)
                failure.exception.close()
            try:
                self.assertFalse(send('/api/gaze/state')['observation']['valid'])
                rejected('/api/gaze/calibration/start', {'display': DISPLAY}, 400)
                send('/api/camera/preview/start', {})
                rejected('/api/gaze/calibration/start', {'display': DISPLAY}, 403, {'Content-Type': 'application/json'})
                rejected('/api/gaze/calibration/start', {'display': DISPLAY}, 403, {'Content-Type': 'application/json', 'X-RUFocusing': '1', 'Origin': 'https://example.com'})
                state = send('/api/gaze/calibration/start', {'display': DISPLAY})
                identifier = state['calibration']['id']
                rejected('/api/gaze/calibration/complete', {'calibration_id': identifier}, 400)
                rejected('/api/gaze/calibration/target', {'calibration_id': identifier, 'target_index': 1}, 400)
                for index, coordinates in enumerate(TARGETS):
                    target[:] = coordinates
                    send('/api/gaze/calibration/target', {'calibration_id': identifier, 'target_index': index})
                    began = clock()
                    for sample in range(12):
                        clock.value = began + .6 + sample * .21
                        controller.gaze_snapshot(identifier)
                    state = send('/api/gaze/state?calibration_id=' + identifier)
                    self.assertEqual(state['calibration']['completed_targets'], index + 1)
                state = send('/api/gaze/calibration/complete', {'calibration_id': identifier})
                self.assertEqual(state['calibration']['status'], 'ready')
                session = send('/api/sessions/start', {'task': 'Calibrated', 'mode': 'Math', 'camera': True})['active']
                clock.value += .2
                self.assertTrue(send('/api/gaze/state')['observation']['valid'])
                clock.value += 1
                finished = send('/api/sessions/end', {})['finished']
                report = send('/api/sessions/' + session['id'] + '/gaze')
                self.assertGreater(report['summary']['tracked'], 0)
                self.assertEqual(report['calibrations'][0]['id'], identifier)
                self.assertAlmostEqual(sum(i['end'] - i['start'] for i in report['intervals']), finished['elapsed'])
                rejected('/api/sessions/missing/gaze', None, 404)
            finally:
                server.shutdown(); thread.join(timeout=2); server.server_close(); controller.close()

    def test_anonymous_polling_does_not_extend_an_abandoned_calibration(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = Clock()
            controller = SessionController(Path(directory) / 'lease.sqlite3', FakeCamera(clock), clock, clock.wall)
            try:
                controller.start_preview()
                controller.calibration_action('start', {'display': DISPLAY})
                clock.value += 4
                state = controller.gaze_snapshot()
                self.assertEqual(state['calibration']['status'], 'uncalibrated')
                self.assertEqual(state['calibration']['reason'], 'calibration_abandoned')
            finally:
                controller.close()


if __name__ == '__main__':
    unittest.main()
