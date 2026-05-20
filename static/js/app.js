// ═══════════════════════════════════════════════
// YOLOv9 Pothole Detector — Real-Time App Logic
// ═══════════════════════════════════════════════

// ── State ──
let videoStream = null;
let gpsWatchId = null;
let detectionLoop = null;
let isRunning = false;
let sevChart = null;
let eventSource = null;

// GPS state
let gpsLat = 0, gpsLon = 0, gpsSpeed = 0, gpsHeading = 0, gpsAccuracy = 0;

// Detection settings
const DETECT_INTERVAL_MS = 800; // send frame every 800ms

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    initChart();
    loadExistingData();
    setupSSE();
    setupButtons();
    startClock();
});

// ═══════════════════════════════════════════════
// 1. CAMERA — Real device camera via getUserMedia
// ═══════════════════════════════════════════════
async function startCamera() {
    const video = document.getElementById('camera-video');
    try {
        // Prefer rear/environment camera (for motorcycle mount)
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });
        video.srcObject = videoStream;
        await video.play();

        // Match overlay canvas size to video
        const overlay = document.getElementById('camera-overlay');
        video.addEventListener('loadedmetadata', () => {
            overlay.width = video.videoWidth;
            overlay.height = video.videoHeight;
        });

        updatePill('pill-camera', 'Kamera ON', 'green');
        document.getElementById('hud-status').innerHTML = 'Kamera aktif — mendeteksi lubang...';
        return true;
    } catch (err) {
        console.error('Camera error:', err);
        updatePill('pill-camera', 'Kamera GAGAL', 'red');
        document.getElementById('hud-status').innerHTML =
            '⚠️ Gagal akses kamera. Izinkan akses kamera di browser.';
        return false;
    }
}

function stopCamera() {
    if (videoStream) {
        videoStream.getTracks().forEach(t => t.stop());
        videoStream = null;
    }
    const video = document.getElementById('camera-video');
    video.srcObject = null;
    updatePill('pill-camera', 'Kamera OFF', 'red');
}

// ═══════════════════════════════════════════════
// 2. GPS — Real position via Geolocation API
//    Also provides speed (m/s) automatically!
// ═══════════════════════════════════════════════
function startGPS() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            updatePill('pill-gps', 'GPS Tidak Tersedia', 'red');
            document.getElementById('hud-status').innerHTML = '⚠️ Browser tidak mendukung GPS.';
            reject(new Error('GPS tidak tersedia'));
            return;
        }

        updatePill('pill-gps', 'GPS Mencari...', 'yellow');
        document.getElementById('hud-status').innerHTML = 'Mencari sinyal GPS...';

        let initialPositionFound = false;

        gpsWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                gpsLat = pos.coords.latitude;
                gpsLon = pos.coords.longitude;
                gpsSpeed = pos.coords.speed || 0;
                gpsHeading = pos.coords.heading || 0;
                gpsAccuracy = pos.coords.accuracy || 0;

                const speedKmh = Math.round(gpsSpeed * 3.6);

                // Update HUD
                document.getElementById('hud-lat').textContent = `Lat: ${gpsLat.toFixed(6)}`;
                document.getElementById('hud-lon').textContent = `Lon: ${gpsLon.toFixed(6)}`;
                document.getElementById('hud-speed-val').textContent = speedKmh;
                document.getElementById('m-speed').textContent = speedKmh;

                // Update pill
                updatePill('pill-gps', 'GPS ON', 'green');
                updatePill('pill-speed', `${speedKmh} km/h`, 'yellow');

                if (!initialPositionFound) {
                    initialPositionFound = true;
                    resolve();
                }
            },
            (err) => {
                console.error('GPS error:', err);
                updatePill('pill-gps', 'GPS ERROR', 'red');
                if (err.code === err.PERMISSION_DENIED) {
                    document.getElementById('hud-status').innerHTML = '⚠️ Akses Lokasi (GPS) Ditolak. Harap izinkan akses lokasi di browser untuk memulai.';
                } else {
                    document.getElementById('hud-status').innerHTML = '⚠️ Gagal mendapatkan sinyal GPS.';
                }
                if (!initialPositionFound) {
                    reject(err);
                }
            },
            {
                enableHighAccuracy: true,
                maximumAge: 1000,
                timeout: 10000
            }
        );
    });
}

function stopGPS() {
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
    updatePill('pill-gps', 'GPS OFF', 'red');
    updatePill('pill-speed', '0 km/h', '');
}

// ═══════════════════════════════════════════════
// 3. DETECTION LOOP — Capture frame → send to server
// ═══════════════════════════════════════════════
function startDetectionLoop() {
    const video = document.getElementById('camera-video');
    const captureCanvas = document.createElement('canvas');
    const captureCtx = captureCanvas.getContext('2d');
    let frameCount = 0;
    let lastFpsTime = Date.now();

    detectionLoop = setInterval(async () => {
        if (!video.videoWidth || video.paused) return;

        // Capture current video frame to hidden canvas
        captureCanvas.width = video.videoWidth;
        captureCanvas.height = video.videoHeight;
        captureCtx.drawImage(video, 0, 0);

        // Convert to base64 JPEG (quality 0.7 for speed)
        const frameData = captureCanvas.toDataURL('image/jpeg', 0.7);

        // Send to backend for YOLOv9 inference
        try {
            const resp = await fetch('/api/detect-frame', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    frame: frameData,
                    latitude: gpsLat,
                    longitude: gpsLon,
                    speed: gpsSpeed
                })
            });

            if (!resp.ok) return;
            const result = await resp.json();

            // Draw bounding boxes on overlay
            drawDetections(result.detections, video.videoWidth, video.videoHeight);

            // Update inference badge
            document.getElementById('m-inference').textContent = result.inference_ms;

            // FPS counter
            frameCount++;
            const now = Date.now();
            if (now - lastFpsTime >= 1000) {
                const fps = frameCount;
                frameCount = 0;
                lastFpsTime = now;
                document.getElementById('badge-fps').textContent =
                    `FPS: ${fps} | Inference: ${result.inference_ms} ms`;
            }

            // If detections found, trigger warning
            if (result.saved && result.saved.length > 0) {
                result.saved.forEach(det => triggerWarning(det));
            }
        } catch (e) {
            // Network error, silently continue
        }
    }, DETECT_INTERVAL_MS);
}

function stopDetectionLoop() {
    if (detectionLoop) {
        clearInterval(detectionLoop);
        detectionLoop = null;
    }
    // Clear overlay
    const overlay = document.getElementById('camera-overlay');
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
}

// ═══════════════════════════════════════════════
// 4. DRAW BOUNDING BOXES on canvas overlay
// ═══════════════════════════════════════════════
function drawDetections(detections, vw, vh) {
    const overlay = document.getElementById('camera-overlay');
    if (overlay.width !== vw) overlay.width = vw;
    if (overlay.height !== vh) overlay.height = vh;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, vw, vh);

    if (!detections || detections.length === 0) return;

    detections.forEach(det => {
        const { x1, y1, x2, y2, confidence, class: cls } = det;
        const w = x2 - x1, h = y2 - y1;

        // Color by confidence
        let color = '#34C759';
        if (confidence > 0.7) color = '#FF3B30';
        else if (confidence > 0.4) color = '#FF9F0A';

        // Main box
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x1, y1, w, h);

        // Corner highlights
        const cornerLen = Math.min(w, h) * 0.25;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        // TL
        ctx.beginPath(); ctx.moveTo(x1, y1 + cornerLen); ctx.lineTo(x1, y1); ctx.lineTo(x1 + cornerLen, y1); ctx.stroke();
        // TR
        ctx.beginPath(); ctx.moveTo(x2 - cornerLen, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + cornerLen); ctx.stroke();
        // BL
        ctx.beginPath(); ctx.moveTo(x1, y2 - cornerLen); ctx.lineTo(x1, y2); ctx.lineTo(x1 + cornerLen, y2); ctx.stroke();
        // BR
        ctx.beginPath(); ctx.moveTo(x2 - cornerLen, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - cornerLen); ctx.stroke();

        // Label background
        const label = `YOLOv9: ${cls} ${(confidence * 100).toFixed(0)}%`;
        ctx.font = 'bold 14px Outfit';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = color;
        ctx.fillRect(x1, y1 - 22, tw + 12, 22);
        // Label text
        ctx.fillStyle = '#0A0D12';
        ctx.fillText(label, x1 + 6, y1 - 6);
    });
}

// ═══════════════════════════════════════════════
// 5. WARNING SYSTEM — Visual + Audio TTS
// ═══════════════════════════════════════════════
function triggerWarning(det) {
    const card = document.getElementById('warning-card');
    const flash = document.getElementById('flash-overlay');
    const isMedium = det.severity === 'Medium';
    const isLow = det.severity === 'Low';

    // Flash screen border
    flash.className = 'flash-overlay ' + (isLow ? '' : isMedium ? 'warning' : 'danger');
    setTimeout(() => { flash.className = 'flash-overlay'; }, 2000);

    // Warning card content
    document.getElementById('warning-content').innerHTML = `
        <div class="warning-danger ${isMedium ? 'medium' : ''}">
            <h3>⚠️ LUBANG TERDETEKSI!</h3>
            <p>${det.severity === 'High' ? 'BAHAYA TINGGI — Kurangi kecepatan segera!' :
                 det.severity === 'Medium' ? 'Waspada — Lubang sedang di depan.' :
                 'Lubang kecil terdeteksi.'}</p>
            <div class="warn-grid">
                <div class="warn-item"><span class="wl">Diameter</span><span class="wv" style="color:var(--warn)">${det.diameter} cm</span></div>
                <div class="warn-item"><span class="wl">Kedalaman</span><span class="wv" style="color:var(--danger)">${det.depth} cm</span></div>
                <div class="warn-item"><span class="wl">Confidence</span><span class="wv" style="color:var(--primary)">${(det.confidence * 100).toFixed(0)}%</span></div>
                <div class="warn-item"><span class="wl">Kecepatan</span><span class="wv">${det.speed} km/h</span></div>
            </div>
        </div>
    `;

    // Voice alert (TTS)
    speakAlert(det.severity, det.diameter, det.depth);

    // Reset after 5s
    setTimeout(resetWarning, 5000);
}

function resetWarning() {
    document.getElementById('warning-content').innerHTML = `
        <div class="warning-safe">
            <div class="safe-icon">✓</div>
            <h3>Jalur Aman</h3>
            <p>Tidak ada lubang terdeteksi</p>
        </div>
    `;
}

function speakAlert(severity, diameter, depth) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    let msg = 'Peringatan! ';
    if (severity === 'High') {
        msg += `Lubang besar terdeteksi di depan! Kedalaman ${Math.round(depth)} sentimeter. Segera kurangi kecepatan!`;
    } else if (severity === 'Medium') {
        msg += `Lubang sedang terdeteksi. Harap waspada.`;
    } else {
        msg += `Lubang kecil terdeteksi.`;
    }

    const utt = new SpeechSynthesisUtterance(msg);
    utt.lang = 'id-ID';
    utt.rate = 1.05;
    window.speechSynthesis.speak(utt);
}


// ═══════════════════════════════════════════════
// 7. CHART.JS
// ═══════════════════════════════════════════════
function initChart() {
    sevChart = new Chart(document.getElementById('severityChart').getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Rendah', 'Sedang', 'Tinggi'],
            datasets: [{ data: [0, 0, 0], backgroundColor: ['#34C759', '#FF9F0A', '#FF3B30'], borderColor: '#121821', borderWidth: 2 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#8B9DB8', font: { size: 10 } } }
            }
        }
    });
}

function refreshStats() {
    fetch('/api/stats').then(r => r.json()).then(s => {
        document.getElementById('m-total').textContent = s.total;
        document.getElementById('m-high').textContent = s.severity_distribution.High || 0;
        sevChart.data.datasets[0].data = [
            s.severity_distribution.Low || 0,
            s.severity_distribution.Medium || 0,
            s.severity_distribution.High || 0
        ];
        sevChart.update();
    });
}

// ═══════════════════════════════════════════════
// 8. LOG TABLE — with Google Maps links
// ═══════════════════════════════════════════════
function addToLogTable(det) {
    const tbody = document.getElementById('log-body');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td>${det.id}</td>
        <td>${det.timestamp}</td>
        <td style="font-family:var(--mono);font-size:.75rem">${det.latitude.toFixed(6)}, ${det.longitude.toFixed(6)}</td>
        <td>${det.speed} km/h</td>
        <td>${det.diameter} cm</td>
        <td>${det.depth} cm</td>
        <td>${(det.confidence * 100).toFixed(0)}%</td>
        <td><span class="badge-sev ${det.severity.toLowerCase()}">${det.severity}</span></td>
        <td>${det.snapshot_path ? `<img src="${det.snapshot_path}" class="snap-thumb" onclick="window.open('${det.snapshot_path}','_blank')" alt="snap">` : '-'}</td>
        <td><a href="${det.google_maps_url}" target="_blank" class="gmaps-link">📍 Maps</a></td>
    `;
    // Prepend newest on top
    if (tbody.firstChild) tbody.insertBefore(tr, tbody.firstChild);
    else tbody.appendChild(tr);
}

// ═══════════════════════════════════════════════
// 9. LOAD EXISTING DATA
// ═══════════════════════════════════════════════
function loadExistingData() {
    fetch('/api/potholes').then(r => r.json()).then(data => {
        data.forEach(p => {
            addToLogTable(p);
        });
    });
    refreshStats();
}

// ═══════════════════════════════════════════════
// 10. SSE — Real-time events from server
// ═══════════════════════════════════════════════
function setupSSE() {
    eventSource = new EventSource('/stream');
    eventSource.onmessage = (ev) => {
        const det = JSON.parse(ev.data);
        addToLogTable(det);
        refreshStats();
    };
}

// ═══════════════════════════════════════════════
// 11. BUTTONS & CONTROLS
// ═══════════════════════════════════════════════
function setupButtons() {
    document.getElementById('btn-start').addEventListener('click', startSystem);
    document.getElementById('btn-stop').addEventListener('click', stopSystem);
}

async function startSystem() {
    if (isRunning) return;
    
    document.getElementById('btn-start').style.display = 'none';
    document.getElementById('btn-stop').style.display = 'inline-block';

    try {
        // Enforce GPS location first
        await startGPS();
        
        // Once GPS is obtained, start camera
        const camOk = await startCamera();
        if (camOk) {
            isRunning = true;
            // Wait a moment for camera to stabilize
            setTimeout(() => startDetectionLoop(), 1000);
        } else {
            stopSystem(); // Revert UI if camera fails
        }
    } catch (err) {
        // GPS failed or denied
        stopSystem();
    }
}

function stopSystem() {
    isRunning = false;
    stopDetectionLoop();
    stopCamera();
    stopGPS();

    document.getElementById('btn-start').style.display = 'inline-block';
    document.getElementById('btn-stop').style.display = 'none';
    document.getElementById('hud-status').innerHTML = 'Sistem dihentikan. Tekan <strong>"Mulai Deteksi"</strong> untuk mengaktifkan kembali.';
    document.getElementById('hud-speed-val').textContent = '0';
}

// ═══════════════════════════════════════════════
// 12. HELPERS
// ═══════════════════════════════════════════════
function updatePill(id, text, dotClass) {
    const pill = document.getElementById(id);
    const dot = pill.querySelector('.dot');
    pill.childNodes[pill.childNodes.length - 1].textContent = ' ' + text;
    if (dot) {
        dot.className = 'dot';
        if (dotClass) dot.classList.add(dotClass);
    }
}

function startClock() {
    setInterval(() => {
        const now = new Date();
        document.getElementById('clock').textContent = now.toLocaleTimeString('id-ID');
    }, 1000);
}



// Export data as JSON
function exportJSON() {
    fetch('/api/potholes').then(r => r.json()).then(data => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `deteksi_lubang_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

// Clear all data
function clearAll() {
    if (!confirm('Hapus SEMUA data deteksi lubang? Data tidak bisa dikembalikan.')) return;
    fetch('/api/potholes').then(r => r.json()).then(data => {
        const promises = data.map(p => fetch(`/api/potholes/${p.id}`, { method: 'DELETE' }));
        Promise.all(promises).then(() => {
            document.getElementById('log-body').innerHTML = '';
            refreshStats();
        });
    });
}
