---
title: Pothole Detector
emoji: 🕳️
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
---

# Pothole Detection Early Warning System 🕳️📸

Sistem pendeteksi lubang jalan raya secara *real-time* berbasis **YOLOv9**, **Flask**, dan **Supabase**. Aplikasi ini didesain agar dapat diakses menggunakan *smartphone* (sebagai *Progressive Web App* / PWA) yang dipasang pada dasbor motor untuk mendeteksi lubang jalan raya, mencatat koordinat GPS, kecepatan, dan mengunggah buktinya ke database Cloud.

## 🚀 Fitur Utama
- **Deteksi Real-time AI:** Menggunakan model YOLOv9 untuk mendeteksi 3 kelas lubang (`lubang_kecil`, `lubang_sedang`, `lubang_besar`).
- **Perekaman Kecepatan & GPS:** Secara otomatis melacak lokasi dan kecepatan motor menggunakan *Geolocation API* dari perangkat.
- **Supabase Cloud Integration:** Menyimpan data lokasi, waktu, dan estimasi kedalaman lubang ke PostgreSQL.
- **Auto-Upload Bukti Foto:** Otomatis mengambil *snapshot* (foto) dari lubang yang terdeteksi dan mengunggahnya ke Supabase Storage.
- **Mobile PWA Ready:** Antarmuka responsif *glassmorphism* layar penuh (*Full-Screen HUD*) yang dirancang khusus untuk HP pengawas jalan.

## 🛠️ Persyaratan Sistem (*Requirements*)
- Python 3.10 atau lebih baru.
- Kamera Web atau Kamera Smartphone.
- Akun [Supabase](https://supabase.com/) (Gratis).
- Cloudflare Tunnel atau Ngrok (jika ingin diakses secara publik tanpa menyewa server/VPS).

## ⚙️ Cara Instalasi & Menjalankan Lokal

1. **Kloning Repositori:**
   ```bash
   git clone https://github.com/Hyusuka/deteksi-lubang.git
   cd deteksi-lubang
   ```

2. **Instal Pustaka yang Dibutuhkan:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Pengaturan Database Supabase:**
   - Buat *Project* di Supabase.
   - Buat tabel `potholes` dan *Bucket Storage* bernama `snapshots` (Anda dapat menyalin perintah SQL dari file `supabase_schema.sql` dan menjalankannya di SQL Editor Supabase).
   - Ubah nama file `.env.example` menjadi `.env` dan masukkan *API Key* Anda:
     ```env
     SUPABASE_URL=https://<PROJECT_ID>.supabase.co
     SUPABASE_KEY=eyJhbGciOi...
     ```

4. **Jalankan Aplikasi:**
   ```bash
   python server.py
   ```
   Aplikasi akan berjalan di `http://127.0.0.1:7860`.

## 🌍 Cara Hosting / Mengakses dari HP (Jaringan Publik)

Karena model AI (PyTorch) terlalu berat untuk hosting gratisan biasa, disarankan untuk menjalankan server ini di **Laptop Anda sendiri** lalu menjembataninya menggunakan **Cloudflare Tunnel** agar bisa diakses dari HP pengawas jalan.

1. Jalankan `python server.py` di laptop Anda.
2. Buka terminal baru dan jalankan perintah *Quick Tunnel* Cloudflare:
   ```bash
   cloudflared tunnel --url http://localhost:7860
   ```
3. Anda akan mendapatkan URL publik gratis (contoh: `https://xxxx.trycloudflare.com`). Buka URL tersebut dari browser HP Android Anda dan aplikasi siap digunakan!

## 📸 Aset Contoh
Di dalam folder `static/assets/`, terdapat tiga gambar *placeholder* (contoh) untuk:
- `pothole_kecil.png`
- `pothole_sedang.png`
- `pothole_besar.png`

## 🤖 Catatan untuk Model AI
Secara *default*, program akan menggunakan `yolov9t.pt`. Jika Anda telah melatih (*training*) model YOLOv9 Anda sendiri dengan kelas-kelas khusus, cukup ganti file `yolov9t.pt` di direktori utama, lalu atur nama file tersebut di `.env`:
```env
YOLO_MODEL=nama_model_anda.pt
```

---
*Dibuat untuk keperluan Skripsi / Tugas Akhir Peringatan Dini Lubang Jalan Raya.*
