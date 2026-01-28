require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');

// ========================================
// 1. SERVIDOR WEB (PRIORIDAD PARA RENDER)
// ========================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('Bot is active and running!'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor Web activo en puerto ${PORT}`);
    console.log(`📡 Health Check: http://0.0.0.0:${PORT}/health`);
});

// ========================================
// 2. CONFIGURACIÓN DEL BOT (INTENTS SEGUROS)
// ========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');

let salesData = {
    daily: {},
    weekly: {},
    monthly: {},
    total: {},
    lastReset: { daily: null, weeklyTag: null, monthly: null }
};

// ========================================
// 3. UTILIDADES GITHUB (PERSISTENCIA)
// ========================================
async function githubApiRequest(apiPath, method, body) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return Promise.reject(new Error('GITHUB_TOKEN missing'));

    const options = {
        hostname: 'api.github.com',
        path: apiPath,
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

async function syncWithGitHub(mode = 'download') {
    const repoPath = '/repos/juanfe14-dev/big-policy-bot/contents/data/sales.json';
    try {
        if (mode === 'download') {
            console.log('📥 Descargando datos desde GitHub...');
            const file = await githubApiRequest(`${repoPath}?ref=main`, 'GET');
            if (file.content) {
                const content = Buffer.from(file.content, 'base64').toString('utf8');
                salesData = JSON.parse(content);
                console.log('✅ Datos recuperados de GitHub.');
            }
        } else {
            console.log('🔄 Sincronizando cambios a GitHub...');
            let sha = null;
            try {
                const current = await githubApiRequest(`${repoPath}?ref=main`, 'GET');
                sha = current.sha;
            } catch (e) {}

            const content = Buffer.from(JSON.stringify(salesData, null, 2)).toString('base64');
            await githubApiRequest(repoPath, 'PUT', {
                message: `Bot Auto-Update: ${new Date().toISOString()}`,
                content,
                sha,
                branch: 'main'
            });
            console.log('✅ GitHub actualizado.');
        }
    } catch (error) {
        console.error('⚠️ Error en Sincronización:', error.message);
    }
}

// ========================================
// 4. LÓGICA DE VENTAS Y REPORTES
// ========================================
function getWeekTag(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${weekNo}`;
}

async function saveData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
        await syncWithGitHub('upload');
    } catch (e) { console.error('Error guardando:', e); }
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== process.env.SALES_CHANNEL_ID) return;

    const apMatch = message.content.match(/(?:AP|Total):\s*\$?([\d,.]+)/i);
    if (!apMatch) return;

    const amount = parseFloat(apMatch[1].replace(/,/g, ''));
    if (isNaN(amount)) return;

    const userId = message.author.id;
    const username = message.author.username;

    // Inicializar si no existe
    const periods = ['daily', 'weekly', 'monthly', 'total'];
    periods.forEach(p => {
        if (!salesData[p]) salesData[p] = {};
        if (!salesData[p][userId]) {
            salesData[p][userId] = { total: 0, count: 0, username };
        }
        salesData[p][userId].total += amount;
        salesData[p][userId].count += 1;
        salesData[p][userId].username = username;
    });

    console.log(`💰 Venta: ${username} $${amount}`);
    try { await message.react('✅'); } catch (e) {}
    await saveData();
});

// ========================================
// 5. ARRANQUE Y TESTS DE CONEXIÓN
// ========================================
async function start() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 BIG POLICY PULSE v5.3 🚀       ║');
    console.log('║     Modo Resistencia Antbloqueo       ║');
    console.log('╚════════════════════════════════════════╝');

    try {
        // Carga inicial
        await syncWithGitHub('download');

        const token = process.env.DISCORD_TOKEN;
        if (!token) throw new Error('DISCORD_TOKEN no configurado.');

        console.log(`🔑 Token detectado (ID): ${token.substring(0, 10)}...`);

        // TEST DE API (Antes de intentar el Login pesado)
        console.log('🧪 Testeando conexión HTTPS con Discord API...');
        const options = {
            hostname: 'discord.com',
            path: '/api/v10/users/@me',
            headers: { Authorization: `Bot ${token}` }
        };

        https.get(options, (res) => {
            if (res.statusCode === 200) {
                console.log('✅ API alcanzable. Procediendo al Login del bot...');
                client.login(token).catch(err => {
                    console.error('❌ Error en Client Login:', err.message);
                });
            } else {
                console.error(`🚫 Discord rechazó la conexión (Status: ${res.statusCode})`);
                console.log('💡 La IP de Render podría estar bloqueada temporalmente.');
            }
        }).on('error', (e) => {
            console.error('❌ Error de red conectando a Discord:', e.message);
        });

    } catch (error) {
        console.error('❌ ERROR CRÍTICO:', error.message);
    }
}

client.once('ready', () => {
    console.log(`⭐ BOT ONLINE como ${client.user.tag}`);
    console.log('📡 Escuchando ventas...');
});

// Programación de reportes
cron.schedule('59 23 * * *', () => {
    // Aquí iría la función sendLeaderboard
}, { timezone: "America/New_York" });

start();
