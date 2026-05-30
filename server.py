import os
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

# ──────────────────────────────────────────────
# Server: TIDAK lagi menjalankan model AI.
# Deteksi YOLO sekarang berjalan on-device di browser via TF.js.
# Server hanya menyimpan data ke Supabase & menyajikan halaman web.
# ──────────────────────────────────────────────

SNAPSHOT_DIR = os.path.join('static', 'snapshots')

# Pastikan folder snapshot ada
os.makedirs(SNAPSHOT_DIR, exist_ok=True)

# ──────────────────────────────────────────────
# Filter Konfigurasi — Konteks Jalan Raya
# Semua nilai bisa di-override via .env
# ──────────────────────────────────────────────
CONF_THRESHOLD      = float(os.environ.get('CONF_THRESHOLD',      '0.25'))  # Keyakinan minimum
ROI_BOTTOM_FRAC     = float(os.environ.get('ROI_BOTTOM_FRAC',     '0.35'))  # Objek harus ada di X% bawah frame
MIN_ASPECT_RATIO    = float(os.environ.get('MIN_ASPECT_RATIO',    '0.25'))  # lebar/tinggi min (lubang jalan cenderung lebar)
MAX_ASPECT_RATIO    = float(os.environ.get('MAX_ASPECT_RATIO',    '5.0'))   # lebar/tinggi maks
MIN_BOX_AREA_FRAC   = float(os.environ.get('MIN_BOX_AREA_FRAC',   '0.002')) # Minimum luas kotak relatif terhadap frame
MAX_BOX_AREA_FRAC   = float(os.environ.get('MAX_BOX_AREA_FRAC',   '0.55'))  # Maksimum luas (bukan seluruh layar)
MIN_SPEED_KMH       = float(os.environ.get('MIN_SPEED_KMH',       '2.0'))   # Kendaraan harus bergerak (0 = nonaktifkan)
ROAD_COLOR_CHECK    = os.environ.get('ROAD_COLOR_CHECK', 'true').lower() == 'true'  # Aktifkan cek warna aspal


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

# ──────────────────────────────────────────────
# Cooldown: simpan deteksi maks 1x per N detik
# ──────────────────────────────────────────────
DETECTION_COOLDOWN_SEC = 5   # ganti angka ini sesuai kebutuhan
_last_saved_time = 0.0       # timestamp detik terakhir kali disimpan

# ──────────────────────────────────────────────
# MySQL Configuration (AnyMhost / cPanel)
# ──────────────────────────────────────────────
import supabase

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

_supabase_client = None
_db_available = False

def _ensure_db():
    global _supabase_client, _db_available
    if _supabase_client is None and SUPABASE_URL and SUPABASE_KEY:
        try:
            from supabase import create_client, Client
            _supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
            _db_available = True
        except Exception as e:
            logging.error(f"Supabase init failed: {e}")
    return _db_available


# ──────────────────────────────────────────────
# Severity, Dimension, and Volume Estimation Helper
# ──────────────────────────────────────────────
def calculate_volume(diameter, depth):
    # Menghitung volume dalam Liter menggunakan model semi-ellipsoid (0.5 * pi * r^2 * h)
    radius = diameter / 2.0
    vol_cm3 = 0.5 * 3.14159 * (radius ** 2) * depth
    vol_liters = round(vol_cm3 / 1000.0, 1)
    return max(0.1, vol_liters)

def estimate_pothole_dimensions(bw, fw, cls_name):
    # Estimasi diameter fisik dalam cm (lebar jalan di dasar frame dianggap 200 cm)
    diameter_cm = round((bw / fw) * 200.0, 1)
    diameter_cm = max(5.0, diameter_cm) # minimal 5cm
    
    # Estimasi kedalaman fisik dalam cm
    if cls_name == 'lubang_besar':
        base_ratio = 0.25
    elif cls_name == 'lubang_kecil':
        base_ratio = 0.12
    else: # 'lubang_sedang' atau 'pothole'
        base_ratio = 0.18
        
    depth_cm = round(diameter_cm * base_ratio, 1)
    depth_cm = max(2.0, min(25.0, depth_cm)) # batas realistis 2cm - 25cm
    
    # Severity classification berdasarkan kedalaman
    if depth_cm >= 12.0:
        severity = 'High'
    elif depth_cm >= 6.0:
        severity = 'Medium'
    else:
        severity = 'Low'
        
    volume_liters = calculate_volume(diameter_cm, depth_cm)
    
    return severity, diameter_cm, depth_cm, volume_liters

def classify_severity_from_class(cls_name):
    if cls_name == 'lubang_besar':
        return 'High', 15.0
    elif cls_name == 'lubang_sedang':
        return 'Medium', 8.0
    elif cls_name == 'lubang_kecil':
        return 'Low', 3.0
    else:
        return 'Medium', 5.0


# ──────────────────────────────────────────────
# Road Context Validator
# Filter berlapis untuk memastikan hanya lubang
# di jalan raya yang terdeteksi, bukan lubang
# pada benda/objek lainnya.
# ──────────────────────────────────────────────
def _is_valid_road_detection(det, frame_h, frame_w):
    """
    Validasi konteks jalan raya untuk satu deteksi.
    Return (True, None) jika valid, (False, alasan) jika tidak valid.

    Filter 1 — Posisi Vertikal:
      Lubang jalan hanya ada di area bawah frame (karena kamera menghadap jalan).
      Objek di bagian atas frame (langit, pintu lemari, wajah) dibuang.

    Filter 2 — Aspek Rasio Bounding Box:
      Lubang jalan cenderung lebih lebar dari tingginya.
      Objek yang sangat tegak/vertikal bukan lubang jalan.

    Filter 3 — Ukuran Bounding Box:
      Lubang jalan tidak terlalu kecil (debu/noise) dan tidak memenuhi
      seluruh layar (itu artinya kamera sedang menghadap tembok).

    Filter 4 — Warna Aspal di Sekitar Objek:
      Area di sekitar deteksi harus mengandung warna abu-abu/kecoklatan
      yang merupakan warna dominan aspal dan tanah jalan.
    """
    x1, y1, x2, y2 = det['x1'], det['y1'], det['x2'], det['y2']
    bw = x2 - x1
    bh = y2 - y1

    if bw <= 0 or bh <= 0:
        return False, "bbox-invalid"

    # Filter 1: Posisi Vertikal — objek harus ada di bagian BAWAH frame
    # Titik tengah-Y dari bounding box harus di bawah ROI_BOTTOM_FRAC * frame_h
    center_y = (y1 + y2) / 2
    roi_threshold = frame_h * ROI_BOTTOM_FRAC
    if center_y < roi_threshold:
        return False, f"posisi-terlalu-tinggi(center_y={center_y:.0f} < threshold={roi_threshold:.0f})"

    # Filter 2: Aspek Rasio — lubang jalan lebih lebar dari tingginya
    aspect_ratio = bw / bh
    if aspect_ratio < MIN_ASPECT_RATIO:
        return False, f"terlalu-sempit(ar={aspect_ratio:.2f} < min={MIN_ASPECT_RATIO})"
    if aspect_ratio > MAX_ASPECT_RATIO:
        return False, f"terlalu-lebar(ar={aspect_ratio:.2f} > max={MAX_ASPECT_RATIO})"

    # Filter 3: Ukuran Bounding Box relatif terhadap frame
    frame_area = frame_h * frame_w
    box_area_frac = (bw * bh) / frame_area
    if box_area_frac < MIN_BOX_AREA_FRAC:
        return False, f"terlalu-kecil(area={box_area_frac:.4f} < min={MIN_BOX_AREA_FRAC})"
    if box_area_frac > MAX_BOX_AREA_FRAC:
        return False, f"terlalu-besar(area={box_area_frac:.4f} > max={MAX_BOX_AREA_FRAC})"

    return True, None


def _has_road_color_context(frame, det):
    """
    Filter 4 (Opsional): Periksa apakah area sekitar deteksi mengandung
    warna yang umum ditemukan pada permukaan jalan (aspal abu-abu, tanah, pasir).
    
    Metode: Ambil area yang diperluas di sekitar bounding box, konversi ke
    HSV, dan periksa apakah pixel dominan masuk dalam rentang warna jalan.
    """
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = det['x1'], det['y1'], det['x2'], det['y2']
    bw  = x2 - x1
    bh  = y2 - y1

    # Perluas area pemeriksaan 50% ke setiap sisi
    margin_x = int(bw * 0.5)
    margin_y = int(bh * 0.5)
    rx1 = max(0, x1 - margin_x)
    ry1 = max(0, y1 - margin_y)
    rx2 = min(w, x2 + margin_x)
    ry2 = min(h, y2 + margin_y)

    region = frame[ry1:ry2, rx1:rx2]
    if region.size == 0:
        return True  # Tidak bisa diperiksa, beri benefit of the doubt

    hsv_region = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)

    # Rentang warna jalan dalam HSV:
    # Aspal    : S sangat rendah (keabu-abuan), V menengah-gelap
    # Tanah/Pasir: S rendah-menengah, H kekuningan-kecoklatan, V menengah
    # Warna non-jalan yang dihindari: hijau (rumput), biru (langit), putih cerah (tembok baru)

    # Aspal abu-abu: saturation < 60, value 20–200
    asphalt_mask = cv2.inRange(hsv_region, np.array([0, 0, 20]), np.array([180, 60, 200]))
    # Tanah/pasir coklat: H=10-30, S=30-180, V=50-200
    soil_mask    = cv2.inRange(hsv_region, np.array([10, 30, 50]), np.array([30, 180, 200]))

    road_pixels = cv2.countNonZero(asphalt_mask) + cv2.countNonZero(soil_mask)
    total_pixels = region.shape[0] * region.shape[1]
    road_ratio = road_pixels / total_pixels if total_pixels > 0 else 0

    # Minimal 20% area sekitar harus berwarna jalan
    return road_ratio >= 0.20


# ──────────────────────────────────────────────
# Fallback dark-region detector (no YOLO model)
# Versi ditingkatkan: menerapkan filter konteks
# ──────────────────────────────────────────────
def fallback_detect(frame):
    """Heuristic berbasis blob gelap + filter konteks jalan raya."""
    h, w = frame.shape[:2]

    # Hanya periksa di bagian bawah frame (area jalan)
    roi_start = int(h * ROI_BOTTOM_FRAC)
    roi = frame[roi_start:, :]

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
        bx, by, bw_c, bh_c = cv2.boundingRect(cnt)
        by += roi_start  # konversi balik ke koordinat frame penuh

        candidate = {
            'x1': int(bx), 'y1': int(by),
            'x2': int(bx + bw_c), 'y2': int(by + bh_c),
            'confidence': 0.0,
            'class': 'pothole'
        }

        valid, reason = _is_valid_road_detection(candidate, h, w)
        if not valid:
            continue

        if ROAD_COLOR_CHECK and not _has_road_color_context(frame, candidate):
            continue

        conf = min(0.95, 0.50 + (area / (w * h)) * 5)
        candidate['confidence'] = round(conf, 3)
        detections.append(candidate)
    return detections

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

# ── API: Terima hasil deteksi dari TF.js on-device ──
# Browser menjalankan YOLO secara lokal (WebGL), lalu HANYA mengirim
# data teks + thumbnail kecil ke endpoint ini untuk disimpan.
# Tidak ada frame besar yang dikirim, tidak perlu OpenCV/NumPy di server.
@app.route('/api/save-detection', methods=['POST'])
def save_detection():
    global _last_saved_time
    data = request.json
    if not data:
        return jsonify({'error': 'No data'}), 400

    now = time.time()

    # ── Cooldown: simpan maks 1x per DETECTION_COOLDOWN_SEC ──
    if (now - _last_saved_time) < DETECTION_COOLDOWN_SEC:
        remaining = round(DETECTION_COOLDOWN_SEC - (now - _last_saved_time), 1)
        logging.debug(f"[COOLDOWN] Skip simpan, sisa {remaining}s")
        return jsonify({'saved': False, 'reason': f'cooldown ({remaining}s)'})

    _last_saved_time = now

    # ── Ekstrak data dari browser ──
    latitude   = float(data.get('latitude', 0))
    longitude  = float(data.get('longitude', 0))
    speed_kmh  = float(data.get('speed', 0))
    severity   = data.get('severity', 'Low')
    confidence = float(data.get('confidence', 0))
    diameter   = float(data.get('diameter', 0))
    depth      = float(data.get('depth', 0))

    # Hitung volume (server-side untuk konsistensi)
    radius        = diameter / 2.0
    volume_liters = max(0.1, round(0.5 * 3.14159 * (radius ** 2) * depth / 1000.0, 1))

    # ── Simpan thumbnail snapshot ──
    snap_name     = f"{uuid.uuid4().hex[:12]}.jpg"
    snap_path     = os.path.join(SNAPSHOT_DIR, snap_name)
    web_snap_path = f'/static/snapshots/{snap_name}'

    snapshot_b64 = data.get('snapshot_b64', '')
    if snapshot_b64:
        try:
            img_bytes = base64.b64decode(snapshot_b64.split(',')[-1])
            with open(snap_path, 'wb') as f:
                f.write(img_bytes)
        except Exception as e:
            logging.warning(f"Gagal simpan snapshot: {e}")
            web_snap_path = ''

    google_maps_url = f'https://www.google.com/maps?q={latitude},{longitude}'
    timestamp_str   = time.strftime('%Y-%m-%d %H:%M:%S')

    # ── Simpan ke Supabase ──
    new_id = int(now)
    _ensure_db()
    if _db_available:
        try:
            db_data = {
                "timestamp":      timestamp_str,
                "latitude":       latitude,
                "longitude":      longitude,
                "speed":          speed_kmh,
                "diameter":       diameter,
                "depth":          depth,
                "confidence":     confidence,
                "severity":       severity,
                "snapshot_path":  web_snap_path,
                "google_maps_url": google_maps_url
            }
            res = _supabase_client.table("potholes").insert(db_data).execute()
            if res.data:
                new_id = res.data[0]['id']
            logging.info(f"[TF.js deteksi] id={new_id} sev={severity} conf={confidence:.2f} {snap_name}")
        except Exception as e:
            logging.warning(f"Supabase insert gagal: {e}")
    else:
        logging.warning("Supabase tidak tersedia — deteksi tidak disimpan ke DB.")

    record = {
        'id':             new_id,
        'timestamp':      timestamp_str,
        'latitude':       latitude,
        'longitude':      longitude,
        'speed':          speed_kmh,
        'diameter':       diameter,
        'depth':          depth,
        'volume':         volume_liters,
        'confidence':     confidence,
        'severity':       severity,
        'snapshot_path':  web_snap_path,
        'google_maps_url': google_maps_url
    }

    broadcaster.broadcast(record)
    return jsonify({'saved': True, 'record': record})


# ── API: list semua potholes ──
@app.route('/api/potholes', methods=['GET'])
def get_potholes():
    if not _ensure_db():
        return jsonify([])
    try:
        res = _supabase_client.table("potholes").select("*").order("id", desc=True).execute()
        data = res.data or []
        for r in data:
            dia = r.get('diameter', 0.0) or 0.0
            dep = r.get('depth', 0.0) or 0.0
            radius = dia / 2.0
            r['volume'] = max(0.1, round(0.5 * 3.14159 * (radius ** 2) * dep / 1000.0, 1))
        return jsonify(data)
    except Exception as e:
        logging.warning(f"Gagal fetch potholes: {e}")
        return jsonify([])



# ── API: list semua potholes ──
@app.route('/api/potholes', methods=['GET'])
def get_potholes():
    if not _ensure_db():
        return jsonify([])
    try:
        res = _supabase_client.table("potholes").select("*").order("id", desc=True).execute()
        data = res.data or []
        for r in data:
            dia = r.get('diameter', 0.0) or 0.0
            dep = r.get('depth', 0.0) or 0.0
            r['volume'] = calculate_volume(dia, dep)
        return jsonify(data)
    except Exception as e:
        logging.warning(f"Gagal fetch potholes: {e}")
        return jsonify([])

# ── API: statistik ──
@app.route('/api/stats', methods=['GET'])
def get_stats():
    empty = {
        'total': 0,
        'severity_distribution': {'Low': 0, 'Medium': 0, 'High': 0},
        'avg_diameter': 0.0,
        'avg_depth':    0.0,
        'avg_speed':    0.0,
        'trend':        []
    }
    if not _ensure_db():
        return jsonify(empty)
    try:
        res = _supabase_client.table("potholes").select("*").execute()
        rows = res.data
        if not rows:
            return jsonify(empty)
        
        total = len(rows)
        sev = {'Low': 0, 'Medium': 0, 'High': 0}
        sum_dia = 0
        sum_dep = 0
        sum_spd = 0
        
        # Simple trend aggregation by day
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
            if date_str:
                trend_dict[date_str] += 1
                
        trend = [{"date": k, "count": v} for k, v in sorted(trend_dict.items())][-7:]

        return jsonify({
            'total':                 total,
            'severity_distribution': sev,
            'avg_diameter':          round(sum_dia/total, 1) if total else 0,
            'avg_depth':             round(sum_dep/total, 1) if total else 0,
            'avg_speed':             round(sum_spd/total, 1) if total else 0,
            'trend':                 trend
        })
    except Exception as e:
        logging.warning(f"Gagal fetch stats: {e}")
        return jsonify(empty)
    try:
        res = _supabase_client.table("potholes").select("*").execute()
        rows = res.data
        if not rows:
            return jsonify(empty)
        
        total = len(rows)
        sev = {'Low': 0, 'Medium': 0, 'High': 0}
        sum_dia = 0
        sum_dep = 0
        sum_spd = 0
        
        # Simple trend aggregation by day
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
            if date_str:
                trend_dict[date_str] += 1
                
        trend = [{"date": k, "count": v} for k, v in sorted(trend_dict.items())][-7:]

        return jsonify({
            'total':                 total,
            'severity_distribution': sev,
            'avg_diameter':          round(sum_dia/total, 1) if total else 0,
            'avg_depth':             round(sum_dep/total, 1) if total else 0,
            'avg_speed':             round(sum_spd/total, 1) if total else 0,
            'trend':                 trend
        })
    except Exception as e:
        logging.warning(f"Gagal fetch stats: {e}")
        return jsonify(empty)
    try:
        conn = get_db()
        with conn.cursor() as cur:
            # Total
            cur.execute("SELECT COUNT(*) AS total FROM potholes")
            total = cur.fetchone()['total']

            # Distribusi severity
            cur.execute("""
                SELECT severity, COUNT(*) AS cnt
                FROM potholes
                GROUP BY severity
            """)
            sev = {'Low': 0, 'Medium': 0, 'High': 0}
            for row in cur.fetchall():
                sev[row['severity']] = row['cnt']

            # Rata-rata
            cur.execute("""
                SELECT
                    COALESCE(AVG(diameter), 0) AS avg_diameter,
                    COALESCE(AVG(depth),    0) AS avg_depth,
                    COALESCE(AVG(speed),    0) AS avg_speed
                FROM potholes
            """)
            avgs = cur.fetchone()

            # Trend 7 hari terakhir
            cur.execute("""
                SELECT DATE(timestamp) AS date, COUNT(*) AS cnt
                FROM potholes
                GROUP BY DATE(timestamp)
                ORDER BY date DESC
                LIMIT 7
            """)
            trend_rows = cur.fetchall()
        conn.close()

        trend = [
            {'date': str(r['date']), 'count': r['cnt']}
            for r in reversed(trend_rows)
        ]

        return jsonify({
            'total':                 total,
            'severity_distribution': sev,
            'avg_diameter':          round(float(avgs['avg_diameter']), 1),
            'avg_depth':             round(float(avgs['avg_depth']),    1),
            'avg_speed':             round(float(avgs['avg_speed']),    1),
            'trend':                 trend
        })
    except Exception as e:
        logging.warning(f"Gagal fetch stats: {e}")
        return jsonify(empty)

# ── API: hapus record ──
@app.route('/api/potholes/<int:pid>', methods=['DELETE'])
def delete_pothole(pid):
    if not _ensure_db():
        return jsonify({'deleted': pid, 'warning': 'DB tidak tersedia'})
    try:
        _supabase_client.table("potholes").delete().eq("id", pid).execute()
        logging.info(f"Deleted pothole id={pid} from Supabase")
    except Exception as e:
        logging.exception(f"Gagal delete id={pid}:")
    return jsonify({'deleted': pid})

@app.route('/api/potholes/delete-all', methods=['DELETE'])
def delete_all_potholes():
    if not _ensure_db():
        return jsonify({'deleted': True, 'warning': 'DB tidak tersedia'})
    try:
        # Supabase requires a filter to delete all rows. Using a dummy condition like id > 0
        _supabase_client.table("potholes").delete().gt("id", 0).execute()
        logging.info("Deleted all potholes from Supabase")
    except Exception as e:
        logging.exception("Gagal delete semua potholes:")
        return jsonify({'error': str(e)}), 500
    return jsonify({'deleted': True})


# ── Global Error Handler ──
@app.errorhandler(Exception)
def handle_exception(e):
    from werkzeug.exceptions import HTTPException
    # Jika exception adalah HTTP error (seperti 404, 405, dll), biarkan Flask menanganinya atau kembalikan status code asli
    if isinstance(e, HTTPException):
        return jsonify({
            'error': e.name,
            'message': e.description
        }), e.code

    # Log error dengan lengkap beserta tracebacks untuk error server asli (500)
    logging.exception("Terjadi Unhandled Exception pada server:")
    # Kembalikan response JSON
    return jsonify({
        'error': 'Internal Server Error',
        'message': str(e)
    }), 500

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 7860))
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False, threaded=True)
