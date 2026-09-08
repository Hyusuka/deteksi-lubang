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

// Stabilizer state (EMA anti-guncangan)
let stabilizerEnabled = true;

// Alert sound module state
let alertMode = localStorage.getItem('alertMode') || 'bell'; // 'bell' | 'ai' | 'silent'
let _audioCtx = null;

// Detection settings
const DETECT_INTERVAL_MS = 150;


// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    initChart();
    loadExistingData();
    setupSSE();
    setupBottomSheet();
    registerServiceWorker();
    initCameraList();
    initSoundSelector();

    // Splash screen launch button
    document.getElementById('btn-launch').addEventListener('click', launchApp);
    document.getElementById('btn-stop').addEventListener('click', stopSystem);

    // Stabilizer toggle button
    const btnStab = document.getElementById('btn-stabilizer');
    if (btnStab) btnStab.addEventListener('click', toggleStabilizer);
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

        // Step 2: Start camera (dengan delay kecil agar lock hardware dari initCameraList benar-benar terlepas)
        btn.innerHTML = '<span class="btn-icon">📷</span><span>Mengaktifkan Kamera...</span>';
        await new Promise(r => setTimeout(r, 300));
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

    let lastError = null;

    // Strategi 1: Gunakan deviceId yang dipilih di dropdown (tanpa width/height agar tidak Overconstrained)
    if (selectedDeviceId) {
        try {
            videoStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: selectedDeviceId } },
                audio: false
            });
            video.srcObject = videoStream;
            await video.play();
            _onCameraReady(video);
            return true;
        } catch (err) {
            console.warn('Gagal buka kamera dengan deviceId:', err.name, err.message);
            lastError = err;
            await new Promise(r => setTimeout(r, 300));
        }
    }

    // Strategi 2: Fallback ke facingMode environment (kamera belakang)
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false
        });
        video.srcObject = videoStream;
        await video.play();
        _onCameraReady(video);
        return true;
    } catch (err) {
        console.warn('Gagal buka kamera facingMode environment:', err.name, err.message);
        lastError = err;
        await new Promise(r => setTimeout(r, 300));
    }

    // Strategi 3: Fallback terakhir — kamera apa saja yang tersedia (paling dasar)
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video.srcObject = videoStream;
        await video.play();
        _onCameraReady(video);
        return true;
    } catch (err) {
        console.error('Semua strategi kamera gagal:', err.name, err.message);
        updatePill('pill-camera', 'CAM ❌', 'red');
        if (lastError && lastError.name === 'NotReadableError') {
            alert('Kamera sedang digunakan oleh aplikasi lain (seperti WhatsApp/Zoom). Tutup aplikasi tersebut lalu coba lagi.');
        } else if (lastError && lastError.name === 'NotAllowedError') {
            alert('Izin kamera ditolak oleh browser. Silakan periksa pengaturan situs.');
        }
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

    let isDetecting = false;

    detectionLoop = setInterval(async () => {
        if (!video.videoWidth || video.paused || isDetecting) return;
        isDetecting = true;

        // Resize frame untuk meringankan beban base64 dan mencegah drop FPS
        const maxDim = 1280;
        let scale = Math.min(maxDim / video.videoWidth, maxDim / video.videoHeight);
        if (scale > 1) scale = 1;

        captureCanvas.width = video.videoWidth * scale;
        captureCanvas.height = video.videoHeight * scale;
        captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

        // Turunkan quality ke 0.75 agar ukuran data sangat kecil
        const frameData = captureCanvas.toDataURL('image/jpeg', 0.75);

        try {
            const resp = await fetch('/api/detect-frame', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    frame: frameData,
                    latitude: gpsLat,
                    longitude: gpsLon,
                    speed: gpsSpeed,
                    stabilizer: stabilizerEnabled
                })
            });

            if (resp.ok) {
                const result = await resp.json();

                // Skala balik koordinat bounding box ke ukuran layar asli
                const scaleFactor = 1 / scale;
                if (result.detections) {
                    result.detections.forEach(det => {
                        det.x1 *= scaleFactor;
                        det.y1 *= scaleFactor;
                        det.x2 *= scaleFactor;
                        det.y2 *= scaleFactor;
                        // Skala koordinat poligon segmentasi ke ukuran layar asli
                        if (det.segmentation) {
                            det.segmentation = det.segmentation.map(p => [p[0] * scaleFactor, p[1] * scaleFactor]);
                        }
                    });
                }

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

                // Cek apakah model YOLO aktif di server
                if (result.model_active === false) {
                    const statusBar = document.getElementById('hud-status');
                    if (statusBar) statusBar.textContent = '⚠️ Model YOLO tidak aktif — deteksi tidak berjalan';
                    if (statusBar) statusBar.style.color = 'var(--danger)';
                }
            }
        } catch (e) {
            // Network error, silently continue
        } finally {
            isDetecting = false;
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
// 3.5. STABILIZER TOGGLE — On/Off anti-guncangan
// ═══════════════════════════════════════════════
let _toastTimer = null;

function showToast(icon, text, type) {
    const toast = document.getElementById('toast-notification');
    if (!toast) return;
    document.getElementById('toast-icon').textContent = icon;
    document.getElementById('toast-text').textContent = text;
    toast.className = 'toast-notification show ' + (type || '');

    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
        toast.className = 'toast-notification';
        _toastTimer = null;
    }, 2500);
}

function toggleStabilizer() {
    stabilizerEnabled = !stabilizerEnabled;
    const btn = document.getElementById('btn-stabilizer');
    if (btn) {
        if (stabilizerEnabled) {
            btn.innerHTML = '🔒 <span class="btn-txt">STAB</span>';
            btn.classList.remove('stab-off');
            btn.classList.add('stab-on');
        } else {
            btn.innerHTML = '🔓 <span class="btn-txt">OFF</span>';
            btn.classList.remove('stab-on');
            btn.classList.add('stab-off');
        }
    }
    const pill = document.getElementById('pill-stab');
    if (pill) {
        const dot = pill.querySelector('.dot');
        if (stabilizerEnabled) {
            pill.childNodes[pill.childNodes.length - 1].textContent = ' STAB';
            if (dot) { dot.className = 'dot green'; }
        } else {
            pill.childNodes[pill.childNodes.length - 1].textContent = ' STAB OFF';
            if (dot) { dot.className = 'dot red'; }
        }
    }

    // Tampilkan toast notification
    if (stabilizerEnabled) {
        showToast('🔒', 'Video Stabilizer Diaktifkan', 'toast-on');
    } else {
        showToast('🔓', 'Video Stabilizer Dimatikan', 'toast-off');
    }
}

// ═══════════════════════════════════════════════
// 4. DRAW SEGMENTATION MASKS + BOUNDING BOXES on canvas overlay
// ═══════════════════════════════════════════════
function drawDetections(detections, vw, vh) {
    const overlay = document.getElementById('camera-overlay');
    if (overlay.width !== vw) overlay.width = vw;
    if (overlay.height !== vh) overlay.height = vh;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, vw, vh);

    if (!detections || detections.length === 0) return;

    detections.forEach((det, index) => {
        const { x1, y1, x2, y2, confidence, class: cls, segmentation } = det;
        const w = x2 - x1, h = y2 - y1;

        let color = '#34C759';
        let rgbColor = '52, 199, 89';
        if (confidence > 0.7) { color = '#FF3B30'; rgbColor = '255, 59, 48'; }
        else if (confidence > 0.4) { color = '#FF9F0A'; rgbColor = '255, 159, 10'; }

        // Gambar poligon segmentasi (filled semi-transparan + outline) di-clip ke dalam bounding box
        if (segmentation && segmentation.length >= 3) {
            ctx.save();
            // Clip ke area bounding box agar mask tidak keluar
            ctx.beginPath();
            ctx.rect(x1, y1, w, h);
            ctx.clip();

            // Fill semi-transparan
            ctx.fillStyle = `rgba(${rgbColor}, 0.35)`;
            ctx.beginPath();
            ctx.moveTo(segmentation[0][0], segmentation[0][1]);
            for (let i = 1; i < segmentation.length; i++) {
                ctx.lineTo(segmentation[i][0], segmentation[i][1]);
            }
            ctx.closePath();
            ctx.fill();

            // Garis kontur (outline) di sekeliling mask
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(segmentation[0][0], segmentation[0][1]);
            for (let i = 1; i < segmentation.length; i++) {
                ctx.lineTo(segmentation[i][0], segmentation[i][1]);
            }
            ctx.closePath();
            ctx.stroke();

            ctx.restore();

            // Hitung persentase area segmentasi terhadap bounding box
            const bboxArea = w * h;
            if (bboxArea > 0) {
                // Shoelace formula untuk polygon area
                let segArea = 0;
                for (let i = 0; i < segmentation.length; i++) {
                    const j = (i + 1) % segmentation.length;
                    segArea += segmentation[i][0] * segmentation[j][1];
                    segArea -= segmentation[j][0] * segmentation[i][1];
                }
                segArea = Math.abs(segArea) / 2;
                const maskPct = Math.min(100, Math.round((segArea / bboxArea) * 100));

                // Label persentase mask di pojok kanan bawah bounding box
                const maskLabel = `Mask: ${maskPct}%`;
                ctx.font = 'bold 11px Outfit';
                const mlw = ctx.measureText(maskLabel).width;
                ctx.fillStyle = `rgba(0,0,0,0.6)`;
                ctx.fillRect(x2 - mlw - 10, y2 - 20, mlw + 8, 18);
                ctx.fillStyle = '#FFFFFF';
                ctx.fillText(maskLabel, x2 - mlw - 6, y2 - 6);
            }
        }

        // Bounding box rectangle
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
        const label = `${index + 1}. ${cls} ${(confidence * 100).toFixed(0)}%`;
        ctx.font = 'bold 14px Outfit';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = color;
        ctx.fillRect(x1, y1 - 22, tw + 12, 22);
        ctx.fillStyle = '#0A0D12';
        ctx.fillText(label, x1 + 6, y1 - 6);
    });
}

// ═══════════════════════════════════════════════
// 5. WARNING SYSTEM — Multi-Mode (Bell / AI / Silent)
// ═══════════════════════════════════════════════

// ── 5.1 Bell Sound Engine (Web Audio API) ──
function _getAudioCtx() {
    if (!_audioCtx || _audioCtx.state === 'closed') {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }
    return _audioCtx;
}

function playBellAlert(severity) {
    const ctx = _getAudioCtx();
    const configs = {
        'High': { freq: 880, repeat: 3, duration: 0.28, gap: 0.12, volume: 0.7, type: 'sine' },
        'Medium': { freq: 660, repeat: 2, duration: 0.22, gap: 0.15, volume: 0.5, type: 'sine' },
        'Low': { freq: 440, repeat: 1, duration: 0.18, gap: 0, volume: 0.35, type: 'sine' }
    };
    const cfg = configs[severity] || configs['Low'];

    for (let i = 0; i < cfg.repeat; i++) {
        const startTime = ctx.currentTime + i * (cfg.duration + cfg.gap);

        // Oscillator — bell tone
        const osc = ctx.createOscillator();
        osc.type = cfg.type;
        osc.frequency.setValueAtTime(cfg.freq, startTime);
        // Slight pitch bend down for bell character
        osc.frequency.exponentialRampToValueAtTime(cfg.freq * 0.7, startTime + cfg.duration);

        // Secondary harmonic for richer bell
        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(cfg.freq * 2.5, startTime);
        osc2.frequency.exponentialRampToValueAtTime(cfg.freq * 1.8, startTime + cfg.duration);

        // Gain envelope (ADSR-like)
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(cfg.volume, startTime + 0.01); // Attack
        gain.gain.exponentialRampToValueAtTime(cfg.volume * 0.3, startTime + cfg.duration * 0.4); // Decay
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + cfg.duration); // Release

        const gain2 = ctx.createGain();
        gain2.gain.setValueAtTime(0, startTime);
        gain2.gain.linearRampToValueAtTime(cfg.volume * 0.15, startTime + 0.01);
        gain2.gain.exponentialRampToValueAtTime(0.001, startTime + cfg.duration * 0.6);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + cfg.duration + 0.05);
        osc2.start(startTime);
        osc2.stop(startTime + cfg.duration + 0.05);
    }
}

// ── 5.2 AI Voice (TTS) ──
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

// ── 5.3 triggerWarning — dispatches per alertMode ──
function triggerWarning(det) {
    const flash = document.getElementById('flash-overlay');
    const isMedium = det.severity === 'Medium';
    const isLow = det.severity === 'Low';
    const isHigh = det.severity === 'High';

    // ── Visual Flash (mode-specific styling) ──
    let flashClass = 'flash-overlay';
    if (!isLow) {
        if (alertMode === 'bell') {
            flashClass += isMedium ? ' warning-bell' : ' danger-bell';
        } else if (alertMode === 'silent') {
            flashClass += isMedium ? ' warning-silent' : ' danger-silent';
        } else {
            flashClass += isMedium ? ' warning' : ' danger';
        }
    }
    flash.className = flashClass;
    setTimeout(() => { flash.className = 'flash-overlay'; }, alertMode === 'silent' ? 3000 : 2000);

    // ── Warning card (always shown) ──
    const radius = det.diameter / 2;
    const vol = det.volume || Math.max(0.1, Math.round((0.5 * 3.14159 * Math.pow(radius, 2) * det.depth / 1000) * 10) / 10);

    const modeLabel = alertMode === 'bell' ? '🔔 Bell' : alertMode === 'ai' ? '🤖 AI' : '🔕 Silent';
    document.getElementById('warning-content').innerHTML = `
        <div class="warning-danger ${isMedium ? 'medium' : ''}">
            <h3>⚠️ LUBANG TERDETEKSI! <span style="font-size:0.65rem;opacity:0.7;font-weight:400;">${modeLabel}</span></h3>
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

    // ── Audio alert (per mode) ──
    if (alertMode === 'bell') {
        playBellAlert(det.severity);
    } else if (alertMode === 'ai') {
        speakAlert(det.severity, det.diameter, det.depth);
    }
    // 'silent' → no audio

    // ── Haptic vibration (all modes, varied intensity) ──
    if ('vibrate' in navigator) {
        if (alertMode === 'silent') {
            // Silent mode: lighter haptic
            if (isHigh) navigator.vibrate([100, 50, 100]);
            else if (isMedium) navigator.vibrate(80);
            else navigator.vibrate(40);
        } else {
            // Normal haptic
            if (isHigh) navigator.vibrate([300, 100, 300, 100, 500]);
            else if (isMedium) navigator.vibrate([200, 100, 200]);
            else navigator.vibrate(150);
        }
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

// ═══════════════════════════════════════════════
// 5.4 SOUND SELECTOR UI — Splash Screen & HUD
// ═══════════════════════════════════════════════
const ALERT_MODES = ['bell', 'ai', 'silent'];
const ALERT_MODE_META = {
    bell: { icon: '🔔', label: 'BELL', toastText: 'Mode Bell Alert Aktif' },
    ai: { icon: '🤖', label: 'AI', toastText: 'Mode Suara AI Aktif' },
    silent: { icon: '🔕', label: 'MUTE', toastText: 'Mode Silent (Visual Only)' }
};

function initSoundSelector() {
    // Restore saved mode from localStorage
    const saved = localStorage.getItem('alertMode');
    if (saved && ALERT_MODES.includes(saved)) {
        alertMode = saved;
    } else {
        alertMode = 'bell';
    }
    _updateSoundSelectorUI();
    _updateHUDSoundPill();
}

function setAlertMode(mode) {
    if (!ALERT_MODES.includes(mode)) return;
    alertMode = mode;
    localStorage.setItem('alertMode', mode);
    _updateSoundSelectorUI();
    _updateHUDSoundPill();

    // Haptic feedback on selection
    if ('vibrate' in navigator) navigator.vibrate(30);
}

function _updateSoundSelectorUI() {
    // Update splash screen cards
    document.querySelectorAll('.sound-card').forEach(card => {
        if (card.dataset.mode === alertMode) {
            card.classList.add('active');
        } else {
            card.classList.remove('active');
        }
    });
}

function _updateHUDSoundPill() {
    const pill = document.getElementById('sound-mode-pill');
    const icon = document.getElementById('smp-icon');
    const label = document.getElementById('smp-label');
    if (!pill) return;

    const meta = ALERT_MODE_META[alertMode];
    pill.setAttribute('data-mode', alertMode);
    if (icon) icon.textContent = meta.icon;
    if (label) label.textContent = meta.label;
}

function cycleAlertMode() {
    const idx = ALERT_MODES.indexOf(alertMode);
    const nextIdx = (idx + 1) % ALERT_MODES.length;
    const nextMode = ALERT_MODES[nextIdx];
    setAlertMode(nextMode);

    // Show toast
    const meta = ALERT_MODE_META[nextMode];
    showToast(meta.icon, meta.toastText, 'toast-on');

    // Haptic
    if ('vibrate' in navigator) navigator.vibrate(50);
}

// ── Preview sounds for splash screen ──
let _previewTimeout = null;
function previewSound(mode) {
    // Clear any previous preview
    if (_previewTimeout) clearTimeout(_previewTimeout);
    document.querySelectorAll('.sound-preview-btn').forEach(b => b.classList.remove('playing'));

    const btn = document.getElementById('prev-' + mode);

    if (mode === 'bell') {
        if (btn) { btn.classList.add('playing'); btn.textContent = '🔊 Playing...'; }
        playBellAlert('High');
        // Haptic demo
        if ('vibrate' in navigator) navigator.vibrate([200, 80, 200]);
        _previewTimeout = setTimeout(() => {
            if (btn) { btn.classList.remove('playing'); btn.textContent = '▶ Preview'; }
        }, 1500);

    } else if (mode === 'ai') {
        if (btn) { btn.classList.add('playing'); btn.textContent = '🔊 Playing...'; }
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utt = new SpeechSynthesisUtterance('Peringatan! Lubang besar terdeteksi di depan. Segera kurangi kecepatan!');
            utt.lang = 'id-ID';
            utt.rate = 1.05;
            utt.onend = () => {
                if (btn) { btn.classList.remove('playing'); btn.textContent = '▶ Preview'; }
            };
            window.speechSynthesis.speak(utt);
        }
        if ('vibrate' in navigator) navigator.vibrate([300, 100, 300]);
        _previewTimeout = setTimeout(() => {
            if (btn) { btn.classList.remove('playing'); btn.textContent = '▶ Preview'; }
        }, 5000);

    } else if (mode === 'silent') {
        if (btn) { btn.classList.add('playing'); btn.textContent = '📳 Vibrating...'; }
        if ('vibrate' in navigator) navigator.vibrate([80, 40, 80]);
        _previewTimeout = setTimeout(() => {
            if (btn) { btn.classList.remove('playing'); btn.textContent = '▶ Preview'; }
        }, 1000);
    }
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
    if (!confirm('Hapus SEMUA data PotDeck?')) return;
    fetch('/api/potholes').then(r => r.json()).then(data => {
        const promises = data.map(p => fetch(`/api/potholes/${p.id}`, { method: 'DELETE' }));
        Promise.all(promises).then(() => {
            document.getElementById('log-body').innerHTML = '';
            refreshStats();
        });
    });
}

// Akhir dari file.
