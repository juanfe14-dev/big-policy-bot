require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');

const app = express();
app.get('/', (req, res) => res.send('🤖 BIG Pulse Pro v7.7 Online'));
app.listen(process.env.PORT || 10000, '0.0.0.0');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');
let salesData = { daily: {}, weekly: {}, monthly: {}, allTime: {}, lastReset: {} };

// ========================================
// PERSISTENCIA GITHUB
// ========================================
async function githubApiRequest(apiPath, method, body) {
    const token = process.env.GITHUB_TOKEN;
    const options = {
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: { 'User-Agent': 'big-bot', 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
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
                console.log('✅ Data sincronizada desde GitHub.');
            }
        } else {
            let sha = null;
            try { const current = await githubApiRequest(`${repoPath}?ref=main`, 'GET'); sha = current.sha; } catch (e) {}
            const content = Buffer.from(JSON.stringify(salesData, null, 2)).toString('base64');
            await githubApiRequest(repoPath, 'PUT', { message: `Update: ${new Date().toISOString()}`, content, sha, branch: 'main' });
        }
    } catch (e) { console.error('Sync Error:', e.message); }
}

// ========================================
// LÓGICA DE RESET Y TIEMPO
// ========================================
function checkResets() {
    const now = new Date();
    const todayTag = now.toLocaleDateString('en-US'); 
    const weekTag = `${now.getFullYear()}-W${getWeekNumber(now)}`;
    const monthTag = `${now.getFullYear()}-${now.getMonth()}`;

    let changed = false;
    if (salesData.lastReset.daily !== todayTag) { salesData.daily = {}; salesData.lastReset.daily = todayTag; changed = true; }
    if (salesData.lastReset.weeklyTag !== weekTag) { salesData.weekly = {}; salesData.lastReset.weeklyTag = weekTag; changed = true; }
    if (salesData.lastReset.monthlyTag !== monthTag) { salesData.monthly = {}; salesData.lastReset.monthlyTag = monthTag; changed = true; }
    return changed;
}

function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ========================================
// GENERADOR DE REPORTES
// ========================================
function generateEmbed(period) {
    checkResets();
    const data = salesData[period] || {};
    const sorted = Object.values(data).sort((a, b) => b.total - a.total);
    const dateStr = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    let title = period === 'daily' ? "💵 DAILY LEADERBOARD" : period === 'weekly' ? "💵 WEEKLY CHAMPIONS" : "💵 MONTHLY CHAMPIONS";
    let color = period === 'daily' ? 0x00FF00 : period === 'weekly' ? 0x0000FF : 0xFFA500;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(`💰 **Ranked by Annual Premium (AP)**\n📍 Date: ${dateStr}, ${timeStr}\n------------------------------------------`)
        .setFooter({ text: `💼 BIG - Annual Premium Rankings • ${dateStr}` });

    if (sorted.length === 0) {
        embed.addFields({ name: '\u200B', value: '*No sales recorded yet for this period.*' });
    } else {
        let top3Text = "";
        sorted.slice(0, 3).forEach((u, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
            top3Text += `${medal} **${u.username}**\n💵 **$${u.total.toLocaleString(undefined, {minimumFractionDigits: 2})} AP**\n📊 *${u.count} policies*\n\n`;
        });
        embed.addFields({ name: '🌟 TOP PRODUCERS', value: top3Text });

        if (sorted.length > 3) {
            let othersText = "";
            sorted.slice(3, 10).forEach((u, i) => {
                othersText += `**${i + 4}.** ${u.username} - **$${u.total.toLocaleString(undefined, {minimumFractionDigits: 2})}**\n`;
            });
            embed.addFields({ name: '📈 Top 10', value: othersText });
        }

        const totalAP = sorted.reduce((acc, curr) => acc + curr.total, 0);
        embed.addFields({ name: '💼 SUMMARY', value: `**Total AP:** $${totalAP.toLocaleString(undefined, {minimumFractionDigits: 2})}\n**Total Policies:** ${sorted.reduce((acc, curr) => acc + curr.count, 0)}` });
    }
    return embed;
}

// ========================================
// MANEJO DE MENSAJES Y COMANDOS
// ========================================
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    if (msg.content === '!ping') return msg.reply('🚀 BIG Pulse Pro Online.');
    if (msg.content === '!lb') return msg.reply({ embeds: [generateEmbed('daily')] });
    if (msg.content === '!weekly') return msg.reply({ embeds: [generateEmbed('weekly')] });
    if (msg.content === '!monthly') return msg.reply({ embeds: [generateEmbed('monthly')] });

    if (msg.channel.id === process.env.SALES_CHANNEL_ID) {
        const moneyRegex = /\$?([\d,]+\.\d{2})/g;
        const matches = [...msg.content.matchAll(moneyRegex)];
        const amounts = matches.map(m => parseFloat(m[1].replace(/,/g, '')));

        if (amounts.length > 0) {
            await syncWithGitHub('download'); // Asegurar data antes de sumar
            checkResets(); 
            amounts.forEach(amt => {
                ['daily', 'weekly', 'monthly', 'allTime'].forEach(p => {
                    if (!salesData[p]) salesData[p] = {};
                    if (!salesData[p][msg.author.id]) salesData[p][msg.author.id] = { total: 0, count: 0, username: msg.author.username };
                    salesData[p][msg.author.id].total = parseFloat((salesData[p][msg.author.id].total + amt).toFixed(2));
                    salesData[p][msg.author.id].count += 1;
                    salesData[p][msg.author.id].username = msg.author.username;
                });
            });
            await msg.react('✅');
            await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
            await syncWithGitHub('upload');
        }
    }
});

// ========================================
// CRON JOBS CON RECARGA DE SEGURIDAD
// ========================================
cron.schedule('0 9,12,15,18,21 * * *', async () => {
    await syncWithGitHub('download');
    const ch = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
    if (ch) ch.send({ embeds: [generateEmbed('daily')] });
}, { timezone: "America/Los_Angeles" });

client.once('ready', async () => {
    await syncWithGitHub('download');
    checkResets();
    console.log(`⭐ Bot active: ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
