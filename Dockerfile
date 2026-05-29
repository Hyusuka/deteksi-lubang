# Gunakan base image Python yang ringan
FROM python:3.10-slim

# Install system dependencies untuk OpenCV
RUN apt-get update && apt-get install -y libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

# [PENTING] Hugging Face Spaces dengan Docker memerlukan aplikasi berjalan sebagai non-root user dengan UID 1000
RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH"

# Atur direktori kerja di dalam container
WORKDIR /home/user/app

# Salin requirements.txt terlebih dahulu agar Docker bisa melakukan caching pada step instalasi library
COPY --chown=user requirements.txt .

# Instal dependensi Python (termasuk Flask, Supabase, YOLOv9, dll)
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Salin seluruh kode proyek Anda (termasuk model YOLOv9, static, templates)
COPY --chown=user . .

# Ekspos port standar yang digunakan oleh Hugging Face Spaces
EXPOSE 7860

# Perintah untuk menjalankan server Flask
CMD ["python", "server.py"]
