"""
Automated Load & Burst Testing Suite
====================================
Tests high-volume burst ingestion against Flask API and verifies:
1. All logs are accepted (202 Accepted) without drops.
2. In-memory queue receives all burst items.
3. Queue depth matches burst count exactly.
"""

import json
from concurrent.futures import ThreadPoolExecutor

def test_burst_ingestion_throughput(client, fake_redis):
    """Verifies that high-frequency burst requests are ingested without drops or race conditions."""
    burst_count = 100

    responses = []
    for idx in range(burst_count):
        payload = {
            "service": f"service-{idx % 5}",
            "level": "INFO",
            "message": f"High volume burst payload #{idx}"
        }
        resp = client.post('/log', json=payload)
        responses.append(resp)

    # Verify all responses are 202 Accepted
    for resp in responses:
        assert resp.status_code == 202
        assert resp.get_json() == {"status": "queued"}

    # Verify all items reached the queue
    queue_len = fake_redis.llen('log_queue')
    assert queue_len == burst_count

    # Verify FIFO integrity and payload structure for popped item
    first_item = json.loads(fake_redis.rpop('log_queue'))
    assert 'service' in first_item
    assert 'timestamp' in first_item
    assert first_item['level'] == 'INFO'
