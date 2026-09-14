const express = require('express');
const cors = require('cors');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cors()); // Allows your frontend to fetch data

// In-memory array to store the latest 100 logs
const logs = [];

// POST: Receive logs from the log_producer
app.post('/logs', (req, res) => {
    const log = req.body;

    if (!log.service || !log.level || !log.message) {
        return res.status(400).json({ error: "Invalid log format" });
    }

    // Add new log to the top of the array
    logs.unshift(log); 
    
    // Keep memory clean by only storing the last 100 logs
    if (logs.length > 100) logs.pop(); 

    console.log(`[${log.timestamp}] [${log.service.toUpperCase()}] [${log.level.toUpperCase()}]: ${log.message}`);
    res.status(201).json({ status: "success" });
});

// GET: Serve logs to the frontend
app.get('/logs', (req, res) => {
    res.json(logs);
});

app.listen(PORT, () => {
    console.log(`🚀 Backend API listening at http://localhost:${PORT}`);
});