require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');

// ========================================
// 1. SERVIDOR WEB (Keep-Alive para Render)
// ========================================
const app = express();
app.get('/', (req, res) => res.send('🤖 BIG Pulse Pro v6.0 Online'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(process.env.PORT || 10000, '0.0.0.0');

// ========================================
// 2. CONFIGURACIÓN DEL CLIENTE
// ========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');
let salesData = { daily: {}, weekly: {}, monthly: {}, allTime: {}, lastReset: {} };

// ========================================
// 3. PERSISTENCIA EN GITHUB CLOUD
// ========================================
async function githubApiRequest(apiPath, method, body) {
    const token = process.env.GITHUB_TOKEN;
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
            res.on('end', () => resolve(data ? JSON.parse(data) : {}));
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function syncWithGitHub(mode = 'download') {
    const repoPath = `/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/contents/data/sales.json`;
    try {
        if (mode === 'download') {
            const file = await githubApiRequest(`${repoPath}?ref=main`, 'GET');
            if (file.content) {
                salesData = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
                console.log('✅ Datos cargados desde GitHub.');
            }
        } else {
            let sha = null;
            try {
                const current = await githubApiRequest(`${repoPath}?ref=main`, 'GET');
                sha = current.sha;
            } catch (e) {}
            const content = Buffer.from(JSON.stringify(salesData, null, 2)).toString('base64');
            await githubApiRequest(repoPath, 'PUT', {
                message: `Update: ${new Date().toISOString()}`,
                content, sha, branch: 'main'
            });
        }
    } catch (e) { console.error('Error Sync GitHub:', e.message); }
}

// ========================================
// 4. MOTOR DE BÚSQUEDA DE VENTAS (V5.1)
// ========================================
function parseSales(text) {
    // Detecta montos con $ y decimales (ej: $2,222.52)
    const moneyRegex = /\$?([\d,]+\.\d{2})/g;
    const matches = [...text.matchAll(moneyRegex)];
    return matches.map(m => parseFloat(m[1].replace(/,/g, '')));
}

function generateReport(period, title) {
    const data = salesData[period] || {};
    const sorted = Object.values(data).sort((a, b) => b.total - a.total);
    
    const embed = new EmbedBuilder()
        .setColor(period === 'monthly' ? 0xffd700 : 0x2ecc71)
        .setTitle(`🏆 ${title}`)
        .setDescription(`Ranked by Annual Premium (AP)\n━━━━━━━━━━━━━━━━━━━━━`)
        .setTimestamp();

    if (sorted.length === 0) {
        embed.addFields({ name: 'Sin registros', value: 'No hay ventas en este periodo.' });
    } else {
        let list = "";
        sorted.forEach((u, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
            list += `${medal} **${u.username}**: $${u.total.toLocaleString()} (${u.count} pols)\n`;
        });
        embed.addFields({ name: 'AGENT RANKINGS', value: list });

        const totalAP = sorted.reduce((acc, curr) => acc + curr.total, 0);
        const totalPols = sorted.reduce((acc, curr) => acc + curr.count, 0);
        embed.addFields({ name: '📊 TOTALES DEL PERIODO', value: `**AP:** $${totalAP.toLocaleString()}\n**Pólizas:** ${totalPols}` });
    }
    return embed;
}

// ========================================
// 5. ESCUCHA DE VENTAS Y COMANDOS
// ========================================
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    // Comandos manuales
    if (msg.content === '!ping') return msg.reply('🚀 Sistema Operativo.');
    if (msg.content === '!lb') return msg.reply({ embeds: [generateReport('daily', 'DAILY LEADERBOARD')] });
    if (msg.content === '!weekly') return msg.reply({ embeds: [generateReport('weekly', 'WEEKLY RANKING')] });

    // Captura en el canal de ventas
    if (msg.channel.id === process.env.SALES_CHANNEL_ID) {
        const amounts = parseSales(msg.content);
        if (amounts.length > 0) {
            let totalInMsg = 0;
            amounts.forEach(amt => {
                totalInMsg += amt;
                ['daily', 'weekly', 'monthly', 'allTime'].forEach(p => {
                    if (!salesData[p][msg.author.id]) {
                        salesData[p][msg.author.id] = { total: 0, count: 0, username: msg.author.username };
                    }
                    salesData[p][msg.author.id].total += amt;
                    salesData[p][msg.author.id].count += 1;
                    salesData[p][msg.author.id].username = msg.author.username;
                });
            });

            try {
                await msg.react('✅');
                await msg.react('💰');
                if (totalInMsg > 2000) await msg.react('🔥');
            } catch (e) {}

            // Guardar local y en la nube
            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
            await syncWithGitHub('upload');
        }
    }
});

// ========================================
// 6. AUTOMATIZACIÓN DE REPORTES (CRON)
// ========================================

// REPORTES DIARIOS (9am, 12pm, 3pm, 6pm, 9pm Pacific Time)
const dailySchedules = ['0 9 * * *', '0 12 * * *', '0 15 * * *', '0 18 * * *', '0 21 * * *'];
dailySchedules.forEach(sched => {
    cron.schedule(sched, () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) channel.send({ embeds: [generateReport('daily', 'DAILY UPDATE')] });
    }, { timezone: "America/Los_Angeles" });
});

// REPORTE SEMANAL (Domingos 11 PM)
cron.schedule('0 23 * * 0', () => {
    const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
    if (channel) channel.send({ embeds: [generateReport('weekly', '🏆 FINAL WEEKLY SUMMARY')] });
}, { timezone: "America/Los_Angeles" });

// REPORTE MENSUAL (Último día del mes 11:30 PM)
cron.schedule('30 23 28-31 * *', () => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    
    if (tomorrow.getDate() === 1) { // Verifica si hoy es el último día
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) channel.send({ embeds: [generateReport('monthly', '👑 FINAL MONTHLY CHAMPIONS')] });
    }
}, { timezone: "America/Los_Angeles" });

client.once('ready', async () => {
    await syncWithGitHub('download');
    console.log(`⭐ Bot iniciado como ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
