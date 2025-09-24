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
    allTime: {}, // For all-time statistics
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

// Parse sale and policy from message
function parseSaleAndPolicy(message) {
    // Pattern for: $624 Americo IUL, $1,328.40 MOO IULE, etc.
    const pattern = /\$\s*([\d,]+(?:\.\d{2})?)\s*(.*)/;
    const match = message.match(pattern);
    
    if (match) {
        // Remove commas from amount and convert to number
        const amount = parseFloat(match[1].replace(/,/g, ''));
        const policyType = match[2].trim() || 'General';
        
        return {
            amount: amount,
            policyType: policyType
        };
    }
    
    return null;
}

// Add sale with specific policy type
function addSale(userId, username, amount, policyType) {
    checkResets();
    
    // Initialize user in all periods if doesn't exist
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
        
        // Add to total
        salesData[period][userId].total += amount;
        salesData[period][userId].count += 1;
        
        // Count by policy type
        if (!salesData[period][userId].policies[policyType]) {
            salesData[period][userId].policies[policyType] = 0;
        }
        salesData[period][userId].policies[policyType]++;
        
        // Add details
        salesData[period][userId].policyDetails.push({
            amount,
            type: policyType,
            date: new Date().toISOString()
        });
    });

    // Add to all-time stats
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

// Generate enhanced leaderboard
function generateLeaderboard(period = 'daily', title = '') {
    checkResets();
    
    const data = salesData[period];
    const sorted = Object.entries(data)
        .sort(([,a], [,b]) => b.total - a.total);

    const periodTitle = {
        'daily': '📅 DAILY REPORT',
        'weekly': '📊 WEEKLY REPORT',
        'monthly': '🏆 MONTHLY REPORT'
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
        .setColor(period === 'monthly' ? 0xFFD700 : period === 'weekly' ? 0x0099FF : 0x00FF00)
        .setTitle(title || periodTitle[period])
        .setDescription(`📍 **Date:** ${currentDate}\n━━━━━━━━━━━━━━━━━━━━━`)
        .setTimestamp()
        .setFooter({ text: '💼 Boundless Insurance Group' });

    if (sorted.length === 0) {
        embed.addFields({
            name: '📝 No Records',
            value: 'No sales recorded for this period'
        });
    } else {
        // Top 3 sellers with more detail
        let topDescription = '';
        const top3 = sorted.slice(0, 3);
        
        top3.forEach(([userId, data], index) => {
            const medal = index === 0 ? '🥇 **LEADER**' : index === 1 ? '🥈 **2nd Place**' : '🥉 **3rd Place**';
            topDescription += `${medal}\n`;
            topDescription += `👤 **${data.username}**\n`;
            topDescription += `💵 **$${data.total.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}** | 📋 ${data.count} policies\n`;
            
            // Show most sold policy types (max 3)
            if (data.policies) {
                const typesOrdered = Object.entries(data.policies)
                    .sort(([,a], [,b]) => b - a)
                    .slice(0, 3);
                    
                if (typesOrdered.length > 0) {
                    const typesText = typesOrdered
                        .map(([type, count]) => `${type} (${count})`)
                        .join(', ');
                    topDescription += `🏷️ *${typesText}*\n`;
                }
            }
            topDescription += '\n';
        });
        
        if (topDescription) {
            embed.addFields({
                name: '🌟 **TOP PERFORMERS**',
                value: topDescription || 'No data'
            });
        }

        // Rest of ranking (4-10)
        if (sorted.length > 3) {
            let restDescription = '';
            const rest = sorted.slice(3, 10);
            
            rest.forEach(([userId, data], index) => {
                restDescription += `**${index + 4}.** ${data.username} - $${data.total.toLocaleString('en-US', {minimumFractionDigits: 2})} (${data.count})\n`;
            });
            
            if (restDescription) {
                embed.addFields({
                    name: '📈 **Other Agents**',
                    value: restDescription
                });
            }
        }

        // General statistics
        const totalSales = Object.values(data).reduce((sum, user) => sum + user.total, 0);
        const totalPolicies = Object.values(data).reduce((sum, user) => sum + user.count, 0);
        const averagePolicy = totalPolicies > 0 ? totalSales / totalPolicies : 0;
        const activeAgents = sorted.length;

        // Featured leader
        const leader = sorted[0];
        let leaderText = `👑 **${leader[1].username}**\n`;
        leaderText += `💰 $${leader[1].total.toLocaleString('en-US', {minimumFractionDigits: 2})}`;

        embed.addFields(
            {
                name: '🏆 **PERIOD LEADER**',
                value: leaderText,
                inline: true
            },
            {
                name: '💼 **SUMMARY**',
                value: `**Total Sales:** $${totalSales.toLocaleString('en-US', {minimumFractionDigits: 2})}\n**Total Policies:** ${totalPolicies}\n**Average:** $${averagePolicy.toLocaleString('en-US', {minimumFractionDigits: 2})}\n**Active Agents:** ${activeAgents}`,
                inline: true
            }
        );

        // Add motivational message based on period
        const motivationalMessages = {
            'daily': '💪 Keep pushing! Every sale counts.',
            'weekly': '🎯 Great week! Let\'s keep the momentum going.',
            'monthly': '🌟 Outstanding month! Let\'s celebrate our achievements.'
        };
        
        embed.addFields({
            name: '\u200B',
            value: `\n*${motivationalMessages[period]}*`
        });
    }

    return embed;
}

// Bot ready
client.once('ready', () => {
    console.log(`✅ ${client.user.tag} is online!`);
    console.log('🏢 Boundless Insurance Group - Sales System Active');
    console.log(`📊 Sales channel: ${process.env.SALES_CHANNEL_ID}`);
    console.log(`📈 Reports channel: ${process.env.LEADERBOARD_CHANNEL_ID}`);
    console.log('⏰ Scheduled times:');
    console.log('   - Every 3 hours: Current day report');
    console.log('   - Daily 6 PM: Day summary');
    console.log('   - Sundays 6 PM: Weekly summary');
    console.log('   - Last day of month 6 PM: Monthly summary');
    
    // AUTOMATED SCHEDULES
    
    // 1. Current day table every 3 hours (6am, 9am, 12pm, 3pm, 6pm, 9pm)
    cron.schedule('0 6,9,12,15,18,21 * * *', async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            const hour = new Date().getHours();
            await channel.send({ embeds: [generateLeaderboard('daily', `📊 ${hour}:00 UPDATE`)] });
            console.log(`📊 Daily table updated - ${hour}:00`);
        }
    });

    // 2. Complete daily summary at 6 PM
    cron.schedule('0 18 * * *', async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            const embed = generateLeaderboard('daily', '📅 END OF DAY - FINAL SUMMARY');
            embed.setColor(0xFFD700); // Gold color for closing
            await channel.send({ embeds: [embed] });
            await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 Final daily summary posted - 18:00');
        }
    });

    // 3. Weekly summary - Sundays at 6 PM
    cron.schedule('0 18 * * 0', async () => {
        const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
        if (channel) {
            const embed = generateLeaderboard('weekly', '🏆 WEEKLY CLOSING - RESULTS');
            embed.setColor(0xFF6B6B); // Special color for weekly
            
            await channel.send({ 
                content: '📢 **WEEKLY SUMMARY**', 
                embeds: [embed] 
            });
            await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 Weekly summary posted - Sunday 18:00');
        }
    });

    // 4. Monthly summary - Last day of month at 6 PM
    cron.schedule('0 18 28-31 * *', async () => {
        const date = new Date();
        const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        
        if (date.getDate() === lastDay) {
            const channel = client.channels.cache.get(process.env.LEADERBOARD_CHANNEL_ID);
            if (channel) {
                const embed = generateLeaderboard('monthly', '🏆🏆🏆 MONTHLY CLOSING - FINAL RESULTS 🏆🏆🏆');
                embed.setColor(0xFFD700); // Gold for monthly
                
                await channel.send({ 
                    content: '🎊 **CONGRATULATIONS TO ALL FOR A GREAT MONTH!** 🎊', 
                    embeds: [embed] 
                });
                await channel.send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('📊 Monthly summary posted - End of month 18:00');
            }
        }
    });
});

// Handle messages
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // Check if it's the sales channel
    if (message.channel.id === process.env.SALES_CHANNEL_ID) {
        const saleData = parseSaleAndPolicy(message.content);
        
        if (saleData && saleData.amount > 0) {
            addSale(
                message.author.id, 
                message.author.username, 
                saleData.amount, 
                saleData.policyType
            );
            
            // React with multiple emojis to celebrate
            await message.react('✅');
            await message.react('💰');
            if (saleData.amount >= 1000) {
                await message.react('🔥'); // Extra emoji for big sales
            }
            
            // Personalized response based on amount
            let response = '';
            if (saleData.amount >= 2000) {
                response = `🔥 **AMAZING SALE!** 🔥\n💰 **$${saleData.amount.toLocaleString('en-US', {minimumFractionDigits: 2})}** - ${saleData.policyType}\nYou're crushing it, ${message.author.username}! 🚀`;
            } else if (saleData.amount >= 1000) {
                response = `🎯 **Excellent sale!**\n💰 **$${saleData.amount.toLocaleString('en-US', {minimumFractionDigits: 2})}** - ${saleData.policyType}\nKeep it up, ${message.author.username}! 💪`;
            } else {
                response = `✅ **Sale recorded**\n💰 **$${saleData.amount.toLocaleString('en-US', {minimumFractionDigits: 2})}** - ${saleData.policyType}\nEvery sale counts! 📈`;
            }
            
            await message.reply(response);
            
            console.log(`💰 Sale recorded: ${message.author.username} - $${saleData.amount} - ${saleData.policyType}`);
        }
    }

    // Commands available in any channel
    if (message.content.startsWith('!')) {
        const args = message.content.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        switch(command) {
            case 'leaderboard':
            case 'lb':
            case 'top':
            case 'ranking':
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
                    await message.channel.send({ embeds: [generateLeaderboard(validPeriods[period])] });
                } else {
                    const errorEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('❌ Invalid Period')
                        .setDescription('**Use one of these periods:**\n• `daily` (or `day`, `today`)\n• `weekly` (or `week`)\n• `monthly` (or `month`)')
                        .addFields({
                            name: 'Example',
                            value: '`!leaderboard weekly`'
                        });
                    await message.reply({ embeds: [errorEmbed] });
                }
                break;

            case 'mysales':
            case 'mystats':
            case 'stats':
            case 'sales':
                checkResets();
                const userId = message.author.id;
                const daily = salesData.daily[userId] || { total: 0, count: 0, policies: {} };
                const weekly = salesData.weekly[userId] || { total: 0, count: 0, policies: {} };
                const monthly = salesData.monthly[userId] || { total: 0, count: 0, policies: {} };
                const allTime = salesData.allTime && salesData.allTime[userId] ? salesData.allTime[userId] : { total: 0, count: 0 };

                const statsEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(`📊 ${message.author.username}'s Statistics`)
                    .setThumbnail(message.author.displayAvatarURL())
                    .addFields(
                        { 
                            name: '📅 **TODAY**', 
                            value: `💵 **$${daily.total.toLocaleString('en-US', {minimumFractionDigits: 2})}**\n📋 ${daily.count} policies`, 
                            inline: true 
                        },
                        { 
                            name: '📊 **THIS WEEK**', 
                            value: `💵 **$${weekly.total.toLocaleString('en-US', {minimumFractionDigits: 2})}**\n📋 ${weekly.count} policies`, 
                            inline: true 
                        },
                        { 
                            name: '🏆 **THIS MONTH**', 
                            value: `💵 **$${monthly.total.toLocaleString('en-US', {minimumFractionDigits: 2})}**\n📋 ${monthly.count} policies`, 
                            inline: true 
                        }
                    );

                // Add most sold policy types for the month
                if (monthly.policies && Object.keys(monthly.policies).length > 0) {
                    const typesOrdered = Object.entries(monthly.policies)
                        .sort(([,a], [,b]) => b - a)
                        .slice(0, 5);
                    
                    const typesText = typesOrdered
                        .map(([type, count]) => `• ${type}: ${count}`)
                        .join('\n');
                    
                    statsEmbed.addFields({
                        name: '🏷️ **Policies Sold (This Month)**',
                        value: typesText || 'No data'
                    });
                }

                // Add all-time record
                if (allTime.total > 0) {
                    statsEmbed.addFields({
                        name: '🌟 **ALL-TIME RECORD**',
                        value: `💎 **$${allTime.total.toLocaleString('en-US', {minimumFractionDigits: 2})}** in ${allTime.count} total sales`
                    });
                }

                // Calculate average
                const monthAverage = monthly.count > 0 ? monthly.total / monthly.count : 0;
                if (monthAverage > 0) {
                    statsEmbed.addFields({
                        name: '📈 **Average per Sale (Month)**',
                        value: `$${monthAverage.toLocaleString('en-US', {minimumFractionDigits: 2})}`
                    });
                }

                statsEmbed
                    .setTimestamp()
                    .setFooter({ text: 'BIG - Boundless Insurance Group | Keep selling!' });

                await message.channel.send({ embeds: [statsEmbed] });
                break;

            case 'help':
            case 'commands':
                const helpEmbed = new EmbedBuilder()
                    .setColor(0x0066CC)
                    .setTitle('📚 **BIG Policy Pulse - User Manual**')
                    .setDescription('Automated Sales Tracking System\n━━━━━━━━━━━━━━━━━━━━━')
                    .addFields(
                        { 
                            name: '💰 **RECORDING SALES**', 
                            value: 'In the sales channel, post your sale with this format:\n\n`$624 Americo IUL`\n`$1,328.40 MOO IULE`\n`$1,227.84 TLE`\n\nThe bot will automatically detect the amount and policy type.'
                        },
                        { 
                            name: '📊 **AVAILABLE COMMANDS**', 
                            value: '`!leaderboard` - View today\'s ranking\n`!leaderboard weekly` - View weekly ranking\n`!leaderboard monthly` - View monthly ranking\n`!mystats` - View your personal statistics\n`!help` - Show this menu'
                        },
                        {
                            name: '⏰ **AUTOMATIC REPORTS**',
                            value: '**Day Update:** Every 3 hours (6, 9, 12, 15, 18, 21 hrs)\n**Daily Close:** 6:00 PM\n**Weekly Close:** Sundays 6:00 PM\n**Monthly Close:** Last day 6:00 PM'
                        },
                        {
                            name: '🏆 **RANKING SYSTEM**',
                            value: '🥇 **1st Place:** Period leader\n🥈 **2nd Place:** Runner-up\n🥉 **3rd Place:** Third position\n\nRankings reset automatically.'
                        },
                        {
                            name: '💡 **TIPS**',
                            value: '• Record every sale immediately\n• Always include the policy type\n• Check your position regularly\n• Compete positively with your team!'
                        }
                    )
                    .setFooter({ text: '💼 Boundless Insurance Group - Success in your sales!' })
                    .setTimestamp();
                
                await message.channel.send({ embeds: [helpEmbed] });
                break;

            case 'ping':
                await message.reply('🏓 Pong! Bot is working correctly.');
                break;
        }
    }
});

// Enhanced error handling
client.on('error', error => {
    console.error('❌ Bot error:', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled error:', error);
});

// Auto-reconnect functions
client.on('disconnect', () => {
    console.log('⚠️ Bot disconnected, attempting to reconnect...');
});

client.on('reconnecting', () => {
    console.log('🔄 Reconnecting...');
});

// Start bot
async function start() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 BIG POLICY PULSE v2.0 🚀       ║');
    console.log('║   Boundless Insurance Group Tracker    ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log('⏳ Starting system...');
    
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