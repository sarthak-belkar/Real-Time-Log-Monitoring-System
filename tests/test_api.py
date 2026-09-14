import json
from datetime import datetime, timezone

def test_health_endpoint_healthy(client):
    """Test /health returns 200 when all backing services are connected."""
    response = client.get('/health')
    assert response.status_code == 200
    data = response.get_json()
    assert data['status'] == 'healthy'
    assert data['redis'] == 'connected'
    assert data['mongodb'] == 'connected'
    assert 'timestamp' in data

def test_health_endpoint_degraded(client, monkeypatch):
    """Test /health returns 503 when a backing service fails."""
    import backend.app as app_module

    class BrokenRedis:
        def ping(self):
            raise ConnectionError("Connection refused")

    monkeypatch.setattr(app_module, 'redis_client', BrokenRedis())
    response = client.get('/health')
    assert response.status_code == 503
    data = response.get_json()
    assert data['status'] == 'degraded'
    assert 'error' in data['redis']

def test_receive_log_valid(client, fake_redis):
    """Test /log accepts valid payloads and queues them in Redis."""
    payload = {
        "service": "auth-service",
        "level": "ERROR",
        "message": "User authentication failed"
    }
    response = client.post('/log', json=payload)
    assert response.status_code == 202
    assert response.get_json() == {"status": "queued"}

    # Verify message was queued in Redis
    raw_message = fake_redis.rpop('log_queue')
    assert raw_message is not None
    data = json.loads(raw_message)
    assert data['service'] == 'auth-service'
    assert data['level'] == 'ERROR'
    assert data['message'] == 'User authentication failed'
    assert 'timestamp' in data

def test_receive_log_missing_fields(client):
    """Test /log rejects payloads missing mandatory keys."""
    # Missing 'message'
    response = client.post('/log', json={"service": "payment", "level": "INFO"})
    assert response.status_code == 400
    assert "Missing required fields" in response.get_json()['error']

def test_receive_log_empty_fields(client):
    """Test /log rejects empty strings for service or message."""
    response = client.post('/log', json={"service": "", "level": "INFO", "message": "   "})
    assert response.status_code == 400
    assert "cannot be empty" in response.get_json()['error']

def test_receive_log_invalid_payload_type(client):
    """Test /log rejects non-dict payloads."""
    response = client.post('/log', data="not json", content_type="application/json")
    assert response.status_code == 400

def test_receive_log_sanitization_and_normalization(client, fake_redis):
    """Test /log truncates excessively long strings and normalizes log levels."""
    payload = {
        "service": "a" * 100,      # should be truncated to 64
        "level": "invalid_level",   # unknown level defaults to INFO
        "message": "b" * 20000      # should be truncated to 10000
    }
    response = client.post('/log', json=payload)
    assert response.status_code == 202

    raw_message = fake_redis.rpop('log_queue')
    data = json.loads(raw_message)
    assert len(data['service']) == 64
    assert data['level'] == 'INFO'
    assert len(data['message']) == 10000

def test_get_logs(client, fake_mongo):
    """Test /logs returns recent logs formatted as JSON."""
    fake_mongo.insert_many([
        {"service": "auth", "level": "INFO", "message": "Login ok", "timestamp": "2026-09-14T10:00:00Z"},
        {"service": "payment", "level": "ERROR", "message": "Card declined", "timestamp": "2026-09-14T10:05:00Z"}
    ])

    response = client.get('/logs')
    assert response.status_code == 200
    logs = response.get_json()
    assert len(logs) == 2
    assert all('_id' in log for log in logs)

def test_get_logs_filtering(client, fake_mongo):
    """Test /logs filters by service and level query params."""
    fake_mongo.insert_many([
        {"service": "auth", "level": "INFO", "message": "ok", "timestamp": "2026-09-14T10:00:00Z"},
        {"service": "payment", "level": "ERROR", "message": "err", "timestamp": "2026-09-14T10:05:00Z"}
    ])

    # Filter by service
    res_service = client.get('/logs?service=payment')
    assert len(res_service.get_json()) == 1
    assert res_service.get_json()[0]['service'] == 'payment'

    # Filter by level
    res_level = client.get('/logs?level=info')
    assert len(res_level.get_json()) == 1
    assert res_level.get_json()[0]['level'] == 'INFO'

def test_get_stats(client, fake_mongo):
    """Test /stats returns aggregated level counts and time series."""
    now_iso = datetime.now(timezone.utc).isoformat()
    fake_mongo.insert_many([
        {"service": "auth", "level": "INFO", "message": "ok", "timestamp": now_iso},
        {"service": "auth", "level": "ERROR", "message": "err", "timestamp": now_iso},
        {"service": "auth", "level": "DEBUG", "message": "trace", "timestamp": now_iso}
    ])

    response = client.get('/stats')
    assert response.status_code == 200
    data = response.get_json()
    assert 'levels' in data
    assert 'time_series' in data
    assert data['levels']['INFO'] >= 1
    assert data['levels']['ERROR'] >= 1
    assert data['levels']['DEBUG'] >= 1
