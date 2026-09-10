/**
 * Project: NIM BOT - Public Multi-User Pairing Module
 * Creator: Nimsara
 * Mode: Full Features Enabled (Status Seen, React, Always Online, Status Saver / Media Downloader & View Once .vv Added)
 */
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    downloadMediaMessage
} = require('baileys');

const yts = require('yt-search');
const axios = require('axios');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const FormData = require('form-data');

const Session = require('./Id');
const { get, input, ensureConfig, handleSettingUpdate } = require('./configdb');

const SESSION_BASE_PATH = path.join(__dirname, './sessions');
const BOT_IMAGE_URL = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/Nim-Bot-New-Logo.jfif';
const BOT_AUDIO_URL = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/welcome%20nim%20new.MP3';
const BOT_CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb0bsRuFnSz4XAQ2yT0r';

// Global tracking maps
const socketCreationTime = new Map();
const activeSockets = new Map();
const messageCache = new Map();
const deletedMessages = new Map();
const reconnectAttempts = new Map();
const userCategoryState = new Map();

// ==========================================
// 🔥 ENHANCED: Get message body with all types
// ==========================================
function getMessageBody(msg) {
    if (!msg.message) return '';
    let message = msg.message;
    if (message.ephemeralMessage) message = message.ephemeralMessage.message;
    if (message.viewOnceMessage) message = message.viewOnceMessage.message;
    if (message.viewOnceMessageV2) message = message.viewOnceMessageV2.message;

    return message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        '';
}

// Helper to download audio
async function getAudioBuffer(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) {
        console.error("Error downloading audio buffer:", e.message);
        return null;
    }
}

// ==========================================
// 🔥 ENHANCED: MongoDB Auth State
// ==========================================
async function useMongoDBAuthState(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionDir = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    await fs.ensureDir(sessionDir);

    let dbData = await Session.findOne({ number: sanitizedNumber });
    const credsPath = path.join(sessionDir, 'creds.json');

    if (dbData && dbData.creds) {
        try {
            if (dbData.creds && typeof dbData.creds === 'object' && Object.keys(dbData.creds).length > 0) {
                await fs.writeJson(credsPath, dbData.creds, { spaces: 2 });
                console.log(`✅ Loaded existing session from MongoDB for ${sanitizedNumber}`);
            } else {
                console.log(`⚠️ Invalid creds in MongoDB for ${sanitizedNumber}, will create new session`);
                await Session.deleteOne({ number: sanitizedNumber });
                dbData = null;
            }
        } catch (e) {
            console.error("Error writing initial creds from DB:", e);
            await fs.remove(credsPath);
            await Session.deleteOne({ number: sanitizedNumber });
            dbData = null;
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const enhancedSaveCreds = async () => {
        try {
            await fs.ensureDir(sessionDir);
            await saveCreds();
            
            if (await fs.pathExists(credsPath)) {
                try {
                    const rawData = await fs.readFile(credsPath, 'utf8');
                    if (rawData && rawData.trim() !== '') {
                        const credsData = JSON.parse(rawData);
                        if (credsData && typeof credsData === 'object' && Object.keys(credsData).length > 0) {
                            await Session.findOneAndUpdate(
                                { number: sanitizedNumber },
                                { 
                                    creds: credsData, 
                                    updatedAt: new Date(),
                                    lastSeen: new Date()
                                },
                                { upsert: true, new: true }
                            );
                            console.log(`✅ Session saved to MongoDB for ${sanitizedNumber}`);
                        }
                    }
                } catch (e) {
                    console.error(`❌ Error saving creds to MongoDB for ${sanitizedNumber}:`, e.message);
                }
            }
        } catch (e) {
            console.error(`❌ Error in enhancedSaveCreds for ${sanitizedNumber}:`, e.message);
        }
    };

    return {
        state,
        saveCreds: enhancedSaveCreds
    };
}

// ==========================================
// 🔥 ENHANCED: Setup Command Handlers
// ==========================================
function setupCommandHandlers(socket, number) {

    // ==========================================
    // 🔥 FIXED: Anti-Delete with better message caching
    // ==========================================
    socket.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            const protocolMsg = update?.protocolMessage || update?.message?.protocolMessage;
            
            if (protocolMsg) {
                if (protocolMsg.type === 0 || protocolMsg.type === 'REVOKE' || protocolMsg.key) {
                    const revokedId = protocolMsg.key?.id || protocolMsg.stanzaId;
                    
                    if (!revokedId) continue;

                    let cachedMsg = messageCache.get(revokedId);
                    
                    if (!cachedMsg) {
                        for (const [key, value] of messageCache) {
                            if (value.key?.id === revokedId) {
                                cachedMsg = value;
                                break;
                            }
                        }
                    }

                    if (cachedMsg) {
                        const chatJid = cachedMsg.key.remoteJid;
                        const senderJid = cachedMsg.key.participant || cachedMsg.key.remoteJid;
                        const messageText = getMessageBody(cachedMsg) || '[Media / Non-text message]';

                        deletedMessages.set(chatJid, {
                            sender: senderJid,
                            text: messageText,
                            time: new Date().toLocaleString(),
                            originalMsg: cachedMsg,
                            keyId: revokedId,
                            timestamp: Date.now()
                        });

                        console.log(`[ANTI-DELETE SUCCESS] Captured deleted message from: ${senderJid}`);
                    } else {
                        console.log(`[ANTI-DELETE WARNING] Message not found in cache: ${revokedId}`);
                    }
                }
            }
        }
    });

    // ==========================================
    // 🔥 ENHANCED: Message cache & main handler
    // ==========================================
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg) return;

        // Cache all messages for anti-delete
        if (msg.key && msg.key.id) {
            messageCache.set(msg.key.id, msg);
            if (msg.key.stanzaId) {
                messageCache.set(msg.key.stanzaId, msg);
            }
            
            if (messageCache.size > 1000) {
                const keys = messageCache.keys();
                for (let i = 0; i < 500; i++) {
                    const key = keys.next().value;
                    if (key) messageCache.delete(key);
                }
            }
        }

        if (!msg.message) return;

        const sender = msg.key.remoteJid;
        const body = getMessageBody(msg);
        if (!body) return;

        const prefix = await get('PREFIX', number) || '.';
        const isCommand = body.startsWith(prefix);

        // Auto-read logic
        global.autoReadStatus = global.autoReadStatus || 'off';
        if (global.autoReadStatus === 'all') {
            await socket.readMessages([msg.key]);
        } else if (global.autoReadStatus === 'cmd' && isCommand) {
            await socket.readMessages([msg.key]);
        }

        // ==========================================
        // 🔥 ENHANCED: Channel forwarding info
        // ==========================================
        const channelInfo = {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363362308230584@newsletter',
                newsletterName: 'NIM PROJECT',
                serverMessageId: 100
            }
        };

        const reply = async (content, quotedMsg = msg) => {
            let messagePayload;
            if (typeof content === 'string') {
                messagePayload = {
                    text: content,
                    contextInfo: channelInfo
                };
            } else {
                messagePayload = {
                    ...content,
                    contextInfo: {
                        ...(content.contextInfo || {}),
                        ...channelInfo
                    }
                };
            }
            return await socket.sendMessage(sender, messagePayload, { quoted: quotedMsg });
        };

        // ==========================================
        // 🔥 FIXED: MENU REPLY HANDLER
        // Only works when replying to bot's menu message
        // ==========================================
        const quotedInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedParticipant = quotedInfo?.participant || '';
        const quotedText = quotedInfo?.quotedMessage?.conversation || 
                          quotedInfo?.quotedMessage?.extendedTextMessage?.text || 
                          '';
        
        // Get bot's own JID
        const botJid = socket.user?.id || '';
        const botNumber = botJid.split(':')[0] || '';
        
        // Check if replying to bot's message
        const isReplyingToBot = quotedParticipant && 
            (quotedParticipant.includes(botNumber) || quotedParticipant === botJid);
        
        // Check if quoted message is a menu message
        const isMenuMessage = quotedText.includes('𝗕𝗢𝗧 𝗠𝗘𝗡𝗨 𝗖𝗔𝗧𝗘𝗚𝗢𝗥𝗜𝗘𝗦') || 
                             quotedText.includes('Type the category number') ||
                             quotedText.includes('Reply to this message with a number');
        
        // Check if quoted message is a category message
        const isCategoryMessage = quotedText.includes('📥 DOWNLOAD COMMANDS') ||
                                 quotedText.includes('⚙️ SETTINGS COMMANDS') ||
                                 quotedText.includes('👑 OWNER COMMANDS') ||
                                 quotedText.includes('🛠️ UTILITY COMMANDS') ||
                                 quotedText.includes('🤖 AI & OTHER COMMANDS');

        // ==========================================
        // 🔥 Handle menu category selection (reply only)
        // ==========================================
        if (!isCommand && body.match(/^[1-5]$/) && isReplyingToBot && isMenuMessage) {
            const categoryNum = parseInt(body);
            let categoryMenu = '';
            const botName = await get('BOT_NAME', number) || 'NIM BOT';

            switch(categoryNum) {
                case 1:
                    categoryMenu = `*╭─\`📥 DOWNLOAD COMMANDS\`┈⊷*
*╎*
*╎ 🎵 .song [song name]*
*╎    Download songs from YouTube*
*╎*
*╎ 🎬 .tt / .tiktok [url]*
*╎    Download TikTok videos*
*╎*
*╎ 🎬 .yt / .youtube [url] [video/audio]*
*╎    Download YouTube videos/audio*
*╎*
*╎ 🎬 .fb / .facebook [url]*
*╎    Download Facebook videos*
*╎*
*╎ 🔗 .tourl / .url*
*╎    Convert media to URL*
*╎*
*╎ 📸 .vv / .viewonce*
*╎    Download View Once media*
*╎*
*╎ 📥 .send / .save*
*╎    Download/Save quoted media*
*╎*
*╰───────────────────────*

💡 *Reply 0 to this message to go back to Main Menu*`;
                    break;

                case 2:
                    categoryMenu = `*╭─\`⚙️ SETTINGS COMMANDS\`┈⊷*
*╎*
*╎ 📋 .settings*
*╎    View current settings*
*╎*
*╎ 🔀 .mode [public/group/inbox/private]*
*╎    Change bot run mode*
*╎*
*╎ 👁️ .autoread [all/cmd/off]*
*╎    Auto-read messages*
*╎*
*╎ 🤖 .autoreply [all/inbox/group/off]*
*╎    Auto-reply settings*
*╎*
*╎ 📷 .autoview [on/off]*
*╎    Auto-view status*
*╎*
*╎ ❤️ .autolike [on/off]*
*╎    Auto-like status*
*╎*
*╎ 🟢 .alwaysonline [on/off]*
*╎    Always online mode*
*╎*
*╎ 🔤 .setprefix [new prefix]*
*╎    Change command prefix*
*╎*
*╰───────────────────────*

💡 *Reply 0 to this message to go back to Main Menu*`;
                    break;

                case 3:
                    categoryMenu = `*╭─\`👑 OWNER COMMANDS\`┈⊷*
*╎*
*╎ 👤 .owner*
*╎    Bot owner information*
*╎*
*╎ 🔄 .mode [public/group/inbox/private]*
*╎    Change bot run mode*
*╎*
*╎ ⚙️ .settings*
*╎    View all settings*
*╎*
*╎ 🔤 .setprefix [new prefix]*
*╎    Change command prefix*
*╎*
*╎ 👁️ .autoread [all/cmd/off]*
*╎    Auto-read settings*
*╎*
*╎ 🤖 .autoreply [all/inbox/group/off]*
*╎    Auto-reply settings*
*╎*
*╎ 📷 .autoview [on/off]*
*╎    Auto-view status*
*╎*
*╎ ❤️ .autolike [on/off]*
*╎    Auto-like status*
*╎*
*╎ 🟢 .alwaysonline [on/off]*
*╎    Always online mode*
*╎*
*╰───────────────────────*

💡 *Reply 0 to this message to go back to Main Menu*`;
                    break;

                case 4:
                    categoryMenu = `*╭─\`🛠️ UTILITY COMMANDS\`┈⊷*
*╎*
*╎ 🏓 .ping*
*╎    Check bot response time*
*╎*
*╎ ⏱️ .runtime*
*╎    Show bot uptime*
*╎*
*╎ 📍 .jid*
*╎    Get JID information*
*╎*
*╎ ❤️ .alive / .status*
*╎    Check bot status*
*╎*
*╎ 🗑️ .remsg / .delete / .getdel*
*╎    Recover deleted message*
*╎*
*╎ 📋 .menu / .help*
*╎    Show this menu*
*╎*
*╰───────────────────────*

💡 *Reply 0 to this message to go back to Main Menu*`;
                    break;

                case 5:
                    categoryMenu = `*╭─\`🤖 AI & OTHER COMMANDS\`┈⊷*
*╎*
*╎ 🤖 .ai / .gpt [question]*
*╎    AI Chatbot (Free)*
*╎*
*╎ ⏱️ .runtime*
*╎    Show bot uptime*
*╎*
*╎ 📋 .menu / .help*
*╎    Show this menu*
*╎*
*╎ 👤 .owner*
*╎    Bot owner info*
*╎*
*╎ 🏓 .ping*
*╎    Check response time*
*╎*
*╰───────────────────────*

💡 *Reply 0 to this message to go back to Main Menu*`;
                    break;

                default:
                    return;
            }

            await reply(categoryMenu.trim());
            userCategoryState.set(sender, categoryNum);
            console.log(`[MENU] ✅ Sent category ${categoryNum} to ${sender}`);
            return;
        }

        // ==========================================
        // 🔥 Handle "0" to go back to main menu (reply only)
        // ==========================================
        if (!isCommand && body === '0' && isReplyingToBot && isCategoryMessage) {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);
            const botName = await get('BOT_NAME', number) || 'NIM BOT';

            const mainMenu = `
*👋 ${botName.toUpperCase()} 🧛🏻*
*-- The Mini Whatsapp Bot Experience --*

> Created By Nimsara 🧛🏻
> 🪀 Contact - 0784280074

─────────────────────
*BOT STATUS 👾*
> Bot Name : ${botName}
> Run Time : ${hours}h ${minutes}m ${seconds}s
> Host : RENDER
> Activers : ${activeSockets.size}
> Bot Channel : ✅ Followed
> Bot Creator : NIMSARA
─────────────────────

*╭─\`💠 𝗕𝗢𝗧 𝗠𝗘𝗡𝗨 𝗖𝗔𝗧𝗘𝗚𝗢𝗥𝗜𝗘𝗦\`┈⊷*
*╎*
*╎ 1️⃣ - 📥 DOWNLOAD COMMANDS*
*╎ 2️⃣ - ⚙️ SETTINGS COMMANDS*
*╎ 3️⃣ - 👑 OWNER COMMANDS*
*╎ 4️⃣ - 🛠️ UTILITY COMMANDS*
*╎ 5️⃣ - 🤖 AI & OTHER COMMANDS*
*╎*
*╰───────────────────────*

💡 *Reply to this message with a number!*
Example: Reply \`1\` for Download Commands

🔗 Web: https://nimsara-official.vercel.app/
*🏮 FOLLOW CHANNEL :- ${BOT_CHANNEL_LINK}*

> _MADE BY NIMSARA_
`;

            await reply({
                image: { url: BOT_IMAGE_URL },
                caption: mainMenu.trim()
            });
            return;
        }

        // ==========================================
        // 🔥 FIXED: Auto-reply with better anti-loop protection
        // ==========================================
        global.autoReplyMode = global.autoReplyMode || 'off';

        if (global.autoReplyMode !== 'off' && !msg.key.fromMe) {
            const isGroup = sender.endsWith('@g.us');
            const shouldAutoReply =
                (global.autoReplyMode === 'all') ||
                (global.autoReplyMode === 'inbox' && !isGroup) ||
                (global.autoReplyMode === 'group' && isGroup);

            if (shouldAutoReply) {
                const textLower = body.toLowerCase().trim();
                
                const isFromBot = msg.key.fromMe || msg.key.participant === socket.user.id;
                
                const botResponsePatterns = [
                    'hi! 👋', 'mokuth na innwa', 'good morning🌤️', 'good night✨',
                    'bye🍻', 'r2k gaming channels', 'payment details', 'eyaa hadapu bot',
                    '🤖', '🎵', '📥', '🎬', '⚠️', '❌', '✅', '⚙️', '👀', '🏓'
                ];
                
                const isBotResponse = botResponsePatterns.some(pattern => textLower.includes(pattern.toLowerCase()));
                
                if (isFromBot || isBotResponse) {
                    return;
                }

                const words = textLower.split(/\s+/);
                const hasKeyword = (word) => words.some(w => w === word || w.includes(word));

                if (hasKeyword('hi') || hasKeyword('හායි') || hasKeyword('hello')) {
                    await reply('Hi! 👋');
                } else if (hasKeyword('mk') || hasKeyword('මොකද කරන්නෙ') || textLower.includes('mokada karanne')) {
                    await reply('Mokuth Na innwa😊');
                } else if (hasKeyword('gm') || hasKeyword('ගුඩ් මොර්නින්ග්') || textLower.includes('good morning')) {
                    await reply('Good Morning🌤️');
                } else if (hasKeyword('gn') || hasKeyword('ගුඩ් නයිට්') || textLower.includes('good night')) {
                    await reply('Good Night✨');
                } else if (hasKeyword('by') || hasKeyword('බායි') || hasKeyword('bye')) {
                    await reply('Bye🍻');
                } else if (textLower.includes('r2k') || textLower.includes('pawara')) {
                    await reply(`*🔥 R2K Gaming Channels 🔥*

💓Tik Tok - https://www.tiktok.com/@rush.2.kill__00
💓Youtube - https://www.youtube.com/@rush.2.kill__0
💓Fb - https://www.facebook.com/profile.php?id=61581297341821

*\`Thankyou Yaluwe !\`*`);
                } else if (textLower.includes('payment') || textLower.includes('payment details danna') || textLower.includes('bank details')) {
                     await reply(`*💰Payment Details*

💡Bank - Commercial Bank
Account number - 8029210301
Name - G.M.Nethmintha Nimsara Jayasooriya
Branch - Ampara

💡Bank - Lolc Bank
Account number - 03210014631
Name - G.M.Nethmintha Nimsara
Branch - Ampara1

💡Bank - NSB
Account number - 109090193739
Name - G.M.N.N.JAYASURIYA
Branch - Ampara 2nd

💡Bank - Dialog Finance PLC
Account number -  001021434294
Name - Gardiya Manawaduge Nethmintha Nimsara Jayasooriya
Branch - Head Office

💡Bank - Peoples Bank
Account number - 015200130082418
Name - Nethmintha nimsara
Branch - branch Ampara - 015


*🪄EZ CASH*

0740532742

*Ez Cash දාද්දි වැඩියෙන් rs.20 දාන්න*

*🪙 BINANCE*

id - 842717887


*\`Thankyou !\`*`);
                } else if (textLower.includes('nethmintha') || textLower.includes('නෙත්මින්ත') || textLower.includes('nimsara')) {
                    try {
                        const audioUrl = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/welcomto%20nim%20bot.MP3';
                        const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
                        const audioBuffer = Buffer.from(response.data);

                        await reply({
                            text: 'Ow kiyanna Nimsara tikakin rp karai man eya hadapu Bot! 👨‍💻😎',
                            audio: audioBuffer,
                            mimetype: 'audio/mp4',
                            ptt: true
                        });
                    } catch (err) {
                        await reply('Ow kiyanna Nimsara tikakin rp karai man eya hadapu Bot! 👨‍💻😎');
                    }
                }
            }
        }

        // ==========================================
        // 🔥 COMMAND HANDLING
        // ==========================================
        if (!isCommand) return;

        const isOwner = msg.key.fromMe;
        const isGroup = sender.endsWith('@g.us');
        const botMode = await get('BOT_MODE', number) || 'public';

        if (!isOwner) {
            if (botMode === 'private') return;
            if (botMode === 'group' && !isGroup) return;
            if (botMode === 'inbox' && isGroup) return;
        }

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const botName = await get('BOT_NAME', number) || 'NIM BOT';

        try {
            switch (command) {

                // ==========================================
                // 🔥 FIXED: Delete message recover
                // ==========================================
                case 'remsg':
                case 'delete':
                case 'getdel': {
                    let lastDeleted = deletedMessages.get(sender);
                    
                    if (!lastDeleted) {
                        for (const [chatId, deleted] of deletedMessages) {
                            if (chatId === sender || chatId.includes(sender.split('@')[0])) {
                                lastDeleted = deleted;
                                break;
                            }
                        }
                    }

                    if (!lastDeleted) {
                        await reply('❌ මේ චැට් එකේ recent delete කරපු message එකක් හමුවුණේ නෑ! 😔\n\n💡 *Tip:* Messages are cached for 5 minutes after deletion.');
                        return;
                    }

                    const senderJid = lastDeleted.sender;
                    const senderName = senderJid.split('@')[0];
                    const time = lastDeleted.time;
                    let originalText = lastDeleted.text;
                    let quotedMsg = null;

                    if (lastDeleted.originalMsg) {
                        quotedMsg = lastDeleted.originalMsg;
                    }

                    const recoverText = `
╭─❖ *🗑️ DELETED MESSAGE RECOVERED* ❖─╮
│
│ 👤 *Sender:* @${senderName}
│ ⏰ *Time:* ${time}
│ 💬 *Message:*
│
│ ${originalText}
│
╰─────────────────────────❖

> _Recovered using NIM BOT Anti-Delete System_
> _🔗 ${BOT_CHANNEL_LINK}_
`;

                    try {
                        await reply({
                            text: recoverText.trim(),
                            mentions: [senderJid]
                        });

                        if (quotedMsg) {
                            try {
                                await reply(`📌 *Original message quoted above*`, quotedMsg);
                            } catch (e) {}
                        }

                        setTimeout(() => {
                            if (deletedMessages.get(sender) === lastDeleted) {
                                deletedMessages.delete(sender);
                            }
                        }, 300000);

                    } catch (e) {
                        console.error("Error sending recovered message:", e);
                        await reply(`❌ Failed to recover message: ${e.message}`);
                    }
                    break;
                }

                // ==========================================
                // 🔥 JID Command
                // ==========================================
                case 'jid': {
                    const inputArg = args[0] || '';

                    if (inputArg.includes('chat.whatsapp.com')) {
                        try {
                            const match = inputArg.match(/(?:https:\/\/)?(?:chat\.whatsapp\.com\/)([0-9A-Za-z]{20,24})/i);
                            if (match && match[1]) {
                                const inviteCode = match[1];
                                const groupInfo = await socket.groupGetInviteInfo(inviteCode);

                                await reply(`
🔗 *GROUP JID FROM LINK* 🔗

🏷️ *Group Name:* ${groupInfo.subject || 'Unknown'}
📌 *Group JID:* \`${groupInfo.id}\`
👥 *Participants:* ${groupInfo.size || 'N/A'}
`.trim(), msg);
                                return;
                            }
                        } catch (err) {
                            await reply('❌ මේ WhatsApp group link එක වැරදියි හෝ ලින්ක් එක හරහා ගෘප් විස්තර ලබාගන්න බැ!', msg);
                            return;
                        }
                    }

                    const chatJid = msg.key.remoteJid;
                    const senderJid = msg.key.participant || msg.key.remoteJid;
                    const quotedJid = msg.message?.extendedTextMessage?.contextInfo?.participant ||
                        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                        'None';

                    await reply(`
📍 *JID INFORMATION* 📍

💬 *Chat JID:* \`${chatJid}\`
👤 *Sender JID:* \`${senderJid}\`
🎯 *Quoted/Target JID:* \`${quotedJid}\`
`.trim(), msg);
                    break;
                }

                // ==========================================
                // 🔥 FIXED: AI with fallback APIs
                // ==========================================
                case 'ai':
                case 'gpt': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a question for AI!\nExample: .ai What is AI?\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);

                    await reply(`🤖 Thinking... please wait... 🧠`);
                    try {
                        let aiAnswer = null;
                        let errorMsg = null;

                        try {
                            const apiUrl = `https://bk9.fun/ai/gemini?q=${encodeURIComponent(query)}`;
                            const apiRes = await axios.get(apiUrl, { timeout: 15000 });
                            aiAnswer = apiRes.data?.result || apiRes.data?.gpt || apiRes.data?.answer;
                        } catch (e1) {
                            errorMsg = e1.message;
                            console.log("BK9 API failed, trying fallback...");
                        }

                        if (!aiAnswer) {
                            try {
                                const fallbackUrl = `https://api.affiliateplus.xyz/api/gpt?query=${encodeURIComponent(query)}`;
                                const fallbackRes = await axios.get(fallbackUrl, { timeout: 15000 });
                                aiAnswer = fallbackRes.data?.reply || fallbackRes.data?.response || fallbackRes.data?.result;
                            } catch (e2) {
                                errorMsg = e2.message;
                                console.log("Fallback API failed too.");
                            }
                        }

                        if (!aiAnswer) {
                            try {
                                const thirdUrl = `https://delirius-apiofc.vercel.app/ai/gpt4?q=${encodeURIComponent(query)}`;
                                const thirdRes = await axios.get(thirdUrl, { timeout: 15000 });
                                aiAnswer = thirdRes.data?.data || thirdRes.data?.response || thirdRes.data?.result;
                            } catch (e3) {
                                errorMsg = e3.message;
                                console.log("Third API also failed.");
                            }
                        }

                        if (!aiAnswer) {
                            try {
                                const fourthUrl = `https://api.siputzx.my.id/api/ai/chatgpt?q=${encodeURIComponent(query)}`;
                                const fourthRes = await axios.get(fourthUrl, { timeout: 15000 });
                                aiAnswer = fourthRes.data?.data || fourthRes.data?.response || fourthRes.data?.result;
                            } catch (e4) {
                                errorMsg = e4.message;
                                console.log("Fourth API also failed.");
                            }
                        }

                        if (!aiAnswer) {
                            return reply(`❌ AI එකෙන් උත්තරයක් ලබාගන්න බැරි වුණා. Error: ${errorMsg || 'No response'}`);
                        }

                        await reply(`
🤖 *AI ASSISTANT* 🤖

${aiAnswer.trim()}

🔗 *Channel:* ${BOT_CHANNEL_LINK}
`.trim(), msg);

                    } catch (e) {
                        console.error("AI command error:", e);
                        await reply(`❌ AI Error: ${e.message}`);
                    }
                    break;
                }

                // ==========================================
                // 🔥 FIXED: SONG command with fallback
                // ==========================================
                case 'song': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a song name!\nExample: .song Manike\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);

                    await reply(`🔍 Searching for *${query}*... 🎶`);
                    try {
                        const search = await yts(query);
                        const video = search.videos[0];
                        if (!video) return reply(`❌ Song not found! Try another name.`);

                        await reply(`🎵 Found: *${video.title}*\n📥 Generating audio...`);

                        let audioUrl = null;

                        try {
                            const { stdout } = await execPromise(
                                `yt-dlp --get-url -f bestaudio "${video.url}"`
                            );
                            audioUrl = stdout.trim().split('\n')[0];
                            if (audioUrl) console.log("yt-dlp succeeded for song");
                        } catch (e) {
                            console.log("yt-dlp failed, trying fallback...");
                        }

                        if (!audioUrl) {
                            try {
                                const ytdl = require('@distube/ytdl-core');
                                const info = await ytdl.getInfo(video.url);
                                const format = ytdl.chooseFormat(info, {
                                    quality: 'highestaudio',
                                    filter: 'audioonly'
                                });
                                audioUrl = format.url;
                                if (audioUrl) console.log("ytdl-core fallback succeeded");
                            } catch (e) {
                                console.log("ytdl-core fallback failed:", e.message);
                            }
                        }

                        if (!audioUrl) {
                            return reply(`❌ Audio link එක ලබාගන්න බැරි වුණා.`);
                        }

                        await socket.sendMessage(sender, {
                            audio: { url: audioUrl },
                            mimetype: 'audio/mpeg',
                            ptt: false,
                            fileName: `${video.title}.mp3`,
                            contextInfo: {
                                externalAdReply: {
                                    title: video.title,
                                    body: `Duration: ${video.timestamp}`,
                                    thumbnailUrl: video.thumbnail,
                                    sourceUrl: video.url,
                                    mediaType: 1
                                }
                            }
                        }, { quoted: msg });

                    } catch (e) {
                        console.error("Song download error:", e);
                        await reply(`❌ Failed to download song: ${e.message}`);
                    }
                    break;
                }

                // ==========================================
                // 🔥 FIXED: TIKTOK command with fallback
                // ==========================================
                case 'tt':
                case 'tiktok': {
                    const url = args[0];
                    if (!url || !url.includes('tiktok.com')) {
                        return reply(`⚠️ Please provide a TikTok video link!\nExample: .tt https://vt.tiktok.com/xxxx/\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }

                    await reply(`📥 Processing TikTok video... Please wait ⏳`);
                    try {
                        let videoUrl = null;

                        try {
                            const { stdout } = await execPromise(
                                `yt-dlp --get-url "${url}"`
                            );
                            videoUrl = stdout.trim().split('\n')[0];
                            if (videoUrl) console.log("yt-dlp succeeded for TikTok");
                        } catch (e) {
                            console.log("yt-dlp failed for TikTok, trying API...");
                        }

                        if (!videoUrl) {
                            try {
                                const apiUrl = `https://api.vevioz.com/api/button/tiktok/${encodeURIComponent(url)}`;
                                const apiRes = await axios.get(apiUrl, { timeout: 15000 });
                                videoUrl = apiRes.data?.downloadUrl || apiRes.data?.url || apiRes.data?.link;
                                if (videoUrl) console.log("TikTok API fallback succeeded");
                            } catch (e) {
                                console.log("TikTok API fallback failed:", e.message);
                            }
                        }

                        if (!videoUrl) {
                            return reply(`❌ TikTok වීඩියෝ ලින්ක් එක ලබාගන්න බැරි වුණා.`);
                        }

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            caption: `🎬 *TikTok Video Downloaded*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`
                        }, { quoted: msg });

                    } catch (e) {
                        console.error("TikTok download error:", e);
                        await reply(`❌ Error downloading TikTok video: ${e.message}`);
                    }
                    break;
                }

                // ==========================================
                // 🔥 FIXED: YOUTUBE command with fallback
                // ==========================================
                case 'yt':
                case 'youtube': {
                    const url = args[0];
                    const type = args[1] ? args[1].toLowerCase() : 'video';

                    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
                        return reply(`⚠️ Usage: .yt [YouTube Link] [video/audio]\nExample: .yt https://youtu.be/xxxx video\nExample: .yt https://youtu.be/xxxx audio\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }

                    try {
                        await reply(`📥 Processing YouTube download... Please wait ⏳`);

                        let mediaUrl = null;

                        try {
                            let cmd;
                            if (type === 'audio') {
                                cmd = `yt-dlp --get-url -f bestaudio "${url}"`;
                            } else {
                                cmd = `yt-dlp --get-url -f "best[ext=mp4]/best" "${url}"`;
                            }
                            const { stdout } = await execPromise(cmd);
                            mediaUrl = stdout.trim().split('\n')[0];
                            if (mediaUrl) console.log("yt-dlp succeeded for YouTube");
                        } catch (e) {
                            console.log("yt-dlp failed for YouTube, trying fallback...");
                        }

                        if (!mediaUrl) {
                            try {
                                const ytdl = require('@distube/ytdl-core');
                                const info = await ytdl.getInfo(url);
                                if (type === 'audio') {
                                    const format = ytdl.chooseFormat(info, {
                                        quality: 'highestaudio',
                                        filter: 'audioonly'
                                    });
                                    mediaUrl = format.url;
                                } else {
                                    const format = ytdl.chooseFormat(info, {
                                        quality: 'highestvideo',
                                        filter: 'videoandaudio'
                                    });
                                    mediaUrl = format.url;
                                }
                                if (mediaUrl) console.log("ytdl-core fallback succeeded");
                            } catch (e) {
                                console.log("ytdl-core fallback failed:", e.message);
                            }
                        }

                        if (!mediaUrl) return reply(`❌ Failed to fetch YouTube media.`);

                        if (type === 'audio') {
                            await socket.sendMessage(sender, {
                                audio: { url: mediaUrl },
                                mimetype: 'audio/mpeg',
                                fileName: `youtube_audio.mp3`
                            }, { quoted: msg });
                        } else {
                            await socket.sendMessage(sender, {
                                video: { url: mediaUrl },
                                caption: `🎬 *YouTube Video*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`
                            }, { quoted: msg });
                        }
                    } catch (e) {
                        console.error("YouTube download error:", e);
                        await reply(`❌ Failed to download YouTube media: ${e.message}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    break;
                }

                // ==========================================
                // 🔥 FIXED: FACEBOOK command with fallback
                // ==========================================
                case 'fb':
                case 'facebook': {
                    const url = args[0];
                    if (!url || (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.me'))) {
                        return reply(`⚠️ Please provide a Facebook video link!\nExample: .fb https://www.facebook.com/share/v/xxxx/\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }

                    await reply(`📥 Processing Facebook video... Please wait ⏳`);
                    try {
                        let videoUrl = null;

                        try {
                            const { stdout } = await execPromise(
                                `yt-dlp --get-url "${url}"`
                            );
                            videoUrl = stdout.trim().split('\n')[0];
                            if (videoUrl) console.log("yt-dlp succeeded for Facebook");
                        } catch (e) {
                            console.log("yt-dlp failed for Facebook, trying API...");
                        }

                        if (!videoUrl) {
                            try {
                                const apiUrl = `https://api.vevioz.com/api/button/facebook/${encodeURIComponent(url)}`;
                                const apiRes = await axios.get(apiUrl, { timeout: 15000 });
                                videoUrl = apiRes.data?.downloadUrl || apiRes.data?.url || apiRes.data?.link;
                                if (videoUrl) console.log("Facebook API fallback succeeded");
                            } catch (e) {
                                console.log("Facebook API fallback failed:", e.message);
                            }
                        }

                        if (!videoUrl) {
                            return reply(`❌ Facebook වීඩියෝ ලින්ක් එක ලබාගන්න බැරි වුණා.`);
                        }

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            caption: `🎬 *Facebook Video Downloaded*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`
                        }, { quoted: msg });

                    } catch (e) {
                        console.error("Facebook download error:", e);
                        await reply(`❌ Error downloading Facebook video: ${e.message}`);
                    }
                    break;
                }

                // ==========================================
                // 🔥 TOURL command
                // ==========================================
                case 'tourl':
                case 'url': {
                    try {
                        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || msg.quoted;
                        const mime = (msg.message?.imageMessage?.mimetype || msg.message?.videoMessage?.mimetype || quoted?.imageMessage?.mimetype || quoted?.videoMessage?.mimetype || '');

                        if (!mime || (!mime.includes('image') && !mime.includes('video'))) {
                            return reply(`⚠️ Please send or reply to an image or video with .tourl\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                        }

                        await reply(`⏳ Uploading media, please wait... 🚀`);

                        const mediaTarget = quoted ? { message: quoted } : msg;
                        const buffer = await downloadMediaMessage(mediaTarget, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                        const form = new FormData();
                        form.append('reqtype', 'fileupload');
                        const ext = mime.split('/')[1] || 'jpg';
                        form.append('fileToUpload', buffer, { filename: `media.${ext}`, contentType: mime });

                        const uploadRes = await axios.post('https://catbox.moe/user/api.php', form, {
                            headers: { ...form.getHeaders() }
                        });

                        if (uploadRes.data && uploadRes.data.startsWith('http')) {
                            await reply(`
🔗 *MEDIA URL GENERATED* 🔗

*Direct Link:* ${uploadRes.data.trim()}

🔗 *Channel:* ${BOT_CHANNEL_LINK}
`.trim(), msg);
                        } else {
                            return reply(`❌ Upload failed. Please try again later.`);
                        }

                    } catch (e) {
                        console.error("ToUrl error:", e);
                        await reply(`❌ Error generating URL: ${e.message}`);
                    }
                    break;
                }

                // ==========================================
                // 🔥 MAIN MENU COMMAND
                // ==========================================
                case 'allmenu':
                case 'menu':
                case 'help': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    const channelStatus = '✅ Followed';

                    const captionText = `
*👋 ${botName.toUpperCase()} 🧛🏻*
*-- The Mini Whatsapp Bot Experience --*

> Created By Nimsara 🧛🏻
> 🪀 Contact - 0784280074        

─────────────────────        
*BOT STATUS 👾*
> Bot Name : ${botName}
> Run Time : ${hours}h ${minutes}m ${seconds}s
> Host : RENDER
> Activers : ${activeSockets.size}
> Bot Channel : ${channelStatus}
> Bot Creator : NIMSARA
─────────────────────  

*╭─\`💠 𝗕𝗢𝗧 𝗠𝗘𝗡𝗨 𝗖𝗔𝗧𝗘𝗚𝗢𝗥𝗜𝗘𝗦\`┈⊷*
*╎*
*╎ 1️⃣ - 📥 DOWNLOAD COMMANDS*
*╎ 2️⃣ - ⚙️ SETTINGS COMMANDS*
*╎ 3️⃣ - 👑 OWNER COMMANDS*
*╎ 4️⃣ - 🛠️ UTILITY COMMANDS*
*╎ 5️⃣ - 🤖 AI & OTHER COMMANDS*
*╎*
*╰───────────────────────*

💡 *Reply to this message with a number!*
Example: Reply \`1\` for Download Commands

🔗 Web: https://nimsara-official.vercel.app/
*🏮 FOLLOW CHANNEL :- ${BOT_CHANNEL_LINK}*

> _MADE BY NIMSARA_
`;

                    await reply({
                        image: { url: BOT_IMAGE_URL },
                        caption: captionText.trim()
                    });

                    await delay(1500);

                    const audioBuffer = await getAudioBuffer(BOT_AUDIO_URL);
                    if (audioBuffer) {
                        await reply({
                            audio: audioBuffer,
                            mimetype: 'audio/mpeg',
                            ptt: false
                        });
                    }
                    break;
                }

                // ==========================================
                // 🔥 OTHER COMMANDS
                // ==========================================
                case 'mode': {
                    if (!msg.key.fromMe) {
                        return reply(`⚠️ This command can only be used by the **Bot Owner**! ❌`);
                    }

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validModes = ['public', 'group', 'inbox', 'private'];

                    if (!validModes.includes(option)) {
                        const currentMode = await get('BOT_MODE', number) || 'public';
                        let msgText = "⚙️ *Bot Mode Settings*\n\n";
                        msgText += `Current Mode: *${currentMode.toUpperCase()}*\n\n`;
                        msgText += "Available Modes:\n";
                        msgText += "• \`.mode public\`\n";
                        msgText += "• \`.mode group\`\n";
                        msgText += "• \`.mode inbox\`\n";
                        msgText += "• \`.mode private\`\n\n";
                        msgText += `🔗 Channel: ${BOT_CHANNEL_LINK}`;
                        return reply(msgText);
                    }

                    await handleSettingUpdate("BOT_MODE", option, reply, number);
                    break;
                }

                case 'ping': {
                    const start = Date.now();
                    const sentMsg = await socket.sendMessage(sender, { text: 'Pinging...' }, { quoted: msg });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { text: `🏓 Pong! *${latency}ms*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}\n> _MADE BY NIMSARA` }, { quoted: sentMsg });
                    break;
                }

                case 'autoread': {
                    if (!msg.key.fromMe) {
                        return reply(`⚠️ This command can only be used by the **Bot Owner**! ❌`);
                    }

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validOptions = ['all', 'cmd', 'off'];

                    if (!validOptions.includes(option)) {
                        let msgText = "👀 *Auto-Read Settings*\n\n";
                        msgText += `Current Auto-Read: *${(global.autoReadStatus || 'off').toUpperCase()}*\n\n`;
                        msgText += "Available Options:\n";
                        msgText += "• \`.autoread all\` - Read all incoming messages\n";
                        msgText += "• \`.autoread cmd\` - Read only commands\n";
                        msgText += "• \`.autoread off\` - Turn off auto-read\n\n";
                        msgText += `🔗 Channel: ${BOT_CHANNEL_LINK}`;
                        return reply(msgText);
                    }

                    global.autoReadStatus = option;
                    await reply(`✅ Auto-Read mode changed to: *${global.autoReadStatus.toUpperCase()}* 👁️‍🗨️`);
                    break;
                }

                case 'autoreply': {
                    if (!msg.key.fromMe) {
                        return reply(`⚠️ This command can only be used by the **Bot Owner**! ❌`);
                    }

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validOptions = ['all', 'inbox', 'group', 'off'];

                    if (!validOptions.includes(option)) {
                        let msgText = "🤖 *Auto-Reply Settings*\n\n";
                        msgText += `Current Mode: *${(global.autoReplyMode || 'off').toUpperCase()}*\n\n`;
                        msgText += "Available Options:\n";
                        msgText += "• \`.autoreply all\` - Enable for both Inbox & Groups\n";
                        msgText += "• \`.autoreply inbox\` - Enable only for Inbox (Private)\n";
                        msgText += "• \`.autoreply group\` - Enable only for Groups\n";
                        msgText += "• \`.autoreply off\` - Turn off auto-reply\n\n";
                        msgText += `🔗 Channel: ${BOT_CHANNEL_LINK}`;
                        return reply(msgText);
                    }

                    global.autoReplyMode = option;
                    await reply(`✅ Auto-Reply mode changed to: *${global.autoReplyMode.toUpperCase()}* ⚡`);
                    break;
                }

                case 'alive':
                case 'status': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const aliveText = `👋 *${botName}* is online and running!\n⏱️ Uptime: ${hours}h ${minutes}m ${seconds}s\n👨‍💻 Creator: Nimsara\n\n🔗 Channel: ${BOT_CHANNEL_LINK}\n\n> _MADE BY NIMSARA_`;

                    await socket.sendMessage(sender, {
                        image: { url: BOT_IMAGE_URL },
                        caption: aliveText
                    }, { quoted: msg });

                    await delay(1500);

                    const audioBuffer = await getAudioBuffer(BOT_AUDIO_URL);
                    if (audioBuffer) {
                        await socket.sendMessage(sender, {
                            audio: audioBuffer,
                            mimetype: 'audio/mpeg',
                            ptt: false
                        }, { quoted: msg });
                    }
                    break;
                }

                case 'runtime': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    await reply(`⏱️ *${botName} Uptime:* ${hours}h ${minutes}m ${seconds}s\n\n🔗 Channel: ${BOT_CHANNEL_LINK}\n> _MADE BY Nimsara_`);
                    break;
                }

                case 'owner': {
                    await reply(`👑 *Bot Owner Information*\n> Name: Nimsara\n> Contact: 0784280074\n> Bot: ${botName}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    break;
                }

                case 'send':
                case 'save': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted || !quoted.quotedMessage) {
                        return reply(`⚠️ Please reply to a status or media message with *${prefix}send*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }

                    const quotedMsg = {
                        key: {
                            remoteJid: quoted.remoteJid || sender,
                            id: quoted.stanzaId,
                            participant: quoted.participant
                        },
                        message: quoted.quotedMessage
                    };

                    try {
                        let messageType = Object.keys(quoted.quotedMessage)[0];
                        if (messageType === 'ephemeralMessage') {
                            messageType = Object.keys(quoted.quotedMessage.ephemeralMessage.message)[0];
                            quotedMsg.message = quoted.quotedMessage.ephemeralMessage.message;
                        }

                        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
                            const buffer = await downloadMediaMessage(
                                quotedMsg,
                                'buffer',
                                {},
                                { logger: pino({ level: 'silent' }) }
                            );

                            const innerMsg = quotedMsg.message[messageType] || quotedMsg.message.ephemeralMessage?.message[messageType];
                            const caption = `${innerMsg?.caption || ''}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}\n> _MADE BY ${botName}_`;

                            if (messageType === 'imageMessage') {
                                await socket.sendMessage(sender, { image: buffer, caption: caption }, { quoted: msg });
                            } else if (messageType === 'videoMessage') {
                                await socket.sendMessage(sender, { video: buffer, caption: caption }, { quoted: msg });
                            } else if (messageType === 'audioMessage') {
                                await socket.sendMessage(sender, { audio: buffer, mimetype: 'audio/mpeg', ptt: innerMsg?.ptt || false }, { quoted: msg });
                            } else if (messageType === 'documentMessage') {
                                await socket.sendMessage(sender, { document: buffer, mimetype: innerMsg?.mimetype || 'application/octet-stream', fileName: innerMsg?.fileName || 'media' }, { quoted: msg });
                            }
                        } else if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                            const text = quoted.quotedMessage.conversation || quoted.quotedMessage.extendedTextMessage?.text;
                            await reply(`📥 *Saved Status Text:*\n\n${text}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}\n> _MADE BY ${botName}_`);
                        } else {
                            await reply(`⚠️ Unsupported media type for downloading!\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                        }
                    } catch (err) {
                        console.error("Status download error:", err);
                        await reply(`❌ Failed to download status/media: ${err.message}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    break;
                }

                case 'vv':
                case 'viewonce': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted || !quoted.quotedMessage) {
                        return reply(`⚠️ Please reply to a View Once image or video with *${prefix}vv*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }

                    let qMsg = quoted.quotedMessage;
                    if (qMsg.ephemeralMessage) qMsg = qMsg.ephemeralMessage.message;
                    if (qMsg.viewOnceMessage) qMsg = qMsg.viewOnceMessage.message;
                    if (qMsg.viewOnceMessageV2) qMsg = qMsg.viewOnceMessageV2.message;
                    if (qMsg.viewOnceMessageV2Extension) qMsg = qMsg.viewOnceMessageV2Extension.message;

                    const messageType = Object.keys(qMsg)[0];

                    if (['imageMessage', 'videoMessage'].includes(messageType)) {
                        const downloadMsg = {
                            key: {
                                remoteJid: quoted.remoteJid || sender,
                                id: quoted.stanzaId,
                                participant: quoted.participant
                            },
                            message: {
                                [messageType]: qMsg[messageType]
                            }
                        };

                        try {
                            const buffer = await downloadMediaMessage(
                                downloadMsg,
                                'buffer',
                                {},
                                { logger: pino({ level: 'silent' }) }
                            );

                            const innerMsg = qMsg[messageType];
                            const caption = `📥 *Here is your View Once media! (${botName})*\n\n${innerMsg?.caption || ''}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}\n\n> _MADE BY NIMSARA_`;

                            if (messageType === 'imageMessage') {
                                await socket.sendMessage(sender, { image: buffer, caption: caption }, { quoted: msg });
                            } else if (messageType === 'videoMessage') {
                                await socket.sendMessage(sender, { video: buffer, caption: caption }, { quoted: msg });
                            }
                        } catch (err) {
                            console.error("View once download error:", err);
                            await reply(`❌ Failed to download View Once media: ${err.message}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                        }
                    } else {
                        await reply(`⚠️ Please reply to a valid View Once image or video!\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    break;
                }

                case 'setprefix': {
                    if (!msg.key.fromMe) {
                        return reply(`⚠️ This command can only be used by the **Bot Owner**! ❌\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    const newPrefix = args[0];
                    const pfx = await get('PREFIX', number) || '.';
                    if (!newPrefix) return reply(`⚠️ Usage: ${pfx}setprefix [New Prefix]\nExample: ${pfx}setprefix !\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    await handleSettingUpdate("PREFIX", newPrefix, reply, number);
                    break;
                }

                case 'settings': {
                    const pfx = await get('PREFIX', number) || '.';
                    const bName = await get('BOT_NAME', number) || 'NIM BOT';
                    const autoView = await get('AUTO_VIEW_STATUS', number) ?? 'true';
                    const autoLike = await get('AUTO_LIKE_STATUS', number) ?? 'true';
                    const alwaysOnline = await get('ALWAYS_ONLINE', number) ?? 'true';

                    const settingsText = `
⚙️ *${bName.toUpperCase()} SETTINGS* ⚙️

> Bot Name: *${bName}*
> Prefix: *${pfx}*
> Auto View Status: *${autoView}*
> Auto Like Status: *${autoLike}*
> Always Online: *${alwaysOnline}*

🛠️ *How to change settings:*
• ${pfx}autoview [on / off]
• ${pfx}autolike [on / off]
• ${pfx}alwaysonline [on / off]
• ${pfx}setprefix [New Prefix]

🔗 Channel: ${BOT_CHANNEL_LINK}
`;
                    await reply(settingsText.trim());
                    break;
                }

                case 'autoview': {
                    if (!msg.key.fromMe) {
                        return reply(`⚠️ This command can only be used by the **Bot Owner**! ❌\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    const val = args[0]?.toLowerCase();
                    const pfx = await get('PREFIX', number) || '.';
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: ${pfx}autoview on  OR  ${pfx}autoview off\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_VIEW_STATUS", normalized, reply, number);
                    break;
                }

                case 'autolike': {
                    if (!msg.key.fromMe) {
                        return reply(`⚠️ This command can only be used by the **Bot Owner**! ❌\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    const val = args[0]?.toLowerCase();
                    const pfx = await get('PREFIX', number) || '.';
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: ${pfx}autolike on  OR  ${pfx}autolike off\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_LIKE_STATUS", normalized, reply, number);
                    break;
                }

                case 'alwaysonline': {
                    if (!msg.key.fromMe) {
                        return reply(`⚠️ This command can only be used by the **Bot Owner**! ❌\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    const val = args[0]?.toLowerCase();
                    const pfx = await get('PREFIX', number) || '.';
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: ${pfx}alwaysonline on  OR  ${pfx}alwaysonline off\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("ALWAYS_ONLINE", normalized, reply, number);
                    break;
                }

                default:
                    break;
            }
        } catch (error) {
            console.error('Command execution error:', error);
        }
    });
}

// ==========================================
// 🔥 Status & Presence Handlers
// ==========================================
function setupStatusAndPresenceHandlers(socket, number) {
    const getBotNumber = () => socket.user?.id ? socket.user.id.split(':')[0] : number;

    socket.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            try {
                const botNum = getBotNumber();
                const alwaysOnline = await get('ALWAYS_ONLINE', botNum);

                if (alwaysOnline === 'false' || alwaysOnline === 'off') {
                    await socket.sendPresenceUpdate('unavailable');
                } else {
                    await socket.sendPresenceUpdate('available');
                }
            } catch (e) { }
        }
    });

    setInterval(async () => {
        try {
            const botNum = getBotNumber();
            const alwaysOnline = await get('ALWAYS_ONLINE', botNum);

            if (alwaysOnline === 'false' || alwaysOnline === 'off') {
                await socket.sendPresenceUpdate('unavailable');
            } else {
                await socket.sendPresenceUpdate('available');
            }
        } catch (e) { }
    }, 60000);

    socket.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message) continue;

            const botNum = getBotNumber();

            if (msg.key && msg.key.remoteJid === 'status@broadcast') {
                const autoView = await get('AUTO_VIEW_STATUS', botNum);
                if (autoView !== 'false' && autoView !== 'off') {
                    try {
                        await socket.readMessages([msg.key]);
                    } catch (e) { }
                }

                const autoLike = await get('AUTO_LIKE_STATUS', botNum);
                if (autoLike === 'true' || autoLike === 'on') {
                    try {
                        const emojis = ['❤️', '🔥', '👍', '✨', '🤍', '🌟'];
                        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                        await socket.sendMessage('status@broadcast', {
                            react: { text: randomEmoji, key: msg.key }
                        }, { statusJidList: [msg.key.participant] });
                    } catch (e) { }
                }
            }
        }
    });
}

// ==========================================
// 🔥 Restore Existing Sessions
// ==========================================
async function restoreExistingSessions() {
    try {
        console.log("🔄 Checking for existing sessions to restore...");
        const allSessions = await Session.find({});
        
        if (allSessions.length === 0) {
            console.log("ℹ️ No existing sessions found in database.");
            return;
        }

        console.log(`📋 Found ${allSessions.length} existing sessions. Restoring...`);

        for (const session of allSessions) {
            if (session.number && session.creds && Object.keys(session.creds).length > 0) {
                try {
                    if (activeSockets.has(session.number)) {
                        console.log(`✅ Session ${session.number} already active.`);
                        continue;
                    }

                    console.log(`🔄 Restoring session for ${session.number}...`);
                    await StartBot(session.number, null, true);
                    await delay(2000);
                } catch (e) {
                    console.error(`❌ Failed to restore session ${session.number}:`, e.message);
                }
            }
        }
        console.log("✅ Session restoration completed.");
    } catch (e) {
        console.error("❌ Error restoring sessions:", e.message);
    }
}

// ==========================================
// 🔥 Start Bot Function
// ==========================================
async function StartBot(number, res = null, isRestore = false) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    if (activeSockets.has(sanitizedNumber)) {
        console.log(`ℹ️ Bot already connected for ${sanitizedNumber}`);
        if (res && typeof res.send === 'function' && !res.headersSent) {
            return res.send({ status: "Already connected", number: sanitizedNumber });
        }
        return;
    }

    try {
        const { state, saveCreds } = await useMongoDBAuthState(sanitizedNumber);
        const logger = pino({ level: 'silent' });

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari'),
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log(`✅ Bot successfully connected for number: ${sanitizedNumber}`);
                reconnectAttempts.set(sanitizedNumber, 0);

                try {
                    if (typeof ensureConfig === 'function') {
                        await ensureConfig(sanitizedNumber);
                    }
                } catch (err) {
                    console.log("Config ensure error:", err.message);
                }

                socketCreationTime.set(sanitizedNumber, Date.now());
                activeSockets.set(sanitizedNumber, sock);

                if (!isRestore) {
                    try {
                        await delay(2000);
                        let botName = 'NIM BOT';
                        let currentPrefix = '.';
                        try {
                            botName = await get('BOT_NAME', sanitizedNumber) || 'NIM BOT';
                            currentPrefix = await get('PREFIX', sanitizedNumber) || '.';
                        } catch (e) { }

                        await sock.sendMessage(`${sanitizedNumber}@s.whatsapp.net`, {
                            image: { url: BOT_IMAGE_URL },
                            caption: `🎉 *${botName} CONNECTED* 🎉\n\n✅ Your WhatsApp Bot is now online and active!\n\n• Name: *${botName}*\n• Number: *${sanitizedNumber}*\n• Prefix: *${currentPrefix}* \n• Type *${currentPrefix}menu* to view commands.\n\n🔗 Channel: ${BOT_CHANNEL_LINK}\n> Creator: *Nimsara*`,
                            contextInfo: {
                                forwardingScore: 999,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: '120363362308230584@newsletter',
                                    newsletterName: 'NIM PROJECT',
                                    serverMessageId: 100
                                }
                            }
                        });

                        await delay(1500);

                        const audioBuffer = await getAudioBuffer(BOT_AUDIO_URL);
                        if (audioBuffer) {
                            await sock.sendMessage(`${sanitizedNumber}@s.whatsapp.net`, {
                                audio: audioBuffer,
                                mimetype: 'audio/mpeg',
                                ptt: false
                            });
                        }
                    } catch (err) {
                        console.log("Failed to send connect message:", err.message);
                    }
                } else {
                    console.log(`✅ Session restored for ${sanitizedNumber}`);
                }

                if (res && typeof res.send === 'function' && !res.headersSent) {
                    return res.send({ status: "Connected", number: sanitizedNumber });
                }

            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Connection closed for ${sanitizedNumber}, status code: ${statusCode}`);
                activeSockets.delete(sanitizedNumber);

                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    console.log(`❌ Session logged out for ${sanitizedNumber}. Removing from database.`);
                    await Session.deleteOne({ number: sanitizedNumber });
                    await fs.remove(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));
                } else {
                    const attempts = (reconnectAttempts.get(sanitizedNumber) || 0) + 1;
                    reconnectAttempts.set(sanitizedNumber, attempts);
                    
                    const delayTime = Math.min(3000 * Math.pow(1.5, attempts - 1), 60000);
                    console.log(`🔄 Reconnecting ${sanitizedNumber} in ${delayTime/1000}s (attempt ${attempts})`);
                    
                    setTimeout(() => {
                        StartBot(sanitizedNumber, null, true);
                    }, delayTime);
                }
            }
        });

        setupCommandHandlers(sock, sanitizedNumber);
        setupStatusAndPresenceHandlers(sock, sanitizedNumber);

        if (!sock.authState.creds.registered) {
            if (isRestore) {
                console.log(`⚠️ Session ${sanitizedNumber} not registered but restore attempted.`);
                setTimeout(() => {
                    if (!activeSockets.has(sanitizedNumber)) {
                        StartBot(sanitizedNumber, null, false);
                    }
                }, 5000);
                return;
            }

            await delay(3000);
            try {
                let code = await sock.requestPairingCode(sanitizedNumber);
                if (res && typeof res.send === 'function' && !res.headersSent) {
                    return res.send({ code });
                }
            } catch (err) {
                console.error("❌ Pairing code request internal error:", err.message);
                if (res && typeof res.status === 'function' && !res.headersSent) {
                    return res.status(500).send({ error: "Failed to generate pairing code from WhatsApp servers." });
                }
            }
        } else {
            if (res && typeof res.send === 'function' && !res.headersSent) {
                return res.send({ status: "Already connected", number: sanitizedNumber });
            }
        }
    } catch (error) {
        console.error("❌ StartBot fatal error:", error.message);
        if (res && typeof res.status === 'function' && !res.headersSent) {
            return res.status(500).send({ error: error.message || "Internal server error during pairing." });
        }
    }
}

// ==========================================
// 🔥 API Endpoints
// ==========================================

// Logout
router.post('/logout', async (req, res) => {
    const { number } = req.body || req.query;
    if (!number) return res.status(400).send({ error: 'Phone number is required!' });

    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    try {
        if (activeSockets.has(sanitizedNumber)) {
            const sock = activeSockets.get(sanitizedNumber);
            try {
                await sock.logout();
                await sock.end();
            } catch (e) {
                console.log("Error during logout:", e.message);
            }
            activeSockets.delete(sanitizedNumber);
        }

        await Session.deleteOne({ number: sanitizedNumber });
        const sessionDir = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        await fs.remove(sessionDir);

        console.log(`✅ Session logged out for ${sanitizedNumber}`);
        res.send({ 
            status: "Logged out successfully", 
            number: sanitizedNumber,
            message: "You can now reconnect with a new pairing code." 
        });
    } catch (e) {
        console.error("Logout error:", e);
        res.status(500).send({ error: e.message });
    }
});

// Get all sessions
router.get('/sessions', async (req, res) => {
    try {
        const allSessions = await Session.find({});
        const active = Array.from(activeSockets.keys());
        
        res.send({
            total: allSessions.length,
            active: active,
            sessions: allSessions.map(s => ({
                number: s.number,
                lastSeen: s.lastSeen || s.updatedAt,
                isActive: active.includes(s.number)
            }))
        });
    } catch (e) {
        res.status(500).send({ error: e.message });
    }
});

// Reconnect
router.post('/reconnect', async (req, res) => {
    const { number } = req.body || req.query;
    if (!number) return res.status(400).send({ error: 'Phone number is required!' });

    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    try {
        const session = await Session.findOne({ number: sanitizedNumber });
        if (!session) {
            return res.status(404).send({ 
                error: 'No session found for this number. Please pair first.' 
            });
        }

        if (activeSockets.has(sanitizedNumber)) {
            return res.send({ 
                status: "Already connected", 
                number: sanitizedNumber 
            });
        }

        await StartBot(sanitizedNumber, null, true);
        
        res.send({ 
            status: "Reconnect initiated", 
            number: sanitizedNumber 
        });
    } catch (e) {
        res.status(500).send({ error: e.message });
    }
});

// Main pairing route
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Phone number is required!' });

    try {
        const sanitized = number.replace(/[^0-9]/g, '');
        const existingSession = await Session.findOne({ number: sanitized });
        
        if (existingSession && existingSession.creds && Object.keys(existingSession.creds).length > 0) {
            if (!activeSockets.has(sanitized)) {
                console.log(`🔄 Existing session found for ${number}, attempting to restore...`);
                await StartBot(number, res, true);
                return;
            }
        }

        await StartBot(number, res, false);
    } catch (e) {
        console.error("Route router.get error:", e);
        if (!res.headersSent) {
            res.status(500).send({ error: e.message });
        }
    }
});

// Restore sessions on startup
(async () => {
    try {
        await delay(5000);
        await restoreExistingSessions();
    } catch (e) {
        console.error("Error during initial session restoration:", e.message);
    }
})();

module.exports = router;
