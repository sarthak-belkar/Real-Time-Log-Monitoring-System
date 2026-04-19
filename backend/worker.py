import redis
import json
import time
import os
import requests
from collections import defaultdict
from dotenv import load_dotenv
from flask_socketio import SocketIO
from db import init_db

load_dotenv()

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
WEBHOOK_URL = os.getenv("WEBHOOK_URL")

socketio = SocketIO(message_queue=REDIS_URL)
redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)

logs_collection = init_db()

error_windows = defaultdict(list)


def should_trigger_alert(service):
    now = time.time()

    valid_times = [t for t in error_windows[service] if now - t <= 10]
    valid_times.append(now)
    error_windows[service] = valid_times

    if len(valid_times) >= 3:
        error_windows[service] = []
        return True

    return False


def send_webhook_alert(log_data):
    if not WEBHOOK_URL:
        print("⚠️ WEBHOOK_URL not set")
        return

    payload = {
        "content": f"🚨 ERROR in {log_data['service']}\n{log_data['message']}",
        "text": f"🚨 ERROR in {log_data['service']}\n{log_data['message']}"
    }

    try:
        requests.post(WEBHOOK_URL, json=payload, timeout=3)
        print("🔔 Alert sent")
    except Exception as e:
        print("⚠️ Alert failed:", e)


def start_worker():
    print("🚀 Worker started...")

    while True:
        try:
            result = redis_client.brpop('log_queue', timeout=0)

            if not result:
                continue

            _, log_str = result
            log_data = json.loads(log_str)

            # 1. Save to DB
            insert = logs_collection.insert_one(log_data.copy())
            log_data['_id'] = str(insert.inserted_id)

            # 2. Emit to frontend
            socketio.emit('new_log', log_data)

            # 3. Alert logic
            if log_data.get('level') == 'ERROR':
                if should_trigger_alert(log_data['service']):
                    send_webhook_alert(log_data)

        except Exception as e:
            print("❌ Worker error:", e)
            time.sleep(2)


if __name__ == '__main__':
    start_worker()