// ══════════════════════════════════════════════════════
//  GALLERY PAGE — JavaScript
//  Loads pothole detection data, renders cards, filtering, sorting
// ══════════════════════════════════════════════════════

let allData = [];
let currentFilter = 'all';
let currentSort = 'newest';
let currentDetailItem = null;

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    refreshGallery();
});

// ── Fetch all potholes from server API ──
async function refreshGallery() {
    const grid = document.getElementById('gallery-grid');
    const empty = document.getElementById('gallery-empty');
    const loading = document.getElementById('gallery-loading');

    grid.innerHTML = '';
    empty.style.display = 'none';
    loading.style.display = 'flex';

    try {
        const res = await fetch('/api/potholes');
        allData = await res.json();
    } catch (err) {
        console.error('Gagal memuat data galeri:', err);
        allData = [];
    }

    loading.style.display = 'none';
    updateStats();
    renderCards();
}

// ── Update stats overview cards ──
function updateStats() {
    const total = allData.length;
    const high = allData.filter(d => d.severity === 'High').length;
    const medium = allData.filter(d => d.severity === 'Medium').length;
    const low = allData.filter(d => d.severity === 'Low').length;

    document.getElementById('stat-total').textContent = total;
    document.getElementById('stat-high').textContent = high;
    document.getElementById('stat-medium').textContent = medium;
    document.getElementById('stat-low').textContent = low;
}

// ── Filter ──
function setFilter(filter) {
    currentFilter = filter;

    // Update chip UI
    document.querySelectorAll('.chip').forEach(c => {
        c.classList.toggle('active', c.dataset.filter === filter);
    });

    renderCards();
}

// ── Sort ──
function setSort(sort) {
    currentSort = sort;
    renderCards();
}

// ── Render cards into the grid ──
function renderCards() {
    const grid = document.getElementById('gallery-grid');
    const empty = document.getElementById('gallery-empty');

    // Filter
    let filtered = allData;
    if (currentFilter !== 'all') {
        filtered = allData.filter(d => d.severity === currentFilter);
    }

    // Sort
    filtered = [...filtered]; // clone to avoid mutating original
    switch (currentSort) {
        case 'newest':
            filtered.sort((a, b) => (b.id || 0) - (a.id || 0));
            break;
        case 'oldest':
            filtered.sort((a, b) => (a.id || 0) - (b.id || 0));
            break;
        case 'severity':
            const sevOrder = { 'High': 3, 'Medium': 2, 'Low': 1 };
            filtered.sort((a, b) => (sevOrder[b.severity] || 0) - (sevOrder[a.severity] || 0));
            break;
        case 'confidence':
            filtered.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
            break;
    }

    // Show empty state?
    if (filtered.length === 0) {
        grid.innerHTML = '';
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';

    // Build cards HTML
    grid.innerHTML = filtered.map((item, idx) => {
        const sevClass = (item.severity || 'Low').toLowerCase();
        const sevLabel = item.severity || 'Low';
        const conf = item.confidence != null ? (item.confidence * 100).toFixed(0) + '%' : '--';
        const diameter = item.diameter != null ? item.diameter.toFixed(1) + ' cm' : '-- cm';
        const depth = item.depth != null ? item.depth.toFixed(1) + ' cm' : '-- cm';
        const volume = item.volume != null ? item.volume.toFixed(1) + ' L' : '-- L';
        const speed = item.speed != null ? item.speed.toFixed(0) + ' km/h' : '-- km/h';
        const timeStr = item.timestamp ? formatTime(item.timestamp) : '--';
        const imgSrc = item.snapshot_path || '/static/snapshots/placeholder.jpg';

        return `
            <div class="gallery-card" onclick="openDetail(${item.id})" style="animation-delay:${Math.min(idx * 0.05, 0.3)}s">
                <img class="gallery-card-img" src="${imgSrc}" alt="Lubang #${item.id}" loading="lazy"
                     onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22><rect fill=%22%231A2232%22 width=%22400%22 height=%22300%22/><text x=%22200%22 y=%22160%22 fill=%22%238B9DB8%22 text-anchor=%22middle%22 font-size=%2220%22>📷 No Image</text></svg>'">
                <div class="gallery-card-body">
                    <div class="gallery-card-top">
                        <span class="gallery-card-sev ${sevClass}">${sevLabel}</span>
                        <span class="gallery-card-conf">${conf}</span>
                    </div>
                    <div class="gallery-card-metrics">
                        <div class="gc-metric">
                            <span>📏</span>
                            <span class="gc-metric-val">${diameter}</span>
                        </div>
                        <div class="gc-metric">
                            <span>📐</span>
                            <span class="gc-metric-val">${depth}</span>
                        </div>
                        <div class="gc-metric">
                            <span>🧊</span>
                            <span class="gc-metric-val">${volume}</span>
                        </div>
                        <div class="gc-metric">
                            <span>🏎️</span>
                            <span class="gc-metric-val">${speed}</span>
                        </div>
                    </div>
                    <div class="gallery-card-time">🕐 ${timeStr}</div>
                </div>
            </div>
        `;
    }).join('');
}

// ── Format timestamp for display ──
function formatTime(ts) {
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return ts;
        const now = new Date();
        const diffMs = now - d;
        const diffMin = Math.floor(diffMs / 60000);
        const diffHr = Math.floor(diffMs / 3600000);
        const diffDay = Math.floor(diffMs / 86400000);

        if (diffMin < 1) return 'Baru saja';
        if (diffMin < 60) return `${diffMin} menit lalu`;
        if (diffHr < 24) return `${diffHr} jam lalu`;
        if (diffDay < 7) return `${diffDay} hari lalu`;

        // Fallback: formatted date
        const day = String(d.getDate()).padStart(2, '0');
        const mon = String(d.getMonth() + 1).padStart(2, '0');
        const yr = d.getFullYear();
        const hr = String(d.getHours()).padStart(2, '0');
        const mn = String(d.getMinutes()).padStart(2, '0');
        return `${day}/${mon}/${yr} ${hr}:${mn}`;
    } catch {
        return ts;
    }
}

// ══════════════════════════════════════════════════════
//  DETAIL MODAL
// ══════════════════════════════════════════════════════
function openDetail(id) {
    const item = allData.find(d => d.id === id);
    if (!item) return;
    currentDetailItem = item;

    const modal = document.getElementById('detail-modal');

    // Title
    document.getElementById('detail-title').textContent = `🔍 Detail Lubang #${item.id}`;

    // Image
    const img = document.getElementById('detail-img');
    img.src = item.snapshot_path || '';

    // Severity badge
    const badge = document.getElementById('detail-sev-badge');
    badge.textContent = item.severity || '--';
    badge.className = 'detail-sev-badge ' + (item.severity || 'low').toLowerCase();

    // Confidence
    document.getElementById('detail-conf').textContent =
        item.confidence != null ? `Confidence: ${(item.confidence * 100).toFixed(1)}%` : 'Confidence: --%';

    // Metrics
    document.getElementById('detail-diameter').textContent =
        item.diameter != null ? `${item.diameter.toFixed(1)} cm` : '-- cm';
    document.getElementById('detail-depth').textContent =
        item.depth != null ? `${item.depth.toFixed(1)} cm` : '-- cm';
    document.getElementById('detail-volume').textContent =
        item.volume != null ? `${item.volume.toFixed(1)} Liter` : '-- L';
    document.getElementById('detail-speed').textContent =
        item.speed != null ? `${item.speed.toFixed(0)} km/h` : '-- km/h';

    // Time
    document.getElementById('detail-time').textContent =
        item.timestamp || '--';

    // Coords
    const lat = item.latitude || 0;
    const lon = item.longitude || 0;
    document.getElementById('detail-coords').textContent =
        `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

    // Maps button
    const mapsUrl = item.google_maps_url || `https://www.google.com/maps?q=${lat},${lon}`;
    document.getElementById('detail-maps-btn').href = mapsUrl;

    // Show
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeDetail() {
    document.getElementById('detail-modal').style.display = 'none';
    document.body.style.overflow = '';
    currentDetailItem = null;
}

// Close on ESC
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
});

// ── Delete item ──
async function deleteItem() {
    if (!currentDetailItem) return;
    const id = currentDetailItem.id;

    if (!confirm(`Hapus data deteksi #${id}?`)) return;

    try {
        await fetch(`/api/potholes/${id}`, { method: 'DELETE' });
        // Remove from local data
        allData = allData.filter(d => d.id !== id);
        closeDetail();
        updateStats();
        renderCards();
    } catch (err) {
        console.error('Gagal menghapus:', err);
        alert('Gagal menghapus data. Silakan coba lagi.');
    }
}

// ── Delete all ──
async function deleteAll() {
    if (!confirm(`YAKIN INGIN MENGHAPUS SEMUA DATA (${allData.length} item)? Aksi ini tidak dapat dibatalkan.`)) return;

    try {
        const response = await fetch(`/api/potholes/delete-all`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Network response was not ok');
        
        // Bersihkan data lokal
        allData = [];
        updateStats();
        renderCards();
        alert('Semua data berhasil dihapus.');
    } catch (err) {
        console.error('Gagal menghapus semua data:', err);
        alert('Gagal menghapus semua data. Silakan coba lagi.');
    }
}
