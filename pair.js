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

const FOOTER = '\n\n> *Creator by Nimsara* 🧛🏻';

const socketCreationTime = new Map();
const activeSockets = new Map();
const messageCache = new Map();
const deletedMessages = new Map();
const reconnectAttempts = new Map();
const userCategoryState = new Map();
const menuMessageIds = new Map();

// 🔥 Per-group settings (in-memory, restored from DB)
const groupAntiLink = new Map();   // { groupJid: 'on'|'off' }
const groupWelcome = new Map();    // { groupJid: 'on'|'off' }

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
                console.log(`✅ Loaded session from DB for ${sanitizedNumber}`);
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
                    }
                }
            }
        }
    });

    // Main message handler
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg) return;

        if (msg.key && msg.key.id) {
            messageCache.set(msg.key.id, msg);
            if (msg.key.stanzaId) messageCache.set(msg.key.stanzaId, msg);
            
            if (messageCache.size > 500) {
                const keys = messageCache.keys();
                for (let i = 0; i < 250; i++) {
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

        global.autoReadStatus = global.autoReadStatus || 'off';
        if (global.autoReadStatus === 'all') {
            await socket.readMessages([msg.key]);
        } else if (global.autoReadStatus === 'cmd' && isCommand) {
            await socket.readMessages([msg.key]);
        }

        const channelInfo = {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363362308230584@newsletter',
                newsletterName: 'NIM PROJECT',
                serverMessageId: 100
            }
        };

        // Reply with auto-react on command
        const reply = async (content, quotedMsg = msg, reactEmoji = true) => {
            let messagePayload;
            if (typeof content === 'string') {
                messagePayload = { text: content, contextInfo: channelInfo };
            } else {
                messagePayload = {
                    ...content,
                    contextInfo: { ...(content.contextInfo || {}), ...channelInfo }
                };
            }
            
            const sentMsg = await socket.sendMessage(sender, messagePayload, { quoted: quotedMsg });

            // 🔥 Auto-react only if this is a command reply
            if (reactEmoji && isCommand) {
                try {
                    const emojis = ['✅', '👍', '🎯', '⚡', '🔥', '💫', '✨'];
                    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
                    await socket.sendMessage(sender, {
                        react: { text: emoji, key: msg.key }
                    });
                } catch (e) {}
            }

            return sentMsg;
        };

        // ==========================================
        // 🔥 Per-Group Anti-Link Check
        // ==========================================
        if (sender.endsWith('@g.us') && !msg.key.fromMe) {
            const currentStatus = groupAntiLink.get(sender);
            
            // Load from DB if not in memory
            if (!currentStatus) {
                const dbStatus = await get(`ANTILINK_${sender}`, number) || 'off';
                groupAntiLink.set(sender, dbStatus);
            }
            
            const status = groupAntiLink.get(sender);
            
            if (status === 'on') {
                if (body.match(/chat\.whatsapp\.com|whatsapp\.com\/channel/i)) {
                    // Check if sender is admin
                    let isAdmin = false;
                    try {
                        const meta = await socket.groupMetadata(sender);
                        const participant = meta.participants.find(p => p.id === msg.key.participant);
                        isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                    } catch (e) {}
                    
                    // Don't delete if sender is admin
                    if (!isAdmin) {
                        try {
                            await socket.sendMessage(sender, { delete: msg.key });
                            await socket.sendMessage(sender, {
                                text: `🚫 *Link Detected!*\n\n@${(msg.key.participant || '').split('@')[0]} Links are not allowed!` + FOOTER,
                                mentions: [msg.key.participant]
                            });
                            return;
                        } catch (e) {
                            console.log("Anti-link error:", e.message);
                        }
                    }
                }
            }
        }

        // ==========================================
        // MENU REPLY HANDLER
        // ==========================================
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedStanzaId = contextInfo?.stanzaId || '';
        
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

        const isBotMenuMessage = quotedStanzaId && menuMessageIds.has(quotedStanzaId);
        
        const hasMenuKeywords = quotedText.includes('𝗕𝗢𝗧 𝗠𝗘𝗡𝗨') || 
                               quotedText.includes('MENU CATEGORIES') ||
                               quotedText.includes('Reply to this message with a number') ||
                               (quotedText.includes('DOWNLOAD COMMANDS') && quotedText.includes('SETTINGS COMMANDS')) ||
                               (quotedText.includes('1️⃣') && quotedText.includes('2️⃣') && quotedText.includes('3️⃣')) ||
                               (quotedText.includes('Reply 0') && quotedText.includes('Main Menu'));

        const isMenuReply = isBotMenuMessage || hasMenuKeywords;

        // ==========================================
        // Handle category selection (1-7)
        // ==========================================
        if (!isCommand && body.match(/^[1-7]$/) && isMenuReply) {
            const categoryNum = parseInt(body);
            let categoryMenu = '';
            const botName = await get('BOT_NAME', number) || 'NIM BOT';

            switch(categoryNum) {
                case 1:
                    categoryMenu = `*╭─\`📥 DOWNLOAD COMMANDS\`┈⊷*
*╎*
*╎ 🎵 .song [name]*
*╎    Download songs*
*╎*
*╎ 🎬 .tt / .tiktok [url]*
*╎    Download TikTok videos*
*╎*
*╎ 🎬 .yt / .youtube [url] [video/audio]*
*╎    Download YouTube*
*╎*
*╎ 🎬 .fb / .facebook [url]*
*╎    Download Facebook videos*
*╎*
*╎ 📸 .ig / .instagram [url]*
*╎    Download Instagram posts*
*╎*
*╎ 🔗 .tourl / .url*
*╎    Convert media to URL*
*╎*
*╎ 📸 .vv / .viewonce*
*╎    Download View Once media*
*╎*
*╎ 📥 .send / .save*
*╎    Save quoted media*
*╎*
*╰───────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
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
*╎ 🔗 .antilink [on/off]*
*╎    Anti-link (per group)*
*╎*
*╎ 👋 .welcome [on/off]*
*╎    Welcome (per group)*
*╎*
*╎ 🔤 .setprefix [prefix]*
*╎    Change command prefix*
*╎*
*╰───────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 3:
                    categoryMenu = `*╭─\`👑 OWNER COMMANDS\`┈⊷*
*╎*
*╎ 👤 .owner*
*╎    Bot owner info*
*╎*
*╎ 📋 .settings*
*╎    View all settings*
*╎*
*╎ 🔤 .setprefix [prefix]*
*╎    Change prefix*
*╎*
*╎ 💾 .setreply [trigger] [response]*
*╎    Custom replies*
*╎*
*╎ 📝 .note save [name] [content]*
*╎    Save notes*
*╎*
*╰───────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 4:
                    categoryMenu = `*╭─\`🛠️ UTILITY COMMANDS\`┈⊷*
*╎*
*╎ 🏓 .ping*
*╎    Response time*
*╎*
*╎ ⏱️ .runtime*
*╎    Bot uptime*
*╎*
*╎ 🕐 .time / .date*
*╎    Current time & date*
*╎*
*╎ 📍 .jid*
*╎    JID information*
*╎*
*╎ ❤️ .alive / .status*
*╎    Bot status*
*╎*
*╎ 🗑️ .remsg / .delete*
*╎    Recover deleted msg*
*╎*
*╎ 👤 .whois / .userinfo*
*╎    User information*
*╎*
*╎ 🔐 .password [length]*
*╎    Generate password*
*╎*
*╎ 🔗 .short [url]*
*╎    Shorten URL*
*╎*
*╎ 📱 .qr [text]*
*╎    Generate QR code*
*╎*
*╎ 🌤️ .weather [city]*
*╎    Weather report*
*╎*
*╎ 🌐 .ip [domain]*
*╎    IP/Domain lookup*
*╎*
*╎ 🔐 .base64 [enc/dec] [text]*
*╎    Base64 encode/decode*
*╎*
*╎ ✅ .check [number]*
*╎    Check WhatsApp number*
*╎*
*╎ 💰 .crypto [coin]*
*╎    Crypto prices*
*╎*
*╰───────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 5:
                    categoryMenu = `*╭─\`🤖 AI & CONVERT COMMANDS\`┈⊷*
*╎*
*╎ 🤖 .ai / .gpt [question]*
*╎    AI Chatbot*
*╎*
*╎ 🌐 .tr [lang]*
*╎    Translate (reply to msg)*
*╎*
*╎ 🎨 .imagine [prompt]*
*╎    AI image generator*
*╎*
*╎ 📸 .sticker / .s*
*╎    Image/Video to sticker*
*╎*
*╎ 📱 .fakechat [name|msg]*
*╎    Fake chat image*
*╎*
*╎ 📸 .ss [url]*
*╎    Website screenshot*
*╎*
*╎ 🎤 .tts [text]*
*╎    Text to speech*
*╎*
*╎ 🎨 .textimg [text]*
*╎    Text to image*
*╎*
*╰───────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 6:
                    categoryMenu = `*╭─\`👥 GROUP ADMIN COMMANDS\`┈⊷*
*╎*
*╎ 📢 .tagall [msg]*
*╎    Mention all members*
*╎*
*╎ 👢 .kick*
*╎    Kick member (reply)*
*╎*
*╎ 👑 .promote*
*╎    Make admin (reply)*
*╎*
*╎ 👤 .demote*
*╎    Remove admin (reply)*
*╎*
*╎ 🔇 .mute*
*╎    Mute group*
*╎*
*╎ 🔊 .unmute*
*╎    Unmute group*
*╎*
*╎ 📊 .ginfo / .groupinfo*
*╎    Group information*
*╎*
*╎ 📊 .poll [Q|opt1|opt2]*
*╎    Group poll*
*╎*
*╎ 📞 .getcontact [invite link]*
*╎    Send random messages*
*╎*
*╰───────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 7:
                    categoryMenu = `*╭─\`🎮 FUN COMMANDS\`┈⊷*
*╎*
*╎ 🎯 .quote*
*╎    Random quote*
*╎*
*╎ 🎲 .dice*
*╎    Roll a dice*
*╎*
*╎ 🎰 .flip*
*╎    Flip a coin*
*╎*
*╎ 😂 .joke / .sijoke*
*╎    Random jokes*
*╎*
*╎ 🔢 .random [min] [max]*
*╎    Random number*
*╎*
*╎ 🎂 .bday set [DD/MM]*
*╎    Birthday tracker*
*╎*
*╰───────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                default:
                    return;
            }

            const sentMsg = await socket.sendMessage(sender, {
                text: categoryMenu.trim() + FOOTER,
                contextInfo: channelInfo
            }, { quoted: msg });
            
            if (sentMsg?.key?.id) {
                menuMessageIds.set(sentMsg.key.id, { type: 'category', num: categoryNum });
            }
            
            return;
        }

        // Handle "0" - Back to main menu
        if (!isCommand && body === '0' && isMenuReply) {
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
*╎ 5️⃣ - 🤖 AI & CONVERT*
*╎ 6️⃣ - 👥 GROUP ADMIN*
*╎ 7️⃣ - 🎮 FUN COMMANDS*
*╎*
*╰───────────────────────*

💡 *Reply to this message with a number!*
Example: Reply \`1\` for Download Commands

🔗 Web: https://nimsara-official.vercel.app/
*🏮 FOLLOW CHANNEL :- ${BOT_CHANNEL_LINK}*

> _MADE BY NIMSARA_`;

            const sentMsg = await socket.sendMessage(sender, {
                image: { url: BOT_IMAGE_URL },
                caption: mainMenu.trim(),
                contextInfo: channelInfo
            }, { quoted: msg });
            
            if (sentMsg?.key?.id) {
                messageIdsSet(sentMsg.key.id);
            }
            
            function messageIdsSet(id) {
                menuMessageIds.set(id, { type: 'main' });
            }
            
            return;
        }

        // Auto-reply
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

                global.customReplies = global.customReplies || {};
                if (global.customReplies[textLower]) {
                    await reply(global.customReplies[textLower] + FOOTER);
                    return;
                }

                const words = textLower.split(/\s+/);
                const hasKeyword = (word) => words.some(w => w === word || w.includes(word));

                if (hasKeyword('hi') || hasKeyword('හායි') || hasKeyword('hello')) {
                    await reply('Hi! 👋' + FOOTER);
                } else if (hasKeyword('mk') || textLower.includes('mokada karanne')) {
                    await reply('Mokuth Na innwa😊' + FOOTER);
                } else if (hasKeyword('gm') || textLower.includes('good morning')) {
                    await reply('Good Morning🌤️' + FOOTER);
                } else if (hasKeyword('gn') || textLower.includes('good night')) {
                    await reply('Good Night✨' + FOOTER);
                } else if (hasKeyword('bye') || hasKeyword('බායි')) {
                    await reply('Bye🍻' + FOOTER);
                } else if (textLower.includes('r2k') || textLower.includes('pawara')) {
                    await reply(`*🔥 R2K Gaming Channels 🔥*

💓Tik Tok - https://www.tiktok.com/@rush.2.kill__00
💓Youtube - https://www.youtube.com/@rush.2.kill__0
💓Fb - https://www.facebook.com/profile.php?id=61581297341821

*\`Thankyou Yaluwe !\`*` + FOOTER);
                } else if (textLower.includes('payment') || textLower.includes('bank details')) {
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


*\`Thankyou !\`*` + FOOTER);
                } else if (textLower.includes('nethmintha') || textLower.includes('නෙත්මින්ත') || textLower.includes('nimsara')) {
                    try {
                        const audioUrl = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/welcomto%20nim%20bot.MP3';
                        const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
                        const audioBuffer = Buffer.from(response.data);
                        await reply({
                            text: 'Ow kiyanna Nimsara tikakin rp karai man eya hadapu Bot! 👨‍💻😎' + FOOTER,
                            audio: audioBuffer,
                            mimetype: 'audio/mp4',
                            ptt: true
                        });
                    } catch (err) {
                        await reply('Ow kiyanna Nimsara tikakin rp karai man eya hadapu Bot! 👨‍💻😎' + FOOTER);
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
                        await reply('❌ මේ චැට් එකේ recent delete කරපු message එකක් හමුවුණේ නෑ! 😔' + FOOTER);
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
╰─────────────────────────❖` + FOOTER;

                    await reply({
                        text: recoverText.trim(),
                        mentions: [senderJid]
                    });
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
`.trim() + FOOTER);
                    break;
                }

                // AI command
                case 'ai':
                case 'gpt': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a question!\nExample: .ai What is AI?` + FOOTER);

                    await reply(`🤖 Thinking... 🧠` + FOOTER);
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
                                const res = await axios.get(`https://api.siputzx.my.id/api/ai/chatgpt?q=${encodeURIComponent(query)}`, { timeout: 15000 });
                                aiAnswer = res.data?.data || res.data?.response || res.data?.result;
                            } catch (e3) {}
                        }

                        if (!aiAnswer) {
                            return reply(`❌ AI එකෙන් උත්තරයක් ලබාගන්න බැරි වුණා.` + FOOTER);
                        }

                        await reply(`🤖 *AI ASSISTANT*\n\n${aiAnswer.trim()}` + FOOTER);

                    } catch (e) {
                        await reply(`❌ AI Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // Song command
                case 'song': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a song name!` + FOOTER);

                    await reply(`🔍 Searching for *${query}*... 🎶` + FOOTER);
                    try {
                        const search = await yts(query);
                        const video = search.videos[0];
                        if (!video) return reply(`❌ Song not found!` + FOOTER);

                        await reply(`🎵 Found: *${video.title}*\n📥 Generating audio...` + FOOTER);

                        let audioUrl = null;

                        try {
                            const { stdout } = await execPromise(`yt-dlp --get-url -f bestaudio "${video.url}"`);
                            audioUrl = stdout.trim().split('\n')[0];
                        } catch (e) {}

                        if (!audioUrl) {
                            try {
                                const ytdl = require('@distube/ytdl-core');
                                const info = await ytdl.getInfo(video.url);
                                const format = ytdl.chooseFormat(info, { quality: 'highestaudio', filter: 'audioonly' });
                                audioUrl = format.url;
                            } catch (e) {}
                        }

                        if (!audioUrl) return reply(`❌ Audio link එක ලබාගන්න බැරි වුණා.` + FOOTER);

                        await socket.sendMessage(sender, {
                            audio: { url: audioUrl },
                            mimetype: 'audio/mpeg',
                            ptt: false,
                            fileName: `${video.title}.mp3`
                        }, { quoted: msg });

                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // TikTok
                case 'tt':
                case 'tiktok': {
                    const url = args[0];
                    if (!url || !url.includes('tiktok.com')) {
                        return reply(`⚠️ Please provide a TikTok link!` + FOOTER);
                    }

                    await reply(`📥 Processing TikTok... ⏳` + FOOTER);
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

                        if (!videoUrl) return reply(`❌ TikTok වීඩියෝ ලින්ක් එක ලබාගන්න බැරි වුණා.` + FOOTER);

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            caption: `🎬 *TikTok Video*` + FOOTER
                        }, { quoted: msg });

                    } catch (e) {
                        await reply(`❌ Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // YouTube
                case 'yt':
                case 'youtube': {
                    const url = args[0];
                    const type = args[1] ? args[1].toLowerCase() : 'video';

                    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
                        return reply(`⚠️ Usage: .yt [URL] [video/audio]` + FOOTER);
                    }

                    try {
                        await reply(`📥 Processing YouTube... ⏳` + FOOTER);
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

                        if (!mediaUrl) return reply(`❌ Failed to fetch YouTube media.` + FOOTER);

                        if (type === 'audio') {
                            await socket.sendMessage(sender, {
                                audio: { url: mediaUrl },
                                mimetype: 'audio/mpeg',
                                fileName: `youtube_audio.mp3`
                            }, { quoted: msg });
                        } else {
                            await socket.sendMessage(sender, {
                                video: { url: mediaUrl },
                                caption: `🎬 *YouTube Video*` + FOOTER
                            }, { quoted: msg });
                        }
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // Facebook
                case 'fb':
                case 'facebook': {
                    const url = args[0];
                    if (!url || (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.me'))) {
                        return reply(`⚠️ Please provide a Facebook link!` + FOOTER);
                    }

                    await reply(`📥 Processing Facebook... ⏳` + FOOTER);
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

                        if (!videoUrl) return reply(`❌ Facebook වීඩියෝ ලින්ක් එක ලබාගන්න බැරි වුණා.` + FOOTER);

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            caption: `🎬 *Facebook Video*` + FOOTER
                        }, { quoted: msg });

                    } catch (e) {
                        await reply(`❌ Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // Instagram
                case 'ig':
                case 'instagram': {
                    const url = args[0];
                    if (!url || !url.includes('instagram.com')) {
                        return reply(`⚠️ Please provide an Instagram link!` + FOOTER);
                    }

                    await reply(`📥 Downloading Instagram... ⏳` + FOOTER);
                    try {
                        const apiRes = await axios.get(`https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`, { timeout: 20000 });
                        const mediaData = apiRes.data?.data;
                        
                        if (mediaData && mediaData.length > 0) {
                            for (const media of mediaData) {
                                if (media.type === 'video' || (media.url && media.url.includes('.mp4'))) {
                                    await socket.sendMessage(sender, {
                                        video: { url: media.url },
                                        caption: `📸 *Instagram Video*` + FOOTER
                                    }, { quoted: msg });
                                } else {
                                    await socket.sendMessage(sender, {
                                        image: { url: media.url },
                                        caption: `📸 *Instagram Image*` + FOOTER
                                    }, { quoted: msg });
                                }
                            }
                        } else {
                            return reply(`❌ Instagram download failed!` + FOOTER);
                        }
                    } catch (e) {
                        await reply(`❌ Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // ToURL
                case 'tourl':
                case 'url': {
                    try {
                        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || msg.quoted;
                        const mime = (msg.message?.imageMessage?.mimetype || msg.message?.videoMessage?.mimetype || quoted?.imageMessage?.mimetype || quoted?.videoMessage?.mimetype || '');

                        if (!mime || (!mime.includes('image') && !mime.includes('video'))) {
                            return reply(`⚠️ Please send/reply to an image or video with .tourl` + FOOTER);
                        }

                        await reply(`⏳ Uploading media... 🚀` + FOOTER);

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
                            await reply(`🔗 *MEDIA URL*\n\n*Direct Link:* ${uploadRes.data.trim()}` + FOOTER);
                        } else {
                            return reply(`❌ Upload failed.` + FOOTER);
                        }

                    } catch (e) {
                        await reply(`❌ Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // Translate
                case 'tr':
                case 'translate': {
                    const targetLang = args[0] || 'si';
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    
                    let textToTranslate = '';
                    
                    if (quoted?.quotedMessage) {
                        textToTranslate = quoted.quotedMessage.conversation || 
                                          quoted.quotedMessage.extendedTextMessage?.text || '';
                    } else {
                        textToTranslate = args.slice(1).join(' ');
                    }
                    
                    if (!textToTranslate) {
                        return reply(`⚠️ Usage: .tr [lang] [text]\nOR reply to a message with .tr [lang]` + FOOTER);
                    }
                    
                    try {
                        const res = await axios.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(textToTranslate)}`);
                        const translated = res.data[0].map(item => item[0]).join('');
                        
                        await reply(`🌐 *TRANSLATED (${targetLang.toUpperCase()})*\n\n${translated}` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Translation failed!` + FOOTER);
                    }
                    break;
                }

                // Sticker
                case 'sticker':
                case 's': {
                    try {
                        const quoted = msg.message?.extendedTextMessage?.contextInfo;
                        if (!quoted?.quotedMessage) {
                            return reply(`⚠️ Reply to an image/video with .sticker` + FOOTER);
                        }
                        
                        let qMsg = quoted.quotedMessage;
                        if (qMsg.ephemeralMessage) qMsg = qMsg.ephemeralMessage.message;
                        if (qMsg.viewOnceMessage) qMsg = qMsg.viewOnceMessage.message;
                        
                        const messageType = Object.keys(qMsg)[0];
                        
                        if (!['imageMessage', 'videoMessage'].includes(messageType)) {
                            return reply(`⚠️ Reply to an image or video!` + FOOTER);
                        }
                        
                        await reply(`⏳ Creating sticker...` + FOOTER);
                        
                        const downloadMsg = {
                            key: { remoteJid: quoted.remoteJid || sender, id: quoted.stanzaId, participant: quoted.participant },
                            message: { [messageType]: qMsg[messageType] }
                        };
                        
                        const buffer = await downloadMediaMessage(downloadMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        
                        await socket.sendMessage(sender, {
                            sticker: buffer
                        }, { quoted: msg });
                        
                    } catch (e) {
                        await reply(`❌ Sticker failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // QR Code
                case 'qr':
                case 'qrcode': {
                    const text = args.join(' ');
                    if (!text) return reply(`⚠️ Usage: .qr [text or URL]` + FOOTER);
                    
                    try {
                        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}`;
                        
                        await socket.sendMessage(sender, {
                            image: { url: qrUrl },
                            caption: `📱 *QR Code*\n\n📝 Content: ${text}` + FOOTER
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ QR failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // Weather
                case 'weather': {
                    const city = args.join(' ');
                    if (!city) return reply(`⚠️ Usage: .weather [city]` + FOOTER);
                    
                    try {
                        const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { timeout: 15000 });
                        const data = res.data;
                        
                        const current = data.current_condition[0];
                        const area = data.nearest_area[0];
                        
                        await reply(`🌤️ *WEATHER REPORT*

📍 *City:* ${area.areaName[0].value}
🌍 *Country:* ${area.country[0].value}
🌡️ *Temp:* ${current.temp_C}°C
☁️ *Condition:* ${current.weatherDesc[0].value}
💧 *Humidity:* ${current.humidity}%
💨 *Wind:* ${current.windspeedKmph} km/h` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Weather failed!` + FOOTER);
                    }
                    break;
                }

                // Password
                case 'password':
                case 'genpass': {
                    const length = parseInt(args[0]) || 16;
                    if (length < 4 || length > 64) return reply(`⚠️ Length 4-64!` + FOOTER);
                    
                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=';
                    let password = '';
                    
                    for (let i = 0; i < length; i++) {
                        password += chars.charAt(Math.floor(Math.random() * chars.length));
                    }
                    
                    await reply(`🔐 *PASSWORD*\n\n\`${password}\`\n\n📏 Length: ${length}` + FOOTER);
                    break;
                }

                // Short URL
                case 'short':
                case 'shorturl': {
                    const url = args[0];
                    if (!url) return reply(`⚠️ Usage: .short [URL]` + FOOTER);
                    
                    try {
                        const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, { timeout: 10000 });
                        await reply(`🔗 *SHORT URL*\n\n📎 *Original:* ${url}\n✂️ *Short:* ${res.data}` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Failed!` + FOOTER);
                    }
                    break;
                }

                // Screenshot
                case 'screenshot':
                case 'ss': {
                    const url = args[0];
                    if (!url) return reply(`⚠️ Usage: .ss [URL]` + FOOTER);
                    
                    try {
                        const ssUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`;
                        
                        await socket.sendMessage(sender, {
                            image: { url: ssUrl },
                            caption: `📸 *Screenshot*` + FOOTER
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ Failed!` + FOOTER);
                    }
                    break;
                }

                // Time/Date
                case 'time':
                case 'date': {
                    const now = new Date();
                    const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Colombo', hour12: true });
                    const dateStr = now.toLocaleDateString('en-US', { timeZone: 'Asia/Colombo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                    
                    await reply(`🕐 *DATE & TIME*\n\n📅 *Date:* ${dateStr}\n⏰ *Time:* ${timeStr}\n🌍 *Timezone:* Sri Lanka` + FOOTER);
                    break;
                }

                // Whois
                case 'whois':
                case 'userinfo': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    const targetJid = quoted?.participant || msg.key.participant || sender;
                    
                    try {
                        const ppUrl = await socket.profilePictureUrl(targetJid, 'image').catch(() => null);
                        const status = await socket.fetchStatus(targetJid).catch(() => null);
                        
                        const infoText = `👤 *USER INFORMATION*

📱 *Number:* ${targetJid.split('@')[0]}
🆔 *JID:* \`${targetJid}\`
💭 *Status:* ${status?.status || 'Hidden'}
🖼️ *Profile Pic:* ${ppUrl ? 'Visible' : 'Hidden'}` + FOOTER;
                        
                        if (ppUrl) {
                            await socket.sendMessage(sender, {
                                image: { url: ppUrl },
                                caption: infoText
                            }, { quoted: msg });
                        } else {
                            await reply(infoText);
                        }
                    } catch (e) {
                        await reply(`❌ Info failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // FakeChat (FIXED)
                case 'fakechat': {
                    const text = args.join(' ');
                    if (!text || !text.includes('|')) {
                        return reply(`⚠️ Usage: .fakechat Name|Message\nExample: .fakechat John|Hello` + FOOTER);
                    }
                    
                    const [name, ...msgParts] = text.split('|');
                    const message = msgParts.join('|');
                    
                    try {
                        const apiUrl = `https://api.nexoracle.com/image-creating/fakechat?name=${encodeURIComponent(name)}&message=${encodeURIComponent(message)}&apikey=free_key`;
                        
                        await socket.sendMessage(sender, {
                            image: { url: apiUrl },
                            caption: `📱 *Fake Chat Generated*` + FOOTER
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ Fake chat failed!` + FOOTER);
                    }
                    break;
                }

                // TAGALL
                case 'tagall':
                case 'all': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    try {
                        const meta = await socket.groupMetadata(sender);
                        const customMsg = args.join(' ') || 'Attention everyone!';
                        let tagText = `📢 *${customMsg}*\n\n`;
                        const mentions = [];
                        
                        meta.participants.forEach((p, i) => {
                            tagText += `${i+1}. @${p.id.split('@')[0]}\n`;
                            mentions.push(p.id);
                        });
                        
                        tagText += FOOTER;
                        
                        await socket.sendMessage(sender, {
                            text: tagText,
                            mentions: mentions
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // GETCONTACT (NEW) - Send random messages to group members
                case 'getcontact':
                case 'gc': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    try {
                        const meta = await socket.groupMetadata(sender);
                        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                        
                        // Get members except bot and owner
                        const members = meta.participants
                            .filter(p => p.id !== botJid && p.id !== msg.key.participant)
                            .map(p => p.id);
                        
                        if (members.length === 0) {
                            return reply(`❌ No members to message!` + FOOTER);
                        }
                        
                        await reply(`📞 Sending random messages to ${members.length} members...` + FOOTER);
                        
                        const messages = ['Hi 👋', 'Hello 👋', 'Mk 😊'];
                        let sent = 0;
                        
                        for (const memberJid of members) {
                            try {
                                const randomMsg = messages[Math.floor(Math.random() * messages.length)];
                                await socket.sendMessage(memberJid, {
                                    text: randomMsg + FOOTER
                                });
                                sent++;
                                await delay(1500);
                            } catch (e) {
                                console.log(`Failed to send to ${memberJid}:`, e.message);
                            }
                        }
                        
                        await reply(`✅ Sent messages to *${sent}/${members.length}* members!` + FOOTER);
                        
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // KICK
                case 'kick': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted?.participant) return reply(`⚠️ Reply to a user with .kick` + FOOTER);
                    
                    try {
                        await socket.groupParticipantsUpdate(sender, [quoted.participant], 'remove');
                        await reply(`✅ User kicked!` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // PROMOTE
                case 'promote': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted?.participant) return reply(`⚠️ Reply to a user with .promote` + FOOTER);
                    
                    try {
                        await socket.groupParticipantsUpdate(sender, [quoted.participant], 'promote');
                        await reply(`✅ User promoted!` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // DEMOTE
                case 'demote': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted?.participant) return reply(`⚠️ Reply to a user with .demote` + FOOTER);
                    
                    try {
                        await socket.groupParticipantsUpdate(sender, [quoted.participant], 'demote');
                        await reply(`✅ User demoted!` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // MUTE
                case 'mute': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    try {
                        await socket.groupSettingUpdate(sender, 'announcement');
                        await reply(`🔇 Group muted!` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // UNMUTE
                case 'unmute': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    try {
                        await socket.groupSettingUpdate(sender, 'not_announcement');
                        await reply(`🔊 Group unmuted!` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // GROUP INFO
                case 'ginfo':
                case 'groupinfo': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    try {
                        const meta = await socket.groupMetadata(sender);
                        const admins = meta.participants.filter(p => p.admin);
                        
                        let ppUrl = null;
                        try { ppUrl = await socket.profilePictureUrl(sender, 'image'); } catch (e) {}
                        
                        const infoText = `📊 *GROUP INFORMATION*

📝 *Name:* ${meta.subject}
🆔 *JID:* \`${meta.id}\`
👥 *Members:* ${meta.participants.length}
👑 *Admins:* ${admins.length}
📅 *Created:* ${new Date(meta.creation * 1000).toLocaleDateString()}
📝 *Desc:* ${meta.desc || 'No description'}` + FOOTER;
                        
                        if (ppUrl) {
                            await socket.sendMessage(sender, {
                                image: { url: ppUrl },
                                caption: infoText
                            }, { quoted: msg });
                        } else {
                            await reply(infoText);
                        }
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // QUOTE
                case 'quote': {
                    const quotes = [
                        "The only way to do great work is to love what you do. - Steve Jobs",
                        "Innovation distinguishes between a leader and a follower. - Steve Jobs",
                        "Life is what happens when you're busy making other plans. - John Lennon",
                        "The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt",
                        "It is during our darkest moments that we must focus to see the light. - Aristotle",
                        "The best time to plant a tree was 20 years ago. The second best time is now.",
                        "Don't watch the clock; do what it does. Keep going. - Sam Levenson",
                        "Your time is limited, don't waste it living someone else's life. - Steve Jobs"
                    ];
                    
                    const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
                    await reply(`💭 *DAILY QUOTE*\n\n${randomQuote}` + FOOTER);
                    break;
                }

                // DICE
                case 'dice': {
                    const dice = Math.floor(Math.random() * 6) + 1;
                    await reply(`🎲 *DICE ROLL*\n\nYou got: *${dice}*` + FOOTER);
                    break;
                }

                // FLIP
                case 'flip':
                case 'coin': {
                    const result = Math.random() < 0.5 ? 'Heads 🪙' : 'Tails 🪙';
                    await reply(`🪙 *COIN FLIP*\n\nResult: *${result}*` + FOOTER);
                    break;
                }

                // JOKE
                case 'joke': {
                    try {
                        const res = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 10000 });
                        await reply(`😂 *JOKE*\n\n${res.data.setup}\n\n${res.data.punchline}` + FOOTER);
                    } catch (e) {
                        const jokes = [
                            "Why don't scientists trust atoms? Because they make up everything!",
                            "What do you call a fake noodle? An impasta!",
                            "Why did the scarecrow win an award? He was outstanding in his field!"
                        ];
                        await reply(`😂 *JOKE*\n\n${jokes[Math.floor(Math.random() * jokes.length)]}` + FOOTER);
                    }
                    break;
                }

                // SINHALA JOKE
                case 'sijoke': {
                    const sijokes = [
                        "මිනිහෙක් බස් එකේ ගිහින් කොන්දොස්තරට කිව්වා 'ටිකට් එකක් දෙන්න' කියලා. කොන්දොස්තර කිව්වා 'කොහෙද යන්නේ?' මිනිහා කිව්වා 'ඔයාගේ ගෙදර' කියලා 😂",
                        "ගුරුවරයා: 'උඹ මොකද මේ පන්තියට එන්නේ නැත්තේ?' ළමයා: 'සර් මම එනවා, ඒත් ගෙදර මාව නවත්තනවා' 😅",
                        "එක මිනිහෙක් ඩොක්ටර්ට කිව්වා 'මට කන්න බෑ' කියලා. ඩොක්ටර් කිව්වා 'මොකද?' මිනිහා කිව්වා 'කට ඇරියම කන්න පුළුවන්' කියලා 🤣"
                    ];
                    
                    await reply(`😂 *සිංහල ජෝක්*\n\n${sijokes[Math.floor(Math.random() * sijokes.length)]}` + FOOTER);
                    break;
                }

                // RANDOM
                case 'random': {
                    const min = parseInt(args[0]) || 1;
                    const max = parseInt(args[1]) || 100;
                    const random = Math.floor(Math.random() * (max - min + 1)) + min;
                    await reply(`🔢 *RANDOM NUMBER*\n\nRange: ${min} - ${max}\nResult: *${random}*` + FOOTER);
                    break;
                }

                // IP LOOKUP
                case 'ip': {
                    const target = args[0];
                    if (!target) return reply(`⚠️ Usage: .ip [domain]` + FOOTER);
                    
                    try {
                        const res = await axios.get(`http://ip-api.com/json/${target}`, { timeout: 10000 });
                        const data = res.data;
                        
                        if (data.status !== 'success') return reply(`❌ Lookup failed!` + FOOTER);
                        
                        await reply(`🌐 *IP INFO*

📍 *Target:* ${target}
🌍 *Country:* ${data.country}
🏙️ *City:* ${data.city}
🌐 *ISP:* ${data.isp}
🕐 *Timezone:* ${data.timezone}` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Failed!` + FOOTER);
                    }
                    break;
                }

                // BASE64
                case 'base64':
                case 'b64': {
                    const mode = args[0]?.toLowerCase();
                    const text = args.slice(1).join(' ');
                    
                    if (!mode || !text) {
                        return reply(`⚠️ Usage:\n.base64 encode [text]\n.base64 decode [text]` + FOOTER);
                    }
                    
                    try {
                        if (mode === 'encode' || mode === 'enc') {
                            const encoded = Buffer.from(text).toString('base64');
                            await reply(`🔐 *ENCODED*\n\n\`${encoded}\`` + FOOTER);
                        } else if (mode === 'decode' || mode === 'dec') {
                            const decoded = Buffer.from(text, 'base64').toString('utf8');
                            await reply(`🔓 *DECODED*\n\n${decoded}` + FOOTER);
                        }
                    } catch (e) {
                        await reply(`❌ Error!` + FOOTER);
                    }
                    break;
                }

                // TTS (FIXED)
                case 'tts':
                case 'say': {
                    const text = args.join(' ');
                    if (!text) return reply(`⚠️ Usage: .tts [text]` + FOOTER);
                    
                    try {
                        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;
                        
                        const response = await axios.get(ttsUrl, { 
                            responseType: 'arraybuffer', 
                            timeout: 15000,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                            }
                        });
                        
                        const audioBuffer = Buffer.from(response.data);
                        
                        if (audioBuffer.length < 100) {
                            return reply(`❌ TTS failed! Try again.` + FOOTER);
                        }
                        
                        await socket.sendMessage(sender, {
                            audio: audioBuffer,
                            mimetype: 'audio/mpeg',
                            ptt: true,
                            fileName: 'tts.mp3'
                        }, { quoted: msg });
                        
                    } catch (e) {
                        await reply(`❌ TTS failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // CRYPTO (FIXED)
                case 'crypto':
                case 'price': {
                    let coin = args[0]?.toLowerCase();
                    if (!coin) return reply(`⚠️ Usage: .crypto [coin]\nExample: .crypto btc` + FOOTER);
                    
                    // Convert symbols to full names
                    const coinMap = {
                        'btc': 'bitcoin',
                        'eth': 'ethereum',
                        'bnb': 'binancecoin',
                        'xrp': 'ripple',
                        'doge': 'dogecoin',
                        'ada': 'cardano',
                        'sol': 'solana',
                        'matic': 'matic-network',
                        'dot': 'polkadot',
                        'ltc': 'litecoin',
                        'trx': 'tron',
                        'shib': 'shiba-inu'
                    };
                    
                    if (coinMap[coin]) coin = coinMap[coin];
                    
                    try {
                        const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=usd,lkr&include_24hr_change=true`, { timeout: 15000 });
                        const data = res.data[coin];
                        
                        if (!data) return reply(`❌ Coin not found! Try: btc, eth, bnb, xrp, doge, ada, sol` + FOOTER);
                        
                        const change = data.usd_24h_change?.toFixed(2) || 0;
                        const emoji = change >= 0 ? '📈' : '📉';
                        
                        await reply(`💰 *${coin.toUpperCase()} PRICE*

💵 *USD:* $${data.usd?.toLocaleString() || 'N/A'}
🇱🇰 *LKR:* Rs. ${data.lkr?.toLocaleString() || 'N/A'}
${emoji} *24h:* ${change}%

> _Powered by CoinGecko_` + FOOTER);
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // URL INFO
                case 'urlinfo':
                case 'preview': {
                    const url = args[0];
                    if (!url) return reply(`⚠️ Usage: .urlinfo [URL]` + FOOTER);
                    
                    try {
                        const res = await axios.get(`https://api.microlink.io?url=${encodeURIComponent(url)}`, { timeout: 15000 });
                        const data = res.data.data;
                        
                        let info = `🔗 *URL INFO*\n\n`;
                        info += `📝 *Title:* ${data.title || 'N/A'}\n`;
                        info += `📄 *Desc:* ${data.description || 'N/A'}\n`;
                        info += `🌐 *Site:* ${data.publisher || 'N/A'}\n`;
                        info += FOOTER;
                        
                        if (data.image?.url) {
                            await socket.sendMessage(sender, {
                                image: { url: data.image.url },
                                caption: info
                            }, { quoted: msg });
                        } else {
                            await reply(info);
                        }
                    } catch (e) {
                        await reply(`❌ Failed!` + FOOTER);
                    }
                    break;
                }

                // TEXT TO IMAGE
                case 'textimg':
                case 'tim': {
                    const text = args.join(' ');
                    if (!text) return reply(`⚠️ Usage: .textimg [text]` + FOOTER);
                    
                    try {
                        const imgUrl = `https://api.siputzx.my.id/api/m/textpro?text=${encodeURIComponent(text)}&theme=neon`;
                        
                        await socket.sendMessage(sender, {
                            image: { url: imgUrl },
                            caption: `🎨 *Text Image*` + FOOTER
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ Failed!` + FOOTER);
                    }
                    break;
                }

                // CHECK NUMBER
                case 'check':
                case 'numbercheck': {
                    const phone = args[0];
                    if (!phone) return reply(`⚠️ Usage: .check [phone]` + FOOTER);
                    
                    try {
                        const cleanPhone = phone.replace(/[^0-9]/g, '');
                        const jid = `${cleanPhone}@s.whatsapp.net`;
                        
                        const [result] = await socket.onWhatsApp(jid);
                        
                        if (result?.exists) {
                            let ppUrl = null;
                            try { ppUrl = await socket.profilePictureUrl(jid, 'image'); } catch (e) {}
                            
                            await reply(`✅ *EXISTS ON WHATSAPP!*

📱 *Number:* ${cleanPhone}
🖼️ *Profile Pic:* ${ppUrl ? 'Visible' : 'Hidden'}` + FOOTER);
                        } else {
                            await reply(`❌ NOT on WhatsApp!` + FOOTER);
                        }
                    } catch (e) {
                        await reply(`❌ Failed!` + FOOTER);
                    }
                    break;
                }

                // SETREPLY
                case 'setreply': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const trigger = args[0]?.toLowerCase();
                    const response = args.slice(1).join(' ');
                    
                    if (!trigger || !response) {
                        return reply(`⚠️ Usage: .setreply [trigger] [response]` + FOOTER);
                    }
                    
                    global.customReplies = global.customReplies || {};
                    global.customReplies[trigger] = response;
                    
                    await reply(`✅ Custom reply set!` + FOOTER);
                    break;
                }

                // DELREPLY
                case 'delreply': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const trigger = args[0]?.toLowerCase();
                    if (!trigger) return reply(`⚠️ Usage: .delreply [trigger]` + FOOTER);
                    
                    global.customReplies = global.customReplies || {};
                    delete global.customReplies[trigger];
                    
                    await reply(`✅ Removed: *${trigger}*` + FOOTER);
                    break;
                }

                // LISTREPLY
                case 'listreply': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    global.customReplies = global.customReplies || {};
                    const triggers = Object.keys(global.customReplies);
                    
                    if (triggers.length === 0) {
                        return reply(`📝 No custom replies!` + FOOTER);
                    }
                    
                    let list = `📝 *CUSTOM REPLIES*\n\n`;
                    triggers.forEach((t, i) => {
                        list += `${i+1}. *${t}* → ${global.customReplies[t]}\n`;
                    });
                    
                    await reply(list + FOOTER);
                    break;
                }

                // NOTE
                case 'note': {
                    const action = args[0]?.toLowerCase();
                    const noteName = args[1]?.toLowerCase();
                    const noteContent = args.slice(2).join(' ');
                    
                    global.notes = global.notes || {};
                    
                    if (action === 'save') {
                        if (!noteName || !noteContent) return reply(`⚠️ Usage: .note save [name] [content]` + FOOTER);
                        global.notes[noteName] = noteContent;
                        await reply(`✅ Note saved: *${noteName}*` + FOOTER);
                    } else if (action === 'get') {
                        if (!noteName) return reply(`⚠️ Usage: .note get [name]` + FOOTER);
                        if (!global.notes[noteName]) return reply(`❌ Not found!` + FOOTER);
                        await reply(`📝 *${noteName.toUpperCase()}*\n\n${global.notes[noteName]}` + FOOTER);
                    } else if (action === 'list') {
                        const notes = Object.keys(global.notes);
                        if (notes.length === 0) return reply(`📝 No notes!` + FOOTER);
                        await reply(`📝 *NOTES*\n\n${notes.map((n, i) => `${i+1}. ${n}`).join('\n')}` + FOOTER);
                    } else if (action === 'del') {
                        if (!noteName) return reply(`⚠️ Usage: .note del [name]` + FOOTER);
                        delete global.notes[noteName];
                        await reply(`✅ Deleted: *${noteName}*` + FOOTER);
                    } else {
                        await reply(`📝 *Note Commands*\n\n.note save [name] [content]\n.note get [name]\n.note list\n.note del [name]` + FOOTER);
                    }
                    break;
                }

                // REMIND
                case 'remind':
                case 'reminder': {
                    const timeArg = args[0];
                    const reminderText = args.slice(1).join(' ');
                    
                    if (!timeArg || !reminderText) {
                        return reply(`⚠️ Usage: .remind [time] [message]\nExample: .remind 5m Take medicine` + FOOTER);
                    }
                    
                    let ms = 0;
                    if (timeArg.endsWith('s')) ms = parseInt(timeArg) * 1000;
                    else if (timeArg.endsWith('m')) ms = parseInt(timeArg) * 60 * 1000;
                    else if (timeArg.endsWith('h')) ms = parseInt(timeArg) * 60 * 60 * 1000;
                    else ms = parseInt(timeArg) * 60 * 1000;
                    
                    if (isNaN(ms) || ms <= 0 || ms > 24 * 60 * 60 * 1000) {
                        return reply(`⚠️ Invalid time! Max 24h` + FOOTER);
                    }
                    
                    await reply(`⏰ Reminder set for ${timeArg}!` + FOOTER);
                    
                    setTimeout(async () => {
                        try {
                            await socket.sendMessage(sender, {
                                text: `⏰ *REMINDER*\n\n${reminderText}` + FOOTER,
                                mentions: [msg.key.participant || sender]
                            });
                        } catch (e) {}
                    }, ms);
                    break;
                }

                // POLL
                case 'poll': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    const pollText = args.join(' ');
                    if (!pollText.includes('|')) {
                        return reply(`⚠️ Usage: .poll Question|Option1|Option2` + FOOTER);
                    }
                    
                    const parts = pollText.split('|');
                    const question = parts[0];
                    const options = parts.slice(1);
                    
                    if (options.length < 2) return reply(`⚠️ At least 2 options!` + FOOTER);
                    
                    let pollMsg = `📊 *POLL*\n\n❓ *${question}*\n\n`;
                    options.forEach((opt, i) => {
                        const emoji = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'][i];
                        pollMsg += `${emoji} ${opt}\n`;
                    });
                    pollMsg += `\n💡 *React to vote!*` + FOOTER;
                    
                    const sent = await socket.sendMessage(sender, { text: pollMsg });
                    
                    const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
                    for (let i = 0; i < options.length; i++) {
                        await delay(500);
                        await socket.sendMessage(sender, {
                            react: { text: emojis[i], key: sent.key }
                        });
                    }
                    break;
                }

                // BIRTHDAY
                case 'birthday':
                case 'bday': {
                    const action = args[0]?.toLowerCase();
                    global.birthdays = global.birthdays || {};
                    
                    if (action === 'set') {
                        const date = args[1];
                        if (!date || !date.includes('/')) return reply(`⚠️ Usage: .bday set DD/MM` + FOOTER);
                        const userJid = msg.key.participant || sender;
                        global.birthdays[userJid] = date;
                        await reply(`🎂 Saved: *${date}*` + FOOTER);
                    } else if (action === 'list') {
                        const entries = Object.entries(global.birthdays);
                        if (entries.length === 0) return reply(`🎂 No birthdays!` + FOOTER);
                        
                        let list = `🎂 *BIRTHDAYS*\n\n`;
                        entries.forEach(([jid, date]) => {
                            list += `• @${jid.split('@')[0]} → ${date}\n`;
                        });
                        
                        await reply({
                            text: list + FOOTER,
                            mentions: entries.map(([jid]) => jid)
                        });
                    } else if (action === 'check') {
                        const today = new Date();
                        const todayStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}`;
                        
                        const birthdayPeople = Object.entries(global.birthdays).filter(([_, d]) => d === todayStr);
                        
                        if (birthdayPeople.length === 0) {
                            await reply(`🎂 No birthdays today!` + FOOTER);
                        } else {
                            let msg2 = `🎉 *TODAY'S BIRTHDAYS* 🎉\n\n`;
                            birthdayPeople.forEach(([jid]) => {
                                msg2 += `🎂 @${jid.split('@')[0]}\n`;
                            });
                            await reply({
                                text: msg2 + FOOTER,
                                mentions: birthdayPeople.map(([jid]) => jid)
                            });
                        }
                    } else {
                        await reply(`🎂 *Birthday Commands*\n\n.bday set DD/MM\n.bday list\n.bday check` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // ANTI-LINK (PER GROUP)
                // ==========================================
                case 'antilink': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    // Check admin or owner
                    let isAdmin = msg.key.fromMe;
                    if (!isAdmin) {
                        try {
                            const meta = await socket.groupMetadata(sender);
                            const participant = meta.participants.find(p => p.id === msg.key.participant);
                            isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                        } catch (e) {}
                    }
                    
                    if (!isAdmin) return reply(`⚠️ Only admins or owner!` + FOOTER);
                    
                    const val = args[0]?.toLowerCase();
                    const current = groupAntiLink.get(sender) || await get(`ANTILINK_${sender}`, number) || 'off';
                    
                    if (!val || !['on', 'off'].includes(val)) {
                        return reply(`🔗 *Anti-Link (This Group)*\n\nCurrent: *${current.toUpperCase()}*\n\nUsage: .antilink on/off` + FOOTER);
                    }
                    
                    // Save per group
                    groupAntiLink.set(sender, val);
                    await handleSettingUpdate(`ANTILINK_${sender}`, val, reply, number);
                    break;
                }

                // ==========================================
                // WELCOME (PER GROUP)
                // ==========================================
                case 'welcome': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    // Check admin or owner
                    let isAdmin = msg.key.fromMe;
                    if (!isAdmin) {
                        try {
                            const meta = await socket.groupMetadata(sender);
                            const participant = meta.participants.find(p => p.id === msg.key.participant);
                            isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                        } catch (e) {}
                    }
                    
                    if (!isAdmin) return reply(`⚠️ Only admins or owner!` + FOOTER);
                    
                    const val = args[0]?.toLowerCase();
                    const current = groupWelcome.get(sender) || await get(`WELCOME_${sender}`, number) || 'off';
                    
                    if (!val || !['on', 'off'].includes(val)) {
                        return reply(`👋 *Welcome (This Group)*\n\nCurrent: *${current.toUpperCase()}*\n\nUsage: .welcome on/off` + FOOTER);
                    }
                    
                    // Save per group
                    groupWelcome.set(sender, val);
                    await handleSettingUpdate(`WELCOME_${sender}`, val, reply, number);
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
*╎ 5️⃣ - 🤖 AI & CONVERT*
*╎ 6️⃣ - 👥 GROUP ADMIN*
*╎ 7️⃣ - 🎮 FUN COMMANDS*
*╎*
*╰───────────────────────*

💡 *Reply to this message with a number!*
Example: Reply \`1\` for Download Commands

🔗 Web: https://nimsara-official.vercel.app/
*🏮 FOLLOW CHANNEL :- ${BOT_CHANNEL_LINK}*

> _MADE BY NIMSARA_`;

                    const sentMsg = await socket.sendMessage(sender, {
                        image: { url: BOT_IMAGE_URL },
                        caption: captionText.trim(),
                        contextInfo: channelInfo
                    }, { quoted: msg });

                    if (sentMsg?.key?.id) {
                        menuMessageIds.set(sentMsg.key.id, { type: 'main', timestamp: Date.now() });
                        
                        if (menuMessageIds.size > 100) {
                            const oldest = menuMessageIds.keys().next().value;
                            menuMessageIds.delete(oldest);
                        }
                    }

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

                // Mode
                case 'mode': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validModes = ['public', 'group', 'inbox', 'private'];

                    if (!validModes.includes(option)) {
                        const currentMode = await get('BOT_MODE', number) || 'public';
                        return reply(`⚙️ *Bot Mode*\n\nCurrent: *${currentMode.toUpperCase()}*\n\nOptions:\n• .mode public\n• .mode group\n• .mode inbox\n• .mode private` + FOOTER);
                    }

                    await handleSettingUpdate("BOT_MODE", option, reply, number);
                    break;
                }

                // Ping
                case 'ping': {
                    const start = Date.now();
                    const sentMsg = await socket.sendMessage(sender, { text: 'Pinging...' }, { quoted: msg });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { text: `🏓 Pong! *${latency}ms*` + FOOTER }, { quoted: sentMsg });
                    break;
                }

                // Autoread
                case 'autoread': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validOptions = ['all', 'cmd', 'off'];

                    if (!validOptions.includes(option)) {
                        return reply(`👀 *Auto-Read*\n\nCurrent: *${(global.autoReadStatus || 'off').toUpperCase()}*\n\nOptions:\n• .autoread all\n• .autoread cmd\n• .autoread off` + FOOTER);
                    }

                    global.autoReadStatus = option;
                    await reply(`✅ Auto-Read: *${global.autoReadStatus.toUpperCase()}*` + FOOTER);
                    break;
                }

                // Autoreply
                case 'autoreply': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validOptions = ['all', 'inbox', 'group', 'off'];

                    if (!validOptions.includes(option)) {
                        return reply(`🤖 *Auto-Reply*\n\nCurrent: *${(global.autoReplyMode || 'off').toUpperCase()}*\n\nOptions:\n• .autoreply all\n• .autoreply inbox\n• .autoreply group\n• .autoreply off` + FOOTER);
                    }

                    global.autoReplyMode = option;
                    await reply(`✅ Auto-Reply: *${global.autoReplyMode.toUpperCase()}*` + FOOTER);
                    break;
                }

                // Alive
                case 'alive':
                case 'status': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const aliveText = `👋 *${botName}* is online!\n⏱️ Uptime: ${hours}h ${minutes}m ${seconds}s\n👨‍💻 Creator: Nimsara` + FOOTER;

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

                // Runtime
                case 'runtime': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    await reply(`⏱️ *${botName} Uptime:* ${hours}h ${minutes}m ${seconds}s` + FOOTER);
                    break;
                }

                // Owner
                case 'owner': {
                    await reply(`👑 *Bot Owner*\n> Name: Nimsara\n> Contact: 0784280074\n> Bot: ${botName}` + FOOTER);
                    break;
                }

                // Send/Save
                case 'send':
                case 'save': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted || !quoted.quotedMessage) {
                        return reply(`⚠️ Reply to media with *${prefix}send*` + FOOTER);
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
                            const caption = `${innerMsg?.caption || ''}` + FOOTER;

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
                            await reply(`📥 *Saved:*\n\n${text}` + FOOTER);
                        }
                    } catch (err) {
                        await reply(`❌ Failed: ${err.message}` + FOOTER);
                    }
                    break;
                }

                // View Once
                case 'vv':
                case 'viewonce': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted || !quoted.quotedMessage) {
                        return reply(`⚠️ Reply to View Once media with *${prefix}vv*` + FOOTER);
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
                            const caption = `📥 *View Once Media*\n\n${innerMsg?.caption || ''}` + FOOTER;

                            if (messageType === 'imageMessage') {
                                await socket.sendMessage(sender, { image: buffer, caption }, { quoted: msg });
                            } else if (messageType === 'videoMessage') {
                                await socket.sendMessage(sender, { video: buffer, caption }, { quoted: msg });
                            }
                        } catch (err) {
                            await reply(`❌ Failed: ${err.message}` + FOOTER);
                        }
                    } else {
                        await reply(`⚠️ Reply to View Once image/video!` + FOOTER);
                    }
                    break;
                }

                // Set prefix
                case 'setprefix': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const newPrefix = args[0];
                    if (!newPrefix) return reply(`⚠️ Usage: .setprefix [New Prefix]` + FOOTER);
                    await handleSettingUpdate("PREFIX", newPrefix, reply, number);
                    break;
                }

                // Settings
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
• ${pfx}setprefix [prefix]` + FOOTER);
                    break;
                }

                // Autoview
                case 'autoview': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: .autoview on/off` + FOOTER);
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_VIEW_STATUS", normalized, reply, number);
                    break;
                }

                // Autolike
                case 'autolike': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: .autolike on/off` + FOOTER);
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_LIKE_STATUS", normalized, reply, number);
                    break;
                }

                // Always online
                case 'alwaysonline': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: .alwaysonline on/off` + FOOTER);
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

    // ==========================================
    // Welcome/Goodbye System (PER GROUP)
    // ==========================================
    socket.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action } = update;
            
            // Check per-group welcome status
            let welcomeEnabled = groupWelcome.get(id);
            if (!welcomeEnabled) {
                welcomeEnabled = await get(`WELCOME_${id}`, number) || 'off';
                groupWelcome.set(id, welcomeEnabled);
            }
            
            if (welcomeEnabled !== 'on') return;
            
            const groupMeta = await socket.groupMetadata(id);
            const groupName = groupMeta.subject;
            
            for (const participant of participants) {
                const userJid = participant;
                const userName = userJid.split('@')[0];
                
                if (action === 'add') {
                    await socket.sendMessage(id, {
                        image: { url: BOT_IMAGE_URL },
                        text: `🎉 *WELCOME* @${userName}!\n\n👋 Welcome to *${groupName}*\n\n📢 Please read group rules!` + FOOTER,
                        mentions: [userJid]
                    });
                } else if (action === 'remove') {
                    await socket.sendMessage(id, {
                        text: `👋 *GOODBYE* @${userName}!\n\n😢 We'll miss you!` + FOOTER,
                        mentions: [userJid]
                    });
                }
            }
        } catch (e) {
            console.log("Group welcome error:", e.message);
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
// Start Bot Function
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

        let connectMessageSent = false;

        const sendConnectMessage = async (currentSock, botNumber) => {
            if (connectMessageSent) return;
            connectMessageSent = true;

            try {
                let botName = 'NIM BOT';
                let currentPrefix = '.';
                try {
                    botName = await get('BOT_NAME', botNumber) || 'NIM BOT';
                    currentPrefix = await get('PREFIX', botNumber) || '.';
                } catch (e) { }

                const ownJid = `${botNumber}@s.whatsapp.net`;

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

                await delay(1500);

                const audioBuffer = await getAudioBuffer(BOT_AUDIO_URL);
                if (audioBuffer) {
                    await currentSock.sendMessage(ownJid, {
                        audio: audioBuffer,
                        mimetype: 'audio/mpeg',
                        ptt: false
                    });
                }

            } catch (err) {
                console.log(`[CONNECT MSG] ❌ Error:`, err.message);
                connectMessageSent = false;
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

                setTimeout(() => {
                    sendConnectMessage(sock, sanitizedNumber);
                }, 3000);

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
                
                if (res && typeof res.send === 'function' && !res.headersSent) {
                    res.send({ code });
                }

                console.log(`✅ Pairing code sent: ${code}`);

            } catch (err) {
                if (res && typeof res.status === 'function' && !res.headersSent) {
                    return res.status(500).send({ error: err.message });
                }
            }
        } else {
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
