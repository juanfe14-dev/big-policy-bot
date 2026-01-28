// ===============================
// 🔥 BIG POLICY BOT - INDEX.JS 🔥
// ===============================

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Events } = require('discord.js');

// ===============================
// 🔧 ENV VARS
// ===============================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SALES_CHANNEL_ID = process.env.SALES_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

// ===============================
// 🧠 BASIC VALIDATION
// ===============================
console.log('🔑 DISCORD_TOKEN exists:', !!DISCORD_TOKEN, 'length:', DISCORD_TOKEN?.length);
console.log('📌 SALES_CHANNEL_ID:', SALES_CHANNEL_ID);
console.log('📌 LEADERBOARD_CHANNEL_ID:', LEADERBOARD_CHANNEL_ID);

if (!DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN');
  process.exit(1);
}

// ===============================
// 📁 DATA SETUP
// ===============================
const dataDir = path.join(__dirname, 'data');
const salesFile = path.join(dataDir, 'sales.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(salesFile)) fs.writeFileSync(salesFile, JSON.stringify([]));

console.log('📁 Data directory:', dataDir);

// ===============================
// 🤖 DISCORD CLIENT
// ===============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ===============================
// ✅ READY EVENT
// ===============================
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot connected successfully!`);
  console.log(`🤖 Bot Tag: ${c.user.tag}`);
});

// ===============================
// 💬 MESSAGE HANDLER
// ===============================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // ===========================
  // 📊 LEADERBOARD COMMAND
  // ===========================
  if (message.content.trim() === '!leaderboard') {
    if (message.channel.id !== LEADERBOARD_CHANNEL_ID) return;

    const sales = JSON.parse(fs.readFileSync(salesFile));
    if (sales.length === 0) {
      return message.channel.send('📭 No sales recorded yet.');
    }

    const totals = {};
    for (const s of sales) {
      totals[s.user] = (totals[s.user] || 0) + s.amount;
    }

    const sorted = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    let output = '🏆 **Leaderboard** 🏆\n\n';
    sorted.forEach(([user, total], i) => {
      output += `${i + 1}. **${user}** — $${total.toFixed(2)}\n`;
    });

    return message.channel.send(output);
  }

  // ===========================
  // 💰 SALE PARSER ($123)
  // ===========================
  if (message.channel.id === SALES_CHANNEL_ID) {
    const match = message.content.match(/\$(\d+(\.\d+)?)/);
    if (!match) return;

    const amount = parseFloat(match[1]);
    const sale = {
      user: message.author.username,
      amount,
      timestamp: new Date().toISOString(),
    };

    const sales = JSON.parse(fs.readFileSync(salesFile));
    sales.push(sale);
    fs.writeFileSync(salesFile, JSON.stringify(sales, null, 2));

    console.log(`💰 Sale recorded: ${sale.user} - $${sale.amount}`);
    return message.react('✅');
  }
});

// ===============================
// 🌐 EXPRESS SERVER (RENDER)
// ===============================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('🤖 BIG Policy Bot is running\nStatus: Connected');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot_connected: client.isReady(),
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📡 Health check available at http://0.0.0.0:${PORT}/health`);
});

// ===============================
// 🚀 DISCORD LOGIN (CRÍTICO)
// ===============================
console.log('🚀 Attempting Discord login...');
client.login(DISCORD_TOKEN);
