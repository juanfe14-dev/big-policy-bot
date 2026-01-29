require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');

// ========================================
// 1. SERVIDOR WEB (Para Render)
// ========================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('🤖 BIG Pulse Online'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Servidor activo en puerto ${PORT}`));

// ========================================
// 2. CONFIGURACIÓN DEL BOT
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
// 3. PERSISTENCIA GITHUB
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
                console.log('✅ Datos sincronizados desde GitHub.');
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
    } catch (e) { console.error('❌ Error en Sync GitHub:', e.message); }
}

// ========================================
// 4. LÓGICA DE PROCESAMIENTO (MOTOR V5.1)
// ========================================
function parseSales(text) {
    // Regex avanzada para capturar montos con emojis y símbolos
    const moneyRegex = /\$?([\d,]+\.\d{2})/g;
    const matches = [...text.matchAll(moneyRegex)];
    return matches.map(m => parseFloat(m[1].replace(/,/g, '')));
}

function generateReport(period, title) {
    const data = salesData[period] || {};
    const sorted = Object.values(data).sort((a, b) => b.total - a.total);
    
    if (sorted.length === 0) return "No hay datos para este periodo.";

    let totalAP = 0;
    let totalPols = 0;
    const dateStr = new Date().toLocaleDateString('en-US');

    let report = `🏆 **${title}** 🏆\n`;
    report += `Ranked by Annual Premium (AP) Date: ${dateStr}\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━\n`;
    report += `**TOP AP PRODUCERS**\n\n`;

    sorted.forEach((u, i) => {
        totalAP += u.total;
        totalPols += u.count;
        const medal = i === 0 ? '🥇 **AP LEADER**' : i === 1 ? '🥈 **2nd Place**' : i === 2 ? '🥉 **3rd Place**' : `${i+1}.`;
        report += `${medal} ${u.username} $${u.total.toLocaleString()} AP (${u.count} policies)\n`;
    });

    report += `\n**AP SUMMARY**\n`;
    report += `Total AP: $${totalAP.toLocaleString()}\n`;
    report += `Average AP: $${(totalAP / (sorted.length || 1)).toLocaleString()}\n`;
    report += `Total Policies: ${totalPols}\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━\n`;
    report += `💼 BIG - Annual Premium Rankings`;

    return report;
}

// ========================================
// 5. EVENTOS Y COMANDOS
// ========================================
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    // COMANDOS DE CONSULTA
    if (msg.content.toLowerCase() === '!ping') return msg.reply('🚀 Bot Activo y capturando ventas.');
    if (msg.content.toLowerCase() === '!leaderboard') return msg.reply(generateReport('daily', 'DAILY LEADERBOARD'));
    if (msg.content.toLowerCase() === '!weekly') return msg.reply(generateReport('weekly', 'WEEKLY CHAMPIONS'));

    // CAPTURA DE VENTAS EN CANAL ESPECÍFICO
    if (msg.channel.id === process.env.SALES_CHANNEL_ID) {
        const amounts = parseSales(msg.content);

        if (amounts.length > 0) {
            let totalMsg = 0;
            amounts.forEach(amt => {
                totalMsg += amt;
                ['daily', 'weekly', 'monthly', 'allTime'].forEach(p => {
                    if (!salesData[p]) salesData[p] = {};
                    if (!salesData[p][msg.author.id]) {
                        salesData[p][msg.author.id] = { total: 0, count: 0, username: msg.author.username };
                    }
                    salesData[p][msg.author.id].total += amt;
                    salesData[p][msg.author.id].count += 1;
                    salesData[p][msg.author.id].username = msg.author.username;
                });
            });

            // REACCIONES
            try {
                await msg.react('✅');
                await msg.react('💰');
                if (totalMsg > 2000) await msg.react('🔥');
            } catch (e) {}

            // GUARDADO Y SYNC
            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
            await syncWithGitHub('upload');
            console.log(`💰 Registrada venta de ${msg.author.username}: $${totalMsg} (${amounts.length} pólizas)`);
        }
    }
});

// ========================================
// 6. AUTOMATIZACIÓN (POSTEO DE LEADERBOARDS)
// ========================================
// Publicar en canal de leaderboard a las 9 PM cada noche
cron.schedule('0 21 * * *', () => {
    const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
    if (channel) {
        channel.send(generateReport('daily', 'DAILY FINAL RANKINGS'));
    }
}, { timezone: "America/Los_Angeles" });

client.once('ready', async () => {
    console.log(`⭐ Bot Online como ${client.user.tag}`);
    await syncWithGitHub('download');
});

client.login(process.env.DISCORD_TOKEN);
