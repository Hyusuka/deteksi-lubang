// ═══════════════════════════════════════════════
// YOLOv9 Pothole Detector — Mobile App Logic
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
const DETECT_INTERVAL_MS = 800;

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    initChart();
    loadExistingData();
    setupSSE();
    setupBottomSheet();
    registerServiceWorker();
    initCameraList();

    // Splash screen launch button
    document.getElementById('btn-launch').addEventListener('click', launchApp);
    document.getElementById('btn-stop').addEventListener('click', stopSystem);
});

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/sw.js')
            .then(reg => console.log('PWA Service Worker registered!', reg))
            .catch(err => console.error('PWA SW failed:', err));
    }
}

async function initCameraList() {
    const select = document.getElementById('camera-select');
    try {
        await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        
        select.innerHTML = '';
        if (videoDevices.length === 0) {
            select.innerHTML = '<option value="">Tidak ada kamera terdeteksi</option>';
            return;
        }

        videoDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `Kamera Eksternal/Internal ${index + 1}`;
            
            if (device.label.toLowerCase().includes('back') || device.label.toLowerCase().includes('environment') || device.label.toLowerCase().includes('belakang')) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    } catch (err) {
        console.error('Gagal mendapatkan daftar kamera', err);
        select.innerHTML = '<option value="">Izinkan akses kamera terlebih dahulu</option>';
    }
}

// ═══════════════════════════════════════════════
// 0. SPLASH → APP TRANSITION (GPS required first)
// ═══════════════════════════════════════════════
async function launchApp() {
    const btn = document.getElementById('btn-launch');
    btn.innerHTML = '<span class="btn-icon">⏳</span><span>Mengaktifkan GPS...</span>';
    btn.disabled = true;

    try {
        // Step 1: GPS must succeed first
        await startGPS();

        // Step 2: Start camera
        btn.innerHTML = '<span class="btn-icon">📷</span><span>Mengaktifkan Kamera...</span>';
        const camOk = await startCamera();

        if (!camOk) {
            btn.innerHTML = '<span class="btn-icon">⚠️</span><span>Kamera Gagal — Coba Lagi</span>';
            btn.disabled = false;
            stopGPS();
            return;
        }

        // Step 3: Hide splash, show app
        document.getElementById('splash-screen').style.display = 'none';
        document.getElementById('app-container').style.display = 'block';
        isRunning = true;

        // Step 4: Start detection loop after camera stabilizes
        setTimeout(() => startDetectionLoop(), 1000);

    } catch (err) {
        console.error('Launch failed:', err);
        btn.innerHTML = '<span class="btn-icon">📍</span><span>GPS Ditolak — Izinkan & Coba Lagi</span>';
        btn.disabled = false;
    }
}

// ═══════════════════════════════════════════════
// 1. CAMERA — Real device camera via getUserMedia
// ═══════════════════════════════════════════════
async function startCamera() {
    const video = document.getElementById('camera-video');
    const select = document.getElementById('camera-select');
    const selectedDeviceId = select.value;
    
    let constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    
    // Jika pengguna memilih kamera spesifik dari dropdown
    if (selectedDeviceId) {
        constraints = { video: { deviceId: { exact: selectedDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    }

    try {
        videoStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = videoStream;
        await video.play();

        const overlay = document.getElementById('camera-overlay');
        video.addEventListener('loadedmetadata', () => {
            overlay.width = video.videoWidth;
            overlay.height = video.videoHeight;
        });

        updatePill('pill-camera', 'CAM', 'green');
        return true;
    } catch (err) {
        console.error('Camera error:', err);
        updatePill('pill-camera', 'CAM ❌', 'red');
        return false;
    }
}

function stopCamera() {
    if (videoStream) {
        videoStream.getTracks().forEach(t => t.stop());
        videoStream = null;
    }
    document.getElementById('camera-video').srcObject = null;
    updatePill('pill-camera', 'CAM OFF', 'red');
}

// ═══════════════════════════════════════════════
// 2. GPS — Real position via Geolocation API
// ═══════════════════════════════════════════════
function startGPS() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('GPS tidak tersedia'));
            return;
        }

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

                // Update pills
                updatePill('pill-gps', 'GPS', 'green');

                if (!initialPositionFound) {
                    initialPositionFound = true;
                    resolve();
                }
            },
            (err) => {
                console.error('GPS error:', err);
                updatePill('pill-gps', 'GPS ❌', 'red');
                if (!initialPositionFound) {
                    reject(err);
                }
            },
            {
                enableHighAccuracy: true,
                maximumAge: 1000,
                timeout: 15000
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

        captureCanvas.width = video.videoWidth;
        captureCanvas.height = video.videoHeight;
        captureCtx.drawImage(video, 0, 0);

        const frameData = captureCanvas.toDataURL('image/jpeg', 0.7);

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

            drawDetections(result.detections, video.videoWidth, video.videoHeight);
            document.getElementById('m-inference').textContent = result.inference_ms;

            // FPS counter
            frameCount++;
            const now = Date.now();
            if (now - lastFpsTime >= 1000) {
                const fps = frameCount;
                frameCount = 0;
                lastFpsTime = now;
                document.getElementById('badge-fps').textContent =
                    `FPS: ${fps} | ${result.inference_ms}ms`;
            }

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

        let color = '#34C759';
        if (confidence > 0.7) color = '#FF3B30';
        else if (confidence > 0.4) color = '#FF9F0A';

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x1, y1, w, h);

        // Corner highlights
        const cornerLen = Math.min(w, h) * 0.25;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x1, y1 + cornerLen); ctx.lineTo(x1, y1); ctx.lineTo(x1 + cornerLen, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2 - cornerLen, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + cornerLen); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y2 - cornerLen); ctx.lineTo(x1, y2); ctx.lineTo(x1 + cornerLen, y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2 - cornerLen, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - cornerLen); ctx.stroke();

        // Label
        const label = `YOLOv9: ${cls} ${(confidence * 100).toFixed(0)}%`;
        ctx.font = 'bold 14px Outfit';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = color;
        ctx.fillRect(x1, y1 - 22, tw + 12, 22);
        ctx.fillStyle = '#0A0D12';
        ctx.fillText(label, x1 + 6, y1 - 6);
    });
}

// ═══════════════════════════════════════════════
// 5. WARNING SYSTEM — Visual + Audio TTS
// ═══════════════════════════════════════════════
function triggerWarning(det) {
    const flash = document.getElementById('flash-overlay');
    const isMedium = det.severity === 'Medium';
    const isLow = det.severity === 'Low';

    // Flash screen
    flash.className = 'flash-overlay ' + (isLow ? '' : isMedium ? 'warning' : 'danger');
    setTimeout(() => { flash.className = 'flash-overlay'; }, 2000);

    // Warning card
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

    // Voice alert
    speakAlert(det.severity, det.diameter, det.depth);

    // Vibrate device
    if ('vibrate' in navigator) {
        if (det.severity === 'High') navigator.vibrate([300, 100, 300, 100, 500]);
        else if (det.severity === 'Medium') navigator.vibrate([200, 100, 200]);
        else navigator.vibrate(150);
    }

    // Reset after 5s
    setTimeout(resetWarning, 5000);
}

function resetWarning() {
    document.getElementById('warning-content').innerHTML = `
        <div class="warning-safe">
            <div class="safe-icon">✓</div>
            <span>Jalur Aman</span>
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
// 6. CHART.JS
// ═══════════════════════════════════════════════
function initChart() {
    const canvas = document.getElementById('severityChart');
    if (!canvas) return;
    sevChart = new Chart(canvas.getContext('2d'), {
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
        if (sevChart) {
            sevChart.data.datasets[0].data = [
                s.severity_distribution.Low || 0,
                s.severity_distribution.Medium || 0,
                s.severity_distribution.High || 0
            ];
            sevChart.update();
        }
    });
}

// ═══════════════════════════════════════════════
// 7. LOG TABLE — Mobile-friendly with Google Maps
// ═══════════════════════════════════════════════
function addToLogTable(det) {
    const tbody = document.getElementById('log-body');
    const tr = document.createElement('tr');
    const timeShort = det.timestamp ? det.timestamp.split(' ')[1] || det.timestamp : '--';
    tr.innerHTML = `
        <td>${det.id}</td>
        <td>${timeShort}</td>
        <td>${det.speed} km/h</td>
        <td><span class="badge-sev ${det.severity.toLowerCase()}">${det.severity}</span></td>
        <td><a href="${det.google_maps_url}" target="_blank" class="gmaps-link">📍 Maps</a></td>
    `;
    if (tbody.firstChild) tbody.insertBefore(tr, tbody.firstChild);
    else tbody.appendChild(tr);
}

// ═══════════════════════════════════════════════
// 8. LOAD EXISTING DATA
// ═══════════════════════════════════════════════
function loadExistingData() {
    fetch('/api/potholes').then(r => r.json()).then(data => {
        data.forEach(p => addToLogTable(p));
    });
    refreshStats();
}

// ═══════════════════════════════════════════════
// 9. SSE — Real-time events from server
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
// 10. STOP SYSTEM
// ═══════════════════════════════════════════════
function stopSystem() {
    isRunning = false;
    stopDetectionLoop();
    stopCamera();
    stopGPS();

    // Go back to splash screen
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('splash-screen').style.display = 'flex';
    const btn = document.getElementById('btn-launch');
    btn.innerHTML = '<span class="btn-icon">▶</span><span>Mulai Deteksi</span>';
    btn.disabled = false;
}

// ═══════════════════════════════════════════════
// 11. BOTTOM SHEET (swipe toggle)
// ═══════════════════════════════════════════════
function setupBottomSheet() {
    const sheet = document.getElementById('bottom-sheet');
    const handle = document.getElementById('sheet-handle');
    if (!sheet || !handle) return;

    let expanded = false;

    handle.addEventListener('click', () => {
        expanded = !expanded;
        sheet.classList.toggle('expanded', expanded);
    });

    // Swipe gesture
    let startY = 0;
    handle.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
    }, { passive: true });

    handle.addEventListener('touchend', (e) => {
        const endY = e.changedTouches[0].clientY;
        const diff = startY - endY;
        if (diff > 40) {
            // Swipe up → expand
            expanded = true;
            sheet.classList.add('expanded');
        } else if (diff < -40) {
            // Swipe down → collapse
            expanded = false;
            sheet.classList.remove('expanded');
        }
    }, { passive: true });
}

// ═══════════════════════════════════════════════
// 12. HELPERS
// ═══════════════════════════════════════════════
function updatePill(id, text, dotClass) {
    const pill = document.getElementById(id);
    if (!pill) return;
    const dot = pill.querySelector('.dot');
    pill.childNodes[pill.childNodes.length - 1].textContent = ' ' + text;
    if (dot) {
        dot.className = 'dot';
        if (dotClass) dot.classList.add(dotClass);
    }
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
    if (!confirm('Hapus SEMUA data deteksi lubang?')) return;
    fetch('/api/potholes').then(r => r.json()).then(data => {
        const promises = data.map(p => fetch(`/api/potholes/${p.id}`, { method: 'DELETE' }));
        Promise.all(promises).then(() => {
            document.getElementById('log-body').innerHTML = '';
            refreshStats();
        });
    });
}
