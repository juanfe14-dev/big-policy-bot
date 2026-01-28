require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');

// ========================================
// 1. SERVIDOR EXPRESS (Optimizado para Render)
// ========================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => res.status(200).send('<h1>🤖 BIG Policy Bot Online</h1>'));
app.get('/health', (req, res) => res.status(200).json({ status: 'healthy', uptime: Math.floor(process.uptime()) }));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor Web en puerto ${PORT}`);
});

// ========================================
// 2. CONFIGURACIÓN DEL BOT (Añadido Partials para mayor estabilidad)
// ========================================
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel]
});

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');

let salesData = {
    daily: {}, weekly: {}, monthly: {}, allTime: {},
    lastReset: { daily: "", weeklyTag: "", monthlyTag: "" }
};

// ========================================
// 3. NÚCLEO DE PERSISTENCIA GITHUB (Mejorado)
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
            'Content-Type': 'application/json'
        },
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(data ? JSON.parse(data) : {});
                else reject(new Error(`GitHub Error ${res.statusCode}: ${data}`));
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function syncWithGitHub(mode = 'download') {
    if (!process.env.GITHUB_TOKEN) return console.log("⚠️ GitHub Token no configurado");
    const repoPath = '/repos/juanfe14-dev/big-policy-bot/contents/data/sales.json';

    try {
        if (mode === 'download') {
            const file = await githubApiRequest(`${repoPath}?ref=main`, 'GET');
            if (file.content) {
                salesData = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
                console.log('✅ Datos descargados de GitHub.');
            }
        } else {
            let sha = null;
            try {
                const current = await githubApiRequest(`${repoPath}?ref=main`, 'GET');
                sha = current.sha;
            } catch (e) {}

            const content = Buffer.from(JSON.stringify(salesData, null, 2)).toString('base64');
            await githubApiRequest(repoPath, 'PUT', {
                message: `Update sales: ${new Date().toISOString()}`,
                content, sha, branch: 'main'
            });
            console.log('☁️ Sincronizado con GitHub Cloud.');
        }
    } catch (e) { console.error('❌ Error Sync:', e.message); }
}

async function saveData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
        await syncWithGitHub('upload');
    } catch (e) { console.error('❌ Error guardando datos:', e); }
}

// ========================================
// 4. LÓGICA DE RESETS Y TIEMPO
// ========================================
function getWeekTag(date) {
    const firstDay = new Date(date.getFullYear(), 0, 1);
    const pastDays = (date - firstDay) / 86400000;
    const weekNum = Math.ceil((pastDays + firstDay.getDay() + 1) / 7);
    return `${date.getFullYear()}-W${weekNum}`;
}

function checkResets() {
    const now = new Date();
    const pacTime = new Date(now.toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
    
    const today = pacTime.toDateString();
    const weekTag = getWeekTag(pacTime);
    const monthTag = `${pacTime.getFullYear()}-${pacTime.getMonth()}`;

    let changed = false;

    if (salesData.lastReset.daily !== today) {
        salesData.daily = {};
        salesData.lastReset.daily = today;
        changed = true;
    }
    if (salesData.lastReset.weeklyTag !== weekTag && pacTime.getDay() === 1) {
        salesData.weekly = {};
        salesData.lastReset.weeklyTag = weekTag;
        changed = true;
    }
    if (salesData.lastReset.monthlyTag !== monthTag) {
        salesData.monthly = {};
        salesData.lastReset.monthlyTag = monthTag;
        changed = true;
    }

    if (changed) saveData();
}

// ========================================
// 5. PARSEO DE VENTAS Y REPORTES (TU ESTILO ORIGINAL)
// ========================================
function parseSales(text) {
    const pattern = /(?:AP|Total):\s*\$?([\d,.]+)/gi;
    const matches = [...text.matchAll(pattern)];
    return matches.map(m => parseFloat(m[1].replace(/,/g, '')));
}

function generateEmbed(period, title) {
    checkResets();
    const data = salesData[period] || {};
    const sorted = Object.entries(data).sort(([,a], [,b]) => b.total - a.total);
    
    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle(title)
        .setDescription(`💰 **Ranked by Annual Premium (AP)**\n━━━━━━━━━━━━━━━━━━━━━`)
        .setTimestamp()
        .setFooter({ text: '💼 BIG - Annual Premium Rankings' });

    if (sorted.length === 0) {
        embed.addFields({ name: '📝 Sin Registros', value: 'No hay ventas en este periodo.' });
    } else {
        let top3Text = "";
        sorted.slice(0, 3).forEach(([id, u], i) => {
            const medal = i === 0 ? '🥇 **AP LEADER**' : i === 1 ? '🥈 **2nd Place**' : '🥉 **3rd Place**';
            top3Text += `${medal}\n👤 **${u.username}**\n💵 **$${u.total.toLocaleString()} AP**\n📊 *${u.count} pólizas*\n\n`;
        });
        embed.addFields({ name: '🌟 TOP AP PRODUCERS', value: top3Text });

        if (sorted.length > 3) {
            let others = sorted.slice(3, 10).map(([id, u], i) => `**${i+4}.** ${u.username} - $${u.total.toLocaleString()} (${u.count})`).join('\n');
            embed.addFields({ name: '📈 Otros Agentes', value: others });
        }

        const totalAP = Object.values(data).reduce((s, u) => s + u.total, 0);
        const totalPol = Object.values(data).reduce((s, u) => s + u.count, 0);
        embed.addFields({ name: '💼 AP SUMMARY', value: `**Total AP:** $${totalAP.toLocaleString()}\n**Promedio:** $${(totalAP/(totalPol||1)).toFixed(2)}\n**Total Pólizas:** ${totalPol}` });
    }
    return embed;
}

// ========================================
// 6. EVENTOS DE DISCORD
// ========================================
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    // Comandos
    if (msg.content.startsWith('!')) {
        const cmd = msg.content.toLowerCase();
        if (cmd.includes('leaderboard') || cmd.includes('lb')) {
            const period = cmd.includes('weekly') ? 'weekly' : (cmd.includes('monthly') ? 'monthly' : 'daily');
            return msg.channel.send({ embeds: [generateEmbed(period, `💵 ${period.toUpperCase()} LEADERBOARD`)] });
        }
        if (cmd === '!ping') return msg.reply('🏓 Pong! Bot activo y sincronizado.');
        if (cmd === '!sync' && msg.member.permissions.has('Administrator')) {
            await syncWithGitHub('upload');
            return msg.reply('✅ Sincronización manual completada.');
        }
    }

    // Escucha de Ventas (Con tus reacciones originales)
    if (msg.channel.id === process.env.SALES_CHANNEL_ID) {
        const amounts = parseSales(msg.content);
        if (amounts.length > 0) {
            let totalMsg = 0;
            amounts.forEach(amt => {
                totalMsg += amt;
                ['daily', 'weekly', 'monthly', 'allTime'].forEach(p => {
                    if (!salesData[p][msg.author.id]) salesData[p][msg.author.id] = { total: 0, count: 0, username: msg.author.username };
                    salesData[p][msg.author.id].total += amt;
                    salesData[p][msg.author.id].count += 1;
                });
            });

            // REACCIONES ORIGINALES
            try {
                await msg.react('✅');
                await msg.react('💰');
                if (totalMsg >= 1000) await msg.react('🔥');
                if (totalMsg >= 5000) await msg.react('🚀');
            } catch (e) {}
            
            await saveData();
        }
    }
});

client.once('ready', async () => {
    console.log(`⭐ Bot listo como ${client.user.tag}`);
    await syncWithGitHub('download');
    checkResets();
});

// Auto-Sync cada 3 horas
cron.schedule('0 */3 * * *', () => syncWithGitHub('upload'));

client.login(process.env.DISCORD_TOKEN);
