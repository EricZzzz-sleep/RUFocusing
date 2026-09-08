"""One local session, a monotonic timer, and a checkpointed presence timeline."""
from dataclasses import asdict
from datetime import datetime, timezone
import threading
import time
import uuid

from core.behavior.rules import AwayDetector
from core.features.feature_engine import Observation
from database.store import Store

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
        self.active_id = None
        self.status = None
        self.state = 'unknown'
        self.camera_enabled = False
        self.elapsed = 0.0
        self.last_tick = self.clock()
        self.last_wall = self.wall_clock()
        self.last_observation = -float('inf')
        self.camera_error = None
        self.stop_event = threading.Event()
        self.thread = None

    def start_ticker(self):
        self.thread = threading.Thread(target=self._loop, daemon=True, name='session-timer')
        self.thread.start()

    def _loop(self):
        while not self.stop_event.wait(1):
            with self.lock:
                self._advance()

    def _observation(self):
        if not self.camera_enabled or self.status == 'break':
            return Observation(self.clock(), message='Camera is paused.' if self.status == 'break' else 'Camera is off. Timer-only session.')
        if self.camera_error:
            return Observation(self.clock(), message=self.camera_error)
        observation = self.camera.snapshot()
        if observation.available and self.clock() - observation.timestamp > 2:
            return Observation(self.clock(), message='Camera observations are stale. The timer is still running.')
        return observation

    def _advance(self):
        if not self.active_id:
            return
        now, wall = self.clock(), self.wall_clock()
        delta = max(0.0, now - self.last_tick)
        wall_delta = max(0.0, wall - self.last_wall)
        # Suspend or a long scheduling gap cannot inherit a previous presence label.
        gap = max(delta, wall_delta) > 3
        if wall_delta - delta > 3:
            delta = wall_delta
        observation = self._observation()
        state = 'break' if self.status == 'break' else ('unknown' if gap else self.state)
        sample = observation if now - self.last_observation >= 1 and self.status != 'break' else None
        self.store.append(self.active_id, self.elapsed, self.elapsed + delta, state, utc(wall), sample)
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
            identifier = str(uuid.uuid4())
            self.store.create(identifier, task.strip(), mode, utc(self.wall_clock()), camera_enabled)
            self.active_id = identifier
            self.status = 'running'
            self.state = 'unknown'
            self.elapsed = 0.0
            self.camera_enabled = camera_enabled
            self.camera_error = None
            self.detector = AwayDetector()
            self.last_tick, self.last_wall = self.clock(), self.wall_clock()
            self.last_observation = -float('inf')
            if camera_enabled:
                try:
                    self.camera.start()
                except RuntimeError as error:
                    self.camera_error = str(error)
            return self.store.get(identifier)

    def pause(self):
        with self.lock:
            if not self.active_id or self.status != 'running':
                raise ValueError('There is no running session to pause.')
            self._advance()
            self.status = self.state = 'break'
            self.store.set_status(self.active_id, 'break')
            self.camera.stop()

    def resume(self):
        with self.lock:
            if not self.active_id or self.status != 'break':
                raise ValueError('There is no paused session to resume.')
            self._advance()
            self.status, self.state = 'running', 'unknown'
            self.detector = AwayDetector()
            self.store.set_status(self.active_id, 'running')
            self.camera_error = None
            if self.camera_enabled:
                try:
                    self.camera.start()
                except RuntimeError as error:
                    self.camera_error = str(error)

    def finish(self, status='completed'):
        with self.lock:
            if not self.active_id:
                raise ValueError('There is no active session to end.')
            self._advance()
            identifier = self.active_id
            self.store.set_status(identifier, status, utc(self.wall_clock()))
            self.active_id = None
            self.status = None
            self.state = 'unknown'
            self.camera.stop()
            return self.store.get(identifier)

    def snapshot(self):
        with self.lock:
            self._advance()
            observation = self._observation() if self.active_id else Observation(self.clock())
            return {'active': self.store.get(self.active_id) if self.active_id else None,
                    'state': self.state, 'observation': asdict(observation), 'history': self.store.history()}

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)
        with self.lock:
            if self.active_id:
                self.finish('interrupted')
            else:
                self.camera.stop()
            self.store.close()
