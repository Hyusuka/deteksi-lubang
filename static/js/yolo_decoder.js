// ═══════════════════════════════════════════════════════════
//  yolo_decoder.js — Post-processing output TF.js YOLOv8
//  Mengubah raw tensor output menjadi bounding box yang siap pakai
// ═══════════════════════════════════════════════════════════

'use strict';

// ── Nama kelas sesuai model yang Anda latih ──
// Jika model hanya 1 kelas (pothole), array ini berisi 1 elemen
const YOLO_CLASS_NAMES = ['pothole'];

// ── Threshold default ──
const DEFAULT_CONF_THRESH = 0.30;  // Minimal confidence score (0.25–0.45 direkomendasikan)
const DEFAULT_IOU_THRESH  = 0.45;  // IoU threshold untuk NMS

/**
 * Fungsi utama: decode output raw YOLOv8 dari TF.js
 *
 * @param {Array|Float32Array} rawOutput - Output tensor dari model.predict()
 *        Format YOLOv8: [numOutputDims, numAnchors]
 *        Contoh 1 kelas: [5, 8400] → [cx, cy, w, h, conf_pothole]
 *        Contoh N kelas: [4+N, 8400]
 *
 * @param {number} origWidth   - Lebar video frame asli (sebelum resize ke 640)
 * @param {number} origHeight  - Tinggi video frame asli
 * @param {number} confThresh  - Filter minimum confidence
 * @param {number} iouThresh   - Threshold IoU untuk NMS
 *
 * @returns {Array} Array of detections:
 *   [ { x1, y1, x2, y2, confidence, className, severity, diameter, depth, volume } ]
 */
function decodeYOLOOutput(rawOutput, origWidth, origHeight,
    confThresh = DEFAULT_CONF_THRESH,
    iouThresh  = DEFAULT_IOU_THRESH
) {
    // rawOutput bisa berupa nested array [[...], [...], ...] atau flat array
    // Normalize ke format: array 2D [numDims][numAnchors]
    let output = rawOutput;

    // Jika output adalah 1D flat array, abaikan (error — perlu 2D)
    if (!Array.isArray(output[0]) && !(output[0] instanceof Float32Array)) {
        console.warn('[YOLODecoder] Output format tidak dikenali, coba transpose...');
        return [];
    }

    const numDims    = output.length;       // 5 untuk 1 kelas (4 box + 1 class)
    const numAnchors = output[0].length;    // 8400 untuk input 640×640
    const numClasses = numDims - 4;         // Jumlah kelas = total dims - 4 box coords

    if (numClasses < 1) {
        console.error('[YOLODecoder] Output format tidak valid:', numDims, 'dims');
        return [];
    }

    const rawBoxes  = [];
    const rawScores = [];
    const rawClassIds = [];

    // ── 1. Parse semua anchor predictions ──
    for (let i = 0; i < numAnchors; i++) {
        // Cari class dengan score tertinggi
        let maxScore   = 0;
        let maxClassId = 0;

        for (let c = 0; c < numClasses; c++) {
            const score = output[4 + c][i];
            if (score > maxScore) {
                maxScore   = score;
                maxClassId = c;
            }
        }

        // Filter confidence rendah
        if (maxScore < confThresh) continue;

        // Koordinat bounding box (center x, center y, width, height) — dalam ruang 640×640
        const cx = output[0][i];
        const cy = output[1][i];
        const w  = output[2][i];
        const h  = output[3][i];

        rawBoxes.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
        rawScores.push(maxScore);
        rawClassIds.push(maxClassId);
    }

    if (rawBoxes.length === 0) return [];

    // ── 2. Non-Maximum Suppression (NMS) ──
    const keepIndices = nonMaxSuppression(rawBoxes, rawScores, iouThresh);

    // ── 3. Scale koordinat dari 640×640 ke resolusi video asli ──
    const scaleX = origWidth  / 640;
    const scaleY = origHeight / 640;

    return keepIndices.map(idx => {
        const [bx1, by1, bx2, by2] = rawBoxes[idx];
        const conf      = rawScores[idx];
        const classId   = rawClassIds[idx];
        const className = YOLO_CLASS_NAMES[classId] || 'pothole';

        // Koordinat dalam pixel video
        const x1 = Math.max(0, Math.round(bx1 * scaleX));
        const y1 = Math.max(0, Math.round(by1 * scaleY));
        const x2 = Math.min(origWidth,  Math.round(bx2 * scaleX));
        const y2 = Math.min(origHeight, Math.round(by2 * scaleY));

        // ── Estimasi dimensi & severity (sama seperti server.py dulu) ──
        const bwPixels     = x2 - x1;
        const diameterCm   = estimateDiameter(bwPixels, origWidth);
        const { depth, severity } = estimateDepthAndSeverity(diameterCm, className);
        const volumeLiters = estimateVolume(diameterCm, depth);

        return {
            x1, y1, x2, y2,
            confidence: conf,
            className,
            severity,
            diameter: diameterCm,
            depth,
            volume: volumeLiters
        };
    });
}

// ─────────────────────────────────────────────────
//  Dimensi & Severity Helpers
// ─────────────────────────────────────────────────

/**
 * Estimasi diameter fisik lubang dalam cm
 * Asumsi: lebar jalan di bawah frame kamera ≈ 200 cm
 */
function estimateDiameter(bwPixels, frameWidth) {
    const d = Math.round((bwPixels / frameWidth) * 200 * 10) / 10;
    return Math.max(5.0, d);
}

/**
 * Estimasi kedalaman dan severity berdasarkan diameter & kelas
 */
function estimateDepthAndSeverity(diameterCm, className) {
    const ratio = className === 'lubang_besar' ? 0.25
                : className === 'lubang_kecil' ? 0.12
                : 0.18; // pothole / lubang_sedang

    const rawDepth = Math.round(diameterCm * ratio * 10) / 10;
    const depth    = Math.min(25.0, Math.max(2.0, rawDepth));

    const severity = depth >= 12.0 ? 'High'
                   : depth >= 6.0  ? 'Medium'
                   : 'Low';

    return { depth, severity };
}

/**
 * Estimasi volume (semi-ellipsoid) dalam Liter
 */
function estimateVolume(diameterCm, depthCm) {
    const r     = diameterCm / 2;
    const volCm = 0.5 * Math.PI * r * r * depthCm;
    return Math.max(0.1, Math.round(volCm / 100) / 10);
}

// ─────────────────────────────────────────────────
//  Non-Maximum Suppression
// ─────────────────────────────────────────────────

/**
 * NMS: menghilangkan bounding box yang saling tumpang tindih
 */
function nonMaxSuppression(boxes, scores, iouThresh) {
    // Sort indeks dari score tertinggi ke terendah
    const indices = Array.from({ length: scores.length }, (_, i) => i)
        .sort((a, b) => scores[b] - scores[a]);

    const keep       = [];
    const suppressed = new Set();

    for (const i of indices) {
        if (suppressed.has(i)) continue;
        keep.push(i);

        for (const j of indices) {
            if (i === j || suppressed.has(j)) continue;
            if (computeIoU(boxes[i], boxes[j]) > iouThresh) {
                suppressed.add(j);
            }
        }
    }

    return keep;
}

/**
 * Hitung Intersection over Union antara dua bounding box
 * Format box: [x1, y1, x2, y2]
 */
function computeIoU(boxA, boxB) {
    const ix1 = Math.max(boxA[0], boxB[0]);
    const iy1 = Math.max(boxA[1], boxB[1]);
    const ix2 = Math.min(boxA[2], boxB[2]);
    const iy2 = Math.min(boxA[3], boxB[3]);

    const interW = Math.max(0, ix2 - ix1);
    const interH = Math.max(0, iy2 - iy1);
    const intersection = interW * interH;

    if (intersection === 0) return 0;

    const areaA = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]);
    const areaB = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]);

    return intersection / (areaA + areaB - intersection);
}

// ─────────────────────────────────────────────────
//  Preprocess: Video frame → TF.js input tensor
// ─────────────────────────────────────────────────

/**
 * Mengubah elemen <video> menjadi tensor siap inferensi
 * Input : videoElement (HTMLVideoElement)
 * Output: tf.Tensor4D shape [1, 3, 640, 640] (NCHW, normalized 0-1)
 */
function preprocessVideoFrame(videoElement) {
    return tf.tidy(() => {
        // Ambil frame dari video sebagai tensor [H, W, 3]
        const frameTensor = tf.browser.fromPixels(videoElement);

        // Resize ke 640×640
        const resized = tf.image.resizeBilinear(frameTensor, [640, 640]);

        // Normalize dari [0, 255] ke [0.0, 1.0]
        const normalized = resized.div(tf.scalar(255.0));

        // Tambah dimensi batch: [1, 640, 640, 3] (NHWC)
        const batched = normalized.expandDims(0);

        // Transpose ke NCHW [1, 3, 640, 640] — format yang diharapkan YOLOv8
        return batched.transpose([0, 3, 1, 2]);
    });
}
