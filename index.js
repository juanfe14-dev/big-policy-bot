require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const {
  Client,
  GatewayIntentBits,
  Partials
} = require('discord.js');

/* =========================
   EXPRESS (RENDER KEEP ALIVE)
========================= */

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('BIG Policy Bot is running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

/* =========================
   DISCORD CLIENT (CRÍTICO)
========================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* =========================
   DATA
========================= */

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

function loadSales() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveSales(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/* =========================
   SALES PARSER
========================= */

function parseSale(message) {
  const match = message.match(/\$([\d,]+(\.\d+)?)/);
  if (!match) return null;
  return parseFloat(match[1].replace(/,/g, ''));
}

/* =========================
   LEADERBOARD
========================= */

function generateLeaderboard() {
  const sales = loadSales();
  const totals = {};

  for (const s of sales) {
    totals[s.user] = (totals[s.user] || 0) + s.amount;
  }

  const sorted = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (!sorted.length) return 'No sales yet.';

  return sorted
    .map(([user, amt], i) => `**${i + 1}. ${user}** — $${amt.toFixed(2)}`)
    .join('\n');
}

/* =========================
   DISCORD EVENTS
========================= */

client.once('ready', () => {
  console.log(`✅ Bot connected as ${client.user.tag}`);

  /* ===== CRON JOB ===== */
  cron.schedule(
    '0 12 * * *',
    async () => {
      try {
        const channel = await client.channels.fetch(
          process.env.LEADERBOARD_CHANNEL_ID
        );
        if (!channel) return;

        const board = generateLeaderboard();
        await channel.send(`📊 **Daily Leaderboard**\n\n${board}`);
        console.log('📊 Leaderboard sent');
      } catch (err) {
        console.error('❌ Leaderboard error:', err);
      }
    },
    { timezone: 'America/Los_Angeles' }
  );

  console.log('⏰ Cron jobs registered');
});

/* ===== MESSAGE LISTENER (CRÍTICO) ===== */

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  console.log('📥 Message received:', message.content);

  // Leaderboard command
  if (message.content.toLowerCase() === '!leaderboard') {
    const board = generateLeaderboard();
    await message.channel.send(`📊 **Leaderboard**\n\n${board}`);
    return;
  }

  // Sale detection
  const amount = parseSale(message.content);
  if (!amount) return;

  const sales = loadSales();
  sales.push({
    user: message.author.username,
    amount,
    timestamp: new Date().toISOString()
  });
  saveSales(sales);

  console.log(`💰 Sale recorded: ${message.author.username} - $${amount}`);
  await message.react('💰');
});

/* =========================
   KEEP ALIVE (RENDER FIX)
========================= */

setInterval(() => {
  console.log('🔄 Keep alive ping', new Date().toISOString());
}, 5 * 60 * 1000);

/* =========================
   LOGIN
========================= */

client.login(process.env.DISCORD_TOKEN);
