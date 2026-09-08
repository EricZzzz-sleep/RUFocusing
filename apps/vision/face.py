"""Local MediaPipe face landmarks; model setup never opens a camera."""
from pathlib import Path
import argparse
import hashlib
import os
import ssl
import urllib.request

MODEL_PATH = Path(__file__).resolve().parents[2] / "core/models/face_landmarker.task"
MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"


def ensure_model():
    if MODEL_PATH.is_file() and hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest() == MODEL_SHA256:
        return MODEL_PATH
    import certifi
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = MODEL_PATH.with_suffix(".download")
    print("Downloading the face landmark model for offline use…", flush=True)
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=60, context=ssl.create_default_context(cafile=certifi.where())) as response:
            content = response.read(20_000_001)
        if not 1_000_000 < len(content) <= 20_000_000:
            raise RuntimeError("Unexpected face-model download size.")
        if hashlib.sha256(content).hexdigest() != MODEL_SHA256:
            raise RuntimeError("Face-model checksum did not match the pinned version.")
        temp.write_bytes(content)
        os.replace(temp, MODEL_PATH)
    finally:
        temp.unlink(missing_ok=True)
    print("Face model ready: " + hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest(), flush=True)
    return MODEL_PATH


class FaceDetector:
    def __init__(self):
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
        if not MODEL_PATH.is_file():
            raise RuntimeError("Face model missing. Run make install first.")
        self.mp = mp
        self.detector = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(MODEL_PATH), delegate=python.BaseOptions.Delegate.CPU),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=2,
            output_facial_transformation_matrixes=True,
        ))
        self.last_timestamp = -1

    def detect(self, frame, timestamp_ms):
        import cv2
        from apps.vision.pose import head_pose
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        timestamp_ms = max(int(timestamp_ms), self.last_timestamp + 1)
        self.last_timestamp = timestamp_ms
        result = self.detector.detect_for_video(image, timestamp_ms)
        count = len(result.face_landmarks)
        pose = head_pose(result.facial_transformation_matrixes[0]) if count == 1 and len(result.facial_transformation_matrixes) else None
        return count, pose or {}

    def close(self):
        self.detector.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    if parser.parse_args().download:
        ensure_model()
