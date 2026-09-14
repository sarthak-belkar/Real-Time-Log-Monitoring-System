from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from flask_cors import CORS
from flask import send_from_directory
import redis
import json
import os
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv


from db import init_db

load_dotenv()

app = Flask(__name__)
CORS(app) 
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-key-change-in-production')
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
socketio = SocketIO(app, cors_allowed_origins="*", message_queue=REDIS_URL)
redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)

# Initialize DB
logs_collection = init_db()

# --- HEALTH / LIVENESS ENDPOINT ---
@app.route('/health', methods=['GET'])
def health_check():
    health = {
        "status": "healthy",
        "redis": "unknown",
        "mongodb": "unknown",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    status_code = 200

    # 1. Check Redis
    try:
        redis_client.ping()
        health["redis"] = "connected"
    except Exception as e:
        health["redis"] = f"error: {e}"
        health["status"] = "degraded"
        status_code = 503

    # 2. Check MongoDB
    try:
        logs_collection.database.command('ping')
        health["mongodb"] = "connected"
    except Exception as e:
        health["mongodb"] = f"error: {e}"
        health["status"] = "degraded"
        status_code = 503

    return jsonify(health), status_code

# --- STATS ENDPOINT ---
@app.route('/stats', methods=['GET'])
def get_stats():

    # 1. Level counts (Limit to last 24 hours for performance)
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    
    level_agg = list(logs_collection.aggregate([
        {"$match": {"timestamp": {"$gte": yesterday}}},
        {"$group": {"_id": "$level", "count": {"$sum": 1}}}
    ]))
    
    levels = {"INFO": 0, "WARN": 0, "ERROR": 0, "DEBUG": 0}
    for item in level_agg:
        levels[item["_id"].upper()] = item["count"]


    # 2. Time-series for last 60 seconds
    sixty_seconds_ago = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
    
    time_agg = list(logs_collection.aggregate([
        {"$match": {"timestamp": {"$gte": sixty_seconds_ago}}},
        {
            "$addFields": {
                # Extracts HH:MM:SS from ISO string
                "second": {"$substr": ["$timestamp", 11, 8]} 
            }
        },
        {"$group": {"_id": "$second", "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}} # Sort chronologically
    ]))
    
    time_series = [{"second": item["_id"], "count": item["count"]} for item in time_agg]

    return jsonify({
        "levels": levels,
        "time_series": time_series
    })

# --- EXISTING ENDPOINTS (DAYS 1-6) ---
@app.route('/log', methods=['POST'])
def receive_log():
    data = request.get_json(silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON payload"}), 400

    if not all(k in data for k in ("service", "level", "message")):
        return jsonify({"error": "Missing required fields: service, level, message"}), 400

    # Sanitize and enforce safe limits
    service = str(data["service"]).strip()[:64]
    level = str(data["level"]).strip().upper()[:16]
    message = str(data["message"])[:10000]

    if not service or not message:
        return jsonify({"error": "Fields 'service' and 'message' cannot be empty"}), 400

    clean_log = {
        "service": service,
        "level": level if level in ("INFO", "WARN", "ERROR", "DEBUG") else "INFO",
        "message": message,
        "timestamp": data.get('timestamp', datetime.now(timezone.utc).isoformat())
    }
    
    redis_client.lpush('log_queue', json.dumps(clean_log))
    return jsonify({"status": "queued"}), 202


@app.route('/logs', methods=['GET'])
def get_logs():
    query = {}
    
    if 'level' in request.args:
        query['level'] = request.args.get('level').upper()
    if 'service' in request.args:
        query['service'] = request.args.get('service')
    if 'keyword' in request.args:
        query['$text'] = {'$search': request.args.get('keyword')}

    cursor = logs_collection.find(query).sort("timestamp", -1).limit(100)
    
    logs = []
    for doc in cursor:
        doc['_id'] = str(doc['_id'])
        logs.append(doc)
        
    return jsonify(logs)

# Absolute path to frontend folder
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, '..', 'frontend')

@app.route('/')
def serve_index():
    print("🔥 Serving index.html from:", FRONTEND_DIR)
    return send_from_directory(FRONTEND_DIR, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    print("📁 Serving file:", path)
    return send_from_directory(FRONTEND_DIR, path)

# --- CRITICAL: THE STARTUP BLOCK ---
if __name__ == '__main__':
    # This keeps the server running infinitely
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)