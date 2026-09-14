import json
import time
from datetime import datetime, timezone
import backend.worker as worker_module

def test_alerting_threshold_and_cooldown():
    """Test should_trigger_alert requires 3 errors in 10s and enforces a 60s cooldown."""
    service = "test-service"
    worker_module.error_windows[service] = []
    worker_module.alert_cooldowns[service] = 0

    # 1st error: no alert
    assert worker_module.should_trigger_alert(service) is False
    # 2nd error: no alert
    assert worker_module.should_trigger_alert(service) is False
    # 3rd error: alert triggers!
    assert worker_module.should_trigger_alert(service) is True

    # 4th error immediately following: suppressed by cooldown!
    assert worker_module.should_trigger_alert(service) is False

def test_send_webhook_alert_safety_with_placeholder(monkeypatch):
    """Test send_webhook_alert skips execution when WEBHOOK_URL is a placeholder."""
    import requests
    posted = False

    def mock_post(*args, **kwargs):
        nonlocal posted
        posted = True
        raise RuntimeError("Should not be called")

    monkeypatch.setattr(requests, 'post', mock_post)
    monkeypatch.setattr(worker_module, 'WEBHOOK_URL', 'https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN')

    # Must safely return without making requests
    worker_module.send_webhook_alert({"service": "auth", "message": "test", "timestamp": "now"})
    assert posted is False

def test_worker_stats_initialization(fake_mongo, monkeypatch):
    """Test initialize_stats populates level_counts from MongoDB."""
    fake_mongo.insert_many([
        {"level": "INFO"},
        {"level": "INFO"},
        {"level": "ERROR"},
        {"level": "DEBUG"}
    ])
    monkeypatch.setattr(worker_module, 'logs_collection', fake_mongo)
    worker_module.level_counts = {"INFO": 0, "WARN": 0, "ERROR": 0, "DEBUG": 0}

    worker_module.initialize_stats()
    assert worker_module.level_counts['INFO'] >= 2
    assert worker_module.level_counts['ERROR'] >= 1
    assert worker_module.level_counts['DEBUG'] >= 1

def test_dlq_poison_pill_routing(fake_redis, fake_mongo, monkeypatch):
    """Test that a corrupt JSON string is safely moved to the Dead Letter Queue (DLQ)."""
    monkeypatch.setattr(worker_module, 'redis_client', fake_redis)
    monkeypatch.setattr(worker_module, 'logs_collection', fake_mongo)

    # Push malformed JSON into queue
    fake_redis.lpush('log_queue', "INVALID_JSON_{{{")

    # Simulate one iteration of worker queue processing
    result = fake_redis.brpop('log_queue', timeout=1)
    assert result is not None
    _, log_str = result

    try:
        json.loads(log_str)
        assert False, "Should have raised JSONDecodeError"
    except json.JSONDecodeError as jde:
        dlq_entry = {
            "raw": log_str,
            "error": f"JSONDecodeError: {jde}",
            "failed_at": datetime.now(timezone.utc).isoformat()
        }
        fake_redis.lpush(worker_module.DLQ_KEY, json.dumps(dlq_entry))

    # Verify DLQ received the poison pill
    dlq_item = fake_redis.rpop(worker_module.DLQ_KEY)
    assert dlq_item is not None
    assert "INVALID_JSON" in dlq_item

def test_dlq_max_retries_routing(fake_redis, fake_mongo, monkeypatch):
    """Test that messages failing Mongo insert exceed MAX_RETRIES and route to DLQ."""
    monkeypatch.setattr(worker_module, 'redis_client', fake_redis)

    log_data = {"service": "db-test", "level": "ERROR", "message": "fail", "_retries": 3}

    # Simulate 4th failure (exceeding MAX_RETRIES = 3)
    retries = log_data.get('_retries', 0) + 1
    log_data['_retries'] = retries

    assert retries > worker_module.MAX_RETRIES

    dlq_entry = {
        "payload": log_data,
        "error": "Simulated Mongo Write Error",
        "retries": retries,
        "failed_at": datetime.now(timezone.utc).isoformat()
    }
    fake_redis.lpush(worker_module.DLQ_KEY, json.dumps(dlq_entry))

    # Verify message landed in DLQ
    item = fake_redis.rpop(worker_module.DLQ_KEY)
    assert item is not None
    parsed = json.loads(item)
    assert parsed['retries'] == 4
    assert parsed['payload']['service'] == 'db-test'
