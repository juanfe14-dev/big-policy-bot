require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');

/* ===========================
   GITHUB API
=========================== */
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
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data ? JSON.parse(data) : {});
                } else {
                    reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }

        req.end();
    });
}

/* ===========================
   DISCORD CLIENT
=========================== */
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

/* ===========================
   EXPRESS SERVER (RENDER)
=========================== */
const app = express();
const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📡 Health check available at http://0.0.0.0:${PORT}/health`);
});

app.get('/', (req, res) => {
    res.send(`
        <h1>🤖 BIG Policy Bot</h1>
        <p>Status: Online</p>
        <p>Uptime: ${Math.floor(process.uptime())}s</p>
        <p>Time: ${new Date().toISOString()}</p>
    `);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        bot_connected: !!client.user,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

/* ===========================
   DATA CONFIG
=========================== */
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
    lastReset: {
        daily: null,
        weekly: null,
        monthly: null
    }
};

/* ===========================
   DATA HELPERS
=========================== */
async function loadData() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        salesData = JSON.parse(data);
        console.log(`📂 Data loaded successfully from: ${DATA_FILE}`);
        console.log(`📊 Current data: ${Object.keys(salesData.daily).length} daily, ${Object.keys(salesData.weekly).length} weekly, ${Object.keys(salesData.monthly).length} monthly agents`);
    } catch (err) {
        console.log('⚠️ No existing data found, starting fresh');
    }
}

async function saveData() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
    console.log(`💾 Data saved to: ${DATA_FILE}`);
}

/* ===========================
   SALES LOGIC
=========================== */
function addSale(userId, username, amount, policyType) {
    const keys = ['daily', 'weekly', 'monthly', 'allTime'];

    keys.forEach(key => {
        if (!salesData[key][userId]) {
            salesData[key][userId] = {
                username,
                total: 0,
                count: 0
            };
        }

        salesData[key][userId].total += amount;
        salesData[key][userId].count += 1;
    });

    console.log(`💰 Sale recorded: ${username} - $${amount} AP - ${policyType}`);
    saveData();
}

function parseMultipleSales(content) {
    const regex = /\$([\d,]+(?:\.\d{1,2})?)\s*-\s*(.+)/gi;
    const sales = [];
    let match;

    while ((match = regex.exec(content)) !== null) {
        const amount = parseFloat(match[1].replace(/,/g, ''));
        const policyType = match[2].trim();
        sales.push({ amount, policyType });
    }

    if (sales.length) {
        console.log(`💬 Parsed ${sales.length} sale(s) from message:`);
        sales.forEach((s, i) =>
            console.log(`   Sale ${i + 1}: $${s.amount} - "${s.policyType}"`)
        );
    }

    return sales;
}

/* ===========================
   LEADERBOARD
=========================== */
function buildLeaderboardEmbed(title, data) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor('#00ff99')
        .setTimestamp();

    const sorted = Object.values(data)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

    if (!sorted.length) {
        embed.setDescription('No sales recorded.');
        return embed;
    }

    embed.setDescription(
        sorted.map((u, i) =>
            `**${i + 1}. ${u.username}** — $${u.total.toFixed(2)} (${u.count})`
        ).join('\n')
    );

    return embed;
}

/* ===========================
   RESET LOGIC
=========================== */
function checkResets() {
    const now = new Date();

    const today = now.toDateString();
    if (salesData.lastReset.daily !== today) {
        salesData.daily = {};
        salesData.lastReset.daily = today;
        console.log('🔄 Daily reset');
    }

    const week = `${now.getFullYear()}-W${Math.ceil(now.getDate() / 7)}`;
    if (salesData.lastReset.weekly !== week) {
        salesData.weekly = {};
        salesData.lastReset.weekly = week;
        console.log('🔄 Weekly reset');
    }

    const month = `${now.getFullYear()}-${now.getMonth()}`;
    if (salesData.lastReset.monthly !== month) {
        salesData.monthly = {};
        salesData.lastReset.monthly = month;
        console.log('🔄 Monthly reset');
    }

    saveData();
}

/* ===========================
   BOT READY
=========================== */
client.once('ready', async () => {
    console.log('\n✅ Bot connected successfully!');
    console.log(`🤖 Bot Tag: ${client.user.tag}`);
    console.log(`🆔 Bot ID: ${client.user.id}`);
    console.log(`📅 Connected at: ${new Date().toLocaleString()}`);

    checkResets();

    cron.schedule('0 12 * * *', async () => {
        const channel = await client.channels.fetch(process.env.LEADERBOARD_CHANNEL_ID);
        await channel.send({ embeds: [buildLeaderboardEmbed('📊 Daily Leaderboard', salesData.daily)] });
        console.log('📊 AP leaderboard posted - 12:00 Pacific');
    }, { timezone: 'America/Los_Angeles' });

    /* ======== 🔧 FIX CRÍTICO ======== */
    setInterval(() => {
        console.log(`💓 Heartbeat OK - ${new Date().toISOString()}`);
    }, 300000);
});

/* ===========================
   MESSAGE LISTENER
=========================== */
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    if (message.channel.id === process.env.SALES_CHANNEL_ID) {
        const sales = parseMultipleSales(message.content);
        if (sales.length) {
            let total = 0;
            for (const sale of sales) {
                addSale(message.author.id, message.author.username, sale.amount, sale.policyType);
                total += sale.amount;
            }
            if (total > 0) {
                await message.react('✅');
                await message.react('💰');
            }
        }
    }

    if (message.content === '!ping') {
        await message.reply('🏓 Pong!');
    }
});

/* ======== 🔧 FIX CRÍTICO ======== */
console.log('👂 Sale message listener attached');

/* ===========================
   ERROR HANDLING
=========================== */
client.on('error', console.error);
process.on('unhandledRejection', console.error);

/* ===========================
   START
=========================== */
(async () => {
    await loadData();
    await client.login(process.env.DISCORD_TOKEN);
})();
