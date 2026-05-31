// ═══════════════════════════════════════════════
// Pothole Detector — Client-Side Logic (Server-Side Inference)
// ═══════════════════════════════════════════════

let videoStream = null;
let gpsWatchId = null;
let detectionLoop = null;
let isRunning = false;
let sevChart = null;

let gpsLat = 0, gpsLon = 0, gpsSpeed = 0, gpsHeading = 0, gpsAccuracy = 0;

const DETECT_INTERVAL_MS = 800; // Kirim frame tiap 800ms

document.addEventListener('DOMContentLoaded', () => {
    initChart();
    loadExistingData();
    setupSSE();
    setupBottomSheet();
    registerServiceWorker();
    initCameraList();

    document.getElementById('btn-launch').addEventListener('click', launchApp);
    document.getElementById('btn-stop').addEventListener('click', stopSystem);
});

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/sw.js')
            .catch(err => console.error('PWA SW failed:', err));
    }
}

async function initCameraList() {
    const select = document.getElementById('camera-select');
    let permissionStream = null;
    try {
        permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
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
            
            const labelLow = label.toLowerCase();
            if (!backCameraFound && (labelLow.includes('back') || labelLow.includes('environment') || labelLow.includes('belakang') || labelLow.includes('rear'))) {
                option.selected = true;
                backCameraFound = true;
            }
            select.appendChild(option);
        });

        if (!backCameraFound && videoDevices.length > 1) {
            select.selectedIndex = select.options.length - 1;
        }
    } catch (err) {
        if (permissionStream) permissionStream.getTracks().forEach(t => t.stop());
        select.innerHTML = '<option value="">Izinkan akses kamera terlebih dahulu</option>';
    }
}

async function launchApp() {
    const splash = document.getElementById('splash-screen');
    const appUI = document.getElementById('app-container');
    
    splash.innerHTML = '<h2>🌍 Mengaktifkan GPS & Kamera...</h2><p style="color:#94a3b8;margin-top:10px;">Mohon izinkan akses Lokasi dan Kamera.</p>';
    
    try {
        await startGPS();
        await startCamera();
        
        splash.style.display = 'none';
        appUI.style.display = 'flex';
        
        isRunning = true;
        startDetectionLoop();
    } catch (err) {
        splash.innerHTML = `<h2>❌ Gagal Memulai</h2><p style="color:#ef4444;margin-top:10px;">${err.message}</p>
        <button onclick="location.reload()" style="margin-top:20px;padding:10px 20px;background:#4F46E5;color:white;border:none;border-radius:8px;">Coba Lagi</button>`;
    }
}

function stopSystem() {
    isRunning = false;
    if (detectionLoop) clearInterval(detectionLoop);
    stopCamera();
    stopGPS();
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('splash-screen').style.display = 'flex';
    document.getElementById('splash-screen').innerHTML = '<h2>⏹️ Sistem Dihentikan</h2><button onclick="location.reload()" style="margin-top:20px;padding:10px 20px;background:#4F46E5;color:white;border:none;border-radius:8px;">Mulai Ulang</button>';
}

function updatePill(id, text, colorClass) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'status-pill ' + colorClass;
}

// ── CAMERA ──
async function startCamera() {
    const video = document.getElementById('camera-video');
    const select = document.getElementById('camera-select');
    const deviceId = select.value;
    
    const constraints = deviceId ? { video: { deviceId: { exact: deviceId } } } : { video: { facingMode: 'environment' } };

    try {
        videoStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = videoStream;
        await new Promise(resolve => { video.onloadedmetadata = resolve; });
        video.play();
        updatePill('pill-camera', 'CAM ON', 'green');
    } catch (err) {
        updatePill('pill-camera', 'CAM ERR', 'red');
        throw new Error('Kamera gagal diakses: ' + err.message);
    }
}

function stopCamera() {
    if (videoStream) {
        videoStream.getTracks().forEach(t => t.stop());
        videoStream = null;
    }
    updatePill('pill-camera', 'CAM OFF', 'red');
}

// ── GPS ──
function startGPS() {
    return new Promise((resolve, reject) => {
        if (!("geolocation" in navigator)) {
            return reject(new Error('GPS tidak tersedia di browser ini'));
        }

        updatePill('pill-gps', 'GPS WAIT', 'yellow');

        gpsWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                gpsLat = pos.coords.latitude;
                gpsLon = pos.coords.longitude;
                gpsSpeed = pos.coords.speed ? (pos.coords.speed * 3.6) : 0; 
                gpsAccuracy = pos.coords.accuracy;
                
                document.getElementById('hud-speed').textContent = `${Math.round(gpsSpeed)} km/h`;
                updatePill('pill-gps', `GPS ±${Math.round(gpsAccuracy)}m`, 'green');
                resolve(); 
            },
            (err) => {
                updatePill('pill-gps', 'GPS ERR', 'red');
                if (err.code === 1) reject(new Error('Izin lokasi ditolak'));
                else reject(new Error('Gagal melacak lokasi: ' + err.message));
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
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

// ── SERVER-SIDE DETECTION LOOP ──
function startDetectionLoop() {
    const video = document.getElementById('camera-video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    let isProcessing = false;

    detectionLoop = setInterval(async () => {
        if (!video.videoWidth || video.paused || isProcessing) return;

        isProcessing = true;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        const base64Image = canvas.toDataURL('image/jpeg', 0.6);

        const payload = {
            image: base64Image,
            latitude: gpsLat,
            longitude: gpsLon,
            speed: gpsSpeed
        };

        try {
            const res = await fetch('/api/detect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            
            if (data.error) {
                console.error("API Error:", data.error);
            } else {
                drawBoundingBoxes(data.detections, video.videoWidth, video.videoHeight);
                if (data.inference_ms) {
                    document.getElementById('hud-status').innerHTML = `🟢 Sistem Aktif & Memantau<br><span style="font-size:0.8rem;color:#10b981;">Inference: ${data.inference_ms}ms (Server YOLOv9)</span>`;
                }
            }
        } catch (err) {
            console.error('[DetectionLoop] Error API:', err);
            document.getElementById('hud-status').innerHTML = `🔴 Koneksi Server Terputus<br><span style="font-size:0.8rem;">Mencoba kembali...</span>`;
        } finally {
            isProcessing = false;
        }
    }, DETECT_INTERVAL_MS);
}

function drawBoundingBoxes(detections, videoW, videoH) {
    const canvas = document.getElementById('camera-overlay');
    if (!canvas) return;
    
    // Sync ukuran canvas dengan video render (menggunakan clientWidth/Height)
    const video = document.getElementById('camera-video');
    canvas.width = video.clientWidth;
    canvas.height = video.clientHeight;
    
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!detections || detections.length === 0) {
        document.getElementById('flash-overlay').classList.remove('active');
        return;
    }

    // Scale dari resolusi asli video ke ukuran tampilan layar
    const scaleX = canvas.width / videoW;
    const scaleY = canvas.height / videoH;

    let highestSeverity = 'Low';

    detections.forEach(d => {
        const [x, y, w, h] = d.box;
        
        const scaledX = x * scaleX;
        const scaledY = y * scaleY;
        const scaledW = w * scaleX;
        const scaledH = h * scaleY;

        let color = '#3b82f6'; // Low (Blue)
        if (d.severity === 'High') {
            color = '#ef4444'; // Red
            highestSeverity = 'High';
        } else if (d.severity === 'Medium') {
            color = '#eab308'; // Yellow
            if (highestSeverity !== 'High') highestSeverity = 'Medium';
        }

        // Draw Box
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(scaledX, scaledY, scaledW, scaledH);
        
        // Draw Fill
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.2;
        ctx.fillRect(scaledX, scaledY, scaledW, scaledH);
        
        // Draw Label
        ctx.globalAlpha = 1.0;
        ctx.font = "14px 'Outfit', sans-serif";
        ctx.fillStyle = color;
        ctx.fillRect(scaledX, scaledY - 24, 180, 24);
        
        ctx.fillStyle = "#ffffff";
        ctx.fillText(`${d.severity} - Conf: ${(d.confidence*100).toFixed(0)}%`, scaledX + 5, scaledY - 8);
    });

    if (highestSeverity === 'High' || highestSeverity === 'Medium') {
        document.getElementById('flash-overlay').classList.add('active');
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    } else {
        document.getElementById('flash-overlay').classList.remove('active');
    }
}

// ── SSE (Real-time updates dari server) ──
function setupSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/stream');
    eventSource.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.id) {
                appendLogItem(data);
                refreshStats();
            }
        } catch (err) {}
    };
    eventSource.onerror = () => {
        eventSource.close();
        setTimeout(setupSSE, 5000);
    };
}

// ── Bottom Sheet & Logs ──
function setupBottomSheet() {
    const sheet = document.getElementById('bottom-sheet');
    const handle = document.getElementById('sheet-handle');
    
    handle.addEventListener('click', () => {
        sheet.classList.toggle('open');
    });

    let startY, currentY;
    handle.addEventListener('touchstart', e => { startY = e.touches[0].clientY; });
    handle.addEventListener('touchmove', e => {
        currentY = e.touches[0].clientY;
        if (currentY - startY > 50) sheet.classList.remove('open');
        else if (startY - currentY > 50) sheet.classList.add('open');
    });
}

function appendLogItem(item) {
    const list = document.getElementById('detection-list');
    const noData = document.getElementById('no-data');
    if (noData) noData.remove();

    const li = document.createElement('div');
    li.className = 'log-item';
    
    let color = '#3b82f6';
    if (item.severity === 'High') color = '#ef4444';
    else if (item.severity === 'Medium') color = '#eab308';

    const snapHtml = item.snapshot_path 
        ? `<img src="${item.snapshot_path}" alt="Snap">` 
        : `<div style="width:60px;height:60px;background:#334155;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:10px;">No Img</div>`;

    li.innerHTML = `
        ${snapHtml}
        <div class="info">
            <div class="time">${item.timestamp}</div>
            <div class="details">Dia: ${item.diameter}cm | Dep: ${item.depth}cm</div>
            <div class="details">GPS: ${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}</div>
        </div>
        <div class="severity" style="color: ${color}; border: 1px solid ${color}; padding: 4px 8px; border-radius: 4px; font-weight:bold;">
            ${item.severity}
        </div>
    `;
    list.insertBefore(li, list.firstChild);
    if (list.children.length > 50) list.lastChild.remove();
}

async function loadExistingData() {
    try {
        const res = await fetch('/api/potholes');
        const data = await res.json();
        const list = document.getElementById('detection-list');
        if (data.length > 0) {
            list.innerHTML = '';
            data.forEach(item => appendLogItem(item));
        }
        refreshStats();
    } catch (err) {
        console.log("Belum ada data awal atau server error.");
    }
}

// ── Chart.js ──
function initChart() {
    const canvas = document.getElementById('severityChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    sevChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['High', 'Medium', 'Low'],
            datasets: [{
                data: [0, 0, 0],
                backgroundColor: ['#ef4444', '#eab308', '#3b82f6'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '70%',
            plugins: {
                legend: { position: 'right', labels: { color: '#f8fafc', font: { family: 'Outfit' } } }
            }
        }
    });
}

async function refreshStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        
        document.getElementById('stat-total').textContent = data.total;
        document.getElementById('stat-avg-dia').textContent = data.avg_diameter + 'cm';
        document.getElementById('stat-avg-dep').textContent = data.avg_depth + 'cm';

        if (sevChart) {
            sevChart.data.datasets[0].data = [
                data.severity_distribution.High || 0,
                data.severity_distribution.Medium || 0,
                data.severity_distribution.Low || 0
            ];
            sevChart.update();
        }
    } catch (err) {}
}
