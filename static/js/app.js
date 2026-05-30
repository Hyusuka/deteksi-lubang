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
let testMode = false; // Mode test static (tanpa GPS)

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
    let permissionStream = null;
    try {
        // Minta izin kamera singkat lalu LANGSUNG STOP stream-nya
        // agar tidak mengunci kamera saat startCamera() dipanggil nanti
        permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        // Hentikan stream izin segera — kamera harus bebas
        permissionStream.getTracks().forEach(t => t.stop());
        permissionStream = null;

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        
        select.innerHTML = '';
        if (videoDevices.length === 0) {
            select.innerHTML = '<option value="">Tidak ada kamera terdeteksi</option>';
            return;
        }

        let backCameraFound = false;
        videoDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            const label = device.label || `Kamera ${index + 1}`;
            option.text = label;
            
            // Auto-pilih kamera belakang
            const labelLow = label.toLowerCase();
            if (!backCameraFound && (labelLow.includes('back') || labelLow.includes('environment') || labelLow.includes('belakang') || labelLow.includes('rear'))) {
                option.selected = true;
                backCameraFound = true;
            }
            select.appendChild(option);
        });

        // Jika tidak ada label back terdeteksi, pilih kamera terakhir (biasanya kamera belakang di HP)
        if (!backCameraFound && videoDevices.length > 1) {
            select.selectedIndex = select.options.length - 1;
        }
    } catch (err) {
        console.error('Gagal mendapatkan daftar kamera', err);
        // Pastikan stream dilepas meskipun terjadi error
        if (permissionStream) {
            permissionStream.getTracks().forEach(t => t.stop());
        }
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

    // Strategi 1: Gunakan deviceId yang dipilih di dropdown
    if (selectedDeviceId) {
        try {
            videoStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: selectedDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
            video.srcObject = videoStream;
            await video.play();
            _onCameraReady(video);
            return true;
        } catch (err) {
            console.warn('Gagal buka kamera dengan deviceId, mencoba fallback facingMode...', err);
        }
    }

    // Strategi 2: Fallback ke facingMode environment (kamera belakang)
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        video.srcObject = videoStream;
        await video.play();
        _onCameraReady(video);
        return true;
    } catch (err) {
        console.warn('Gagal buka kamera facingMode environment, mencoba kamera apapun...', err);
    }

    // Strategi 3: Fallback terakhir — kamera apa saja yang tersedia
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video.srcObject = videoStream;
        await video.play();
        _onCameraReady(video);
        return true;
    } catch (err) {
        console.error('Semua strategi kamera gagal:', err);
        updatePill('pill-camera', 'CAM ❌', 'red');
        return false;
    }
}

function _onCameraReady(video) {
    const overlay = document.getElementById('camera-overlay');
    video.addEventListener('loadedmetadata', () => {
        overlay.width = video.videoWidth;
        overlay.height = video.videoHeight;
    });
    updatePill('pill-camera', 'CAM', 'green');
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
//    Kompatibel dengan Safari iOS, Chrome Android
// ═══════════════════════════════════════════════
function _updateGPSData(pos) {
    gpsLat = pos.coords.latitude;
    gpsLon = pos.coords.longitude;
    gpsSpeed = pos.coords.speed || 0;
    gpsHeading = pos.coords.heading || 0;
    gpsAccuracy = pos.coords.accuracy || 0;

    const speedKmh = Math.round(gpsSpeed * 3.6);

    // Update HUD (hanya jika elemen sudah ada di DOM)
    const elLat = document.getElementById('hud-lat');
    const elLon = document.getElementById('hud-lon');
    const elSpeed = document.getElementById('hud-speed-val');
    const elMSpeed = document.getElementById('m-speed');
    if (elLat) elLat.textContent = `Lat: ${gpsLat.toFixed(6)}`;
    if (elLon) elLon.textContent = `Lon: ${gpsLon.toFixed(6)}`;
    if (elSpeed) elSpeed.textContent = speedKmh;
    if (elMSpeed) elMSpeed.textContent = speedKmh;

    updatePill('pill-gps', 'GPS', 'green');
}

function startGPS() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('GPS tidak tersedia di browser ini'));
            return;
        }

        let resolved = false;

        // Fase 1: getCurrentPosition — cepat dan didukung baik oleh Safari
        // Safari iOS sering gagal pada watchPosition langsung, tapi getCurrentPosition lebih stabil
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                _updateGPSData(pos);
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
                // Setelah posisi awal didapat, mulai watch untuk update kontinu
                _startGPSWatch();
            },
            (err) => {
                console.warn('getCurrentPosition gagal, mencoba watchPosition...', err);
                // Fase 2: Fallback ke watchPosition jika getCurrentPosition gagal
                _startGPSWatch();
                // Beri timeout tambahan untuk watchPosition mendapat posisi pertama
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        // Jika masih belum dapat posisi, resolve saja agar app bisa berjalan
                        // GPS akan tetap mencoba di background via watchPosition
                        console.warn('GPS timeout - app dilanjutkan tanpa posisi awal');
                        updatePill('pill-gps', 'GPS ⏳', 'yellow');
                        resolve();
                    }
                }, 10000);
            },
            {
                enableHighAccuracy: true,
                maximumAge: 30000,  // Terima posisi cached hingga 30 detik (penting untuk Safari)
                timeout: 15000      // Timeout lebih panjang untuk Safari iOS
            }
        );

        function _startGPSWatch() {
            if (gpsWatchId !== null) return; // Sudah dimulai
            gpsWatchId = navigator.geolocation.watchPosition(
                (pos) => {
                    _updateGPSData(pos);
                    if (!resolved) {
                        resolved = true;
                        resolve();
                    }
                },
                (err) => {
                    console.warn('watchPosition error:', err.message);
                    // Jangan reject — biarkan app tetap jalan, GPS akan retry otomatis
                    updatePill('pill-gps', 'GPS ⚠️', 'yellow');
                },
                {
                    enableHighAccuracy: true,
                    maximumAge: 5000,
                    timeout: 30000  // Timeout sangat panjang untuk Safari
                }
            );
        }
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
    const radius = det.diameter / 2;
    const vol = det.volume || Math.max(0.1, Math.round((0.5 * 3.14159 * Math.pow(radius, 2) * det.depth / 1000) * 10) / 10);

    document.getElementById('warning-content').innerHTML = `
        <div class="warning-danger ${isMedium ? 'medium' : ''}">
            <h3>⚠️ LUBANG TERDETEKSI!</h3>
            <p>${det.severity === 'High' ? 'BAHAYA TINGGI — Kurangi kecepatan segera!' :
                 det.severity === 'Medium' ? 'Waspada — Lubang sedang di depan.' :
                 'Lubang kecil terdeteksi.'}</p>
            <div class="warn-grid" style="grid-template-columns: repeat(2, 1fr);">
                <div class="warn-item"><span class="wl">Diameter</span><span class="wv" style="color:var(--warn)">${det.diameter} cm</span></div>
                <div class="warn-item"><span class="wl">Kedalaman</span><span class="wv" style="color:var(--danger)">${det.depth} cm</span></div>
                <div class="warn-item"><span class="wl">Volume</span><span class="wv" style="color:var(--cyan)">${vol} L</span></div>
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
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', (e) => {
        // Jangan buka modal jika mengklik link Google Maps langsung
        if (!e.target.classList.contains('gmaps-link')) {
            openPotholeModal(det);
        }
    });

    const timeShort = det.timestamp ? det.timestamp.split(' ')[1] || det.timestamp : '--';
    tr.innerHTML = `
        <td>${det.id}</td>
        <td>${timeShort}</td>
        <td>${det.speed} km/h</td>
        <td><span class="badge-sev ${det.severity.toLowerCase()}">${det.severity}</span></td>
        <td><a href="${det.google_maps_url}" target="_blank" class="gmaps-link" onclick="event.stopPropagation();">📍 Maps</a></td>
    `;
    if (tbody.firstChild) tbody.insertBefore(tr, tbody.firstChild);
    else tbody.appendChild(tr);
}

// ═══════════════════════════════════════════════
// LIGHTBOX / PHOTO VIEWER MODAL CONTROLS
// ═══════════════════════════════════════════════
function openPotholeModal(det) {
    document.getElementById('modal-img').src = det.snapshot_path || '';
    
    const sevBadge = document.getElementById('modal-severity');
    sevBadge.textContent = det.severity;
    sevBadge.className = 'm-val badge-sev ' + det.severity.toLowerCase();
    
    document.getElementById('modal-diameter').textContent = `${det.diameter} cm`;
    document.getElementById('modal-depth').textContent = `${det.depth} cm`;
    
    // Hitung volume jika belum ada di objek det (sebagai fallback dinamis)
    const radius = det.diameter / 2;
    const vol = det.volume || Math.max(0.1, Math.round((0.5 * 3.14159 * Math.pow(radius, 2) * det.depth / 1000) * 10) / 10);
    document.getElementById('modal-volume').textContent = `${vol} Liter`;
    
    document.getElementById('modal-time').textContent = det.timestamp || '--';
    document.getElementById('modal-speed').textContent = `${det.speed} km/h`;
    
    const lat = typeof det.latitude === 'number' ? det.latitude.toFixed(6) : det.latitude;
    const lon = typeof det.longitude === 'number' ? det.longitude.toFixed(6) : det.longitude;
    document.getElementById('modal-coords').textContent = `${lat}, ${lon}`;
    document.getElementById('modal-maps-btn').href = det.google_maps_url || '#';
    
    document.getElementById('pothole-modal').style.display = 'flex';
}

function closePotholeModal() {
    document.getElementById('pothole-modal').style.display = 'none';
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

// ═══════════════════════════════════════════════
// 13. TEST STATIC MODE — Uji tanpa GPS / kecepatan
// ═══════════════════════════════════════════════

/**
 * Aktifkan/nonaktifkan panel Test Static.
 * Jika panel belum ada, buat dahulu.
 */
function toggleTestMode() {
    testMode = !testMode;
    let panel = document.getElementById('test-mode-panel');
    if (!panel) {
        panel = createTestPanel();
        document.body.appendChild(panel);
    }
    panel.style.display = testMode ? 'block' : 'none';

    const btn = document.getElementById('btn-test-mode');
    if (btn) {
        btn.textContent = testMode ? '🧪 Tutup Test' : '🧪 Mode Test';
        btn.style.background = testMode ? 'var(--danger)' : '';
    }
}

function createTestPanel() {
    const panel = document.createElement('div');
    panel.id = 'test-mode-panel';
    panel.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: #0A0D12EE; z-index: 9999; overflow-y: auto;
        padding: 20px; display: none; font-family: Outfit, sans-serif;
    `;
    panel.innerHTML = `
        <div style="max-width:600px; margin:0 auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h2 style="color:#00E5FF; margin:0;">🧪 Mode Test Static</h2>
                <button onclick="toggleTestMode()" style="
                    background:#FF3B30; color:#fff; border:none;
                    padding:8px 16px; border-radius:8px; cursor:pointer;
                    font-size:14px; font-family:Outfit,sans-serif;
                ">✕ Tutup</button>
            </div>
            <p style="color:#8B9DB8; margin-bottom:16px;">
                Upload foto atau ambil dari kamera — deteksi dijalankan <b style='color:#fff'>tanpa filter kecepatan</b>.
                Cocok untuk menguji model di tempat diam.
            </p>

            <!-- Upload / Kamera -->
            <div style="display:flex; gap:10px; margin-bottom:16px;">
                <label for="test-file-input" style="
                    flex:1; padding:12px; background:#1E2533; border:2px dashed #2A3447;
                    border-radius:10px; text-align:center; cursor:pointer; color:#8B9DB8;
                    font-size:13px;
                ">📁 Pilih Foto</label>
                <input id="test-file-input" type="file" accept="image/*" capture="environment"
                    style="display:none;" onchange="runTestOnFile(this)">
                <button onclick="runTestOnCamera()" style="
                    flex:1; padding:12px; background:#1E2533; border:2px solid #2A3447;
                    border-radius:10px; cursor:pointer; color:#8B9DB8; font-size:13px;
                    font-family:Outfit,sans-serif;
                ">📷 Dari Kamera Live</button>
            </div>

            <!-- Preview -->
            <div id="test-preview-wrap" style="position:relative; background:#121821; border-radius:10px; overflow:hidden; margin-bottom:16px; display:none;">
                <img id="test-preview-img" style="width:100%; display:block;">
                <canvas id="test-overlay-canvas" style="position:absolute;top:0;left:0;width:100%;height:100%;"></canvas>
            </div>

            <!-- Result -->
            <div id="test-result-box" style="
                background:#1E2533; border-radius:10px; padding:16px;
                color:#8B9DB8; font-size:13px; min-height:80px;
                white-space: pre-wrap; font-family: monospace;
            ">Belum ada hasil. Upload foto untuk mulai uji.</div>
        </div>
    `;
    return panel;
}

async function runTestOnFile(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = async (e) => {
        const dataUrl = e.target.result;
        await runTestDetect(dataUrl);
    };
    reader.readAsDataURL(file);
}

async function runTestOnCamera() {
    const video = document.getElementById('camera-video');
    if (!video || !video.videoWidth) {
        document.getElementById('test-result-box').textContent =
            '⚠️ Kamera belum aktif. Tekan Mulai Deteksi dahulu, lalu buka Test Mode.';
        return;
    }
    const cap = document.createElement('canvas');
    cap.width = video.videoWidth;
    cap.height = video.videoHeight;
    cap.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = cap.toDataURL('image/jpeg', 0.85);
    await runTestDetect(dataUrl);
}

async function runTestDetect(dataUrl) {
    // Tampilkan preview
    const wrap = document.getElementById('test-preview-wrap');
    const img  = document.getElementById('test-preview-img');
    const resultBox = document.getElementById('test-result-box');
    wrap.style.display = 'block';
    img.src = dataUrl;
    resultBox.textContent = '⏳ Menjalankan deteksi...';

    let response;
    try {
        response = await fetch('/api/test-detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frame: dataUrl })
        });
    } catch (err) {
        resultBox.textContent = `❌ Gagal koneksi ke server: ${err.message}`;
        return;
    }

    if (!response.ok) {
        try {
            const errData = await response.json();
            resultBox.textContent = `❌ Server error: ${response.status}\nDetail: ${errData.message || errData.error}`;
        } catch (e) {
            resultBox.textContent = `❌ Server error: ${response.status} ${response.statusText}`;
        }
        return;
    }

    const result = await response.json();

    // Gambar bounding box di atas canvas overlay
    img.onload = () => {
        const canvas = document.getElementById('test-overlay-canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Deteksi yang LOLOS (hijau)
        (result.detections || []).forEach(det => {
            const { x1, y1, x2, y2, confidence, class: cls } = det;
            ctx.strokeStyle = '#34C759';
            ctx.lineWidth = 4;
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            ctx.fillStyle = '#34C75988';
            ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 16px Outfit';
            ctx.fillText(`✓ ${cls} ${(confidence*100).toFixed(0)}%`, x1 + 4, y1 + 20);
        });

        // Deteksi yang DIBUANG (merah semi-transparan)
        (result.rejected || []).forEach(det => {
            const { x1, y1, x2, y2, confidence, class: cls, reject_reason } = det;
            ctx.strokeStyle = '#FF3B3066';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            ctx.setLineDash([]);
            ctx.fillStyle = '#FF3B3033';
            ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
            ctx.fillStyle = '#FF9F0A';
            ctx.font = '12px Outfit';
            ctx.fillText(`✗ ${reject_reason || 'filtered'}`, x1 + 4, y1 + 16);
        });
    };
    // Trigger onload jika gambar sudah cached
    if (img.complete) img.onload();

    // Tampilkan teks hasil
    const passed   = result.detections?.length || 0;
    const rejected = result.rejected?.length   || 0;
    const config   = result.config || {};

    let txt = `📊 HASIL DETEKSI\n`;
    txt += `━━━━━━━━━━━━━━━━━━━━━\n`;
    txt += `✅ Lolos filter  : ${passed} deteksi\n`;
    txt += `❌ Dibuang filter: ${rejected} deteksi\n`;
    txt += `⚡ Waktu inferensi: ${result.inference_ms} ms\n`;
    txt += `📐 Ukuran frame  : ${result.frame_size?.w}×${result.frame_size?.h}\n`;
    txt += `\n⚙️  KONFIGURASI AKTIF\n`;
    txt += `━━━━━━━━━━━━━━━━━━━━━\n`;
    txt += `  Model          : ${config.model}\n`;
    txt += `  CONF_THRESHOLD : ${config.conf_threshold}\n`;
    txt += `  ROI_BOTTOM_FRAC: ${config.roi_bottom_frac} (objek harus di bawah ${(config.roi_bottom_frac*100).toFixed(0)}% frame)\n`;
    txt += `  Aspek rasio    : ${config.min_aspect_ratio} – ${config.max_aspect_ratio}\n`;

    if (rejected > 0) {
        txt += `\n🔍 ALASAN DIBUANG\n`;
        txt += `━━━━━━━━━━━━━━━━━━━━━\n`;
        (result.rejected || []).forEach((det, i) => {
            txt += `  [${i+1}] ${det.class} conf=${(det.confidence*100).toFixed(0)}% → ${det.reject_reason}\n`;
        });
    }

    if (passed === 0 && rejected === 0) {
        txt += `\n⚠️  Model tidak mendeteksi objek apapun.\n`;
        txt += `Kemungkinan: model yolov9t.pt belum dilatih dengan dataset lubang jalan.\n`;
        txt += `Coba ganti model dengan model yang sudah fine-tuned untuk pothole detection.`;
    }

    resultBox.textContent = txt;
}
