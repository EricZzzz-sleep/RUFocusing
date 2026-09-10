CREATE TABLE calibrations (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    model_version TEXT NOT NULL,
    model_json TEXT NOT NULL
);
CREATE TABLE gaze_intervals (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start REAL NOT NULL,
    end REAL NOT NULL CHECK (end >= start),
    state TEXT NOT NULL CHECK (state IN ('top_left','top_center','top_right','middle_left','middle_center','middle_right','bottom_left','bottom_center','bottom_right','unknown','break')),
    calibration_id TEXT REFERENCES calibrations(id)
);
CREATE INDEX gaze_intervals_session ON gaze_intervals(session_id, start);
CREATE TABLE gaze_observations (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    elapsed REAL NOT NULL,
    x REAL,
    y REAL,
    region TEXT,
    reason TEXT NOT NULL,
    quality TEXT NOT NULL,
    calibration_id TEXT REFERENCES calibrations(id)
);
CREATE INDEX gaze_observations_session ON gaze_observations(session_id, elapsed);
PRAGMA user_version = 2;
