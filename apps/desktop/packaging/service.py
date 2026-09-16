"""Frozen entry point: multiprocessing dispatch must precede application imports."""
import multiprocessing
import sys
import os
from pathlib import Path


def vision_self_test(sender):
    """Exercise bundled native inference on a blank synthetic image, never a camera."""
    try:
        import numpy as np
        from apps.vision.face import FaceDetector
        detector = FaceDetector()
        count, _ = detector.detect(np.zeros((480, 640, 3), dtype=np.uint8), 1)
        detector.close()
        sender.send(count == 0)
    finally:
        sender.close()


if __name__ == '__main__':
    # PyInstaller otherwise creates a new font cache on every process launch.
    # MediaPipe imports plotting utilities, although RUFocusing never plots images.
    if os.environ.get('RUFOCUSING_CACHE_DIR'):
        Path(os.environ['RUFOCUSING_CACHE_DIR']).mkdir(parents=True, exist_ok=True, mode=0o700)
        os.environ['MPLCONFIGDIR'] = os.environ['RUFOCUSING_CACHE_DIR']
    os.environ['MPLBACKEND'] = 'Agg'
    multiprocessing.freeze_support()
    if '--self-test' in sys.argv:
        context = multiprocessing.get_context('spawn')
        receiver, sender = context.Pipe(duplex=False)
        child = context.Process(target=vision_self_test, args=(sender,))
        child.start()
        sender.close()
        success = False
        try:
            success = receiver.poll(60) and receiver.recv() is True
        finally:
            child.join(timeout=3)
            if child.is_alive():
                child.kill()
                child.join()
            receiver.close()
        if not success or child.exitcode != 0:
            raise SystemExit('Bundled vision self-test failed.')
        print('Bundled offline inference and multiprocessing passed.')
    else:
        from apps.vision.worker import main
        main()
