import os
import json
import time
import base64
import uuid
import numpy as np
import cv2
from flask import Flask, render_template, jsonify, request, Response, send_from_directory
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__, template_folder='templates', static_folder='static')
DATABASE = 'potholes.db'
SNAPSHOT_DIR = os.path.join('static', 'snapshots')

# Ensure snapshot directory exists
os.makedirs(SNAPSHOT_DIR, exist_ok=True)

# ──────────────────────────────────────────────
# YOLOv9 Model Loader
# ──────────────────────────────────────────────
YOLO_MODEL = None
try:
    from ultralytics import YOLO
    MODEL_PATH = os.environ.get('YOLO_MODEL', 'yolov9t.pt')
    print(f"[INFO] Loading YOLOv9 model '{MODEL_PATH}'...")
    YOLO_MODEL = YOLO(MODEL_PATH)
    # Warmup with a dummy frame
    dummy = np.zeros((640, 640, 3), dtype=np.uint8)
    YOLO_MODEL(dummy, verbose=False)
    print("[INFO] YOLOv9 model loaded & warmed up successfully.")
except Exception as e:
    print(f"[WARN] Could not load YOLOv9 model: {e}")
    print("[WARN] Detection will use a fallback heuristic (dark-region detector).")

# ──────────────────────────────────────────────
# SSE client management
# ──────────────────────────────────────────────
import queue

class SSEBroadcaster:
    def __init__(self):
        self.listeners = []

    def listen(self):
        q = queue.Queue(maxsize=20)
        self.listeners.append(q)
        return q

    def broadcast(self, data_dict):
        payload = f"data: {json.dumps(data_dict)}\n\n"
        for i in reversed(range(len(self.listeners))):
            try:
                self.listeners[i].put_nowait(payload)
            except queue.Full:
                del self.listeners[i]

broadcaster = SSEBroadcaster()

# ──────────────────────────────────────────────
# Supabase Configuration
# ──────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

supabase = None
if SUPABASE_URL and SUPABASE_KEY:
    try:
        from supabase import create_client, Client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        print("[INFO] Connected to Supabase!")
    except Exception as e:
        print(f"[WARN] Failed to connect to Supabase: {e}")
else:
    print("[WARN] SUPABASE_URL or SUPABASE_KEY is missing. Database operations will fail.")

BUCKET_NAME = "snapshots"

# ──────────────────────────────────────────────
# Severity classification based on 3-Class YOLO Model
# ──────────────────────────────────────────────
def classify_severity_from_class(cls_name):
    # Mapping YOLO class to severity and estimated depth (cm)
    if cls_name == 'lubang_besar':
        return 'High', 15.0  # Estimated 15cm depth
    elif cls_name == 'lubang_sedang':
        return 'Medium', 8.0 # Estimated 8cm depth
    elif cls_name == 'lubang_kecil':
        return 'Low', 3.0    # Estimated 3cm depth
    else:
        # Fallback if the model outputs something else (like 'pothole')
        return 'Medium', 5.0

# ──────────────────────────────────────────────
# Fallback dark-region detector (no YOLO model)
# ──────────────────────────────────────────────
def fallback_detect(frame):
    """Simple heuristic: find large dark blobs on the lower half of the frame."""
    h, w = frame.shape[:2]
    roi = frame[h // 2:, :]   # bottom half = road surface
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 60, 255, cv2.THRESH_BINARY_INV)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    detections = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 800:
            continue
        x, y, bw, bh = cv2.boundingRect(cnt)
        y += h // 2  # offset back to full-frame coords
        conf = min(0.95, 0.50 + (area / (w * h)) * 5)
        detections.append({
            'x1': int(x), 'y1': int(y),
            'x2': int(x + bw), 'y2': int(y + bh),
            'confidence': round(conf, 3),
            'class': 'pothole'
        })
    return detections

# ──────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/stream')
def sse_stream():
    q = broadcaster.listen()
    def gen():
        while True:
            try:
                msg = q.get(timeout=20.0)
                yield msg
            except queue.Empty:
                yield ": keepalive\n\n"
    return Response(gen(), mimetype='text/event-stream')

# ── Core: receive a camera frame + GPS, run detection ──
@app.route('/api/detect-frame', methods=['POST'])
def detect_frame():
    data = request.json
    if not data or 'frame' not in data:
        return jsonify({'error': 'No frame data'}), 400

    # Decode base64 JPEG frame
    try:
        img_bytes = base64.b64decode(data['frame'].split(',')[-1])
        np_arr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify({'error': 'Invalid image'}), 400
    except Exception as e:
        return jsonify({'error': f'Decode error: {e}'}), 400

    fh, fw = frame.shape[:2]

    # GPS & speed from client
    latitude  = data.get('latitude', 0.0)
    longitude = data.get('longitude', 0.0)
    speed_mps = data.get('speed', 0)            # m/s from Geolocation API
    speed_kmh = round((speed_mps or 0) * 3.6, 1)  # convert to km/h

    # ── Run YOLOv9 or fallback ──
    detections = []
    inference_ms = 0

    if YOLO_MODEL is not None:
        t0 = time.time()
        results = YOLO_MODEL(frame, verbose=False, conf=0.25)
        inference_ms = round((time.time() - t0) * 1000, 1)

        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                # Accept any class as "pothole" for a single-class model,
                # or filter by class name if multi-class
                cls_name = r.names.get(cls_id, 'pothole')
                detections.append({
                    'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2,
                    'confidence': round(conf, 3),
                    'class': cls_name
                })
    else:
        t0 = time.time()
        detections = fallback_detect(frame)
        inference_ms = round((time.time() - t0) * 1000, 1)

    # ── Save detections to Supabase ──
    saved = []
    for det in detections:
        cls_name = det['class']
        severity, est_depth = classify_severity_from_class(cls_name)
        
        # Estimate diameter loosely from bounding box width (heuristics for 2D)
        bw = det['x2'] - det['x1']
        est_diameter = round((bw / fw) * 100, 1) # rough heuristic percentage
        
        confidence = det['confidence']

        # Save snapshot image locally first
        snap_name = f"{uuid.uuid4().hex[:12]}.jpg"
        snap_path = os.path.join(SNAPSHOT_DIR, snap_name)
        
        # Draw box on snapshot copy
        snap_frame = frame.copy()
        color = (0, 0, 255) if severity == 'High' else (0, 165, 255) if severity == 'Medium' else (0, 255, 0)
        cv2.rectangle(snap_frame, (det['x1'], det['y1']), (det['x2'], det['y2']), color, 3)
        label = f"{cls_name} {confidence*100:.0f}%"
        cv2.putText(snap_frame, label, (det['x1'], det['y1'] - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
        cv2.imwrite(snap_path, snap_frame)
        
        web_snap_path = f'/static/snapshots/{snap_name}'
        
        # Upload to Supabase Storage
        if supabase:
            try:
                with open(snap_path, "rb") as f:
                    supabase.storage.from_(BUCKET_NAME).upload(snap_name, f.read(), {"content-type": "image/jpeg"})
                # Get public URL
                web_snap_path = supabase.storage.from_(BUCKET_NAME).get_public_url(snap_name)
            except Exception as e:
                print(f"[ERROR] Supabase Storage upload failed: {e}")

        google_maps_url = f'https://www.google.com/maps?q={latitude},{longitude}'
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')

        record = {
            'timestamp': timestamp,
            'latitude': latitude,
            'longitude': longitude,
            'speed': speed_kmh,
            'diameter': est_diameter,
            'depth': est_depth,
            'confidence': confidence,
            'severity': severity,
            'snapshot_path': web_snap_path,
            'google_maps_url': google_maps_url
        }

        # Insert into Supabase PostgreSQL
        if supabase:
            try:
                res = supabase.table('potholes').insert(record).execute()
                if res.data:
                    record['id'] = res.data[0]['id']
                else:
                    record['id'] = int(time.time()) # fallback ID
            except Exception as e:
                print(f"[ERROR] Supabase Insert failed: {e}")
                record['id'] = int(time.time())
        else:
            record['id'] = int(time.time())

        saved.append(record)

        # Broadcast via SSE
        broadcaster.broadcast(record)

    return jsonify({
        'detections': detections,
        'saved': saved,
        'inference_ms': inference_ms,
        'speed_kmh': speed_kmh
    })

# ── API: list all saved potholes ──
@app.route('/api/potholes', methods=['GET'])
def get_potholes():
    if not supabase:
        return jsonify([])
    try:
        res = supabase.table('potholes').select('*').order('id', desc=True).execute()
        return jsonify(res.data)
    except Exception as e:
        print(f"[ERROR] Failed to fetch potholes: {e}")
        return jsonify([])

# ── API: stats ──
@app.route('/api/stats', methods=['GET'])
def get_stats():
    if not supabase:
        return jsonify({
            'total': 0, 'severity_distribution': {'Low':0, 'Medium':0, 'High':0},
            'avg_diameter': 0, 'avg_depth': 0, 'avg_speed': 0, 'trend': []
        })
    try:
        res = supabase.table('potholes').select('*').execute()
        data = res.data
        total = len(data)
        
        sev = {'Low': 0, 'Medium': 0, 'High': 0}
        avg_diam, avg_depth, avg_speed = 0, 0, 0
        
        if total > 0:
            for row in data:
                sev[row['severity']] = sev.get(row['severity'], 0) + 1
                avg_diam += row.get('diameter', 0)
                avg_depth += row.get('depth', 0)
                avg_speed += row.get('speed', 0)
                
            avg_diam = round(avg_diam / total, 1)
            avg_depth = round(avg_depth / total, 1)
            avg_speed = round(avg_speed / total, 1)
            
        trend_dict = {}
        for row in data:
            date_str = row['timestamp'][:10]
            trend_dict[date_str] = trend_dict.get(date_str, 0) + 1
            
        sorted_dates = sorted(trend_dict.keys(), reverse=True)[:7]
        trend = [{'date': d, 'count': trend_dict[d]} for d in reversed(sorted_dates)]
        
        return jsonify({
            'total': total,
            'severity_distribution': sev,
            'avg_diameter': avg_diam,
            'avg_depth': avg_depth,
            'avg_speed': avg_speed,
            'trend': trend
        })
    except Exception as e:
        print(f"[ERROR] Failed to fetch stats: {e}")
        return jsonify({'error': str(e)})

# ── API: delete a pothole record ──
@app.route('/api/potholes/<int:pid>', methods=['DELETE'])
def delete_pothole(pid):
    if supabase:
        try:
            supabase.table('potholes').delete().eq('id', pid).execute()
        except Exception as e:
            print(f"[ERROR] Failed to delete: {e}")
    return jsonify({'deleted': pid})

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 7860))
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False, threaded=True)
