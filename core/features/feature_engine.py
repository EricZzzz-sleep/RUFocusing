"""Small, image-free observations shared by vision and session logic."""
from dataclasses import dataclass
from typing import Literal

CameraStatus = Literal['off', 'starting', 'ready', 'unavailable']


@dataclass(frozen=True)
class Observation:
    timestamp: float
    available: bool = False
    face_count: int | None = None
    pitch: float | None = None
    yaw: float | None = None
    roll: float | None = None
    message: str = "Camera is off."
    camera_status: CameraStatus = 'off'
