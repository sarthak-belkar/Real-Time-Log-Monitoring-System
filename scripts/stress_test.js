#!/usr/bin/env node
/**
 * High-Performance Node.js Load & Stress Test Runner
 * ==================================================
 * Simulates high-concurrency log producer bursts against the Flask ingestion API.
 * Uses HTTP Keep-Alive pooling and tracks latency percentiles and throughput.
 */

const http = require('http');
const readline = require('readline');

// Parse CLI args
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const TARGET_URL = getArg('--url', 'http://localhost:5000/log');
const TOTAL_REQUESTS = parseInt(getArg('--total', '5000'), 10);
const CONCURRENCY = parseInt(getArg('--concurrency', '50'), 10);

const SERVICES = ['auth-service', 'payment-service', 'order-api', 'inventory-db', 'notification-worker'];
const LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
const MESSAGES = [
    'User authentication token verified successfully',
    'Database connection pool latency exceeded 120ms threshold',
    'Unhandled NullReferenceException in checkout pipeline',
    'Cache miss for product catalog key #882194',
    'Payment gateway timeout after 3000ms retry limit'
];

function getRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function makePayload() {
    return JSON.stringify({
        service: getRandom(SERVICES),
        level: getRandom(LEVELS),
        message: getRandom(MESSAGES),
        timestamp: new Date().toISOString()
    });
}

const urlObj = new URL(TARGET_URL);

// Reusable HTTP Agent with Keep-Alive
const agent = new http.Agent({
    keepAlive: true,
    maxSockets: CONCURRENCY,
    maxFreeSockets: CONCURRENCY,
    timeout: 5000
});

async function runBenchmark() {
    console.log('='.repeat(70));
    console.log('🚀 NODE.JS HIGH-THROUGHPUT STRESS TEST (P0 BENCHMARK)');
    console.log('='.repeat(70));
    console.log(`Endpoint        : ${TARGET_URL}`);
    console.log(`Total Logs      : ${TOTAL_REQUESTS.toLocaleString()}`);
    console.log(`Concurrency     : ${CONCURRENCY} parallel pipelines`);
    console.log('-'.repeat(70));

    const latencies = [];
    const statusCounts = {};
    let completed = 0;
    let inFlight = 0;
    let scheduled = 0;

    const t0 = process.hrtime.bigint();

    return new Promise((resolve) => {
        function dispatchNext() {
            if (completed >= TOTAL_REQUESTS) {
                return;
            }

            while (inFlight < CONCURRENCY && scheduled < TOTAL_REQUESTS) {
                scheduled++;
                inFlight++;
                sendRequest();
            }
        }

        function sendRequest() {
            const payload = Buffer.from(makePayload(), 'utf8');
            const reqStart = process.hrtime.bigint();

            const req = http.request({
                hostname: urlObj.hostname,
                port: urlObj.port || 80,
                path: urlObj.pathname,
                method: 'POST',
                agent: agent,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length
                }
            }, (res) => {
                res.resume(); // consume response stream
                res.on('end', () => {
                    const reqEnd = process.hrtime.bigint();
                    const latMs = Number(reqEnd - reqStart) / 1e6;
                    latencies.push(latMs);

                    const status = res.statusCode;
                    statusCounts[status] = (statusCounts[status] || 0) + 1;

                    inFlight--;
                    completed++;

                    if (completed % 1000 === 0 || completed === TOTAL_REQUESTS) {
                        process.stdout.write(`\r⚡ Progress: ${completed.toLocaleString()}/${TOTAL_REQUESTS.toLocaleString()} logs ingested...`);
                    }

                    if (completed >= TOTAL_REQUESTS) {
                        finish();
                    } else {
                        dispatchNext();
                    }
                });
            });

            req.on('error', (err) => {
                const reqEnd = process.hrtime.bigint();
                const latMs = Number(reqEnd - reqStart) / 1e6;
                latencies.push(latMs);
                statusCounts['error'] = (statusCounts['error'] || 0) + 1;

                inFlight--;
                completed++;
                if (completed >= TOTAL_REQUESTS) {
                    finish();
                } else {
                    dispatchNext();
                }
            });

            req.write(payload);
            req.end();
        }

        function finish() {
            const tTotal = Number(process.hrtime.bigint() - t0) / 1e9;
            console.log('\n' + '-'.repeat(70));

            latencies.sort((a, b) => a - b);
            const n = latencies.length;
            const p50 = latencies[Math.floor(n * 0.50)] || 0;
            const p90 = latencies[Math.floor(n * 0.90)] || 0;
            const p95 = latencies[Math.floor(n * 0.95)] || 0;
            const p99 = latencies[Math.floor(n * 0.99)] || 0;
            const minLat = latencies[0] || 0;
            const maxLat = latencies[n - 1] || 0;
            const avgLat = latencies.reduce((a, b) => a + b, 0) / n;
            const throughput = n / tTotal;

            console.log('📊 BENCHMARK METRICS SUMMARY');
            console.log('='.repeat(70));
            console.log(`Total Requests Sent   : ${n.toLocaleString()}`);
            console.log(`HTTP 202 Accepted     : ${(statusCounts[202] || 0).toLocaleString()} (${((statusCounts[202] || 0) / n * 100).toFixed(2)}%)`);
            if (Object.keys(statusCounts).some(k => k !== '202')) {
                console.log(`Other Statuses        : ${JSON.stringify(statusCounts)}`);
            }
            console.log(`Elapsed Time          : ${tTotal.toFixed(3)} seconds`);
            console.log(`Throughput            : ${throughput.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} logs/sec`);
            console.log('-'.repeat(70));
            console.log('⏱️ LATENCY PERCENTILES');
            console.log(`  Min Latency         : ${minLat.toFixed(2)} ms`);
            console.log(`  P50 (Median)        : ${p50.toFixed(2)} ms`);
            console.log(`  Avg Latency         : ${avgLat.toFixed(2)} ms`);
            console.log(`  P90 Latency         : ${p90.toFixed(2)} ms`);
            console.log(`  P95 Latency         : ${p95.toFixed(2)} ms`);
            console.log(`  P99 Latency         : ${p99.toFixed(2)} ms`);
            console.log(`  Max Latency         : ${maxLat.toFixed(2)} ms`);
            console.log('='.repeat(70));
            resolve();
        }

        dispatchNext();
    });
}

runBenchmark();
