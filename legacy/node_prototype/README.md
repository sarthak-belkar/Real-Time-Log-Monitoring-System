# Legacy Node.js Prototypes

These files contain the original Node.js / Express prototypes for log ingestion and streaming:
- `backend.js`: Express server with Redis Streams (`log_stream`) and Socket.io.
- `server.js`: Minimal in-memory Express log receiver.
- `producer.js`: Simulated log producer publishing to Redis Streams.

The active production architecture uses the Python / Flask / Redis Queue stack located in `/backend` and the HTTP generator in `/log_producer/generator.js`.
