"""Synthetic evidence only: these tests do not measure mental states or gaze accuracy."""
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from apps.vision.worker import make_handler
from core.analytics.study_patterns import analyze_session, validate_annotations, validate_reflection
from core.session import SessionController
from database.store import Store
from test_phase1 import Clock, FakeCamera
from test_gaze import DISPLAY, calibrate, observation


def session(*segments):
    timeline, end = [], 0
    for state, seconds in segments:
        timeline.append({'start': end, 'end': end + seconds, 'state': state})
        end += seconds
    return {'id': 'study', 'elapsed': end, 'timeline': timeline}


class PatternTests(unittest.TestCase):
    def test_threshold_and_adjacent_presence(self):
        for seconds, count in ((0, None), (599.999, 0), (600, 1), (600.001, 1)):
            with self.subTest(seconds=seconds):
                result = analyze_session(session(('present', seconds)))
                self.assertEqual(result['summary']['sustained_count'], count)
        result = analyze_session(session(('present', 300), ('present', 300)))
        self.assertEqual(result['summary']['sustained_seconds'], 600)
        self.assertEqual(result['summary']['longest_sustained'], 600)

    def test_every_nonpresence_state_splits_sustained_periods(self):
        for state in ('away', 'unknown', 'break'):
            result = analyze_session(session(('present', 600), (state, 1), ('present', 600)))
            self.assertEqual(result['summary']['sustained_count'], 2)
            self.assertEqual(result['summary']['longest_sustained'], 600)
        value = session(('present', 1300))
        result = analyze_session(value, [{'start': 600, 'end': 700, 'kind': 'check'}])
        self.assertEqual(result['summary']['sustained_count'], 2)
        self.assertEqual(result['summary']['eligible_seconds'], 1200)
        self.assertEqual(result['summary']['sustained_seconds'], 1200)
        self.assertEqual(value, session(('present', 1300)))

    def test_away_episodes_do_not_backfill_unknown_or_cross_diagnostics(self):
        result = analyze_session(session(('unknown', 10), ('away', 30), ('break', 10), ('away', 20)),
                                 [{'start': 20, 'end': 30, 'kind': 'calibration'}])
        self.assertEqual([(row['start'], row['end']) for row in result['interruptions']], [(10, 20), (30, 40), (50, 70)])
        self.assertEqual(result['summary']['interruption_seconds'], 40)
        self.assertEqual(result['summary']['observation_coverage'], 40 / 50)

    def test_unknown_gaps_zero_timer_only_and_incomplete_provenance(self):
        value = session(('present', 1200))
        value['timeline'] = [{'start': 0, 'end': 599, 'state': 'present'}, {'start': 600, 'end': 1200, 'state': 'present'}]
        result = analyze_session(value)
        self.assertEqual(result['summary']['sustained_count'], 1)
        self.assertEqual(result['intervals'][1], {'start': 599, 'end': 600, 'state': 'unknown'})
        for value, reason, coverage in ((session(), 'no_eligible_study_time', None),
                                        (session(('unknown', 600)), 'no_presence_observations', 0)):
            summary = analyze_session(value)['summary']
            self.assertIn(reason, summary['availability']['reasons'])
            self.assertIsNone(summary['sustained_count'])
            self.assertEqual(summary['observation_coverage'], coverage)
        result = analyze_session(session(('present', 700)), provenance_reason='historical_diagnostic_boundaries_missing')
        self.assertFalse(result['summary']['availability']['available'])
        self.assertIsNone(result['summary']['eligible_seconds'])
        self.assertEqual(result['sustained_periods'], [])

    def test_gaze_never_assigns_mental_states_and_ratings_do_not_label_minutes(self):
        value = session(('present', 1200), ('unknown', 600))
        expected = analyze_session(value)
        for gaze in ('looking_down', 'outside_display', 'uncalibrated', 'camera_failure', 'top_left', 'middle_center'):
            value['gaze_summary'] = {'reason': gaze}
            self.assertEqual(analyze_session(value), expected)
        result = analyze_session(value, reflection={'concentration': 5, 'distraction': 1, 'flow': 'yes'})
        self.assertEqual(result['annotations'], [])
        self.assertEqual(result['summary']['tagged_seconds'], {'focused': 0, 'distracted': 0, 'flow': 0})

    def test_reflection_and_tag_validation_and_sustained_self_report(self):
        self.assertEqual(validate_reflection({}), {'concentration': None, 'distraction': None, 'flow': None})
        for bad in ({'concentration': True}, {'concentration': 2.5}, {'distraction': 0}, {'flow': 'maybe'}, {'score': 99}):
            with self.assertRaises(ValueError): validate_reflection(bad)
        value = session(('unknown', 1200), ('break', 100), ('present', 600))
        tags = [{'start': 0, 'end': 600, 'kind': 'focused'}, {'start': 600, 'end': 1200, 'kind': 'flow'}]
        self.assertEqual(validate_annotations(tags, value['elapsed'], value['timeline'], []), tags)
        result = analyze_session(value, annotations=tags)
        self.assertEqual(result['summary']['self_reported_sustained_seconds'], 1200)
        self.assertEqual(result['intervals'][0]['state'], 'unknown')
        for bad in ([{'start': -1, 'end': 10, 'kind': 'flow'}], [{'start': 0, 'end': 0, 'kind': 'flow'}],
                    [{'start': True, 'end': 10, 'kind': 'flow'}], [{'start': 0, 'end': float('nan'), 'kind': 'flow'}],
                    [{'start': 0, 'end': 2000, 'kind': 'flow'}], [{'start': 1200, 'end': 1250, 'kind': 'flow'}],
                    [{'start': 0, 'end': 10, 'kind': 'focused'}] * 2):
            with self.assertRaises(ValueError): validate_annotations(bad, value['elapsed'], value['timeline'], [])
        with self.assertRaises(ValueError): validate_annotations(tags, value['elapsed'], [], [{'start': 10, 'end': 20}])
        self.assertEqual(analyze_session(value, annotations=[{'start': 0, 'end': 599.99, 'kind': 'flow'}])['summary']['self_reported_sustained_seconds'], 0)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'study.sqlite3'
        self.store = Store(self.path)
        self.store.create('study', 'Paper reading', 'Reading', '2026-09-11T03:59:00Z', False)
        self.store.append('study', 0, 1200, 'unknown', '2026-09-11T04:19:00Z')
        self.store.set_status('study', 'completed', '2026-09-11T04:19:00Z')

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def test_replace_retries_clearing_reopening_and_unchanged_observations(self):
        original = self.store.get('study')
        reflection = {'concentration': 4, 'distraction': None, 'flow': 'unsure'}
        first = self.store.save_reflection('study', reflection)
        self.assertEqual(self.store.save_reflection('study', reflection), first)
        tags = [{'start': 10, 'end': 700, 'kind': 'flow'}]
        first = self.store.save_annotations('study', tags)
        self.assertEqual(self.store.save_annotations('study', tags), first)
        self.assertEqual(self.store.get('study')['timeline'], original['timeline'])
        self.assertEqual(self.store.get('study')['analysis_summary'], first['summary'])
        self.store.close(); self.store = Store(self.path)
        self.assertEqual(self.store.analysis('study'), first)
        self.store.save_reflection('study', {})
        self.assertIsNone(self.store.analysis('study')['reflection']['flow'])
        self.assertEqual(self.store.save_annotations('study', [])['annotations'], [])

    def test_active_session_rejected_and_failed_replace_rolls_back(self):
        self.store.create('active', 'Task', 'Math', '2026-09-11', False)
        with self.assertRaises(ValueError): self.store.save_reflection('active', {})
        with self.assertRaises(ValueError): self.store.save_annotations('active', [])
        old = [{'start': 0, 'end': 100, 'kind': 'focused'}]
        self.store.save_annotations('study', old)
        self.store.connection.execute("CREATE TRIGGER fail_tag BEFORE INSERT ON session_annotations BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
        with self.assertRaises(sqlite3.IntegrityError): self.store.save_annotations('study', [{'start': 200, 'end': 400, 'kind': 'flow'}])
        self.assertEqual(self.store.analysis('study')['annotations'], old)
        self.assertEqual(self.store.get('study')['status'], 'completed')

    def test_crash_recovers_open_exclusion_at_checkpoint(self):
        self.store.create('active', 'Task', 'Math', '2026-09-11', True)
        self.store.append('active', 0, 100, 'present', '2026-09-11')
        self.store.save_exclusions([{'run_id': 'open', 'session_id': 'active', 'kind': 'check', 'start': 60, 'end': None}])
        self.store.close(); self.store = Store(self.path)
        result = self.store.analysis('active')
        self.assertEqual(result['exclusions'][0]['end'], 100)
        self.assertEqual(result['summary']['eligible_seconds'], 60)
        self.assertEqual(self.store.get('active')['status'], 'interrupted')


class MigrationTests(unittest.TestCase):
    def make_v3(self, path):
        db = sqlite3.connect(path)
        db.executescript(''.join(Path('database', name).read_text() for name in ('schema.sql', 'gaze_v2.sql', 'diagnostics_v3.sql')))
        for identifier, status in (('clean', 'completed'), ('old', 'interrupted'), ('active', 'running')):
            db.execute('INSERT INTO sessions (id,task,mode,started_at,checkpoint_at,status,camera_enabled,elapsed) VALUES (?,?,?,?,?,?,?,?)',
                       (identifier, identifier, 'Math', '2026-09-11', '2026-09-11', status, 1, 1200))
            db.execute('INSERT INTO timeline (session_id,start,end,state) VALUES (?,0,1200,\'present\')', (identifier,))
        db.execute("INSERT INTO diagnostic_runs VALUES ('check','check','old',NULL,'failed','{}')")
        db.commit(); db.close()

    def test_populated_v3_preserved_with_explicit_historical_availability(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'db'; self.make_v3(path)
            store = Store(path)
            self.assertEqual(store.connection.execute('PRAGMA user_version').fetchone()[0], 4)
            self.assertEqual(store.analysis('clean')['summary']['sustained_seconds'], 1200)
            self.assertEqual(store.analysis('old')['summary']['availability']['reasons'], ['historical_diagnostic_boundaries_missing'])
            self.assertIn('upgrade_during_session', store.analysis('active')['summary']['availability']['reasons'])
            self.assertEqual(store.save_reflection('old', {'flow': 'yes'})['reflection']['flow'], 'yes')
            self.assertEqual(len(store.history()), 3)
            store.close(); store = Store(path)
            self.assertEqual(store.analysis('old')['reflection']['flow'], 'yes'); store.close()

    def test_v4_migration_failure_is_transactional(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'db'; self.make_v3(path)
            read = Path.read_text
            def broken(file, *args, **kwargs):
                return read(file, *args, **kwargs) + ('\nINVALID SQL;' if file.name == 'study_patterns_v4.sql' else '')
            with patch.object(Path, 'read_text', broken), self.assertRaises(sqlite3.OperationalError): Store(path)
            db = sqlite3.connect(path)
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 3)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 3)
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='session_reflections'").fetchone()); db.close()


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.clock = Clock(); self.camera = FakeCamera(self.clock)
        self.camera.snapshot = lambda: observation(self.clock()) if self.camera.started else FakeCamera.snapshot(self.camera)
        self.c = SessionController(Path(self.temp.name) / 'db', self.camera, self.clock, self.clock.wall)
        self.identifier = self.c.start('Sustained study', 'Reading', True)['id']

    def tearDown(self):
        self.c.close(); self.temp.cleanup()

    def test_calibration_cancel_break_toggle_and_finish_boundaries(self):
        for action in ('reset', 'pause', 'off', 'finish'):
            self.c.calibration_action('start', {'display': DISPLAY})
            start = self.c.elapsed
            self.clock.value += 2
            if action == 'reset': self.c.calibration_action('reset', {'calibration_id': self.c.gaze.identifier})
            elif action == 'pause': self.c.pause()
            elif action == 'off': self.c.set_camera(False)
            else: self.c.finish('interrupted')
            rows = self.c.store.exclusions(self.identifier)
            self.assertAlmostEqual(rows[-1]['start'], start)
            self.assertAlmostEqual(rows[-1]['end'], start + 2)
            if action == 'pause': self.c.resume()
            if action == 'off': self.c.set_camera(True)
        self.assertEqual(self.c.store.get(self.identifier)['elapsed'], 8)

    def test_failed_check_and_boundary_write_failure_preserve_first_start(self):
        self.clock.value = calibrate(self.c.gaze, self.clock())
        self.c.store.save_calibration(self.c.gaze.record(), self.identifier, '2026-09-11')
        with patch.object(self.c.store, 'save_exclusions', side_effect=sqlite3.OperationalError('busy')):
            with self.assertRaises(sqlite3.OperationalError): self.c.diagnostic_action('checks', 'start', {'display': DISPLAY, 'request_id': 'check'})
        run = self.c.diagnostics.check
        captured_start = self.c.exclusion_rows[run['id']]['start']
        self.clock.value += 1
        self.c.diagnostic_action('checks', 'cancel', {'id': run['id']})
        row = self.c.store.exclusions(self.identifier)[0]
        self.assertEqual(row['start'], captured_start)
        self.assertAlmostEqual(row['end'] - row['start'], 1)
        self.assertEqual(self.c.active_id, self.identifier)

    def test_api_security_saved_only_idempotence_and_summary_consistency(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.c))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def send(path, body=None, headers=None):
            request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}' + path,
                data=json.dumps(body).encode() if body is not None else None,
                headers=headers or {'Content-Type': 'application/json', 'X-RUFocusing': '1'})
            with urllib.request.urlopen(request) as response: return json.load(response)
        prefix = '/api/sessions/' + self.identifier
        try:
            for path, body, headers, code in ((prefix + '/analysis', None, None, 400),
                    (prefix + '/reflection', {}, None, 400),
                    (prefix + '/reflection', {}, {'Content-Type': 'application/json'}, 403),
                    (prefix + '/annotations', {'annotations': []}, {'Content-Type': 'application/json', 'X-RUFocusing': '1', 'Origin': 'https://example.com'}, 403),
                    (prefix + '/reflection', {'extra': 'x' * 5000}, None, 400)):
                with self.assertRaises(urllib.error.HTTPError) as error: send(path, body, headers)
                self.assertEqual(error.exception.code, code); error.exception.close()
            self.clock.value += 2; self.c.finish()
            result = send(prefix + '/reflection', {'concentration': 5, 'flow': 'yes'})
            self.assertEqual(send(prefix + '/reflection', {'concentration': 5, 'flow': 'yes'}), result)
            result = send(prefix + '/annotations', {'annotations': [{'start': 0, 'end': 1, 'kind': 'focused'}]})
            self.assertEqual(send(prefix + '/analysis'), result)
            self.assertEqual(send('/api/state')['history'][0]['analysis_summary'], result['summary'])
            self.assertEqual(send('/api/health')['api_version'], 4)
        finally:
            server.shutdown(); server.server_close(); thread.join()
