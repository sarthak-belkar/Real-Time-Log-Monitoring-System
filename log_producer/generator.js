const API_URL = 'http://localhost:3000/logs';

const SERVICES = ['auth', 'database', 'payment', 'frontend', 'cache'];
const LEVELS = ['info', 'warn', 'error', 'debug'];
const MESSAGES = {
    auth: ['User login successful', 'Invalid password attempt', 'Token expired'],
    database: ['Connection pool full', 'Query executed successfully', 'Deadlock detected'],
    payment: ['Transaction approved', 'Card declined', 'API rate limit reached'],
    frontend: ['Component rendered', 'Image load failed', 'Uncaught TypeError'],
    cache: ['Cache hit', 'Cache miss', 'Redis disconnected']
};

const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

function generateLog() {
    const service = getRandom(SERVICES);
    return {
        service: service,
        level: getRandom(LEVELS),
        message: getRandom(MESSAGES[service]),
        timestamp: new Date().toISOString()
    };
}

async function sendLog() {
    const logData = generateLog();
    try {
        await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logData)
        });
        console.log(`✅ Sent ${logData.level} log from '${logData.service}'`);
    } catch (error) {
        console.error(`🔌 Connection failed. Backend running?`);
    }
}

setInterval(sendLog, 1500);