"""SQLite storage. The session controller serializes all access."""
from pathlib import Path
import sqlite3
from core.analytics.focus_blocks import summarize_timeline


class Store:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        version = self.connection.execute("PRAGMA user_version").fetchone()[0]
        if version > 1:
            self.connection.close()
            raise RuntimeError("This database was created by a newer application version.")
        self.connection.executescript(Path(__file__).with_name("schema.sql").read_text())
        # End an uncleanly closed session at its last persisted checkpoint.
        with self.connection:
            self.connection.execute("UPDATE sessions SET status='interrupted', ended_at=checkpoint_at WHERE status IN ('running','break')")

    def create(self, identifier, task, mode, started_at, camera_enabled):
        with self.connection:
            self.connection.execute("INSERT INTO sessions (id,task,mode,started_at,checkpoint_at,status,camera_enabled) VALUES (?,?,?,?,?,'running',?)",
                                    (identifier, task, mode, started_at, started_at, int(camera_enabled)))

    def append(self, identifier, start, end, state, checkpoint, observation=None):
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

    def set_status(self, identifier, status, ended_at=None):
        with self.connection:
            self.connection.execute("UPDATE sessions SET status=?,ended_at=? WHERE id=?", (status, ended_at, identifier))

    def get(self, identifier):
        row = self.connection.execute("SELECT * FROM sessions WHERE id=?", (identifier,)).fetchone()
        if not row:
            return None
        session = dict(row)
        session['camera_enabled'] = bool(session['camera_enabled'])
        session['timeline'] = [dict(item) for item in self.connection.execute("SELECT start,end,state FROM timeline WHERE session_id=? ORDER BY start", (identifier,))]
        session.update(summarize_timeline(session['timeline']))
        return session

    def history(self):
        rows = self.connection.execute("SELECT id FROM sessions WHERE status IN ('completed','interrupted') ORDER BY started_at DESC").fetchall()
        return [self.get(row['id']) for row in rows]

    def close(self):
        self.connection.close()
