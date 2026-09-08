PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    checkpoint_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'break', 'completed', 'interrupted')),
    camera_enabled INTEGER NOT NULL,
    elapsed REAL NOT NULL DEFAULT 0 CHECK (elapsed >= 0)
);
CREATE TABLE IF NOT EXISTS timeline (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start REAL NOT NULL,
    end REAL NOT NULL CHECK (end >= start),
    state TEXT NOT NULL CHECK (state IN ('present', 'away', 'break', 'unknown'))
);
CREATE INDEX IF NOT EXISTS timeline_session ON timeline(session_id, start);
CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    elapsed REAL NOT NULL,
    available INTEGER NOT NULL,
    face_count INTEGER,
    pitch REAL,
    yaw REAL,
    roll REAL
);
CREATE INDEX IF NOT EXISTS observations_session ON observations(session_id, elapsed);
PRAGMA user_version = 1;
