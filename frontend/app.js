// ==========================================================================
// LogPulse Frontend Observability Engine
// ==========================================================================

// 1. WebSocket Client
const socket = io();

// 2. Application State
const state = {
    logs: [],
    renderedIds: new Set(),
    isPaused: false,
    autoScroll: true,
    maxLogs: 250,

    // Filter State
    selectedLevel: 'ALL',
    searchKeyword: '',
    selectedService: '',

    // Sliding window metrics (Last 60s)
    currentSecondWindowCount: 0,
    timeSeriesBuffer: [], // Array of { second: string, count: number }
    lifetimeTotal: 0,
    lifetimeErrors: 0
};

// 3. DOM Elements
const DOM = {
    container: document.getElementById('logs-container'),
    statusIndicator: document.getElementById('status-indicator'),
    statusText: document.getElementById('status-text'),
    reconnectBanner: document.getElementById('reconnect-banner'),

    // Metric Displays
    rateCount: document.getElementById('rate-count'),
    totalCount: document.getElementById('total-count'),
    errorCount: document.getElementById('error-count'),
    errorRate: document.getElementById('error-rate'),

    // Control Buttons
    btnPause: document.getElementById('btn-pause'),
    pauseIcon: document.getElementById('pause-icon'),
    pauseText: document.getElementById('pause-text'),
    btnClear: document.getElementById('btn-clear'),
    btnExport: document.getElementById('btn-export'),
    toggleAutoscroll: document.getElementById('toggle-autoscroll'),

    // Filters
    search: document.getElementById('filter-search'),
    btnClearSearch: document.getElementById('btn-clear-search'),
    service: document.getElementById('filter-service'),
    btnClearService: document.getElementById('btn-clear-service'),
    severityPills: document.getElementById('severity-pills'),
    btnResetFilters: document.getElementById('btn-reset-filters'),
    activeServiceBadge: document.getElementById('active-service-badge'),
    activeServiceText: document.getElementById('active-service-text'),
    btnRemoveServiceFilter: document.getElementById('btn-remove-service-filter'),

    // Mobile Sidebar
    sidebar: document.getElementById('sidebar'),
    btnToggleSidebar: document.getElementById('btn-toggle-sidebar'),

    // Toast
    toast: document.getElementById('toast')
};

// 4. Chart Instances
let levelChart = null;
let timeChart = null;

// ==========================================================================
// Charts Initialization & Real-Time Sliding Window
// ==========================================================================

async function fetchAndInitCharts() {
    try {
        const res = await fetch('/stats');
        const data = await res.json();

        // 1. Severity Doughnut Chart
        const ctxLevel = document.getElementById('levelChart').getContext('2d');
        const infoCount = data.levels?.INFO || 0;
        const warnCount = data.levels?.WARN || 0;
        const errorCount = data.levels?.ERROR || 0;
        const debugCount = data.levels?.DEBUG || 0;

        levelChart = new Chart(ctxLevel, {
            type: 'doughnut',
            data: {
                labels: ['INFO', 'WARN', 'ERROR', 'DEBUG'],
                datasets: [{
                    data: [infoCount, warnCount, errorCount, debugCount],
                    backgroundColor: ['#388bfd', '#d29922', '#f85149', '#8b949e'],
                    borderColor: '#161b22',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: '#8b949e',
                            boxWidth: 10,
                            padding: 10,
                            font: { size: 11, family: 'Inter' }
                        }
                    }
                },
                cutout: '68%'
            }
        });

        // 2. Initialize 60-Second Sliding Window
        initSlidingWindow(data.time_series || []);

        // 3. Time Series Line Chart
        const ctxTime = document.getElementById('timeChart').getContext('2d');
        timeChart = new Chart(ctxTime, {
            type: 'line',
            data: {
                labels: state.timeSeriesBuffer.map(d => d.second),
                datasets: [{
                    label: 'Throughput (eps)',
                    data: state.timeSeriesBuffer.map(d => d.count),
                    borderColor: '#2f81f7',
                    backgroundColor: 'rgba(47, 129, 247, 0.1)',
                    borderWidth: 1.8,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 0 },
                scales: {
                    x: {
                        ticks: { color: '#6e7681', maxTicksLimit: 6, font: { size: 10 } },
                        grid: { color: '#21262d' }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: { color: '#6e7681', font: { size: 10 }, precision: 0 },
                        grid: { color: '#21262d' }
                    }
                },
                plugins: { legend: { display: false } }
            }
        });

        // 4. Update Metrics from Database Baseline
        state.lifetimeTotal = infoCount + warnCount + errorCount + debugCount;
        state.lifetimeErrors = errorCount;
        updateMetricsUI();

    } catch (err) {
        console.error('Failed to initialize charts:', err);
    }
}

function initSlidingWindow(serverTimeSeries) {
    const now = new Date();
    state.timeSeriesBuffer = [];
    const serverMap = new Map(serverTimeSeries.map(d => [d.second, d.count]));

    // Pre-fill last 60 seconds
    for (let i = 59; i >= 0; i--) {
        const secDate = new Date(now.getTime() - i * 1000);
        const secStr = secDate.toLocaleTimeString([], { hour12: false });
        state.timeSeriesBuffer.push({
            second: secStr,
            count: serverMap.get(secStr) || 0
        });
    }
}

// Tick chart forward every second to ensure idle periods display 0 events/sec
function startClockTicker() {
    setInterval(() => {
        if (!timeChart) return;

        const nowStr = new Date().toLocaleTimeString([], { hour12: false });
        const lastCount = state.currentSecondWindowCount;
        state.currentSecondWindowCount = 0;

        // Advance sliding window
        state.timeSeriesBuffer.push({ second: nowStr, count: lastCount });
        if (state.timeSeriesBuffer.length > 60) {
            state.timeSeriesBuffer.shift();
        }

        // Update live rate display
        if (DOM.rateCount) DOM.rateCount.textContent = lastCount;

        // Render on chart
        timeChart.data.labels = state.timeSeriesBuffer.map(d => d.second);
        timeChart.data.datasets[0].data = state.timeSeriesBuffer.map(d => d.count);
        timeChart.update();
    }, 1000);
}

// ==========================================================================
// WebSocket Events
// ==========================================================================

socket.on('connect', () => {
    DOM.statusIndicator.className = 'status-pill connected';
    DOM.statusText.textContent = 'Connected';
    DOM.reconnectBanner.classList.add('hidden');
});

socket.on('disconnect', () => {
    DOM.statusIndicator.className = 'status-pill disconnected';
    DOM.statusText.textContent = 'Disconnected';
    DOM.reconnectBanner.classList.remove('hidden');
});

socket.on('new_log', (log) => {
    processIncomingLog(log, true);
});

socket.on('stats_update', (data) => {
    if (data.levels && levelChart) {
        levelChart.data.datasets[0].data = [
            data.levels.INFO || 0,
            data.levels.WARN || 0,
            data.levels.ERROR || 0,
            data.levels.DEBUG || 0
        ];
        levelChart.update();
    }
});

// ==========================================================================
// Log Processing & Deduplication
// ==========================================================================

async function fetchHistoricalLogs() {
    try {
        const res = await fetch('/logs');
        const logs = await res.json();
        // Reverse so oldest historical logs are processed first, leaving newest at top
        logs.reverse().forEach(log => processIncomingLog(log, false));
    } catch (err) {
        console.error('Failed to fetch historical logs:', err);
    }
}

function processIncomingLog(log, isRealTime) {
    if (log._id && state.renderedIds.has(log._id)) return;
    if (log._id) state.renderedIds.add(log._id);

    // Track throughput count
    if (isRealTime) {
        state.currentSecondWindowCount++;
        state.lifetimeTotal++;
        if ((log.level || '').toUpperCase() === 'ERROR') {
            state.lifetimeErrors++;
        }
        updateMetricsUI();
    }

    state.logs.unshift(log);

    // Memory buffer pruning
    if (state.logs.length > state.maxLogs) {
        const popped = state.logs.pop();
        if (popped._id) state.renderedIds.delete(popped._id);
    }

    if (state.isPaused && isRealTime) return;

    if (passesFilters(log)) {
        appendLogToDOM(log);
        maintainDOMLimit();
        if (state.autoScroll && isRealTime) {
            DOM.container.scrollTop = 0;
        }
    }
}

// ==========================================================================
// DOM Rendering (Interactive Accordion Items)
// ==========================================================================

function createLogElement(log) {
    const el = document.createElement('div');
    const level = (log.level || 'INFO').toUpperCase();
    const time = new Date(log.timestamp).toLocaleTimeString([], { hour12: false });
    const service = log.service || 'unknown';
    const message = log.message || '';

    el.className = 'log-item';
    el.innerHTML = `
        <div class="log-summary">
            <span class="log-time">${time}</span>
            <span class="level-badge ${level}">${level}</span>
            <span class="service-badge" title="Filter by ${escapeHTML(service)}">${escapeHTML(service)}</span>
            <span class="log-message-text" title="${escapeHTML(message)}">${escapeHTML(message)}</span>
            <div class="log-row-actions">
                <button class="btn-inspect" aria-label="Inspect metadata">
                    JSON <span class="chevron">›</span>
                </button>
            </div>
        </div>
        <div class="log-drawer">
            <div class="drawer-header">
                <span class="drawer-title">Log Payload & Metadata</span>
                <div class="drawer-actions">
                    <button class="btn-action-sm btn-filter-service" data-service="${escapeHTML(service)}">
                        Filter Service
                    </button>
                    <button class="btn-action-sm btn-copy-json">
                        Copy JSON
                    </button>
                </div>
            </div>
            <pre class="json-viewer">${escapeHTML(JSON.stringify(log, null, 2))}</pre>
        </div>
    `;

    // Row click toggles accordion expansion
    const summaryRow = el.querySelector('.log-summary');
    summaryRow.onclick = (e) => {
        // If clicking service badge, filter service instead of expanding
        if (e.target.classList.contains('service-badge')) {
            e.stopPropagation();
            setServiceFilter(service);
            return;
        }
        el.classList.toggle('expanded');
    };

    // Quick Action: Filter Service inside drawer
    el.querySelector('.btn-filter-service').onclick = (e) => {
        e.stopPropagation();
        setServiceFilter(service);
    };

    // Quick Action: Copy JSON inside drawer
    el.querySelector('.btn-copy-json').onclick = (e) => {
        e.stopPropagation();
        copyToClipboard(JSON.stringify(log, null, 2));
    };

    return el;
}

function appendLogToDOM(log) {
    // Remove empty-state if present
    const emptyState = DOM.container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const el = createLogElement(log);
    DOM.container.prepend(el);
}

function renderAllLogs() {
    DOM.container.innerHTML = '';
    const matchingLogs = state.logs.filter(passesFilters);

    if (matchingLogs.length === 0) {
        DOM.container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <div class="empty-state-title">No matching logs</div>
                <div class="empty-state-subtitle">Adjust your search query or severity level to view events.</div>
            </div>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();
    matchingLogs.forEach(log => {
        fragment.appendChild(createLogElement(log));
    });

    DOM.container.appendChild(fragment);
    if (state.autoScroll) DOM.container.scrollTop = 0;
}

// ==========================================================================
// Filtering Logic
// ==========================================================================

function passesFilters(log) {
    const lvl = (log.level || '').toUpperCase();
    const svc = (log.service || '').toLowerCase();
    const msg = (log.message || '').toLowerCase();

    if (state.selectedLevel !== 'ALL' && lvl !== state.selectedLevel) {
        return false;
    }
    if (state.selectedService && !svc.includes(state.selectedService.toLowerCase())) {
        return false;
    }
    if (state.searchKeyword && !msg.includes(state.searchKeyword.toLowerCase())) {
        return false;
    }

    return true;
}

function setServiceFilter(serviceName) {
    state.selectedService = serviceName;
    DOM.service.value = serviceName;
    DOM.btnClearService.classList.remove('hidden');

    DOM.activeServiceText.textContent = serviceName;
    DOM.activeServiceBadge.classList.remove('hidden');

    renderAllLogs();
}

function clearServiceFilter() {
    state.selectedService = '';
    DOM.service.value = '';
    DOM.btnClearService.classList.add('hidden');
    DOM.activeServiceBadge.classList.add('hidden');
    renderAllLogs();
}

// ==========================================================================
// Helpers & Utilities
// ==========================================================================

function debounce(fn, delay = 200) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function maintainDOMLimit() {
    while (DOM.container.children.length > state.maxLogs) {
        DOM.container.lastChild.remove();
    }
}

function updateMetricsUI() {
    if (DOM.totalCount) DOM.totalCount.textContent = state.lifetimeTotal.toLocaleString();
    if (DOM.errorCount) DOM.errorCount.textContent = state.lifetimeErrors.toLocaleString();
    if (DOM.errorRate) {
        const rate = state.lifetimeTotal > 0
            ? ((state.lifetimeErrors / state.lifetimeTotal) * 100).toFixed(1)
            : '0';
        DOM.errorRate.textContent = `(${rate}%)`;
    }
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showToast(message) {
    DOM.toast.textContent = message;
    DOM.toast.classList.remove('hidden');
    setTimeout(() => {
        DOM.toast.classList.add('hidden');
    }, 2000);
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('JSON copied to clipboard!');
    }).catch(() => {
        showToast('Failed to copy');
    });
}

function exportLogsAsJSON() {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state.logs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `logpulse-export-${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast(`Exported ${state.logs.length} logs as JSON!`);
}

// ==========================================================================
// Event Listeners
// ==========================================================================

function setupEventListeners() {
    // 1. Pause / Resume Stream
    DOM.btnPause.onclick = () => {
        state.isPaused = !state.isPaused;
        DOM.pauseIcon.textContent = state.isPaused ? '▶' : '⏸';
        DOM.pauseText.textContent = state.isPaused ? 'Resume Stream' : 'Pause Stream';
        DOM.btnPause.classList.toggle('btn-primary', !state.isPaused);
        DOM.btnPause.classList.toggle('btn-secondary', state.isPaused);
        if (!state.isPaused) renderAllLogs();
    };

    // 2. Clear View
    DOM.btnClear.onclick = () => {
        DOM.container.innerHTML = '';
        state.logs = [];
        state.renderedIds.clear();
        renderAllLogs();
        showToast('Dashboard logs cleared');
    };

    // 3. Export JSON
    DOM.btnExport.onclick = exportLogsAsJSON;

    // 4. Auto-Scroll Toggle
    DOM.toggleAutoscroll.onchange = (e) => {
        state.autoScroll = e.target.checked;
        if (state.autoScroll) DOM.container.scrollTop = 0;
    };

    // 5. Severity Pills
    DOM.severityPills.querySelectorAll('.pill').forEach(pill => {
        pill.onclick = () => {
            DOM.severityPills.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            state.selectedLevel = pill.getAttribute('data-level');
            renderAllLogs();
        };
    });

    // 6. Message Search with Debounce
    const debouncedSearch = debounce(() => {
        state.searchKeyword = DOM.search.value.trim();
        DOM.btnClearSearch.classList.toggle('hidden', !state.searchKeyword);
        renderAllLogs();
    }, 200);
    DOM.search.oninput = debouncedSearch;

    DOM.btnClearSearch.onclick = () => {
        DOM.search.value = '';
        state.searchKeyword = '';
        DOM.btnClearSearch.classList.add('hidden');
        renderAllLogs();
    };

    // 7. Service Filter with Debounce
    const debouncedService = debounce(() => {
        state.selectedService = DOM.service.value.trim();
        DOM.btnClearService.classList.toggle('hidden', !state.selectedService);
        if (state.selectedService) {
            DOM.activeServiceText.textContent = state.selectedService;
            DOM.activeServiceBadge.classList.remove('hidden');
        } else {
            DOM.activeServiceBadge.classList.add('hidden');
        }
        renderAllLogs();
    }, 200);
    DOM.service.oninput = debouncedService;

    DOM.btnClearService.onclick = clearServiceFilter;
    DOM.btnRemoveServiceFilter.onclick = clearServiceFilter;

    // 8. Reset All Filters
    DOM.btnResetFilters.onclick = () => {
        state.selectedLevel = 'ALL';
        state.searchKeyword = '';
        state.selectedService = '';
        DOM.search.value = '';
        DOM.service.value = '';
        DOM.btnClearSearch.classList.add('hidden');
        DOM.btnClearService.classList.add('hidden');
        DOM.activeServiceBadge.classList.add('hidden');
        DOM.severityPills.querySelectorAll('.pill').forEach(p => {
            p.classList.toggle('active', p.getAttribute('data-level') === 'ALL');
        });
        renderAllLogs();
    };

    // 9. Mobile Sidebar Drawer
    if (DOM.btnToggleSidebar) {
        DOM.btnToggleSidebar.onclick = () => {
            DOM.sidebar.classList.toggle('open');
        };
    }
}

// ==========================================================================
// Boot Initialization
// ==========================================================================

function init() {
    setupEventListeners();
    fetchHistoricalLogs();
    fetchAndInitCharts();
    startClockTicker();
}

init();