CREATE TABLE analysis_provenance (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    reason TEXT
);
INSERT INTO analysis_provenance (session_id, reason)
SELECT s.id, CASE
    WHEN s.status IN ('running','break') THEN 'upgrade_during_session'
    WHEN EXISTS (SELECT 1 FROM diagnostic_runs d WHERE d.session_id=s.id AND d.kind IN ('calibration','check'))
      OR EXISTS (SELECT 1 FROM calibrations c WHERE c.session_id=s.id)
      THEN 'historical_diagnostic_boundaries_missing'
    ELSE NULL END
FROM sessions s;
CREATE TABLE session_reflections (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    concentration INTEGER CHECK (concentration BETWEEN 1 AND 5),
    distraction INTEGER CHECK (distraction BETWEEN 1 AND 5),
    flow TEXT CHECK (flow IN ('yes','no','unsure'))
);
CREATE TABLE session_annotations (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    position INTEGER NOT NULL,
    start REAL NOT NULL CHECK (start >= 0),
    end REAL NOT NULL CHECK (end > start),
    kind TEXT NOT NULL CHECK (kind IN ('focused','distracted','flow')),
    PRIMARY KEY (session_id, position)
);
-- Deliberately independent of diagnostic_runs: persist boundaries before result
-- metadata, including failures, and recover an open end at the session checkpoint.
CREATE TABLE diagnostic_exclusions (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    kind TEXT NOT NULL CHECK (kind IN ('calibration','check')),
    start REAL NOT NULL CHECK (start >= 0),
    end REAL CHECK (end >= start)
);
CREATE INDEX exclusions_session ON diagnostic_exclusions(session_id, start);
PRAGMA user_version = 4;
