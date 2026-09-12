"""Experimental local screen-gaze geometry, calibration, and estimation.

MediaPipe supplies landmarks, not gaze. These versioned heuristics and held-out
error gates deliberately make no claims about mental concentration.
"""
from dataclasses import asdict, dataclass
import math
import uuid
from typing import Literal

import numpy as np

from core.features.feature_engine import Observation

MODEL_VERSION = 'iris-ridge-v1'
FEATURE_NAMES = ('left_x', 'left_y', 'right_x', 'right_y', 'pitch', 'yaw', 'face_x', 'face_y', 'face_width')
TRAIN_TARGETS = [(x, y) for y in (.1, .5, .9) for x in (.1, .5, .9)]
VALIDATION_TARGETS = [(x, y) for y in (.3, .7) for x in (.3, .7)]
TARGETS = TRAIN_TARGETS + VALIDATION_TARGETS
REGIONS = tuple(f'{row}_{col}' for row in ('top', 'middle', 'bottom') for col in ('left', 'center', 'right'))
CalibrationStatus = Literal['uncalibrated', 'collecting', 'validating', 'ready', 'failed']
GazeRegion = Literal['top_left', 'top_center', 'top_right', 'middle_left', 'middle_center', 'middle_right', 'bottom_left', 'bottom_center', 'bottom_right']
STALE_AFTER = .75


def eye_features(landmarks, width, height, pose):
    """Return only compact geometry; never pass a mesh out of the worker.

    Eye coordinates use orthogonal axes in pixel space, including image aspect
    ratio. The horizontal axis follows the unmirrored camera image.
    """
    invalid = {'gaze_quality': 'invalid_landmarks'}
    if len(landmarks) < 478 or width <= 0 or height <= 0:
        return invalid
    try:
        points = np.array([(p.x * width, p.y * height) for p in landmarks], dtype=float)
        if not np.isfinite(points).all():
            return invalid
        lo, hi = points[:468].min(axis=0), points[:468].max(axis=0)
        center = (lo + hi) / 2
        bounds = (float(lo[0] / width), float(lo[1] / height), float((hi[0] - lo[0]) / width), float((hi[1] - lo[1]) / height))
        result = {'face_bounds': bounds}
        if lo[0] < 0 or lo[1] < 0 or hi[0] > width or hi[1] > height:
            return {**result, 'gaze_quality': 'face_clipped'}
        if bounds[2] < .12:
            return {**result, 'gaze_quality': 'face_too_small'}
        if any(pose.get(key) is None or not math.isfinite(pose[key]) for key in ('pitch', 'yaw', 'roll')):
            return {**result, 'gaze_quality': 'head_pose_unavailable'}
        if max(abs(pose[key]) for key in ('pitch', 'yaw', 'roll')) > 40:
            return {**result, 'gaze_quality': 'extreme_head_angle'}
        values, openness = [], []
        for a, b, upper, lower, iris in ((33, 133, 159, 145, 468), (362, 263, 386, 374, 473)):
            corners = sorted((points[a], points[b]), key=lambda p: p[0])
            axis = corners[1] - corners[0]
            eye_width = float(np.linalg.norm(axis))
            if eye_width < 8:
                return {**result, 'gaze_quality': 'eyes_too_small'}
            axis /= eye_width
            vertical = np.array([-axis[1], axis[0]])
            opening = abs(float((points[lower] - points[upper]) @ vertical)) / eye_width
            openness.append(opening)
            relative = points[iris] - (corners[0] + corners[1]) / 2
            values.extend((float(relative @ axis / eye_width), float(relative @ vertical / eye_width)))
        result['eye_openness'] = tuple(openness)
        if min(openness) < .12:
            return {**result, 'gaze_quality': 'eyes_closed'}
        if any(abs(values[i]) > (.65 if i % 2 == 0 else .35) for i in range(4)) or abs(values[0] - values[2]) > .25 or abs(values[1] - values[3]) > .15:
            return {**result, 'gaze_quality': 'unreliable_eyes'}
        values.extend((pose['pitch'], pose['yaw'], float(center[0] / width), float(center[1] / height), bounds[2]))
        return {**result, 'gaze_quality': 'usable', 'gaze_features': tuple(values)}
    except (TypeError, ValueError, IndexError, AttributeError, FloatingPointError):
        return invalid


def display_geometry(data):
    if not isinstance(data, dict) or set(data) != {'width', 'height', 'device_pixel_ratio'}:
        raise ValueError('Provide the calibrated display width, height, and device pixel ratio.')
    limits = {'width': (320, 16384), 'height': (200, 16384), 'device_pixel_ratio': (.5, 8)}
    for key, (low, high) in limits.items():
        value = data[key]
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError('Invalid display geometry.')
    return dict(data)


@dataclass(frozen=True)
class GazeObservation:
    timestamp: float
    valid: bool = False
    x: float | None = None
    y: float | None = None
    region: GazeRegion | None = None
    reason: str = 'uncalibrated'
    calibration_id: str | None = None


class GazeTracker:
    def __init__(self):
        self.reset()

    def reset(self, reason='uncalibrated'):
        self.status: CalibrationStatus = 'uncalibrated'
        self.reason = reason
        self.identifier = None
        self.display = None
        self.model = None
        self.validation = None
        self.samples = {}
        self.target_index = None
        self.target_started = None
        self.target_samples = []
        self.target_error = None
        self.last_timestamp = -math.inf
        self.last_client_seen = None
        self.quality = 'unavailable'
        self.rejections = {}
        self.last_quality_timestamp = -math.inf
        self.geometry_since = None
        self.camera_config = None
        self.latest = GazeObservation(0, reason=reason)
        self.smoothed = None

    def clear_point(self, now, reason):
        self.latest = GazeObservation(now, reason=reason, calibration_id=self.identifier)
        self.smoothed = None

    def start(self, display, now):
        display = display_geometry(display)
        self.reset()
        self.display = display
        self.identifier = str(uuid.uuid4())
        self.status = 'collecting'
        self.reason = 'calibration_in_progress'
        self.last_client_seen = now

    def target(self, identifier, index, now):
        if identifier != self.identifier or self.status not in ('collecting', 'validating'):
            raise ValueError('Start a new calibration before collecting targets.')
        if isinstance(index, bool) or not isinstance(index, int) or index != len(self.samples) or not 0 <= index < len(TARGETS):
            raise ValueError('Collect the next calibration target in order.')
        if self.target_started is not None:
            if index == self.target_index:
                return  # Duplicate requests must not reset a running target.
            raise ValueError('Finish the current calibration target first.')
        self.target_index = index
        self.target_started = now
        self.target_samples = []
        self.target_error = None
        self.status = 'collecting' if index < 9 else 'validating'
        self.last_client_seen = now

    def _deadlines(self, now):
        if self.status in ('collecting', 'validating'):
            if self.last_client_seen is not None and now - self.last_client_seen > 3:
                self.reset('calibration_abandoned')
            elif self.target_started is not None and now - self.target_started > 10:
                self.target_started = None
                self.target_samples = []
                self.target_error = 'Not enough usable frames. Keep both eyes visible and retry this target.'

    def update(self, observation: Observation, now):
        self._deadlines(now)
        if observation.camera_status == 'unavailable' and self.status != 'uncalibrated':
            self.reset('camera_failed_recalibrate')
        if observation.available and observation.camera_config is not None:
            if self.camera_config is not None and observation.camera_config != self.camera_config:
                self.reset('camera_config_changed_recalibrate')
            if self.status in ('collecting', 'validating') and self.camera_config is None:
                self.camera_config = observation.camera_config
        self.quality = observation.gaze_quality
        features = observation.gaze_features
        usable = (observation.available and observation.face_count == 1 and observation.gaze_quality == 'usable'
                  and features is not None and len(features) == len(FEATURE_NAMES)
                  and all(math.isfinite(v) for v in features))
        if not usable or not 0 <= now - observation.timestamp <= STALE_AFTER:
            reason = 'stale' if observation.available and now - observation.timestamp > STALE_AFTER else (
                'multiple_faces' if observation.face_count and observation.face_count > 1 else 'no_face' if observation.face_count == 0 else observation.gaze_quality)
            if self.status in ('collecting', 'validating') and observation.timestamp > self.last_quality_timestamp:
                self.rejections[reason] = self.rejections.get(reason, 0) + 1
                self.last_quality_timestamp = observation.timestamp
            self.clear_point(now, reason)
            self.geometry_since = None
            return
        if observation.timestamp <= self.last_timestamp:
            return
        self.last_timestamp = observation.timestamp
        values = np.asarray(features, dtype=float)
        if self.target_started is not None and observation.timestamp >= self.target_started + .5:
            self.target_samples.append((observation.timestamp, values))
            if len(self.target_samples) >= 10 and self.target_samples[-1][0] - self.target_samples[0][0] >= 2:
                self.samples[self.target_index] = np.array([sample for _, sample in self.target_samples])
                self.target_started = None
        if self.status != 'ready':
            self.clear_point(now, self.reason)
            return
        model = self.model
        geometry_bad = (np.any(np.abs(values[6:8] - model['geometry'][:2]) > .1)
                        or not .75 <= values[8] / model['geometry'][2] <= 1.25
                        or np.any(values[4:6] < model['pose_min'] - 10)
                        or np.any(values[4:6] > model['pose_max'] + 10))
        if geometry_bad:
            if self.geometry_since is None:
                self.geometry_since = now
            self.clear_point(now, 'seating_changed')
            if now - self.geometry_since >= 2:
                self.reset('seating_changed_recalibrate')
            return
        self.geometry_since = None
        point = self._predict(values)
        if not np.isfinite(point).all() or np.any(point < 0) or np.any(point > 1):
            self.clear_point(now, 'outside_calibrated_area')
            return
        if self.smoothed is not None:
            previous_time, previous_point = self.smoothed
            alpha = 1 - math.exp(-(observation.timestamp - previous_time) / .25)
            point = previous_point + alpha * (point - previous_point)
        self.smoothed = (observation.timestamp, point)
        x, y = map(float, point)
        region = REGIONS[min(2, int(y * 3)) * 3 + min(2, int(x * 3))]
        self.latest = GazeObservation(observation.timestamp, True, x, y, region, 'estimated', self.identifier)

    def _predict(self, features):
        standardized = (features - self.model['mean']) / self.model['scale']
        return np.append(standardized, 1) @ self.model['coefficients']

    def complete(self, identifier):
        if identifier != self.identifier or self.status not in ('collecting', 'validating') or len(self.samples) != len(TARGETS):
            raise ValueError('Collect all nine training and four validation targets first.')
        training = np.concatenate([self.samples[i] for i in range(9)])
        answers = np.concatenate([np.tile(TRAIN_TARGETS[i], (len(self.samples[i]), 1)) for i in range(9)])
        mean, scale = training.mean(axis=0), training.std(axis=0)
        scale[scale < 1e-6] = 1
        design = np.column_stack(((training - mean) / scale, np.ones(len(training))))
        penalty = np.eye(design.shape[1])
        penalty[-1, -1] = 0  # Unpenalized intercept; ridge lambda = 1.
        try:
            coefficients = np.linalg.solve(design.T @ design + penalty, design.T @ answers)
            self.model = {'mean': mean, 'scale': scale, 'coefficients': coefficients,
                          'geometry': np.median(training[:, 6:9], axis=0),
                          'pose_min': training[:, 4:6].min(axis=0), 'pose_max': training[:, 4:6].max(axis=0)}
            pixels = np.array([self.display['width'], self.display['height']])
            errors = [float(np.linalg.norm((self._predict(sample) - TARGETS[i]) * pixels) / np.linalg.norm(pixels))
                      for i in range(9, 13) for sample in self.samples[i]]
            median, p90 = float(np.median(errors)), float(np.percentile(errors, 90))
        except (np.linalg.LinAlgError, ValueError, FloatingPointError):
            median = p90 = math.inf
        accepted = math.isfinite(median) and math.isfinite(p90) and median <= .1 and p90 <= .2
        self.validation = {'median_error': median if math.isfinite(median) else None,
                           'p90_error': p90 if math.isfinite(p90) else None,
                           'accepted': accepted, 'unit': 'display_diagonal_fraction'}
        self.status = 'ready' if accepted else 'failed'
        self.reason = 'estimated' if accepted else 'calibration_accuracy_failed'
        if not accepted:
            self.model = None
        self.samples = {}  # Discard raw calibration feature samples.
        self.target_samples = []
        self.target_started = None
        return accepted

    def record(self):
        if self.status != 'ready':
            raise ValueError('Only validated calibration models may be saved.')
        return {'id': self.identifier, 'model_version': MODEL_VERSION, 'display': self.display,
                'validation': self.validation, 'features': FEATURE_NAMES, 'camera_config': self.camera_config,
                'parameters': {key: value.tolist() for key, value in self.model.items()}}

    def snapshot(self, now):
        self._deadlines(now)
        if self.latest.valid and now - self.latest.timestamp > STALE_AFTER:
            self.clear_point(now, 'stale')
        return {'experimental': True, 'quality': self.quality, 'observation': asdict(self.latest),
                'calibration': {'id': self.identifier, 'status': self.status, 'reason': self.reason,
                    'display': self.display, 'validation': self.validation,
                    'target_index': self.target_index, 'target': TARGETS[self.target_index] if self.target_index is not None else None,
                    'target_count': len(TARGETS), 'targets': TARGETS, 'completed_targets': len(self.samples) if self.status in ('collecting', 'validating') else 13 if self.status == 'ready' else 0,
                    'rejections': dict(self.rejections), 'samples': len(self.target_samples), 'collecting': self.target_started is not None,
                    'target_error': self.target_error}}
