require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');

// ========================================
// 1. WEB SERVER (Render Keep-Alive)
// ========================================
const app = express();
app.get('/', (req, res) => res.send('🤖 BIG Pulse Pro v7.0 Online'));
app.listen(process.env.PORT || 10000, '0.0.0.0');

// ========================================
// 2. BOT CONFIGURATION
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
let salesData = { daily: {}, weekly: {}, monthly: {}, allTime: {} };

// ========================================
// 3. GITHUB CLOUD PERSISTENCE
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
                console.log('✅ Data synced from GitHub.');
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
    } catch (e) { console.error('❌ GitHub Sync Error:', e.message); }
}

// ========================================
// 4. SALES PARSING ENGINE
// ========================================
function parseSales(text) {
    const moneyRegex = /\$?([\d,]+\.\d{2})/g;
    const matches = [...text.matchAll(moneyRegex)];
    return matches.map(m => parseFloat(m[1].replace(/,/g, '')));
}

// ========================================
// 5. EMBED GENERATOR (EXACT VISUAL MATCH)
// ========================================
function generateEmbed(period) {
    const data = salesData[period] || {};
    const sorted = Object.values(data).sort((a, b) => b.total - a.total);
    const dateStr = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    let title = "";
    let color = 0x00FF00; // Default Green

    if (period === 'daily') {
        title = "💵 DAILY LEADERBOARD";
        color = 0x00FF00;
    } else if (period === 'weekly') {
        title = "💵 WEEKLY CHAMPIONS - COMPLETE WEEK";
        color = 0x0000FF;
    } else if (period === 'monthly') {
        title = "💵 MONTHLY CHAMPIONS - COMPLETE MONTH";
        color = 0xFFA500;
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: title, iconURL: 'https://i.imgur.com/8N4N8N8.png' }) // Opcional: icono de dinero
        .setDescription(`💰 **Ranked by Annual Premium (AP)**\n📍 Date: ${dateStr}, ${timeStr}\n------------------------------------------`)
        .setFooter({ text: `💼 BIG - Annual Premium Rankings • ${dateStr}, ${timeStr}` });

    if (sorted.length === 0) {
        embed.addFields({ name: '\u200B', value: '*No data recorded for this period.*' });
    } else {
        // Top 3 Producers Section
        let top3Text = "🌟 **TOP AP PRODUCERS**\n";
        sorted.slice(0, 3).forEach((u, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
            const place = i === 0 ? 'AP LEADER' : i === 1 ? '2nd Place' : '3rd Place';
            top3Text += `${medal} **${place}**\n👤 **${u.username}**\n💵 **$${u.total.toLocaleString(undefined, {minimumFractionDigits: 2})} AP**\n📊 *${u.count} policies*\n\n`;
        });
        embed.addFields({ name: '\u200B', value: top3Text });

        // Other Agents List
        if (sorted.length > 3) {
            let othersText = "";
            sorted.slice(3, 10).forEach((u, i) => {
                othersText += `**${i + 4}.** ${u.username} - **$${u.total.toLocaleString(undefined, {minimumFractionDigits: 2})}** (${u.count})\n`;
            });
            embed.addFields({ name: '📈 Other Agents', value: othersText });
        }

        // Summary Section
        const totalAP = sorted.reduce((acc, curr) => acc + curr.total, 0);
        const totalPols = sorted.reduce((acc, curr) => acc + curr.count, 0);
        const avgAP = totalAP / (sorted.length || 1);

        embed.addFields({ 
            name: '💼 AP SUMMARY', 
            value: `**Total AP:** $${totalAP.toLocaleString(undefined, {minimumFractionDigits: 2})}\n**Average AP:** $${avgAP.toLocaleString(undefined, {minimumFractionDigits: 3})}\n**Total Policies:** ${totalPols}` 
        });
    }

    return embed;
}

// ========================================
// 6. EVENTS & AUTOMATION
// ========================================
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    if (msg.content === '!lb') return msg.reply({ embeds: [generateEmbed('daily')] });
    if (msg.content === '!weekly') return msg.reply({ embeds: [generateEmbed('weekly')] });
    if (msg.content === '!monthly') return msg.reply({ embeds: [generateEmbed('monthly')] });

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

            await msg.react('✅');
            await msg.react('💰');
            if (totalInMsg > 2000) await msg.react('🔥');

            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
            await syncWithGitHub('upload');
        }
    }
});

// CRON Schedules (Pacific Time)
const dailyHours = ['0 9 * * *', '0 12 * * *', '0 15 * * *', '0 18 * * *', '0 21 * * *'];
dailyHours.forEach(h => {
    cron.schedule(h, () => {
        const ch = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (ch) ch.send({ embeds: [generateEmbed('daily')] });
    }, { timezone: "America/Los_Angeles" });
});

cron.schedule('0 23 * * 0', () => { // Weekly: Sunday 11pm
    const ch = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
    if (ch) ch.send({ embeds: [generateEmbed('weekly')] });
}, { timezone: "America/Los_Angeles" });

cron.schedule('30 23 28-31 * *', () => { // Monthly: Last day
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    if (tomorrow.getDate() === 1) {
        const ch = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (ch) ch.send({ embeds: [generateEmbed('monthly')] });
    }
}, { timezone: "America/Los_Angeles" });

client.once('ready', async () => {
    await syncWithGitHub('download');
    console.log(`⭐ Bot active as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
