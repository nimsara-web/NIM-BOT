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
const reconnectAttempts = new Map(); // Track reconnect attempts per number

// Helper to get message text safely
function getMessageBody(msg) {
    if (!msg.message) return '';
    let message = msg.message;
    if (message.ephemeralMessage) message = message.ephemeralMessage.message;
    if (message.viewOnceMessage) message = message.viewOnceMessage.message;
    if (message.viewOnceMessageV2) message = message.viewOnceMessageV2.message;

    return message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption || '';
}

// Helper to download audio as a Buffer to ensure 100% playback success
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

async function useMongoDBAuthState(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionDir = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    await fs.ensureDir(sessionDir);

    let dbData = await Session.findOne({ number: sanitizedNumber });
    const credsPath = path.join(sessionDir, 'creds.json');

    // 🔥 CRITICAL FIX: Always load from MongoDB first, then write to file
    if (dbData && dbData.creds) {
        try {
            // Check if creds has valid structure
            if (dbData.creds && typeof dbData.creds === 'object' && Object.keys(dbData.creds).length > 0) {
                await fs.writeJson(credsPath, dbData.creds, { spaces: 2 });
                console.log(`✅ Loaded existing session from MongoDB for ${sanitizedNumber}`);
            } else {
                console.log(`⚠️ Invalid creds in MongoDB for ${sanitizedNumber}, will create new session`);
                // Remove invalid entry
                await Session.deleteOne({ number: sanitizedNumber });
                dbData = null;
            }
        } catch (e) {
            console.error("Error writing initial creds from DB:", e);
            // If file is corrupted, delete it and start fresh
            await fs.remove(credsPath);
            await Session.deleteOne({ number: sanitizedNumber });
            dbData = null;
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // 🔥 FIX: Enhanced saveCreds with better error handling
    const enhancedSaveCreds = async () => {
        try {
            await fs.ensureDir(sessionDir);
            await saveCreds();
            
            if (await fs.pathExists(credsPath)) {
                try {
                    const rawData = await fs.readFile(credsPath, 'utf8');
                    if (rawData && rawData.trim() !== '') {
                        const credsData = JSON.parse(rawData);
                        // Validate creds data
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
                        } else {
                            console.log(`⚠️ Invalid creds data for ${sanitizedNumber}, skipping save`);
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

function setupCommandHandlers(socket, number) {

    // Anti-delete handler
    socket.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            if (update) {
                console.log("[UPDATE EVENT]", JSON.stringify(update));
            }

            const protocolMsg = update?.protocolMessage || update?.message?.protocolMessage;

            if (protocolMsg) {
                console.log("[ANTI-DELETE] Protocol message detected, type:", protocolMsg.type);

                if (protocolMsg.type === 0 || protocolMsg.type === 'REVOKE' || protocolMsg.key || protocolMsg.stanzaId) {
                    const revokedId = protocolMsg.key?.id || protocolMsg.stanzaId;

                    if (!revokedId) continue;

                    const cachedMsg = messageCache.get(revokedId);

                    if (cachedMsg) {
                        const chatJid = cachedMsg.key.remoteJid;
                        const senderJid = cachedMsg.key.participant || cachedMsg.key.remoteJid;
                        const messageText = getMessageBody(cachedMsg) || '[Media / Non-text message]';

                        deletedMessages.set(chatJid, {
                            sender: senderJid,
                            text: messageText,
                            time: new Date().toLocaleTimeString(),
                            originalMsg: cachedMsg
                        });

                        console.log(`[ANTI-DELETE SUCCESS] Captured deleted message from: ${senderJid}`);
                    } else {
                        console.log(`[ANTI-DELETE WARNING] Message ID not found in cache: ${revokedId}`);
                    }
                }
            }
        }
    });

    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg) return;

        // Cache message for anti-delete
        if (msg.key && msg.key.id) {
            messageCache.set(msg.key.id, msg);
            if (messageCache.size > 500) {
                const oldestKey = messageCache.keys().next().value;
                messageCache.delete(oldestKey);
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

        // Channel forwarding info
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

        // Auto-reply logic
        global.autoReplyMode = global.autoReplyMode || 'off';

        if (global.autoReplyMode !== 'off' && !msg.key.fromMe) {
            const isGroup = sender.endsWith('@g.us');
            const shouldAutoReply =
                (global.autoReplyMode === 'all') ||
                (global.autoReplyMode === 'inbox' && !isGroup) ||
                (global.autoReplyMode === 'group' && isGroup);

            if (shouldAutoReply) {
                const textLower = body.toLowerCase().trim();

                const isBotSelfReply =
                    textLower.includes('hi! 👋') ||
                    textLower.includes('mokuth na innwa') ||
                    textLower.includes('good morning🌤️') ||
                    textLower.includes('good night✨') ||
                    textLower.includes('bye🍻') ||
                    textLower.includes('r2k gaming channels') ||
                    textLower.includes('payment details') ||
                    textLower.includes('eyaa hadapu bot');

                if (isBotSelfReply) {
                    return;
                }

                if (textLower.includes('hi') || textLower.includes('හායි') || textLower.includes('hello')) {
                    await reply('Hi! 👋');
                } else if (textLower.includes('mk') || textLower.includes('මොකද කරන්නෙ') || textLower.includes('mokada karanne')) {
                    await reply('Mokuth Na innwa😊');
                } else if (textLower.includes('gm') || textLower.includes('ගුඩ් මොර්නින්ග්') || textLower.includes('good morning')) {
                    await reply('Good Morning🌤️');
                } else if (textLower.includes('gn') || textLower.includes('ගුඩ් නයිජ්ට්') || textLower.includes('good night')) {
                    await reply('Good Night✨');
                } else if (textLower.includes('by') || textLower.includes('බායි') || textLower.includes('bye')) {
                    await reply('Bye🍻');
                } else if (textLower.includes('r2k ge channel monawada') || textLower.includes('pawarage channel link') || textLower.includes('r2k gaming')) {
                    await reply(`*🔥 R2K Gaming Channels 🔥*

💓Tik Tok - https://www.tiktok.com/@rush.2.kill__00

💓Youtube - https://www.youtube.com/@rush.2.kill__0

💓Fb - https://www.facebook.com/profile.php?id=61581297341821

*\`Thankyou Yaluwe !\`*`);
                } else if (textLower.includes('payment details') || textLower.includes('පේමන්ට් ඩීටේල්') || textLower.includes('bank details')) {
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
                } else if (textLower.includes('nethmintha') || textLower.includes('නෙත්මින්ත')) {
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
                        console.error('Audio send error:', err);
                        await reply('Ow kiyanna Nimsara tikakin rp karai man eya hadapu Bot! 👨‍💻😎');
                    }
                }
            }
        }

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
                case 'remsg':
                case 'delete':
                case 'getdel': {
                    const lastDeleted = deletedMessages.get(sender);
                    if (!lastDeleted) {
                        await reply('❌ මේ චැට් එකේ recent delete කරපු message එකක් හමුවුණේ නෑ !', msg);
                        return;
                    }

                    const recoverText = `
🗑️ *DELETED MESSAGE RECOVERED* 🗑️

👤 *Sender:* @${lastDeleted.sender.split('@')[0]}
⏰ *Time:* ${lastDeleted.time}
💬 *Message:* ${lastDeleted.text}
`;

                    await reply({
                        text: recoverText.trim(),
                        mentions: [lastDeleted.sender]
                    }, lastDeleted.originalMsg);
                    break;
                }

                case 'jid': {
                    const inputArg = args[0] || '';

                    if (inputArg.includes('chat.whatsapp.com')) {
                        try {
                            const match = inputArg.match(/(?:https:\/\/)?(?:chat\.whatsapp\.com\/)([0-9A-Za-z]{20,24})/i);
                            if (match && match[1]) {
                                const inviteCode = match[1];
                                const groupInfo = await socket.groupGetInviteInfo(inviteCode);

                                const groupLinkJidText = `
🔗 *GROUP JID FROM LINK* 🔗

🏷️ *Group Name:* ${groupInfo.subject || 'Unknown'}
📌 *Group JID:* \`${groupInfo.id}\`
👥 *Participants:* ${groupInfo.size || 'N/A'}
`;
                                await reply(groupLinkJidText.trim(), msg);
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

                    const jidText = `
📍 *JID INFORMATION* 📍

💬 *Chat JID:* \`${chatJid}\`
👤 *Sender JID:* \`${senderJid}\`
🎯 *Quoted/Target JID:* \`${quotedJid}\`
`;

                    await reply(jidText.trim(), msg);
                    break;
                }

                // ==========================================
                // 🤖 AI CHATBOT (Fixed with fallback APIs)
                // ==========================================
                case 'ai':
                case 'gpt': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a question or prompt for AI!\nExample: .ai What is the capital of Sri Lanka?\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);

                    await reply(`🤖 Thinking... please wait... 🧠`);
                    try {
                        let aiAnswer = null;
                        let errorMsg = null;

                        // Try API 1: BK9
                        try {
                            const apiUrl = `https://bk9.fun/ai/gemini?q=${encodeURIComponent(query)}`;
                            const apiRes = await axios.get(apiUrl, { timeout: 10000 });
                            aiAnswer = apiRes.data?.result || apiRes.data?.gpt || apiRes.data?.answer;
                        } catch (e1) {
                            errorMsg = e1.message;
                            console.log("BK9 API failed, trying fallback...");
                        }

                        // Try API 2: Fallback
                        if (!aiAnswer) {
                            try {
                                const fallbackUrl = `https://api.affiliateplus.xyz/api/gpt?query=${encodeURIComponent(query)}`;
                                const fallbackRes = await axios.get(fallbackUrl, { timeout: 10000 });
                                aiAnswer = fallbackRes.data?.reply || fallbackRes.data?.response || fallbackRes.data?.result;
                            } catch (e2) {
                                errorMsg = e2.message;
                                console.log("Fallback API failed too.");
                            }
                        }

                        // Try API 3: Another fallback
                        if (!aiAnswer) {
                            try {
                                const thirdUrl = `https://delirius-apiofc.vercel.app/ai/gpt4?q=${encodeURIComponent(query)}`;
                                const thirdRes = await axios.get(thirdUrl, { timeout: 10000 });
                                aiAnswer = thirdRes.data?.data || thirdRes.data?.response || thirdRes.data?.result;
                            } catch (e3) {
                                errorMsg = e3.message;
                                console.log("Third API also failed.");
                            }
                        }

                        if (!aiAnswer) {
                            return reply(`❌ AI එකෙන් උත්තරයක් ලබාගන්න බැරි වුණා මචං. Error: ${errorMsg || 'No response from any API'}`);
                        }

                        const aiResponseText = `
🤖 *AI ASSISTANT* 🤖

${aiAnswer.trim()}

🔗 *Channel:* ${BOT_CHANNEL_LINK}
`;

                        await reply(aiResponseText.trim(), msg);

                    } catch (e) {
                        console.error("AI command error:", e);
                        await reply(`❌ AI Error: ${e.message}`);
                    }
                    break;
                }

                // ==========================================
                // 📥 DOWNLOAD COMMANDS (FIXED - Using direct exec)
                // ==========================================

                case 'song': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a song name!\nExample: .song Manike Mage Hithe\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);

                    await reply(`🔍 Searching for *${query}*... 🎶`);
                    try {
                        const search = await yts(query);
                        const video = search.videos[0];
                        if (!video) return reply(`❌ Song not found! Try another name.`);

                        await reply(`🎵 Found: *${video.title}*\n📥 Generating audio link, please wait...`);

                        const { stdout } = await execPromise(
                            `yt-dlp --get-url -f bestaudio "${video.url}"`
                        );

                        const audioUrl = stdout.trim().split('\n')[0];

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

                case 'tt':
                case 'tiktok': {
                    const url = args[0];
                    if (!url || !url.includes('tiktok.com')) {
                        return reply(`⚠️ Please provide a valid TikTok video link!\nExample: .tt https://vt.tiktok.com/xxxx/\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }

                    await reply(`📥 Processing TikTok video... Please wait ⏳`);
                    try {
                        const { stdout } = await execPromise(
                            `yt-dlp --get-url "${url}"`
                        );

                        const videoUrl = stdout.trim().split('\n')[0];

                        if (!videoUrl) return reply(`❌ TikTok වීඩියෝ ලින්ක් එක ලබාගන්න බැරි වුණා.`);

                        const caption = `🎬 *TikTok Video Downloaded*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`;

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            caption: caption
                        }, { quoted: msg });

                    } catch (e) {
                        console.error("TikTok download error:", e);
                        await reply(`❌ Error downloading TikTok video: ${e.message}`);
                    }
                    break;
                }

                case 'yt':
                case 'youtube': {
                    const url = args[0];
                    const type = args[1] ? args[1].toLowerCase() : 'video';

                    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
                        return reply(`⚠️ Usage: .yt [YouTube Link] [video/audio]\nExample: .yt https://youtu.be/xxxx video\nExample: .yt https://youtu.be/xxxx audio\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }

                    try {
                        await reply(`📥 Processing YouTube download... Please wait ⏳`);

                        let cmd;
                        if (type === 'audio') {
                            cmd = `yt-dlp --get-url -f bestaudio "${url}"`;
                        } else {
                            cmd = `yt-dlp --get-url -f "best[ext=mp4]/best" "${url}"`;
                        }

                        const { stdout } = await execPromise(cmd);
                        const mediaUrl = stdout.trim().split('\n')[0];

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

                case 'fb':
                case 'facebook': {
                    const url = args[0];
                    if (!url || (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.me'))) {
                        return reply(`⚠️ Please provide a valid Facebook video link!\nExample: .fb https://www.facebook.com/share/v/xxxx/\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
                    }

                    await reply(`📥 Processing Facebook video... Please wait ⏳`);
                    try {
                        const { stdout } = await execPromise(
                            `yt-dlp --get-url "${url}"`
                        );

                        const videoUrl = stdout.trim().split('\n')[0];

                        if (!videoUrl) {
                            return reply(`❌ Facebook වීඩියෝ ලින්ක් එක ලබාගන්න බැරි වුණා මචං.`);
                        }

                        const caption = `🎬 *Facebook Video Downloaded*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`;

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            caption: caption
                        }, { quoted: msg });

                    } catch (e) {
                        console.error("Facebook download error:", e);
                        await reply(`❌ Error downloading Facebook video: ${e.message}`);
                    }
                    break;
                }

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
                            headers: {
                                ...form.getHeaders()
                            }
                        });

                        if (uploadRes.data && uploadRes.data.startsWith('http')) {
                            const mediaUrl = uploadRes.data.trim();

                            const responseText = `
🔗 *MEDIA URL GENERATED* 🔗

*Direct Link:* ${mediaUrl}

🔗 *Channel:* ${BOT_CHANNEL_LINK}
`;
                            await reply(responseText.trim(), msg);
                        } else {
                            return reply(`❌ Upload failed. Please try again later.`);
                        }

                    } catch (e) {
                        console.error("ToUrl error:", e);
                        await reply(`❌ Error generating URL: ${e.message}`);
                    }
                    break;
                }

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

*╭─\`💠 𝗕𝗢𝗧 𝗠𝗘𝗡𝗨...\`┈⊷*
*╎*
*╎📍ᴄᴍᴅ - .alive*
*╎🔖 ᴅᴇꜱᴄ- Show bot status.*
*╎*
*╎📍ᴄᴍᴅ - .status*
*╎🔖 ᴅᴇꜱᴄ- Check bot status.*
*╎*
*╎📍ᴄᴍᴅ - .ping*
*╎🔖 ᴅᴇꜱᴄ- Check response time.*
*╎*
*╎📍ᴄᴍᴅ - .runtime*
*╎🔖 ᴅᴇꜱᴄ- Show bot uptime.*
*╎*
*╎📍ᴄᴍᴅ - .settings*
*╎🔖 ᴅᴇꜱᴄ- Manage bot settings (Auto status/Online).*
*╎*
*╎📍ᴄᴍᴅ - .setprefix*
*╎🔖 ᴅᴇꜱᴄ- Change bot command prefix.*
*╎*
*╎📍ᴄᴍᴅ - .send*
*╎🔖 ᴅᴇꜱᴄ- Download/Save quoted status or media.*
*╎*
*╎📍ᴄᴍᴅ - .mode public/group/inbox/private*
*╎🔖 ᴅᴇꜱᴄ- Bot Run Mode.*
*╎*
*╎📍ᴄᴍᴅ - .autoread all/cmd/off*
*╎🔖 ᴅᴇꜱᴄ- Auto Read Massege All Massege/Command Massege/Off Read.*
*╎*
*╎📍ᴄᴍᴅ - .vv*
*╎🔖 ᴅᴇꜱᴄ- Download View Once image or video.*
*╎*
*╎📍ᴄᴍᴅ - .jid*
*╎🔖 ᴅᴇꜱᴄ- Channel & Group & Chat JID.*
*╎*
*╎📍ᴄᴍᴅ - .owner*
*╎🔖 ᴅᴇꜱᴄ- Bot owner information.*
*╰───────────────────────*

🔗 Web: https://nimsara-official.vercel.app/

*🏮 FOLLOW MINE CHANNEL :- ${BOT_CHANNEL_LINK}*

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
                    await reply(`✅ Auto-Read mode successfully changed to: *${global.autoReadStatus.toUpperCase()}* 👁️‍🗨️`);
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
                        msgText += "• \`.autoread inbox\` - Enable only for Inbox (Private)\n";
                        msgText += "• \`.autoreply group\` - Enable only for Groups\n";
                        msgText += "• \`.autoreply off\` - Turn off auto-reply\n\n";
                        msgText += `🔗 Channel: ${BOT_CHANNEL_LINK}`;
                        return reply(msgText);
                    }

                    global.autoReplyMode = option;
                    await reply(`✅ Auto-Reply mode successfully changed to: *${global.autoReplyMode.toUpperCase()}* ⚡`);
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
                    await reply(`⏱️ *${botName} Uptime:* ${hours} hours, ${minutes} minutes, ${seconds} seconds.\n\n🔗 Channel: ${BOT_CHANNEL_LINK}\n> _MADE BY Nimsara_`);
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

// Auto Status Seen, Auto Status React & Always Online Handlers
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

// 🔥 NEW: Function to check and restore existing sessions on startup
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
                    // Check if already active
                    if (activeSockets.has(session.number)) {
                        console.log(`✅ Session ${session.number} already active.`);
                        continue;
                    }

                    console.log(`🔄 Restoring session for ${session.number}...`);
                    // Start bot without sending pairing code (will use existing session)
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

async function StartBot(number, res = null, isRestore = false) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    // Check if already connected
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
            // 🔥 Important: Keep connection alive
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log(`✅ Bot successfully connected for number: ${sanitizedNumber}`);
                
                // Reset reconnect attempts on successful connection
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

                // Only send welcome message if not restoring
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

                // 🔥 Auto-reconnect logic
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    console.log(`❌ Session logged out for ${sanitizedNumber}. Removing from database.`);
                    await Session.deleteOne({ number: sanitizedNumber });
                    await fs.remove(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));
                } else {
                    // Try to reconnect with exponential backoff
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

        // 🔥 Only request pairing code if not registered AND not restoring
        if (!sock.authState.creds.registered) {
            if (isRestore) {
                console.log(`⚠️ Session ${sanitizedNumber} not registered but restore attempted. Will try to reconnect.`);
                // Try to reconnect after a delay
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

// 🔥 NEW: REST API endpoint to manually logout a session
router.post('/logout', async (req, res) => {
    const { number } = req.body || req.query;
    if (!number) return res.status(400).send({ error: 'Phone number is required!' });

    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    try {
        // Close socket if active
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

        // Remove from database
        await Session.deleteOne({ number: sanitizedNumber });
        
        // Remove session files
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

// 🔥 NEW: API to get all active sessions
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

// 🔥 NEW: API to manually reconnect a session
router.post('/reconnect', async (req, res) => {
    const { number } = req.body || req.query;
    if (!number) return res.status(400).send({ error: 'Phone number is required!' });

    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    try {
        // Check if session exists in database
        const session = await Session.findOne({ number: sanitizedNumber });
        if (!session) {
            return res.status(404).send({ 
                error: 'No session found for this number. Please pair first.' 
            });
        }

        // If already active, just return status
        if (activeSockets.has(sanitizedNumber)) {
            return res.send({ 
                status: "Already connected", 
                number: sanitizedNumber 
            });
        }

        // Start bot with restore mode
        await StartBot(sanitizedNumber, null, true);
        
        res.send({ 
            status: "Reconnect initiated", 
            number: sanitizedNumber 
        });
    } catch (e) {
        res.status(500).send({ error: e.message });
    }
});

// Main route for pairing
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Phone number is required!' });

    try {
        // Check if session already exists in database
        const existingSession = await Session.findOne({ number: number.replace(/[^0-9]/g, '') });
        
        if (existingSession && existingSession.creds && Object.keys(existingSession.creds).length > 0) {
            // If session exists but not active, try to restore
            if (!activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                console.log(`🔄 Existing session found for ${number}, attempting to restore...`);
                await StartBot(number, res, true);
                return;
            }
        }

        // If no existing session, start fresh
        await StartBot(number, res, false);
    } catch (e) {
        console.error("Route router.get error:", e);
        if (!res.headersSent) {
            res.status(500).send({ error: e.message });
        }
    }
});

// 🔥 Start restoring sessions when server starts
(async () => {
    try {
        // Wait for MongoDB connection
        await delay(5000);
        await restoreExistingSessions();
    } catch (e) {
        console.error("Error during initial session restoration:", e.message);
    }
})();

module.exports = router;
