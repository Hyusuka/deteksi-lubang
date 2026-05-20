import os
import sqlite3
import json
import time
import base64
import uuid
import numpy as np
import cv2
from flask import Flask, render_template, jsonify, request, Response, send_from_directory

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
# Database helpers
# ──────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS potholes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            speed REAL DEFAULT 0,
            diameter REAL DEFAULT 0,
            depth REAL DEFAULT 0,
            confidence REAL DEFAULT 0,
            severity TEXT NOT NULL,
            snapshot_path TEXT,
            google_maps_url TEXT
        )
    ''')
    conn.commit()
    conn.close()

init_db()

# ──────────────────────────────────────────────
# Severity classification based on bounding-box area
# ──────────────────────────────────────────────
def classify_severity(box_w, box_h, frame_w, frame_h):
    area_ratio = (box_w * box_h) / (frame_w * frame_h) if frame_w and frame_h else 0
    if area_ratio > 0.08:
        return 'High', round(box_w * 0.15, 1), round(box_h * 0.10, 1)   # estimated diameter, depth
    elif area_ratio > 0.03:
        return 'Medium', round(box_w * 0.12, 1), round(box_h * 0.07, 1)
    else:
        return 'Low', round(box_w * 0.08, 1), round(box_h * 0.04, 1)

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

    # ── Save detections to DB ──
    saved = []
    for det in detections:
        bw = det['x2'] - det['x1']
        bh = det['y2'] - det['y1']
        severity, est_diameter, est_depth = classify_severity(bw, bh, fw, fh)
        confidence = det['confidence']

        # Save snapshot image
        snap_name = f"{uuid.uuid4().hex[:12]}.jpg"
        snap_path = os.path.join(SNAPSHOT_DIR, snap_name)
        # Draw box on snapshot copy
        snap_frame = frame.copy()
        color = (0, 0, 255) if severity == 'High' else (0, 165, 255) if severity == 'Medium' else (0, 255, 0)
        cv2.rectangle(snap_frame, (det['x1'], det['y1']), (det['x2'], det['y2']), color, 3)
        label = f"Pothole {confidence*100:.0f}%"
        cv2.putText(snap_frame, label, (det['x1'], det['y1'] - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
        cv2.imwrite(snap_path, snap_frame)
        web_snap_path = f'/static/snapshots/{snap_name}'

        google_maps_url = f'https://www.google.com/maps?q={latitude},{longitude}'
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')

        conn = get_db()
        cur = conn.execute('''
            INSERT INTO potholes
                (timestamp, latitude, longitude, speed, diameter, depth,
                 confidence, severity, snapshot_path, google_maps_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (timestamp, latitude, longitude, speed_kmh,
              est_diameter, est_depth, confidence, severity,
              web_snap_path, google_maps_url))
        new_id = cur.lastrowid
        conn.commit()
        conn.close()

        record = {
            'id': new_id,
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
    conn = get_db()
    rows = conn.execute('SELECT * FROM potholes ORDER BY id DESC').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

# ── API: stats ──
@app.route('/api/stats', methods=['GET'])
def get_stats():
    conn = get_db()
    total = conn.execute('SELECT COUNT(*) FROM potholes').fetchone()[0]
    sev = {r[0]: r[1] for r in conn.execute(
        'SELECT severity, COUNT(*) FROM potholes GROUP BY severity').fetchall()}
    for s in ('Low', 'Medium', 'High'):
        sev.setdefault(s, 0)
    avg = conn.execute('SELECT AVG(diameter), AVG(depth), AVG(speed) FROM potholes').fetchone()
    trend = [{'date': r[0], 'count': r[1]} for r in reversed(
        conn.execute('SELECT SUBSTR(timestamp,1,10) d, COUNT(*) FROM potholes GROUP BY d ORDER BY d DESC LIMIT 7').fetchall())]
    conn.close()
    return jsonify({
        'total': total,
        'severity_distribution': sev,
        'avg_diameter': round(avg[0] or 0, 1),
        'avg_depth': round(avg[1] or 0, 1),
        'avg_speed': round(avg[2] or 0, 1),
        'trend': trend
    })

# ── API: delete a pothole record ──
@app.route('/api/potholes/<int:pid>', methods=['DELETE'])
def delete_pothole(pid):
    conn = get_db()
    conn.execute('DELETE FROM potholes WHERE id = ?', (pid,))
    conn.commit()
    conn.close()
    return jsonify({'deleted': pid})

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 7860))
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False, threaded=True)
