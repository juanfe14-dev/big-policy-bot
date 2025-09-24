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

// Data file
const DATA_FILE = path.join(__dirname, 'data', 'sales.json');

// Data structure
let salesData = {
    daily: {},
    weekly: {},
    monthly: {},
    allTime: {},
    lastReset: {
        daily: new Date().toDateString(),
        weekly: getWeekNumber(new Date()),
        monthly: new Date().getMonth()
    }
};

// Load data
async function loadData() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
        const data = await fs.readFile(DATA_FILE, 'utf8');
        salesData = JSON.parse(data);
        console.log('📂 Data loaded successfully');
    } catch (error) {
        console.log('📝 No data file found, starting fresh');
        await saveData();
    }
}

// Save data
async function saveData() {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(salesData, null, 2));
    } catch (error) {
        console.error('❌ Error saving data:', error);
    }
}

// Get week number
function getWeekNumber(date) {
    const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

// Check period resets
function checkResets() {
    const now = new Date();
    const currentDay = now.toDateString();
    const currentWeek = getWeekNumber(now);
    const currentMonth = now.getMonth();

    let wasReset = false;

    if (salesData.lastReset.daily !== currentDay) {
        salesData.daily = {};
        salesData.lastReset.daily = currentDay;
        wasReset = true;
        console.log('🔄 Daily reset executed');
    }

    if (salesData.lastReset.weekly !== currentWeek) {
        salesData.weekly = {};
        salesData.lastReset.weekly = currentWeek;
        wasReset = true;
        console.log('🔄 Weekly reset executed');
    }

    if (salesData.lastReset.monthly !== currentMonth) {
        salesData.monthly = {};
        salesData.lastReset.monthly = currentMonth;
        wasReset = true;
        console.log('🔄 Monthly reset executed');
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
function generateAPLeaderboard(period = 'daily', title = '') {
    checkResets();
    
    const data = salesData[period];
    const sorted = Object.entries(data)
        .sort(([,a], [,b]) => b.total - a.total);

    const periodTitle = {
        'daily': '💵 DAILY AP LEADERBOARD',
        'weekly': '💵 WEEKLY AP LEADERBOARD',
        'monthly': '💵 MONTHLY AP LEADERBOARD'
    };

    const currentDate = new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
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

// Generate Policy Count Leaderboard (sorted by number of policies)
function generatePolicyLeaderboard(period = 'daily', title = '') {
    checkResets();
    
    const data = salesData[period];
    const sorted = Object.entries(data)
        .sort(([,a], [,b]) => b.count - a.count); // Sort by COUNT not total

    const periodTitle = {
        'daily': '📋 DAILY POLICY LEADERBOARD',
        'weekly': '📋 WEEKLY POLICY LEADERBOARD',
        'monthly': '📋 MONTHLY POLICY LEADERBOARD'
    };

    const currentDate = new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
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

// Bot ready
client.once('ready', () => {
    console.log(`✅ ${client.user.tag} is online!`);
    console.log('🏢 Boundless Insurance Group - Dual Tracking System');
    console.log(`📊 Sales channel: ${process.env.SALES_CHANNEL_ID}`);
    console.log(`📈 Reports channel: ${process.env.LEADERBOARD_CHANNEL_ID}`);
    console.log('💰 Tracking: AP (Annual Premium) & Policy Count');
    console.log('🔇 Silent mode: Only emoji reactions, no reply messages');
    console.log('📦 Multi-sale detection: Can process multiple sales per message');
    console.log('⏰ Scheduled times for BOTH leaderboards:');
    console.log('   - Every 3 hours: AP & Policy rankings');
    console.log('   - Daily 6 PM: Complete dual summary');
    console.log('   - Sundays 6 PM: Weekly dual rankings');
    console.log('   - Last day of month 6 PM: Monthly dual rankings');
    
    // AUTOMATED SCHEDULES - Now posting BOTH leaderboards
    
    // 1. Every 3 hours - Post BOTH leaderboards
    cron.schedule('0 6,9,12,15,18,21 * * *', async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            const hour = new Date().getHours();
            
            await channel.send('📊 **HOURLY UPDATE**');
            
            // Send AP Leaderboard
            await channel.send({ embeds: [generateAPLeaderboard('daily', `💵 ${hour}:00 AP UPDATE`)] });
            
            // Send Policy Leaderboard
            await channel.send({ embeds: [generatePolicyLeaderboard('daily', `📋 ${hour}:00 POLICY UPDATE`)] });
            
            await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`📊 Both leaderboards updated - ${hour}:00`);
        }
    });

    // 2. Daily summary at 6 PM - BOTH leaderboards
    cron.schedule('0 18 * * *', async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            await channel.send('📢 **END OF DAY FINAL RANKINGS**');
            
            const apEmbed = generateAPLeaderboard('daily', '💵 DAILY AP FINAL STANDINGS');
            apEmbed.setColor(0xFFD700);
            await channel.send({ embeds: [apEmbed] });
            
            const policyEmbed = generatePolicyLeaderboard('daily', '📋 DAILY POLICY FINAL STANDINGS');
            policyEmbed.setColor(0xFFD700);
            await channel.send({ embeds: [policyEmbed] });
            
            await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 Final daily rankings posted - 18:00');
        }
    });

    // 3. Weekly summary - Sundays at 6 PM
    cron.schedule('0 18 * * 0', async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            await channel.send('🏆 **WEEKLY FINAL RANKINGS**');
            
            const apEmbed = generateAPLeaderboard('weekly', '💵🏆 WEEKLY AP CHAMPIONS');
            apEmbed.setColor(0xFF6B6B);
            await channel.send({ embeds: [apEmbed] });
            
            const policyEmbed = generatePolicyLeaderboard('weekly', '📋🏆 WEEKLY POLICY CHAMPIONS');
            policyEmbed.setColor(0xFF6B6B);
            await channel.send({ embeds: [policyEmbed] });
            
            await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 Weekly rankings posted - Sunday 18:00');
        }
    });

    // 4. Monthly summary - Last day of month at 6 PM
    cron.schedule('0 18 28-31 * *', async () => {
        const date = new Date();
        const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        
        if (date.getDate() === lastDay) {
            const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
            if (channel) {
                await channel.send('🎊 **MONTHLY FINAL RANKINGS - CONGRATULATIONS!** 🎊');
                
                const apEmbed = generateAPLeaderboard('monthly', '💵🏆🏆 MONTHLY AP CHAMPIONS 🏆🏆');
                apEmbed.setColor(0xFFD700);
                await channel.send({ embeds: [apEmbed] });
                
                const policyEmbed = generatePolicyLeaderboard('monthly', '📋🏆🏆 MONTHLY POLICY CHAMPIONS 🏆🏆');
                policyEmbed.setColor(0xFFD700);
                await channel.send({ embeds: [policyEmbed] });
                
                await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('📊 Monthly rankings posted - End of month 18:00');
            }
        }
    });
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
                    // Send BOTH leaderboards
                    await message.channel.send('📊 **CURRENT RANKINGS**');
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
                    .setTitle('📚 **BIG Policy Pulse v3.2 - User Manual**')
                    .setDescription('Dual Tracking System with Multi-Sale Detection\n━━━━━━━━━━━━━━━━━━━━━')
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
                            name: '⏰ **AUTOMATIC REPORTS**',
                            value: 'Both leaderboards post automatically:\n• Every 3 hours (6, 9, 12, 15, 18, 21)\n• Daily close at 6 PM\n• Weekly summary Sundays 6 PM\n• Monthly summary last day 6 PM'
                        },
                        {
                            name: '🏆 **DUAL RANKING SYSTEM**',
                            value: '**AP Leaderboard:** Ranked by total dollar amount\n**Policy Leaderboard:** Ranked by number of policies\n\nMultiple sales per message count separately!'
                        }
                    )
                    .setFooter({ text: '💼 BIG - Excel in both AP and Policy count!' })
                    .setTimestamp();
                
                await message.channel.send({ embeds: [helpEmbed] });
                break;

            case 'ping':
                await message.reply('🏓 Pong! Bot is working correctly.');
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
    console.log('║     🚀 BIG POLICY PULSE v3.2 🚀       ║');
    console.log('║   DUAL LEADERBOARD SYSTEM              ║');
    console.log('║   Multi-Sale Detection                 ║');
    console.log('║   Silent Mode (Emojis Only)            ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log('⏳ Starting dual tracking system...');
    
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