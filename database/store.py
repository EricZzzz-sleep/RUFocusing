"""SQLite storage. The session controller serializes all access."""
from pathlib import Path
import sqlite3
import json
from core.analytics.focus_blocks import summarize_timeline


class Store:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        version = self.connection.execute("PRAGMA user_version").fetchone()[0]
        if version > 2:
            self.connection.close()
            raise RuntimeError("This database was created by a newer application version.")
        self.connection.execute('PRAGMA foreign_keys = ON')
        if version < 2:
            base = Path(__file__).with_name('schema.sql').read_text() if version == 0 else ''
            migration = Path(__file__).with_name('gaze_v2.sql').read_text()
            try:
                self.connection.executescript('BEGIN IMMEDIATE;\n' + base + migration + '\nCOMMIT;')
            except Exception:
                self.connection.rollback()
                self.connection.close()
                raise
        # End an uncleanly closed session at its last persisted checkpoint.
        with self.connection:
            self.connection.execute("UPDATE sessions SET status='interrupted', ended_at=checkpoint_at WHERE status IN ('running','break')")

    def create(self, identifier, task, mode, started_at, camera_enabled):
        with self.connection:
            self.connection.execute("INSERT INTO sessions (id,task,mode,started_at,checkpoint_at,status,camera_enabled) VALUES (?,?,?,?,?,'running',?)",
                                    (identifier, task, mode, started_at, started_at, int(camera_enabled)))

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

    def attach_calibration(self, identifier, session_id):
        with self.connection:
            self.connection.execute('UPDATE calibrations SET session_id=? WHERE id=? AND session_id IS NULL', (session_id, identifier))

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
        for row in self.connection.execute('SELECT model_json FROM calibrations WHERE session_id=?', (identifier,)):
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

    def get(self, identifier):
        row = self.connection.execute("SELECT * FROM sessions WHERE id=?", (identifier,)).fetchone()
        if not row:
            return None
        session = dict(row)
        session['camera_enabled'] = bool(session['camera_enabled'])
        session['timeline'] = [dict(item) for item in self.connection.execute("SELECT start,end,state FROM timeline WHERE session_id=? ORDER BY start", (identifier,))]
        session.update(summarize_timeline(session['timeline']))
        session['gaze_summary'] = self.gaze_summary(identifier)
        return session

    def history(self):
        rows = self.connection.execute("SELECT id FROM sessions WHERE status IN ('completed','interrupted') ORDER BY started_at DESC").fetchall()
        return [self.get(row['id']) for row in rows]

    def close(self):
        self.connection.close()
