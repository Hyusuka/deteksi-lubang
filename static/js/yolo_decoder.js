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
 * Fungsi utama: decode output raw YOLOv8 dari ONNX
 *
 * @param {Float32Array} outputData - Flat array output dari ONNX
 * @param {Array} dims - Dimensi output, contoh: [1, 5, 8400]
 * @param {number} origWidth   - Lebar video frame asli (sebelum resize ke 640)
 * @param {number} origHeight  - Tinggi video frame asli
 * @param {number} confThresh  - Filter minimum confidence
 * @param {number} iouThresh   - Threshold IoU untuk NMS
 *
 * @returns {Array} Array of detections
 */
function decodeYOLOOutput(outputData, dims, origWidth, origHeight,
    confThresh = DEFAULT_CONF_THRESH,
    iouThresh  = DEFAULT_IOU_THRESH
) {
    const numDims    = dims[1]; // misal 5 untuk 1 kelas
    const numAnchors = dims[2]; // 8400
    const numClasses = numDims - 4;

    if (numClasses < 1) {
        console.error('[YOLODecoder] Output format tidak valid:', numDims, 'dims');
        return [];
    }

    const rawBoxes  = [];
    const rawScores = [];
    const rawClassIds = [];

    // ── 1. Parse semua anchor predictions dari Float32Array ──
    for (let i = 0; i < numAnchors; i++) {
        let maxScore   = 0;
        let maxClassId = 0;

        for (let c = 0; c < numClasses; c++) {
            const score = outputData[(4 + c) * numAnchors + i];
            if (score > maxScore) {
                maxScore   = score;
                maxClassId = c;
            }
        }

        // Filter confidence rendah
        if (maxScore < confThresh) continue;

        // Koordinat bounding box
        const cx = outputData[0 * numAnchors + i];
        const cy = outputData[1 * numAnchors + i];
        const w  = outputData[2 * numAnchors + i];
        const h  = outputData[3 * numAnchors + i];

        rawBoxes.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
        rawScores.push(maxScore);
        rawClassIds.push(maxClassId);
    }

    if (rawBoxes.length === 0) return [];

    // ── 2. Non-Maximum Suppression (NMS) ──
    const keepIndices = nonMaxSuppression(rawBoxes, rawScores, iouThresh);

    // ── 3. Scale koordinat ke resolusi asli ──
    const scaleX = origWidth  / 640;
    const scaleY = origHeight / 640;

    return keepIndices.map(idx => {
        const [bx1, by1, bx2, by2] = rawBoxes[idx];
        const conf      = rawScores[idx];
        const classId   = rawClassIds[idx];
        const className = YOLO_CLASS_NAMES[classId] || 'pothole';

        const x1 = Math.max(0, Math.round(bx1 * scaleX));
        const y1 = Math.max(0, Math.round(by1 * scaleY));
        const x2 = Math.min(origWidth,  Math.round(bx2 * scaleX));
        const y2 = Math.min(origHeight, Math.round(by2 * scaleY));

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
//  Preprocess: Video frame → Float32Array (NCHW)
// ─────────────────────────────────────────────────
const _prepCanvas = document.createElement('canvas');
_prepCanvas.width = 640;
_prepCanvas.height = 640;
const _prepCtx = _prepCanvas.getContext('2d', { willReadFrequently: true });

/**
 * Mengubah elemen <video> atau <img> menjadi array siap inferensi untuk ONNX
 * Output: Float32Array length 3*640*640 (NCHW, normalized 0-1)
 */
function preprocessVideoFrame(sourceElement) {
    // 1. Gambar ke canvas 640x640
    _prepCtx.drawImage(sourceElement, 0, 0, 640, 640);
    
    // 2. Ambil data piksel (RGBA)
    const imgData = _prepCtx.getImageData(0, 0, 640, 640);
    const data = imgData.data; // array RGBA
    
    // 3. Ubah ke NCHW [1, 3, 640, 640] float32 array
    const float32Data = new Float32Array(3 * 640 * 640);
    const redOffset   = 0;
    const greenOffset = 640 * 640;
    const blueOffset  = 2 * 640 * 640;

    for (let i = 0; i < 640 * 640; i++) {
        // Normalisasi ke 0.0 - 1.0
        float32Data[redOffset + i]   = data[i * 4 + 0] / 255.0;
        float32Data[greenOffset + i] = data[i * 4 + 1] / 255.0;
        float32Data[blueOffset + i]  = data[i * 4 + 2] / 255.0;
    }

    return float32Data;
}
