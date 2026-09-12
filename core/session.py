"""One local session, a monotonic timer, and a checkpointed presence timeline."""
from dataclasses import asdict
from datetime import datetime, timezone
import threading
import time
import uuid

from core.behavior.rules import AwayDetector
from core.features.feature_engine import Observation
from database.store import Store
from apps.vision.gaze import GazeTracker, display_geometry
from apps.vision.diagnostics import Diagnostics, conditions

MODES = ('Math', 'Coding', 'Reading', 'Lecture')


def utc(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


class SessionController:
    def __init__(self, path, camera, clock=time.monotonic, wall_clock=time.time):
        self.store = Store(path)
        self.camera = camera
        self.clock = clock
        self.wall_clock = wall_clock
        self.lock = threading.RLock()
        self.detector = AwayDetector()
        self.gaze = GazeTracker()
        self.diagnostics = Diagnostics()
        self.last_diagnostic_save = -float('inf')
        self.diagnostic_error = None
        self.exclusion_rows = {}
        self.exclusion_active = set()
        self.exclusion_dirty = set()
        self.gaze_pending = []
        self.gaze_offset = 0.0
        self.gaze_previous = ('unknown', None)
        self.active_id = None
        self.status = None
        self.state = 'unknown'
        self.camera_enabled = False
        self.elapsed = 0.0
        self.last_tick = self.clock()
        self.last_wall = self.wall_clock()
        self.last_observation = -float('inf')
        self.camera_error = None
        self.preview_until = 0.0
        self.stop_event = threading.Event()
        self.thread = None

    def start_ticker(self):
        self.thread = threading.Thread(target=self._loop, daemon=True, name='session-timer')
        self.thread.start()

    def _loop(self):
        while not self.stop_event.wait(.2):
            with self.lock:
                self._update_gaze()
                if self.clock() - self.last_tick >= 1:
                    self._advance()

    def _observation(self):
        if not self.camera_enabled or self.status == 'break':
            return Observation(self.clock(), message='Camera is paused.' if self.status == 'break' else 'Camera is off. Timer-only session.')
        return self._camera_observation()

    def _camera_observation(self):
        if self.camera_error:
            return Observation(self.clock(), message=self.camera_error, camera_status='unavailable')
        observation = self.camera.snapshot()
        if observation.available and not 0 <= self.clock() - observation.timestamp <= 2:
            return Observation(self.clock(), message='Camera observations stopped updating. Select Retry camera.', camera_status='unavailable')
        return observation

    def _start_camera(self, invalidate_gaze=False):
        if invalidate_gaze:
            self.gaze.reset('camera_restarted_recalibrate')
        self.camera_error = None
        self.detector = AwayDetector()
        self.state = 'unknown'
        try:
            self.camera.start()
        except (OSError, RuntimeError):
            self.camera_error = 'The camera could not start. Check camera access, then select Retry camera.'

    def _update_gaze(self, now=None):
        now = self.clock() if now is None else now
        observation = self._observation() if self.active_id else (self._camera_observation() if self.preview_until > now else Observation(now))
        self.gaze.update(observation, now)
        point = self.gaze.snapshot(now)['observation']
        self.diagnostics.update(observation, point, self.gaze, now, self.wall_clock(), self.active_id, self.status, getattr(self, 'camera_enabled', False))
        self._flush_diagnostics(now)
        current = ('break', None) if self.status == 'break' else (point['region'], point['calibration_id']) if point['valid'] else ('unknown', None)
        if self.active_id:
            offset = self.elapsed + max(0, now - self.last_tick)
            # Invalid evidence conservatively clears the interval since the last
            # update. Valid changes apply prospectively, just like presence.
            state, calibration_id = current if current[0] in ('unknown', 'break') else self.gaze_previous
            if offset > self.gaze_offset:
                interval = {'start': self.gaze_offset, 'end': offset, 'state': state, 'calibration_id': calibration_id}
                if self.gaze_pending and all(self.gaze_pending[-1][key] == interval[key] for key in ('state', 'calibration_id')):
                    self.gaze_pending[-1]['end'] = offset
                else:
                    self.gaze_pending.append(interval)
            self.gaze_offset = offset
            self.gaze_previous = current

    def _flush_diagnostics(self, now, force=False):
        self._sync_exclusions(now)
        if not force and now - self.last_diagnostic_save < 1:
            return
        self.last_diagnostic_save = now
        try:
            self.store.save_exclusions([self.exclusion_rows[key] for key in self.exclusion_dirty])
            self.exclusion_dirty.clear()
            for identifier in list(self.diagnostics.dirty):
                self.store.save_diagnostic(self.diagnostics.records[identifier])
                self.diagnostics.dirty.discard(identifier)
            self.diagnostic_error = None
        except Exception:
            self.diagnostic_error = 'Diagnostic results could not be saved. Check local database access; pending results will be retried.'
            if force:
                raise

    def _sync_exclusions(self, now):
        # Capture transitions in session coordinates, never reconstruct them from
        # diagnostic wall timestamps. Pending boundaries survive write failures.
        delta = max(0, now - self.last_tick)
        wall_delta = max(0, self.wall_clock() - self.last_wall)
        offset = self.elapsed + (wall_delta if wall_delta - delta > 3 else delta) if self.active_id else self.elapsed
        runs = [run for run in (self.diagnostics.calibration, self.diagnostics.check)
                if run and run['status'] == 'running' and self.active_id and run['session_id'] == self.active_id]
        active = {run['id'] for run in runs}
        for key in self.exclusion_active - active:
            self.exclusion_rows[key]['end'] = max(self.exclusion_rows[key]['start'], offset)
            self.exclusion_dirty.add(key)
        for run in runs:
            if run['id'] not in self.exclusion_active:
                self.exclusion_rows[run['id']] = {'run_id': run['id'], 'session_id': self.active_id,
                                                  'kind': run['kind'], 'start': offset, 'end': None}
                self.exclusion_dirty.add(run['id'])
        self.exclusion_active = active

    def session_analysis(self, identifier, action=None, data=None):
        with self.lock:
            if action == 'reflection':
                return self.store.save_reflection(identifier, data)
            if action == 'annotations':
                if set(data) != {'annotations'}:
                    raise ValueError('Provide the complete annotation list.')
                return self.store.save_annotations(identifier, data['annotations'])
            return self.store.analysis(identifier)

    def diagnostic_state(self, owner=None):
        with self.lock:
            now = self.clock()
            self._update_gaze(now)
            self.diagnostics.heartbeat(owner, now)
            if self.diagnostics.check and owner == self.diagnostics.check['id'] and self.preview_until > now:
                self.preview_until = now + 8
            return {**self.diagnostics.snapshot(), 'save_error': self.diagnostic_error,
                    'recent': [{**{key: value for key, value in record.items() if key not in ('targets', 'buckets', 'windows', 'target_order')}, 'targets': []}
                               for record in self.store.diagnostics(limit=10)],
                    'calibration_ready': self.gaze.status == 'ready', 'calibration_busy': self.gaze.status in ('collecting', 'validating')}

    def diagnostic_records(self, identifier=None, session_id=None):
        with self.lock:
            self._flush_diagnostics(self.clock(), True)
            return self.store.diagnostic(identifier) if identifier else self.store.diagnostics(session_id)

    def diagnostic_action(self, group, action, data):
        with self.lock:
            try:
                return self._diagnostic_action(group, action, data)
            finally:
                self._update_gaze()
                self._flush_diagnostics(self.clock(), True)

    def _diagnostic_action(self, group, action, data):
        with self.lock:
            self._advance()
            now = self.clock()
            self._update_gaze(now)
            identifier = data.get('id')
            if action == 'start':
                request_id = data.get('request_id')
                if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
                    raise ValueError('Provide a request identifier for this diagnostic.')
                for record in self.diagnostics.records.values():
                    if record.get('request_id') == request_id:
                        if record['kind'] != ('check' if group == 'checks' else 'trial'):
                            raise ValueError('Use a different request identifier.')
                        return self.diagnostic_state()
                observing = (self.active_id and self.camera_enabled and self.status == 'running') or (not self.active_id and self.preview_until > now)
                if not observing or self._camera_observation().camera_status != 'ready' or self.gaze.status != 'ready':
                    raise ValueError('Enable the camera and complete calibration before running diagnostics.')
                if display_geometry(data.get('display')) != self.gaze.display:
                    self.gaze.reset('display_changed_recalibrate')
                    raise ValueError('The display changed. Calibrate again.')
                metadata = conditions(data.get('conditions'))
                if group == 'checks':
                    self.diagnostics.start_check(self.active_id, self.gaze, now, self.wall_clock(), metadata, request_id)
                else:
                    self.diagnostics.start_trial(self.active_id, self.gaze, now, self.wall_clock(), metadata, request_id)
            elif group == 'checks':
                if action == 'target':
                    self.diagnostics.target(identifier, data.get('target_index'), now)
                elif action == 'complete':
                    record = self.diagnostics.complete(identifier, now)
                    if record['status'] == 'failed' and self.gaze.identifier == record['calibration_id']:
                        self.gaze.reset('accuracy_check_failed_recalibrate')
                elif action == 'cancel':
                    self.diagnostics.cancel(identifier, now)
                else:
                    raise ValueError('Unknown accuracy check action.')
            else:
                trial = self.diagnostics.trial
                if not trial or trial['id'] != identifier:
                    record = self.store.diagnostic(identifier) if isinstance(identifier, str) else None
                    if action == 'stop' and not trial and record and record['kind'] == 'trial':
                        return self.diagnostic_state()
                    raise ValueError('This trial is no longer active.')
                if action == 'stop':
                    self.diagnostics.stop_trial(now)
                elif action == 'reminder' and data.get('checkpoint') in ('initial', 'mid', 'final'):
                    checkpoint = trial['checkpoints'][data['checkpoint']]
                    if checkpoint['status'] == 'pending':
                        checkpoint['status'] = 'dismissed'
                        self.diagnostics.touch(trial, now)
                else:
                    raise ValueError('Unknown trial action.')
            self._flush_diagnostics(now, True)
            return self.diagnostic_state()

    def gaze_snapshot(self, calibration_id=None):
        with self.lock:
            now = self.clock()
            if self.gaze.status in ('collecting', 'validating') and calibration_id == self.gaze.identifier:
                # Check expiry before renewing; an abandoned client cannot revive it.
                self.gaze._deadlines(now)
                self.gaze.last_client_seen = now
                if self.preview_until > now:
                    self.preview_until = now + 8
            self._update_gaze()
            result = self.gaze.snapshot(now)
            result['diagnostic_check_active'] = self.diagnostics.check is not None
            return result

    def calibration_action(self, action, data):
        with self.lock:
            try:
                return self._calibration_action(action, data)
            finally:
                self._update_gaze()
                self._flush_diagnostics(self.clock(), True)

    def _calibration_action(self, action, data):
        with self.lock:
            self._advance()
            now = self.clock()
            if action == 'reset':
                if data.get('calibration_id') is not None and data['calibration_id'] != self.gaze.identifier:
                    raise ValueError('This calibration is no longer current.')
                self.gaze.reset('calibration_reset')
            elif action == 'display':
                geometry = display_geometry(data.get('display'))
                if self.gaze.display is not None and geometry != self.gaze.display:
                    self.gaze.reset('display_changed_recalibrate')
            else:
                observing = (self.active_id and self.camera_enabled and self.status == 'running') or (not self.active_id and self.preview_until > now)
                if not observing or self._camera_observation().camera_status != 'ready':
                    raise ValueError('Enable the camera and wait for it to be ready before calibrating.')
                if action == 'start':
                    if self.diagnostics.check or self.gaze.status in ('collecting', 'validating'):
                        raise ValueError('Finish or cancel the current collection first.')
                    metadata = conditions(data.get('conditions'))
                    self.diagnostics.stop_trial(now, 'calibration_replaced', 'interrupted')
                    self.gaze.start(data.get('display'), now)
                    self.diagnostics.begin_calibration(self.active_id, self.gaze, now, self.wall_clock(), metadata)
                elif action == 'target':
                    self.gaze.target(data.get('calibration_id'), data.get('target_index'), now)
                elif action == 'complete':
                    if self.gaze.complete(data.get('calibration_id')):
                        try:
                            self.store.save_calibration(self.gaze.record(), self.active_id, utc(self.wall_clock()))
                        except Exception:
                            self.gaze.reset('calibration_save_failed')
                            raise
                else:
                    raise ValueError('Unknown calibration action.')
            self.diagnostics.sync_calibration(self.gaze, now)
            self._update_gaze(now)
            self._flush_diagnostics(now, True)
            self.gaze_previous = ('unknown', None)
            return self.gaze.snapshot(now)

    def gaze_details(self, identifier):
        with self.lock:
            self._advance()
            return self.store.gaze_details(identifier)

    def _advance(self):
        if not self.active_id:
            if self.preview_until and self.clock() >= self.preview_until:
                self.preview_until = 0.0
                self.camera.stop()
                self.gaze.reset('setup_preview_expired')
            return
        now, wall = self.clock(), self.wall_clock()
        delta = max(0.0, now - self.last_tick)
        wall_delta = max(0.0, wall - self.last_wall)
        # Suspend or a long scheduling gap cannot inherit a previous presence label.
        gap = max(delta, wall_delta) > 3
        if wall_delta - delta > 3:
            delta = wall_delta
        self._update_gaze(now)
        observation = self._observation()
        state = 'break' if self.status == 'break' else ('unknown' if gap or not observation.available else self.state)
        sample = observation if now - self.last_observation >= 1 and self.status != 'break' else None
        gaze_intervals = self.gaze_pending
        if gap:
            gaze_intervals = [{'start': self.elapsed, 'end': self.elapsed + delta, 'state': 'break' if self.status == 'break' else 'unknown', 'calibration_id': None}]
            self.gaze.clear_point(now, 'timing_gap')
            self.gaze_previous = ('break' if self.status == 'break' else 'unknown', None)
        self.store.append(self.active_id, self.elapsed, self.elapsed + delta, state, utc(wall), sample,
                          gaze_intervals, self.gaze.snapshot(now) if sample else None)
        self.gaze_pending = []
        self.gaze_offset = self.elapsed + delta
        self.elapsed += delta
        self.last_tick, self.last_wall = now, wall
        if sample:
            self.last_observation = now
        if gap:
            self.detector = AwayDetector()
        self.state = 'break' if self.status == 'break' else self.detector.classify(observation, now)

    def start(self, task, mode, camera_enabled):
        if not isinstance(task, str) or not task.strip() or len(task.strip()) > 200:
            raise ValueError('Enter a task between 1 and 200 characters.')
        if mode not in MODES or not isinstance(camera_enabled, bool):
            raise ValueError('Choose a valid mode and camera setting.')
        with self.lock:
            if self.active_id:
                raise ValueError('End the current session before starting another.')
            transfer_calibration = camera_enabled and self.preview_until > self.clock() and self.gaze.status == 'ready'
            if not transfer_calibration:
                self.gaze.reset()
            identifier = str(uuid.uuid4())
            self.store.create(identifier, task.strip(), mode, utc(self.wall_clock()), camera_enabled)
            if transfer_calibration:
                self.store.attach_calibration(self.gaze.identifier, identifier)
                for record in self.diagnostics.records.values():
                    if record['calibration_id'] == self.gaze.identifier and record['session_id'] is None:
                        record['session_id'] = identifier
                        self.diagnostics.touch(record, self.clock())
            self.gaze_pending = []
            self.gaze_offset = 0.0
            self.gaze_previous = ('unknown', None)
            self.gaze.clear_point(self.clock(), 'waiting_for_frame')
            self.active_id = identifier
            self.status = 'running'
            self.state = 'unknown'
            self.elapsed = 0.0
            reuse_preview = camera_enabled and self.preview_until > self.clock() and self._camera_observation().camera_status in ('starting', 'ready')
            self.preview_until = 0.0
            self.camera_enabled = camera_enabled
            self.camera_error = None
            self.detector = AwayDetector()
            self.last_tick, self.last_wall = self.clock(), self.wall_clock()
            self.last_observation = -float('inf')
            if camera_enabled and not reuse_preview:
                self._start_camera()
            if not camera_enabled:
                self.camera.stop()
            self._update_gaze(self.last_tick)
            self._flush_diagnostics(self.last_tick, True)
            return self.store.get(identifier)

    def set_camera(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError('Choose a valid camera setting.')
        with self.lock:
            if not self.active_id:
                raise ValueError('Start a session before changing its camera setting.')
            self._advance()
            if enabled == self.camera_enabled:
                return
            # Close the old interval before changing observation availability.
            self.store.set_camera(self.active_id, enabled)
            self.camera_enabled = enabled
            self.gaze.clear_point(self.clock(), 'waiting_for_frame' if enabled else 'camera_off')
            self.gaze_previous = ('break' if self.status == 'break' else 'unknown', None)
            if self.gaze.status in ('collecting', 'validating'):
                self.gaze.reset('calibration_interrupted')
            self.preview_until = 0.0
            self.camera_error = None
            self.detector = AwayDetector()
            self.state = 'break' if self.status == 'break' else 'unknown'
            if enabled and self.status == 'running':
                self._start_camera()
            else:
                self.camera.stop()

            self._update_gaze()
            self._flush_diagnostics(self.clock(), True)

    def start_preview(self):
        with self.lock:
            self._advance()
            if self.active_id and (not self.camera_enabled or self.status == 'break'):
                raise ValueError('Preview is available for webcam sessions while tracking is running.')
            if self._camera_observation().camera_status not in ('starting', 'ready'):
                self._start_camera(invalidate_gaze=True)
            if not self.active_id:
                self.preview_until = self.clock() + 8

    def stop_preview(self):
        with self.lock:
            self.preview_until = 0.0
            if not self.active_id:
                self.camera.stop()
                self.gaze.reset('setup_preview_closed')

    def preview_frame(self):
        with self.lock:
            if not self.active_id:
                self._advance()
            if self.active_id:
                if not self.camera_enabled or self.status != 'running':
                    return None
            elif self.preview_until > self.clock():
                self.preview_until = self.clock() + 8
            else:
                return None
            return self.camera.preview_frame()

    def pause(self):
        with self.lock:
            if not self.active_id or self.status != 'running':
                raise ValueError('There is no running session to pause.')
            self._advance()
            self.status = self.state = 'break'
            self.gaze.clear_point(self.clock(), 'break')
            self.gaze_previous = ('break', None)
            if self.gaze.status in ('collecting', 'validating'):
                self.gaze.reset('calibration_interrupted')
            self.store.set_status(self.active_id, 'break')
            self.camera.stop()
            self._update_gaze()
            self._flush_diagnostics(self.clock(), True)

    def resume(self):
        with self.lock:
            if not self.active_id or self.status != 'break':
                raise ValueError('There is no paused session to resume.')
            self._advance()
            self.status, self.state = 'running', 'unknown'
            self.gaze_previous = ('unknown', None)
            self.detector = AwayDetector()
            self.store.set_status(self.active_id, 'running')
            self.camera_error = None
            if self.camera_enabled:
                self._start_camera()

    def finish(self, status='completed'):
        with self.lock:
            if not self.active_id:
                raise ValueError('There is no active session to end.')
            self._advance()
            identifier = self.active_id
            self.diagnostics.stop_trial(self.clock(), 'session_ended', 'interrupted')
            if self.diagnostics.check:
                self.diagnostics.cancel(self.diagnostics.check['id'], self.clock(), 'session_ended', 'interrupted')
            self.gaze.reset()
            self.diagnostics.sync_calibration(self.gaze, self.clock())
            self._flush_diagnostics(self.clock(), True)
            self.store.set_status(identifier, status, utc(self.wall_clock()))
            self.active_id = None
            self.gaze_pending = []
            self.status = None
            self.state = 'unknown'
            self.camera.stop()
            return self.store.get(identifier)

    def snapshot(self):
        with self.lock:
            self._advance()
            observation = self._observation() if self.active_id else (self._camera_observation() if self.preview_until > self.clock() else Observation(self.clock()))
            return {'active': self.store.get(self.active_id) if self.active_id else None,
                    'state': self.state, 'observation': asdict(observation), 'history': self.store.history(),
                    'preview_active': self.preview_until > self.clock()}

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)
        with self.lock:
            if self.active_id:
                self.finish('interrupted')
            else:
                self.camera.stop()
            self.diagnostics.stop_trial(self.clock(), 'application_stopped', 'interrupted')
            if self.diagnostics.check:
                self.diagnostics.cancel(self.diagnostics.check['id'], self.clock(), 'application_stopped', 'interrupted')
            self.gaze.reset('application_stopped')
            self.diagnostics.sync_calibration(self.gaze, self.clock())
            self._flush_diagnostics(self.clock(), True)
            self.store.close()
