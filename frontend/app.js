// --- State Management ---
const state = {
    logs: [],                  // Holds up to maxLogs in memory
    renderedIds: new Set(),    // Prevents duplicates (WebSocket + REST overlap)
    isPaused: false,
    autoScroll: true,
    maxLogs: 200,              // Keep DOM light
    lifetimeTotal: 0,          
    lifetimeErrors: 0
};

// --- DOM Elements ---
const DOM = {
    container: document.getElementById('logs-container'),
    wrapper: document.querySelector('.log-stream-wrapper'),
    status: document.getElementById('status-indicator'),
    statusText: document.getElementById('status-text'),
    countTotal: document.getElementById('total-count'),
    countError: document.getElementById('error-count'),
    
    // Controls
    btnPause: document.getElementById('btn-pause'),
    btnClear: document.getElementById('btn-clear'),
    toggleScroll: document.getElementById('toggle-autoscroll'),
    
    // Filters
    search: document.getElementById('filter-search'),
    level: document.getElementById('filter-level'),
    service: document.getElementById('filter-service')
};

// --- Initialization ---
const socket = io('http://localhost:5000');

function init() {
    setupEventListeners();
    fetchHistoricalLogs();
}

// --- WebSocket Handling ---
socket.on('connect', () => updateStatus(true));
socket.on('disconnect', () => updateStatus(false));

socket.on('new_log', (log) => {
    processIncomingLog(log, true);
});

// --- Core Logic ---
async function fetchHistoricalLogs() {
    try {
        const res = await fetch('http://localhost:5000/logs');
        const historicalLogs = await res.json();
        // Backend sends newest first. Reverse to process oldest to newest 
        // so they stack correctly when we prepend them.
        historicalLogs.reverse().forEach(log => processIncomingLog(log, false));
    } catch (err) {
        console.error("Failed to load history:", err);
    }
}

function processIncomingLog(log, isRealTime) {
    // 1. Deduplicate
    if (log._id && state.renderedIds.has(log._id)) return;
    if (log._id) state.renderedIds.add(log._id);

    // 2. Update Lifetime Stats
    state.lifetimeTotal++;
    if ((log.level || '').toUpperCase() === 'ERROR') state.lifetimeErrors++;
    updateStatsUI();

    // 3. Update Memory State (Newest at index 0)
    state.logs.unshift(log);
    
    // Prune memory if too large
    if (state.logs.length > state.maxLogs) {
        const popped = state.logs.pop();
        if (popped._id) state.renderedIds.delete(popped._id);
    }

    // 4. DOM Update Logic
    if (state.isPaused && isRealTime) return; // Buffer in memory, but don't render yet

    if (passesFilters(log)) {
        appendLogToDOM(log);
        maintainDOMLimit();
        if (state.autoScroll && isRealTime) {
            DOM.wrapper.scrollTop = 0;
        }
    }
}

// --- UI Rendering ---
function appendLogToDOM(log) {
    const el = document.createElement('div');
    const level = (log.level || 'INFO').toUpperCase();
    const time = new Date(log.timestamp).toLocaleTimeString([], { hour12: false });
    
    el.className = `log-entry ${level}`;
    el.innerHTML = `
        <div class="log-time">${time}</div>
        <div class="log-level">${level}</div>
        <div class="log-service">${log.service}</div>
        <div class="log-msg">${escapeHTML(log.message)}</div>
    `;
    
    // Always prepend so newest is at the top
    DOM.container.prepend(el);
}

function renderAllLogs() {
    // Used when filters change or stream is unpaused
    DOM.container.innerHTML = '';
    const fragment = document.createDocumentFragment();
    
    // Render from state (already sorted newest first)
    state.logs.filter(passesFilters).forEach(log => {
        const el = document.createElement('div');
        const level = (log.level || 'INFO').toUpperCase();
        const time = new Date(log.timestamp).toLocaleTimeString([], { hour12: false });
        
        el.className = `log-entry ${level}`;
        el.innerHTML = `
            <div class="log-time">${time}</div>
            <div class="log-level">${level}</div>
            <div class="log-service">${log.service}</div>
            <div class="log-msg">${escapeHTML(log.message)}</div>
        `;
        fragment.appendChild(el);
    });
    
    DOM.container.appendChild(fragment);
    if (state.autoScroll) DOM.wrapper.scrollTop = 0;
}

// --- Helpers & Utilities ---
function passesFilters(log) {
    const term = DOM.search.value.toLowerCase();
    const lvl = DOM.level.value;
    const svc = DOM.service.value.toLowerCase();

    if (lvl !== 'ALL' && (log.level || '').toUpperCase() !== lvl) return false;
    if (svc && !(log.service || '').toLowerCase().includes(svc)) return false;
    if (term && !(log.message || '').toLowerCase().includes(term)) return false;
    
    return true;
}

function maintainDOMLimit() {
    while (DOM.container.children.length > state.maxLogs) {
        DOM.container.lastChild.remove();
    }
}

function updateStatus(isConnected) {
    DOM.status.className = `status ${isConnected ? 'connected' : 'disconnected'}`;
    DOM.statusText.textContent = isConnected ? 'Connected' : 'Disconnected';
}

function updateStatsUI() {
    DOM.countTotal.textContent = state.lifetimeTotal.toLocaleString();
    DOM.countError.textContent = state.lifetimeErrors.toLocaleString();
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.innerText = str;
    return div.innerHTML;
}

// --- Event Listeners ---
function setupEventListeners() {
    DOM.btnPause.addEventListener('click', () => {
        state.isPaused = !state.isPaused;
        DOM.btnPause.innerHTML = state.isPaused ? '▶ Resume Stream' : '⏸ Pause Stream';
        DOM.btnPause.style.background = state.isPaused ? 'var(--info)' : '';
        if (!state.isPaused) renderAllLogs(); // Catch up DOM on resume
    });

    DOM.btnClear.addEventListener('click', () => {
        DOM.container.innerHTML = '';
        state.logs = [];
        state.renderedIds.clear();
        state.lifetimeTotal = 0;
        state.lifetimeErrors = 0;
        updateStatsUI();
    });

    DOM.toggleScroll.addEventListener('change', (e) => {
        state.autoScroll = e.target.checked;
        if (state.autoScroll) DOM.wrapper.scrollTop = 0;
    });

    // Debounced filtering for better typing performance
    let timeout;
    const triggerFilter = () => {
        clearTimeout(timeout);
        timeout = setTimeout(renderAllLogs, 200);
    };

    DOM.search.addEventListener('input', triggerFilter);
    DOM.service.addEventListener('input', triggerFilter);
    DOM.level.addEventListener('change', renderAllLogs);
}

init();