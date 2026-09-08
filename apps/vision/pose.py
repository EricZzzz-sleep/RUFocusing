"""Approximate pitch, yaw, and roll from a facial transformation matrix."""
import math


def head_pose(matrix):
    # Normalize columns to remove uniform model-to-face scale.
    rotation = [[float(matrix[row][col]) for col in range(3)] for row in range(3)]
    for col in range(3):
        length = math.sqrt(sum(rotation[row][col] ** 2 for row in range(3)))
        if not math.isfinite(length) or length < 1e-8:
            return None
        for row in range(3):
            rotation[row][col] /= length
    r = rotation
    horizontal = math.hypot(r[0][0], r[1][0])
    yaw = math.atan2(-r[2][0], horizontal)
    if horizontal > 1e-6:
        pitch, roll = math.atan2(r[2][1], r[2][2]), math.atan2(r[1][0], r[0][0])
    else:
        pitch, roll = math.atan2(-r[1][2], r[1][1]), 0.0
    return dict(zip(("pitch", "yaw", "roll"), (round(math.degrees(v), 1) for v in (pitch, yaw, roll))))
