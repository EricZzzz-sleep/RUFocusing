"""Conservative presence rules. Head orientation never determines away state."""
from core.features.feature_engine import Observation


class AwayDetector:
    def __init__(self, threshold=10.0, stale_after=2.0):
        self.threshold = threshold
        self.stale_after = stale_after
        self.absent_since = None

    def classify(self, observation: Observation, now: float) -> str:
        if (not observation.available or observation.face_count is None
                or not 0 <= now - observation.timestamp <= self.stale_after
                or observation.face_count > 1):
            self.absent_since = None
            return "unknown"
        if observation.face_count == 1:
            self.absent_since = None
            return "present"
        if self.absent_since is None:
            self.absent_since = now
        return "away" if now - self.absent_since >= self.threshold else "unknown"
