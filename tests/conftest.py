import os
import sys
import pytest
import fakeredis
import mongomock

# Ensure repository root and backend directory are on Python path
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BACKEND_DIR = os.path.join(REPO_ROOT, 'backend')
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

@pytest.fixture
def fake_redis():
    """Provides an isolated in-memory Redis client."""
    server = fakeredis.FakeServer()
    client = fakeredis.FakeRedis(server=server, decode_responses=True)
    return client

@pytest.fixture
def fake_mongo():
    """Provides an isolated in-memory MongoDB logs collection."""
    client = mongomock.MongoClient()
    db = client['log_system_test']
    collection = db['logs']
    return collection

@pytest.fixture
def client(fake_redis, fake_mongo, monkeypatch):
    """Provides a configured Flask test client patched with in-memory DB and Queue."""
    import backend.app as app_module

    monkeypatch.setattr(app_module, 'redis_client', fake_redis)
    monkeypatch.setattr(app_module, 'logs_collection', fake_mongo)

    app_module.app.config['TESTING'] = True
    with app_module.app.test_client() as test_client:
        yield test_client
