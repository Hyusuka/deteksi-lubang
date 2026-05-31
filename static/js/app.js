// ═══════════════════════════════════════════════
// Pothole Detector — On-Device Inference (ONNX Web) 30 FPS
// ═══════════════════════════════════════════════

let videoStream = null;
let gpsWatchId = null;
let isRunning = false;
let sevChart = null;

let gpsLat = 0, gpsLon = 0, gpsSpeed = 0, gpsAccuracy = 0;

let yoloSession = null;
let isModelLoading = false;
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.45;

document.addEventListener('DOMContentLoaded', () => {
    initChart();
    loadExistingData();
    setupBottomSheet();
    registerServiceWorker();
    initCameraList();

    document.getElementById('btn-launch').addEventListener('click', launchApp);
    document.getElementById('btn-stop').addEventListener('click', stopSystem);
});

function registerServiceWorker() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/static/sw.js').catch(e => console.log(e));
}

async function initCameraList() {
    const select = document.getElementById('camera-select');
    try {
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
            if (!backCameraFound && (label.toLowerCase().includes('back') || label.toLowerCase().includes('environment'))) {
                option.selected = true;
                backCameraFound = true;
            }
            select.appendChild(option);
        });
        if (!backCameraFound && videoDevices.length > 1) select.selectedIndex = select.options.length - 1;
    } catch (err) {
        select.innerHTML = '<option value="">Izinkan akses kamera terlebih dahulu</option>';
    }
}

async function loadAIModel() {
    if (yoloSession) return;
    isModelLoading = true;
    
    document.getElementById('downloading-screen').style.display = 'flex';
    const progressBar = document.getElementById('download-progress-bar');
    const statusText = document.getElementById('download-status-text');
    
    try {
        // Karena onnxruntime-web belum mensupport onProgress secara native di fetch model,
        // Kita gunakan XMLHttpRequest manual untuk bisa dapat progress bar.
        const modelUrl = '/static/pothole_yolov8.onnx';
        statusText.innerText = "Mengunduh 42 MB...";
        
        const response = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', modelUrl, true);
            xhr.responseType = 'arraybuffer';
            xhr.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    progressBar.style.width = pct + '%';
                    statusText.innerText = pct + '% (' + (e.loaded/1024/1024).toFixed(1) + 'MB)';
                } else {
                    statusText.innerText = "Mengunduh... (" + (e.loaded/1024/1024).toFixed(1) + "MB)";
                }
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
                else reject(new Error(xhr.statusText));
            };
            xhr.onerror = () => reject(new Error("Network Error"));
            xhr.send();
        });

        statusText.innerText = "Memanaskan Model (WebGL)...";
        // Init ONNX Session dengan backend webgl agar cepat
        yoloSession = await ort.InferenceSession.create(response, { executionProviders: ['webgl', 'wasm'] });
        
        document.getElementById('downloading-screen').style.display = 'none';
        isModelLoading = false;
    } catch (e) {
        console.error("Gagal memuat model:", e);
        statusText.innerText = "Gagal Mengunduh Model!";
        statusText.style.color = '#ef4444';
        progressBar.style.background = '#ef4444';
        throw e;
    }
}

async function launchApp() {
    const splash = document.getElementById('splash-screen');
    const appUI = document.getElementById('app-container');
    const select = document.getElementById('camera-select');
    const selectedDeviceId = select ? select.value : '';
    
    splash.innerHTML = '<h2>🌍 Mengaktifkan GPS & Kamera...</h2><p style="color:#94a3b8;margin-top:10px;">Mohon izinkan akses Lokasi dan Kamera.</p>';
    
    try {
        await startGPS();
        await startCamera(selectedDeviceId);
        
        splash.style.display = 'none';
        
        // MULAI DOWNLOAD MODEL ONNX
        await loadAIModel();
        
        appUI.style.display = 'flex';
        isRunning = true;
        
        requestAnimationFrame(detectFrame);
    } catch (err) {
        splash.innerHTML = `<h2>❌ Gagal Memulai</h2><p style="color:#ef4444;margin-top:10px;">${err.message}</p>
        <button onclick="location.reload()" style="margin-top:20px;padding:10px 20px;background:#4F46E5;color:white;border:none;border-radius:8px;">Coba Lagi</button>`;
    }
}

function stopSystem() {
    isRunning = false;
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

// ── CAMERA & GPS ──
async function startCamera(deviceId) {
    const video = document.getElementById('camera-video');
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

function startGPS() {
    return new Promise((resolve, reject) => {
        if (!("geolocation" in navigator)) return reject(new Error('GPS tidak tersedia'));
        updatePill('pill-gps', 'GPS WAIT', 'yellow');
        gpsWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                gpsLat = pos.coords.latitude;
                gpsLon = pos.coords.longitude;
                gpsSpeed = pos.coords.speed ? (pos.coords.speed * 3.6) : 0; 
                gpsAccuracy = pos.coords.accuracy;
                
                const speedEl = document.getElementById('hud-speed-val');
                if (speedEl) speedEl.textContent = Math.round(gpsSpeed);
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

// ── ON-DEVICE AI DETECTION (ONNX) ──
let lastLogTime = 0;
// Reusable canvas and tensor arrays to avoid garbage collection pauses
const inputCanvas = document.createElement('canvas');
inputCanvas.width = 640;
inputCanvas.height = 640;
const inputCtx = inputCanvas.getContext('2d', { willReadFrequently: true });

async function detectFrame() {
    if (!isRunning || !yoloSession) return;
    
    const video = document.getElementById('camera-video');
    if (!video.videoWidth || video.paused) {
        requestAnimationFrame(detectFrame);
        return;
    }
    
    const startMs = performance.now();
    
    // 1. Preprocessing (Resize ke 640x640)
    inputCtx.drawImage(video, 0, 0, 640, 640);
    const imgData = inputCtx.getImageData(0, 0, 640, 640).data;
    
    // Konversi HWC (RGBA) ke CHW (Float32) dan normalisasi 0-1
    const float32Data = new Float32Array(3 * 640 * 640);
    for (let i = 0, j = 0; i < imgData.length; i += 4, j++) {
        float32Data[j] = imgData[i] / 255.0;                   // R
        float32Data[j + 640 * 640] = imgData[i + 1] / 255.0;   // G
        float32Data[j + 2 * 640 * 640] = imgData[i + 2] / 255.0; // B
    }
    
    const tensor = new ort.Tensor('float32', float32Data, [1, 3, 640, 640]);
    
    try {
        // 2. Inference
        const feeds = {};
        feeds[yoloSession.inputNames[0]] = tensor;
        const output = await yoloSession.run(feeds);
        
        // Output nama tensor bisa bervariasi, kita ambil output pertama
        const outName = yoloSession.outputNames[0];
        const outData = output[outName].data;
        // outData adalah FlatArray dari shape [1, 5, 8400]
        
        // 3. Post-Processing
        const boxes = processYoloOutput(outData, video.videoWidth, video.videoHeight);
        drawBoundingBoxes(boxes, video.videoWidth, video.videoHeight);
        
        const endMs = performance.now();
        const inferenceTime = Math.round(endMs - startMs);
        const fps = Math.round(1000 / (inferenceTime || 1));
        
        document.getElementById('hud-status').innerHTML = `🟢 Sistem Aktif<br><span style="font-size:0.8rem;color:#10b981;">Infer: ${inferenceTime}ms (${fps} FPS) ONNX</span>`;
        
        // Log ke server tiap 1 detik jika deteksi lubang
        if (boxes.length > 0 && (Date.now() - lastLogTime > 1000)) {
            lastLogTime = Date.now();
            saveDetection(boxes[0], video);
        }
        
    } catch (e) {
        console.error("Inference Error:", e);
    }
    
    // 4. Lanjut frame berikutnya
    requestAnimationFrame(detectFrame);
}

function processYoloOutput(data, vidW, vidH) {
    const numDetections = 8400;
    const boxes = [];
    
    for (let i = 0; i < numDetections; i++) {
        const x = data[0 * numDetections + i];
        const y = data[1 * numDetections + i];
        const w = data[2 * numDetections + i];
        const h = data[3 * numDetections + i];
        const conf = data[4 * numDetections + i]; // Skor confidence lubang
        
        if (conf > CONF_THRESHOLD) {
            const rx = (x - w / 2) / 640 * vidW;
            const ry = (y - h / 2) / 640 * vidH;
            const rw = w / 640 * vidW;
            const rh = h / 640 * vidH;
            
            const diameter = (rw + rh) / 2;
            let severity = 'Low';
            if (diameter > 150) severity = 'High';
            else if (diameter > 80) severity = 'Medium';
            
            boxes.push({ box: [rx, ry, rw, rh], confidence: conf, severity: severity, diameter: Math.round(diameter) });
        }
    }
    return applyNMS(boxes, IOU_THRESHOLD);
}

function applyNMS(boxes, iouThreshold) {
    boxes.sort((a, b) => b.confidence - a.confidence);
    const result = [];
    while(boxes.length > 0) {
        const current = boxes.shift();
        result.push(current);
        for (let i = boxes.length - 1; i >= 0; i--) {
            if (calculateIoU(current.box, boxes[i].box) > iouThreshold) {
                boxes.splice(i, 1);
            }
        }
    }
    return result;
}

function calculateIoU(box1, box2) {
    const x1 = Math.max(box1[0], box2[0]);
    const y1 = Math.max(box1[1], box2[1]);
    const x2 = Math.min(box1[0] + box1[2], box2[0] + box2[2]);
    const y2 = Math.min(box1[1] + box1[3], box2[1] + box2[3]);
    
    const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const box1Area = box1[2] * box1[3];
    const box2Area = box2[2] * box2[3];
    return interArea / (box1Area + box2Area - interArea);
}

function drawBoundingBoxes(detections, videoW, videoH) {
    const canvas = document.getElementById('camera-overlay');
    const ctx = canvas.getContext('2d');
    
    const uiRect = canvas.getBoundingClientRect();
    if (canvas.width !== uiRect.width || canvas.height !== uiRect.height) {
        canvas.width = uiRect.width;
        canvas.height = uiRect.height;
    }
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!detections || detections.length === 0) {
        document.getElementById('flash-overlay').classList.remove('active');
        return;
    }

    const scaleX = canvas.width / videoW;
    const scaleY = canvas.height / videoH;
    let highestSeverity = 'Low';

    detections.forEach(d => {
        const [x, y, w, h] = d.box;
        
        const scaledX = x * scaleX;
        const scaledY = y * scaleY;
        const scaledW = w * scaleX;
        const scaledH = h * scaleY;

        let color = '#3b82f6';
        let bgFill = 'rgba(59, 130, 246, 0.2)';
        
        if (d.severity === 'High') {
            color = '#ef4444';
            bgFill = 'rgba(239, 68, 68, 0.2)';
            highestSeverity = 'High';
        } else if (d.severity === 'Medium') {
            color = '#eab308';
            bgFill = 'rgba(234, 179, 8, 0.2)';
            if (highestSeverity !== 'High') highestSeverity = 'Medium';
        }

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.fillStyle = bgFill;
        ctx.beginPath();
        ctx.roundRect(scaledX, scaledY, scaledW, scaledH, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.font = 'bold 12px Outfit, sans-serif';
        const text = `${d.severity} ${d.diameter}cm`;
        const textWidth = ctx.measureText(text).width;
        
        ctx.beginPath();
        ctx.roundRect(scaledX, scaledY - 22, textWidth + 12, 22, [6, 6, 0, 0]);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, scaledX + 6, scaledY - 6);
    });

    if (highestSeverity === 'High' || highestSeverity === 'Medium') {
        document.getElementById('flash-overlay').classList.add('active');
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    } else {
        document.getElementById('flash-overlay').classList.remove('active');
    }
}

async function saveDetection(det, video) {
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = 320;
    tmpCanvas.height = 320;
    tmpCanvas.getContext('2d').drawImage(video, 0, 0, 320, 320);
    const base64Image = tmpCanvas.toDataURL('image/jpeg', 0.5);

    try {
        await fetch('/api/detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: base64Image,
                latitude: gpsLat,
                longitude: gpsLon,
                speed: gpsSpeed,
                save_only: true, 
                detection: det
            })
        });
        refreshStats();
        loadExistingData();
    } catch(err) {
        console.error("Gagal save detection:", err);
    }
}

// ── Chart.js & UI ──
function initChart() {
    const chartCanvas = document.getElementById('severityChart');
    if (!chartCanvas) return;
    const ctx = chartCanvas.getContext('2d');
    sevChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['High', 'Medium', 'Low'],
            datasets: [{ data: [0, 0, 0], backgroundColor: ['#ef4444', '#eab308', '#3b82f6'], borderWidth: 0 }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'right', labels: { color: '#f8fafc' } } } }
    });
}
function setupBottomSheet() {
    const sheet = document.getElementById('bottom-sheet');
    const handle = document.getElementById('sheet-handle');
    handle.addEventListener('click', () => sheet.classList.toggle('open'));
}
function appendLogItem(item) {
    const list = document.getElementById('log-body');
    if (!list) return;
    const tr = document.createElement('tr');
    let color = '#3b82f6';
    if (item.severity === 'High') color = '#ef4444';
    else if (item.severity === 'Medium') color = '#eab308';
    const snapHtml = item.snapshot_path ? `<img src="${item.snapshot_path}" alt="Snap" style="width:40px;height:40px;object-fit:cover;border-radius:4px;">` : `-`;
    tr.innerHTML = `
        <td>${snapHtml}</td>
        <td style="font-size:0.85rem;">${item.timestamp.split(' ')[1]}</td>
        <td><span style="color:${color};font-weight:bold;border:1px solid ${color};padding:2px 6px;border-radius:4px;font-size:0.75rem;">${item.severity}</span></td>
        <td style="font-size:0.85rem;color:#94a3b8;">${item.diameter}cm</td>
    `;
    list.insertBefore(tr, list.firstChild);
    if (list.children.length > 50) list.lastChild.remove();
}
async function loadExistingData() {
    try {
        const res = await fetch('/api/potholes');
        const data = await res.json();
        const list = document.getElementById('log-body');
        if (data.length > 0 && list) {
            list.innerHTML = '';
            data.forEach(item => appendLogItem(item));
        }
        refreshStats();
    } catch (err) {}
}
async function refreshStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        const t = document.getElementById('stat-total'); if (t) t.textContent = data.total;
        const ad = document.getElementById('stat-avg-dia'); if (ad) ad.textContent = data.avg_diameter + 'cm';
        const ap = document.getElementById('stat-avg-dep'); if (ap) ap.textContent = data.avg_depth + 'cm';
        if (sevChart) {
            sevChart.data.datasets[0].data = [ data.severity_distribution.High || 0, data.severity_distribution.Medium || 0, data.severity_distribution.Low || 0 ];
            sevChart.update();
        }
    } catch (err) {}
}
