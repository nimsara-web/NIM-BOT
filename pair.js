/**
 * Project: NIM BOT - Public Multi-User Pairing Module
 * Creator: Nimsara
 * Mode: Full Features Enabled
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
// 🔥 NEW: Store menu message IDs to detect replies to bot's menu
const menuMessageIds = new Map();

// ==========================================
// Get message body
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
// MongoDB Auth State
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
                await Session.deleteOne({ number: sanitizedNumber });
                dbData = null;
            }
        } catch (e) {
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
                        }
                    }
                } catch (e) {
                    console.error(`❌ Error saving creds:`, e.message);
                }
            }
        } catch (e) {
            console.error(`❌ Error in enhancedSaveCreds:`, e.message);
        }
    };

    return { state, saveCreds: enhancedSaveCreds };
}

// ==========================================
// Setup Command Handlers
// ==========================================
function setupCommandHandlers(socket, number) {

    // Anti-Delete handler
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

                        console.log(`[ANTI-DELETE SUCCESS] Captured from: ${senderJid}`);
                    }
                }
            }
        }
    });

    // Main message handler
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg) return;

        // Cache for anti-delete
        if (msg.key && msg.key.id) {
            messageCache.set(msg.key.id, msg);
            if (msg.key.stanzaId) messageCache.set(msg.key.stanzaId, msg);
            
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

        // Auto-read
        global.autoReadStatus = global.autoReadStatus || 'off';
        if (global.autoReadStatus === 'all') {
            await socket.readMessages([msg.key]);
        } else if (global.autoReadStatus === 'cmd' && isCommand) {
            await socket.readMessages([msg.key]);
        }

        // Channel forwarding
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
                messagePayload = { text: content, contextInfo: channelInfo };
            } else {
                messagePayload = {
                    ...content,
                    contextInfo: { ...(content.contextInfo || {}), ...channelInfo }
                };
            }
            return await socket.sendMessage(sender, messagePayload, { quoted: quotedMsg });
        };

        // ==========================================
        // 🔥 MENU REPLY HANDLER - FIXED
        // ==========================================
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedStanzaId = contextInfo?.stanzaId || '';
        const quotedParticipant = contextInfo?.participant || '';
        
        // Get quoted message text from multiple types
        let quotedText = '';
        const qm = contextInfo?.quotedMessage || {};
        if (qm.conversation) {
            quotedText = qm.conversation;
        } else if (qm.extendedTextMessage?.text) {
            quotedText = qm.extendedTextMessage.text;
        } else if (qm.imageMessage?.caption) {
            quotedText = qm.imageMessage.caption;
        } else if (qm.videoMessage?.caption) {
            quotedText = qm.videoMessage.caption;
        }

        // 🔥 FIXED: Check if quoted message is from bot using stored menu IDs
        const isBotMenuMessage = quotedStanzaId && menuMessageIds.has(quotedStanzaId);
        
        // Also check by menu text keywords as backup
        const hasMenuKeywords = quotedText.includes('𝗕𝗢𝗧 𝗠𝗘𝗡𝗨') || 
                               quotedText.includes('MENU CATEGORIES') ||
                               quotedText.includes('Reply to this message with a number') ||
                               (quotedText.includes('DOWNLOAD COMMANDS') && quotedText.includes('SETTINGS COMMANDS')) ||
                               (quotedText.includes('1️⃣') && quotedText.includes('2️⃣') && quotedText.includes('3️⃣')) ||
                               (quotedText.includes('Reply 0') && quotedText.includes('Main Menu'));

        const isMenuReply = isBotMenuMessage || hasMenuKeywords;

        console.log(`[MENU DEBUG] Body: "${body}" | stanzaId: ${quotedStanzaId} | isBotMenu: ${isBotMenuMessage} | hasKeywords: ${hasMenuKeywords} | isMenuReply: ${isMenuReply}`);

        // ==========================================
        // Handle category selection (1-5)
        // ==========================================
        if (!isCommand && body.match(/^[1-5]$/) && isMenuReply) {
            const categoryNum = parseInt(body);
            let categoryMenu = '';
            const botName = await get('BOT_NAME', number) || 'NIM BOT';

            console.log(`[MENU] ✅ Processing category ${categoryNum}`);

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

            const sentMsg = await socket.sendMessage(sender, {
                text: categoryMenu.trim(),
                contextInfo: channelInfo
            }, { quoted: msg });
            
            if (sentMsg?.key?.id) {
                menuMessageIds.set(sentMsg.key.id, { type: 'category', num: categoryNum });
                console.log(`[MENU] Stored category msg ID: ${sentMsg.key.id}`);
            }
            
            userCategoryState.set(sender, categoryNum);
            console.log(`[MENU] ✅ Sent category ${categoryNum}`);
            return;
        }

        // ==========================================
        // Handle "0" to go back to main menu
        // ==========================================
        if (!isCommand && body === '0' && isMenuReply) {
            console.log(`[MENU] ✅ Going back to main menu`);
            
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

            const sentMsg = await socket.sendMessage(sender, {
                image: { url: BOT_IMAGE_URL },
                caption: mainMenu.trim(),
                contextInfo: channelInfo
            }, { quoted: msg });
            
            if (sentMsg?.key?.id) {
                menuMessageIds.set(sentMsg.key.id, { type: 'main' });
                console.log(`[MENU] Stored main menu msg ID: ${sentMsg.key.id}`);
            }
            
            return;
        }

        // ==========================================
        // Auto-reply with anti-loop protection
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
                
                if (isFromBot || isBotResponse) return;

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
                } else if (textLower.includes('payment') || textLower.includes('bank details')) {
                    await reply(`*💰Payment Details*

💡Bank - Commercial Bank - 8029210301
💡Bank - Lolc Bank - 03210014631
💡Bank - NSB - 109090193739
💡Bank - Dialog Finance - 001021434294
💡Bank - Peoples Bank - 015200130082418

*🪄EZ CASH* - 0740532742
*🪙 BINANCE* - id: 842717887`);
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
        // COMMAND HANDLING
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

                // Delete message recover
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
                        await reply('❌ මේ චැට් එකේ recent delete කරපු message එකක් හමුවුණේ නෑ! 😔');
                        return;
                    }

                    const senderJid = lastDeleted.sender;
                    const senderName = senderJid.split('@')[0];

                    const recoverText = `
╭─❖ *🗑️ DELETED MESSAGE RECOVERED* ❖─╮
│
│ 👤 *Sender:* @${senderName}
│ ⏰ *Time:* ${lastDeleted.time}
│ 💬 *Message:*
│ ${lastDeleted.text}
│
╰─────────────────────────❖

> _Recovered by NIM BOT Anti-Delete_`;

                    await reply({
                        text: recoverText.trim(),
                        mentions: [senderJid]
                    });

                    if (lastDeleted.originalMsg) {
                        try {
                            await reply(`📌 *Original message*`, lastDeleted.originalMsg);
                        } catch (e) {}
                    }
                    break;
                }

                // JID command
                case 'jid': {
                    const chatJid = msg.key.remoteJid;
                    const senderJid = msg.key.participant || msg.key.remoteJid;
                    const quotedJid = msg.message?.extendedTextMessage?.contextInfo?.participant || 'None';

                    await reply(`
📍 *JID INFORMATION* 📍

💬 *Chat JID:* \`${chatJid}\`
👤 *Sender JID:* \`${senderJid}\`
🎯 *Quoted JID:* \`${quotedJid}\`
`.trim(), msg);
                    break;
                }

                // AI command
                case 'ai':
                case 'gpt': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a question!\nExample: .ai What is AI?`);

                    await reply(`🤖 Thinking... 🧠`);
                    try {
                        let aiAnswer = null;

                        try {
                            const apiRes = await axios.get(`https://bk9.fun/ai/gemini?q=${encodeURIComponent(query)}`, { timeout: 15000 });
                            aiAnswer = apiRes.data?.result || apiRes.data?.gpt || apiRes.data?.answer;
                        } catch (e1) {}

                        if (!aiAnswer) {
                            try {
                                const res = await axios.get(`https://api.affiliateplus.xyz/api/gpt?query=${encodeURIComponent(query)}`, { timeout: 15000 });
                                aiAnswer = res.data?.reply || res.data?.response || res.data?.result;
                            } catch (e2) {}
                        }

                        if (!aiAnswer) {
                            try {
                                const res = await axios.get(`https://delirius-apiofc.vercel.app/ai/gpt4?q=${encodeURIComponent(query)}`, { timeout: 15000 });
                                aiAnswer = res.data?.data || res.data?.response || res.data?.result;
                            } catch (e3) {}
                        }

                        if (!aiAnswer) {
                            try {
                                const res = await axios.get(`https://api.siputzx.my.id/api/ai/chatgpt?q=${encodeURIComponent(query)}`, { timeout: 15000 });
                                aiAnswer = res.data?.data || res.data?.response || res.data?.result;
                            } catch (e4) {}
                        }

                        if (!aiAnswer) {
                            return reply(`❌ AI එකෙන් උත්තරයක් ලබාගන්න බැරි වුණා.`);
                        }

                        await reply(`
🤖 *AI ASSISTANT* 🤖

${aiAnswer.trim()}

🔗 *Channel:* ${BOT_CHANNEL_LINK}
`.trim(), msg);

                    } catch (e) {
                        await reply(`❌ AI Error: ${e.message}`);
                    }
                    break;
                }

                // Song command
                case 'song': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a song name!\nExample: .song Manike`);

                    await reply(`🔍 Searching for *${query}*... 🎶`);
                    try {
                        const search = await yts(query);
                        const video = search.videos[0];
                        if (!video) return reply(`❌ Song not found!`);

                        await reply(`🎵 Found: *${video.title}*\n📥 Generating audio...`);

                        let audioUrl = null;

                        try {
                            const { stdout } = await execPromise(`yt-dlp --get-url -f bestaudio "${video.url}"`);
                            audioUrl = stdout.trim().split('\n')[0];
                        } catch (e) {
                            console.log("yt-dlp failed, using ytdl-core");
                        }

                        if (!audioUrl) {
                            try {
                                const ytdl = require('@distube/ytdl-core');
                                const info = await ytdl.getInfo(video.url);
                                const format = ytdl.chooseFormat(info, { quality: 'highestaudio', filter: 'audioonly' });
                                audioUrl = format.url;
                            } catch (e) {
                                console.log("ytdl-core failed:", e.message);
                            }
                        }

                        if (!audioUrl) return reply(`❌ Audio link එක ලබාගන්න බැරි වුණා.`);

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
                        await reply(`❌ Failed: ${e.message}`);
                    }
                    break;
                }

                // TikTok command
                case 'tt':
                case 'tiktok': {
                    const url = args[0];
                    if (!url || !url.includes('tiktok.com')) {
                        return reply(`⚠️ Please provide a TikTok link!\nExample: .tt https://vt.tiktok.com/xxxx/`);
                    }

                    await reply(`📥 Processing TikTok... ⏳`);
                    try {
                        let videoUrl = null;

                        try {
                            const { stdout } = await execPromise(`yt-dlp --get-url "${url}"`);
                            videoUrl = stdout.trim().split('\n')[0];
                        } catch (e) {}

                        if (!videoUrl) {
                            try {
                                const apiRes = await axios.get(`https://api.vevioz.com/api/button/tiktok/${encodeURIComponent(url)}`, { timeout: 15000 });
                                videoUrl = apiRes.data?.downloadUrl || apiRes.data?.url || apiRes.data?.link;
                            } catch (e) {}
                        }

                        if (!videoUrl) return reply(`❌ TikTok වීඩියෝ ලින්ක් එක ලබාගන්න බැරි වුණා.`);

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            caption: `🎬 *TikTok Video*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`
                        }, { quoted: msg });

                    } catch (e) {
                        await reply(`❌ Error: ${e.message}`);
                    }
                    break;
                }

                // YouTube command
                case 'yt':
                case 'youtube': {
                    const url = args[0];
                    const type = args[1] ? args[1].toLowerCase() : 'video';

                    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
                        return reply(`⚠️ Usage: .yt [URL] [video/audio]`);
                    }

                    try {
                        await reply(`📥 Processing YouTube... ⏳`);
                        let mediaUrl = null;

                        try {
                            const cmd = type === 'audio' 
                                ? `yt-dlp --get-url -f bestaudio "${url}"`
                                : `yt-dlp --get-url -f "best[ext=mp4]/best" "${url}"`;
                            const { stdout } = await execPromise(cmd);
                            mediaUrl = stdout.trim().split('\n')[0];
                        } catch (e) {}

                        if (!mediaUrl) {
                            try {
                                const ytdl = require('@distube/ytdl-core');
                                const info = await ytdl.getInfo(url);
                                const format = type === 'audio'
                                    ? ytdl.chooseFormat(info, { quality: 'highestaudio', filter: 'audioonly' })
                                    : ytdl.chooseFormat(info, { quality: 'highestvideo', filter: 'videoandaudio' });
                                mediaUrl = format.url;
                            } catch (e) {}
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
                        await reply(`❌ Failed: ${e.message}`);
                    }
                    break;
                }

                // Facebook command
                case 'fb':
                case 'facebook': {
                    const url = args[0];
                    if (!url || (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.me'))) {
                        return reply(`⚠️ Please provide a Facebook link!`);
                    }

                    await reply(`📥 Processing Facebook... ⏳`);
                    try {
                        let videoUrl = null;

                        try {
                            const { stdout } = await execPromise(`yt-dlp --get-url "${url}"`);
                            videoUrl = stdout.trim().split('\n')[0];
                        } catch (e) {}

                        if (!videoUrl) {
                            try {
                                const apiRes = await axios.get(`https://api.vevioz.com/api/button/facebook/${encodeURIComponent(url)}`, { timeout: 15000 });
                                videoUrl = apiRes.data?.downloadUrl || apiRes.data?.url || apiRes.data?.link;
                            } catch (e) {}
                        }

                        if (!videoUrl) return reply(`❌ Facebook වීඩියෝ ලින්ක් එක ලබාගන්න බැරි වුණා.`);

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            caption: `🎬 *Facebook Video*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`
                        }, { quoted: msg });

                    } catch (e) {
                        await reply(`❌ Error: ${e.message}`);
                    }
                    break;
                }

                // ToURL command
                case 'tourl':
                case 'url': {
                    try {
                        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || msg.quoted;
                        const mime = (msg.message?.imageMessage?.mimetype || msg.message?.videoMessage?.mimetype || quoted?.imageMessage?.mimetype || quoted?.videoMessage?.mimetype || '');

                        if (!mime || (!mime.includes('image') && !mime.includes('video'))) {
                            return reply(`⚠️ Please send/reply to an image or video with .tourl`);
                        }

                        await reply(`⏳ Uploading media... 🚀`);

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
                            return reply(`❌ Upload failed.`);
                        }

                    } catch (e) {
                        await reply(`❌ Error: ${e.message}`);
                    }
                    break;
                }

                // MENU command
                case 'allmenu':
                case 'menu':
                case 'help': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

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

                    const sentMsg = await socket.sendMessage(sender, {
                        image: { url: BOT_IMAGE_URL },
                        caption: captionText.trim(),
                        contextInfo: channelInfo
                    }, { quoted: msg });

                    if (sentMsg?.key?.id) {
                        menuMessageIds.set(sentMsg.key.id, { type: 'main', timestamp: Date.now() });
                        console.log(`[MENU] ✅ Stored main menu ID: ${sentMsg.key.id}`);
                        
                        if (menuMessageIds.size > 100) {
                            const oldest = menuMessageIds.keys().next().value;
                            menuMessageIds.delete(oldest);
                        }
                    }

                    await delay(1500);

                    const audioBuffer = await getAudioBuffer(BOT_AUDIO_URL);
                    if (audioBuffer) {
                        const audioSent = await socket.sendMessage(sender, {
                            audio: audioBuffer,
                            mimetype: 'audio/mpeg',
                            ptt: false
                        }, { quoted: msg });
                    }
                    break;
                }

                // Mode command
                case 'mode': {
                    if (!msg.key.fromMe) {
                        return reply(`⚠️ Only Bot Owner! ❌`);
                    }

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validModes = ['public', 'group', 'inbox', 'private'];

                    if (!validModes.includes(option)) {
                        const currentMode = await get('BOT_MODE', number) || 'public';
                        return reply(`⚙️ *Bot Mode*\n\nCurrent: *${currentMode.toUpperCase()}*\n\nOptions:\n• .mode public\n• .mode group\n• .mode inbox\n• .mode private`);
                    }

                    await handleSettingUpdate("BOT_MODE", option, reply, number);
                    break;
                }

                // Ping command
                case 'ping': {
                    const start = Date.now();
                    const sentMsg = await socket.sendMessage(sender, { text: 'Pinging...' }, { quoted: msg });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { text: `🏓 Pong! *${latency}ms*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}` }, { quoted: sentMsg });
                    break;
                }

                // Autoread command
                case 'autoread': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner! ❌`);

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validOptions = ['all', 'cmd', 'off'];

                    if (!validOptions.includes(option)) {
                        return reply(`👀 *Auto-Read*\n\nCurrent: *${(global.autoReadStatus || 'off').toUpperCase()}*\n\nOptions:\n• .autoread all\n• .autoread cmd\n• .autoread off`);
                    }

                    global.autoReadStatus = option;
                    await reply(`✅ Auto-Read: *${global.autoReadStatus.toUpperCase()}*`);
                    break;
                }

                // Autoreply command
                case 'autoreply': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner! ❌`);

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validOptions = ['all', 'inbox', 'group', 'off'];

                    if (!validOptions.includes(option)) {
                        return reply(`🤖 *Auto-Reply*\n\nCurrent: *${(global.autoReplyMode || 'off').toUpperCase()}*\n\nOptions:\n• .autoreply all\n• .autoreply inbox\n• .autoreply group\n• .autoreply off`);
                    }

                    global.autoReplyMode = option;
                    await reply(`✅ Auto-Reply: *${global.autoReplyMode.toUpperCase()}*`);
                    break;
                }

                // Alive/Status command
                case 'alive':
                case 'status': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const aliveText = `👋 *${botName}* is online!\n⏱️ Uptime: ${hours}h ${minutes}m ${seconds}s\n👨‍💻 Creator: Nimsara\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`;

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

                // Runtime command
                case 'runtime': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    await reply(`⏱️ *${botName} Uptime:* ${hours}h ${minutes}m ${seconds}s`);
                    break;
                }

                // Owner command
                case 'owner': {
                    await reply(`👑 *Bot Owner*\n> Name: Nimsara\n> Contact: 0784280074\n> Bot: ${botName}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    break;
                }

                // Send/Save command
                case 'send':
                case 'save': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted || !quoted.quotedMessage) {
                        return reply(`⚠️ Please reply to media with *${prefix}send*`);
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
                            const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                            const innerMsg = quotedMsg.message[messageType];
                            const caption = `${innerMsg?.caption || ''}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`;

                            if (messageType === 'imageMessage') {
                                await socket.sendMessage(sender, { image: buffer, caption }, { quoted: msg });
                            } else if (messageType === 'videoMessage') {
                                await socket.sendMessage(sender, { video: buffer, caption }, { quoted: msg });
                            } else if (messageType === 'audioMessage') {
                                await socket.sendMessage(sender, { audio: buffer, mimetype: 'audio/mpeg', ptt: innerMsg?.ptt || false }, { quoted: msg });
                            } else if (messageType === 'documentMessage') {
                                await socket.sendMessage(sender, { document: buffer, mimetype: innerMsg?.mimetype, fileName: innerMsg?.fileName }, { quoted: msg });
                            }
                        } else if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                            const text = quoted.quotedMessage.conversation || quoted.quotedMessage.extendedTextMessage?.text;
                            await reply(`📥 *Saved:*\n\n${text}`);
                        }
                    } catch (err) {
                        await reply(`❌ Failed: ${err.message}`);
                    }
                    break;
                }

                // View Once command
                case 'vv':
                case 'viewonce': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted || !quoted.quotedMessage) {
                        return reply(`⚠️ Please reply to a View Once media with *${prefix}vv*`);
                    }

                    let qMsg = quoted.quotedMessage;
                    if (qMsg.ephemeralMessage) qMsg = qMsg.ephemeralMessage.message;
                    if (qMsg.viewOnceMessage) qMsg = qMsg.viewOnceMessage.message;
                    if (qMsg.viewOnceMessageV2) qMsg = qMsg.viewOnceMessageV2.message;
                    if (qMsg.viewOnceMessageV2Extension) qMsg = qMsg.viewOnceMessageV2Extension.message;

                    const messageType = Object.keys(qMsg)[0];

                    if (['imageMessage', 'videoMessage'].includes(messageType)) {
                        const downloadMsg = {
                            key: { remoteJid: quoted.remoteJid || sender, id: quoted.stanzaId, participant: quoted.participant },
                            message: { [messageType]: qMsg[messageType] }
                        };

                        try {
                            const buffer = await downloadMediaMessage(downloadMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                            const innerMsg = qMsg[messageType];
                            const caption = `📥 *View Once Media*\n\n${innerMsg?.caption || ''}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`;

                            if (messageType === 'imageMessage') {
                                await socket.sendMessage(sender, { image: buffer, caption }, { quoted: msg });
                            } else if (messageType === 'videoMessage') {
                                await socket.sendMessage(sender, { video: buffer, caption }, { quoted: msg });
                            }
                        } catch (err) {
                            await reply(`❌ Failed: ${err.message}`);
                        }
                    } else {
                        await reply(`⚠️ Please reply to a View Once image or video!`);
                    }
                    break;
                }

                // Set prefix command
                case 'setprefix': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner! ❌`);
                    const newPrefix = args[0];
                    if (!newPrefix) return reply(`⚠️ Usage: .setprefix [New Prefix]`);
                    await handleSettingUpdate("PREFIX", newPrefix, reply, number);
                    break;
                }

                // Settings command
                case 'settings': {
                    const pfx = await get('PREFIX', number) || '.';
                    const bName = await get('BOT_NAME', number) || 'NIM BOT';
                    const autoView = await get('AUTO_VIEW_STATUS', number) ?? 'true';
                    const autoLike = await get('AUTO_LIKE_STATUS', number) ?? 'true';
                    const alwaysOnline = await get('ALWAYS_ONLINE', number) ?? 'true';

                    await reply(`⚙️ *${bName} SETTINGS*

> Bot Name: *${bName}*
> Prefix: *${pfx}*
> Auto View: *${autoView}*
> Auto Like: *${autoLike}*
> Always Online: *${alwaysOnline}*

🛠️ *Commands:*
• ${pfx}autoview [on/off]
• ${pfx}autolike [on/off]
• ${pfx}alwaysonline [on/off]
• ${pfx}setprefix [prefix]`);
                    break;
                }

                // Auto view command
                case 'autoview': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner! ❌`);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: .autoview on OR .autoview off`);
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_VIEW_STATUS", normalized, reply, number);
                    break;
                }

                // Auto like command
                case 'autolike': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner! ❌`);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: .autolike on OR .autolike off`);
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_LIKE_STATUS", normalized, reply, number);
                    break;
                }

                // Always online command
                case 'alwaysonline': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner! ❌`);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: .alwaysonline on OR .alwaysonline off`);
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
// Status & Presence Handlers
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
                    try { await socket.readMessages([msg.key]); } catch (e) { }
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
// Restore Existing Sessions
// ==========================================
async function restoreExistingSessions() {
    try {
        console.log("🔄 Checking for existing sessions...");
        const allSessions = await Session.find({});
        
        if (allSessions.length === 0) {
            console.log("ℹ️ No existing sessions found.");
            return;
        }

        console.log(`📋 Found ${allSessions.length} sessions. Restoring...`);

        for (const session of allSessions) {
            if (session.number && session.creds && Object.keys(session.creds).length > 0) {
                try {
                    if (activeSockets.has(session.number)) continue;

                    console.log(`🔄 Restoring ${session.number}...`);
                    await StartBot(session.number, null, true);
                    await delay(2000);
                } catch (e) {
                    console.error(`❌ Failed ${session.number}:`, e.message);
                }
            }
        }
        console.log("✅ Session restoration completed.");
    } catch (e) {
        console.error("❌ Error:", e.message);
    }
}

// ==========================================
// 🔥 Start Bot Function - WITH CONNECT MESSAGE FIX
// ==========================================
async function StartBot(number, res = null, isRestore = false) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    if (activeSockets.has(sanitizedNumber)) {
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

        // 🔥 Flag to prevent duplicate connect messages
        let connectMessageSent = false;

        // 🔥 Helper function to send connect message
        const sendConnectMessage = async (currentSock, botNumber) => {
            if (connectMessageSent) {
                console.log(`[CONNECT MSG] Already sent for ${botNumber}, skipping`);
                return;
            }
            connectMessageSent = true;

            try {
                let botName = 'NIM BOT';
                let currentPrefix = '.';
                try {
                    botName = await get('BOT_NAME', botNumber) || 'NIM BOT';
                    currentPrefix = await get('PREFIX', botNumber) || '.';
                } catch (e) { }

                // 🔥 Send to OWN number (self-chat)
                const ownJid = `${botNumber}@s.whatsapp.net`;
                
                console.log(`[CONNECT MSG] 📤 Sending to own number: ${ownJid}`);

                // Send image + caption
                await currentSock.sendMessage(ownJid, {
                    image: { url: BOT_IMAGE_URL },
                    caption: `🎉 *${botName} CONNECTED* 🎉\n\n✅ Your WhatsApp Bot is now online and active!\n\n• Name: *${botName}*\n• Number: *${botNumber}*\n• Prefix: *${currentPrefix}*\n\nType *${currentPrefix}menu* to view commands.\n\n🔗 Channel: ${BOT_CHANNEL_LINK}\n> Creator: *Nimsara*`,
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

                console.log(`[CONNECT MSG] ✅ Image sent`);

                await delay(1500);

                // Send audio
                const audioBuffer = await getAudioBuffer(BOT_AUDIO_URL);
                if (audioBuffer) {
                    await currentSock.sendMessage(ownJid, {
                        audio: audioBuffer,
                        mimetype: 'audio/mpeg',
                        ptt: false
                    });
                    console.log(`[CONNECT MSG] ✅ Audio sent`);
                }

                console.log(`[CONNECT MSG] 🎉 All messages sent to ${ownJid}`);

            } catch (err) {
                console.log(`[CONNECT MSG] ❌ Error:`, err.message);
                connectMessageSent = false; // Allow retry
            }
        };

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log(`✅ Bot connected: ${sanitizedNumber}`);
                reconnectAttempts.set(sanitizedNumber, 0);

                try {
                    if (typeof ensureConfig === 'function') {
                        await ensureConfig(sanitizedNumber);
                    }
                } catch (err) { }

                socketCreationTime.set(sanitizedNumber, Date.now());
                activeSockets.set(sanitizedNumber, sock);

                // 🔥 Send connect message ONLY for new connections (not restores)
                if (!isRestore) {
                    // Wait a bit for socket to fully stabilize, then send
                    setTimeout(() => {
                        sendConnectMessage(sock, sanitizedNumber);
                    }, 3000);
                } else {
                    console.log(`✅ Session restored for ${sanitizedNumber} (no connect message)`);
                }

                if (res && typeof res.send === 'function' && !res.headersSent) {
                    return res.send({ status: "Connected", number: sanitizedNumber });
                }

            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Connection closed: ${sanitizedNumber}, code: ${statusCode}`);
                activeSockets.delete(sanitizedNumber);

                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    await Session.deleteOne({ number: sanitizedNumber });
                    await fs.remove(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));
                } else {
                    const attempts = (reconnectAttempts.get(sanitizedNumber) || 0) + 1;
                    reconnectAttempts.set(sanitizedNumber, attempts);
                    
                    const delayTime = Math.min(3000 * Math.pow(1.5, attempts - 1), 60000);
                    setTimeout(() => StartBot(sanitizedNumber, null, true), delayTime);
                }
            }
        });

        setupCommandHandlers(sock, sanitizedNumber);
        setupStatusAndPresenceHandlers(sock, sanitizedNumber);

        // 🔥 PAIRING CODE LOGIC
        if (!sock.authState.creds.registered) {
            if (isRestore) {
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
                
                // 🔥 Send pairing code FIRST
                if (res && typeof res.send === 'function' && !res.headersSent) {
                    res.send({ code });
                }

                // 🔥 Then wait for connection to open (handled by connection.update event above)
                console.log(`✅ Pairing code sent: ${code}, waiting for connection...`);

            } catch (err) {
                if (res && typeof res.status === 'function' && !res.headersSent) {
                    return res.status(500).send({ error: err.message });
                }
            }
        } else {
            // Already registered - just send status
            if (res && typeof res.send === 'function' && !res.headersSent) {
                return res.send({ status: "Already connected", number: sanitizedNumber });
            }
        }

    } catch (error) {
        console.error("❌ StartBot error:", error.message);
        if (res && typeof res.status === 'function' && !res.headersSent) {
            return res.status(500).send({ error: error.message });
        }
    }
}

// ==========================================
// API Endpoints
// ==========================================

router.post('/logout', async (req, res) => {
    const { number } = req.body || req.query;
    if (!number) return res.status(400).send({ error: 'Phone number required!' });

    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    try {
        if (activeSockets.has(sanitizedNumber)) {
            const sock = activeSockets.get(sanitizedNumber);
            try {
                await sock.logout();
                await sock.end();
            } catch (e) {}
            activeSockets.delete(sanitizedNumber);
        }

        await Session.deleteOne({ number: sanitizedNumber });
        await fs.remove(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));

        res.send({ status: "Logged out", number: sanitizedNumber });
    } catch (e) {
        res.status(500).send({ error: e.message });
    }
});

router.get('/sessions', async (req, res) => {
    try {
        const allSessions = await Session.find({});
        const active = Array.from(activeSockets.keys());
        
        res.send({
            total: allSessions.length,
            active: active,
            sessions: allSessions.map(s => ({
                number: s.number,
                isActive: active.includes(s.number)
            }))
        });
    } catch (e) {
        res.status(500).send({ error: e.message });
    }
});

router.post('/reconnect', async (req, res) => {
    const { number } = req.body || req.query;
    if (!number) return res.status(400).send({ error: 'Phone number required!' });

    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    try {
        const session = await Session.findOne({ number: sanitizedNumber });
        if (!session) return res.status(404).send({ error: 'No session found.' });

        if (activeSockets.has(sanitizedNumber)) {
            return res.send({ status: "Already connected" });
        }

        await StartBot(sanitizedNumber, null, true);
        res.send({ status: "Reconnect initiated" });
    } catch (e) {
        res.status(500).send({ error: e.message });
    }
});

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Phone number required!' });

    try {
        const sanitized = number.replace(/[^0-9]/g, '');
        const existingSession = await Session.findOne({ number: sanitized });
        
        if (existingSession && existingSession.creds && Object.keys(existingSession.creds).length > 0) {
            if (!activeSockets.has(sanitized)) {
                await StartBot(number, res, true);
                return;
            }
        }

        await StartBot(number, res, false);
    } catch (e) {
        if (!res.headersSent) res.status(500).send({ error: e.message });
    }
});

// Restore sessions on startup
(async () => {
    try {
        await delay(5000);
        await restoreExistingSessions();
    } catch (e) {
        console.error("Restore error:", e.message);
    }
})();

module.exports = router;
