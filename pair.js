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
const nexray = require('api-nexray');
const ytdl = require('@distube/ytdl-core');
const axios = require('axios');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

let botMode = 'public'; // Default mode eka

const Session = require('./Id'); 
const { get, input, ensureConfig, handleSettingUpdate } = require('./configdb'); 

const SESSION_BASE_PATH = path.join(__dirname, './sessions');
const BOT_IMAGE_URL = 'https://github.com/nimsara-web/Im-Nim/blob/main/Data/WhatsApp%20Image%202026-08-27%20at%204.41.36%20PM.jpeg';
const BOT_AUDIO_URL = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/welcome%20nim%20new.MP3';
const BOT_CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb0bsRuFnSz4XAQ2yT0r';

// Global tracking maps
const socketCreationTime = new Map();
const activeSockets = new Map();

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

    if (dbData && dbData.creds) {
        try {
            await fs.writeJson(credsPath, dbData.creds, { spaces: 2 });
        } catch (e) {
            console.error("Error writing initial creds from DB:", e);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    return {
        state,
        saveCreds: async () => {
            await fs.ensureDir(sessionDir);
            await saveCreds();
            if (await fs.pathExists(credsPath)) {
                try {
                    const rawData = await fs.readFile(credsPath, 'utf8');
                    if (rawData && rawData.trim() !== '') {
                        const credsData = JSON.parse(rawData);
                        await Session.findOneAndUpdate(
                            { number: sanitizedNumber },
                            { creds: credsData, updatedAt: new Date() },
                            { upsert: true, new: true }
                        );
                    }
                } catch (e) {
                    console.error("Skipped saving corrupted creds.json to MongoDB:", e.message);
                }
            }
        }
    };
}

// Robust message body extractor for Baileys
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
} // 👈 මෙන්න මෙතන getMessageBody ෆන්ක්ෂන් එක වැහුණා!

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;
        const body = getMessageBody(msg);
        if (!body) return;

        const prefix = await get('PREFIX', number) || '.';
        
        // 1. isCommand define කරනවා
        const isCommand = body.startsWith(prefix);

        // 2. Auto-read logic එක
        global.autoReadStatus = global.autoReadStatus || 'off'; 

        if (global.autoReadStatus === 'all') {
            await socket.readMessages([msg.key]); 
        } 
        else if (global.autoReadStatus === 'cmd' && isCommand) {
            await socket.readMessages([msg.key]); 
        }

        // ==========================================
        // 🔗 UNIVERSAL CHANNEL FORWARDING & REPLY HELPER
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

        // Text එකක් හෝ Object එකක් (Audio/Image) දුන්නත් කැනල් කන්ටෙක්ට් එක ඔටෝ සෙට් කරන reply function එක
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
        // 🤖 AUTO-REPLY LOGIC
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

                // 1. "Hi" හෝ "හායි" හෝ "Hello" දැමූ විට
                if (textLower.includes('hi') || textLower.includes('හායි') || textLower.includes('hello')) {
                    await reply('Hi! 👋');
                }
                // 2. "Mk" හෝ "මොකද" දැමූ විට
                else if (textLower.includes('mk') || textLower.includes('මොකද කරන්නෙ') || textLower.includes('mokada')) {
                    await reply('Mokuth Na innwa😊');
                }
                // 3. "Nimsara" හෝ "නිම්සර" දැමූ විට Text එකයි Audio එකයි යන්න
                else if (textLower.includes('nethmintha') || textLower.includes('නෙත්මින්ත')) {
                    try {
                        const audioUrl = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/welcomto%20nim%20bot.MP3';
                        
                        // GitHub URL එකෙන් axios හරහා බෆර් එක ඩවුන්ලෝඩ් කරගැනීම
                        const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
                        const audioBuffer = Buffer.from(response.data);

                        await reply({ 
                            text: 'Ow kiyanna Nimsara tikakin rp karai man eya hadapu Bot! 👨‍💻😎',
                            audio: audioBuffer,
                            mimetype: 'audio/mp4',
                            ptt: true // Voice Note එකක් ලෙස යැවීමට
                        });
                    } catch (err) {
                        console.error('Audio send error:', err);
                        await reply('Ow kiyanna Nimsara tikakin rp karai man eya hadapu Bot! 👨‍💻😎');
                    }
                }
            }
        }
        // ==========================================


        // 3. Prefix නැති ඒවා මෙතනින් නවත්තනවා
    if (!isCommand) return;

    // 4. BOT MODE CHECK එක (ඩේටබේස් එකෙන් ලේටස්ට් මෝඩ් එක අරන් චෙක් කරයි)
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
*╎📍ᴄᴍᴅ - .owner*
*╎🔖 ᴅᴇꜱᴄ- Bot owner information.*
*╰───────────────────────*

🔗 Web: Pending

*🏮 FOLLOW MINE CHANNEL :- ${BOT_CHANNEL_LINK}*

> _MADE BY NIMSARA_
`;

                   // Send Menu Image + Caption (using reply helper for automatic channel forwarding)
                    await reply({
                        image: { url: BOT_IMAGE_URL },
                        caption: captionText.trim()
                    });

                    await delay(1500);

                    // Download and send Audio Buffer reliably
                    const audioBuffer = await getAudioBuffer(BOT_AUDIO_URL);
                    if (audioBuffer) {
                        await reply({
                            audio: audioBuffer,
                            mimetype: 'audio/mpeg',
                            ptt: false
                        });
                    }
                    break;
                } // ේok------------------------

                case 'mode': {
                    if (!msg.key.fromMe) {
                        return reply(`⚠️ This command can only be used by the **Bot Owner**! ❌`);
                    }

                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validModes = ['public', 'group', 'inbox', 'private'];
                    
                    if (!validModes.includes(option)) {
                        // 🚀 ඩේටබේස් එකෙන් වර්තමාන මෝඩ් එක ගෙනැවිත් පෙන්වයි
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

                    // 🚀 ඩේටබේස් එකේ මෝඩ් එක ස්ථිරවම සේව් කිරීම (handleSettingUpdate හරහා)
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



// --- BOT MODE RESTRICTION CHECK ---
                const isGroup = from.endsWith('@g.us');
                const cleanSender = sender.split(':')[0];
                const cleanBotNumber = socket.user.id.split(':')[0];
                const isOwner = (cleanSender === cleanBotNumber);

                // Owner හැර වෙන කෙනෙක් නම්, mode එක අනුව block කරනවා:
                if (!isOwner) {
                    // 1. Private Mode: Owner හැလෙන්න වෙන කවුරුත් bot පාවිච්චි කරන්න බෑ
                    if (botMode === 'private') {
                        return; // Silent block (reply nokara inna puluwan)
                    }
                    // 2. Group Mode: Inbox එකෙන් එවපු ඒවා block කරනවා
                    if (botMode === 'group' && !isGroup) {
                        return;
                    }
                    // 3. Inbox Mode: Group එකෙන් එවපු ඒවා block කරනවා
                    if (botMode === 'inbox' && isGroup) {
                        return;
                    }
                }




                 case 'autoread': {
                    // Bot Connect කරපු නම්බර් එකෙන් (fromMe) විතරක් වැඩ කරනවා
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
                        msgText += "• \`.autoread inbox\` - Enable only for Inbox (Private)\n"; // spelling check
                        msgText += "• \`.autoreply group\` - Enable only for Groups\n";
                        msgText += "• \`.autoreply off\` - Turn off auto-reply\n\n";
                        msgText += `🔗 Channel: ${BOT_CHANNEL_LINK}`;
                        return reply(msgText);
                    }

                    global.autoReplyMode = option;
                    await reply(`✅ Auto-Reply mode successfully changed to: *${global.autoReplyMode.toUpperCase()}* ⚡`);
                    break;
                }
                    

                    

   // CASE: SONG
case 'song': {
    const query = args.join(' ');
    if (!query) return reply(`⚠️ Please provide a song name!\nExample: .song Manike Mage Hithe\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
    
    await reply(`🔍 Searching for *${query}*... 🎶`);
    try {
        const search = await yts(query);
        const video = search.videos[0];
        if (!video) return reply(`❌ Song not found! Try another name.`);

        await reply(`🎵 Found: *${video.title}*\n📥 Downloading audio, please wait...`);

        // Direct Axios request (Bypassing api-nexray package bug)
        const apiRes = await axios.get(`https://api.nexray.eu.cc/downloader/ytmp3?url=${encodeURIComponent(video.url)}`);
        const resData = apiRes.data;
        
        if (!resData) {
            return reply(`❌ Download failed from API. Try again later.`);
        }

        const resultObj = resData.result || resData;
        const audioUrl = resultObj.download?.url || resultObj.url || resultObj.audio;

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

// CASE: TIKTOK
case 'tt':
case 'tiktok': {
    const url = args[0];
    if (!url || !url.includes('tiktok.com')) {
        return reply(`⚠️ Please provide a valid TikTok video link!\nExample: .tt https://vt.tiktok.com/xxxx/\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
    }

    await reply(`📥 Downloading TikTok video... Please wait ⏳`);
    try {
        // Direct Axios request (Bypassing api-nexray package bug)
        const response = await axios.get(`https://api.nexray.eu.cc/downloader/tiktok?url=${encodeURIComponent(url)}`);
        const resData = response.data;

        if (resData) {
            const resultObj = resData.result || resData;
            const videoUrl = resultObj.no_watermark || resultObj.nowm || resultObj.video || resultObj.data?.no_watermark || resultObj.dl_url;
            const caption = `🎬 *TikTok Video Downloaded*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`;

            await socket.sendMessage(sender, {
                video: { url: videoUrl },
                caption: caption
            }, { quoted: msg });
        } else {
            await reply(`❌ Failed to fetch TikTok video. Invalid link or API error.`);
        }
    } catch (e) {
        console.error("TikTok download error:", e);
        await reply(`❌ Error downloading TikTok video: ${e.message}`);
    }
    break;
}

// CASE: YOUTUBE
case 'yt':
case 'youtube': {
    const url = args[0];
    const type = args[1] ? args[1].toLowerCase() : 'video';

    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
        return reply(`⚠️ Usage: .yt [YouTube Link] [video/audio]\nExample: .yt https://youtu.be/xxxx video\nExample: .yt https://youtu.be/xxxx audio\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
    }

    try {
        await reply(`📥 Processing YouTube download... Please wait ⏳`);
        
        if (type === 'audio') {
            const apiRes = await axios.get(`https://api.nexray.eu.cc/downloader/ytmp3?url=${encodeURIComponent(url)}`);
            const resData = apiRes.data;
            if (!resData) return reply(`❌ Failed to fetch audio.`);
            
            const resultObj = resData.result || resData;
            const audioUrl = resultObj.download?.url || resultObj.url || resultObj.audio;

            await socket.sendMessage(sender, {
                audio: { url: audioUrl },
                mimetype: 'audio/mpeg',
                fileName: `youtube_audio.mp3`
            }, { quoted: msg });

        } else {
            const apiRes = await axios.get(`https://api.nexray.eu.cc/downloader/ytmp4?url=${encodeURIComponent(url)}`);
            const resData = apiRes.data;
            if (!resData) return reply(`❌ Failed to fetch video.`);
            
            const resultObj = resData.result || resData;
            const videoUrl = resultObj.download?.url || resultObj.url || resultObj.video;

            await socket.sendMessage(sender, {
                video: { url: videoUrl },
                caption: `🎬 *YouTube Video*\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`
            }, { quoted: msg });
        }
    } catch (e) {
        console.error("YouTube download error:", e);
        await reply(`❌ Failed to download YouTube media: ${e.message}\n\n🔗 Channel: ${BOT_CHANNEL_LINK}`);
    }
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

// Auto Status Seen, Auto Status React & Always Online Handlers (Fixed)
function setupStatusAndPresenceHandlers(socket, number) {
    // 🚀 බොට්ගේ නම්බර් එක සේෆ්ලි හැdle කරගැනීම (DB එකෙන් සෙටින්ග්ස් නිවැරදිව රීඩ් වීමට)
    const getBotNumber = () => socket.user?.id ? socket.user.id.split(':')[0] : number;

    socket.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            try {
                const botNum = getBotNumber();
                const alwaysOnline = await get('ALWAYS_ONLINE', botNum);
                
                // 🛑 ඕෆ් කරලා නම් අනිවාර්යයෙන්ම unavailable (offline) යවනවා
                if (alwaysOnline === 'false' || alwaysOnline === 'off') {
                    await socket.sendPresenceUpdate('unavailable');
                } else {
                    await socket.sendPresenceUpdate('available');
                }
            } catch (e) {}
        }
    });

    setInterval(async () => {
        try {
            const botNum = getBotNumber();
            const alwaysOnline = await get('ALWAYS_ONLINE', botNum);
            
            // 🛑 ඕෆ් කරලා නම් කවදාවත් available යවන්නේ නැහැ
            if (alwaysOnline === 'false' || alwaysOnline === 'off') {
                await socket.sendPresenceUpdate('unavailable');
            } else {
                await socket.sendPresenceUpdate('available');
            }
        } catch (e) {}
    }, 60000);

    socket.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message) continue;

            const botNum = getBotNumber();

            if (msg.key && msg.key.remoteJid === 'status@broadcast') {
                // 🛑 Auto View Status (false හෝ off කර ඇත්නම් ස්ටේටස් බීලිම් සම්පූර්ණයෙන්ම නවතී)
                const autoView = await get('AUTO_VIEW_STATUS', botNum);
                if (autoView !== 'false' && autoView !== 'off') {
                    try {
                        await socket.readMessages([msg.key]);
                    } catch (e) {}
                }

                // 🛑 Auto Like Status (true හෝ on කර ඇත්නම් පමණක් ලයික් වේ)
                const autoLike = await get('AUTO_LIKE_STATUS', botNum);
                if (autoLike === 'true' || autoLike === 'on') {
                    try {
                        const emojis = ['❤️', '🔥', '👍', '✨', '🤍', '🌟'];
                        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                        await socket.sendMessage('status@broadcast', {
                            react: { text: randomEmoji, key: msg.key }
                        }, { statusJidList: [msg.key.participant] });
                    } catch (e) {}
                }
            }
        }
    });
}

async function StartBot(number, res = null) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');

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
            browser: Browsers.macOS('Safari')
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log(`✅ Bot successfully connected for number: ${sanitizedNumber}`);

                try {
                    if (typeof ensureConfig === 'function') {
                        await ensureConfig(sanitizedNumber);
                    }
                } catch (err) {
                    console.log("Config ensure error:", err.message);
                }

                socketCreationTime.set(sanitizedNumber, Date.now());
                activeSockets.set(sanitizedNumber, sock);

                // Send Connected Welcome Message + Image & Audio Buffer
                try {
                    await delay(2000);
                    let botName = 'NIM BOT';
                    let currentPrefix = '.';
                    try {
                        botName = await get('BOT_NAME', sanitizedNumber) || 'NIM BOT';
                        currentPrefix = await get('PREFIX', sanitizedNumber) || '.';
                    } catch (e) {}

                    // කැනල් ෆෝවර්ඩ් කන්ටෙක්ට් එක මෙතනටත් දෙනවා
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

            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Connection closed for ${sanitizedNumber}, status code: ${statusCode}`);
                activeSockets.delete(sanitizedNumber);

                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    await Session.deleteOne({ number: sanitizedNumber });
                    await fs.remove(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));
                } else {
                    setTimeout(() => StartBot(sanitizedNumber), 3000);
                }
            }
        });

        setupCommandHandlers(sock, sanitizedNumber);
        setupStatusAndPresenceHandlers(sock, sanitizedNumber);

        if (!sock.authState.creds.registered) {
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
                return res.send({ status: "Already connected" });
            }
        }
    } catch (error) {
        console.error("❌ StartBot fatal error:", error.message);
        if (res && typeof res.status === 'function' && !res.headersSent) {
            return res.status(500).send({ error: error.message || "Internal server error during pairing." });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Phone number is required!' });

    try {
        await StartBot(number, res);
    } catch (e) {
        console.error("Route router.get error:", e);
        if (!res.headersSent) {
            res.status(500).send({ error: e.message });
        }
    }
});

module.exports = router;
