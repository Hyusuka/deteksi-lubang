import os
import json
import time
import base64
import uuid
import queue
import logging
import sqlite3
from flask import Flask, render_template, jsonify, request, Response

np = None
cv2 = None

# ──────────────────────────────────────────────
# Konfigurasi Logging
# ──────────────────────────────────────────────
log_path = os.path.join(os.path.dirname(__file__), '..', 'logs', 'app.log')
os.makedirs(os.path.dirname(log_path), exist_ok=True)
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s', handlers=[logging.FileHandler(log_path, encoding="utf-8"), logging.StreamHandler()])

app = Flask(__name__, template_folder='templates', static_folder='static')
SNAPSHOT_DIR = os.path.join(app.static_folder, 'snapshots')
os.makedirs(SNAPSHOT_DIR, exist_ok=True)

# ──────────────────────────────────────────────
# Local SQLite DB (Pengganti Supabase & MySQL)
# ──────────────────────────────────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'database', 'potholes.db')

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS potholes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            latitude REAL,
            longitude REAL,
            speed REAL,
            diameter REAL,
            depth REAL,
            confidence REAL,
            severity TEXT,
            snapshot_path TEXT,
            google_maps_url TEXT
        )
    ''')
    conn.commit()
    conn.close()

init_db()

# ──────────────────────────────────────────────
# YOLO Model Loader
# ──────────────────────────────────────────────
YOLO_MODEL = None
_model_loaded = False
MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'best.pt')

def load_model_lazy():
    global YOLO_MODEL, _model_loaded, np, cv2
    if _model_loaded: return
    if np is None:
        import numpy as _np
        globals()['np'] = _np
    if cv2 is None:
        import cv2 as _cv2
        globals()['cv2'] = _cv2

    logging.info("Memulai pemuatan model YOLOv9 lokal...")
    try:
        from ultralytics import YOLO
        YOLO_MODEL = YOLO(MODEL_PATH)
        dummy = np.zeros((640, 640, 3), dtype=np.uint8)
        YOLO_MODEL(dummy, verbose=False)
        logging.info("YOLOv9 model loaded successfully.")
    except Exception as e:
        logging.error(f"Gagal load model: {e}")
    _model_loaded = True

# ──────────────────────────────────────────────
# Tracker Anti Guncangan (EMA + IoU)
# ──────────────────────────────────────────────
class PotholeTracker:
    def __init__(self, alpha=0.5, max_missed=2):
        self.tracks = []
        self.alpha = alpha
        self.max_missed = max_missed

    def iou(self, boxA, boxB):
        xA = max(boxA[0], boxB[0])
        yA = max(boxA[1], boxB[1])
        xB = min(boxA[2], boxB[2])
        yB = min(boxA[3], boxB[3])
        interArea = max(0, xB - xA) * max(0, yB - yA)
        boxAArea = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1])
        boxBArea = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1])
        if float(boxAArea + boxBArea - interArea) == 0: return 0.0
        return interArea / float(boxAArea + boxBArea - interArea)

    def update(self, detections):
        new_tracks = []
        unmatched_dets = list(detections)

        for track in self.tracks:
            best_iou = 0
            best_det = None
            for det in unmatched_dets:
                if track['class'] == det['class']:
                    iou_val = self.iou((track['x1'], track['y1'], track['x2'], track['y2']), 
                                       (det['x1'], det['y1'], det['x2'], det['y2']))
                    if iou_val > best_iou:
                        best_iou = iou_val
                        best_det = det
            
            if best_iou > 0.2: # Ambang batas diturunkan agar lebih stabil walau guncangan besar
                track['x1'] = int(self.alpha * best_det['x1'] + (1 - self.alpha) * track['x1'])
                track['y1'] = int(self.alpha * best_det['y1'] + (1 - self.alpha) * track['y1'])
                track['x2'] = int(self.alpha * best_det['x2'] + (1 - self.alpha) * track['x2'])
                track['y2'] = int(self.alpha * best_det['y2'] + (1 - self.alpha) * track['y2'])
                track['confidence'] = best_det['confidence']
                track['missed'] = 0
                new_tracks.append(track)
                unmatched_dets.remove(best_det)
            else:
                track['missed'] += 1
                if track['missed'] <= self.max_missed:
                    new_tracks.append(track)
        
        for det in unmatched_dets:
            new_tracks.append({
                'x1': det['x1'], 'y1': det['y1'], 'x2': det['x2'], 'y2': det['y2'],
                'confidence': det['confidence'], 'class': det['class'], 'missed': 0
            })
            
        self.tracks = new_tracks
        return [t for t in self.tracks if t['missed'] == 0]

tracker = PotholeTracker(alpha=0.45) # Alpha < 1 memberi efek smoothing (anti-guncangan)

# ──────────────────────────────────────────────
# SSE client management
# ──────────────────────────────────────────────
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
DETECTION_COOLDOWN_SEC = 5
_last_saved_time = 0.0

# ──────────────────────────────────────────────
# Helper Estimasi Dimensi
# ──────────────────────────────────────────────
def calculate_volume(diameter, depth):
    radius = diameter / 2.0
    vol_cm3 = 0.5 * 3.14159 * (radius ** 2) * depth
    return max(0.1, round(vol_cm3 / 1000.0, 1))

def estimate_pothole_dimensions(bw, fw, cls_name):
    diameter_cm = max(5.0, round((bw / fw) * 200.0, 1))
    
    if cls_name == 'lubang_besar': base_ratio = 0.25
    elif cls_name == 'lubang_kecil': base_ratio = 0.12
    else: base_ratio = 0.18
        
    depth_cm = max(2.0, min(25.0, round(diameter_cm * base_ratio, 1)))
    
    if depth_cm >= 12.0: severity = 'High'
    elif depth_cm >= 6.0: severity = 'Medium'
    else: severity = 'Low'
        
    return severity, diameter_cm, depth_cm, calculate_volume(diameter_cm, depth_cm)

# ──────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/gallery')
def gallery():
    return render_template('gallery.html')

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

@app.route('/api/detect-frame', methods=['POST'])
def detect_frame():
    load_model_lazy()
    data = request.json
    if not data or 'frame' not in data:
        return jsonify({'error': 'No frame data'}), 400

    try:
        img_bytes = base64.b64decode(data['frame'].split(',')[-1])
        np_arr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    except:
        return jsonify({'error': 'Decode error'}), 400

    if frame is None: return jsonify({'error': 'Invalid image'}), 400

    fh, fw = frame.shape[:2]
    latitude = data.get('latitude', 0.0)
    longitude = data.get('longitude', 0.0)
    speed_kmh = round((data.get('speed', 0) or 0) * 3.6, 1)

    t0 = time.time()
    raw_detections = []
    
    if YOLO_MODEL is not None:
        results = YOLO_MODEL(frame, verbose=False, conf=0.25)
        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                cls_name = r.names.get(cls_id, 'pothole')
                # Filter asumsikan hanya objek di bagian bawah layar yang relevan (jalan)
                center_y = (y1 + y2) / 2
                if center_y > fh * 0.35:
                    raw_detections.append({'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'confidence': round(conf, 3), 'class': cls_name})

    # Terapkan Anti-Guncangan pada Bounding Box
    detections = tracker.update(raw_detections)
    inference_ms = round((time.time() - t0) * 1000, 1)

    global _last_saved_time
    saved = []
    now = time.time()
    
    if detections and (now - _last_saved_time) >= DETECTION_COOLDOWN_SEC:
        det = sorted(detections, key=lambda x: x['confidence'], reverse=True)[0]
        severity, diameter_cm, depth_cm, volume_liters = estimate_pothole_dimensions(det['x2'] - det['x1'], fw, det['class'])
        
        _last_saved_time = now
        snap_name = f"{uuid.uuid4().hex[:12]}.jpg"
        snap_path = os.path.join(SNAPSHOT_DIR, snap_name)
        snap_frame = frame.copy()

        color = (0, 0, 255) if severity == 'High' else (0, 165, 255) if severity == 'Medium' else (0, 255, 0)
        cv2.rectangle(snap_frame, (det['x1'], det['y1']), (det['x2'], det['y2']), color, 3)
        label = f"{det['class']} {det['confidence']*100:.0f}%"
        cv2.putText(snap_frame, label, (det['x1'], det['y1'] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
        cv2.imwrite(snap_path, snap_frame)

        web_snap_path = f'/static/snapshots/{snap_name}'
        google_maps_url = f'https://www.google.com/maps?q={latitude},{longitude}'
        timestamp_str = time.strftime('%Y-%m-%d %H:%M:%S')

        conn = get_db()
        cur = conn.cursor()
        cur.execute('''
            INSERT INTO potholes (timestamp, latitude, longitude, speed, diameter, depth, confidence, severity, snapshot_path, google_maps_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (timestamp_str, latitude, longitude, speed_kmh, diameter_cm, depth_cm, det['confidence'], severity, web_snap_path, google_maps_url))
        new_id = cur.lastrowid
        conn.commit()
        conn.close()

        record = {
            'id': new_id, 'timestamp': timestamp_str, 'latitude': latitude, 'longitude': longitude,
            'speed': speed_kmh, 'diameter': diameter_cm, 'depth': depth_cm, 'volume': volume_liters,
            'confidence': det['confidence'], 'severity': severity, 'snapshot_path': web_snap_path,
            'google_maps_url': google_maps_url
        }
        saved.append(record)
        broadcaster.broadcast(record)

    return jsonify({'detections': detections, 'saved': saved, 'inference_ms': inference_ms, 'speed_kmh': speed_kmh})

@app.route('/api/potholes', methods=['GET'])
def get_potholes():
    conn = get_db()
    rows = conn.execute("SELECT * FROM potholes ORDER BY id DESC LIMIT 100").fetchall()
    conn.close()
    data = []
    for r in rows:
        d = dict(r)
        d['volume'] = calculate_volume(d['diameter'], d['depth'])
        data.append(d)
    return jsonify(data)

@app.route('/api/stats', methods=['GET'])
def get_stats():
    conn = get_db()
    cur = conn.cursor()
    total = cur.execute("SELECT COUNT(*) FROM potholes").fetchone()[0]
    sev_rows = cur.execute("SELECT severity, COUNT(*) FROM potholes GROUP BY severity").fetchall()
    sev = {'Low': 0, 'Medium': 0, 'High': 0}
    for r in sev_rows: sev[r[0]] = r[1]
    avgs = cur.execute("SELECT COALESCE(AVG(diameter),0), COALESCE(AVG(depth),0), COALESCE(AVG(speed),0) FROM potholes").fetchone()
    conn.close()
    
    return jsonify({
        'total': total,
        'severity_distribution': sev,
        'avg_diameter': round(avgs[0], 1),
        'avg_depth': round(avgs[1], 1),
        'avg_speed': round(avgs[2], 1),
        'trend': [] # disederhanakan
    })

@app.route('/api/potholes/<int:pid>', methods=['DELETE'])
def delete_pothole(pid):
    conn = get_db()
    conn.execute("DELETE FROM potholes WHERE id = ?", (pid,))
    conn.commit()
    conn.close()
    return jsonify({'deleted': pid})

@app.errorhandler(Exception)
def handle_exception(e):
    logging.exception("Error:")
    return jsonify({'error': 'Server Error', 'message': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=7860, debug=False, use_reloader=False, threaded=True)
