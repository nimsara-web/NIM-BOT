/**
 * Project: NIM BOT - Public Multi-User Pairing Module
 * Creator: Nimsara
 * Mode: Fixed Commands & Auto Connect Message
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Session = require('./Id'); 
const { get, input, ensureConfig, handleSettingUpdate } = require('./configdb'); 

const SESSION_BASE_PATH = path.join(__dirname, './sessions');

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

// Robust message body extractor for Baileys (handles wrapped messages)
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
                case 'menu':
                case 'help': {
                    let menuText = `╔═════════════════════════╗\n║     🤖 *${botName}* 🤖     \n╚═════════════════════════╝\nCreator: *Nimsara*\n\n*Commands:*\n• ${prefix}ping\n• ${prefix}settings\n• ${prefix}setname [name]`;
                    await reply(menuText);
                    break;
                }
                case 'ping': {
                    const start = Date.now();
                    const sentMsg = await socket.sendMessage(sender, { text: 'Pinging...' }, { quoted: msg });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { text: `🏓 Pong! *${latency}ms*` }, { quoted: sentMsg });
                    break;
                }
                case 'settings': {
                    const autoView = await get('AUTO_VIEW_STATUS', number) || 'true';
                    const autoLike = await get('AUTO_LIKE_STATUS', number) || 'true';
                    let settingsText = `⚙️ *NIM BOT SETTINGS* ⚙️\n\n• Auto View Status: *${autoView}*\n• Auto Like Status: *${autoLike}*`;
                    await reply(settingsText);
                    break;
                }
                case 'setname': {
                    const newName = args.join(' ');
                    if (!newName) return reply("Usage: .setname [New Name]");
                    await handleSettingUpdate("BOT_NAME", newName, reply, number);
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

function setupStatusHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        if (msg.key && msg.key.remoteJid === 'status@broadcast') {
            const autoView = await get('AUTO_VIEW_STATUS', number) || 'true';
            if (autoView === 'true' || autoView === 'on') {
                try {
                    await socket.readMessages([msg.key]);
                } catch (e) {}
            }

            const autoLike = await get('AUTO_LIKE_STATUS', number) || 'true';
            if (autoLike === 'true' || autoLike === 'on') {
                try {
                    const emojis = ['❤️', '🔥', '👍', '✨', '🙌'];
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
                await ensureConfig(sanitizedNumber);

                // Send Connected Welcome Message to the bot owner's chat
                try {
                    await delay(2000);
                    await sock.sendMessage(`${sanitizedNumber}@s.whatsapp.net`, {
                        text: `╔═════════════════════════╗\n║  🎉 *NIM BOT CONNECTED* 🎉  \n╚═════════════════════════╝\n\n✅ Your WhatsApp Bot is now online and active!\n\n• Number: *${sanitizedNumber}*\n• Prefix: *.* \n• Type *.menu* to view commands.\n\nCreator: *Nimsara*`
                    });
                } catch (err) {
                    console.log("Failed to send connect message:", err.message);
                }

            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Connection closed for ${sanitizedNumber}, status code: ${statusCode}`);

                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    await Session.deleteOne({ number: sanitizedNumber });
                    await fs.remove(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));
                } else {
                    setTimeout(() => StartBot(sanitizedNumber), 3000);
                }
            }
        });

        setupCommandHandlers(sock, sanitizedNumber);
        setupStatusHandlers(sock, sanitizedNumber);

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
