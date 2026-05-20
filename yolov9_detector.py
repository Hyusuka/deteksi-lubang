import os
import sys
import time
import random
import requests
import json
import cv2
import numpy as np

# API Endpoint of Flask server
API_URL = "http://localhost:5000/api/potholes/add"

# Try importing ultralytics for YOLOv9
ULTRALYTICS_AVAILABLE = False
try:
    from ultralytics import YOLO
    ULTRALYTICS_AVAILABLE = True
except ImportError:
    print("Warning: 'ultralytics' library not found. Running in optimized Simulation Mode.")

class PotholeDetector:
    def __init__(self, mode='simulation', model_path='yolov9c.pt'):
        self.mode = mode
        self.model_path = model_path
        self.model = None
        self.running = False
        
        # Simulated route from Universitas Gunadarma Campus D (Margonda) to Lenteng Agung
        # Coordinates path
        self.route_coords = [
            (-6.3627, 106.8272), # Gunadarma Campus D
            (-6.3600, 106.8290),
            (-6.3570, 106.8310),
            (-6.3540, 106.8330),
            (-6.3510, 106.8345),
            (-6.3470, 106.8355), # UI Station
            (-6.3430, 106.8360),
            (-6.3390, 106.8365),
            (-6.3350, 106.8360),
            (-6.3310, 106.8350), # Lenteng Agung
        ]
        self.current_route_index = 0
        
        # Pothole locations along the route to trigger alerts
        self.pothole_triggers = [
            {"index": 2, "diameter": 32.5, "depth": 7.8, "severity": "Medium"},
            {"index": 5, "diameter": 54.2, "depth": 14.1, "severity": "High"},
            {"index": 8, "diameter": 15.0, "depth": 3.2, "severity": "Low"},
        ]
        self.triggered_potholes = set()

        if ULTRALYTICS_AVAILABLE and self.mode == 'real':
            try:
                print(f"Loading YOLOv9 model from '{self.model_path}'...")
                # Download weights if not present, and load model
                self.model = YOLO(self.model_path)
                print("YOLOv9 model loaded successfully.")
            except Exception as e:
                print(f"Error loading YOLOv9 model: {e}. Falling back to simulation.")
                self.mode = 'simulation'

    def run_detection(self):
        self.running = True
        print(f"Starting Pothole Detection System (Mode: {self.mode.upper()})...")
        
        # Speed simulator (motorcycle speed in km/h)
        speed = 40.0 
        
        while self.running:
            # 1. Update position on route
            start_coord = self.route_coords[self.current_route_index]
            next_index = (self.current_route_index + 1) % len(self.route_coords)
            end_coord = self.route_coords[next_index]
            
            # Smoothly transition coordinates to simulate riding
            steps = 20
            for step in range(steps):
                if not self.running:
                    break
                    
                # Interpolated coordinates
                t = step / steps
                lat = start_coord[0] + (end_coord[0] - start_coord[0]) * t
                lon = start_coord[1] + (end_coord[1] - start_coord[1]) * t
                
                # Speed fluctuations (e.g. slowing down near pothole or traffic)
                speed_variance = random.uniform(-5, 5)
                current_speed = max(10, min(60, speed + speed_variance))
                
                # Inference telemetry
                inference_time_ms = 0.0
                detected_boxes = []
                
                if self.mode == 'real' and self.model is not None:
                    # Capture real inference telemetry (simulate a dummy forward pass or read actual frame)
                    t0 = time.time()
                    # Perform dummy inference to get model latency or process a black image
                    dummy_frame = np.zeros((640, 640, 3), dtype=np.uint8)
                    _ = self.model(dummy_frame, verbose=False)
                    inference_time_ms = (time.time() - t0) * 1000.0
                else:
                    # Simulation mode latency: YOLOv9c usually runs at 15-25ms on GPU, 100-200ms on CPU
                    inference_time_ms = random.uniform(18.5, 24.2)
                
                # 2. Check if a pothole is triggered at this segment of the route
                for trigger in self.pothole_triggers:
                    trig_idx = trigger["index"]
                    # If we are in the segment before this index, and haven't triggered it yet
                    if self.current_route_index == trig_idx - 1 and step == 10:
                        trig_key = f"{trig_idx}_{lat}_{lon}"
                        if trig_key not in self.triggered_potholes:
                            self.triggered_potholes.add(trig_key)
                            self.send_detection_to_server(lat, lon, trigger)
                            
                # Sleep between steps (e.g. 0.5s per step)
                time.sleep(0.5)
                
            # Advance to next waypoint
            self.current_route_index = next_index
            # Reset triggers if we completed the route
            if self.current_route_index == 0:
                self.triggered_potholes.clear()

    def send_detection_to_server(self, lat, lon, trigger):
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        data = {
            "timestamp": timestamp,
            "latitude": lat,
            "longitude": lon,
            "diameter": trigger["diameter"],
            "depth": trigger["depth"],
            "severity": trigger["severity"],
            "image_path": "/static/assets/sample_pothole.jpg"
        }
        
        print(f"\n[ALERT] Pothole Detected at Lat: {lat:.6f}, Lon: {lon:.6f}!")
        print(f"        Diameter: {trigger['diameter']} cm | Depth: {trigger['depth']} cm | Severity: {trigger['severity']}")
        
        try:
            r = requests.post(API_URL, json=data)
            if r.status_code == 200:
                print("        Successfully logged to backend server database.")
            else:
                print(f"        Failed to log to server: Status {r.status_code}")
        except Exception as e:
            print(f"        Error connecting to Flask backend: {e}")

    def stop(self):
        self.running = False

if __name__ == '__main__':
    # Determine mode based on command arguments
    mode = 'simulation'
    if len(sys.argv) > 1:
        if sys.argv[1].lower() == 'real':
            mode = 'real'
            
    detector = PotholeDetector(mode=mode)
    try:
        detector.run_detection()
    except KeyboardInterrupt:
        print("\nStopping detector system...")
        detector.stop()
