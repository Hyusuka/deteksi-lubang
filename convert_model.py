"""
═══════════════════════════════════════════════════════════════
  convert_model.py — Konversi YOLOv8 ke TensorFlow.js
═══════════════════════════════════════════════════════════════

Jalankan script ini SEKALI di komputer Anda (bukan di server).
Script akan menghasilkan folder: static/tfjs_model/

PERSYARATAN (install dulu):
    pip install ultralytics tensorflowjs onnx

CARA PAKAI:
    python convert_model.py

OUTPUT:
    static/tfjs_model/model.json
    static/tfjs_model/group1-shard1of*.bin
    (semua file ini di-upload bersama ke Hugging Face via git)
"""

import os
import sys
import shutil

# ── 1. Cek model ada ──
MODEL_PT = 'pothole_yolov8.pt'
TFJS_OUT  = os.path.join('static', 'tfjs_model')

if not os.path.exists(MODEL_PT):
    print(f"[ERROR] File model tidak ditemukan: {MODEL_PT}")
    print("Pastikan Anda menjalankan script ini dari folder proyek yang sama dengan file .pt")
    sys.exit(1)

print(f"[INFO] Model ditemukan: {MODEL_PT} ({os.path.getsize(MODEL_PT)/1e6:.1f} MB)")
print("[INFO] Memulai konversi ke TensorFlow.js...")
print("[INFO] Proses ini memakan waktu 2-5 menit, harap tunggu...\n")

# ── 2. Export ke TF.js via Ultralytics (satu perintah langsung!) ──
try:
    from ultralytics import YOLO
    model = YOLO(MODEL_PT)

    # Export langsung ke tfjs — Ultralytics handle semua konversi otomatis
    # imgsz=640: ukuran input standar YOLO
    # optimize=True: aktifkan optimasi untuk ukuran model lebih kecil
    export_path = model.export(
        format='tfjs',
        imgsz=640,
        optimize=False,   # False = lebih kompatibel; True = lebih kecil tapi bisa error
        half=False,       # FP32 untuk akurasi tertinggi di browser WebGL
    )
    print(f"\n[OK] Export selesai! Output: {export_path}")

except ImportError:
    print("[ERROR] ultralytics belum terinstall. Jalankan: pip install ultralytics")
    sys.exit(1)
except Exception as e:
    print(f"[ERROR] Konversi gagal: {e}")
    print("\nCoba install ulang dependensi:")
    print("  pip install ultralytics tensorflowjs onnx onnxruntime")
    sys.exit(1)

# ── 3. Pindahkan output ke static/tfjs_model/ ──
print(f"\n[INFO] Memindahkan model ke {TFJS_OUT}...")

# Cari folder output yang dibuat ultralytics
# Biasanya: pothole_yolov8_web_model/ atau pothole_yolov8_saved_model/web_model
possible_dirs = [
    'pothole_yolov8_web_model',
    os.path.join('pothole_yolov8_saved_model', 'pothole_yolov8_web_model'),
]

source_dir = None
if isinstance(export_path, str) and os.path.isdir(export_path):
    source_dir = export_path
else:
    for d in possible_dirs:
        if os.path.isdir(d):
            source_dir = d
            break

if not source_dir:
    # Cari berdasarkan nama model.json
    for root, dirs, files in os.walk('.'):
        if 'model.json' in files and 'tfjs' in root.lower():
            source_dir = root
            break

if not source_dir:
    print("[ERROR] Tidak bisa menemukan folder output TF.js secara otomatis.")
    print("Cari folder yang berisi 'model.json' dan salin manual ke static/tfjs_model/")
    sys.exit(1)

print(f"[INFO] Sumber folder: {source_dir}")

# Hapus output lama jika ada
if os.path.exists(TFJS_OUT):
    shutil.rmtree(TFJS_OUT)

# Salin ke static/tfjs_model/
shutil.copytree(source_dir, TFJS_OUT)

# ── 4. Verifikasi ──
model_json = os.path.join(TFJS_OUT, 'model.json')
if os.path.exists(model_json):
    total_size = sum(
        os.path.getsize(os.path.join(TFJS_OUT, f))
        for f in os.listdir(TFJS_OUT)
    ) / 1e6

    print(f"\n{'='*55}")
    print(f"  KONVERSI BERHASIL!")
    print(f"  Output : {TFJS_OUT}/")
    print(f"  Ukuran : {total_size:.1f} MB")
    print(f"  Files  : {', '.join(os.listdir(TFJS_OUT))}")
    print(f"{'='*55}")
    print(f"\n[LANGKAH BERIKUTNYA]")
    print(f"  1. Jalankan: git add static/tfjs_model/")
    print(f"  2. Jalankan: git commit -m 'add: tfjs model for on-device inference'")
    print(f"  3. Jalankan: git push origin main")
    print(f"  4. Jalankan: git push huggingface main")
    print(f"\n  Model akan dimuat langsung di browser HP Anda!")
else:
    print("[ERROR] model.json tidak ditemukan di output.")
    print(f"Periksa isi folder {TFJS_OUT} secara manual.")
