import os
import json
import time
import base64
import uuid
import queue
import logging
import sqlite3
import threading
import tempfile
import shutil
from flask import Flask, render_template, jsonify, request, Response, send_from_directory
from flask_cors import CORS

np = None
cv2 = None

# ──────────────────────────────────────────────
# Konfigurasi Logging
# ──────────────────────────────────────────────
log_path = os.path.join(os.path.dirname(__file__), '..', 'logs', 'app.log')
os.makedirs(os.path.dirname(log_path), exist_ok=True)
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s', handlers=[logging.FileHandler(log_path, encoding="utf-8"), logging.StreamHandler()])

app = Flask(__name__, template_folder='templates', static_folder='static')
CORS(app)
SNAPSHOT_DIR = os.path.join(app.static_folder, 'snapshots')
os.makedirs(SNAPSHOT_DIR, exist_ok=True)

# ──────────────────────────────────────────────
# Local SQLite DB (Pengganti Supabase & MySQL)
# ──────────────────────────────────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'database', 'potholes.db')
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

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
# Helper: Gambar Overlay Segmentasi pada Frame
# ──────────────────────────────────────────────
def draw_segmentation_overlay(frame, points, color, alpha=0.3):
    """Gambar poligon segmentasi semi-transparan di dalam area bounding box.
    
    Args:
        frame: numpy array (BGR image) — akan dimodifikasi in-place.
        points: list of [x, y] koordinat poligon segmentasi.
        color: tuple BGR warna (e.g. (0, 0, 255) untuk merah).
        alpha: tingkat transparansi fill (0.0 = transparan, 1.0 = solid).
    """
    if not points or len(points) < 3:
        return
    pts = np.array(points, dtype=np.int32).reshape((-1, 1, 2))
    # Buat overlay transparan: salin frame, gambar fill, lalu blend
    overlay = frame.copy()
    cv2.fillPoly(overlay, [pts], color)
    cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, frame)
    # Gambar garis kontur (outline) di sekeliling mask
    cv2.polylines(frame, [pts], isClosed=True, color=color, thickness=2)

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
                track['segmentation'] = best_det.get('segmentation', [])  # Update poligon mask terbaru
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
                'confidence': det['confidence'], 'class': det['class'],
                'segmentation': det.get('segmentation', []),  # Simpan poligon mask
                'missed': 0
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
            # Ambil data segmentasi mask (poligon kontur) jika tersedia
            masks_xy = r.masks.xy if r.masks is not None else []
            for idx, box in enumerate(r.boxes):
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                cls_name = r.names.get(cls_id, 'pothole')
                # Ekstrak koordinat poligon segmentasi untuk deteksi ini
                seg_points = []
                if idx < len(masks_xy):
                    seg_points = [[int(p[0]), int(p[1])] for p in masks_xy[idx]]
                # Filter asumsikan hanya objek di bagian bawah layar yang relevan (jalan)
                center_y = (y1 + y2) / 2
                if center_y > fh * 0.35:
                    raw_detections.append({'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'confidence': round(conf, 3), 'class': cls_name, 'segmentation': seg_points})

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
        # Gambar segmentasi mask (poligon semi-transparan) di dalam bounding box
        seg_points = det.get('segmentation', [])
        if seg_points and len(seg_points) >= 3:
            draw_segmentation_overlay(snap_frame, seg_points, color, alpha=0.3)
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

# ──────────────────────────────────────────────
# Halaman Uji Deteksi (Upload Gambar / Video)
# ──────────────────────────────────────────────
RESULTS_DIR = os.path.join(app.static_folder, 'results')
os.makedirs(RESULTS_DIR, exist_ok=True)

@app.route('/test')
def test_page():
    return render_template('test.html')

@app.route('/api/detect-image', methods=['POST'])
def detect_image():
    """Deteksi lubang dari gambar yang di-upload (file upload)"""
    load_model_lazy()

    if 'image' not in request.files:
        return jsonify({'error': 'Tidak ada file gambar'}), 400

    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'Nama file kosong'}), 400

    try:
        img_bytes = file.read()
        np_arr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    except Exception as e:
        return jsonify({'error': f'Gagal decode gambar: {str(e)}'}), 400

    if frame is None:
        return jsonify({'error': 'Format gambar tidak valid'}), 400

    fh, fw = frame.shape[:2]
    conf_threshold = float(request.form.get('confidence', 0.15))
    t0 = time.time()
    detections = []

    if YOLO_MODEL is not None:
        # Gunakan imgsz lebih besar untuk gambar statis (lebih akurat untuk objek kecil/jauh)
        results = YOLO_MODEL(frame, verbose=False, conf=conf_threshold, imgsz=1280)
        print(f"[detect-image] conf={conf_threshold}, frame={fw}x{fh}, boxes found: {sum(len(r.boxes) for r in results)}")
        for r in results:
            # Ambil data segmentasi mask (poligon kontur) jika tersedia
            masks_xy = r.masks.xy if r.masks is not None else []
            for idx, box in enumerate(r.boxes):
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                cls_name = r.names.get(cls_id, 'pothole')
                # Ekstrak koordinat poligon segmentasi untuk deteksi ini
                seg_points = []
                if idx < len(masks_xy):
                    seg_points = [[int(p[0]), int(p[1])] for p in masks_xy[idx]]
                print(f"  -> {cls_name} conf={conf:.3f} bbox=[{x1},{y1},{x2},{y2}] mask_points={len(seg_points)}")

                bw = x2 - x1
                severity, diameter_cm, depth_cm, volume_liters = estimate_pothole_dimensions(bw, fw, cls_name)

                detections.append({
                    'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2,
                    'confidence': round(conf, 3),
                    'class': cls_name,
                    'severity': severity,
                    'diameter': diameter_cm,
                    'depth': depth_cm,
                    'volume': volume_liters,
                    'segmentation': seg_points
                })

    inference_ms = round((time.time() - t0) * 1000, 1)

    # Gambar segmentasi mask dan bounding box pada frame
    annotated = frame.copy()
    for det in detections:
        color_map = {'High': (0, 0, 255), 'Medium': (0, 165, 255), 'Low': (0, 255, 0)}
        color = color_map.get(det['severity'], (0, 255, 0))
        # Gambar segmentasi mask (poligon semi-transparan) di dalam bounding box
        seg_points = det.get('segmentation', [])
        if seg_points and len(seg_points) >= 3:
            draw_segmentation_overlay(annotated, seg_points, color, alpha=0.3)
        cv2.rectangle(annotated, (det['x1'], det['y1']), (det['x2'], det['y2']), color, 3)

        label = f"{det['class']} {det['confidence']*100:.0f}% | {det['severity']}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 2)
        cv2.rectangle(annotated, (det['x1'], det['y1'] - th - 10), (det['x1'] + tw + 10, det['y1']), color, -1)
        cv2.putText(annotated, label, (det['x1'] + 5, det['y1'] - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)

    # Encode hasil ke base64
    _, buffer = cv2.imencode('.jpg', annotated, [cv2.IMWRITE_JPEG_QUALITY, 90])
    result_b64 = base64.b64encode(buffer).decode('utf-8')

    return jsonify({
        'result_image': f'data:image/jpeg;base64,{result_b64}',
        'detections': detections,
        'inference_ms': inference_ms,
        'image_size': {'width': fw, 'height': fh},
        'total_detected': len(detections)
    })


# ── Video processing state tracking ──
_video_jobs = {}

@app.route('/api/detect-video', methods=['POST'])
def detect_video():
    """Deteksi lubang dari video yang di-upload (proses frame-by-frame)"""
    load_model_lazy()

    if 'video' not in request.files:
        return jsonify({'error': 'Tidak ada file video'}), 400

    file = request.files['video']
    if file.filename == '':
        return jsonify({'error': 'Nama file kosong'}), 400

    # Simpan video sementara
    job_id = uuid.uuid4().hex[:12]
    temp_dir = os.path.join(RESULTS_DIR, f'temp_{job_id}')
    os.makedirs(temp_dir, exist_ok=True)

    input_path = os.path.join(temp_dir, 'input' + os.path.splitext(file.filename)[1])
    file.save(input_path)

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        shutil.rmtree(temp_dir, ignore_errors=True)
        return jsonify({'error': 'Gagal membuka video. Format tidak didukung.'}), 400

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    vw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    vh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    # Inisialisasi job state
    _video_jobs[job_id] = {
        'status': 'processing',
        'progress': 0,
        'total_frames': total_frames,
        'processed_frames': 0,
        'detections': [],
        'result_path': None,
        'error': None
    }

    conf_threshold = float(request.form.get('confidence', 0.15))

    # Proses di background thread
    def process_video():
        try:
            cap2 = cv2.VideoCapture(input_path)
            output_name = f'result_{job_id}.mp4'
            output_path = os.path.join(RESULTS_DIR, output_name)

            fourcc = cv2.VideoWriter_fourcc(*'mp4v')
            out = cv2.VideoWriter(output_path, fourcc, fps, (vw, vh))

            frame_skip = max(1, int(fps / 5))  # Proses ~5 frame per detik
            frame_idx = 0
            all_detections = []

            while cap2.isOpened():
                ret, frame = cap2.read()
                if not ret:
                    break

                if frame_idx % frame_skip == 0 and YOLO_MODEL is not None:
                    results = YOLO_MODEL(frame, verbose=False, conf=conf_threshold)
                    frame_dets = []
                    for r in results:
                        # Ambil data segmentasi mask (poligon kontur) jika tersedia
                        masks_xy = r.masks.xy if r.masks is not None else []
                        for idx, box in enumerate(r.boxes):
                            cls_id = int(box.cls[0])
                            conf = float(box.conf[0])
                            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                            cls_name = r.names.get(cls_id, 'pothole')
                            # Ekstrak koordinat poligon segmentasi untuk deteksi ini
                            seg_points = []
                            if idx < len(masks_xy):
                                seg_points = [[int(p[0]), int(p[1])] for p in masks_xy[idx]]
                            bw = x2 - x1
                            severity, diameter_cm, depth_cm, volume_liters = estimate_pothole_dimensions(bw, vw, cls_name)

                            det_data = {
                                'frame': frame_idx,
                                'time_sec': round(frame_idx / fps, 2),
                                'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2,
                                'confidence': round(conf, 3),
                                'class': cls_name,
                                'severity': severity,
                                'diameter': diameter_cm,
                                'depth': depth_cm,
                                'volume': volume_liters,
                                'segmentation': seg_points
                            }
                            frame_dets.append(det_data)
                            all_detections.append(det_data)

                    # Gambar segmentasi mask dan bounding box pada frame
                    for det in frame_dets:
                        color_map = {'High': (0, 0, 255), 'Medium': (0, 165, 255), 'Low': (0, 255, 0)}
                        color = color_map.get(det['severity'], (0, 255, 0))
                        # Gambar segmentasi mask (poligon semi-transparan) di dalam bounding box
                        seg_points = det.get('segmentation', [])
                        if seg_points and len(seg_points) >= 3:
                            draw_segmentation_overlay(frame, seg_points, color, alpha=0.3)
                        cv2.rectangle(frame, (det['x1'], det['y1']), (det['x2'], det['y2']), color, 3)
                        label = f"{det['class']} {det['confidence']*100:.0f}%"
                        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 2)
                        cv2.rectangle(frame, (det['x1'], det['y1'] - th - 10), (det['x1'] + tw + 10, det['y1']), color, -1)
                        cv2.putText(frame, label, (det['x1'] + 5, det['y1'] - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)

                out.write(frame)
                frame_idx += 1

                # Update progress
                _video_jobs[job_id]['progress'] = round((frame_idx / total_frames) * 100, 1)
                _video_jobs[job_id]['processed_frames'] = frame_idx

            cap2.release()
            out.release()

            # Cleanup temp files
            shutil.rmtree(temp_dir, ignore_errors=True)

            _video_jobs[job_id]['status'] = 'done'
            _video_jobs[job_id]['progress'] = 100
            _video_jobs[job_id]['detections'] = all_detections
            _video_jobs[job_id]['result_path'] = f'/static/results/{output_name}'

        except Exception as e:
            logging.exception(f"Error processing video {job_id}")
            _video_jobs[job_id]['status'] = 'error'
            _video_jobs[job_id]['error'] = str(e)
            shutil.rmtree(temp_dir, ignore_errors=True)

    thread = threading.Thread(target=process_video, daemon=True)
    thread.start()

    return jsonify({
        'job_id': job_id,
        'total_frames': total_frames,
        'fps': fps,
        'resolution': f'{vw}x{vh}',
        'message': 'Video sedang diproses...'
    })


@app.route('/api/video-status/<job_id>', methods=['GET'])
def video_status(job_id):
    """Cek status pemrosesan video"""
    job = _video_jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job tidak ditemukan'}), 404
    return jsonify(job)


@app.errorhandler(Exception)
def handle_exception(e):
    logging.exception("Error:")
    return jsonify({'error': 'Server Error', 'message': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=7860, debug=False, use_reloader=False, threaded=True)
