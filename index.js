require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const https = require('https');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// ========================================
// SERVIDOR EXPRESS PARA RENDER (CRÍTICO)
// ========================================
const app = express();
const PORT = process.env.PORT || 10000;

// IMPORTANTE: Iniciar el servidor INMEDIATAMENTE
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📡 Health check available at http://0.0.0.0:${PORT}/health`);
});

// Health check endpoints
app.get('/', (req, res) => {
    const status = {
        server: 'online',
        bot: client.user ? `${client.user.tag} connected` : 'connecting...',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    };
    res.send(`
        <h1>🤖 BIG Policy Bot Status</h1>
        <p>Bot: ${status.bot}</p>
        <p>Uptime: ${status.uptime} seconds</p>
        <p>Time: ${status.timestamp}</p>
    `);
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        bot_connected: client.user ? true : false,
        bot_tag: client.user ? client.user.tag : null,
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'production'
    });
});

// Ping endpoint para monitoreo
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// ========================================
// CONFIGURACIÓN DEL BOT
// ========================================
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

// Data file - Compatible con Render
const DATA_DIR = process.env.RENDER 
    ? '/opt/render/project/src/data' 
    : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');

console.log(`📁 Data directory: ${DATA_DIR}`);

// Data structure
let salesData = {
    daily: {},
    weekly: {},
    monthly: {},
    allTime: {},
    dailySnapshot: {},
    weeklySnapshot: {},
    monthlySnapshot: {},
    lastReset: {
        daily: new Date().toDateString(),
        weekly: getWeekNumber(new Date()),
        weeklyTag: '',
        monthly: new Date().getMonth(),
        monthlyTag: ''
    }
};

// Load data
async function loadData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        
        try {
            await fs.access(DATA_FILE);
            const data = await fs.readFile(DATA_FILE, 'utf8');
            salesData = JSON.parse(data);
            
            if (!salesData.lastReset.weeklyTag) {
                salesData.lastReset.weeklyTag = '';
            }
            if (!salesData.lastReset.monthlyTag) {
                salesData.lastReset.monthlyTag = '';
            }
            
            console.log('📂 Data loaded successfully from:', DATA_FILE);
            
            const dailyCount = Object.keys(salesData.daily || {}).length;
            const weeklyCount = Object.keys(salesData.weekly || {}).length;
            const monthlyCount = Object.keys(salesData.monthly || {}).length;
            console.log(`   📊 Current data: ${dailyCount} daily, ${weeklyCount} weekly, ${monthlyCount} monthly agents`);
        } catch (error) {
            console.log('📝 No data file found at:', DATA_FILE);
            console.log('   Creating new data file...');
            await saveData();
        }
    } catch (error) {
        console.error('❌ Error in loadData:', error);
        console.log('   Starting with fresh data...');
        await saveData();
    }
}

// Save data - Simplificado sin backup a Discord
async function saveData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
        console.log(`💾 Data saved to: ${DATA_FILE}`);
    } catch (error) {
        console.error('❌ Error saving data:', error);
    }
}

// ========== Daily backup of sales.json (end of day, Pacific) ==========
async function backupDailySales() {
    try {
        const backupsDir = path.join(DATA_DIR, 'backups');
        await fs.mkdir(backupsDir, { recursive: true });
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
        const tag = now.toISOString().slice(0,10); // YYYY-MM-DD (Pacific day)
        const backupFile = path.join(backupsDir, `sales-${tag}.json`);
        await fs.copyFile(DATA_FILE, backupFile);
        console.log(`📦 Daily backup created: ${backupFile}`);
    } catch (err) {
        console.error('❌ Daily backup error:', err?.message || err);
    }
}

// Función para sincronizar con GitHub
async function syncToGitHub() {
    if (!process.env.GITHUB_TOKEN) {
        console.log('⚠️ No GitHub token configured, skipping GitHub sync');
        return false;
    }
    
    try {
        console.log('🔄 Starting GitHub sync...');
        
        // Verificar si git está inicializado, si no, inicializar
        try {
            await execPromise('git status');
        } catch (e) {
            console.log('Initializing git repository...');
            await execPromise('git init');
        }
        
        // Configurar git user (requerido para commits)
        await execPromise('git config user.email "bot@bigpolicy.com"');
        await execPromise('git config user.name "BIG Policy Bot"');
        
        // Configurar remote con token
        const gitUrl = `https://${process.env.GITHUB_TOKEN}@github.com/juanfe14-dev/big-policy-bot.git`;
        
        // Primero verificar si el remote existe, si no, agregarlo
        try {
            await execPromise('git remote get-url origin');
            // Si existe, actualizar la URL
            await execPromise(`git remote set-url origin ${gitUrl}`);
        } catch (e) {
            // Si no existe, agregarlo
            console.log('Adding git remote...');
            await execPromise(`git remote add origin ${gitUrl}`);
        }
        
        // Fetch para obtener la rama remota
        try {
            await execPromise('git fetch origin');
        } catch (e) {
            console.log('Fetch skipped - may be first time');
        }
        
        // Verificar si estamos en una rama, si no, crear main
        try {
            await execPromise('git branch --show-current');
        } catch (e) {
            await execPromise('git checkout -b main');
        }
        
        // Pull últimos cambios (con estrategia de merge)
        try {
            await execPromise('git pull origin main --no-rebase --allow-unrelated-histories');
        } catch (pullError) {
            console.log('Pull skipped - may be first sync or conflicts');
        }
        
        // Agregar archivo de datos (usar -f para forzar ya que data/ está en .gitignore)
        await execPromise('git add -f data/sales.json');
        
        // Verificar si hay cambios para commitear
        const status = await execPromise('git status --porcelain');
        if (!status.stdout || status.stdout.trim() === '') {
            console.log('ℹ️ No changes to sync');
            return true;
        }
        
        // Commit con timestamp
        const pacificTime = new Date().toLocaleString('en-US', { 
            timeZone: 'America/Los_Angeles',
            month: 'short',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
        
        // Obtener estadísticas para el commit
        const totalDaily = Object.keys(salesData.daily || {}).length;
        const totalWeekly = Object.keys(salesData.weekly || {}).length;
        const totalMonthly = Object.keys(salesData.monthly || {}).length;
        
        const commitMessage = `Auto-update sales data - ${pacificTime} - ${totalDaily}d ${totalWeekly}w ${totalMonthly}m agents`;
        
        try {
            await execPromise(`git commit -m "${commitMessage}"`);
        } catch (commitError) {
            console.log('Trying alternative commit...');
            await execPromise(`git commit -m "Auto-update sales data"`);
        }
        
        // Push a GitHub
        await execPromise('git push origin main --force-with-lease');
        
        console.log('✅ Successfully synced to GitHub');
        console.log(`   📊 Updated: ${totalDaily} daily, ${totalWeekly} weekly, ${totalMonthly} monthly agents`);
        return true;
    } catch (error) {
        console.error('❌ Error syncing to GitHub:', error.message);
        return false;
    }
}

// Get week number
function getWeekNumber(date) {
    const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

// Check period resets - CORREGIDO PARA FILTRAR POR MES CORRECTAMENTE
function checkResets() {
    const now = new Date();
    const pacificTime = new Date(now.toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
    
    const currentDay = pacificTime.toDateString();
    const currentWeek = getWeekNumber(pacificTime);
    const currentMonth = pacificTime.getMonth();
    const currentYear = pacificTime.getFullYear();

    let wasReset = false;

    // Daily reset
    if (salesData.lastReset.daily !== currentDay) {
        salesData.dailySnapshot = JSON.parse(JSON.stringify(salesData.daily));
        salesData.daily = {};
        salesData.lastReset.daily = currentDay;
        wasReset = true;
        console.log(`🔄 Daily reset executed for ${currentDay}`);
    }

    // Weekly reset (Mondays)
    const lastWeekReset = `${currentYear}-W${currentWeek}`;
    if (!salesData.lastReset.weeklyTag || salesData.lastReset.weeklyTag !== lastWeekReset) {
        if (pacificTime.getDay() === 1) {
            salesData.weeklySnapshot = JSON.parse(JSON.stringify(salesData.weekly));
            salesData.weekly = {};
            salesData.lastReset.weekly = currentWeek;
            salesData.lastReset.weeklyTag = lastWeekReset;
            wasReset = true;
            console.log(`🔄 Weekly reset executed for week ${currentWeek}`);
        }
    }

    // Monthly reset - CORRECCIÓN AQUÍ
    // El tag debe incluir tanto año como mes para detectar cambios correctamente
    const lastMonthReset = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
    
    // Si no existe el tag O si el tag es diferente al mes actual
    if (!salesData.lastReset.monthlyTag || salesData.lastReset.monthlyTag !== lastMonthReset) {
        console.log(`🔄 Monthly reset detected: stored tag "${salesData.lastReset.monthlyTag}" vs current "${lastMonthReset}"`);
        salesData.monthlySnapshot = JSON.parse(JSON.stringify(salesData.monthly));
        salesData.monthly = {};
        salesData.lastReset.monthly = currentMonth;
        salesData.lastReset.monthlyTag = lastMonthReset;
        wasReset = true;
        console.log(`🔄 Monthly reset executed for month ${currentMonth + 1} (${lastMonthReset})`);
    }

    if (wasReset) {
        saveData();
    }
}

// Parse MULTIPLE sales from a single message
function parseMultipleSales(message) {
    const fullMessage = message.replace(/\n/g, ' ');
    const pattern = /(?:\$\s*([\d,]+(?:\.\d{2})?))|([\d,]+(?:\.\d{2})?)\s*\$/g;
    const matches = [...fullMessage.matchAll(pattern)];
    
    if (!matches || matches.length === 0) {
        return [];
    }
    
    const sales = [];
    
    matches.forEach((match, index) => {
        const amountStr = match[1] || match[2];
        const amount = parseFloat(amountStr.replace(/,/g, ''));
        
        const startPos = match.index + match[0].length;
        const endPos = matches[index + 1] ? matches[index + 1].index : fullMessage.length;
        let policyText = fullMessage.substring(startPos, endPos).trim();
        
        // Clean up policy text
        policyText = policyText.replace(/^(His|Hers|Child|Spouse|Wife|Husband|Son|Daughter|Kid|Parent|Mother|Father):/gi, '').trim();
        policyText = policyText.replace(/:[a-zA-Z0-9_]+:/g, '').trim();
        policyText = policyText.replace(/[\u{1F000}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{FE00}-\u{FE0F}]|[\u{1F300}-\u{1F5FF}]|[\u{2000}-\u{3300}]/gu, '').trim();
        policyText = policyText.replace(/@[^\s]+/g, '').trim();
        policyText = policyText.replace(/\b(w\/|with)\b.*/gi, '').trim();
        
        const hashtagIndex = policyText.indexOf('#');
        if (hashtagIndex > -1) {
            policyText = policyText.substring(0, hashtagIndex).trim();
        }
        
        policyText = policyText.replace(/[^\w\s-]/g, ' ');
        policyText = policyText.replace(/\s+/g, ' ').trim();
        
        const policyPatterns = [
            'NLG', 'TLE', 'IUL', 'IULE', 'UL', 'WL', 'TERM',
            'Americo', 'MOO', 'Ladder', 'Term Life',
            'Universal Life', 'Whole Life', 'Final Expense',
            'Index Universal Life', 'Variable Universal Life'
        ];
        
        let foundPolicy = '';
        for (const pattern of policyPatterns) {
            const regex = new RegExp(`\\b${pattern}\\b`, 'i');
            if (regex.test(policyText)) {
                const extractRegex = new RegExp(`(\\w+\\s+)?\\b${pattern}\\b(\\s+\\w+)?`, 'i');
                const policyMatch = policyText.match(extractRegex);
                if (policyMatch) {
                    foundPolicy = policyMatch[0].trim();
                    break;
                }
            }
        }
        
        let policyType = foundPolicy || policyText;
        
        const words = policyType.split(' ').filter(word => word.length > 0);
        if (words.length > 3) {
            policyType = words.slice(0, 3).join(' ');
        }
        
        if (!policyType || policyType.length < 2) {
            policyType = 'General Policy';
        }
        
        policyType = policyType.split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
        
        sales.push({
            amount: amount,
            policyType: policyType
        });
    });
    
    console.log(`💬 Parsed ${sales.length} sale(s) from message:`);
    sales.forEach((sale, i) => {
        console.log(`   Sale ${i + 1}: $${sale.amount} - "${sale.policyType}"`);
    });
    
    return sales;
}

// Add sale
function addSale(userId, username, amount, policyType) {
    if (!salesData.daily[userId]) {
        salesData.daily[userId] = { total: 0, count: 0, username: username };
    }
    if (!salesData.weekly[userId]) {
        salesData.weekly[userId] = { total: 0, count: 0, username: username };
    }
    if (!salesData.monthly[userId]) {
        salesData.monthly[userId] = { total: 0, count: 0, username: username };
    }
    if (!salesData.allTime[userId]) {
        salesData.allTime[userId] = { total: 0, count: 0, username: username };
    }

    salesData.daily[userId].total += amount;
    salesData.daily[userId].count += 1;
    salesData.weekly[userId].total += amount;
    salesData.weekly[userId].count += 1;
    salesData.monthly[userId].total += amount;
    salesData.monthly[userId].count += 1;
    salesData.allTime[userId].total += amount;
    salesData.allTime[userId].count += 1;

    saveData();
}

// Generate AP Leaderboard
function generateAPLeaderboard(period, title = null) {
    // Siempre ejecutar checkResets antes de generar leaderboard
    // Esto asegura que los datos del mes anterior se reseteen si cambió el mes
    if (period === 'monthly') {
        checkResets();
    }
    
    const data = salesData[period];
    const sorted = Object.entries(data)
        .sort(([,a], [,b]) => b.total - a.total);

    const periodTitle = {
        'daily': '💵 DAILY LEADERBOARD',
        'weekly': '💵 WEEKLY LEADERBOARD',
        'monthly': '💵 MONTHLY LEADERBOARD'
    };

    const currentDate = new Date().toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle(title || periodTitle[period])
        .setDescription(`💰 **Ranked by Annual Premium (AP)**\n📍 Date: ${currentDate}\n━━━━━━━━━━━━━━━━━━━━━`)
        .setTimestamp()
        .setFooter({ text: '💼 BIG - Annual Premium Rankings' });

    if (sorted.length === 0) {
        embed.addFields({
            name: '📝 No Records',
            value: 'No sales recorded for this period'
        });
    } else {
        let topDescription = '';
        const top3 = sorted.slice(0, 3);
        
        top3.forEach(([userId, data], index) => {
            const medal = index === 0 ? '🥇 **AP LEADER**' : index === 1 ? '🥈 **2nd Place**' : '🥉 **3rd Place**';
            topDescription += `${medal}\n`;
            topDescription += `👤 **${data.username}**\n`;
            topDescription += `💵 **$${data.total.toLocaleString('en-US', {minimumFractionDigits: 2})} AP**\n`;
            topDescription += `📊 *${data.count} policies*\n\n`;
        });
        
        embed.addFields({
            name: '🌟 **TOP AP PRODUCERS**',
            value: topDescription || 'No data'
        });

        if (sorted.length > 3) {
            let restDescription = '';
            const rest = sorted.slice(3, 10);
            
            rest.forEach(([userId, data], index) => {
                restDescription += `**${index + 4}.** ${data.username} - **$${data.total.toLocaleString('en-US', {minimumFractionDigits: 2})}** (${data.count})\n`;
            });
            
            if (restDescription) {
                embed.addFields({
                    name: '📈 **Other Agents**',
                    value: restDescription
                });
            }
        }

        const totalAP = Object.values(data).reduce((sum, user) => sum + user.total, 0);
        const totalPolicies = Object.values(data).reduce((sum, user) => sum + user.count, 0);
        const averageAP = totalPolicies > 0 ? totalAP / totalPolicies : 0;

        embed.addFields({
            name: '💼 **AP SUMMARY**',
            value: `**Total AP:** $${totalAP.toLocaleString('en-US', {minimumFractionDigits: 2})}\n**Average AP:** $${averageAP.toLocaleString('en-US', {minimumFractionDigits: 2})}\n**Total Policies:** ${totalPolicies}`
        });
    }

    return embed;
}

// Generate AP Leaderboard from specific data
function generateAPLeaderboardFromData(data, title) {
    const sorted = Object.entries(data)
        .sort(([,a], [,b]) => b.total - a.total);

    const currentDate = new Date().toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle(title)
        .setDescription(`💰 **Ranked by Annual Premium (AP)**\n📍 Date: ${currentDate}\n━━━━━━━━━━━━━━━━━━━━━`)
        .setTimestamp()
        .setFooter({ text: '💼 BIG - Annual Premium Rankings' });

    if (sorted.length === 0) {
        embed.addFields({
            name: '📝 No Records',
            value: 'No sales recorded for this period'
        });
    } else {
        let topDescription = '';
        const top3 = sorted.slice(0, 3);
        
        top3.forEach(([userId, data], index) => {
            const medal = index === 0 ? '🥇 **AP LEADER**' : index === 1 ? '🥈 **2nd Place**' : '🥉 **3rd Place**';
            topDescription += `${medal}\n`;
            topDescription += `👤 **${data.username}**\n`;
            topDescription += `💵 **$${data.total.toLocaleString('en-US', {minimumFractionDigits: 2})} AP**\n`;
            topDescription += `📊 *${data.count} policies*\n\n`;
        });
        
        embed.addFields({
            name: '🌟 **TOP AP PRODUCERS**',
            value: topDescription || 'No data'
        });

        if (sorted.length > 3) {
            let restDescription = '';
            const rest = sorted.slice(3, 10);
            
            rest.forEach(([userId, data], index) => {
                restDescription += `**${index + 4}.** ${data.username} - **$${data.total.toLocaleString('en-US', {minimumFractionDigits: 2})}** (${data.count})\n`;
            });
            
            if (restDescription) {
                embed.addFields({
                    name: '📈 **Other Agents**',
                    value: restDescription
                });
            }
        }

        const totalAP = Object.values(data).reduce((sum, user) => sum + user.total, 0);
        const totalPolicies = Object.values(data).reduce((sum, user) => sum + user.count, 0);
        const averageAP = totalPolicies > 0 ? totalAP / totalPolicies : 0;

        embed.addFields({
            name: '💼 **AP SUMMARY**',
            value: `**Total AP:** $${totalAP.toLocaleString('en-US', {minimumFractionDigits: 2})}\n**Average AP:** $${averageAP.toLocaleString('en-US', {minimumFractionDigits: 2})}\n**Total Policies:** ${totalPolicies}`
        });
    }

    return embed;
}

// Función para convertir hora Pacific a UTC
function getPacificToUTC(pacificHour) {
    const testDate = new Date();
    testDate.setHours(pacificHour, 0, 0, 0);
    
    const pacificTime = new Date(testDate.toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
    const utcTime = new Date(testDate.toLocaleString("en-US", {timeZone: "UTC"}));
    
    const offset = (utcTime.getHours() - pacificTime.getHours() + 24) % 24;
    return (pacificHour + offset) % 24;
}

// Bot ready event
client.once('ready', async () => {
    console.log('\n✅ Bot connected successfully!');
    console.log(`   🤖 Bot Tag: ${client.user.tag}`);
    console.log(`   🆔 Bot ID: ${client.user.id}`);
    console.log(`   📅 Connected at: ${new Date().toLocaleString('en-US', {timeZone: 'America/Los_Angeles'})}`);
    console.log(`   📡 Ping: ${client.ws.ping}ms\n`);
    
    // Verificar variables de entorno
    console.log('🔍 Environment check:');
    console.log(`   SALES_CHANNEL_ID: ${process.env.SALES_CHANNEL_ID ? '✓' : '✗'}`);
    console.log(`   LEADERBOARD_CHANNEL_ID: ${process.env.LEADERBOARD_CHANNEL_ID ? '✓' : '✗'}`);
    console.log(`   GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? '✓' : '✗'}`);
    console.log('');
    
    // Verificar y resetear si es necesario
    checkResets();

    // ========== Scheduled automatic posts (AP leaderboards) ==========
    
    // Cada 3 horas: AP leaderboard + sync GitHub
    cron.schedule('0 */3 * * *', async () => {
        const pacificNow = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
        const hour = pacificNow.getHours();
        
        if ([9, 12, 15, 18, 21].includes(hour)) {
            const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
            if (channel) {
                checkResets();
                const embed = generateAPLeaderboard('daily');
                await channel.send({ embeds: [embed] });
                console.log(`📊 AP leaderboard posted - ${hour}:00 Pacific`);
            }
        }
        
        // Sync to GitHub every 3 hours
        if (process.env.GITHUB_TOKEN) {
            console.log('⏰ 3-hour GitHub sync triggered');
            await syncToGitHub();
        }
    });

    // Daily backup at 23:59 Pacific
    cron.schedule('59 23 * * *', async () => { 
        await backupDailySales(); 
    }, { timezone: 'America/Los_Angeles' });

    // Weekly summary - Sundays at 10:55 PM Pacific
    const weeklyUTCHour = getPacificToUTC(22);
    cron.schedule(`55 ${weeklyUTCHour} * * 0`, async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            const weeklyDataCopy = JSON.parse(JSON.stringify(salesData.weekly));
            
            await channel.send('🏆 **WEEKLY FINAL RANKINGS**');
            
            const apEmbed = generateAPLeaderboardFromData(weeklyDataCopy, '💵 WEEKLY CHAMPIONS - COMPLETE WEEK');
            apEmbed.setColor(0xFF6B6B);
            await channel.send({ embeds: [apEmbed] });
            
            await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 Weekly AP rankings posted - Sunday 10:55 PM Pacific');
        }
    }, {
        scheduled: true,
        timezone: "UTC"
    });

    // Monthly summary - Last day of month at 10:55 PM Pacific
    const monthlyUTCHour = getPacificToUTC(22);
    cron.schedule(`55 ${monthlyUTCHour} * * *`, async () => {
        const pacificNow = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
        const tomorrow = new Date(pacificNow);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        if (tomorrow.getDate() === 1) {
            const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
            if (channel) {
                const monthlyDataCopy = JSON.parse(JSON.stringify(salesData.monthly));
                
                await channel.send('🎊 **MONTHLY FINAL RANKINGS - CONGRATULATIONS!** 🎊');
                
                const apEmbed = generateAPLeaderboardFromData(monthlyDataCopy, '💵 MONTHLY CHAMPIONS - COMPLETE MONTH');
                apEmbed.setColor(0xFFD700);
                await channel.send({ embeds: [apEmbed] });
                
                await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('📊 Monthly AP rankings posted - End of month 10:55 PM Pacific');
            }
        }
    }, {
        scheduled: true,
        timezone: "UTC"
    });
    
    console.log('\n🌍 TIMEZONE INFORMATION:');
    const now = new Date();
    const utcTime = now.toLocaleString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: true });
    const pacificTime = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: true });
    console.log(`   Current UTC time: ${utcTime}`);
    console.log(`   Current Pacific time: ${pacificTime}`);
    console.log(`   DST Status: ${isDST() ? 'PDT (UTC-7)' : 'PST (UTC-8)'}`);
    console.log(`   Cron schedules adjusted for Pacific Time ✅`);
});

// Handle messages
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // Check if it's the sales channel
    if (message.channel.id === process.env.SALES_CHANNEL_ID) {
        const sales = parseMultipleSales(message.content);
        
        if (sales && sales.length > 0) {
            let totalAmount = 0;
            
            for (const sale of sales) {
                if (sale.amount > 0) {
                    addSale(
                        message.author.id, 
                        message.author.username, 
                        sale.amount, 
                        sale.policyType
                    );
                    totalAmount += sale.amount;
                    
                    console.log(`💰 Sale recorded: ${message.author.username} - $${sale.amount} AP - ${sale.policyType}`);
                }
            }
            
            if (totalAmount > 0) {
                await message.react('✅');
                await message.react('💰');
                
                if (totalAmount >= 1000) {
                    await message.react('🔥');
                }
                
                if (totalAmount >= 5000) {
                    await message.react('🚀');
                }
                
                if (sales.length >= 3) {
                    await message.react('⭐');
                }
                
                console.log(`📊 Total recorded: ${sales.length} policies, $${totalAmount} total AP`);
            }
        }
    }

    // Commands
    if (message.content.startsWith('!')) {
        const args = message.content.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        switch(command) {
            case 'leaderboard':
            case 'lb':
            case 'ap':
            case 'rankings':
                const period = args[0] || 'daily';
                const validPeriods = {
                    'daily': 'daily',
                    'day': 'daily',
                    'today': 'daily',
                    'weekly': 'weekly',
                    'week': 'weekly',
                    'monthly': 'monthly',
                    'month': 'monthly'
                };
                
                if (validPeriods[period]) {
                    await message.channel.send({ embeds: [generateAPLeaderboard(validPeriods[period])] });
                } else {
                    await message.reply('Usage: `!leaderboard [daily|weekly|monthly]`');
                }
                break;

            case 'mysales':
            case 'mystats':
            case 'stats':
                checkResets();
                const userId = message.author.id;
                const daily = salesData.daily[userId] || { total: 0, count: 0 };
                const weekly = salesData.weekly[userId] || { total: 0, count: 0 };
                const monthly = salesData.monthly[userId] || { total: 0, count: 0 };
                const allTime = salesData.allTime && salesData.allTime[userId] ? salesData.allTime[userId] : { total: 0, count: 0 };

                const dailyAPRank = Object.entries(salesData.daily)
                    .sort(([,a], [,b]) => b.total - a.total)
                    .findIndex(([id,]) => id === userId) + 1;

                const statsEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(`📊 ${message.author.username}'s Complete Statistics`)
                    .setThumbnail(message.author.displayAvatarURL())
                    .addFields(
                        { 
                            name: '📅 **TODAY**', 
                            value: `💵 **${daily.total.toLocaleString('en-US', {minimumFractionDigits: 2})} AP**\n📋 **${daily.count} Policies**\n🏆 AP Rank: #${dailyAPRank || 'N/A'}`, 
                            inline: true 
                        },
                        { 
                            name: '📊 **THIS WEEK**', 
                            value: `💵 **${weekly.total.toLocaleString('en-US', {minimumFractionDigits: 2})} AP**\n📋 **${weekly.count} Policies**`, 
                            inline: true 
                        },
                        { 
                            name: '🏆 **THIS MONTH**', 
                            value: `💵 **${monthly.total.toLocaleString('en-US', {minimumFractionDigits: 2})} AP**\n📋 **${monthly.count} Policies**`, 
                            inline: true 
                        }
                    );

                if (allTime.total > 0) {
                    statsEmbed.addFields({
                        name: '🌟 **ALL-TIME RECORD**',
                        value: `💎 **${allTime.total.toLocaleString('en-US', {minimumFractionDigits: 2})} Total AP**\n📝 **${allTime.count} Total Policies**`
                    });
                }

                const monthAverage = monthly.count > 0 ? monthly.total / monthly.count : 0;
                if (monthAverage > 0) {
                    statsEmbed.addFields({
                        name: '📈 **Performance Metrics**',
                        value: `**Avg AP per Policy:** ${monthAverage.toLocaleString('en-US', {minimumFractionDigits: 2})}\n**Daily Target:** ${((daily.total / 2000) * 100).toFixed(1)}% of $2,000`
                    });
                }

                statsEmbed
                    .setTimestamp()
                    .setFooter({ text: 'BIG - Keep pushing for higher AP!' });

                await message.channel.send({ embeds: [statsEmbed] });
                break;
                
            case 'sync':
                // Comando manual para sincronizar con GitHub
                if (message.member.permissions.has('ADMINISTRATOR')) {
                    await message.reply('🔄 Starting GitHub sync...');
                    const success = await syncToGitHub();
                    if (success) {
                        await message.reply('✅ GitHub sync completed successfully');
                    } else {
                        await message.reply('❌ GitHub sync failed - check logs');
                    }
                }
                break;

            case 'help':
            case 'commands':
                const helpEmbed = new EmbedBuilder()
                    .setColor(0x0066CC)
                    .setTitle('📚 **BIG Policy Pulse v5.0 - User Manual**')
                    .setDescription('Annual Premium Tracking System - Pacific Time Zone\n━━━━━━━━━━━━━━━━━━━━━')
                    .addFields(
                        { 
                            name: '💰 **RECORDING SALES**', 
                            value: 'Post in the sales channel:\n\n**Single Sale:**\n`$624 Americo IUL`\n`624$ Americo IUL` (both formats work)\n\n**Multiple Sales (Family/Couple):**\n`His: $4,000 NLG IUL Hers: $2,400 NLG IUL`\n`378$ HIS FORESTERS 378$ HERS FORESTERS`\n\n✅ Bot detects EACH sale separately\n🔇 Bot only reacts with emojis (no messages)'
                        },
                        { 
                            name: '📊 **LEADERBOARD COMMANDS**', 
                            value: '**View AP Rankings:**\n`!leaderboard` - Current AP rankings\n`!leaderboard weekly` - Weekly AP rankings\n`!leaderboard monthly` - Monthly AP rankings\n\n**Aliases:**\n`!lb` - Shortcut for leaderboard\n`!ap` - Same as leaderboard\n`!rankings` - Same as leaderboard'
                        },
                        {
                            name: '📈 **PERSONAL STATS**',
                            value: '`!mystats` - View all your statistics and rankings'
                        },
                        {
                            name: '⭐ **EMOJI REACTIONS**',
                            value: '✅ Sale recorded\n💰 Money earned\n🔥 Total >$1,000\n🚀 Total >$5,000\n⭐ 3+ policies in one message'
                        },
                        {
                            name: '⏰ **AUTOMATIC FEATURES**',
                            value: '• Every 3 hours: AP leaderboard (9am, 12pm, 3pm, 6pm, 9pm Pacific)\n• 10:55 PM Pacific: Daily Final + Weekly/Monthly Progress\n• Sundays 10:55 PM: Weekly FINAL\n• Last day 10:55 PM: Monthly FINAL\n• **GitHub sync:** Every 3 hours + Daily at 10:55 PM'
                        },
                        {
                            name: '🔧 **ADMIN COMMANDS**',
                            value: '`!sync` - Force GitHub sync (Admin only)'
                        }
                    )
                    .setFooter({ text: '💼 BIG - v5.0 with GitHub Auto-Sync' })
                    .setTimestamp();
                
                await message.channel.send({ embeds: [helpEmbed] });
                break;

            case 'ping':
                await message.reply('🏓 Pong! Bot is working correctly.');
                break;

            case 'timezone':
            case 'tz':
                const now = new Date();
                const utcTime = now.toLocaleString('en-US', { 
                    timeZone: 'UTC', 
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit', 
                    minute: '2-digit', 
                    hour12: true 
                });
                const pacificTime = now.toLocaleString('en-US', { 
                    timeZone: 'America/Los_Angeles', 
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit', 
                    minute: '2-digit', 
                    hour12: true 
                });
                
                const isDSTNow = isDST();
                const tzEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('🌍 Timezone Information')
                    .setDescription(`**Pacific Time:** ${pacificTime}\n**UTC Time:** ${utcTime}\n**Current Timezone:** ${isDSTNow ? 'PDT (UTC-7)' : 'PST (UTC-8)'}\n\nAll scheduled posts run in Pacific Time!`)
                    .setTimestamp();
                
                await message.channel.send({ embeds: [tzEmbed] });
                break;
        }
    }
});

// Helper function for DST check
function isDST(date = new Date()) {
    const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
    return Math.max(jan, jul) !== date.getTimezoneOffset();
}

// Error handling
client.on('error', error => {
    console.error('❌ Bot error:', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled error:', error);
});

client.on('disconnect', () => {
    console.log('⚠️ Bot disconnected, attempting to reconnect...');
});

client.on('reconnecting', () => {
    console.log('🔄 Reconnecting...');
});

// Start bot
async function start() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 BIG POLICY PULSE v5.1 🚀       ║');
    console.log('║   Fixed Monthly Filter Edition         ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log('⏳ Starting AP tracking system...');
    console.log(`📁 Using data directory: ${DATA_DIR}`);
    console.log(`🌐 Server port: ${PORT}`);
    
    await loadData();
    
    try {
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error('❌ Error connecting to Discord:', error.message);
        console.log('\n🔍 Please verify:');
        console.log('   1. DISCORD_TOKEN in environment variables');
        console.log('   2. Bot is created in Discord Developer Portal');
        console.log('   3. Bot has proper permissions');
        process.exit(1);
    }
}

start();
