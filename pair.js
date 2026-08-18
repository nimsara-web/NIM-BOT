/**
 * Project: NIM BOT - Public Multi-User Pairing Module
 * Creator: Nimsara
 * Mode: Normal Text Message Mode with Robust Reconnection Handling
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
        await fs.writeJson(credsPath, dbData.creds, { spaces: 2 });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    return {
        state,
        saveCreds: async () => {
            await saveCreds();
            if (await fs.pathExists(credsPath)) {
                try {
                    const credsData = await fs.readJson(credsPath);
                    await Session.findOneAndUpdate(
                        { number: sanitizedNumber },
                        { creds: credsData, updatedAt: new Date() },
                        { upsert: true, new: true }
                    );
                } catch (e) {
                    console.error("Error saving creds to MongoDB:", e);
                }
            }
        }
    };
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const body = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || '';

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
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection closed for ${sanitizedNumber}, status code: ${statusCode}`);

            // If logged out or session invalidated, clear session data
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log(`❌ Session logged out for ${sanitizedNumber}. Removing from DB.`);
                await Session.deleteOne({ number: sanitizedNumber });
                await fs.remove(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));
            } else {
                // Reconnect automatically for other closures (like 515 restart required, connection reset, etc.)
                setTimeout(() => StartBot(sanitizedNumber), 3000);
            }
        }
    });

    setupCommandHandlers(sock, sanitizedNumber);
    setupStatusHandlers(sock, sanitizedNumber);

    // Request Pairing Code if not registered
    if (!sock.authState.creds.registered) {
        await delay(3000); // 3 seconds delay to stabilize socket before requesting code
        try {
            let code = await sock.requestPairingCode(sanitizedNumber);
            if (res && !res.headersSent) {
                res.send({ code });
            }
        } catch (e) {
            console.error("Pairing code generation error:", e);
            if (res && !res.headersSent) {
                res.status(500).send({ error: "Failed to generate pairing code. Please try again." });
            }
        }
    } else {
        if (res && !res.headersSent) {
            res.send({ status: "Already connected" });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Phone number is required!' });
    
    try {
        await StartBot(number, res);
    } catch (e) {
        if (!res.headersSent) {
            res.status(500).send({ error: e.message });
        }
    }
});

module.exports = router;
