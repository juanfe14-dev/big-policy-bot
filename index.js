require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');

// ========================================
// CONFIGURACIÓN Y CONSTANTES
// ========================================
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences
    ]
});

let salesData = {
    daily: {},
    weekly: {},
    monthly: {},
    total: {},
    lastReset: { daily: null, weekly: null, monthly: null, weeklyTag: null },
    dailySnapshot: {},
    weeklySnapshot: {},
    monthlySnapshot: {}
};

// ========================================
// SERVIDOR EXPRESS (HEALTH CHECK PARA RENDER)
// ========================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('Bot is running!'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📡 Health check: http://0.0.0.0:${PORT}/health`);
});

// ========================================
// UTILIDADES DE GITHUB API (Sincronización)
// ========================================
function githubApiRequest(path, method, body) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return Promise.reject(new Error('GITHUB_TOKEN no configurado en Render'));

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

async function downloadFromGitHub() {
    try {
        console.log('📥 Intentando recuperar datos desde GitHub (data/sales.json)...');
        const repoPath = `/repos/juanfe14-dev/big-policy-bot/contents/data/sales.json?ref=main`;
        const fileData = await githubApiRequest(repoPath, 'GET');
        
        if (fileData && fileData.content) {
            const content = Buffer.from(fileData.content, 'base64').toString('utf8');
            return JSON.parse(content);
        }
    } catch (error) {
        console.log('ℹ️ Nota: No se pudo bajar de GitHub (puede ser el primer inicio):', error.message);
    }
    return null;
}

// ========================================
// GESTIÓN DE DATOS LOCALES
// ========================================
async function loadData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(BACKUP_DIR, { recursive: true });

        let loaded = false;

        // 1. Intentar local
        try {
            const data = await fs.readFile(DATA_FILE, 'utf8');
            salesData = JSON.parse(data);
            console.log('📂 Datos cargados desde disco local.');
            loaded = true;
        } catch (e) {
            console.log('❓ No hay archivo local.');
        }

        // 2. Intentar GitHub si el local falló o está vacío
        if (!loaded || Object.keys(salesData.total || {}).length === 0) {
            const remoteData = await downloadFromGitHub();
            if (remoteData) {
                salesData = remoteData;
                console.log('✅ Datos recuperados exitosamente desde GitHub.');
                await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
            } else {
                console.log('📝 Iniciando con base de datos nueva.');
            }
        }

        // Asegurar estructura
        salesData.lastReset = salesData.lastReset || {};
        salesData.daily = salesData.daily || {};
        salesData.weekly = salesData.weekly || {};
        salesData.monthly = salesData.monthly || {};
        salesData.total = salesData.total || {};

    } catch (error) {
        console.error('❌ Error en loadData:', error);
    }
}

async function saveData() {
    try {
        const dataStr = JSON.stringify(salesData, null, 2);
        await fs.writeFile(DATA_FILE, dataStr);
        
        // Backup histórico
        const date = new Date().toISOString().split('T')[0];
        await fs.writeFile(path.join(BACKUP_DIR, `sales-${date}.json`), dataStr);
        
        await syncToGitHub();
    } catch (error) {
        console.error('❌ Error al guardar:', error);
    }
}

async function syncToGitHub() {
    try {
        const repoPath = '/repos/juanfe14-dev/big-policy-bot/contents/data/sales.json';
        let sha = null;

        try {
            const currentFile = await githubApiRequest(`${repoPath}?ref=main`, 'GET');
            sha = currentFile.sha;
        } catch (e) {}

        const content = Buffer.from(JSON.stringify(salesData, null, 2)).toString('base64');
        await githubApiRequest(repoPath, 'PUT', {
            message: `Bot Auto-Sync: ${new Date().toISOString()}`,
            content,
            sha,
            branch: 'main'
        });
        console.log('🔄 Sincronizado con GitHub ✅');
    } catch (error) {
        console.error('❌ Error sincronización GitHub:', error.message);
    }
}

// ========================================
// LÓGICA DE RESETS
// ========================================
function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function checkResets() {
    const now = new Date();
    const tz = process.env.TZ || "America/New_York";
    const localTime = new Date(now.toLocaleString("en-US", {timeZone: tz}));
    
    const dayTag = localTime.toDateString();
    const weekNum = getWeekNumber(localTime);
    const year = localTime.getFullYear();
    const weekTag = `${year}-W${weekNum}`;
    const monthTag = `${year}-${localTime.getMonth()}`;

    let changed = false;

    if (salesData.lastReset.daily !== dayTag) {
        console.log('🌅 Reset Diario...');
        salesData.dailySnapshot = JSON.parse(JSON.stringify(salesData.daily));
        salesData.daily = {};
        salesData.lastReset.daily = dayTag;
        changed = true;
    }

    if (salesData.lastReset.weeklyTag !== weekTag) {
        console.log('📅 Reset Semanal...');
        salesData.weeklySnapshot = JSON.parse(JSON.stringify(salesData.weekly));
        salesData.weekly = {};
        salesData.lastReset.weeklyTag = weekTag;
        changed = true;
    }

    if (salesData.lastReset.monthly !== monthTag) {
        console.log('🗓️ Reset Mensual...');
        salesData.monthlySnapshot = JSON.parse(JSON.stringify(salesData.monthly));
        salesData.monthly = {};
        salesData.lastReset.monthly = monthTag;
        changed = true;
    }

    if (changed) saveData();
}

// ========================================
// EVENTOS DISCORD
// ========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== process.env.SALES_CHANNEL_ID) return;

    const apMatch = message.content.match(/(?:AP|Total):\s*\$?([\d,.]+)/i);
    if (!apMatch) return;

    const amount = parseFloat(apMatch[1].replace(/,/g, ''));
    if (isNaN(amount)) return;

    const userId = message.author.id;
    const username = message.author.username;

    const init = (obj) => { if (!obj[userId]) obj[userId] = { total: 0, count: 0, username }; };
    
    [salesData.daily, salesData.weekly, salesData.monthly, salesData.total].forEach(target => {
        init(target);
        target[userId].total += amount;
        target[userId].count += 1;
        target[userId].username = username;
    });

    console.log(`💰 Venta: ${username} $${amount}`);
    try { await message.react('✅'); } catch(e) {}
    saveData();
});

// ========================================
// REPORTES AUTOMÁTICOS (CRON)
// ========================================
cron.schedule('59 23 * * *', () => {
    sendLeaderboard('DAILY REPORT', salesData.daily, process.env.SALES_CHANNEL_ID);
}, { timezone: process.env.TZ || "America/New_York" });

cron.schedule('58 23 * * 0', () => {
    sendLeaderboard('WEEKLY LEADERBOARD', salesData.weekly, process.env.LEADERBOARD_CHANNEL_ID);
}, { timezone: process.env.TZ || "America/New_York" });

async function sendLeaderboard(title, data, channelId) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;

        const sorted = Object.entries(data)
            .sort(([, a], [, b]) => b.total - a.total)
            .slice(0, 10);

        if (sorted.length === 0) return;

        const embed = new EmbedBuilder()
            .setTitle(`🏆 ${title}`)
            .setColor('#00ff00')
            .setTimestamp();

        let desc = sorted.map(([id, s], i) => `**${i+1}. ${s.username}**: $${s.total.toLocaleString()} (${s.count} sales)`).join('\n');
        embed.setDescription(desc);
        await channel.send({ embeds: [embed] });
    } catch (e) { console.error('Error leaderboard:', e); }
}

// ========================================
// ARRANQUE DEL SISTEMA
// ========================================
async function start() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 BIG POLICY PULSE v5.3 🚀       ║');
    console.log('║     Debug & GitHub Recovery Active    ║');
    console.log('╚════════════════════════════════════════╝');

    try {
        await loadData();
        checkResets();

        // VALIDACIÓN DE TOKEN (DEBUG)
        const token = process.env.DISCORD_TOKEN;
        if (!token || token.length < 20) {
            console.error('❌ ERROR: DISCORD_TOKEN no detectado o inválido en Render.');
            return;
        }
        console.log(`🔑 Token detectado (ID): ${token.substring(0, 10)}...`);
        console.log('⏳ Intentando conectar con Discord Gateway...');

        const loginTimeout = setTimeout(() => {
            console.error('⚠️ El login está tardando demasiado. Discord podría estar bloqueando la IP de Render.');
        }, 15000);

        await client.login(token);
        clearTimeout(loginTimeout);

    } catch (error) {
        console.error('❌ ERROR CRÍTICO EN START:', error.message);
        process.exit(1);
    }
}

client.once('ready', () => {
    console.log(`✅ ¡CONECTADO! Logueado como: ${client.user.tag}`);
    console.log(`📊 Datos cargados: ${Object.keys(salesData.total).length} agentes en total.`);
});

client.on('error', e => console.error('Discord Client Error:', e));

start();
