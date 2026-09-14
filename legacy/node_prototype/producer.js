// producer.js
const { createClient } = require('redis');

// Initialize Redis Client
const redisClient = createClient({ url: 'redis://localhost:6379' });

redisClient.on('error', (err) => console.error('Redis Client Error', err));

// Simulated log generator
function generateLog() {
    const services = ['auth', 'database', 'frontend'];
    const levels = ['info', 'warn', 'error'];
    const messages = ['Invalid token', 'Connection timeout', 'User logged in', 'Rate limit exceeded'];

    return {
        service: services[Math.floor(Math.random() * services.length)],
        level: levels[Math.floor(Math.random() * levels.length)],
        message: messages[Math.floor(Math.random() * messages.length)],
        timestamp: Date.now() // e.g., 1710000000000
    };
}

async function startProducer() {
    await redisClient.connect();
    console.log('✅ Producer connected to Redis');

    // Generate and push a log every 1.5 seconds
    setInterval(async () => {
        const logData = generateLog();
        
        try {
            // XADD adds an entry to a stream. 
            // 'log_stream' is the stream name. '*' tells Redis to auto-generate an ID.
            // Redis streams store key-value pairs, so we stringify our log object into a 'data' field.
            const messageId = await redisClient.xAdd('log_stream', '*', {
                data: JSON.stringify(logData)
            });
            
            console.log(`⬆️ Pushed to queue [${messageId}]: ${logData.level.toUpperCase()} from ${logData.service}`);
        } catch (error) {
            console.error('❌ Failed to push log:', error);
        }
    }, 1500);
}

startProducer();