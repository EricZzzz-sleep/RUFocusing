"""Automatic sample cleanup preserves reports and actually reclaims disk space."""
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from core.features.feature_engine import Observation
from database.store import Store


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'sessions.sqlite3'
        self.store = Store(self.path)

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def seed(self, identifier='session'):
        self.store.create(identifier, 'Study', 'Reading', 'start', True)
        self.store.append(identifier, 0, 700, 'present', 'checkpoint',
                          Observation(700, True, 1),
                          [{'start': 0, 'end': 700, 'state': 'middle_center'}],
                          {'observation': {'x': .5, 'y': .5, 'region': 'middle_center',
                                           'reason': 'valid', 'calibration_id': None}, 'quality': 'good'})
        # Simulate a long recording without opening a camera or waiting in real time.
        with self.store.connection:
            self.store.connection.executemany(
                'INSERT INTO observations (session_id,elapsed,available,face_count,pitch) VALUES (?,?,1,1,45)',
                ((identifier, index / 20) for index in range(10000)))
            self.store.connection.executemany(
                "INSERT INTO gaze_observations (session_id,elapsed,x,y,reason,quality) VALUES (?,?,.5,.5,'valid','good')",
                ((identifier, index / 20) for index in range(10000)))

    def counts(self, identifier='session'):
        return [self.store.connection.execute(f'SELECT COUNT(*) FROM {table} WHERE session_id=?',
                                              (identifier,)).fetchone()[0]
                for table in ('observations', 'gaze_observations')]

    def test_finish_reclaims_space_preserves_reports_setup_and_other_session(self):
        self.seed()
        self.seed('other')
        self.store.save_gaze_setup({'id': 'setup', 'model_version': 'v1', 'display': {}, 'validation': {}}, 'session', 'now')
        before = self.store.get('session')
        gaze_before = self.store.gaze_details('session')
        size = self.path.stat().st_size
        self.store.set_status('session', 'completed', 'end')
        self.assertEqual(self.counts(), [0, 0])
        self.assertEqual(self.counts('other'), [10001, 10001])
        self.assertLess(self.path.stat().st_size, size)
        after = self.store.get('session')
        for key in ('timeline', 'totals', 'study_periods', 'gaze_summary'):
            self.assertEqual(after[key], before[key])
        self.assertEqual(self.store.gaze_details('session'), gaze_before)
        self.assertEqual(self.store.gaze_profile()['id'], 'setup')
        self.assertEqual(self.store.analysis('session')['study_periods']['totals']['deep'], 700)
        self.store.save_reflection('session', {'concentration': 4, 'flow': 'yes'})
        self.store.save_annotations('session', [{'start': 0, 'end': 600, 'kind': 'focused'}])
        report = self.store.analysis('session')
        self.store.close()
        self.store = Store(self.path)
        self.assertEqual(self.store.analysis('session'), report)
        self.assertFalse(self.store.connection.execute('PRAGMA foreign_key_check').fetchall())

    def test_restart_cleans_crashed_and_legacy_sessions(self):
        self.seed()
        self.seed('legacy')
        # An older app saved a completed session without the retention policy.
        with self.store.connection:
            self.store.connection.execute("UPDATE sessions SET status='completed' WHERE id='legacy'")
        before = self.store.get('session')['study_periods']
        self.store.close()
        self.store = Store(self.path)
        self.assertEqual(self.counts(), [0, 0])
        self.assertEqual(self.counts('legacy'), [0, 0])
        self.assertEqual(self.store.get('session')['status'], 'interrupted')
        self.assertEqual(self.store.get('session')['ended_at'], 'checkpoint')
        self.assertEqual(self.store.get('session')['study_periods'], before)
        self.assertEqual(self.store.get('legacy')['status'], 'completed')

    def test_pause_keeps_samples_and_failed_cleanup_rolls_back_finalization(self):
        self.seed()
        self.store.set_status('session', 'break')
        self.assertEqual(self.counts(), [10001, 10001])
        self.store.connection.execute("CREATE TRIGGER fail_cleanup BEFORE DELETE ON gaze_observations BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.set_status('session', 'completed', 'end')
        self.assertEqual(self.counts(), [10001, 10001])
        self.assertEqual(self.store.get('session')['status'], 'break')
        self.store.connection.execute('DROP TRIGGER fail_cleanup')
        self.store.set_status('session', 'interrupted', 'end')
        self.assertEqual(self.counts(), [0, 0])

    def test_compaction_failure_keeps_report_and_retries_on_restart(self):
        self.seed()
        size = self.path.stat().st_size
        with patch.object(self.store, 'compact', side_effect=sqlite3.OperationalError('disk full')):
            self.store.set_status('session', 'completed', 'end')
        self.assertEqual(self.counts(), [0, 0])
        self.assertEqual(self.store.get('session')['status'], 'completed')
        self.assertIn('could not be reclaimed', self.store.storage_summary()['warning'])
        report = self.store.analysis('session')
        self.store.close()
        self.store = Store(self.path)
        self.assertLess(self.path.stat().st_size, size)
        self.assertIsNone(self.store.storage_summary()['warning'])
        self.assertEqual(self.store.analysis('session'), report)


if __name__ == '__main__':
    unittest.main()
