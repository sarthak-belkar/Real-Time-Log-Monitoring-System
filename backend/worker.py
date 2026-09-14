import redis
import json
import time
import os
import requests
from datetime import datetime, timezone
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from flask_socketio import SocketIO
from dotenv import load_dotenv

from db import init_db

load_dotenv()
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
WEBHOOK_URL = os.getenv("WEBHOOK_URL")

# Setup SocketIO, Redis, and DB
socketio = SocketIO(message_queue=REDIS_URL)
redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
logs_collection = init_db()

# --- DEAD LETTER QUEUE (DLQ) & RETRY CONFIG ---
MAX_RETRIES = 3
DLQ_KEY = 'log_dlq'

# --- ALERTING STATE & NON-BLOCKING EXECUTOR ---
error_windows = defaultdict(list)
alert_cooldowns = {}
ALERT_COOLDOWN_SECONDS = 60
webhook_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="webhook-worker")

# --- IN-MEMORY STATS STATE ---
level_counts = {"INFO": 0, "WARN": 0, "ERROR": 0, "DEBUG": 0}

current_second = ""
current_second_count = 0

def initialize_stats():
    """Fetches the initial level counts from the DB on worker boot."""
    try:
        agg = logs_collection.aggregate([{"$group": {"_id": "$level", "count": {"$sum": 1}}}])
        for doc in agg:
            lvl = doc["_id"].upper()
            if lvl in level_counts:
                level_counts[lvl] = doc["count"]
        print("📊 Worker stats initialized.")
    except Exception as e:
        print(f"⚠️ Stats init warning: {e}")

def should_trigger_alert(service):
    """Returns True if a service has 3+ errors within a 10-second rolling window, respecting cooldown."""
    if not service:
        service = 'unknown'
    now = time.time()
    
    # Check cooldown (avoid spamming webhooks within cooldown window)
    last_alert = alert_cooldowns.get(service, 0)
    if now - last_alert < ALERT_COOLDOWN_SECONDS:
        return False
        
    valid_times = [t for t in error_windows[service] if now - t <= 10]
    valid_times.append(now)
    error_windows[service] = valid_times
    
    if len(valid_times) >= 3:
        error_windows[service] = []  # Reset window
        alert_cooldowns[service] = now  # Set cooldown timestamp
        return True
    return False


def send_webhook_alert(log_data):
    """Sends a formatted alert to Discord/Slack."""
    if not WEBHOOK_URL or "YOUR_WEBHOOK" in WEBHOOK_URL:
        return

    service = log_data.get('service', 'Unknown Service')
    message = log_data.get('message', 'No message provided')
    timestamp = log_data.get('timestamp', 'Unknown Time')

    formatted_alert = (
        f"🚨 **CRITICAL ALERT: HIGH ERROR RATE** 🚨\n"
        f"**Service:** `{service}`\n"
        f"**Message:** {message}\n"
        f"**Time:** {timestamp}\n"
        f"_Triggered by 3+ errors in 10 seconds._"
    )

    payload = {"content": formatted_alert, "text": formatted_alert}

    try:
        response = requests.post(WEBHOOK_URL, json=payload, timeout=3)
        response.raise_for_status()
        print(f"🔔 Webhook alert sent successfully for {service}!")
    except Exception as e:
        print(f"⚠️ Failed to send webhook alert: {e}")

def start_worker():
    initialize_stats()
    global current_second, current_second_count
    print(f"🚀 Worker started. Listening on 'log_queue' (DLQ: '{DLQ_KEY}', Max Retries: {MAX_RETRIES})...")
    
    while True:
        try:
            result = redis_client.brpop('log_queue', timeout=0)
            if not result:
                continue
                
            _, log_str = result
            
            # Safe JSON parsing
            try:
                log_data = json.loads(log_str)
            except json.JSONDecodeError as jde:
                print("❌ Error: Invalid JSON in queue. Routing to DLQ...")
                dlq_entry = {
                    "raw": log_str,
                    "error": f"JSONDecodeError: {jde}",
                    "failed_at": datetime.now(timezone.utc).isoformat()
                }
                redis_client.lpush(DLQ_KEY, json.dumps(dlq_entry))
                continue
            
            try:
                # 1. DB Insert (include created_at for TTL index)
                doc_to_insert = log_data.copy()
                doc_to_insert['created_at'] = datetime.now(timezone.utc)
                insert_result = logs_collection.insert_one(doc_to_insert)
                log_data['_id'] = str(insert_result.inserted_id)
                
                # 2. Emit to WebSockets
                socketio.emit('new_log', log_data)
                
                # 3. Update Stats In-Memory & Emit Update
                lvl = log_data.get('level', 'INFO').upper()
                if lvl in level_counts:
                    level_counts[lvl] += 1
                
                log_sec = str(log_data.get('timestamp', ''))[11:19] # Extract HH:MM:SS safely
                if log_sec == current_second:
                    current_second_count += 1
                else:
                    current_second = log_sec
                    current_second_count = 1

                socketio.emit("stats_update", {
                    "levels": level_counts,
                    "latest_second": current_second,
                    "latest_count": current_second_count
                })

                print(f"✅ Processed: [{lvl}] {log_data.get('service')}")

                # 4. Alerting Logic (non-blocking thread pool execution)
                if lvl == 'ERROR' and should_trigger_alert(log_data.get('service')):
                    webhook_executor.submit(send_webhook_alert, log_data.copy())

                
            except Exception as mongo_err:
                retries = log_data.get('_retries', 0) + 1
                log_data['_retries'] = retries
                if retries <= MAX_RETRIES:
                    print(f"⚠️ DB Error: {mongo_err}. Retry {retries}/{MAX_RETRIES} in 1s...")
                    redis_client.rpush('log_queue', json.dumps(log_data))
                    time.sleep(1)
                else:
                    print(f"❌ Exceeded {MAX_RETRIES} retries. Routing to '{DLQ_KEY}': {mongo_err}")
                    dlq_entry = {
                        "payload": log_data,
                        "error": str(mongo_err),
                        "retries": retries,
                        "failed_at": datetime.now(timezone.utc).isoformat()
                    }
                    redis_client.lpush(DLQ_KEY, json.dumps(dlq_entry))
                
        except Exception as e:
            print(f"❌ Worker Error: {e}")
            time.sleep(2)

if __name__ == '__main__':
    start_worker()