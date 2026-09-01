// ═══════════════════════════════════════════════
// Uji Deteksi — Test Page Logic
// ═══════════════════════════════════════════════

// ── State ──
let currentImageFile = null;
let currentVideoFile = null;
let currentVideoJobId = null;
let pollInterval = null;

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupImageDropZone();
    setupVideoDropZone();
});

// ═══════════════════════════════════════════════
// 1. TAB SWITCHING
// ═══════════════════════════════════════════════
function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;

            // Update active tab button
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Show/hide tab content
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(`tab-${target}`).classList.add('active');
        });
    });
}

// ═══════════════════════════════════════════════
// 2. IMAGE DROP ZONE & UPLOAD
// ═══════════════════════════════════════════════
function setupImageDropZone() {
    const dropZone = document.getElementById('image-drop-zone');
    const fileInput = document.getElementById('image-file-input');

    if (!dropZone || !fileInput) return;

    // Click to open file picker
    dropZone.addEventListener('click', (e) => {
        if (e.target.closest('.drop-zone-btn') || e.target === dropZone || e.target.closest('.drop-zone-icon') || e.target.closest('.drop-zone-title') || e.target.closest('.drop-zone-sub')) {
            fileInput.click();
        }
    });

    // Drag events
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].type.startsWith('image/')) {
            handleImageFile(files[0]);
        }
    });

    // File input change
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
            handleImageFile(fileInput.files[0]);
        }
    });
}

function handleImageFile(file) {
    currentImageFile = file;

    // Show preview
    const previewSection = document.getElementById('image-preview');
    const previewImg = document.getElementById('image-preview-img');
    const fileInfo = document.getElementById('image-file-info');

    const reader = new FileReader();
    reader.onload = (e) => {
        previewImg.src = e.target.result;
        previewSection.classList.add('visible');
    };
    reader.readAsDataURL(file);

    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    fileInfo.textContent = `${file.name} · ${sizeMB} MB`;

    // Update drop zone appearance
    document.getElementById('image-drop-zone').classList.add('has-file');

    // Hide previous results
    document.getElementById('image-result').classList.remove('visible');
}

function clearImage() {
    currentImageFile = null;
    document.getElementById('image-preview').classList.remove('visible');
    document.getElementById('image-result').classList.remove('visible');
    document.getElementById('image-drop-zone').classList.remove('has-file');
    document.getElementById('image-file-input').value = '';
}

async function detectImage() {
    if (!currentImageFile) return;

    const btn = document.getElementById('btn-detect-image');
    const processing = document.getElementById('image-processing');
    const resultSection = document.getElementById('image-result');

    // UI: Disable button, show processing
    btn.disabled = true;
    btn.innerHTML = '<span class="processing-spinner" style="width:20px;height:20px;border-width:2px;display:inline-block;margin:0;"></span> Memproses...';
    processing.classList.add('visible');
    resultSection.classList.remove('visible');

    try {
        const formData = new FormData();
        formData.append('image', currentImageFile);
        const confSlider = document.getElementById('img-confidence');
        const confVal = confSlider ? confSlider.value : 15;
        formData.append('confidence', (confVal / 100).toFixed(2));

        const resp = await fetch('/api/detect-image', {
            method: 'POST',
            body: formData
        });

        const data = await resp.json();

        if (!resp.ok) {
            throw new Error(data.error || 'Gagal memproses gambar');
        }

        // Render results
        renderImageResult(data);

    } catch (err) {
        alert('Error: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '🔍 Mulai Deteksi';
        processing.classList.remove('visible');
    }
}

function renderImageResult(data) {
    const resultSection = document.getElementById('image-result');

    // Summary cards
    const totalDetected = data.total_detected || 0;
    const highCount = data.detections.filter(d => d.severity === 'High').length;
    const medCount = data.detections.filter(d => d.severity === 'Medium').length;
    const lowCount = data.detections.filter(d => d.severity === 'Low').length;

    document.getElementById('img-stat-total').textContent = totalDetected;
    document.getElementById('img-stat-high').textContent = highCount;
    document.getElementById('img-stat-medium').textContent = medCount;
    document.getElementById('img-stat-time').textContent = `${data.inference_ms}ms`;

    // Result image
    document.getElementById('result-image-display').src = data.result_image;
    document.getElementById('result-image-size').textContent = `${data.image_size.width}×${data.image_size.height}`;

    // Detection table
    const tbody = document.getElementById('image-det-tbody');
    tbody.innerHTML = '';

    if (data.detections.length > 0) {
        document.getElementById('image-det-table-card').style.display = 'block';
        document.getElementById('image-no-detection').style.display = 'none';

        data.detections.forEach((det, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${idx + 1}</td>
                <td><span class="sev-dot ${det.severity.toLowerCase()}"></span>${det.class}</td>
                <td><span class="badge-sev ${det.severity.toLowerCase()}">${det.severity}</span></td>
                <td>${(det.confidence * 100).toFixed(1)}%</td>
                <td>${det.diameter} cm</td>
                <td>${det.depth} cm</td>
                <td>${det.volume} L</td>
            `;
            tbody.appendChild(tr);
        });
    } else {
        document.getElementById('image-det-table-card').style.display = 'none';
        document.getElementById('image-no-detection').style.display = 'block';
    }

    resultSection.classList.add('visible');
}

// ═══════════════════════════════════════════════
// 3. VIDEO DROP ZONE & UPLOAD
// ═══════════════════════════════════════════════
function setupVideoDropZone() {
    const dropZone = document.getElementById('video-drop-zone');
    const fileInput = document.getElementById('video-file-input');

    if (!dropZone || !fileInput) return;

    dropZone.addEventListener('click', (e) => {
        if (e.target.closest('.drop-zone-btn') || e.target === dropZone || e.target.closest('.drop-zone-icon') || e.target.closest('.drop-zone-title') || e.target.closest('.drop-zone-sub')) {
            fileInput.click();
        }
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].type.startsWith('video/')) {
            handleVideoFile(files[0]);
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
            handleVideoFile(fileInput.files[0]);
        }
    });
}

function handleVideoFile(file) {
    currentVideoFile = file;

    const previewSection = document.getElementById('video-preview');
    const previewVid = document.getElementById('video-preview-vid');
    const fileInfo = document.getElementById('video-file-info');

    const url = URL.createObjectURL(file);
    previewVid.src = url;
    previewSection.classList.add('visible');

    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    fileInfo.textContent = `${file.name} · ${sizeMB} MB`;

    document.getElementById('video-drop-zone').classList.add('has-file');

    // Hide previous results
    document.getElementById('video-result').classList.remove('visible');
    document.getElementById('video-progress').classList.remove('visible');
}

function clearVideo() {
    currentVideoFile = null;
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    document.getElementById('video-preview').classList.remove('visible');
    document.getElementById('video-result').classList.remove('visible');
    document.getElementById('video-progress').classList.remove('visible');
    document.getElementById('video-drop-zone').classList.remove('has-file');
    document.getElementById('video-file-input').value = '';
}

async function detectVideo() {
    if (!currentVideoFile) return;

    const btn = document.getElementById('btn-detect-video');
    const progressSection = document.getElementById('video-progress');
    const resultSection = document.getElementById('video-result');

    btn.disabled = true;
    btn.innerHTML = '<span class="processing-spinner" style="width:20px;height:20px;border-width:2px;display:inline-block;margin:0;"></span> Mengunggah...';
    resultSection.classList.remove('visible');

    try {
        const formData = new FormData();
        formData.append('video', currentVideoFile);
        const confSlider = document.getElementById('vid-confidence');
        const confVal = confSlider ? confSlider.value : 15;
        formData.append('confidence', (confVal / 100).toFixed(2));

        const resp = await fetch('/api/detect-video', {
            method: 'POST',
            body: formData
        });

        const data = await resp.json();

        if (!resp.ok) {
            throw new Error(data.error || 'Gagal memproses video');
        }

        currentVideoJobId = data.job_id;

        // Show progress bar
        progressSection.classList.add('visible');
        document.getElementById('progress-detail-text').textContent =
            `${data.resolution} · ${Math.round(data.fps)} FPS · ${data.total_frames} frame`;

        btn.innerHTML = '⏳ Sedang Memproses...';

        // Start polling for progress
        startProgressPolling(data.job_id);

    } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = '🔍 Mulai Deteksi';
    }
}

function startProgressPolling(jobId) {
    pollInterval = setInterval(async () => {
        try {
            const resp = await fetch(`/api/video-status/${jobId}`);
            const data = await resp.json();

            // Update progress bar
            document.getElementById('progress-fill').style.width = `${data.progress}%`;
            document.getElementById('progress-percent-text').textContent = `${data.progress}%`;
            document.getElementById('progress-detail-text').textContent =
                `Frame ${data.processed_frames} / ${data.total_frames}`;

            if (data.status === 'done') {
                clearInterval(pollInterval);
                pollInterval = null;
                renderVideoResult(data);

                const btn = document.getElementById('btn-detect-video');
                btn.disabled = false;
                btn.innerHTML = '🔍 Mulai Deteksi';

                // Hide progress after delay
                setTimeout(() => {
                    document.getElementById('video-progress').classList.remove('visible');
                }, 500);
            } else if (data.status === 'error') {
                clearInterval(pollInterval);
                pollInterval = null;
                alert('Error: ' + (data.error || 'Gagal memproses video'));

                const btn = document.getElementById('btn-detect-video');
                btn.disabled = false;
                btn.innerHTML = '🔍 Mulai Deteksi';
                document.getElementById('video-progress').classList.remove('visible');
            }
        } catch (err) {
            console.error('Poll error:', err);
        }
    }, 1500);
}

function renderVideoResult(data) {
    const resultSection = document.getElementById('video-result');

    // Summary
    const dets = data.detections || [];
    const totalDetected = dets.length;
    const highCount = dets.filter(d => d.severity === 'High').length;
    const medCount = dets.filter(d => d.severity === 'Medium').length;
    const lowCount = dets.filter(d => d.severity === 'Low').length;

    document.getElementById('vid-stat-total').textContent = totalDetected;
    document.getElementById('vid-stat-high').textContent = highCount;
    document.getElementById('vid-stat-medium').textContent = medCount;
    document.getElementById('vid-stat-low').textContent = lowCount;

    // Video player
    const videoPlayer = document.getElementById('result-video-display');
    videoPlayer.src = data.result_path;
    videoPlayer.load();

    // Set download link
    const dlLink = document.getElementById('video-download-link');
    dlLink.href = data.result_path;
    dlLink.download = 'hasil_deteksi.mp4';

    // Detection table
    const tbody = document.getElementById('video-det-tbody');
    tbody.innerHTML = '';

    if (dets.length > 0) {
        document.getElementById('video-det-table-card').style.display = 'block';
        document.getElementById('video-no-detection').style.display = 'none';

        dets.forEach((det, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${idx + 1}</td>
                <td>${det.time_sec}s</td>
                <td><span class="sev-dot ${det.severity.toLowerCase()}"></span>${det.class}</td>
                <td><span class="badge-sev ${det.severity.toLowerCase()}">${det.severity}</span></td>
                <td>${(det.confidence * 100).toFixed(1)}%</td>
                <td>${det.diameter} cm</td>
                <td>${det.depth} cm</td>
            `;
            tbody.appendChild(tr);
        });
    } else {
        document.getElementById('video-det-table-card').style.display = 'none';
        document.getElementById('video-no-detection').style.display = 'block';
    }

    resultSection.classList.add('visible');
}

// ═══════════════════════════════════════════════
// 4. UTILITY — Download result image
// ═══════════════════════════════════════════════
function downloadResultImage() {
    const img = document.getElementById('result-image-display');
    if (!img || !img.src) return;

    const a = document.createElement('a');
    a.href = img.src;
    a.download = `hasil_deteksi_${Date.now()}.jpg`;
    a.click();
}
