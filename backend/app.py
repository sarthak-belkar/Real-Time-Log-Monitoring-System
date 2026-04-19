import os
import json
import redis
from datetime import datetime, timezone
from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from flask_cors import CORS
from dotenv import load_dotenv
from db import init_db

load_dotenv()

app = Flask(__name__)
CORS(app)
app.config['SECRET_KEY'] = 'secret!'

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

socketio = SocketIO(app, cors_allowed_origins="*", message_queue=REDIS_URL)
redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)

logs_collection = init_db()

@app.route('/log', methods=['POST'])
def receive_log():
    data = request.json

    if not data or not all(k in data for k in ("service", "level", "message")):
        return jsonify({"error": "Invalid log format"}), 400

    data['timestamp'] = data.get(
        'timestamp',
        datetime.now(timezone.utc).isoformat()
    )

    redis_client.lpush('log_queue', json.dumps(data))
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


if __name__ == '__main__':
    socketio.run(
        app,
        host='0.0.0.0',
        port=5000,
        debug=True,
        allow_unsafe_werkzeug=True
    )