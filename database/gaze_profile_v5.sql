CREATE TABLE gaze_profile (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    model_json TEXT NOT NULL,
    saved_at TEXT NOT NULL
);
CREATE TABLE calibration_sessions (
    calibration_id TEXT NOT NULL REFERENCES calibrations(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    PRIMARY KEY (calibration_id, session_id)
);
INSERT INTO calibration_sessions SELECT id, session_id FROM calibrations WHERE session_id IS NOT NULL;
PRAGMA user_version = 5;
