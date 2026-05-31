import os

code = """import os
import json
import time
import base64
import uuid
import queue
import logging
from flask import Flask, render_template, jsonify, request, Response, send_from_directory
from dotenv import load_dotenv

load_dotenv()

# ──────────────────────────────────────────────
# Konfigurasi Logging Ke File 'app.log'
# ──────────────────────────────────────────────
log_path = os.path.join(os.path.dirname(__file__), 'app.log')
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(log_path, encoding="utf-8"),
        logging.StreamHandler()
    ]
)

app = Flask(__name__, template_folder='templates', static_folder='static')

SNAPSHOT_DIR = os.path.join('static', 'snapshots')
os.makedirs(SNAPSHOT_DIR, exist_ok=True)

# ──────────────────────────────────────────────
# Filter Konfigurasi — Konteks Jalan Raya
# ──────────────────────────────────────────────
CONF_THRESHOLD      = float(os.environ.get('CONF_THRESHOLD',      '0.25'))
ROI_BOTTOM_FRAC     = float(os.environ.get('ROI_BOTTOM_FRAC',     '0.35'))
MIN_ASPECT_RATIO    = float(os.environ.get('MIN_ASPECT_RATIO',    '0.25'))
MAX_ASPECT_RATIO    = float(os.environ.get('MAX_ASPECT_RATIO',    '5.0'))
MIN_BOX_AREA_FRAC   = float(os.environ.get('MIN_BOX_AREA_FRAC',   '0.002'))
MAX_BOX_AREA_FRAC   = float(os.environ.get('MAX_BOX_AREA_FRAC',   '0.55'))
MIN_SPEED_KMH       = float(os.environ.get('MIN_SPEED_KMH',       '2.0'))
ROAD_COLOR_CHECK    = os.environ.get('ROAD_COLOR_CHECK', 'true').lower() == 'true'

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
        payload = f"data: {json.dumps(data_dict)}\\n\\n"
        for i in reversed(range(len(self.listeners))):
            try:
                self.listeners[i].put_nowait(payload)
            except queue.Full:
                del self.listeners[i]

broadcaster = SSEBroadcaster()

# ──────────────────────────────────────────────
# Database (Supabase) Setup
# ──────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

_supabase_client = None
_db_available = False

def _ensure_db():
    global _supabase_client, _db_available
    if _supabase_client is None and SUPABASE_URL and SUPABASE_KEY:
        try:
            from supabase import create_client
            _supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
            _db_available = True
        except Exception as e:
            logging.error(f"Supabase init failed: {e}")
    return _db_available

# ──────────────────────────────────────────────
# YOLOv9 Model Loader (Lazy Load)
# ──────────────────────────────────────────────
MODEL_PATH = os.environ.get('YOLO_MODEL', 'yolov9t.pt')

_model_loaded = False
model = None
cv2 = None
np = None

def load_model_lazy():
    global model, _model_loaded, cv2, np
    if not _model_loaded:
        logging.info("Memuat model YOLOv9 untuk pertama kali...")
        import cv2 as _cv2
        import numpy as _np
        cv2 = _cv2
        np = _np
        try:
            from ultralytics import YOLO
            model = YOLO(MODEL_PATH)
            _model_loaded = True
            logging.info("Model YOLOv9 berhasil dimuat!")
        except Exception as e:
            logging.error(f"Gagal memuat YOLO: {e}")
            raise e

def is_valid_pothole(x1, y1, x2, y2, frame_w, frame_h, conf):
    if conf < CONF_THRESHOLD: return False
    # ROI check (bottom fraction of screen)
    if y2 < (frame_h * (1.0 - ROI_BOTTOM_FRAC)): return False
    
    w = x2 - x1
    h = y2 - y1
    if h == 0: return False
    aspect_ratio = w / h
    if not (MIN_ASPECT_RATIO <= aspect_ratio <= MAX_ASPECT_RATIO): return False
    
    box_area = w * h
    frame_area = frame_w * frame_h
    area_frac = box_area / frame_area
    if not (MIN_BOX_AREA_FRAC <= area_frac <= MAX_BOX_AREA_FRAC): return False
    return True

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
                yield ": keepalive\\n\\n"
    return Response(gen(), mimetype='text/event-stream')

# ──────────────────────────────────────────────
# API: Deteksi Gambar dengan YOLO Server-Side
# ──────────────────────────────────────────────
DETECTION_COOLDOWN_SEC = 5
_last_saved_time = 0.0

@app.route('/api/detect', methods=['POST'])
def process_image():
    global _last_saved_time
    load_model_lazy()

    data = request.json
    if not data or 'image' not in data:
        return jsonify({'error': 'No image data'}), 400

    now = time.time()
    
    # Ambil data tambahan dari GPS
    latitude = float(data.get('latitude', 0))
    longitude = float(data.get('longitude', 0))
    speed_kmh = float(data.get('speed', 0))
    
    # Decode image
    try:
        img_data = data['image'].split(',')[1]
        img_bytes = base64.b64decode(img_data)
        np_arr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    except Exception as e:
        return jsonify({'error': f'Invalid image format: {e}'}), 400

    if frame is None:
        return jsonify({'error': 'Failed to decode image'}), 400

    h, w, _ = frame.shape
    
    t0 = time.time()
    results = model.predict(frame, conf=CONF_THRESHOLD, verbose=False)
    inference_ms = int((time.time() - t0) * 1000)
    
    detections = []
    saved = []
    
    for r in results:
        boxes = r.boxes
        for box in boxes:
            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
            conf = float(box.conf[0].cpu().numpy())
            
            if not is_valid_pothole(x1, y1, x2, y2, w, h, conf):
                continue

            bw = x2 - x1
            bh = y2 - y1
            
            # Estimasi kasaran (menggunakan faktor kalibrasi fiktif)
            pixel_to_cm = 0.15 
            est_diameter = round(bw * pixel_to_cm, 1)
            est_depth = round(est_diameter * 0.15, 1)
            
            if est_depth > 10: severity = 'High'
            elif est_depth > 5: severity = 'Medium'
            else: severity = 'Low'

            detections.append({
                'box': [int(x1), int(y1), int(bw), int(bh)],
                'confidence': round(conf, 2),
                'diameter': est_diameter,
                'depth': est_depth,
                'severity': severity
            })
            
            # Hanya simpan 1 snapshot per cooldown
            if (now - _last_saved_time) >= DETECTION_COOLDOWN_SEC:
                _last_saved_time = now
                
                # Gambar kotak merah di frame
                cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), (0, 0, 255), 3)
                cv2.putText(frame, f"{severity} ({conf:.2f})", (int(x1), int(y1)-10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
                
                snap_name = f"{uuid.uuid4().hex[:12]}.jpg"
                snap_path = os.path.join(SNAPSHOT_DIR, snap_name)
                cv2.imwrite(snap_path, frame)
                web_snap_path = f'/static/snapshots/{snap_name}'
                
                google_maps_url = f'https://www.google.com/maps?q={latitude},{longitude}'
                timestamp_str = time.strftime('%Y-%m-%d %H:%M:%S')
                
                _ensure_db()
                new_id = int(time.time())
                if _db_available:
                    try:
                        db_data = {
                            "timestamp": timestamp_str,
                            "latitude": latitude,
                            "longitude": longitude,
                            "speed": speed_kmh,
                            "diameter": est_diameter,
                            "depth": est_depth,
                            "confidence": conf,
                            "severity": severity,
                            "snapshot_path": web_snap_path,
                            "google_maps_url": google_maps_url
                        }
                        res = _supabase_client.table("potholes").insert(db_data).execute()
                        if res.data:
                            new_id = res.data[0]['id']
                    except Exception as e:
                        logging.warning(f"Supabase insert failed: {e}")
                
                record = {
                    'id': new_id,
                    'timestamp': timestamp_str,
                    'latitude': latitude,
                    'longitude': longitude,
                    'speed': speed_kmh,
                    'diameter': est_diameter,
                    'depth': est_depth,
                    'confidence': conf,
                    'severity': severity,
                    'snapshot_path': web_snap_path,
                    'google_maps_url': google_maps_url
                }
                
                saved.append(record)
                broadcaster.broadcast(record)
                
    return jsonify({
        'detections': detections,
        'saved': saved,
        'inference_ms': inference_ms
    })

# ──────────────────────────────────────────────
# Database APIs
# ──────────────────────────────────────────────
@app.route('/api/potholes', methods=['GET'])
def get_potholes():
    if not _ensure_db(): return jsonify([])
    try:
        res = _supabase_client.table("potholes").select("*").order("id", desc=True).execute()
        return jsonify(res.data)
    except Exception as e:
        return jsonify([])

@app.route('/api/stats', methods=['GET'])
def get_stats():
    empty = {'total': 0, 'severity_distribution': {'Low': 0, 'Medium': 0, 'High': 0}, 'avg_diameter': 0, 'avg_depth': 0, 'avg_speed': 0, 'trend': []}
    if not _ensure_db(): return jsonify(empty)
    try:
        res = _supabase_client.table("potholes").select("*").execute()
        rows = res.data
        if not rows: return jsonify(empty)
        
        total = len(rows)
        sev = {'Low': 0, 'Medium': 0, 'High': 0}
        sum_dia = sum_dep = sum_spd = 0
        from collections import defaultdict
        trend_dict = defaultdict(int)

        for r in rows:
            sev_val = r.get("severity", "Low")
            if sev_val in sev: sev[sev_val] += 1
            else: sev["Low"] += 1
            sum_dia += r.get("diameter", 0)
            sum_dep += r.get("depth", 0)
            sum_spd += r.get("speed", 0)
            date_str = str(r.get("timestamp", ""))[:10]
            if date_str: trend_dict[date_str] += 1
                
        trend = [{"date": k, "count": v} for k, v in sorted(trend_dict.items())][-7:]
        return jsonify({
            'total': total,
            'severity_distribution': sev,
            'avg_diameter': round(sum_dia/total, 1),
            'avg_depth': round(sum_dep/total, 1),
            'avg_speed': round(sum_spd/total, 1),
            'trend': trend
        })
    except:
        return jsonify(empty)

@app.route('/api/potholes/<int:pid>', methods=['DELETE'])
def delete_pothole(pid):
    if not _ensure_db(): return jsonify({"success": False}), 500
    try:
        _supabase_client.table("potholes").delete().eq("id", pid).execute()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    # Pastikan server berjalan di 0.0.0.0 untuk Hugging Face Spaces Docker
    app.run(host='0.0.0.0', port=7860, debug=False)
"""

with open('server.py', 'w', encoding='utf-8') as f:
    f.write(code)
print("server.py completely regenerated to use Server-Side YOLO + Supabase")
