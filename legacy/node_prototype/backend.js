const express = require('express');
const { createClient } = require('redis');
const http = require('http');           // ⬅️ Added for WebSockets
const { Server } = require('socket.io'); // ⬅️ Added for WebSockets
const cors = require('cors');

const app = express();
app.use(cors());

// ⬅️ Setup HTTP server and Socket.io
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Allow our frontend to connect
});

const PORT = 3000;

const redisClient = createClient({ url: 'redis://localhost:6379' });
const blockingClient = redisClient.duplicate();

redisClient.on('error', (err) => console.error('Redis Error', err));
blockingClient.on('error', (err) => console.error('Redis Blocking Error', err));

const STREAM_KEY = 'log_stream';
const GROUP_NAME = 'backend_consumers';
const CONSUMER_NAME = 'consumer_1';

async function setupRedis() {
    await redisClient.connect();
    await blockingClient.connect();
    console.log('✅ Backend connected to Redis');

    try {
        await redisClient.xGroupCreate(STREAM_KEY, GROUP_NAME, '0', { MKSTREAM: true });
        console.log(`✅ Consumer group '${GROUP_NAME}' created.`);
    } catch (error) {
        if (!error.message.includes('BUSYGROUP')) throw error;
    }
}

async function consumeLogs() {
    console.log('🎧 Listening for logs in the queue...');
    
    while (true) {
        try {
            const response = await blockingClient.xReadGroup(
                GROUP_NAME, CONSUMER_NAME, [{ key: STREAM_KEY, id: '>' }],
                { COUNT: 10, BLOCK: 2000 } 
            );

            if (response) {
                for (const stream of response) {
                    for (const message of stream.messages) {
                        const logData = JSON.parse(message.message.data);
                        console.log(`⬇️ Processed Log: [${logData.service}] ${logData.message}`);

                        // ⬅️ EMIT the log in real-time to all connected frontends!
                        io.emit('new-log', logData);

                        await redisClient.xAck(STREAM_KEY, GROUP_NAME, message.id);
                    }
                }
            }
        } catch (error) {
            console.error('❌ Error consuming logs:', error.message);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// ⬅️ Notify when a frontend connects
io.on('connection', (socket) => {
    console.log('💻 Frontend dashboard connected via WebSockets!');
});

async function startServer() {
    await setupRedis();
    
    // ⬅️ Make sure to use server.listen(), NOT app.listen()
    server.listen(PORT, () => {
        console.log(`🚀 Backend API & WebSockets listening on http://localhost:${PORT}`);
    });

    consumeLogs();
}

startServer();