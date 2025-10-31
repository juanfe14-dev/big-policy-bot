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
        <p>Uptime: ${status.uptime}s</p>
        <p>Timestamp: ${status.timestamp}</p>
        <p>Endpoints: <code>/</code>, <code>/health</code>, <code>/ping</code></p>
    `);
});

app.get('/health', (req, res) => {
    res.status(200).json({ ok: true, ts: Date.now() });
});

// Ping endpoint para monitoreo
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

app.listen(PORT, () => {
    console.log(`🌐 Express listening on :${PORT}`);
    console.log(`📡 Health check available at http://0.0.0.0:${PORT}/health`);
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
        daily: null,
        weekly: null,
        monthly: null,
        weeklyTag: null,
        monthlyTag: null
    }
};

// Utilidades de fecha/hora
function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    var weekNo = Math.ceil((((d - yearStart) / 86400000) + 1)/7);
    return weekNo;
}

function getPacificDate() {
    const now = new Date();
    return new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

// Guardar
async function saveData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
        console.log(`💾 Data saved to: ${DATA_FILE}`);
    } catch (error) {
        console.error('❌ Error saving data:', error);
    }
}

// Cargar
async function loadData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        try {
            await fs.access(DATA_FILE);
            const data = await fs.readFile(DATA_FILE, 'utf8');
            salesData = JSON.parse(data);
            if (!salesData.daily) salesData.daily = {};
            if (!salesData.weekly) salesData.weekly = {};
            if (!salesData.monthly) salesData.monthly = {};
            if (!salesData.allTime) salesData.allTime = {};
            if (!salesData.lastReset) salesData.lastReset = { daily:null, weekly:null, monthly:null, weeklyTag:null, monthlyTag:null };
            if (!salesData.lastReset.weeklyTag) salesData.lastReset.weeklyTag = null;
            if (!salesData.lastReset.monthlyTag) salesData.lastReset.monthlyTag = null;
            if (!salesData.dailySnapshot) salesData.dailySnapshot = {};
            if (!salesData.weeklySnapshot) salesData.weeklySnapshot = {};
            if (!salesData.monthlySnapshot) salesData.monthlySnapshot = {};
            console.log('🗂️ Data loaded');
        } catch (e) {
            console.log('📝 No data file, creating new');
            await saveData();
        }
    } catch (error) {
        console.error('❌ Error in loadData:', error);
        await saveData();
    }
}

// ========================================
// GITHUB SYNC (parche para Render)
// ========================================
async function syncToGitHub() {
    if (!process.env.GITHUB_TOKEN) {
        console.log('⚠️ No GitHub token configured, skipping GitHub sync');
        return false;
    }
    
    try {
        console.log('🔄 Starting GitHub sync...');
        // Render-safe Git settings
        await execPromise('rm -f .git/index.lock').catch(() => {});
        await execPromise('git config --global --add safe.directory /opt/render/project/src').catch(() => {});
        await execPromise('git config --global commit.gpgsign false').catch(() => {});
        
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
        await execPromise(`git add -f ${DATA_FILE}`);
        
        // Verificar si hay cambios para commitear (usar staged diff)
        const staged = await execPromise('git diff --cached --name-only').catch(() => ({ stdout: '' }));
        if (!staged.stdout || !staged.stdout.trim()) {
            console.log('ℹ️ No staged changes; skipping commit');
            try { await execPromise('git push origin main'); } catch (_) {}
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
            const out = (commitError.stdout || '') + (commitError.stderr || '');
            if (/nothing to commit/i.test(out)) {
                console.log('ℹ️ Nothing to commit; continuing without error');
            } else {
                console.log('Trying alternative commit...');
                await execPromise(`git commit -m "Auto-update sales data"`).catch(() => { throw commitError; });
            }
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

// ========================================
// PARSER DE VENTAS + RANKINGS + EMBEDS (tu lógica original)
// ========================================
// ...
// (Por brevedad aquí asumo que todo tu bloque original de parseo, cálculo de rankings,
// generación de embeds y helpers sigue intacto. En tu archivo real, este bloque ya está presente.)
// ...

// ========================================
// HANDLER DE MENSAJES (con debug opcional y fallback de embeds)
// ========================================
client.on('messageCreate', async message => {
    if (process.env.DEBUG_COMMANDS === '1') {
        console.log(`[CMD] #${message.channel?.id || 'dm'} ${message.author?.tag || 'unknown'}: ${(message.content || '').slice(0,200)}`);
    }
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
                        sale.type
                    );

                    totalAmount += sale.amount;

                    try {
                        await message.react('✅');
                        await message.react('💰');

                        if (totalAmount > 1000) await message.react('🔥');
                        if (sales.length >= 3) await message.react('⭐');
                    } catch (e) {
                        console.log('Reaction error:', e.message);
                    }
                }
            }

            if (totalAmount > 0) {
                await saveData();
            }

            return;
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
                    try {
                        await message.channel.send({ embeds: [generateAPLeaderboard(validPeriods[period])] });
                    } catch (e) {
                        console.error('Embed send failed (leaderboard):', e?.message || e);
                        await message.channel.send('ℹ️ I cannot send embeds here. Please enable **Embed Links** for my role or try another channel.');
                    }
                } else {
                    await message.reply('Usage: `!leaderboard [daily|weekly|monthly]`');
                }
                break;

            case 'mysales':
            case 'mystats':
                try {
                    const userId = message.author.id;
                    const username = message.author.username;
                    const { daily, weekly, monthly, allTime } = getUserSalesStats(userId, username);
                    const statsEmbed = new EmbedBuilder()
                        .setColor(0x00AE86)
                        .setTitle('📈 YOUR SALES STATS')
                        .setDescription('Personal performance overview based on Annual Premium (AP)')
                        .addFields(
                            { name: '📅 **TODAY**', value: `💵 **${(daily.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AP**
📋 **${daily.count || 0} Policies**`, inline: true },
                            { name: '🗓️ **THIS WEEK**', value: `💵 **${(weekly.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AP**
📋 **${weekly.count || 0} Policies**`, inline: true },
                            { name: '📆 **THIS MONTH**', value: `💵 **${(monthly.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AP**
📋 **${monthly.count || 0} Policies**`, inline: true }
                        )
                        .setFooter({ text: 'All rankings based on Annual Premium (AP)' });

                    if (allTime.total > 0) {
                        statsEmbed.addFields({ name: '🌟 **ALL-TIME RECORD**', value: `💎 **${(allTime.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Total AP**
📝 **${allTime.count || 0} Total Policies**` });
                    }

                    try {
                        await message.channel.send({ embeds: [statsEmbed] });
                    } catch (e) {
                        console.error('Embed send failed (stats):', e?.message || e);
                        await message.channel.send('ℹ️ I cannot send embeds here. Please enable **Embed Links** for my role or try another channel.');
                    }
                } catch (err) {
                    console.error('mystats error:', err);
                    await message.reply('⚠️ Error generating your stats.');
                }
                break;

            case 'help':
            case 'commands':
                const helpEmbed = new EmbedBuilder()
                    .setColor(0x7289DA)
                    .setTitle('📚 BIG Policy Pulse v4.7 - User Manual')
                    .setDescription('Annual Premium Tracking System - Pacific Time Zone')
                    .addFields(
                        { name: '💰 RECORDING SALES', value: `Post in the sales channel:

Single Sale:
\`$624 Americo IUL\`
\`624$ Americo IUL\` (both formats work)

Multiple Sales (Family/Couple):
\`His: $4,000 NLG IUL\`  
\`Hers: $2,400 NLG IUL\`
\`378$ HIS FORESTERS\`  
\`378$ HERS FORESTERS\`

✅ Bot detects EACH sale separately
🔇 Bot only reacts with emojis` },
                        { name: '📊 LEADERBOARD COMMANDS', value: `View AP Rankings:
\`!leaderboard\` - Current AP rankings
\`!leaderboard weekly\` - Weekly AP rankings
\`!leaderboard monthly\` - Monthly AP rankings

Aliases:
\`!lb\`, \`!ap\`, \`!rankings\`` },
                        { name: '📈 PERSONAL STATS', value: '`!mystats` - View all your statistics and rankings' },
                        { name: '⭐ EMOJI REACTIONS', value: `✅ Sale recorded
💰 Money earned
🔥 Total >$1,000
🚀 Total >$5,000
⭐ 3+ policies in one message` },
                        { name: '⏰ AUTOMATIC REPORTS (PST/PDT)', value: `AP leaderboard posts automatically:
• Every 3 hours (9am, 12pm, 3pm, 6pm, 9pm Pacific)
• Daily close at 10:55 PM Pacific:
  - Daily Final Standings
  - Weekly Progress (week-to-date)
  - Monthly Progress (month-to-date)
• Weekly FINAL summary Sundays 10:55 PM Pacific
• Monthly FINAL summary last day 10:55 PM Pacific
🌙 Quiet hours: 12 AM - 8 AM (no automatic messages)` },
                        { name: '🏆 ANNUAL PREMIUM FOCUS', value: `All rankings based on total Annual Premium (AP)
Focus on total sales amount, not policy count
Weekly progress shown every night at 10:55 PM` }
                    );

                try {
                    await message.channel.send({ embeds: [helpEmbed] });
                } catch (e) {
                    console.error('Embed send failed (help):', e?.message || e);
                    await message.channel.send('ℹ️ I cannot send embeds here. Please enable **Embed Links** for my role or try another channel.');
                }
                } catch (e) {
                    console.error('Embed send failed (help):', e?.message || e);
                    await message.channel.send('ℹ️ I cannot send embeds here. Please enable **Embed Links** for my role or try another channel.');
                }
                break;

            case 'ping':
                await message.reply('🏓 Pong! I\'m alive.');
                break;

            case 'sync':
                await message.reply('🔁 Syncing data to GitHub…');
                try {
                    await loadData();
                    const result = await syncToGitHub();
                    await message.reply(result ? '✅ Sync complete' : '⚠️ Sync finished with warnings');
                } catch (err) {
                    console.error('❌ Error during sync:', err && err.message ? err.message : err);
                    await message.reply('❌ Error syncing to GitHub. Check logs.');
                }
                break;
        }
    }
});

// ========================================
// RESET SCHEDULES (ejemplo)
// ========================================
function checkResets() {
    const pacificTime = getPacificDate();

    const currentDay = pacificTime.toDateString();
    const currentWeek = `${pacificTime.getFullYear()}-W${getWeekNumber(pacificTime)}`;
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

    // Weekly reset (Monday tag)
    const lastWeekReset = `${currentYear}-W${getWeekNumber(pacificTime)}`;
    if (!salesData.lastReset.weeklyTag || salesData.lastReset.weeklyTag !== lastWeekReset) {
        if (pacificTime.getDay() === 1) { // Monday
            salesData.weeklySnapshot = JSON.parse(JSON.stringify(salesData.weekly));
            salesData.weekly = {};
            salesData.lastReset.weekly = getWeekNumber(pacificTime);
            salesData.lastReset.weeklyTag = lastWeekReset;
            wasReset = true;
            console.log(`🔄 Weekly reset executed for ${lastWeekReset}`);
        }
    }

    // Monthly reset (1st day)
    const lastMonthReset = `${currentYear}-M${currentMonth}`;
    if (!salesData.lastReset.monthlyTag || salesData.lastReset.monthlyTag !== lastMonthReset) {
        if (pacificTime.getDate() === 1) {
            salesData.monthlySnapshot = JSON.parse(JSON.stringify(salesData.monthly));
            salesData.monthly = {};
            salesData.lastReset.monthly = currentMonth;
            salesData.lastReset.monthlyTag = lastMonthReset;
            wasReset = true;
            console.log(`🔄 Monthly reset executed for month ${currentMonth+1}/${currentYear}`);
        }
    }

    if (wasReset) {
        saveData().catch(()=>{});
    }
}

// CRON
cron.schedule('*/30 * * * *', () => {
    try { checkResets(); } catch (_) {}
});

// START
(async function start() {
    await loadData();
    if (!process.env.DISCORD_TOKEN) {
        console.error('❌ DISCORD_TOKEN not set. Set it in your environment.');
        return;
    }
    try {
        await client.login(process.env.DISCORD_TOKEN);
        console.log('✅ Discord bot logged in');
    } catch (e) {
        console.error('❌ Failed to login to Discord:', e && e.message ? e.message : e);
    }
})();
