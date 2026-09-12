"""Image-free, versioned diagnostics of the production gaze estimator.

The collector consumes predictions; it never trains or changes model parameters.
All durations use a monotonic clock. A stale sample can cover at most 750 ms.
"""
from copy import deepcopy
from datetime import datetime, timezone
import math
import random
import uuid
from typing import Literal, TypedDict

import numpy as np

from apps.vision.gaze import MODEL_VERSION, STALE_AFTER

PROTOCOL_VERSION = 'gaze-reliability-v1'
DiagnosticOutcome = Literal['running', 'awaiting_initial', 'passed', 'failed', 'incomplete', 'cancelled', 'interrupted', 'completed']


class TargetResult(TypedDict):
    index: int
    target: list[float]
    valid_count: int
    valid_span: float
    complete: bool
    median_error: float | None
    p90_error: float | None
    coverage: float | None
    durations: dict[str, float]


def conditions(value=None):
    value = {} if value is None else value
    allowed = {'lighting': ('normal', 'dim', 'side'), 'glasses': ('none', 'worn'), 'distance': ('normal', 'near', 'far')}
    if not isinstance(value, dict) or set(value) - {*allowed, 'notes'}:
        raise ValueError('Provide lighting, glasses, distance, and optional notes.')
    result = {key: value.get(key, choices[0]) for key, choices in allowed.items()}
    if any(result[key] not in choices for key, choices in allowed.items()):
        raise ValueError('Choose a listed test condition.')
    notes = value.get('notes', '')
    if not isinstance(notes, str) or len(notes) > 500:
        raise ValueError('Limit diagnostic notes to 500 characters.')
    return {**result, 'notes': notes.strip()}


def errors_summary(errors):
    return {'median_error': float(np.median(errors)) if errors else None,
            'p90_error': float(np.percentile(errors, 90)) if errors else None}


def coverage(durations):
    total = sum(durations.values())
    return durations.get('valid', 0) / total if total > 0 else None


def add_duration(durations, reason, seconds):
    if seconds > 0:
        durations[reason] = durations.get(reason, 0) + seconds


class Diagnostics:
    def __init__(self):
        self.check = None
        self.trial = None
        self.calibration = None
        self.records = {}
        self.dirty = set()
        self.last_now = None
        self.last_wall = None
        self.previous = None
        self.window_start = None
        self.window_durations = {}
        self.window_errors = []
        self.window_times = []
        self.all_errors = []
        self.last_frame = -math.inf
        self.owner_seen = None

    def _new(self, kind, session_id, tracker, now, wall, metadata=None):
        record = {'id': str(uuid.uuid4()), 'kind': kind, 'status': 'running', 'reason': None,
                  'session_id': session_id, 'calibration_id': tracker.identifier if tracker.status == 'ready' else None,
                  'calibration_identifier': tracker.identifier, 'model_version': MODEL_VERSION,
                  'protocol_version': PROTOCOL_VERSION, 'display': deepcopy(tracker.display),
                  'camera_config': tracker.camera_config, 'conditions': conditions(metadata),
                  'created_at': datetime.fromtimestamp(wall, timezone.utc).isoformat(),
                  'started_monotonic': now, 'updated_monotonic': now,
                  'targets': [], 'durations': {}, 'coverage': None}
        self.records[record['id']] = record
        self.touch(record, now)
        return record

    def touch(self, record, now):
        record['updated_monotonic'] = now
        self.dirty.add(record['id'])

    def begin_calibration(self, session_id, tracker, now, wall, metadata=None):
        self.calibration = self._new('calibration', session_id, tracker, now, wall, metadata)

    def sync_calibration(self, tracker, now):
        run = self.calibration
        if not run:
            return
        if tracker.identifier == run['calibration_identifier']:
            run['camera_config'] = tracker.camera_config
            run['completed_targets'] = 13 if tracker.status in ('ready', 'failed') else len(tracker.samples)
            run['rejections'] = dict(tracker.rejections)
            if tracker.status in ('ready', 'failed'):
                run['validation'] = deepcopy(tracker.validation)
                run['status'] = 'passed' if tracker.status == 'ready' else 'failed'
                run['calibration_id'] = tracker.identifier if tracker.status == 'ready' else None
                run['reason'] = tracker.reason
                self.calibration = None
        else:
            run['status'] = 'cancelled' if tracker.reason in ('calibration_reset', 'setup_preview_closed') else 'interrupted'
            run['reason'] = tracker.reason
            self.calibration = None
        self.touch(run, now)

    def start_check(self, session_id, tracker, now, wall, metadata=None, request_id=None):
        if self.check:
            if request_id and self.check.get('request_id') == request_id:
                return self.check
            raise ValueError('Finish or cancel the current accuracy check first.')
        if tracker.status != 'ready':
            raise ValueError('Complete a successful calibration before checking accuracy.')
        run = self._new('check', session_id, tracker, now, wall, metadata)
        targets = [[x, y] for y in (.2, .5, .8) for x in (.2, .5, .8)]
        random.SystemRandom().shuffle(targets)
        run.update(target_order=targets, completed_targets=0, collecting=False, request_id=request_id,
                   median_error=None, p90_error=None, valid_count=0, trial_id=None, checkpoint=None)
        if self.trial:
            trial = self.trial
            checkpoint = 'initial' if trial['status'] == 'awaiting_initial' else 'final' if trial['study_seconds'] >= 1500 else 'mid' if trial['study_seconds'] >= 600 and not trial['checkpoints']['mid'].get('check_id') else None
            run.update(trial_id=trial['id'], checkpoint=checkpoint, trial_study_seconds=trial['study_seconds'])
            trial['windows'].append({'check_id': run['id'], 'start': now - trial['started_monotonic'], 'end': None})
            if checkpoint:
                trial['checkpoints'][checkpoint] = {'status': 'checking', 'check_id': run['id'], 'study_seconds': trial['study_seconds']}
            self.touch(trial, now)
        self.check = run
        self.window_start = None
        self.all_errors = []
        self.last_frame = -math.inf
        self.owner_seen = now
        return run

    def target(self, identifier, index, now):
        run = self._active_check(identifier)
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < 9:
            raise ValueError('Choose the current target identifier.')
        if index < run['completed_targets']:
            return  # Retrying an acknowledged command never restarts collection.
        if index != run['completed_targets']:
            raise ValueError('Acknowledge targets in the server-provided order.')
        if run['collecting']:
            return
        self.window_start = now + .5
        self.window_durations, self.window_errors, self.window_times = {}, [], []
        run['collecting'] = True
        run['target_index'] = index
        self.owner_seen = now
        self.touch(run, now)

    def _active_check(self, identifier):
        if not self.check or identifier != self.check['id']:
            raise ValueError('This accuracy check is no longer active.')
        return self.check

    def heartbeat(self, identifier, now):
        # Expiry is checked before extending, so abandoned checks cannot revive.
        self.expire(now)
        if self.check and identifier == self.check['id']:
            self.owner_seen = now

    def expire(self, now):
        if self.check and now - self.owner_seen > 3:
            self.cancel(self.check['id'], now, 'owner_disconnected', 'interrupted')

    def _segments(self, start, end, point, reason):
        if end <= start:
            return []
        previous = self.previous
        if not point['valid'] or not previous or not previous['valid']:
            return [(reason if not point['valid'] else 'waiting_for_frame', end - start)]
        until = min(end, previous['timestamp'] + STALE_AFTER)
        result = [('valid', max(0, until - start))]
        if end > max(start, until):
            result.append(('stale', end - max(start, until)))
        return result

    def update(self, observation, point, tracker, now, wall, session_id, session_status, camera_enabled):
        elapsed = max(0, now - self.last_now) if self.last_now is not None else 0
        suspension = max(0, wall - self.last_wall - elapsed) if self.last_wall is not None else 0
        self.last_wall = wall
        if suspension > 3:
            if self.check:
                self.cancel(self.check['id'], now, 'timing_gap', 'interrupted')
            elif self.trial and self.trial['status'] == 'running' and session_status == 'running' and not self.calibration:
                self._trial_duration(self.trial, 'timing_gap', suspension)
                self.touch(self.trial, now)
        self.sync_calibration(tracker, now)
        self.expire(now)
        if self.trial and (self.trial['session_id'] != session_id or tracker.identifier != self.trial['calibration_id'] or tracker.status != 'ready'):
            self.stop_trial(now, 'calibration_changed' if session_id else 'session_ended', 'interrupted')
        if self.check and (tracker.identifier != self.check['calibration_id'] or tracker.status != 'ready' or session_status == 'break' or not observation.available and observation.camera_status == 'off'):
            self.cancel(self.check['id'], now, 'camera_or_calibration_changed', 'interrupted')
        start = self.last_now if self.last_now is not None else now
        reason = 'camera_off' if session_id and not camera_enabled else point['reason']
        if self.check and self.window_start is not None:
            run = self.check
            begin, finish = self.window_start, self.window_start + 3
            for key, seconds in self._segments(max(start, begin), min(now, finish), point, reason):
                add_duration(self.window_durations, key, seconds)
            stamp = observation.timestamp
            if begin <= stamp < finish and stamp > self.last_frame and point['valid'] and point['timestamp'] == stamp:
                self.last_frame = stamp
                target = run['target_order'][run['completed_targets']]
                display = run['display']
                error = math.hypot((point['x'] - target[0]) * display['width'], (point['y'] - target[1]) * display['height']) / math.hypot(display['width'], display['height'])
                self.window_errors.append(error)
                self.window_times.append(stamp)
            run['current_target'] = {'index': run['completed_targets'], 'target': run['target_order'][run['completed_targets']],
                                     'valid_count': len(self.window_times), 'valid_span': self.window_times[-1] - self.window_times[0] if self.window_times else 0,
                                     'complete': False, 'partial': True, **errors_summary(self.window_errors),
                                     'durations': dict(self.window_durations), 'coverage': coverage(self.window_durations)}
            self.touch(run, now)
            if now >= finish:
                run.pop('current_target', None)
                span = self.window_times[-1] - self.window_times[0] if self.window_times else 0
                durations = dict(self.window_durations)
                add_duration(durations, 'timing_gap', max(0, 3 - sum(durations.values())))
                result = {'index': run['completed_targets'], 'target': run['target_order'][run['completed_targets']],
                          'valid_count': len(self.window_times), 'valid_span': span,
                          'complete': len(self.window_times) >= 10 and span >= 2,
                          **errors_summary(self.window_errors), 'durations': durations, 'coverage': coverage(durations)}
                run['targets'].append(result)
                run['completed_targets'] += 1
                run['valid_count'] += len(self.window_times)
                for key, seconds in durations.items():
                    add_duration(run['durations'], key, seconds)
                run['coverage'] = coverage(run['durations'])
                self.all_errors.extend(self.window_errors)
                run.update(errors_summary(self.all_errors))
                self.window_start = None
                run['collecting'] = False
                self.touch(run, now)
        trial = self.trial
        if trial and trial['status'] == 'running' and session_status == 'running' and not self.check and not self.calibration:
            for key, seconds in self._segments(start, now, point, reason):
                self._trial_duration(trial, key, seconds)
            self.touch(trial, now)
        self.last_now, self.previous = now, dict(point)

    def _trial_duration(self, trial, key, seconds):
        while seconds > 1e-9:
            index = int(trial['study_seconds'] // 300)
            chunk = min(seconds, (index + 1) * 300 - trial['study_seconds'])
            while len(trial['buckets']) <= index:
                trial['buckets'].append({'index': len(trial['buckets']), 'durations': {}, 'coverage': None})
            bucket = trial['buckets'][index]
            add_duration(bucket['durations'], key, chunk)
            add_duration(trial['durations'], key, chunk)
            trial['study_seconds'] += chunk
            bucket['coverage'] = coverage(bucket['durations'])
            seconds -= chunk
        trial['coverage'] = coverage(trial['durations'])

    def complete(self, identifier, now):
        if not self.check:
            run = self.records.get(identifier)
            if run and run['kind'] == 'check' and run['status'] in ('passed', 'failed', 'incomplete'):
                return run
            raise ValueError('This accuracy check is no longer active.')
        run = self._active_check(identifier)
        if run['completed_targets'] != 9:
            raise ValueError('Finish all nine targets before completing the check.')
        complete = all(target['complete'] for target in run['targets'])
        run['status'] = ('passed' if run['median_error'] <= .1 and run['p90_error'] <= .2 else 'failed') if complete else 'incomplete'
        run['reason'] = 'accuracy_gates' if complete else 'insufficient_observations'
        self._finish_check(run, now)
        return run

    def cancel(self, identifier, now, reason='user_cancelled', status='cancelled'):
        if not self.check:
            run = self.records.get(identifier)
            if run and run['kind'] == 'check':
                return run
            raise ValueError('This accuracy check is no longer active.')
        run = self._active_check(identifier)
        partial = run.pop('current_target', None)
        if partial:
            run['targets'].append(partial)
            run['valid_count'] += partial['valid_count']
            for key, seconds in partial['durations'].items():
                add_duration(run['durations'], key, seconds)
            run['coverage'] = coverage(run['durations'])
            run.update(errors_summary(self.all_errors + self.window_errors))
        run.update(status=status, reason=reason)
        self._finish_check(run, now)
        return run

    def _finish_check(self, run, now):
        run['collecting'] = False
        self.touch(run, now)
        self.check = None
        self.window_start = None
        trial = self.trial
        if trial and run.get('trial_id') == trial['id']:
            trial['windows'][-1]['end'] = now - trial['started_monotonic']
            checkpoint = run['checkpoint']
            if checkpoint:
                trial['checkpoints'][checkpoint]['status'] = run['status']
            if checkpoint == 'initial':
                if run['status'] == 'passed':
                    trial['status'] = 'running'
                else:
                    self.stop_trial(now, 'initial_check_not_passed', 'interrupted')
            elif run['status'] == 'failed':
                self.stop_trial(now, 'accuracy_check_failed', 'interrupted')
            elif checkpoint == 'final' and run['status'] in ('passed', 'incomplete'):
                self.stop_trial(now, 'trial_finished', 'completed')
            self.touch(trial, now)
        self.last_now = now

    def start_trial(self, session_id, tracker, now, wall, metadata=None, request_id=None):
        if self.trial:
            if request_id and self.trial.get('request_id') == request_id:
                return self.trial
            raise ValueError('A reliability trial is already active.')
        if not session_id or tracker.status != 'ready' or self.check:
            raise ValueError('Start a calibrated study session and finish any check first.')
        self.trial = self._new('trial', session_id, tracker, now, wall, metadata)
        self.trial.update(status='awaiting_initial', study_seconds=0., buckets=[], windows=[], request_id=request_id,
                          checkpoints={key: {'status': 'pending', 'check_id': None} for key in ('initial', 'mid', 'final')})
        return self.trial

    def stop_trial(self, now, reason='user_stopped', status='cancelled'):
        trial = self.trial
        if not trial:
            return
        self.trial = None
        if self.check and self.check.get('trial_id') == trial['id']:
            self.cancel(self.check['id'], now, reason, 'interrupted')
        for window in trial['windows']:
            if window['end'] is None:
                window['end'] = now - trial['started_monotonic']
        for checkpoint in trial['checkpoints'].values():
            if checkpoint['status'] in ('pending', 'dismissed', 'checking'):
                checkpoint['status'] = 'missed'
        trial.update(status=status, reason=reason)
        self.touch(trial, now)

    def snapshot(self):
        trial = deepcopy(self.trial)
        if trial:
            trial['reminder'] = next((key for key, seconds in (('initial', 0), ('final', 1500), ('mid', 600))
                                      if trial['study_seconds'] >= seconds and trial['checkpoints'][key]['status'] == 'pending'), None)
        return {'check': deepcopy(self.check), 'trial': trial}
