"""Optional webcam process. Native vision failures cannot stop the session timer."""
import multiprocessing
import logging
import pickle
import queue
import time
from core.features.feature_engine import Observation

STARTUP_TIMEOUT = 15.0
STALE_AFTER = 2.0


class LatestFrame:
    """One bounded, local-only packet; a crashed writer can never block a reader."""
    def __init__(self, context):
        self.buffer = context.RawArray('B', 4 * 1024 * 1024)
        self.size = context.RawValue('I', 0)
        self.lock = context.Lock()

    def put_nowait(self, packet):
        payload = pickle.dumps(packet, protocol=5)
        if len(payload) > len(self.buffer):
            raise ValueError('Camera packet exceeds the 4 MiB limit.')
        if not self.lock.acquire(False):
            raise queue.Full
        try:
            memoryview(self.buffer).cast('B')[:len(payload)] = payload
            self.size.value = len(payload)
        finally:
            self.lock.release()

    def get_nowait(self):
        if not self.lock.acquire(False):
            raise queue.Empty
        try:
            if not self.size.value:
                raise queue.Empty
            payload = bytes(memoryview(self.buffer).cast('B')[:self.size.value])
            self.size.value = 0
        finally:
            self.lock.release()
        # Only the spawned local camera worker can write this shared buffer.
        return pickle.loads(payload)

    def close(self):
        self.buffer = self.size = self.lock = None


class StopSignal:
    """The child only polls a pipe; no shared Event lock survives a worker crash."""
    def __init__(self, receiver):
        self.receiver = receiver

    def is_set(self):
        return self.receiver.poll(0)

    def wait(self, timeout):
        return self.receiver.poll(timeout)

    def close(self):
        self.receiver.close()


def _publish(output, observation, jpeg=None):
    try:
        output.put_nowait((observation, jpeg))
    except queue.Full:
        try:
            output.get_nowait()
        except queue.Empty:
            pass
        try:
            output.put_nowait((observation, jpeg))
        except queue.Full:
            pass


def _capture(index, stop, output):
    capture = detector = None
    failure_message = 'Face detection could not start. Check the terminal for details, then select Retry camera.'
    try:
        import cv2
        from apps.vision.face import FaceDetector
        detector = FaceDetector()
        if stop.is_set():
            return
        failure_message = 'Could not open the camera. Check camera access for Python or your launching app in system settings, close other apps using the camera, then select Retry camera.'
        capture = cv2.VideoCapture(index)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        if not capture.isOpened():
            raise RuntimeError('The default camera could not be opened.')
        while not stop.is_set():
            started = time.monotonic()
            failure_message = 'Camera frames stopped. Check the camera connection, then select Retry camera.'
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError('The camera returned no frame.')
            failure_message = 'Face detection stopped. Check the terminal for details, then select Retry camera.'
            count, pose = detector.detect(frame, started * 1000)
            message = 'Face detected.' if count == 1 else ('No face detected; away is estimated after 10 seconds.' if count == 0 else 'Multiple faces detected; presence is unknown.')
            if not stop.is_set():
                encoded, image = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                if not encoded:
                    failure_message = 'The camera preview could not be prepared. Select Retry camera.'
                    raise RuntimeError('JPEG encoding failed.')
                _publish(output, Observation(started, True, count, message=message, camera_status='ready', camera_config=(index, frame.shape[1], frame.shape[0]), **pose), image.tobytes())
            stop.wait(max(0, 0.2 - (time.monotonic() - started)))
    except Exception:
        logging.exception('Camera worker failed')
        _publish(output, Observation(time.monotonic(), message=failure_message, camera_status='unavailable'))
    finally:
        if capture is not None:
            capture.release()
        if detector is not None:
            detector.close()
        stop.close()


class Camera:
    def __init__(self, index=0, clock=time.monotonic):
        self.index = index
        self.clock = clock
        self.context = multiprocessing.get_context('spawn')
        self.process = self.output = self.stop_sender = None
        self.latest = Observation(self.clock())
        self.jpeg = None

    def _drain(self):
        if self.output:
            while True:
                try:
                    self.latest, self.jpeg = self.output.get_nowait()
                except queue.Empty:
                    break

    def snapshot(self):
        self._drain()
        age = self.clock() - self.latest.timestamp
        if self.process and not self.process.is_alive() and (self.latest.available or self.latest.camera_status == 'starting'):
            self.latest = Observation(self.clock(), message='Camera processing stopped unexpectedly. Select Retry camera.', camera_status='unavailable')
        elif self.latest.camera_status == 'starting' and age >= STARTUP_TIMEOUT:
            self._release_process()
            self.latest = Observation(self.clock(), message='Camera startup took longer than 15 seconds. Check camera access and the terminal, then select Retry camera.', camera_status='unavailable')
        elif self.latest.available and not 0 <= age <= STALE_AFTER:
            self.latest = Observation(self.clock(), message='Camera observations stopped updating. Select Retry camera.', camera_status='unavailable')
        if not self.latest.available:
            self.jpeg = None
        return self.latest

    def preview_frame(self):
        self.snapshot()
        return self.jpeg

    def start(self):
        self.stop()
        self.latest = Observation(self.clock(), message='Starting camera and face detection…', camera_status='starting')
        receiver = None
        try:
            receiver, self.stop_sender = self.context.Pipe(duplex=False)
            self.output = LatestFrame(self.context)
            self.process = self.context.Process(target=_capture, args=(self.index, StopSignal(receiver), self.output), daemon=True, name='vision')
            self.process.start()
        except (OSError, RuntimeError):
            logging.exception('Could not start camera process')
            self._release_process()
            self.latest = Observation(self.clock(), message='The camera process could not start. Check the terminal for details, then select Retry camera.', camera_status='unavailable')
        finally:
            if receiver:
                receiver.close()

    def _release_process(self):
        if self.process:
            if self.process.is_alive():
                try:
                    # At most one tiny message is sent into this dedicated pipe.
                    self.stop_sender.send_bytes(b'stop')
                except (BrokenPipeError, OSError):
                    pass
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
        if self.stop_sender:
            self.stop_sender.close()
            self.stop_sender = None
        self.jpeg = None

    def stop(self):
        self._release_process()
        self.latest = Observation(self.clock())
