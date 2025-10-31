require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const http = require('http');
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

// Mantener despierto en Render
if (process.env.RENDER) {
    setInterval(() => {
        try {
            let target = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}/health`;
            if (!/^https?:\/\//i.test(target)) {
                target = `https://${target}`;
            }
            const client = target.startsWith('https://') ? https : http;
            client.get(target, (r) => r.resume()).on('error', () => {});
        } catch (_) {}
    }, 5 * 60 * 1000);
}
    }, 5 * 60 * 1000);
}

app.listen(PORT, () => {
    console.log(`🌐 Express listening on :${PORT}`);
    console.log(`📡 Health check available at http://0.0.0.0:${PORT}/health`);
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
    lastReset: {
        daily: null,
        weekly: null,
        monthly: null,
        monthlyTag: null
    },
    dailySnapshot: {},
    weeklySnapshot: {},
    monthlySnapshot: {}
};

// Load data
async function loadData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        
        try {
            await fs.access(DATA_FILE);
            const data = await fs.readFile(DATA_FILE, 'utf8');
            salesData = JSON.parse(data);
            if (!salesData || typeof salesData !== 'object') throw new Error('Invalid JSON');
            if (!salesData.daily) salesData.daily = {};
            if (!salesData.weekly) salesData.weekly = {};
            if (!salesData.monthly) salesData.monthly = {};
            if (!salesData.lastReset) salesData.lastReset = { daily: null, weekly: null, monthly: null, monthlyTag: null };
            if (!salesData.dailySnapshot) salesData.dailySnapshot = {};
            if (!salesData.weeklySnapshot) salesData.weeklySnapshot = {};
            if (!salesData.monthlySnapshot) salesData.monthlySnapshot = {};
            
            console.log(`🗂️  Loaded sales data from ${DATA_FILE}`);
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

// Save data
async function saveData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
        console.log(`💾 Data saved to ${DATA_FILE}`);
    } catch (error) {
        console.error('❌ Error saving data:', error);
    }
}

// ========================================
// FUNCIÓN PARA SINCRONIZAR CON GITHUB
// ========================================
async function syncToGitHub() {
    if (!process.env.GITHUB_TOKEN) {
        console.log('⚠️ No GitHub token configured, skipping GitHub sync');
        return false;
    }
    
    try {
        console.log('🔄 Starting GitHub sync...');
        
        // Render-safe Git settings (para contenedores como Render)
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
        
        // Verificar si hay cambios para commitear (usar staged diff en vez de porcelain)
        const staged = await execPromise('git diff --cached --name-only').catch(() => ({ stdout: '' }));
        if (!staged.stdout || !staged.stdout.trim()) {
            console.log('ℹ️ No staged changes; skipping commit');
            // Intentar push de todas formas para asegurar upstream
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
// UTILIDADES (se mantienen como en tu archivo original)
// ========================================

// Get week number
function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    var weekNo = Math.ceil((((d - yearStart) / 86400000) + 1)/7);
    return weekNo;
}

// Check period resets
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

    // Weekly reset (lunes)
    const dayOfWeek = pacificTime.getDay();
    const isMonday = dayOfWeek === 1;
    if (isMonday && salesData.lastReset.weekly !== currentWeek) {
        salesData.weeklySnapshot = JSON.parse(JSON.stringify(salesData.weekly));
        salesData.weekly = {};
        salesData.lastReset.weekly = currentWeek;
        wasReset = true;
        console.log(`🔄 Weekly reset executed for week ${currentWeek}`);
    }

    // Monthly reset (día 1)
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

// AQUI VAN EL RESTO DE TUS HANDLERS Y LÓGICA ORIGINALES...
// (Se conservan sin cambios; este es el parche mínimo para que el sync funcione en Render)

// ========================================
// COMANDO !sync EN DISCORD
// ========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = (message.content || '').trim();

    if (content === '!sync') {
        const reply = await message.reply('🔁 Syncing data to GitHub…');
        try {
            await loadData(); // asegurar archivo antes de sync
            const result = await syncToGitHub();
            await reply.edit(result ? '✅ Sync complete' : '⚠️ Sync finished with warnings');
        } catch (err) {
            console.error('❌ Error during sync:', err && err.message ? err.message : err);
            await reply.edit('❌ Error syncing to GitHub. Check logs.');
        }
    }
});

// ========================================
// ARRANQUE DEL BOT
// ========================================
async function start() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 BIG POLICY PULSE v5.0 🚀       ║');
    console.log('║   GitHub Auto-Sync Edition            ║');
    console.log('╚════════════════════════════════════════╝');

    await loadData();

    if (!process.env.DISCORD_TOKEN) {
        console.error('❌ DISCORD_TOKEN not set. Set it in your environment.');
    } else {
        try {
            await client.login(process.env.DISCORD_TOKEN);
            console.log('✅ Discord bot logged in');
        } catch (e) {
            console.error('❌ Failed to login to Discord:', e && e.message ? e.message : e);
        }
    }

    // Cron de ejemplo para resets (cada 30 min)
    cron.schedule('*/30 * * * *', () => {
        try { checkResets(); } catch (_) {}
    });
}

start().catch(console.error);
