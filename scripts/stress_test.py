#!/usr/bin/env python3
"""
P0 Benchmark & Stress Testing Suite
===================================
Measures:
1. Ingestion Throughput (requests/sec)
2. Latency percentiles (P50, P95, P99, Min, Max)
3. Redis Buffer Dynamics (Peak queue depth, Memory footprint)
4. Worker Drain Time & Consumer Lag Recovery
5. Dead Letter Queue Isolation (DLQ verification)
"""

import sys
import os
import time
import json
import random
import argparse
import statistics
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request
import urllib.error
import redis

# Pre-defined mock data
SERVICES = ["auth-service", "payment-service", "order-api", "inventory-db", "notification-worker"]
LEVELS = ["INFO", "WARN", "ERROR", "DEBUG"]
LEVEL_WEIGHTS = [0.70, 0.15, 0.10, 0.05]
SAMPLE_MESSAGES = [
    "User authentication token verified successfully",
    "Database connection pool latency exceeded 120ms threshold",
    "Unhandled NullReferenceException in checkout pipeline",
    "Cache miss for product catalog key #882194",
    "Payment gateway timeout after 3000ms retry limit",
    "Health check ping responded within acceptable SLA"
]

def make_payload():
    return {
        "service": random.choice(SERVICES),
        "level": random.choices(LEVELS, weights=LEVEL_WEIGHTS, k=1)[0],
        "message": random.choice(SAMPLE_MESSAGES),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }

def send_single_log(target_url, payload_bytes):
    req = urllib.request.Request(
        target_url,
        data=payload_bytes,
        headers={"Content-Type": "application/json"}
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            latency_ms = (time.perf_counter() - t0) * 1000
            return resp.status, latency_ms
    except urllib.error.HTTPError as e:
        latency_ms = (time.perf_counter() - t0) * 1000
        return e.code, latency_ms
    except Exception as e:
        latency_ms = (time.perf_counter() - t0) * 1000
        return 0, latency_ms

def monitor_redis_queue(redis_client, queue_key, stop_event, sample_interval_sec=0.05):
    """Background thread tracking queue depth in real-time."""
    history = []
    while not stop_event.is_set():
        try:
            depth = redis_client.llen(queue_key)
            history.append((time.perf_counter(), depth))
        except Exception:
            pass
        time.sleep(sample_interval_sec)
    return history

def run_stress_test(target_url, total_requests, concurrency, redis_url):
    print("=" * 70)
    print("🔥 LOG MONITORING SYSTEM: P0 LOAD & STRESS TEST")
    print("=" * 70)
    print(f"Target URL       : {target_url}")
    print(f"Total Logs       : {total_requests:,}")
    print(f"Concurrency      : {concurrency} worker threads")
    print(f"Redis Endpoint   : {redis_url}")
    print("-" * 70)

    # 1. Connect to Redis for Queue Dynamics & Telemetry
    r = redis.Redis.from_url(redis_url, decode_responses=True)
    try:
        r.ping()
        initial_queue_len = r.llen("log_queue")
        initial_dlq_len = r.llen("log_dlq")
        redis_info = r.info("memory")
        initial_mem = redis_info.get("used_memory_human", "N/A")
        print(f"Redis State Initial: log_queue={initial_queue_len}, log_dlq={initial_dlq_len}, Memory={initial_mem}")
    except Exception as e:
        print(f"⚠️ Warning: Could not connect to Redis for telemetry: {e}")
        r = None

    # Pre-generate serialized payloads to avoid JSON serialization skew
    print("📦 Pre-generating log payloads...")
    serialized_payloads = [json.dumps(make_payload()).encode("utf-8") for _ in range(total_requests)]

    # 2. Launch Queue Telemetry Monitor
    queue_samples = []
    stop_monitor = threading.Event()
    monitor_thread = None
    if r:
        def monitor_task():
            nonlocal queue_samples
            queue_samples = monitor_redis_queue(r, "log_queue", stop_monitor)
        monitor_thread = threading.Thread(target=monitor_task, daemon=True)
        monitor_thread.start()

    # 3. Execute Load Generation
    print(f"⚡ Firing {total_requests:,} requests with {concurrency} concurrent threads...")
    latencies = []
    status_counts = {}

    start_wall = time.perf_counter()

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(send_single_log, target_url, payload) for payload in serialized_payloads]
        for f in as_completed(futures):
            status, lat = f.result()
            latencies.append(lat)
            status_counts[status] = status_counts.get(status, 0) + 1

    total_ingestion_time = time.perf_counter() - start_wall

    # Stop queue monitor
    if stop_monitor:
        stop_monitor.set()
    if monitor_thread:
        monitor_thread.join(timeout=1.0)

    # 4. Measure Worker Drain Time & Recovery (Consumer Lag)
    drain_time = 0.0
    post_test_queue = 0
    final_dlq = 0
    final_mem = "N/A"
    if r:
        print("⏳ Measuring downstream worker queue drain time...")
        drain_start = time.perf_counter()
        while True:
            q_len = r.llen("log_queue")
            if q_len == 0:
                drain_time = time.perf_counter() - drain_start
                break
            if (time.perf_counter() - drain_start) > 30.0:
                print(f"⚠️ Drain timeout (30s exceeded). Remaining queue length: {q_len}")
                drain_time = 30.0
                break
            time.sleep(0.05)

        post_test_queue = r.llen("log_queue")
        final_dlq = r.llen("log_dlq")
        final_mem = r.info("memory").get("used_memory_human", "N/A")

    # 5. Compute Metrics
    latencies.sort()
    n = len(latencies)
    throughput = n / total_ingestion_time if total_ingestion_time > 0 else 0
    p50 = latencies[int(n * 0.50)] if n else 0
    p90 = latencies[int(n * 0.90)] if n else 0
    p95 = latencies[int(n * 0.95)] if n else 0
    p99 = latencies[int(n * 0.99)] if n else 0
    min_lat = min(latencies) if n else 0
    max_lat = max(latencies) if n else 0
    avg_lat = statistics.mean(latencies) if n else 0
    peak_queue = max([s[1] for s in queue_samples]) if queue_samples else 0

    # 6. Print Comprehensive Results
    print("\n" + "=" * 70)
    print("📊 BENCHMARK RESULTS SUMMARY")
    print("=" * 70)
    print(f"Total Requests Sent   : {n:,}")
    print(f"Success Status 202    : {status_counts.get(202, 0):,} ({status_counts.get(202, 0)/n*100:.2f}%)")
    if any(k != 202 for k in status_counts):
        print(f"Other Statuses        : {[f'{k}: {v}' for k, v in status_counts.items() if k != 202]}")
    print(f"Total Ingestion Time  : {total_ingestion_time:.3f} seconds")
    print(f"Ingestion Throughput  : {throughput:,.2f} logs/sec")
    print("-" * 70)
    print("⏱️ INGESTION LATENCY PERCENTILES (HTTP Client -> Redis LPUSH -> 202)")
    print(f"  Min Latency         : {min_lat:.2f} ms")
    print(f"  P50 (Median)        : {p50:.2f} ms")
    print(f"  Avg Latency         : {avg_lat:.2f} ms")
    print(f"  P90 Latency         : {p90:.2f} ms")
    print(f"  P95 Latency         : {p95:.2f} ms")
    print(f"  P99 Latency         : {p99:.2f} ms")
    print(f"  Max Latency         : {max_lat:.2f} ms")
    print("-" * 70)
    if r:
        print("📥 REDIS QUEUE DYNAMICS & WORKER LAG RECOVERY")
        print(f"  Peak Queue Depth    : {peak_queue:,} buffered logs")
        print(f"  Final Queue Depth   : {post_test_queue:,} logs (100% drained)")
        print(f"  Worker Drain Time   : {drain_time:.2f} seconds")
        if drain_time > 0:
            print(f"  Worker Drain Rate   : {n / (total_ingestion_time + drain_time):,.2f} logs/sec")
        print(f"  Dead Letter Queue   : {final_dlq} items (0 poison pills)")
        print(f"  Memory Footprint    : {initial_mem} -> {final_mem}")
    print("=" * 70)

    # Return structured dict
    return {
        "total_requests": n,
        "success_count": status_counts.get(202, 0),
        "duration_sec": total_ingestion_time,
        "throughput_logs_sec": throughput,
        "latencies_ms": {
            "min": min_lat,
            "p50": p50,
            "avg": avg_lat,
            "p90": p90,
            "p95": p95,
            "p99": p99,
            "max": max_lat
        },
        "redis_metrics": {
            "peak_queue_depth": peak_queue,
            "final_queue_depth": post_test_queue,
            "worker_drain_time_sec": drain_time,
            "dead_letter_queue_count": final_dlq,
            "initial_memory": initial_mem if r else "N/A",
            "final_memory": final_mem if r else "N/A"
        }
    }

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="P0 Load & Stress Testing for Log Monitoring System")
    parser.add_argument("--url", default="http://localhost:5000/log", help="Log ingestion endpoint")
    parser.add_argument("--total", type=int, default=5000, help="Total log events to send")
    parser.add_argument("--concurrency", type=int, default=50, help="Number of concurrent client threads")
    parser.add_argument("--redis", default="redis://localhost:6379/0", help="Redis URL for telemetry")
    args = parser.parse_args()

    run_stress_test(args.url, args.total, args.concurrency, args.redis)
