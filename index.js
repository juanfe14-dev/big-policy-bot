require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');

console.log('🔥 INDEX.JS LOADED - BIG POLICY BOT 🔥');

/* =====================================================
   DISCORD CLIENT (⚠️ DEBE IR ANTES DE EXPRESS)
   ===================================================== */
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

/* =====================================================
   GITHUB API HELPER
   ===================================================== */
function githubApiRequest(path, method, body) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        return Promise.reject(new Error('GITHUB_TOKEN not set'));
    }

    const options = {
        hostname: 'api.github.com',
        path,
        method,
        headers: {
            'User-Agent': 'big-policy-bot',
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
        },
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data ? JSON.parse(data) : {});
                } else {
                    reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

/* =====================================================
   EXPRESS SERVER (RENDER)
   ===================================================== */
const app = express();
const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📡 Health check available at http://0.0.0.0:${PORT}/health`);
});

app.get('/', (req, res) => {
    res.send(`
        <h1>🤖 BIG Policy Bot is running</h1>
        <p>Status: ${client.user ? 'Connected to Discord' : 'Connecting...'}</p>
    `);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        bot_connected: !!client.user,
        bot_tag: client.user?.tag || null,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

/* =====================================================
   DATA STORAGE
   ===================================================== */
const DATA_DIR = process.env.RENDER
    ? '/opt/render/project/src/data'
    : path.join(__dirname, 'data');

const DATA_FILE = path.join(DATA_DIR, 'sales.json');

console.log(`📁 Data directory: ${DATA_DIR}`);

let salesData = {
    daily: {},
    weekly: {},
    monthly: {},
    allTime: {},
    dailySnapshot: {},
    weeklySnapshot: {},
    monthlySnapshot: {},
    lastReset: {
        daily: new Date().toDateString(),
        weekly: '',
        weeklyTag: '',
        monthly: new Date().getMonth(),
        monthlyTag: ''
    }
};

async function loadData() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
        const raw = await fs.readFile(DATA_FILE, 'utf8');
        salesData = JSON.parse(raw);
        console.log('📂 Data loaded successfully');
    } catch {
        await saveData();
    }
}

async function saveData() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
    console.log(`💾 Data saved`);
}

/* =====================================================
   UTILITIES
   ===================================================== */
function getWeekNumber(date) {
    const first = new Date(date.getFullYear(), 0, 1);
    return Math.ceil((((date - first) / 86400000) + first.getDay() + 1) / 7);
}

function checkResets() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const day = now.toDateString();
    const week = getWeekNumber(now);
    const monthTag = `${now.getFullYear()}-${now.getMonth()}`;

    if (salesData.lastReset.daily !== day) {
        salesData.daily = {};
        salesData.lastReset.daily = day;
    }

    if (salesData.lastReset.weeklyTag !== `${now.getFullYear()}-W${week}`) {
        if (now.getDay() === 1) {
            salesData.weekly = {};
            salesData.lastReset.weeklyTag = `${now.getFullYear()}-W${week}`;
        }
    }

    if (salesData.lastReset.monthlyTag !== monthTag) {
        salesData.monthly = {};
        salesData.lastReset.monthlyTag = monthTag;
    }
}

/* =====================================================
   SALES PARSER
   ===================================================== */
function parseMultipleSales(text) {
    const matches = [...text.matchAll(/\$([\d,]+(\.\d{2})?)/g)];
    return matches.map(m => ({
        amount: parseFloat(m[1].replace(/,/g, '')),
        policyType: 'General Policy'
    }));
}

function addSale(id, username, amount) {
    ['daily','weekly','monthly','allTime'].forEach(p => {
        if (!salesData[p][id]) {
            salesData[p][id] = { total: 0, count: 0, username };
        }
        salesData[p][id].total += amount;
        salesData[p][id].count += 1;
    });
    saveData();
}

/* =====================================================
   DISCORD EVENTS
   ===================================================== */
client.once('ready', async () => {
    console.log('✅ Bot connected successfully!');
    console.log(`🤖 Bot Tag: ${client.user.tag}`);
    console.log(`🆔 Bot ID: ${client.user.id}`);
    await loadData();
    checkResets();

    cron.schedule('0 */3 * * *', async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (!channel) return;
        await channel.send('📊 **AP Leaderboard running**');
        console.log('📊 Leaderboard sent');
    });
});

client.on('messageCreate', async message => {
    console.log('📩 Message received:', message.content);

    if (message.author.bot) return;

    if (message.channel.id === process.env.SALES_CHANNEL_ID) {
        const sales = parseMultipleSales(message.content);
        for (const s of sales) {
            addSale(message.author.id, message.author.username, s.amount);
            console.log(`💰 Sale recorded: $${s.amount}`);
        }
        if (sales.length) {
            await message.react('✅');
            await message.react('💰');
        }
    }

    if (message.content === '!leaderboard') {
        await message.channel.send('📊 Leaderboard command received');
    }
});

/* =====================================================
   ERROR HANDLING
   ===================================================== */
client.on('error', err => console.error('❌ Discord error:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled:', err));

/* =====================================================
   START BOT
   ===================================================== */
async function start() {
    console.log('⏳ Starting AP tracking system...');
    console.log(`🌐 Server port: ${PORT}`);

    if (!process.env.DISCORD_TOKEN) {
        console.error('❌ DISCORD_TOKEN missing');
        process.exit(1);
    }
console.log(
  '🔑 DISCORD_TOKEN exists:',
  !!process.env.DISCORD_TOKEN,
  'length:',
  process.env.DISCORD_TOKEN?.length
);
    await client.login(process.env.DISCORD_TOKEN);
}

start();
