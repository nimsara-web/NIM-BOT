/**
 * Project: NIM BOT - Public Multi-User Pairing Module
 * Creator: Nimsara
 * Mode: Full Features Enabled (Status Seen, React, Always Online, Menu + Images)
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('baileys');

const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Session = require('./Id'); 
const { get, input, ensureConfig, handleSettingUpdate } = require('./configdb'); 

const SESSION_BASE_PATH = path.join(__dirname, './sessions');
const BOT_IMAGE_URL = 'https://res.cloudinary.com/dqlh378fb/image/upload/v1787035957/zanta_media_uploads/c9qlcgvmwlcuf7oyb8be.jpg';

// Global tracking maps
const socketCreationTime = new Map();
const activeSockets = new Map();

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
            // Ensure directory exists before saving to prevent ENOENT error
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
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;
        const body = getMessageBody(msg);
        if (!body) return;

        const prefix = await get('PREFIX', number) || '.';
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const botName = await get('BOT_NAME', number) || 'NIM BOT';

        const reply = async (text) => {
            await socket.sendMessage(sender, { text: text }, { quoted: msg });
        };

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
*👋${botName.toUpperCase()} 🧛🏻*
*--  T𝗁𝖾 mini W𝗁𝖺𝗍𝗌𝖺𝗉𝗉 B𝗈𝗍 E𝗑𝗉𝖾𝗋𝗂𝖾𝗇𝖈𝖾 --*

> Created By Nimsara 🧛🏻
> 🪀 Contact - 0784280074
 (${botName.toUpperCase()} 🧛🏻)         

──────────────────────       
*BOT STATUS 👾*
> Bot Name : ${botName}
> Run Time : ${hours}h ${minutes}m ${seconds}s
> Host : RENDER
> Activers : ${activeSockets.size}
> Bot Channel : ${channelStatus}
> Bot Creator : NIMSARA
──────────────────────  

*╭─\`💠 𝗕𝗢𝗧  𝗨𝗡𝗧𝗜𝗟𝗜𝗧𝗬...⚙️\`┈⊷*
*╎*
*╎🏷️ᴄᴍᴅ - .alive*
*╎🔖 ᴅᴇꜱᴄ- Show bot status.*
*╎*
*╎🏷️ᴄᴍᴅ - .status*
*╎🔖 ᴅᴇꜱᴄ- Check bot status.*
*╎*
*╎🏷️ᴄᴍᴅ - .ping*
*╎🔖 ᴅᴇꜱᴄ- Check response time.*
*╎*
*╎🏷️ᴄᴍᴅ - .runtime*
*╎🔖 ᴅᴇꜱᴄ- Show bot uptime.*
*╎*
*╎🏷️ᴄᴍᴅ - .settings*
*╎🔖 ᴅᴇꜱᴄ- Manage bot settings (Auto status/Online).*
*╎*
*╎🏷️ᴄᴍᴅ - .setprefix*
*╎🔖 ᴅᴇꜱᴄ- Change bot command prefix.*
*╎*
*╎🏷️ᴄᴍᴅ - .setname*
*╎🔖 ᴅᴇꜱᴄ- Change bot name.*
*╎*
*╎🏷️ᴄᴍᴅ - .owner*
*╎🔖 ᴅᴇꜱᴄ- Bot owner information.*
*╰───────────────────────*

🔗 Web: https://pending/
*🏮 FOLLOW MINE CHANNEL :- https://whatsapp.com/channel/0029Vb0bsRuFnSz4XAQ2yT0r*
> _MADE BY NIMSARA_
`;
                    await socket.sendMessage(sender, {
                        image: { url: BOT_IMAGE_URL },
                        caption: captionText.trim()
                    }, { quoted: msg });
                    break;
                }
                case 'ping': {
                    const start = Date.now();
                    const sentMsg = await socket.sendMessage(sender, { text: 'Pinging...' }, { quoted: msg });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { text: `🏓 Pong! *${latency}ms*` }, { quoted: sentMsg });
                    break;
                }
                case 'alive':
                case 'status': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    
                    const aliveText = `👋 *${botName}* is online and running!\n⏱️ Uptime: ${hours}h ${minutes}m ${seconds}s\n👨‍💻 Creator: Nimsara`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: BOT_IMAGE_URL },
                        caption: aliveText
                    }, { quoted: msg });
                    break;
                }
                case 'runtime': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    await reply(`⏱️ *Bot Uptime:* ${hours} hours, ${minutes} minutes, ${seconds} seconds.`);
                    break;
                }
                case 'owner': {
                    await reply(`👑 *Bot Owner Information*\n> Name: Nimsara\n> Contact: 0784280074\n> Bot: ${botName}`);
                    break;
                }
                case 'setname': {
                    const newName = args.join(' ');
                    if (!newName) return reply("⚠️ Usage: .setname [New Name]");
                    await handleSettingUpdate("BOT_NAME", newName, reply, number);
                    break;
                }
                case 'setprefix': {
                    const newPrefix = args[0];
                    if (!newPrefix) return reply("⚠️ Usage: .setprefix [New Prefix]\nExample: .setprefix !");
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
• ${pfx}setname [New Name]
`;
                    await reply(settingsText.trim());
                    break;
                }
                case 'autoview': {
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply("⚠️ Usage: .autoview on  OR  .autoview off");
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_VIEW_STATUS", normalized, reply, number);
                    break;
                }
                case 'autolike': {
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply("⚠️ Usage: .autolike on  OR  .autolike off");
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_LIKE_STATUS", normalized, reply, number);
                    break;
                }
                case 'alwaysonline': {
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply("⚠️ Usage: .alwaysonline on  OR  .alwaysonline off");
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
    socket.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            try {
                const alwaysOnline = await get('ALWAYS_ONLINE', number) ?? 'true';
                if (alwaysOnline === 'true' || alwaysOnline === 'on') {
                    await socket.sendPresenceUpdate('available');
                }
            } catch (e) {}
        }
    });

    setInterval(async () => {
        try {
            const alwaysOnline = await get('ALWAYS_ONLINE', number) ?? 'true';
            if (alwaysOnline === 'true' || alwaysOnline === 'on') {
                await socket.sendPresenceUpdate('available');
            }
        } catch (e) {}
    }, 60000);

    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        if (msg.key && msg.key.remoteJid === 'status@broadcast') {
            const autoView = await get('AUTO_VIEW_STATUS', number) ?? 'true';
            if (autoView === 'true' || autoView === 'on') {
                try {
                    await socket.readMessages([msg.key]);
                } catch (e) {}
            }

            const autoLike = await get('AUTO_LIKE_STATUS', number) ?? 'true';
            if (autoLike === 'true' || autoLike === 'on') {
                try {
                    const emojis = ['❤️', '🔥', '👍', '✨', '🙌', '🌟'];
                    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                    await socket.sendMessage('status@broadcast', {
                        react: { text: randomEmoji, key: msg.key }
                    }, { statusJidList: [msg.key.participant] });
                } catch (e) {}
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

                // Send Connected Welcome Message with Image to the owner's chat
                try {
                    await delay(2000);
                    let botName = 'NIM BOT';
                    let currentPrefix = '.';
                    try {
                        botName = await get('BOT_NAME', sanitizedNumber) || 'NIM BOT';
                        currentPrefix = await get('PREFIX', sanitizedNumber) || '.';
                    } catch (e) {}

                    await sock.sendMessage(`${sanitizedNumber}@s.whatsapp.net`, {
                        image: { url: BOT_IMAGE_URL },
                        caption: `╔═════════════════════════╗\n║  🎉 *NIM BOT CONNECTED* 🎉  \n╚═════════════════════════╝\n\n✅ Your WhatsApp Bot is now online and active!\n\n• Name: *${botName}*\n• Number: *${sanitizedNumber}*\n• Prefix: *${currentPrefix}* \n• Type *${currentPrefix}menu* to view commands.\n\nCreator: *Nimsara*`
                    });
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
