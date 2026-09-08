"""Phase 1 checks use synthetic observations and temporary databases, never a webcam."""
from datetime import datetime
from http.server import ThreadingHTTPServer
import json
import math
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

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
        self.stops = 0
    def start(self):
        self.started = True
    def stop(self):
        self.started = False
        self.stops += 1
    def snapshot(self):
        return Observation(self.clock(), self.available and self.started, self.face_count,
                           pitch=45 if self.face_count == 1 else None)


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


class ApiTests(SessionTests):
    # Reuse only setup and teardown, not the inherited test methods.
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
            state=send('/api/sessions/start',{'task':'Test session','mode':'Coding','camera':False})
            self.assertEqual(state['active']['task'],'Test session')
            self.advance(2)
            result=send('/api/sessions/end',{})
            self.assertIsNone(result['active'])
            self.assertEqual(result['finished']['elapsed'],2)
            with self.assertRaises(urllib.error.HTTPError) as missing:
                send('/api/sessions/start',{}, {'Content-Type':'application/json'})
            self.assertEqual(missing.exception.code,403)
            with self.assertRaises(urllib.error.HTTPError) as origin:
                send('/api/state',headers={'Origin':'https://unrelated.example'})
            self.assertEqual(origin.exception.code,403)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()


if __name__ == '__main__':
    unittest.main()
