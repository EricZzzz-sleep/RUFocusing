"""SQLite storage. The session controller serializes all access."""
from pathlib import Path
import sqlite3
import json
from core.analytics.focus_blocks import summarize_timeline
from core.analytics.study_patterns import analyze_session, validate_reflection, validate_annotations


class Store:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        version = self.connection.execute("PRAGMA user_version").fetchone()[0]
        if version > 5:
            self.connection.close()
            raise RuntimeError("This database was created by a newer application version.")
        self.connection.execute('PRAGMA foreign_keys = ON')
        if version < 5:
            base = Path(__file__).with_name('schema.sql').read_text() if version == 0 else ''
            migration = '\n'.join(Path(__file__).with_name(name).read_text() for target, name in
                                  ((2, 'gaze_v2.sql'), (3, 'diagnostics_v3.sql'), (4, 'study_patterns_v4.sql'), (5, 'gaze_profile_v5.sql')) if version < target)
            try:
                self.connection.executescript('BEGIN IMMEDIATE;\n' + base + migration + '\nCOMMIT;')
            except Exception:
                self.connection.rollback()
                self.connection.close()
                raise
        # End an uncleanly closed session at its last persisted checkpoint.
        with self.connection:
            self.connection.execute('UPDATE diagnostic_exclusions SET start=MIN(start,(SELECT elapsed FROM sessions WHERE id=session_id)), end=(SELECT elapsed FROM sessions WHERE id=session_id) WHERE end IS NULL')
            self.connection.execute("UPDATE sessions SET status='interrupted', ended_at=checkpoint_at WHERE status IN ('running','break')")

        for row in self.connection.execute("SELECT id FROM diagnostic_runs WHERE status IN ('running','awaiting_initial')").fetchall():
            record = self.diagnostic(row[0])
            record.update(status='interrupted', reason='application_restarted', collecting=False)
            for checkpoint in record.get('checkpoints', {}).values():
                if checkpoint['status'] in ('pending', 'dismissed', 'checking'):
                    checkpoint['status'] = 'missed'
            self.save_diagnostic(record)

    def save_diagnostic(self, record):
        metadata = {key: value for key, value in record.items() if key != 'targets'}
        with self.connection:
            self.connection.execute('INSERT INTO diagnostic_runs VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, calibration_id=excluded.calibration_id, status=excluded.status, record_json=excluded.record_json',
                (record['id'], record['kind'], record['session_id'], record['calibration_id'], record['status'], json.dumps(metadata, allow_nan=False)))
            self.connection.execute('DELETE FROM diagnostic_targets WHERE run_id=?', (record['id'],))
            self.connection.executemany('INSERT INTO diagnostic_targets VALUES (?,?,?)',
                [(record['id'], i, json.dumps(target, allow_nan=False)) for i, target in enumerate(record['targets'])])
            self.connection.execute('DELETE FROM diagnostic_durations WHERE run_id=?', (record['id'],))
            buckets = [(-1, record['durations'])] + [(bucket['index'], bucket['durations']) for bucket in record.get('buckets', [])]
            self.connection.executemany('INSERT INTO diagnostic_durations VALUES (?,?,?,?)',
                [(record['id'], index, reason, seconds) for index, durations in buckets for reason, seconds in durations.items()])

    def diagnostic(self, identifier):
        row = self.connection.execute('SELECT record_json FROM diagnostic_runs WHERE id=?', (identifier,)).fetchone()
        if not row:
            return None
        result = json.loads(row[0])
        result['targets'] = [json.loads(item[0]) for item in self.connection.execute('SELECT result_json FROM diagnostic_targets WHERE run_id=? ORDER BY target_index', (identifier,))]
        return result

    def diagnostics(self, session_id=None, limit=50):
        query = 'SELECT id FROM diagnostic_runs'
        args = ()
        if session_id is not None:
            query += ' WHERE session_id=?'
            args = (session_id,)
        query += ' ORDER BY rowid DESC LIMIT ?'
        args = (*args, limit)
        return [self.diagnostic(row[0]) for row in self.connection.execute(query, args).fetchall()]

    def create(self, identifier, task, mode, started_at, camera_enabled):
        with self.connection:
            self.connection.execute("INSERT INTO sessions (id,task,mode,started_at,checkpoint_at,status,camera_enabled) VALUES (?,?,?,?,?,'running',?)",
                                    (identifier, task, mode, started_at, started_at, int(camera_enabled)))
            self.connection.execute('INSERT INTO analysis_provenance VALUES (?,NULL)', (identifier,))

    def save_exclusions(self, rows):
        with self.connection:
            self.connection.executemany('INSERT INTO diagnostic_exclusions (run_id,session_id,kind,start,end) VALUES (:run_id,:session_id,:kind,:start,:end) ON CONFLICT(run_id) DO UPDATE SET end=excluded.end', rows)

    def exclusions(self, identifier):
        return [dict(row) for row in self.connection.execute('SELECT run_id,kind,start,end FROM diagnostic_exclusions WHERE session_id=? ORDER BY start', (identifier,))]

    def _analysis(self, session):
        identifier = session['id']
        provenance = self.connection.execute('SELECT reason FROM analysis_provenance WHERE session_id=?', (identifier,)).fetchone()
        reflection = self.connection.execute('SELECT concentration,distraction,flow FROM session_reflections WHERE session_id=?', (identifier,)).fetchone()
        annotations = [dict(row) for row in self.connection.execute('SELECT start,end,kind FROM session_annotations WHERE session_id=? ORDER BY position', (identifier,))]
        return analyze_session(session, self.exclusions(identifier), provenance['reason'] if provenance else 'exclusion_provenance_missing',
                               dict(reflection) if reflection else None, annotations)

    def analysis(self, identifier):
        session = self.get(identifier, include_analysis=False)
        if session is None:
            return None
        if session['status'] not in ('completed', 'interrupted'):
            raise ValueError('Save the session before opening its study-pattern report.')
        return self._analysis(session)

    def save_reflection(self, identifier, data):
        if self.analysis(identifier) is None:
            raise ValueError('Saved session not found.')
        reflection = validate_reflection(data)
        with self.connection:
            self.connection.execute('INSERT INTO session_reflections VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET concentration=excluded.concentration, distraction=excluded.distraction, flow=excluded.flow',
                                    (identifier, reflection['concentration'], reflection['distraction'], reflection['flow']))
        return self.analysis(identifier)

    def save_annotations(self, identifier, data):
        analysis = self.analysis(identifier)
        if analysis is None:
            raise ValueError('Saved session not found.')
        session = self.get(identifier, include_analysis=False)
        annotations = validate_annotations(data, session['elapsed'], session['timeline'], analysis['exclusions'])
        with self.connection:
            self.connection.execute('DELETE FROM session_annotations WHERE session_id=?', (identifier,))
            self.connection.executemany('INSERT INTO session_annotations VALUES (?,?,?,?,?)',
                                        [(identifier, index, row['start'], row['end'], row['kind']) for index, row in enumerate(annotations)])
        return self.analysis(identifier)

    def append(self, identifier, start, end, state, checkpoint, observation=None, gaze_intervals=None, gaze=None):
        with self.connection:
            if end > start:
                previous = self.connection.execute("SELECT id,end,state FROM timeline WHERE session_id=? ORDER BY id DESC LIMIT 1", (identifier,)).fetchone()
                if previous and previous['state'] == state and abs(previous['end'] - start) < 1e-6:
                    self.connection.execute("UPDATE timeline SET end=? WHERE id=?", (end, previous['id']))
                else:
                    self.connection.execute("INSERT INTO timeline (session_id,start,end,state) VALUES (?,?,?,?)", (identifier, start, end, state))
            self.connection.execute("UPDATE sessions SET elapsed=?,checkpoint_at=? WHERE id=?", (end, checkpoint, identifier))
            if observation is not None:
                self.connection.execute("INSERT INTO observations (session_id,elapsed,available,face_count,pitch,yaw,roll) VALUES (?,?,?,?,?,?,?)",
                    (identifier, end, int(observation.available), observation.face_count, observation.pitch, observation.yaw, observation.roll))

            for interval in gaze_intervals or []:
                self._append_gaze(identifier, **interval)
            if gaze is not None:
                point = gaze['observation']
                # Only accepted, persisted calibrations can be referenced by rows.
                calibration_id = point['calibration_id']
                if calibration_id and not self.connection.execute('SELECT 1 FROM calibrations WHERE id=?', (calibration_id,)).fetchone():
                    calibration_id = None
                self.connection.execute('INSERT INTO gaze_observations (session_id,elapsed,x,y,region,reason,quality,calibration_id) VALUES (?,?,?,?,?,?,?,?)',
                    (identifier, end, point['x'], point['y'], point['region'], point['reason'], gaze['quality'], calibration_id))

    def _append_gaze(self, identifier, start, end, state, calibration_id=None):
        if end <= start:
            return
        previous = self.connection.execute('SELECT id,end,state,calibration_id FROM gaze_intervals WHERE session_id=? ORDER BY id DESC LIMIT 1', (identifier,)).fetchone()
        if previous and previous['state'] == state and previous['calibration_id'] == calibration_id and abs(previous['end'] - start) < 1e-6:
            self.connection.execute('UPDATE gaze_intervals SET end=? WHERE id=?', (end, previous['id']))
        else:
            self.connection.execute('INSERT INTO gaze_intervals (session_id,start,end,state,calibration_id) VALUES (?,?,?,?,?)', (identifier, start, end, state, calibration_id))

    def save_calibration(self, record, session_id, created_at):
        with self.connection:
            self.connection.execute('INSERT INTO calibrations (id,session_id,created_at,model_version,model_json) VALUES (?,?,?,?,?)',
                (record['id'], session_id, created_at, record['model_version'], json.dumps(record, allow_nan=False)))

    def save_gaze_setup(self, record, session_id, created_at):
        # Profile and historical model must commit together.
        encoded = json.dumps(record, allow_nan=False)
        with self.connection:
            self.connection.execute('INSERT INTO calibrations (id,session_id,created_at,model_version,model_json) VALUES (?,?,?,?,?)',
                (record['id'], None, created_at, record['model_version'], encoded))
            if session_id is not None:
                self.connection.execute('INSERT INTO calibration_sessions VALUES (?,?)', (record['id'], session_id))
            self.connection.execute('INSERT INTO gaze_profile VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET model_json=excluded.model_json,saved_at=excluded.saved_at',
                                    (encoded, created_at))

    def gaze_profile(self):
        row = self.connection.execute('SELECT model_json FROM gaze_profile WHERE singleton=1').fetchone()
        try:
            profile = json.loads(row[0]) if row else None
            if not isinstance(profile, dict) or not isinstance(profile.get('id'), str):
                return None
            return profile if self.connection.execute('SELECT 1 FROM calibrations WHERE id=?', (profile['id'],)).fetchone() else None
        except (ValueError, TypeError):
            return None

    def reset_gaze_profile(self):
        with self.connection:
            self.connection.execute('DELETE FROM gaze_profile')

    def attach_calibration(self, identifier, session_id):
        with self.connection:
            self.connection.execute('INSERT OR IGNORE INTO calibration_sessions VALUES (?,?)', (identifier, session_id))

    def gaze_summary(self, identifier):
        rows = self.connection.execute('SELECT state,SUM(end-start) AS duration FROM gaze_intervals WHERE session_id=? GROUP BY state', (identifier,)).fetchall()
        if not rows and not self.connection.execute('SELECT 1 FROM gaze_observations WHERE session_id=? LIMIT 1', (identifier,)).fetchone():
            return None
        totals = {row['state']: row['duration'] for row in rows}
        study = sum(value for key, value in totals.items() if key != 'break')
        tracked = sum(value for key, value in totals.items() if key not in ('unknown', 'break'))
        return {'totals': totals, 'tracked': tracked, 'study': study, 'coverage': tracked / study if study > 0 else None}

    def gaze_details(self, identifier):
        if not self.connection.execute('SELECT 1 FROM sessions WHERE id=?', (identifier,)).fetchone():
            return None
        calibrations = []
        for row in self.connection.execute('SELECT model_json FROM calibrations WHERE session_id=? OR id IN (SELECT calibration_id FROM calibration_sessions WHERE session_id=?) OR id IN (SELECT calibration_id FROM gaze_intervals WHERE session_id=? UNION SELECT calibration_id FROM gaze_observations WHERE session_id=?)', (identifier, identifier, identifier, identifier)):
            record = json.loads(row['model_json'])
            calibrations.append({key: record[key] for key in ('id', 'model_version', 'display', 'validation')})
        return {'session_id': identifier, 'summary': self.gaze_summary(identifier),
                'intervals': [dict(row) for row in self.connection.execute('SELECT start,end,state,calibration_id FROM gaze_intervals WHERE session_id=? ORDER BY start', (identifier,))],
                'calibrations': calibrations}

    def set_status(self, identifier, status, ended_at=None):
        with self.connection:
            self.connection.execute("UPDATE sessions SET status=?,ended_at=? WHERE id=?", (status, ended_at, identifier))

    def set_camera(self, identifier, enabled):
        with self.connection:
            self.connection.execute("UPDATE sessions SET camera_enabled=? WHERE id=?", (int(enabled), identifier))

    def get(self, identifier, include_analysis=True):
        row = self.connection.execute("SELECT * FROM sessions WHERE id=?", (identifier,)).fetchone()
        if not row:
            return None
        session = dict(row)
        session['camera_enabled'] = bool(session['camera_enabled'])
        session['timeline'] = [dict(item) for item in self.connection.execute("SELECT start,end,state FROM timeline WHERE session_id=? ORDER BY start", (identifier,))]
        session.update(summarize_timeline(session['timeline']))
        session['gaze_summary'] = self.gaze_summary(identifier)
        if include_analysis:
            analysis = self._analysis(session)
            session['study_periods'] = analysis['study_periods']
            if session['status'] in ('completed', 'interrupted'):
                session['analysis_summary'] = analysis['summary']
        return session

    def history(self):
        rows = self.connection.execute("SELECT id FROM sessions WHERE status IN ('completed','interrupted') ORDER BY started_at DESC").fetchall()
        return [self.get(row['id']) for row in rows]

    def close(self):
        self.connection.close()
