# Real-Time Distributed Log Monitoring System

A production-style distributed system for real-time log ingestion, processing, visualization, and alerting.

---

##  Architecture

```text
Client
  ↓
Flask API
  ↓
Redis Queue (Async Buffer)
  ↓
Worker (Processor)
  ├── MongoDB        → Persistent Storage
  ├── WebSocket      → Real-time Dashboard
  └── Webhooks       → Alerting System
---

## Features

* Real-time log streaming via WebSockets
* Redis-based asynchronous queue processing
* MongoDB persistence with indexing
* Smart alerting system (threshold-based + webhook notifications)
* Filtering and search in UI
* Fully containerized using Docker Compose

---

## Tech Stack

* Backend: Flask, Flask-SocketIO
* Queue: Redis
* Database: MongoDB
* Frontend: HTML, CSS, JavaScript
* DevOps: Docker, Docker Compose

---

## 🚀 Run the Project

### 1. Clone repo

```bash
git clone https://github.com/YOUR_USERNAME/Real-Time-Log-Monitoring-System.git
cd Real-Time-Log-Monitoring-System
```

### 2. Setup environment

```bash
cp .env.example .env
```

### 3. Start system

```bash
docker compose up --build
```

---

## 🧪 Test Logging

```bash
curl -X POST http://localhost:5000/log \
-H "Content-Type: application/json" \
-d '{"service":"auth","level":"ERROR","message":"test error"}'
```

---

## System Highlights

* Decoupled architecture (API → Queue → Worker)
* Handles high-throughput log ingestion
* Real-time UI updates without polling
* Alerting system prevents error flooding using thresholds

---

## Future Improvements

* Analytics dashboard (charts)
* Log retention policies (TTL)
* Role-based access control
* Deployment to cloud (AWS/GCP)

---

## Author

Sarthak Belkar
