require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const express = require('express');

// =======================
// EXPRESS (RENDER)
// =======================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (_, res) => res.send('BIG Policy Bot is running'));
app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// =======================
// DISCORD CLIENT
// =======================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// =======================
// DATA
// =======================
const DATA_DIR = process.env.RENDER
  ? '/opt/render/project/src/data'
  : path.join(__dirname, 'data');

const DATA_FILE = path.join(DATA_DIR, 'sales.json');

let salesData = {
  daily: {},
  weekly: {},
  monthly: {},
  lastReset: {
    day: '',
    week: '',
    month: ''
  }
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DATA_FILE)) {
  salesData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(salesData, null, 2));
}

// =======================
// TIME / RESETS
// =======================
function pacificNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function getWeekTag(d) {
  const first = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - first) / 86400000) + first.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

function checkResets() {
  const now = pacificNow();

  const dayTag = now.toDateString();
  const weekTag = getWeekTag(now);
  const monthTag = `${now.getFullYear()}-${now.getMonth()}`;

  if (salesData.lastReset.day !== dayTag) {
    salesData.daily = {};
    salesData.lastReset.day = dayTag;
    console.log('🔄 Daily reset');
  }

  if (salesData.lastReset.week !== weekTag) {
    salesData.weekly = {};
    salesData.lastReset.week = weekTag;
    console.log('🔄 Weekly reset');
  }

  if (salesData.lastReset.month !== monthTag) {
    salesData.monthly = {};
    salesData.lastReset.month = monthTag;
    console.log('🔄 Monthly reset');
  }

  saveData();
}

// =======================
// SALES
// =======================
function addSale(user, amount) {
  checkResets();

  for (const period of ['daily', 'weekly', 'monthly']) {
    if (!salesData[period][user.id]) {
      salesData[period][user.id] = {
        username: user.username,
        total: 0,
        count: 0
      };
    }
    salesData[period][user.id].total += amount;
    salesData[period][user.id].count += 1;
  }

  saveData();
}

function parseSale(text) {
  const match = text.match(/\$([\d,]+(\.\d{2})?)/);
  if (!match) return null;
  return parseFloat(match[1].replace(/,/g, ''));
}

// =======================
// LEADERBOARD
// =======================
function buildLeaderboard(period) {
  checkResets();

  const data = Object.values(salesData[period])
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle(`💵 ${period.toUpperCase()} LEADERBOARD`)
    .setTimestamp();

  if (data.length === 0) {
    embed.setDescription('No sales recorded.');
    return embed;
  }

  embed.setDescription(
    data.map((u, i) =>
      `**${i + 1}. ${u.username}** — $${u.total.toLocaleString()} (${u.count})`
    ).join('\n')
  );

  return embed;
}

// =======================
// CRON (CRÍTICO)
// =======================
let cronsStarted = false;

function startCrons() {
  // Every 3 hours
  cron.schedule('0 */3 * * *', async () => {
    const hour = pacificNow().getHours();
    if (![9, 12, 15, 18, 21].includes(hour)) return;

    const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
    if (!channel) return;

    await channel.send({ embeds: [buildLeaderboard('daily')] });
    console.log('📊 Leaderboard sent');
  });

  console.log('⏰ Cron jobs registered');
}

// =======================
// EVENTS
// =======================
client.on('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  if (!cronsStarted) {
    startCrons();
    cronsStarted = true;
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  checkResets();

  if (message.channel.id === process.env.SALES_CHANNEL_ID) {
    const amount = parseSale(message.content);
    if (!amount) return;

    addSale(message.author, amount);
    await message.react('✅');
    await message.react('💰');
    console.log(`💰 Sale: ${message.author.username} $${amount}`);
  }

  if (message.content === '!leaderboard') {
    await message.channel.send({ embeds: [buildLeaderboard('daily')] });
  }
});

// =======================
// START
// =======================
client.login(process.env.DISCORD_TOKEN);
