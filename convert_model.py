"""
═══════════════════════════════════════════════════════════════
  convert_model.py — Konversi YOLOv8 ke ONNX (Web Runtime)
═══════════════════════════════════════════════════════════════

Jalankan script ini SEKALI di komputer Windows Anda.
Script akan menghasilkan 1 file: static/pothole_yolov8.onnx

PERSYARATAN (install dulu):
    pip install ultralytics onnx

CARA PAKAI:
    python convert_model.py
"""

import os
import sys
import shutil

MODEL_PT = 'pothole_yolov8.pt'
ONNX_OUT = os.path.join('static', 'pothole_yolov8.onnx')

if not os.path.exists(MODEL_PT):
    print(f"[ERROR] File model tidak ditemukan: {MODEL_PT}")
    sys.exit(1)

print(f"[INFO] Model ditemukan: {MODEL_PT} ({os.path.getsize(MODEL_PT)/1e6:.1f} MB)")
print("[INFO] Memulai konversi ke ONNX...")

try:
    from ultralytics import YOLO
    model = YOLO(MODEL_PT)

    # Export ke ONNX (sangat lancar di Windows)
    export_path = model.export(
        format='onnx',
        imgsz=640,
        half=False,
        opset=12,  # Kompatibilitas terbaik untuk ONNX Web
    )
    
    print(f"\n[OK] Export selesai! Output sementara: {export_path}")

except ImportError:
    print("[ERROR] ultralytics belum terinstall. Jalankan: pip install ultralytics onnx")
    sys.exit(1)
except Exception as e:
    print(f"[ERROR] Konversi gagal: {e}")
    sys.exit(1)

# Pindahkan file .onnx ke folder static
if os.path.exists(export_path):
    shutil.move(export_path, ONNX_OUT)
    print(f"\n{'='*55}")
    print(f"  KONVERSI ONNX BERHASIL!")
    print(f"  Output : {ONNX_OUT}")
    print(f"  Ukuran : {os.path.getsize(ONNX_OUT)/1e6:.1f} MB")
    print(f"{'='*55}")
    print("\n[LANGKAH BERIKUTNYA]")
    print("  1. git add .")
    print("  2. git commit -m \"Ganti ke ONNX On-Device Inference\"")
    print("  3. git push origin main")
    print("  4. Buka aplikasi di HP Anda!")
else:
    print("[ERROR] Gagal memindahkan file ONNX.")
