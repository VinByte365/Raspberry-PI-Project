import cv2
import threading
import time
from picamera2 import Picamera2

class PiCameraBackend:
    def __init__(self, width=640, height=480, fps=30.0):
        self.width = width
        self.height = height
        self.fps = fps

        self.latest_jpeg = None
        self.new_frame_available = False  # 💡 Frame state tracker
        self.lock = threading.Lock()
        self.running = False

        self.picam2 = Picamera2()

    def start(self):
        # FIX (Tip): Confirm "YUV420" is supported on your Pi by running
        # picam2.sensor_formats — if you get a config error at startup,
        # try "YUYV" and update the cvtColor call below to match.
        config = self.picam2.create_video_configuration(
            main={"size": (self.width, self.height), "format": "YUV420"}
        )

        # FIX (Bug #2): config["FrameRate"] and a top-level config["controls"]
        # are silently ignored by picamera2. Framerate must be expressed as
        # FrameDurationLimits (in microseconds) inside the controls dict.
        # Formula: duration_us = int(1_000_000 / fps)
        frame_duration_us = int(1_000_000 / self.fps)
        config["controls"] = {
            "FrameDurationLimits": (frame_duration_us, frame_duration_us),
            "NoiseReductionMode": 1,
            "Sharpness": 1.5,
            "Contrast": 1.15,
        }

        self.picam2.configure(config)
        self.picam2.start()

        self.running = True
        self.worker_thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.worker_thread.start()
        print(f"[Camera Backend] Hardware running at {self.fps}fps ({self.width}x{self.height}).")

    def _capture_loop(self):
        while self.running:
            try:
                img_array = self.picam2.capture_array()

                if img_array is not None:
                    color_frame = cv2.cvtColor(img_array, cv2.COLOR_YUV2BGR_I420)
                    ret, buffer = cv2.imencode(
                        ".jpg", color_frame, [cv2.IMWRITE_JPEG_QUALITY, 80]
                    )

                    if ret:
                        with self.lock:
                            self.latest_jpeg = buffer.tobytes()
                            self.new_frame_available = True  # 💡 Mark that a whole new image is ready

            except Exception as e:
                print(f"[Camera Backend] Capture Error: {e}")

            time.sleep(1 / self.fps)

    def get_latest_frame(self):
        """Thread-safe accessor that drops frames if they aren't new yet."""
        with self.lock:
            if self.new_frame_available:
                self.new_frame_available = False  # Reset flag immediately upon reading
                return self.latest_jpeg
        return None  # Return None if the server is checking faster than the camera records

    def stop(self):
        self.running = False
        if hasattr(self, "worker_thread"):
            self.worker_thread.join(timeout=2.0)
        self.picam2.stop()
        self.picam2.close()