"""Optional webcam process. Native vision failures cannot stop the session timer."""
import multiprocessing
import queue
import time
from core.features.feature_engine import Observation


def _publish(output, observation):
    try:
        output.put_nowait(observation)
    except queue.Full:
        try:
            output.get_nowait()
        except queue.Empty:
            pass
        try:
            output.put_nowait(observation)
        except queue.Full:
            pass


def _capture(index, stop, output):
    capture = detector = None
    try:
        import cv2
        from apps.vision.face import FaceDetector
        detector = FaceDetector()
        if stop.is_set():
            return
        capture = cv2.VideoCapture(index)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        if not capture.isOpened():
            raise RuntimeError('Camera unavailable. Allow camera access for your terminal/Python in system settings, then restart the session.')
        while not stop.is_set():
            started = time.monotonic()
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError('Camera disconnected or no frames are available. The timer is still running.')
            count, pose = detector.detect(frame, started * 1000)
            message = 'Face detected.' if count == 1 else ('No face detected; away is estimated after 10 seconds.' if count == 0 else 'Multiple faces detected; presence is unknown.')
            if not stop.is_set():
                _publish(output, Observation(started, True, count, message=message, **pose))
            stop.wait(max(0, 0.2 - (time.monotonic() - started)))
    except Exception as error:
        _publish(output, Observation(time.monotonic(), message=str(error)))
    finally:
        if capture is not None:
            capture.release()
        if detector is not None:
            detector.close()


class Camera:
    def __init__(self, index=0):
        self.index = index
        self.context = multiprocessing.get_context('spawn')
        self.process = self.output = self.stop_event = None
        self.latest = Observation(time.monotonic())

    def snapshot(self):
        if self.output:
            while True:
                try:
                    self.latest = self.output.get_nowait()
                except queue.Empty:
                    break
        if self.process and not self.process.is_alive() and (self.latest.available or self.latest.message.startswith('Starting')):
            self.latest = Observation(time.monotonic(), message='Vision stopped unexpectedly. The timer is still running; end and restart the session to retry the camera.')
        return self.latest

    def start(self):
        self.stop()
        self.stop_event = self.context.Event()
        self.output = self.context.Queue(maxsize=1)
        self.latest = Observation(time.monotonic(), message='Starting camera and face detection…')
        self.process = self.context.Process(target=_capture, args=(self.index, self.stop_event, self.output), daemon=True, name='vision')
        self.process.start()

    def stop(self):
        if self.process:
            self.stop_event.set()
            self.process.join(timeout=2)
            if self.process.is_alive():
                self.process.terminate()
                self.process.join(timeout=1)
            if self.process.is_alive():
                self.process.kill()
                self.process.join()
            self.process.close()
            self.process = None
        if self.output:
            self.output.close()
            self.output = None
        self.latest = Observation(time.monotonic(), message='Camera is off.')
