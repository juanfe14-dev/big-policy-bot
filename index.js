require('dotenv').config();
// ===================== Imports =====================
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const cron = require('node-cron');
const util = require('util');
const { exec } = require('child_process');
const execPromise = util.promisify(exec);

// ===================== Constants =====================
const PROJECT_ROOT = process.env.RENDER ? '/opt/render/project/src' : process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');
const PORT = process.env.PORT || 10000;

// ===================== Express (health) =====================
const app = express();
app.get('/', (req, res) => { res.status(200).send('OK'); });
app.get('/health', (req, res) => { res.status(200).json({ ok: true, ts: Date.now() }); });
app.listen(PORT, () => { console.log(`🌐 Express listening on :${PORT}`); });

// Optional keep-alive ping (safe)
if (process.env.RENDER) {
  setInterval(() => {
    try {
      let target = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}/health`;
      if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
      const client = target.startsWith('https://') ? https : http;
      client.get(target, (r) => r.resume()).on('error', () => {});
    } catch (_) {}
  }, 5 * 60 * 1000);
}

// ===================== Data =====================
let salesData = {
  daily: {},
  weekly: {},
  monthly: {},
  allTime: {},
  lastReset: { dailyTag: null, weeklyTag: null, monthlyTag: null }
};

async function ensureDirs() { await fs.mkdir(DATA_DIR, { recursive: true }); }
async function saveData() { await ensureDirs(); await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2)); }
async function loadData() {
  try {
    await ensureDirs();
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    salesData = Object.assign({ daily:{}, weekly:{}, monthly:{}, allTime:{}, lastReset:{} }, parsed);
    salesData.lastReset = Object.assign({ dailyTag:null, weeklyTag:null, monthlyTag:null }, salesData.lastReset||{});
    console.log('🗂️ Loaded data');
  } catch(_) {
    console.log('ℹ️ No existing data, creating new file');
    await saveData();
  }
}

// ===================== Time helpers =====================
function pacificNow(){ return new Date(new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'})); }
function dayTag(d=pacificNow()){ return d.toISOString().slice(0,10); }
function weekNumber(d){ const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); date.setUTCDate(date.getUTCDate()+4-(date.getUTCDay()||7)); const yearStart=new Date(Date.UTC(date.getUTCFullYear(),0,1)); return Math.ceil((((date-yearStart)/864e5)+1)/7); }
function weekTag(d=pacificNow()){ return `${d.getFullYear()}-W${weekNumber(d)}`; }
function monthTag(d=pacificNow()){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }

function checkResets(){
  const d = pacificNow();
  const dTag = dayTag(d), wTag = weekTag(d), mTag = monthTag(d);
  let changed=false;
  if(salesData.lastReset.dailyTag!==dTag){ salesData.daily={}; salesData.lastReset.dailyTag=dTag; changed=true; console.log('🔄 Daily reset'); }
  if(salesData.lastReset.weeklyTag!==wTag && d.getDay()===1){ salesData.weekly={}; salesData.lastReset.weeklyTag=wTag; changed=true; console.log('🔄 Weekly reset'); }
  if(salesData.lastReset.monthlyTag!==mTag && d.getDate()===1){ salesData.monthly={}; salesData.lastReset.monthlyTag=mTag; changed=true; console.log('🔄 Monthly reset'); }
  if(changed) saveData().catch(()=>{});
}

cron.schedule('*/30 * * * *', () => { try{ checkResets(); }catch(_){} });

// ===================== Sales parsing =====================
// "$624 Americo IUL", "624$ Americo IUL"
// "His: $4,000 NLG IUL  Hers: $2,400 NLG IUL"
// "378$ HIS FORESTERS" / "378$ HERS FORESTERS"
function parseMultipleSales(text){
  if(!text) return [];
  const out=[];
  const t = String(text).replace(/\s+/g,' ').trim();

  // Pattern 1: labeled His/Hers blocks
  const hisHers = /\b(?:his|hers)\s*:\s*\$?([\d,.]+)\b/gi;
  let m; while((m=hisHers.exec(t))){
    const amount = parseFloat(m[1].replace(/,/g,''));
    if(amount>0) out.push({ amount, type:'AP' });
  }

  // Pattern 2: generic $amount anywhere
  const any = /\$\s*([\d,.]+)/g; let n; while((n=any.exec(t))){
    const amount = parseFloat(n[1].replace(/,/g,''));
    if(amount>0) out.push({ amount, type:'AP' });
  }

  // Pattern 3: 123$ format
  const trailing = /\b([\d,.]+)\s*\$/g; let k; while((k=trailing.exec(t))){
    const amount = parseFloat(k[1].replace(/,/g,''));
    if(amount>0) out.push({ amount, type:'AP' });
  }

  // De-dup same amounts from overlapping patterns
  if(out.length>1){
    const seen=new Set(); const uniq=[];
    for(const s of out){ const key = s.amount.toFixed(2); if(!seen.has(key)){ seen.add(key); uniq.push(s); } }
    return uniq;
  }
  return out;
}

function addSale(userId, username, amount){
  function bump(bucket){
    const cur = bucket[userId] || { username, total:0, count:0 };
    if(username && username!==cur.username) cur.username=username;
    cur.total += amount; cur.count += 1; bucket[userId]=cur;
  }
  bump(salesData.daily); bump(salesData.weekly); bump(salesData.monthly); bump(salesData.allTime);
}

// ===================== Leaderboard / Stats =====================
function sortedEntries(obj){ return Object.entries(obj).sort((a,b)=> b[1].total - a[1].total); }
function numberUSD(n){ return n.toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2}); }

function generateAPLeaderboard(period){
  const data = salesData[period] || {};
  const entries = sortedEntries(data);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🏆 AP Leaderboard — ${period.toUpperCase()}`)
    .setFooter({ text: 'All rankings based on Annual Premium (AP)' })
    .setTimestamp(pacificNow());

  if(entries.length===0){ embed.setDescription('No sales recorded yet.'); return embed; }

  const top = entries.slice(0,10);
  const rest = entries.slice(10);

  embed.addFields({ name:'Top 10', value: top.map(([uid,u],i)=>`${i+1}. **${u.username}** — $**${numberUSD(u.total)}**  (${u.count})`).join('\n') });
  if(rest.length){
    embed.addFields({ name:'Others', value: rest.map(([uid,u])=>`• ${u.username} — $${numberUSD(u.total)} (${u.count})`).join('\n').slice(0,1000) });
  }
  const totalAP = entries.reduce((s, [,u])=> s+u.total, 0);
  const totalPolicies = entries.reduce((s, [,u])=> s+u.count, 0);
  const avg = totalPolicies? totalAP/totalPolicies : 0;
  embed.addFields({ name:'Totals', value:`Sales: **${totalPolicies}**\nAP: **$${numberUSD(totalAP)}**\nAvg AP/policy: **$${numberUSD(avg)}**` });
  return embed;
}

function getUserSalesStats(userId, username){
  function pull(bucket){
    const u = bucket[userId] || { username, total:0, count:0 };
    bucket[userId]=u; return u;
  }
  return { daily: pull(salesData.daily), weekly: pull(salesData.weekly), monthly: pull(salesData.monthly), allTime: pull(salesData.allTime) };
}

// ===================== Discord Client =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
client.once('ready', ()=>{ console.log(`🤖 Logged in as ${client.user.tag}`); });

client.on('messageCreate', async (message)=>{
  if(process.env.DEBUG_COMMANDS==='1') console.log(`[MSG] ${message.author?.tag}: ${message.content}`);
  if(message.author.bot) return;

  // Record sales only in specific channel if provided
  const salesChannelId = process.env.SALES_CHANNEL_ID;
  if(!salesChannelId || message.channel?.id === salesChannelId){
    const parsed = parseMultipleSales(message.content);
    if(parsed.length){
      let total=0; for(const s of parsed){ addSale(message.author.id, message.author.username, s.amount); total+=s.amount; }
      try{ await message.react('✅'); await message.react('💰'); if(total>1000) await message.react('🔥'); if(parsed.length>=3) await message.react('⭐'); }catch(_){}
      await saveData();
      return; // do not process as command
    }
  }

  // Commands
  if(!message.content || !message.content.startsWith('!')) return;
  const args = message.content.slice(1).trim().split(/\s+/);
  const command = (args.shift()||'').toLowerCase();

  try{
    switch(command){
      case 'ping':
        await message.reply('🏓 Pong!');
        break;

      case 'help':
      case 'commands':{
        const help = new EmbedBuilder()
          .setColor(0x7289DA)
          .setTitle('📚 BIG Policy Pulse v4.7 - User Manual')
          .setDescription('Annual Premium Tracking System - Pacific Time Zone')
          .addFields(
            { name:'💰 RECORDING SALES', value:'Post in the sales channel:\n\nSingle Sale:\n`$624 Americo IUL`\n`624$ Americo IUL` (both formats work)\n\nMultiple Sales (Family/Couple):\n`His: $4,000 NLG IUL`\n`Hers: $2,400 NLG IUL`\n`378$ HIS FORESTERS`\n`378$ HERS FORESTERS`\n\n✅ Bot detects EACH sale separately\n🔇 Bot only reacts with emojis' },
            { name:'📊 LEADERBOARD COMMANDS', value:'View AP Rankings:\n`!leaderboard` - Current AP rankings\n`!leaderboard weekly` - Weekly AP rankings\n`!leaderboard monthly` - Monthly AP rankings\n\nAliases:\n`!lb`, `!ap`, `!rankings`' },
            { name:'📈 PERSONAL STATS', value:'`!mystats` - View all your statistics and rankings' },
            { name:'⭐ EMOJI REACTIONS', value:'✅ Sale recorded\n💰 Money earned\n🔥 Total >$1,000\n🚀 Total >$5,000\n⭐ 3+ policies in one message' },
            { name:'⏰ AUTOMATIC REPORTS (PST/PDT)', value:'AP leaderboard posts automatically:\n• Every 3 hours (9am, 12pm, 3pm, 6pm, 9pm Pacific)\n• Daily close at 10:55 PM Pacific:\n  - Daily Final Standings\n  - Weekly Progress (week-to-date)\n  - Monthly Progress (month-to-date)\n• Weekly FINAL summary Sundays 10:55 PM Pacific\n• Monthly FINAL summary last day 10:55 PM Pacific\n🌙 Quiet hours: 12 AM - 8 AM (no automatic messages)' },
            { name:'🏆 ANNUAL PREMIUM FOCUS', value:'All rankings based on total Annual Premium (AP)\nFocus on total sales amount, not policy count\nWeekly progress shown every night at 10:55 PM' }
          );
        try{ await message.channel.send({ embeds:[help] }); } catch(e){ await message.channel.send('ℹ️ I cannot send embeds here. Please enable **Embed Links** for my role or try another channel.'); }
        break; }

      case 'leaderboard':
      case 'lb':
      case 'ap':
      case 'rankings':{
        const arg = (args[0]||'daily').toLowerCase();
        const map = { daily:'daily', day:'daily', today:'daily', weekly:'weekly', week:'weekly', monthly:'monthly', month:'monthly' };
        const period = map[arg] || 'daily';
        const embed = generateAPLeaderboard(period);
        try{ await message.channel.send({ embeds:[embed] }); } catch(e){ await message.channel.send('ℹ️ I cannot send embeds here. Please enable **Embed Links** for my role or try another channel.'); }
        break; }

      case 'mysales':
      case 'mystats':{
        const { daily, weekly, monthly, allTime } = getUserSalesStats(message.author.id, message.author.username);
        const em = new EmbedBuilder()
          .setColor(0x00AE86)
          .setTitle('📈 YOUR SALES STATS')
          .setDescription('Personal performance overview based on Annual Premium (AP)')
          .addFields(
            { name:'📅 TODAY', value:`💵 **$${numberUSD(daily.total||0)}**\n📋 **${daily.count||0} Policies**`, inline:true },
            { name:'🗓️ THIS WEEK', value:`💵 **$${numberUSD(weekly.total||0)}**\n📋 **${weekly.count||0} Policies**`, inline:true },
            { name:'📆 THIS MONTH', value:`💵 **$${numberUSD(monthly.total||0)}**\n📋 **${monthly.count||0} Policies**`, inline:true }
          )
          .setFooter({ text:'All rankings based on Annual Premium (AP)' });
        if((allTime.total||0)>0) em.addFields({ name:'🌟 ALL-TIME RECORD', value:`💎 **$${numberUSD(allTime.total||0)} Total AP**\n📝 **${allTime.count||0} Total Policies**` });
        try{ await message.channel.send({ embeds:[em] }); } catch(e){ await message.channel.send('ℹ️ I cannot send embeds here. Please enable **Embed Links** for my role or try another channel.'); }
        break; }

      case 'sync':{
        const isAdmin = message.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
        if(!isAdmin){ await message.reply('⛔ Requires Administrator.'); break; }
        const msg = await message.reply('🔁 Syncing data to GitHub…');
        try{ await loadData(); const ok = await syncToGitHub(); await msg.edit(ok? '✅ Sync complete' : '⚠️ Sync finished with warnings'); }
        catch(err){ console.error('❌ Error during sync:', err?.message||err); await msg.edit('❌ Error syncing to GitHub. Check logs.'); }
        break; }

      default:
        break;
    }
  }catch(err){
    console.error('Command handler error:', err);
    try{ await message.reply('⚠️ Error running command.'); }catch(_){ }
  }
});

// ===================== Git Sync (Render-safe) =====================
async function syncToGitHub(){
  if(!process.env.GITHUB_TOKEN){ console.log('⚠️ No GITHUB_TOKEN set'); return false; }
  console.log('🔄 Starting GitHub sync...');
  const run = (cmd)=> execPromise(cmd, { cwd: PROJECT_ROOT, env:{...process.env, GIT_ASKPASS:'echo'} });
  try{
    await run('rm -f .git/index.lock').catch(()=>{});
    await run(`git config --global --add safe.directory ${PROJECT_ROOT}`).catch(()=>{});
    await run('git config --global commit.gpgsign false').catch(()=>{});

    // ensure repo
    const isRepo = await run('git rev-parse --is-inside-work-tree').then(()=>true).catch(()=>false);
    if(!isRepo) await run('git init');

    await run('git config user.email "bot@bigpolicy.com"').catch(()=>{});
    await run('git config user.name "BIG Policy Bot"').catch(()=>{});

    const remoteUrl = `https://${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_OWNER||'juanfe14-dev'}/${process.env.GITHUB_REPO||'big-policy-bot'}.git`;
    await run('git remote remove origin').catch(()=>{});
    await run(`git remote add origin ${remoteUrl}`);

    await run('git fetch origin main').catch(()=>{});
    await run('git checkout -B main').catch(()=> run('git checkout -b main'));
    await run('git branch --set-upstream-to=origin/main main').catch(()=>{});
    await run('git pull --no-rebase --allow-unrelated-histories origin main').catch(()=>{});

    await ensureDirs(); try{ await fs.access(DATA_FILE); }catch(_){ await saveData(); }

    await run('git add -f data/sales.json');
    const staged = await run('git diff --cached --name-only').then(r=>r.stdout.trim()).catch(()=> '');
    if(!staged){ console.log('ℹ️ No staged changes; skipping commit'); await run('git push origin main').catch(()=>{}); return true; }

    const bogotaTime = new Date().toLocaleString('en-US', { timeZone:'America/Bogota' });
    const msg = `Auto-update sales data - ${bogotaTime}`;
    try{ await run(`git commit -m "${msg.replace(/"/g,'\\"')}"`); }
    catch(e){ const out=(e.stdout||'')+(e.stderr||''); if(/nothing to commit/i.test(out)){ console.log('ℹ️ Nothing to commit; continuing'); } else { await run('git commit -m "Auto-update sales data"').catch(()=>{ throw e; }); } }

    await run('git push origin main');
    console.log('✅ Pushed to GitHub');
    return true;
  }catch(err){ console.error('❌ Git sync error:', err?.message||err); return false; }
}

// ===================== Boot =====================
(async function start(){
  await loadData();
  if(!process.env.DISCORD_TOKEN){ console.error('❌ DISCORD_TOKEN not set.'); return; }
  try{ await client.login(process.env.DISCORD_TOKEN); console.log('✅ Discord bot logged in'); }
  catch(e){ console.error('❌ Failed to login to Discord:', e?.message||e); }
})();
