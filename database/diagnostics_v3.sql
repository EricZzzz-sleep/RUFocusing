CREATE TABLE diagnostic_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('calibration','check','trial')),
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    calibration_id TEXT REFERENCES calibrations(id),
    status TEXT NOT NULL,
    record_json TEXT NOT NULL
);
CREATE INDEX diagnostic_runs_session ON diagnostic_runs(session_id);
CREATE TABLE diagnostic_targets (
    run_id TEXT NOT NULL REFERENCES diagnostic_runs(id) ON DELETE CASCADE,
    target_index INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY(run_id, target_index)
);
CREATE TABLE diagnostic_durations (
    run_id TEXT NOT NULL REFERENCES diagnostic_runs(id) ON DELETE CASCADE,
    bucket INTEGER NOT NULL,
    reason TEXT NOT NULL,
    seconds REAL NOT NULL CHECK(seconds >= 0),
    PRIMARY KEY(run_id, bucket, reason)
);
PRAGMA user_version = 3;
