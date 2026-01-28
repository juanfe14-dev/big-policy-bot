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
// SERVIDOR EXPRESS (HEALTH CHECK)
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
// UTILIDADES DE GITHUB API
// ========================================
function githubApiRequest(path, method, body) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return Promise.reject(new Error('GITHUB_TOKEN not set'));

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
        // Ruta exacta en tu repo
        const fileData = await githubApiRequest(
            '/repos/juanfe14-dev/big-policy-bot/contents/data/sales.json?ref=main',
            'GET'
        );
        if (fileData && fileData.content) {
            const content = Buffer.from(fileData.content, 'base64').toString('utf8');
            return JSON.parse(content);
        }
    } catch (error) {
        console.log('ℹ️ No se encontraron datos previos en GitHub o error en descarga:', error.message);
    }
    return null;
}

// ========================================
// GESTIÓN DE DATOS (LOCAL Y REMOTO)
// ========================================
async function loadData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(BACKUP_DIR, { recursive: true });

        let loaded = false;

        // 1. Intentar cargar localmente primero
        try {
            const data = await fs.readFile(DATA_FILE, 'utf8');
            salesData = JSON.parse(data);
            console.log('📂 Datos cargados desde disco local.');
            loaded = true;
        } catch (e) {
            console.log('❓ No hay archivo local (esto es normal en el primer despliegue de Render).');
        }

        // 2. Si no cargó local o está vacío, intentar de GitHub
        if (!loaded || Object.keys(salesData.total || {}).length === 0) {
            const remoteData = await downloadFromGitHub();
            if (remoteData) {
                salesData = remoteData;
                console.log('✅ Datos recuperados exitosamente desde GitHub.');
                await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
            } else {
                console.log('📝 No hay datos locales ni remotos. Iniciando base de datos nueva.');
            }
        }

        // Asegurar que existan los objetos básicos
        if (!salesData.lastReset) salesData.lastReset = {};
        if (!salesData.daily) salesData.daily = {};
        if (!salesData.weekly) salesData.weekly = {};
        if (!salesData.monthly) salesData.monthly = {};
        if (!salesData.total) salesData.total = {};

        console.log(`📊 Datos actuales: ${Object.keys(salesData.daily).length} daily, ${Object.keys(salesData.weekly).length} weekly, ${Object.keys(salesData.monthly).length} monthly agents`);

    } catch (error) {
        console.error('❌ Error crítico en loadData:', error);
    }
}

async function saveData() {
    try {
        const dataStr = JSON.stringify(salesData, null, 2);
        await fs.writeFile(DATA_FILE, dataStr);

        // Backup diario local
        const date = new Date().toISOString().split('T')[0];
        await fs.writeFile(path.join(BACKUP_DIR, `sales-${date}.json`), dataStr);
        
        // Sincronizar a GitHub
        await syncToGitHub();
    } catch (error) {
        console.error('❌ Error saving data:', error);
    }
}

async function syncToGitHub() {
    try {
        console.log('🔄 Sincronizando con GitHub...');
        const repoPath = '/repos/juanfe14-dev/big-policy-bot/contents/data/sales.json';
        let sha = null;

        try {
            const currentFile = await githubApiRequest(`${repoPath}?ref=main`, 'GET');
            sha = currentFile.sha;
        } catch (e) { /* Archivo nuevo */ }

        const content = Buffer.from(JSON.stringify(salesData, null, 2)).toString('base64');
        await githubApiRequest(repoPath, 'PUT', {
            message: `Update sales data - ${new Date().toISOString()}`,
            content,
            sha,
            branch: 'main'
        });
        console.log('✅ Sincronización exitosa.');
    } catch (error) {
        console.error('❌ Error sincronizando GitHub:', error.message);
    }
}

// ========================================
// LÓGICA DE RESETS (MEJORADA)
// ========================================
function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function checkResets() {
    const now = new Date();
    // Ajuste a tu zona horaria (TZ en Render)
    const pacificTime = new Date(now.toLocaleString("en-US", {timeZone: process.env.TZ || "America/New_York"}));
    
    const currentDay = pacificTime.toDateString();
    const currentWeek = getWeekNumber(pacificTime);
    const currentMonth = pacificTime.getMonth();
    const currentYear = pacificTime.getFullYear();
    const currentWeekTag = `${currentYear}-W${currentWeek}`;

    let changed = false;

    // Reset Diario
    if (salesData.lastReset.daily !== currentDay) {
        console.log('🌅 Ejecutando Reset Diario...');
        salesData.dailySnapshot = JSON.parse(JSON.stringify(salesData.daily || {}));
        salesData.daily = {};
        salesData.lastReset.daily = currentDay;
        changed = true;
    }

    // Reset Semanal (Basado en número de semana, no solo en lunes)
    if (salesData.lastReset.weeklyTag !== currentWeekTag) {
        console.log('📅 Ejecutando Reset Semanal...');
        salesData.weeklySnapshot = JSON.parse(JSON.stringify(salesData.weekly || {}));
        salesData.weekly = {};
        salesData.lastReset.weeklyTag = currentWeekTag;
        salesData.lastReset.weekly = currentWeek;
        changed = true;
    }

    // Reset Mensual
    const monthTag = `${currentYear}-${currentMonth}`;
    if (salesData.lastReset.monthly !== monthTag) {
        console.log('🗓️ Ejecutando Reset Mensual...');
        salesData.monthlySnapshot = JSON.parse(JSON.stringify(salesData.monthly || {}));
        salesData.monthly = {};
        salesData.lastReset.monthly = monthTag;
        changed = true;
    }

    if (changed) saveData();
}

// ========================================
// EVENTOS DE DISCORD
// ========================================
client.on('messageCreate', async (message) => {
    // Ignorar bots y mensajes fuera del canal de ventas
    if (message.author.bot) return;
    if (message.channel.id !== process.env.SALES_CHANNEL_ID) return;

    // Regex para detectar ventas (AP o TOTAL)
    const apMatch = message.content.match(/(?:AP|Total):\s*\$?([\d,.]+)/i);
    if (!apMatch) return;

    const amount = parseFloat(apMatch[1].replace(/,/g, ''));
    if (isNaN(amount)) return;

    const userId = message.author.id;
    const username = message.author.username;

    // Inicializar usuario si no existe
    const initUser = (target) => {
        if (!target[userId]) target[userId] = { total: 0, count: 0, username };
    };

    [salesData.daily, salesData.weekly, salesData.monthly, salesData.total].forEach(initUser);

    // Sumar venta
    [salesData.daily, salesData.weekly, salesData.monthly, salesData.total].forEach(target => {
        target[userId].total += amount;
        target[userId].count += 1;
        target[userId].username = username;
    });

    console.log(`💰 Venta registrada: ${username} - $${amount}`);
    
    // Reaccionar para confirmar
    try { await message.react('✅'); } catch (e) {}
    
    // Guardar (esto también sube a GitHub)
    saveData();
});

// ========================================
// CRON JOBS (REPORTES)
// ========================================
// Informe diario a las 11:59 PM
cron.schedule('59 23 * * *', () => {
    sendLeaderboard('DAILY REPORT', salesData.daily, process.env.SALES_CHANNEL_ID);
}, { timezone: process.env.TZ || "America/New_York" });

// Informe semanal los domingos a las 11:58 PM
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
            .setColor('#FFD700')
            .setTimestamp();

        let description = "";
        sorted.forEach(([id, stats], index) => {
            description += `**${index + 1}. ${stats.username}**: $${stats.total.toLocaleString()} (${stats.count} sales)\n`;
        });
        
        embed.setDescription(description);
        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('❌ Error enviando leaderboard:', error);
    }
}

// ========================================
// INICIO DEL BOT
// ========================================
async function start() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 BIG POLICY PULSE v5.2 🚀       ║');
    console.log('║     Recuperación GitHub Activa        ║');
    console.log('╚════════════════════════════════════════╝');

    try {
        // 1. Cargar Datos
        await loadData();
        
        // 2. Ejecutar chequeo de resets antes de arrancar
        checkResets();

        // 3. Login con Discord
        console.log('⏳ Intentando conectar con Discord...');
        
        const loginTimeout = setTimeout(() => {
            console.error('⚠️ El login está tardando más de lo normal. Revisa el Token o posible baneo de IP en Render.');
        }, 15000);

        await client.login(process.env.DISCORD_TOKEN);
        clearTimeout(loginTimeout);

    } catch (error) {
        console.error('❌ ERROR CRÍTICO AL INICIAR:', error);
        process.exit(1); // Forzar reinicio de Render
    }
}

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📡 Bot listo para procesar ventas en el canal: ${process.env.SALES_CHANNEL_ID}`);
    
    // Sincronización cada 3 horas por seguridad
    cron.schedule('0 */3 * * *', () => {
        console.log('⏰ Sincronización periódica de respaldo...');
        saveData();
    });
});

// Manejo de errores globales
client.on('error', e => console.error('Discord Client Error:', e));
process.on('unhandledRejection', e => console.error('Unhandled Promise:', e));

start();
