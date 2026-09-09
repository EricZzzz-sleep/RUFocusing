"""Phase 1 checks use synthetic observations and temporary databases, never a webcam."""
from http.server import ThreadingHTTPServer
import json
import math
import multiprocessing
import os
import queue
import time
from types import SimpleNamespace
from unittest.mock import Mock, patch
from pathlib import Path
import tempfile
import threading
import subprocess
import sys
import unittest
import urllib.error
import urllib.request

from apps.vision.camera import Camera, LatestFrame, STARTUP_TIMEOUT, _capture, _publish
from apps.vision.pose import head_pose
from apps.vision.worker import make_handler
from core.behavior.rules import AwayDetector
from core.features.feature_engine import Observation
from core.session import SessionController


class Clock:
    value = 100.0
    def __call__(self):
        return self.value
    def wall(self):
        return 1_780_000_000 + self.value


class FakeCamera:
    def __init__(self, clock):
        self.clock = clock
        self.face_count = 1
        self.available = True
        self.started = False
        self.starts = 0
        self.stops = 0
        self.starting = False
    def start(self):
        self.starts += 1
        self.started = True
    def stop(self):
        self.started = False
        self.stops += 1
    def preview_frame(self):
        return b"jpeg-preview" if self.started and self.available else None
    def snapshot(self):
        status = 'off' if not self.started else 'starting' if self.starting else 'ready' if self.available else 'unavailable'
        return Observation(self.clock(), status == 'ready', self.face_count,
                           pitch=45 if self.face_count == 1 else None, camera_status=status)


class PreviewBufferTests(unittest.TestCase):
    def test_only_latest_frame_is_retained(self):
        output = LatestFrame(multiprocessing.get_context('spawn'))
        observation = Observation(time.monotonic(), True, 1)
        _publish(output, observation, b'old-frame')
        _publish(output, observation, b'new-frame')
        self.assertEqual(output.get_nowait()[1], b'new-frame')
        with self.assertRaises(queue.Empty):
            output.get_nowait()
        output.close()

    def test_stale_or_crashed_camera_clears_cached_frame(self):
        camera = Camera()
        camera.latest = Observation(time.monotonic() - 3, True, 1)
        camera.jpeg = b'stale'
        self.assertIsNone(camera.preview_frame())
        camera.latest = Observation(time.monotonic(), True, 1)
        camera.jpeg = b'last-frame'
        camera.process = SimpleNamespace(is_alive=lambda: False)
        self.assertIsNone(camera.preview_frame())
        self.assertFalse(camera.snapshot().available)


class CameraLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.camera = Camera(clock=self.clock)
        self.process = Mock()
        self.process.is_alive.return_value = True
        context = multiprocessing.get_context('spawn')
        self.camera.context = Mock(wraps=context)
        sender = Mock()
        sender.send_bytes.side_effect = lambda _data: setattr(self.process.is_alive, 'return_value', False)
        self.camera.context.Pipe.return_value = (Mock(), sender)
        self.camera.context.Process.return_value = self.process

    def tearDown(self):
        self.camera.stop()

    def test_start_ready_stale_recovery_and_stop_states(self):
        self.assertEqual(self.camera.snapshot().camera_status, 'off')
        self.camera.start()
        self.assertEqual(self.camera.snapshot().camera_status, 'starting')
        _publish(self.camera.output, Observation(self.clock(), True, 1, camera_status='ready'), b'frame')
        self.assertEqual(self.camera.snapshot().camera_status, 'ready')
        self.assertEqual(self.camera.preview_frame(), b'frame')
        self.clock.value += 3
        self.assertEqual(self.camera.snapshot().camera_status, 'unavailable')
        self.assertFalse(self.camera.snapshot().available)
        self.assertIsNone(self.camera.preview_frame())
        _publish(self.camera.output, Observation(self.clock(), True, 1, camera_status='ready'), b'fresh-frame')
        self.assertEqual(self.camera.snapshot().camera_status, 'ready')
        self.camera.stop()
        self.assertEqual(self.camera.snapshot().camera_status, 'off')
        self.assertIsNone(self.camera.preview_frame())
        self.process.close.assert_called_once()

    def test_startup_timeout_releases_process_and_allows_retry(self):
        self.camera.start()
        self.clock.value += STARTUP_TIMEOUT
        observation = self.camera.snapshot()
        self.assertEqual(observation.camera_status, 'unavailable')
        self.assertIn('Retry camera', observation.message)
        self.assertIsNone(self.camera.process)
        self.process.close.assert_called_once()
        self.process.is_alive.return_value = True
        self.camera.start()
        self.assertEqual(self.camera.snapshot().camera_status, 'starting')

    def test_process_start_failure_does_not_escape(self):
        self.process.start.side_effect = OSError('Cannot spawn process')
        self.process.is_alive.return_value = False
        with self.assertLogs(level='ERROR'):
            self.camera.start()
        self.assertEqual(self.camera.snapshot().camera_status, 'unavailable')
        self.assertIn('Retry camera', self.camera.snapshot().message)
        self.assertIsNone(self.camera.process)

    def test_native_crash_during_startup_is_actionable(self):
        self.camera.start()
        self.process.is_alive.return_value = False
        observation = self.camera.snapshot()
        self.assertEqual(observation.camera_status, 'unavailable')
        self.assertIn('Retry camera', observation.message)
        self.assertNotIn('restart the session', observation.message)

    def test_open_failure_and_model_failure_publish_actionable_status(self):
        cv2 = Mock()
        cv2.VideoCapture.return_value.isOpened.return_value = False
        stop = Mock()
        stop.is_set.return_value = False
        for model_failure in (False, True):
            with self.subTest(model_failure=model_failure), patch.dict('sys.modules', {'cv2': cv2}), patch('apps.vision.face.FaceDetector') as detector, self.assertLogs(level='ERROR'):
                if model_failure:
                    detector.side_effect = RuntimeError('Model unavailable')
                output = queue.Queue(maxsize=1)
                _capture(0, stop, output)
                observation, image = output.get_nowait()
                self.assertEqual(observation.camera_status, 'unavailable')
                self.assertFalse(observation.available)
                self.assertIn('Retry camera', observation.message)
                self.assertIsNone(image)
                if not model_failure:
                    self.assertIn('camera access', observation.message)
                    cv2.VideoCapture.return_value.release.assert_called_once()


class PresenceTests(unittest.TestCase):
    def test_away_requires_ten_seconds_of_valid_absence(self):
        detector = AwayDetector()
        self.assertEqual(detector.classify(Observation(0, True, 0), 0), 'unknown')
        self.assertEqual(detector.classify(Observation(9.9, True, 0), 9.9), 'unknown')
        self.assertEqual(detector.classify(Observation(10, True, 0), 10), 'away')
        self.assertEqual(detector.classify(Observation(11, True, 1), 11), 'present')
        self.assertEqual(detector.classify(Observation(12, True, 0), 12), 'unknown')

    def test_failed_stale_and_multiple_face_observations_reset_absence(self):
        for observation in [Observation(10, False, 0), Observation(0, True, 0), Observation(10, True, 2)]:
            detector = AwayDetector()
            detector.classify(Observation(0, True, 0), 0)
            self.assertEqual(detector.classify(observation, 10), 'unknown')
            self.assertEqual(detector.classify(Observation(11, True, 0), 11), 'unknown')

    def test_looking_down_is_not_away(self):
        self.assertEqual(AwayDetector().classify(Observation(1, True, 1, pitch=60), 1), 'present')

    def test_head_pose_identity_scale_and_rotation(self):
        self.assertEqual(head_pose([[2,0,0],[0,2,0],[0,0,2]]), {'pitch':0.0,'yaw':0.0,'roll':0.0})
        angle=math.radians(30)
        pose=head_pose([[math.cos(angle),0,math.sin(angle)],[0,1,0],[-math.sin(angle),0,math.cos(angle)]])
        self.assertAlmostEqual(pose['yaw'], 30)
        self.assertEqual(head_pose([[0,0,0],[0,0,0],[0,0,0]]), None)


def _crash_while_writing(_index, _stop, output):
    output.lock.acquire()
    os._exit(7)


def _synthetic_capture(_index, stop, output):
    try:
        while not stop.is_set():
            _publish(output, Observation(time.monotonic(), True, 1, camera_status='ready'), b'frame' * 12000)
            stop.wait(0.01)
    finally:
        stop.close()


def _exercise_real_process_recovery():
    """Actual spawned processes and IPC, synthetic frames, no physical webcam."""
    def wait_until(predicate):
        deadline = time.monotonic() + 4
        while not predicate():
            if time.monotonic() >= deadline:
                raise AssertionError('Process recovery timed out')
            time.sleep(0.02)

    with tempfile.TemporaryDirectory() as directory:
        camera = Camera()
        controller = SessionController(Path(directory) / 'sessions.sqlite3', camera)
        try:
            with patch('apps.vision.camera._capture', _crash_while_writing):
                session = controller.start('Crash regression', 'Math', True)
            wait_until(lambda: not camera.process.is_alive())
            failed = controller.snapshot()
            assert failed['observation']['camera_status'] == 'unavailable'
            assert failed['active']['totals']['unknown'] > 0
            with patch('apps.vision.camera._capture', _synthetic_capture):
                for _ in range(3):
                    before = controller.snapshot()['active']['elapsed']
                    controller.start_preview()
                    wait_until(lambda: controller.snapshot()['observation']['camera_status'] == 'ready')
                    current = controller.snapshot()
                    assert current['active']['id'] == session['id']
                    assert current['active']['elapsed'] >= before
                    assert controller.preview_frame() == b'frame' * 12000
                    camera.process.terminate()
                    camera.process.join(timeout=1)
                    assert controller.snapshot()['observation']['camera_status'] == 'unavailable'
                controller.start_preview()
                wait_until(lambda: controller.snapshot()['observation']['camera_status'] == 'ready')
                controller.pause()
                assert camera.process is None
                controller.resume()
                wait_until(lambda: controller.snapshot()['observation']['camera_status'] == 'ready')
                completed = controller.finish()
                assert completed['id'] == session['id']
                assert abs(sum(completed['totals'].values()) - completed['elapsed']) < 0.001
                assert camera.process is None
        finally:
            controller.close()


class ProcessRecoveryTests(unittest.TestCase):
    def test_dead_writer_and_repeated_termination_cannot_block_retry(self):
        # Isolate the regression so a future IPC deadlock fails with a deadline
        # instead of hanging the test runner. Nested workers never open cameras.
        env = dict(os.environ, PYTHONPATH=os.pathsep.join((str(Path(__file__).parent), str(Path(__file__).resolve().parents[1]))))
        result = subprocess.run([sys.executable, '-c', 'from test_phase1 import _exercise_real_process_recovery; _exercise_real_process_recovery()'],
                                env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'sessions.sqlite3'
        self.clock = Clock()
        self.camera = FakeCamera(self.clock)
        self.controller = SessionController(self.path, self.camera, self.clock, self.clock.wall)

    def tearDown(self):
        self.controller.close()
        self.temp.cleanup()

    def advance(self, seconds):
        for _ in range(seconds):
            self.clock.value += 1
            self.controller.snapshot()

    def assert_timeline(self, session):
        offset = 0
        for interval in session['timeline']:
            self.assertAlmostEqual(interval['start'], offset)
            self.assertGreater(interval['end'], interval['start'])
            offset = interval['end']
        self.assertAlmostEqual(offset, session['elapsed'])
        self.assertAlmostEqual(sum(session['totals'].values()), session['elapsed'])

    def test_setup_preview_does_not_create_a_session_or_persist_images(self):
        self.controller.start_preview()
        self.assertTrue(self.camera.started)
        self.assertIsNone(self.controller.snapshot()['active'])
        self.assertEqual(self.controller.preview_frame(), b'jpeg-preview')
        self.assertEqual(self.controller.store.connection.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)
        self.assertEqual(self.controller.store.connection.execute('SELECT COUNT(*) FROM observations').fetchone()[0], 0)
        self.controller.stop_preview()
        self.assertFalse(self.camera.started)
        self.assertIsNone(self.controller.preview_frame())

    def test_retry_restarts_a_stale_camera(self):
        self.controller.start_preview()
        starts = self.camera.starts
        self.camera.snapshot = lambda: Observation(self.clock() - 3, True, 1)
        self.controller.start_preview()
        self.assertEqual(self.camera.starts, starts + 1)

    def test_repeated_retry_and_session_start_reuse_starting_camera(self):
        self.camera.starting = True
        self.controller.start_preview()
        self.assertEqual(self.controller.snapshot()['observation']['camera_status'], 'starting')
        for _ in range(5):
            self.controller.start_preview()
        self.assertEqual(self.camera.starts, 1)
        original = self.controller.start('Warmup', 'Reading', True)
        self.assertEqual(self.camera.starts, 1)
        self.advance(2)
        self.assertEqual(self.controller.snapshot()['active']['totals']['unknown'], 2)
        self.camera.starting = False
        self.assertEqual(self.controller.snapshot()['observation']['camera_status'], 'ready')
        self.advance(3)
        result = self.controller.finish()
        self.assertEqual(result['id'], original['id'])
        self.assertEqual(result['elapsed'], 5)
        self.assertEqual(result['totals']['present'], 3)
        self.assert_timeline(result)

    def test_retry_preserves_timeline_and_failure_time_is_unknown(self):
        original = self.controller.start('Recovery', 'Coding', True)
        self.advance(4)
        before = self.controller.snapshot()['active']
        self.camera.available = False
        self.controller.snapshot()
        self.advance(5)
        failed = self.controller.snapshot()
        self.assertEqual(failed['observation']['camera_status'], 'unavailable')
        self.assertEqual(failed['active']['totals']['present'], before['totals']['present'])
        self.assertEqual(failed['active']['totals']['unknown'], before['totals']['unknown'] + 5)
        self.camera.available = True
        self.controller.start_preview()
        retried = self.controller.snapshot()['active']
        self.assertEqual(retried['id'], original['id'])
        self.assertEqual(retried['elapsed'], 9)
        self.assertEqual(retried['timeline'][:len(before['timeline'])], before['timeline'])
        self.advance(3)
        result = self.controller.finish()
        self.assertEqual(result['elapsed'], 12)
        self.assertEqual(result['totals']['present'], before['totals']['present'] + 3)
        self.assertEqual(len(self.controller.snapshot()['history']), 1)
        self.assert_timeline(result)

    def test_failed_spawn_keeps_timer_and_can_retry_same_session(self):
        with patch.object(self.camera, 'start', side_effect=OSError('Cannot start camera')):
            original = self.controller.start('Failed camera', 'Lecture', True)
            self.assertEqual(self.controller.snapshot()['observation']['camera_status'], 'unavailable')
            self.advance(4)
        self.controller.start_preview()
        state = self.controller.snapshot()
        self.assertEqual(state['observation']['camera_status'], 'ready')
        self.assertEqual(state['active']['id'], original['id'])
        self.assertEqual(state['active']['totals']['unknown'], 4)
        self.advance(2)
        result = self.controller.finish()
        self.assertEqual(result['totals']['present'], 2)
        self.assert_timeline(result)

    def test_healthy_retry_does_not_restart_camera(self):
        self.controller.start('Healthy camera', 'Math', True)
        for _ in range(5):
            self.controller.start_preview()
        self.assertEqual(self.camera.starts, 1)

    def test_abandoned_setup_preview_expires(self):
        self.controller.start_preview()
        self.clock.value += 7
        self.assertEqual(self.controller.preview_frame(), b'jpeg-preview')
        self.clock.value += 7
        self.assertTrue(self.controller.snapshot()['preview_active'])
        self.clock.value += 2
        self.assertFalse(self.controller.snapshot()['preview_active'])
        self.assertFalse(self.camera.started)

    def test_closing_preview_keeps_active_tracking_and_break_stops_frames(self):
        self.controller.start_preview()
        stops = self.camera.stops
        self.controller.start('Math', 'Math', True)
        self.assertEqual(self.camera.stops, stops)
        self.controller.stop_preview()
        self.assertTrue(self.camera.started)
        self.assertEqual(self.controller.preview_frame(), b'jpeg-preview')
        self.controller.pause()
        self.assertIsNone(self.controller.preview_frame())
        with self.assertRaises(ValueError): self.controller.start_preview()
        self.controller.resume()
        self.controller.finish()
        self.assertIsNone(self.controller.preview_frame())

    def test_timer_only_break_resume_finish_and_reopen(self):
        self.controller.start('Reading', 'Reading', False)
        self.advance(3)
        self.controller.pause()
        self.advance(2)
        self.controller.resume()
        self.advance(4)
        session = self.controller.finish()
        self.assertEqual(session['elapsed'], 9)
        self.assertEqual(session['totals'], {'present':0, 'away':0, 'break':2, 'unknown':7})
        self.assertFalse(self.camera.started)
        self.assert_timeline(session)
        self.controller.close()
        self.controller = SessionController(self.path, self.camera, self.clock, self.clock.wall)
        self.assertEqual(self.controller.snapshot()['history'][0], session)

    def test_observations_persist_and_camera_failure_is_unknown(self):
        self.controller.start('Math', 'Math', True)
        self.advance(4)
        self.assertEqual(self.controller.snapshot()['state'], 'present')
        self.camera.available = False
        self.advance(3)
        session = self.controller.finish()
        self.assertEqual(session['totals']['away'], 0)
        self.assertGreater(session['totals']['unknown'], 0)
        self.assert_timeline(session)
        columns = {row[1] for row in self.controller.store.connection.execute('PRAGMA table_info(observations)')}
        self.assertEqual(columns, {'id','session_id','elapsed','available','face_count','pitch','yaw','roll'})
        self.assertGreater(self.controller.store.connection.execute('SELECT COUNT(*) FROM observations').fetchone()[0], 0)

    def test_break_releases_camera_and_resume_restarts(self):
        self.controller.start('Math', 'Math', True)
        self.assertTrue(self.camera.started)
        self.controller.pause()
        self.assertFalse(self.camera.started)
        self.controller.resume()
        self.assertTrue(self.camera.started)
        self.controller.finish()
        self.assertFalse(self.camera.started)

    def test_long_unobserved_gap_does_not_inherit_presence(self):
        self.controller.start('Math', 'Math', True)
        self.advance(2)
        self.clock.value += 20
        session = self.controller.snapshot()['active']
        self.assertEqual(session['timeline'][-1]['state'], 'unknown')
        self.assertEqual(session['timeline'][-1]['end'] - session['timeline'][-1]['start'], 20)
        self.assert_timeline(session)

    def test_unclean_restart_ends_at_last_saved_checkpoint(self):
        original = self.controller.start('Math', 'Math', False)
        self.advance(3)
        # Simulate abrupt exit without controller.finish().
        self.controller.store.close()
        self.clock.value += 100
        self.controller = SessionController(self.path, self.camera, self.clock, self.clock.wall)
        state = self.controller.snapshot()
        self.assertIsNone(state['active'])
        self.assertEqual(state['history'][0]['id'], original['id'])
        self.assertEqual(state['history'][0]['status'], 'interrupted')
        self.assertEqual(state['history'][0]['elapsed'], 3)
        self.assertEqual(state['history'][0]['ended_at'], state['history'][0]['checkpoint_at'])

    def test_invalid_actions_and_duplicate_sessions(self):
        for task,mode,camera in [('', 'Math', False),('x'*201,'Math',False),('Task','Invalid',False),('Task','Math','yes')]:
            with self.assertRaises(ValueError):
                self.controller.start(task,mode,camera)
        with self.assertRaises(ValueError): self.controller.pause()
        with self.assertRaises(ValueError): self.controller.finish()
        self.controller.start('Math','Math',False)
        with self.assertRaises(ValueError): self.controller.start('Other','Coding',False)
        with self.assertRaises(ValueError): self.controller.resume()

    def test_zero_duration_session_is_valid(self):
        self.controller.start('Math','Math',False)
        session=self.controller.finish()
        self.assertEqual(session['elapsed'], 0)
        self.assertEqual(session['timeline'], [])
        self.assert_timeline(session)

    def test_empty_history(self):
        state=self.controller.snapshot()
        self.assertIsNone(state['active'])
        self.assertEqual(state['history'], [])


class ApiTests(unittest.TestCase):
    setUp = SessionTests.setUp
    tearDown = SessionTests.tearDown
    advance = SessionTests.advance
    def test_api_round_trip_and_request_validation(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.controller))
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        def send(path, data=None, headers=None):
            request=urllib.request.Request(base+path, data=json.dumps(data).encode() if data is not None else None,
                headers=headers or {'Content-Type':'application/json','X-RUFocusing':'1'})
            return json.load(urllib.request.urlopen(request))
        try:
            self.assertTrue(send('/api/health')['ok'])
            preview_state = send('/api/camera/preview/start', {})
            self.assertIsNone(preview_state['active'])
            self.assertEqual(preview_state['observation']['camera_status'], 'ready')
            with urllib.request.urlopen(urllib.request.Request(base+'/api/camera/preview', headers={'X-RUFocusing':'1'})) as image:
                self.assertEqual(image.headers['Content-Type'], 'image/jpeg')
                self.assertEqual(image.headers['Cache-Control'], 'no-store, max-age=0')
                self.assertEqual(image.read(), b'jpeg-preview')
            with self.assertRaises(urllib.error.HTTPError) as blocked:
                urllib.request.urlopen(base+'/api/camera/preview')
            self.assertEqual(blocked.exception.code, 403)
            blocked.exception.close()
            self.assertEqual(send('/api/camera/preview/stop', {})['observation']['camera_status'], 'off')
            state=send('/api/sessions/start',{'task':'Test session','mode':'Coding','camera':False})
            self.assertEqual(state['active']['task'],'Test session')
            self.advance(2)
            result=send('/api/sessions/end',{})
            self.assertIsNone(result['active'])
            self.assertEqual(result['finished']['elapsed'],2)
            with self.assertRaises(urllib.error.HTTPError) as missing:
                send('/api/sessions/start',{}, {'Content-Type':'application/json'})
            self.assertEqual(missing.exception.code,403)
            missing.exception.close()
            with self.assertRaises(urllib.error.HTTPError) as origin:
                send('/api/state',headers={'Origin':'https://unrelated.example'})
            self.assertEqual(origin.exception.code,403)
            origin.exception.close()
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()


if __name__ == '__main__':
    unittest.main()
