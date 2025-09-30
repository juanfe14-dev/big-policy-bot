require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

// Data file - Using Railway persistent volume
// If volume is mounted at /app/data, use it. Otherwise fallback to local
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');

console.log(`📁 Data directory: ${DATA_DIR}`);

// Data structure
let salesData = {
    daily: {},
    weekly: {},
    monthly: {},
    allTime: {},
    dailySnapshot: {}, // Snapshot for final daily report
    weeklySnapshot: {}, // Snapshot for final weekly report
    monthlySnapshot: {}, // Snapshot for final monthly report
    lastReset: {
        daily: new Date().toDateString(),
        weekly: getWeekNumber(new Date()),
        monthly: new Date().getMonth()
    }
};

// Load data
async function loadData() {
    try {
        // Ensure the data directory exists
        await fs.mkdir(DATA_DIR, { recursive: true });
        
        // Check if file exists
        try {
            await fs.access(DATA_FILE);
            const data = await fs.readFile(DATA_FILE, 'utf8');
            salesData = JSON.parse(data);
            console.log('📂 Data loaded successfully from:', DATA_FILE);
            
            // Log current data stats
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
        // Ensure directory exists before saving
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
        console.log(`💾 Data saved to: ${DATA_FILE}`);
    } catch (error) {
        console.error('❌ Error saving data:', error);
        console.error('   File path:', DATA_FILE);
        console.error('   Directory:', DATA_DIR);
    }
}

// Get week number
function getWeekNumber(date) {
    const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

// Check period resets - Now timezone aware and saves snapshots
function checkResets() {
    // Get current Pacific Time
    const now = new Date();
    const pacificTime = new Date(now.toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
    
    const currentDay = pacificTime.toDateString();
    const currentWeek = getWeekNumber(pacificTime);
    const currentMonth = pacificTime.getMonth();

    let wasReset = false;

    // Daily reset - Save snapshot before reset
    if (salesData.lastReset.daily !== currentDay) {
        // Save snapshot of yesterday's data before reset
        salesData.dailySnapshot = JSON.parse(JSON.stringify(salesData.daily));
        salesData.daily = {};
        salesData.lastReset.daily = currentDay;
        wasReset = true;
        console.log('🔄 Daily reset executed - Snapshot saved');
    }

    // Weekly reset - Save snapshot before reset
    if (salesData.lastReset.weekly !== currentWeek) {
        // Save snapshot of last week's data before reset
        salesData.weeklySnapshot = JSON.parse(JSON.stringify(salesData.weekly));
        salesData.weekly = {};
        salesData.lastReset.weekly = currentWeek;
        wasReset = true;
        console.log('🔄 Weekly reset executed - Snapshot saved');
    }

    // Monthly reset - Save snapshot before reset
    if (salesData.lastReset.monthly !== currentMonth) {
        // Save snapshot of last month's data before reset
        salesData.monthlySnapshot = JSON.parse(JSON.stringify(salesData.monthly));
        salesData.monthly = {};
        salesData.lastReset.monthly = currentMonth;
        wasReset = true;
        console.log('🔄 Monthly reset executed - Snapshot saved');
    }

    if (wasReset) {
        saveData();
    }
}

// Parse MULTIPLE sales from a single message
function parseMultipleSales(message) {
    // Handle multi-line messages - join all lines
    const fullMessage = message.replace(/\n/g, ' ');
    
    // Find ALL dollar amounts in the message
    const pattern = /\$\s*([\d,]+(?:\.\d{2})?)/g;
    const matches = [...fullMessage.matchAll(pattern)];
    
    if (!matches || matches.length === 0) {
        return [];
    }
    
    const sales = [];
    
    // Process each dollar amount found
    matches.forEach((match, index) => {
        // Extract amount
        const amount = parseFloat(match[1].replace(/,/g, ''));
        
        // Get text between this dollar amount and the next (or end of message)
        const startPos = match.index + match[0].length;
        const endPos = matches[index + 1] ? matches[index + 1].index : fullMessage.length;
        let policyText = fullMessage.substring(startPos, endPos).trim();
        
        // Clean up the policy type
        // Remove labels like "His:", "Hers:", "Child:", etc.
        policyText = policyText.replace(/^(His|Hers|Child|Spouse|Wife|Husband|Son|Daughter|Kid|Parent|Mother|Father):/gi, '').trim();
        
        // Remove Discord custom emojis (:emoji_name:)
        policyText = policyText.replace(/:[a-zA-Z0-9_]+:/g, '').trim();
        
        // Remove all Unicode emojis
        policyText = policyText.replace(/[\u{1F000}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{FE00}-\u{FE0F}]|[\u{1F300}-\u{1F5FF}]|[\u{2000}-\u{3300}]/gu, '').trim();
        
        // Remove @mentions
        policyText = policyText.replace(/@[^\s]+/g, '').trim();
        
        // Remove "w/" or "with" and everything after
        policyText = policyText.replace(/\b(w\/|with)\b.*/gi, '').trim();
        
        // Remove hashtags and everything after
        const hashtagIndex = policyText.indexOf('#');
        if (hashtagIndex > -1) {
            policyText = policyText.substring(0, hashtagIndex).trim();
        }
        
        // Clean up extra spaces and special characters
        policyText = policyText.replace(/[^\w\s-]/g, ' ');
        policyText = policyText.replace(/\s+/g, ' ').trim();
        
        // Look for common policy patterns
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
        
        // Final cleanup
        const words = policyType.split(' ').filter(word => word.length > 0);
        if (words.length > 3) {
            policyType = words.slice(0, 3).join(' ');
        }
        
        if (!policyType || policyType.length < 2) {
            policyType = 'General Policy';
        }
        
        // Capitalize properly
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
    checkResets();
    
    ['daily', 'weekly', 'monthly'].forEach(period => {
        if (!salesData[period][userId]) {
            salesData[period][userId] = { 
                username, 
                total: 0, 
                count: 0,
                policies: {},
                policyDetails: []
            };
        }
        
        salesData[period][userId].total += amount;
        salesData[period][userId].count += 1;
        
        if (!salesData[period][userId].policies[policyType]) {
            salesData[period][userId].policies[policyType] = 0;
        }
        salesData[period][userId].policies[policyType]++;
        
        salesData[period][userId].policyDetails.push({
            amount,
            type: policyType,
            date: new Date().toISOString()
        });
    });

    if (!salesData.allTime) {
        salesData.allTime = {};
    }
    
    if (!salesData.allTime[userId]) {
        salesData.allTime[userId] = {
            username,
            total: 0,
            count: 0
        };
    }
    
    salesData.allTime[userId].total += amount;
    salesData.allTime[userId].count += 1;

    saveData();
}

// Generate AP Leaderboard (sorted by total amount)
function generateAPLeaderboard(period = 'daily', title = '', skipResetCheck = false) {
    // Only check resets if not generating a final report
    if (!skipResetCheck) {
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
        .setColor(0x00FF00) // Green for AP
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
        // Top 3 AP leaders
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

        // Rest of ranking
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

        // Statistics
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

// Generate AP Leaderboard from specific data (for final reports)
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

// Generate Policy Count Leaderboard (sorted by number of policies)
function generatePolicyLeaderboard(period = 'daily', title = '', skipResetCheck = false) {
    // Only check resets if not generating a final report
    if (!skipResetCheck) {
        checkResets();
    }
    
    const data = salesData[period];
    const sorted = Object.entries(data)
        .sort(([,a], [,b]) => b.count - a.count); // Sort by COUNT not total

    const periodTitle = {
        'daily': '📋 DAILY LEADERBOARD',
        'weekly': '📋 WEEKLY LEADERBOARD',
        'monthly': '📋 MONTHLY LEADERBOARD'
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
        .setColor(0x0099FF) // Blue for Policies
        .setTitle(title || periodTitle[period])
        .setDescription(`📋 **Ranked by Number of Policies**\n📍 Date: ${currentDate}\n━━━━━━━━━━━━━━━━━━━━━`)
        .setTimestamp()
        .setFooter({ text: '💼 BIG - Policy Count Rankings' });

    if (sorted.length === 0) {
        embed.addFields({
            name: '📝 No Records',
            value: 'No policies recorded for this period'
        });
    } else {
        // Top 3 policy leaders
        let topDescription = '';
        const top3 = sorted.slice(0, 3);
        
        top3.forEach(([userId, data], index) => {
            const medal = index === 0 ? '🥇 **POLICY LEADER**' : index === 1 ? '🥈 **2nd Place**' : '🥉 **3rd Place**';
            topDescription += `${medal}\n`;
            topDescription += `👤 **${data.username}**\n`;
            topDescription += `📋 **${data.count} Policies**\n`;
            topDescription += `💰 *$${data.total.toLocaleString('en-US', {minimumFractionDigits: 2})} total AP*\n\n`;
        });
        
        embed.addFields({
            name: '🌟 **TOP POLICY WRITERS**',
            value: topDescription || 'No data'
        });

        // Rest of ranking
        if (sorted.length > 3) {
            let restDescription = '';
            const rest = sorted.slice(3, 10);
            
            rest.forEach(([userId, data], index) => {
                restDescription += `**${index + 4}.** ${data.username} - **${data.count} policies** ($${data.total.toLocaleString('en-US', {minimumFractionDigits: 2})})\n`;
            });
            
            if (restDescription) {
                embed.addFields({
                    name: '📈 **Other Agents**',
                    value: restDescription
                });
            }
        }

        // Statistics
        const totalPolicies = Object.values(data).reduce((sum, user) => sum + user.count, 0);
        const activeAgents = sorted.length;
        const avgPoliciesPerAgent = activeAgents > 0 ? totalPolicies / activeAgents : 0;

        embed.addFields({
            name: '📊 **POLICY SUMMARY**',
            value: `**Total Policies:** ${totalPolicies}\n**Active Agents:** ${activeAgents}\n**Avg per Agent:** ${avgPoliciesPerAgent.toFixed(1)}`
        });
    }

    return embed;
}

// Generate Policy Leaderboard from specific data (for final reports)
function generatePolicyLeaderboardFromData(data, title) {
    const sorted = Object.entries(data)
        .sort(([,a], [,b]) => b.count - a.count);

    const currentDate = new Date().toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(title)
        .setDescription(`📋 **Ranked by Number of Policies**\n📍 Date: ${currentDate}\n━━━━━━━━━━━━━━━━━━━━━`)
        .setTimestamp()
        .setFooter({ text: '💼 BIG - Policy Count Rankings' });

    if (sorted.length === 0) {
        embed.addFields({
            name: '📝 No Records',
            value: 'No policies recorded for this period'
        });
    } else {
        let topDescription = '';
        const top3 = sorted.slice(0, 3);
        
        top3.forEach(([userId, data], index) => {
            const medal = index === 0 ? '🥇 **POLICY LEADER**' : index === 1 ? '🥈 **2nd Place**' : '🥉 **3rd Place**';
            topDescription += `${medal}\n`;
            topDescription += `👤 **${data.username}**\n`;
            topDescription += `📋 **${data.count} Policies**\n`;
            topDescription += `💰 *$${data.total.toLocaleString('en-US', {minimumFractionDigits: 2})} total AP*\n\n`;
        });
        
        embed.addFields({
            name: '🌟 **TOP POLICY WRITERS**',
            value: topDescription || 'No data'
        });

        if (sorted.length > 3) {
            let restDescription = '';
            const rest = sorted.slice(3, 10);
            
            rest.forEach(([userId, data], index) => {
                restDescription += `**${index + 4}.** ${data.username} - **${data.count} policies** ($${data.total.toLocaleString('en-US', {minimumFractionDigits: 2})})\n`;
            });
            
            if (restDescription) {
                embed.addFields({
                    name: '📈 **Other Agents**',
                    value: restDescription
                });
            }
        }

        const totalPolicies = Object.values(data).reduce((sum, user) => sum + user.count, 0);
        const activeAgents = sorted.length;
        const avgPoliciesPerAgent = activeAgents > 0 ? totalPolicies / activeAgents : 0;

        embed.addFields({
            name: '📊 **POLICY SUMMARY**',
            value: `**Total Policies:** ${totalPolicies}\n**Active Agents:** ${activeAgents}\n**Avg per Agent:** ${avgPoliciesPerAgent.toFixed(1)}`
        });
    }

    return embed;
}

// Bot ready
client.once('ready', () => {
    console.log(`✅ ${client.user.tag} is online!`);
    console.log('🏢 Boundless Insurance Group - Dual Tracking System');
    console.log(`📊 Sales channel: ${process.env.SALES_CHANNEL_ID}`);
    console.log(`📈 Reports channel: ${process.env.LEADERBOARD_CHANNEL_ID}`);
    console.log('💰 Tracking: AP (Annual Premium) & Policy Count');
    console.log('🔇 Silent mode: Only emoji reactions, no reply messages');
    console.log('📦 Multi-sale detection: Can process multiple sales per message');
    console.log('🕐 Timezone: Pacific Standard Time (PST/PDT)');
    console.log('🌙 Quiet Hours: 12 AM - 8 AM Pacific (no automatic messages)');
    console.log('📊 Daily Final Rankings: 11:55 PM Pacific (preserves full day data)');
    console.log('⏰ Scheduled times for BOTH leaderboards:');
    console.log('   - Every 3 hours: 9am, 12pm, 3pm, 6pm, 9pm PST');
    console.log('   - Daily 11:55 PM PST: Complete dual summary');
    console.log('   - Sundays 11:55 PM PST: Weekly dual rankings');
    console.log('   - Last day of month 11:55 PM PST: Monthly dual rankings');
    console.log('   🌙 NO automatic messages between 12 AM - 8 AM Pacific');
    
    // ==========================================
    // AUTOMATED SCHEDULES - TIMEZONE CORRECTED
    // ==========================================
    
    // IMPORTANT: Cron runs in UTC. We need to adjust for Pacific Time
    // PST = UTC-8 (Nov-Mar), PDT = UTC-7 (Mar-Nov)
    // We'll use a function to determine if we're in DST
    
    function isDST(date = new Date()) {
        const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
        const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
        return Math.max(jan, jul) !== date.getTimezoneOffset();
    }
    
    // Calculate UTC hours for Pacific Time
    function getPacificToUTC(pacificHour) {
        // If we're in DST (PDT), add 7 hours, otherwise add 8 hours (PST)
        const offset = isDST() ? 7 : 8;
        const utcHour = (pacificHour + offset) % 24;
        return utcHour;
    }
    
    // 1. Every 3 hours - Post BOTH leaderboards
    // Pacific times: 9am, 12pm, 3pm, 6pm, 9pm (NO 6am - respecting quiet hours)
    // Convert to UTC based on current DST status
    const threeHourlyPacific = [9, 12, 15, 18, 21];  // Removed 6am
    const threeHourlyUTC = threeHourlyPacific.map(hour => getPacificToUTC(hour));
    const cronSchedule3Hours = `0 ${threeHourlyUTC.join(',')} * * *`;
    
    cron.schedule(cronSchedule3Hours, async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            const pacificTime = new Date().toLocaleString("en-US", {
                timeZone: "America/Los_Angeles",
                hour: '2-digit',
                hour12: true
            });
            
            // Send AP Leaderboard
            await channel.send({ embeds: [generateAPLeaderboard('daily')] });
            
            // Send Policy Leaderboard
            await channel.send({ embeds: [generatePolicyLeaderboard('daily')] });
            
            await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`📊 Both leaderboards updated - ${pacificTime} PST/PDT`);
        }
    }, {
        scheduled: true,
        timezone: "UTC"
    });

    // 2. Daily summary at 11:55 PM Pacific (5 minutes before midnight to ensure correct date)
    const dailyUTCHour = getPacificToUTC(23); // 11 PM Pacific
    cron.schedule(`55 ${dailyUTCHour} * * *`, async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            // Create a copy of current data BEFORE any reset
            const dailyDataCopy = JSON.parse(JSON.stringify(salesData.daily));
            
            await channel.send('📢 **END OF DAY FINAL RANKINGS**');
            
            // Generate leaderboards using the copied data directly
            const apEmbed = generateAPLeaderboardFromData(dailyDataCopy, '💵 DAILY FINAL STANDINGS - COMPLETE');
            apEmbed.setColor(0xFFD700);
            await channel.send({ embeds: [apEmbed] });
            
            const policyEmbed = generatePolicyLeaderboardFromData(dailyDataCopy, '📋 DAILY FINAL STANDINGS - COMPLETE');
            policyEmbed.setColor(0xFFD700);
            await channel.send({ embeds: [policyEmbed] });
            
            await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 Final daily rankings posted - 11:55 PM Pacific with preserved data');
        }
    }, {
        scheduled: true,
        timezone: "UTC"
    });

    // 3. Weekly summary - Sundays at 11:55 PM Pacific
    const weeklyUTCHour = getPacificToUTC(23);
    cron.schedule(`55 ${weeklyUTCHour} * * 0`, async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            // Create a copy of current data BEFORE any reset
            const weeklyDataCopy = JSON.parse(JSON.stringify(salesData.weekly));
            
            await channel.send('🏆 **WEEKLY FINAL RANKINGS**');
            
            // Generate leaderboards using the copied data directly
            const apEmbed = generateAPLeaderboardFromData(weeklyDataCopy, '💵 WEEKLY CHAMPIONS - COMPLETE WEEK');
            apEmbed.setColor(0xFF6B6B);
            await channel.send({ embeds: [apEmbed] });
            
            const policyEmbed = generatePolicyLeaderboardFromData(weeklyDataCopy, '📋 WEEKLY CHAMPIONS - COMPLETE WEEK');
            policyEmbed.setColor(0xFF6B6B);
            await channel.send({ embeds: [policyEmbed] });
            
            await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 Weekly rankings posted - Sunday 11:55 PM Pacific with preserved data');
        }
    }, {
        scheduled: true,
        timezone: "UTC"
    });

    // 4. Monthly summary - Last day of month at 11:55 PM Pacific
    const monthlyUTCHour = getPacificToUTC(23);
    cron.schedule(`55 ${monthlyUTCHour} * * *`, async () => {
        // Check if today is the last day of the month in Pacific Time
        const pacificNow = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
        const tomorrow = new Date(pacificNow);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        // If tomorrow is the 1st, today is the last day of the month
        if (tomorrow.getDate() === 1) {
            const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
            if (channel) {
                // Create a copy of current data BEFORE any reset
                const monthlyDataCopy = JSON.parse(JSON.stringify(salesData.monthly));
                
                await channel.send('🎊 **MONTHLY FINAL RANKINGS - CONGRATULATIONS!** 🎊');
                
                // Generate leaderboards using the copied data directly
                const apEmbed = generateAPLeaderboardFromData(monthlyDataCopy, '💵 MONTHLY CHAMPIONS - COMPLETE MONTH');
                apEmbed.setColor(0xFFD700);
                await channel.send({ embeds: [apEmbed] });
                
                const policyEmbed = generatePolicyLeaderboardFromData(monthlyDataCopy, '📋 MONTHLY CHAMPIONS - COMPLETE MONTH');
                policyEmbed.setColor(0xFFD700);
                await channel.send({ embeds: [policyEmbed] });
                
                await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('📊 Monthly rankings posted - End of month 11:55 PM Pacific with preserved data');
            }
        }
    }, {
        scheduled: true,
        timezone: "UTC"
    });
    
    // Display current timezone info
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
            // Process EACH sale separately
            let totalAmount = 0;
            
            for (const sale of sales) {
                if (sale.amount > 0) {
                    // Add each sale individually
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
            
            // React with emojis based on TOTAL amount
            if (totalAmount > 0) {
                await message.react('✅');
                await message.react('💰');
                
                // Add fire emoji for big total sales
                if (totalAmount >= 1000) {
                    await message.react('🔥');
                }
                
                // Add rocket for huge sales
                if (totalAmount >= 5000) {
                    await message.react('🚀');
                }
                
                // Add star for multiple policies in one message
                if (sales.length >= 3) {
                    await message.react('⭐');
                }
                
                // NO REPLY MESSAGE - Only reactions
                console.log(`📊 Total recorded: ${sales.length} policies, $${totalAmount} total AP`);
            }
        }
    }

    // Commands
    if (message.content.startsWith('!')) {
        const args = message.content.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        switch(command) {
            case 'ap':
            case 'apleaderboard':
            case 'aprank':
                const apPeriod = args[0] || 'daily';
                const apValidPeriods = {
                    'daily': 'daily',
                    'day': 'daily',
                    'today': 'daily',
                    'weekly': 'weekly',
                    'week': 'weekly',
                    'monthly': 'monthly',
                    'month': 'monthly'
                };
                
                if (apValidPeriods[apPeriod]) {
                    await message.channel.send({ embeds: [generateAPLeaderboard(apValidPeriods[apPeriod])] });
                } else {
                    await message.reply('Usage: `!ap [daily|weekly|monthly]`');
                }
                break;

            case 'policies':
            case 'policy':
            case 'policyrank':
                const policyPeriod = args[0] || 'daily';
                const policyValidPeriods = {
                    'daily': 'daily',
                    'day': 'daily',
                    'today': 'daily',
                    'weekly': 'weekly',
                    'week': 'weekly',
                    'monthly': 'monthly',
                    'month': 'monthly'
                };
                
                if (policyValidPeriods[policyPeriod]) {
                    await message.channel.send({ embeds: [generatePolicyLeaderboard(policyValidPeriods[policyPeriod])] });
                } else {
                    await message.reply('Usage: `!policies [daily|weekly|monthly]`');
                }
                break;

            case 'leaderboard':
            case 'lb':
            case 'both':
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
                    // Send BOTH leaderboards without extra title
                    await message.channel.send({ embeds: [generateAPLeaderboard(validPeriods[period])] });
                    await message.channel.send({ embeds: [generatePolicyLeaderboard(validPeriods[period])] });
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

                // Find rankings
                const dailyAPRank = Object.entries(salesData.daily)
                    .sort(([,a], [,b]) => b.total - a.total)
                    .findIndex(([id,]) => id === userId) + 1;
                const dailyPolicyRank = Object.entries(salesData.daily)
                    .sort(([,a], [,b]) => b.count - a.count)
                    .findIndex(([id,]) => id === userId) + 1;

                const statsEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(`📊 ${message.author.username}'s Complete Statistics`)
                    .setThumbnail(message.author.displayAvatarURL())
                    .addFields(
                        { 
                            name: '📅 **TODAY**', 
                            value: `💵 **$${daily.total.toLocaleString('en-US', {minimumFractionDigits: 2})} AP**\n📋 **${daily.count} Policies**\n🏆 AP Rank: #${dailyAPRank || 'N/A'}\n🏆 Policy Rank: #${dailyPolicyRank || 'N/A'}`, 
                            inline: true 
                        },
                        { 
                            name: '📊 **THIS WEEK**', 
                            value: `💵 **$${weekly.total.toLocaleString('en-US', {minimumFractionDigits: 2})} AP**\n📋 **${weekly.count} Policies**`, 
                            inline: true 
                        },
                        { 
                            name: '🏆 **THIS MONTH**', 
                            value: `💵 **$${monthly.total.toLocaleString('en-US', {minimumFractionDigits: 2})} AP**\n📋 **${monthly.count} Policies**`, 
                            inline: true 
                        }
                    );

                if (allTime.total > 0) {
                    statsEmbed.addFields({
                        name: '🌟 **ALL-TIME RECORD**',
                        value: `💎 **$${allTime.total.toLocaleString('en-US', {minimumFractionDigits: 2})} Total AP**\n📝 **${allTime.count} Total Policies**`
                    });
                }

                const monthAverage = monthly.count > 0 ? monthly.total / monthly.count : 0;
                if (monthAverage > 0) {
                    statsEmbed.addFields({
                        name: '📈 **Performance Metrics**',
                        value: `**Avg AP per Policy:** $${monthAverage.toLocaleString('en-US', {minimumFractionDigits: 2})}\n**Daily Target:** ${((daily.total / 2000) * 100).toFixed(1)}% of $2,000`
                    });
                }

                statsEmbed
                    .setTimestamp()
                    .setFooter({ text: 'BIG - Keep pushing for both AP and Policy count!' });

                await message.channel.send({ embeds: [statsEmbed] });
                break;

            case 'help':
            case 'commands':
                const helpEmbed = new EmbedBuilder()
                    .setColor(0x0066CC)
                    .setTitle('📚 **BIG Policy Pulse v4.2 - User Manual**')
                    .setDescription('Dual Tracking System - Pacific Time Zone\n━━━━━━━━━━━━━━━━━━━━━')
                    .addFields(
                        { 
                            name: '💰 **RECORDING SALES**', 
                            value: 'Post in the sales channel:\n\n**Single Sale:**\n`$624 Americo IUL`\n\n**Multiple Sales (Family/Couple):**\n`His: $4,000 NLG IUL Hers: $2,400 NLG IUL`\n`Child: $500 Parents: $3,000 each`\n\n✅ Bot detects EACH sale separately\n🔇 Bot only reacts with emojis (no messages)'
                        },
                        { 
                            name: '📊 **LEADERBOARD COMMANDS**', 
                            value: '**View Both Rankings:**\n`!leaderboard` - Both current rankings\n`!leaderboard weekly` - Both weekly rankings\n`!leaderboard monthly` - Both monthly rankings\n\n**AP Rankings Only:**\n`!ap` - Current AP leaderboard\n`!ap weekly` - Weekly AP leaderboard\n\n**Policy Rankings Only:**\n`!policies` - Current policy leaderboard\n`!policies weekly` - Weekly policy leaderboard'
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
                            name: '⏰ **AUTOMATIC REPORTS (PST/PDT)**',
                            value: 'Both leaderboards post automatically:\n• Every 3 hours (9am, 12pm, 3pm, 6pm, 9pm Pacific)\n• Daily close at 11:55 PM Pacific\n• Weekly summary Sundays 11:55 PM Pacific\n• Monthly summary last day 11:55 PM Pacific\n🌙 **Quiet hours: 12 AM - 8 AM (no automatic messages)**'
                        },
                        {
                            name: '🏆 **DUAL RANKING SYSTEM**',
                            value: '**AP Leaderboard:** Ranked by total dollar amount\n**Policy Leaderboard:** Ranked by number of policies\n\nMultiple sales per message count separately!'
                        }
                    )
                    .setFooter({ text: '💼 BIG - All times in Pacific Time' })
                    .setTimestamp();
                
                await message.channel.send({ embeds: [helpEmbed] });
                break;

            case 'ping':
                await message.reply('🏓 Pong! Bot is working correctly.');
                break;

            case 'timezone':
            case 'tz':
                // Command to check current timezone status
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

            case 'test':
                // Test command to verify parsing (admin only)
                if (message.author.id === message.guild.ownerId || message.member.permissions.has('ADMINISTRATOR')) {
                    const testMessages = [
                        'His: $4,000 NLG IUL Hers: $2,400 NLG IUL',
                        'His: $1,000 NLG IUL Hers: $4,400 NLG IUL Child: $500',
                        '$500 + $600 + $700 multiple sales',
                        ':siren: FIRST SALE! :siren: \n$1,227.84 🐮  TLE\nw/ @Roan Hickey ⛹️‍♂️ \n#SD #FirstDayFirstSale',
                        'Family package: Husband $3,000 Wife $2,500 Kids $500 each x2'
                    ];
                    
                    let testResult = '**Parse Test Results:**\n';
                    for (const msg of testMessages) {
                        const parsed = parseMultipleSales(msg);
                        testResult += `\n**Input:** \`${msg}\`\n`;
                        if (parsed && parsed.length > 0) {
                            testResult += `→ Found **${parsed.length} sale(s)**:\n`;
                            parsed.forEach((sale, i) => {
                                testResult += `   ${i + 1}. **$${sale.amount}** - "${sale.policyType}"\n`;
                            });
                            const total = parsed.reduce((sum, sale) => sum + sale.amount, 0);
                            testResult += `   **Total: $${total.toLocaleString('en-US', {minimumFractionDigits: 2})}**\n`;
                        } else {
                            testResult += `→ No sales found\n`;
                        }
                    }
                    
                    await message.channel.send(testResult);
                }
                break;
        }
    }
});

// Helper function for DST check (also define it globally for reuse)
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
    console.log('║     🚀 BIG POLICY PULSE v4.2 🚀       ║');
    console.log('║   TIME FIX: 11:55 PM + MONTHLY FIX     ║');
    console.log('║   Correct last day of month detection  ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log('⏳ Starting dual tracking system...');
    console.log(`📁 Using data directory: ${DATA_DIR}`);
    
    await loadData();
    
    try {
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error('❌ Error connecting to Discord:', error.message);
        console.log('\n🔍 Please verify:');
        console.log('   1. TOKEN in .env file is correct');
        console.log('   2. Bot is created in Discord Developer Portal');
        console.log('   3. Bot permissions are correct');
        process.exit(1);
    }
}

start();